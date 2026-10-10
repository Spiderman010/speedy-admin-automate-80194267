-- ═════════════════════════════════════════════════════════════════════════════
-- BANK-MATCHAFWIJZINGEN — BLIJVENDE FEEDBACK BIJ "SUGGESTIE AFWIJZEN"
--
-- WAAROM
--   Een banksuggestie is vandaag (banktransactie → factuur) en wordt volledig in
--   de browser berekend (`rankCandidates()` in BankMatchDialog, de
--   "Automatisch voorstellen"-scan in Bank). "Afwijzen" zet alleen de
--   suggestievelden op `bank_transactions` terug; nergens ligt vast WELKE factuur
--   is afgewezen, dus de volgende scan stelt precies dezelfde factuur opnieuw voor.
--
--   Deze migratie legt die afwijzing vast als eigen, administratiegebonden feit:
--   één rij per (banktransactie, factuursoort, factuur). Meer niet.
--
-- WAT DEZE MIGRATIE NADRUKKELIJK NIET DOET
--   - Geen wijziging aan bank_transactions, bank_transaction_allocations,
--     facturen, ledger_postings of een boekingsmarker. Een afwijzing is metadata
--     naast de suggestie; zij verandert geen saldo, geen koppeling en geen boeking.
--   - Geen matching-, score- of boekingslogica in de database. Het onderdrukken
--     van een afgewezen suggestie gebeurt in de bestaande client-side matcher
--     (vervolg-PR, zodra de gegenereerde types deze tabel kennen).
--   - Geen backfill: er is geen historische bron van afwijzingen.
--   - Geen UPDATE: een afwijzing wordt vastgelegd of weggehaald, nooit herschreven.
--
-- IDENTITEIT EN ISOLATIE
--   - `organization_id` en `client_id` worden NOOIT uit de aanroeper geloofd:
--     de trigger leidt ze af uit de banktransactie. Een meegestuurde afwijkende
--     waarde wordt geweigerd, niet stilzwijgend vervangen.
--   - De factuur moet bestaan in de tabel van haar soort en bij dezelfde
--     administratie horen als de banktransactie.
--   - Een factuur die voor deze transactie al is gekoppeld (een rij in
--     bank_transaction_allocations) kan niet worden "afgewezen": een bevestigde
--     koppeling blijft onaangeroerd; eerst ontkoppelen.
--   - Daarna beslist RLS: invoegen en verwijderen vanaf `assistant`, lezen vanaf
--     `read_only`, altijd binnen de eigen organisatie, en `rejected_by` is de
--     aanroeper zelf.
--   - Idempotent: UNIQUE (bank_transaction_id, invoice_type, invoice_id). De
--     applicatie voegt in met ON CONFLICT DO NOTHING; een herhaling is een no-op.
--
-- PRODUCTIE
--   Toepassen uitsluitend via de Lovable Cloud SQL editor van project
--   alxlbdhpbwlehbdbfejw, ná review; daarna `types.ts` regenereren. Deze PR past
--   niets toe.
--
-- ROLLBACK (handmatig; verwijdert vastgelegde afwijzingen — er staat geen
-- boekhoudkundig feit in, alleen feedback):
-- ROLLBACK-BEGIN
--   DROP TABLE IF EXISTS public.bank_match_rejections;
--   DROP FUNCTION IF EXISTS public.enforce_bank_match_rejection_scope();
-- ROLLBACK-END
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten: fail closed ───────────────────────────────────────────────

DO $migratie$
BEGIN
  IF to_regproc('public.has_min_role') IS NULL THEN
    RAISE EXCEPTION 'Bank-matchafwijzingen vereisen eerst public.has_min_role()';
  END IF;
  IF to_regclass('public.bank_transactions') IS NULL
     OR to_regclass('public.bank_transaction_allocations') IS NULL
     OR to_regclass('public.purchase_invoices') IS NULL
     OR to_regclass('public.sales_invoices') IS NULL THEN
    RAISE EXCEPTION 'Bank-matchafwijzingen vereisen bank_transactions, bank_transaction_allocations, purchase_invoices en sales_invoices';
  END IF;
END
$migratie$;

-- ── 1. De tabel ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.bank_match_rejections (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  client_id           uuid        NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  bank_transaction_id uuid        NOT NULL REFERENCES public.bank_transactions (id) ON DELETE CASCADE,
  invoice_type        text        NOT NULL,
  invoice_id          uuid        NOT NULL,
  rejected_by         uuid        NOT NULL REFERENCES auth.users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_match_rejections_invoice_type_check CHECK (invoice_type IN ('inkoop', 'verkoop')),
  CONSTRAINT bank_match_rejections_unique UNIQUE (bank_transaction_id, invoice_type, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_bank_match_rejections_client ON public.bank_match_rejections (client_id);
CREATE INDEX IF NOT EXISTS idx_bank_match_rejections_organization ON public.bank_match_rejections (organization_id);

-- ── 2. Afleiding en grenzen (vóór RLS: de policy toetst de afgeleide rij) ──

CREATE OR REPLACE FUNCTION public.enforce_bank_match_rejection_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx_org    uuid;
  v_tx_client uuid;
  v_found     boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  SELECT bt.organization_id, bt.client_id INTO v_tx_org, v_tx_client
  FROM public.bank_transactions bt
  WHERE bt.id = NEW.bank_transaction_id;

  -- Onbekend of zonder organisatie: dezelfde neutrale fout, zodat het bestaan
  -- van andermans transacties niet af te lezen is. Lezen is daarna aan RLS.
  IF v_tx_client IS NULL OR v_tx_org IS NULL
     OR NOT public.has_min_role(auth.uid(), v_tx_org, 'read_only') THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  IF NEW.organization_id IS NOT NULL AND NEW.organization_id <> v_tx_org THEN
    RAISE EXCEPTION 'Organisatie hoort niet bij deze banktransactie' USING ERRCODE = '23514';
  END IF;
  IF NEW.client_id IS NOT NULL AND NEW.client_id <> v_tx_client THEN
    RAISE EXCEPTION 'Administratie hoort niet bij deze banktransactie' USING ERRCODE = '23514';
  END IF;
  NEW.organization_id := v_tx_org;
  NEW.client_id := v_tx_client;

  IF NEW.rejected_by IS NULL THEN
    NEW.rejected_by := auth.uid();
  END IF;

  IF NEW.invoice_type = 'inkoop' THEN
    SELECT EXISTS (SELECT 1 FROM public.purchase_invoices pi
                   WHERE pi.id = NEW.invoice_id AND pi.client_id = v_tx_client) INTO v_found;
  ELSIF NEW.invoice_type = 'verkoop' THEN
    SELECT EXISTS (SELECT 1 FROM public.sales_invoices si
                   WHERE si.id = NEW.invoice_id AND si.client_id = v_tx_client) INTO v_found;
  ELSE
    v_found := false;
  END IF;
  IF NOT v_found THEN
    RAISE EXCEPTION 'Factuur hoort niet bij de administratie van deze banktransactie' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (SELECT 1 FROM public.bank_transaction_allocations a
             WHERE a.bank_transaction_id = NEW.bank_transaction_id AND a.invoice_id = NEW.invoice_id) THEN
    RAISE EXCEPTION 'Deze factuur is al aan de banktransactie gekoppeld; ontkoppel eerst in plaats van af te wijzen'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_match_rejection_scope() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_bank_match_rejection_scope_trigger ON public.bank_match_rejections;
CREATE TRIGGER enforce_bank_match_rejection_scope_trigger
  BEFORE INSERT ON public.bank_match_rejections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_match_rejection_scope();

-- ── 3. RLS en rechten ───────────────────────────────────────────────────────

ALTER TABLE public.bank_match_rejections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_bank_match_rejections_select ON public.bank_match_rejections;
CREATE POLICY role_bank_match_rejections_select ON public.bank_match_rejections
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

DROP POLICY IF EXISTS role_bank_match_rejections_insert ON public.bank_match_rejections;
CREATE POLICY role_bank_match_rejections_insert ON public.bank_match_rejections
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_min_role(auth.uid(), organization_id, 'assistant')
    AND rejected_by = auth.uid()
  );

DROP POLICY IF EXISTS role_bank_match_rejections_delete ON public.bank_match_rejections;
CREATE POLICY role_bank_match_rejections_delete ON public.bank_match_rejections
  FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'assistant'));

-- Volledige reset, dan precies wat nodig is. Geen UPDATE voor wie dan ook.
REVOKE ALL ON public.bank_match_rejections FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.bank_match_rejections TO authenticated;
GRANT SELECT ON public.bank_match_rejections TO service_role;
