-- rollback: DROP FUNCTION public.post_bank_transaction(uuid); DROP TRIGGER validate_bank_transaction_source_claim_trigger ON public.ledger_postings; DROP FUNCTION public.enforce_bank_transaction_source_claim(); DROP TABLE public.bank_transaction_postings; ALTER TABLE public.bank_transactions DROP COLUMN btw_percentage;

-- 1. BTW-percentage per bankregel (additief, optioneel)
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS btw_percentage numeric;

-- 2. Markertabel: precies één boekingsgroep per bankregel
CREATE TABLE IF NOT EXISTS public.bank_transaction_postings (
  bank_transaction_id uuid PRIMARY KEY REFERENCES public.bank_transactions(id) ON DELETE RESTRICT,
  posting_group_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  grootboekrekening_id uuid NOT NULL REFERENCES public.grootboekrekeningen(id) ON DELETE RESTRICT,
  posting_date date NOT NULL,
  boekjaar integer NOT NULL,
  gross_amount numeric(12,2) NOT NULL,
  net_amount numeric(12,2) NOT NULL,
  btw_amount numeric(12,2) NOT NULL,
  btw_percentage numeric,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.bank_transaction_postings TO authenticated;
GRANT ALL ON public.bank_transaction_postings TO service_role;

ALTER TABLE public.bank_transaction_postings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_bank_transaction_postings_select ON public.bank_transaction_postings;
CREATE POLICY role_bank_transaction_postings_select
  ON public.bank_transaction_postings FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

CREATE INDEX IF NOT EXISTS idx_bank_transaction_postings_client
  ON public.bank_transaction_postings(client_id);

-- 3. Source claim: losse grootboekregels met source_type 'bank_transaction' zijn verboden
CREATE OR REPLACE FUNCTION public.enforce_bank_transaction_source_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marker public.bank_transaction_postings%ROWTYPE;
BEGIN
  IF NEW.source_type <> 'bank_transaction' THEN
    RETURN NEW;
  END IF;

  IF NEW.source_id IS NULL THEN
    RAISE EXCEPTION 'Een bankboeking moet naar een banktransactie verwijzen' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_marker
  FROM public.bank_transaction_postings
  WHERE bank_transaction_id = NEW.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deze banktransactie is niet geboekt via de boekingsfunctie; losse grootboekregels zijn niet toegestaan'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.posting_group_id <> v_marker.posting_group_id THEN
    RAISE EXCEPTION 'Een banktransactie kan maar één boekingsgroep hebben; deze regel hoort niet bij de geboekte groep'
      USING ERRCODE = '23505';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_marker.organization_id
     OR NEW.client_id IS DISTINCT FROM v_marker.client_id THEN
    RAISE EXCEPTION 'Organisatie of administratie van deze regel wijkt af van de geboekte banktransactie'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.posting_date IS DISTINCT FROM v_marker.posting_date
     OR NEW.boekjaar IS DISTINCT FROM v_marker.boekjaar THEN
    RAISE EXCEPTION 'Datum of boekjaar van deze regel wijkt af van de geboekte banktransactie'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.grootboekrekening_id IS NULL THEN
    RAISE EXCEPTION 'Een bankboekingsregel moet een grootboekrekening hebben' USING ERRCODE = '23514';
  END IF;

  IF NEW.line_no NOT IN (1, 2, 3) THEN
    RAISE EXCEPTION 'Een bankboeking bestaat uit hooguit drie regels; regel % is niet toegestaan', NEW.line_no
      USING ERRCODE = '23514';
  END IF;

  IF (NEW.debit_amount + NEW.credit_amount) NOT IN (v_marker.gross_amount, v_marker.net_amount, v_marker.btw_amount) THEN
    RAISE EXCEPTION 'Een bankboekingsregel moet het bruto-, netto- of BTW-bedrag van de geboekte banktransactie dragen'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_bank_transaction_source_claim_trigger ON public.ledger_postings;
CREATE TRIGGER validate_bank_transaction_source_claim_trigger
BEFORE INSERT ON public.ledger_postings
FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_transaction_source_claim();

-- 4. Bevriezing van een geboekte banktransactie (aflettering én directe boeking)
CREATE OR REPLACE FUNCTION public.prevent_posted_bank_transaction_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_has_allocation boolean;
  v_has_direct boolean;
BEGIN
  v_has_allocation := EXISTS (
    SELECT 1 FROM public.bank_allocation_postings WHERE bank_transaction_id = OLD.id
  );
  v_has_direct := EXISTS (
    SELECT 1 FROM public.bank_transaction_postings WHERE bank_transaction_id = OLD.id
  );

  IF NOT v_has_allocation AND NOT v_has_direct THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deze banktransactie is geboekt in het grootboek; verwijderen is niet mogelijk. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id                  IS DISTINCT FROM OLD.id
     OR NEW.amount           IS DISTINCT FROM OLD.amount
     OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
     OR NEW.client_id        IS DISTINCT FROM OLD.client_id
     OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
     OR NEW.user_id          IS DISTINCT FROM OLD.user_id
  THEN
    RAISE EXCEPTION 'Deze banktransactie is geboekt in het grootboek; bedrag, datum, administratie en organisatie kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  IF v_has_direct AND (
        NEW.grootboekrekening_id IS DISTINCT FROM OLD.grootboekrekening_id
     OR NEW.btw_percentage       IS DISTINCT FROM OLD.btw_percentage
     OR NEW.match_status         IS DISTINCT FROM OLD.match_status
  ) THEN
    RAISE EXCEPTION 'Deze banktransactie is geboekt in het grootboek; rekening, BTW en status kunnen niet meer worden gewijzigd. Een correctie vereist een tegenboeking.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- 5. De writer
CREATE OR REPLACE FUNCTION public.post_bank_transaction(_transaction_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_tx           public.bank_transactions%ROWTYPE;
  v_client       public.clients%ROWTYPE;
  v_group_id     uuid := gen_random_uuid();
  v_boekjaar     integer;
  v_gross        numeric(12,2);
  v_net          numeric(12,2);
  v_btw          numeric(12,2);
  v_pct          numeric;
  v_btw_account  uuid;
  v_line_no      integer := 0;
  v_desc         text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_tx
  FROM public.bank_transactions
  WHERE id = _transaction_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Banktransactie niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  IF v_tx.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_tx.organization_id, 'assistant') THEN
    RAISE EXCEPTION 'Geen rechten om te boeken voor deze organisatie' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_client FROM public.clients WHERE id = v_tx.client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_tx.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  IF v_tx.match_status <> 'handmatig_geboekt' THEN
    RAISE EXCEPTION 'Alleen handmatig gecodeerde banktransacties kunnen zo geboekt worden' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = v_tx.id) THEN
    RAISE EXCEPTION 'Deze banktransactie is aan een factuur gekoppeld; boek die via de aflettering' USING ERRCODE = '22023';
  END IF;

  IF v_tx.grootboekrekening_id IS NULL THEN
    RAISE EXCEPTION 'Deze banktransactie heeft nog geen grootboekrekening' USING ERRCODE = '22023';
  END IF;

  IF v_tx.amount = 0 THEN
    RAISE EXCEPTION 'Een banktransactie van nul kan niet geboekt worden' USING ERRCODE = '22023';
  END IF;

  IF v_client.bank_rekening_id IS NULL THEN
    RAISE EXCEPTION 'Geen bankrekening (grootboek) ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  v_boekjaar := EXTRACT(YEAR FROM v_tx.transaction_date)::integer;
  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar USING ERRCODE = '22023';
  END IF;

  IF NOT public.posting_account_ok(v_client.bank_rekening_id, v_tx.organization_id, v_tx.client_id) THEN
    RAISE EXCEPTION 'De ingestelde bankrekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';
  END IF;

  IF NOT public.posting_account_ok(v_tx.grootboekrekening_id, v_tx.organization_id, v_tx.client_id) THEN
    RAISE EXCEPTION 'De gekozen grootboekrekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';
  END IF;

  -- BTW: vrijgestelde administraties boeken nooit BTW.
  v_pct := CASE WHEN v_client.btw_vrijgesteld THEN 0 ELSE COALESCE(v_tx.btw_percentage, 0) END;
  IF v_pct < 0 OR v_pct >= 100 THEN
    RAISE EXCEPTION 'Ongeldig BTW-percentage (%) op deze banktransactie', v_tx.btw_percentage USING ERRCODE = '22023';
  END IF;

  v_gross := round(abs(v_tx.amount), 2);
  v_net   := round(v_gross / (1 + v_pct / 100), 2);
  v_btw   := v_gross - v_net;

  IF v_btw > 0 THEN
    v_btw_account := CASE WHEN v_tx.amount < 0
      THEN v_client.btw_te_vorderen_rekening_id
      ELSE v_client.btw_te_betalen_rekening_id END;
    IF v_btw_account IS NULL THEN
      RAISE EXCEPTION 'Geen BTW-rekening ingesteld voor deze administratie' USING ERRCODE = '22023';
    END IF;
    IF NOT public.posting_account_ok(v_btw_account, v_tx.organization_id, v_tx.client_id) THEN
      RAISE EXCEPTION 'De ingestelde BTW-rekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';
    END IF;
  END IF;

  v_desc := COALESCE(NULLIF(btrim(v_tx.description), ''), 'Bankboeking');

  BEGIN
    INSERT INTO public.bank_transaction_postings (
      bank_transaction_id, posting_group_id, organization_id, client_id,
      grootboekrekening_id, posting_date, boekjaar,
      gross_amount, net_amount, btw_amount, btw_percentage, user_id
    ) VALUES (
      v_tx.id, v_group_id, v_tx.organization_id, v_tx.client_id,
      v_tx.grootboekrekening_id, v_tx.transaction_date, v_boekjaar,
      v_gross, v_net, v_btw, NULLIF(v_pct, 0), v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze banktransactie is al geboekt' USING ERRCODE = '23505';
  END;

  IF v_tx.amount < 0 THEN
    -- Geld eraf: kosten/rekening debet (netto) + BTW te vorderen debet, bank credit.
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, user_id
    ) VALUES (
      v_tx.organization_id, v_tx.client_id, v_tx.grootboekrekening_id, v_group_id, v_line_no,
      v_tx.transaction_date, v_boekjaar, v_net, 0, 'EUR',
      v_desc, 'bank_transaction', v_tx.id, v_uid
    );

    IF v_btw > 0 THEN
      v_line_no := v_line_no + 1;
      INSERT INTO public.ledger_postings (
        organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
        posting_date, boekjaar, debit_amount, credit_amount, currency,
        description, source_type, source_id, user_id
      ) VALUES (
        v_tx.organization_id, v_tx.client_id, v_btw_account, v_group_id, v_line_no,
        v_tx.transaction_date, v_boekjaar, v_btw, 0, 'EUR',
        'BTW ' || v_desc, 'bank_transaction', v_tx.id, v_uid
      );
    END IF;

    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, user_id
    ) VALUES (
      v_tx.organization_id, v_tx.client_id, v_client.bank_rekening_id, v_group_id, v_line_no,
      v_tx.transaction_date, v_boekjaar, 0, v_gross, 'EUR',
      v_desc, 'bank_transaction', v_tx.id, v_uid
    );
  ELSE
    -- Geld erbij: bank debet, opbrengst/rekening credit (netto) + BTW te betalen credit.
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, user_id
    ) VALUES (
      v_tx.organization_id, v_tx.client_id, v_client.bank_rekening_id, v_group_id, v_line_no,
      v_tx.transaction_date, v_boekjaar, v_gross, 0, 'EUR',
      v_desc, 'bank_transaction', v_tx.id, v_uid
    );

    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, user_id
    ) VALUES (
      v_tx.organization_id, v_tx.client_id, v_tx.grootboekrekening_id, v_group_id, v_line_no,
      v_tx.transaction_date, v_boekjaar, 0, v_net, 'EUR',
      v_desc, 'bank_transaction', v_tx.id, v_uid
    );

    IF v_btw > 0 THEN
      v_line_no := v_line_no + 1;
      INSERT INTO public.ledger_postings (
        organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
        posting_date, boekjaar, debit_amount, credit_amount, currency,
        description, source_type, source_id, user_id
      ) VALUES (
        v_tx.organization_id, v_tx.client_id, v_btw_account, v_group_id, v_line_no,
        v_tx.transaction_date, v_boekjaar, 0, v_btw, 'EUR',
        'BTW ' || v_desc, 'bank_transaction', v_tx.id, v_uid
      );
    END IF;
  END IF;

  RETURN v_group_id;
END;
$$;

REVOKE ALL ON FUNCTION public.post_bank_transaction(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_bank_transaction(uuid) TO authenticated;