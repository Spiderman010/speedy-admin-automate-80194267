-- ROLLBACK van 20261018150000_keep_bank_description_on_correction.
--
-- Alleen met akkoord van de eigenaar, in de Lovable Cloud SQL editor van
-- project alxlbdhpbwlehbdbfejw. Zet reclassify_bank_transaction byte-gelijk
-- terug naar de versie uit 20261018120000 (PR 1), met haar rechten en
-- commentaar. Data-neutraal: geen rij wordt gewijzigd. Daarna schrijft een
-- correctie met _description weer in bank_transactions.description (het
-- gedrag van PR 1).
--
-- Verwacht na afloop: md5(prosrc) van reclassify_bank_transaction =
-- a931207c1a4e97f06e7797ed105c0264 (de POST-pin van PR 1).

-- Alleen vanuit de beoordeelde toestand: de functie is die van PR 2 (of al die
-- van PR 1, bij een tweede uitvoering). Anders gebeurt er niets.
DO $rollback$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('067939e0c44a672c26ec8883717ef6d2', 'a931207c1a4e97f06e7797ed105c0264') THEN
    RAISE EXCEPTION 'Rollback geweigerd: reclassify_bank_transaction is niet de beoordeelde versie (md5 %)', v_md5 USING ERRCODE = '55000';
  END IF;
END
$rollback$;

CREATE OR REPLACE FUNCTION public.reclassify_bank_transaction(
  _transaction_id            uuid,
  _expected_posting_group_id uuid,
  _grootboekrekening_id      uuid,
  _btw_percentage            numeric,
  _request_id                uuid,
  _reason                    text DEFAULT NULL,
  _description               text DEFAULT NULL
)
RETURNS TABLE (
  outcome                     text,
  replayed                    boolean,
  posting_group_id            uuid,
  superseded_posting_group_id uuid,
  reversal_posting_group_id   uuid,
  event_id                    uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid         uuid := auth.uid();
  v_reason      text;
  v_desc_arg    text;
  v_new_desc    text;
  v_old_desc    text;
  v_tx          public.bank_transactions%ROWTYPE;
  v_client      public.clients%ROWTYPE;
  v_account     public.grootboekrekeningen%ROWTYPE;
  v_prev        public.bank_transaction_posting_events%ROWTYPE;
  v_marker      public.bank_transaction_postings%ROWTYPE;
  v_has_marker  boolean;
  v_last        text;
  v_state       text;
  v_reversal    uuid;
  v_lines       integer;
  v_line_acct   uuid;
  v_line_amount numeric;
  v_vat_acct    uuid;
  v_new_group   uuid;
  v_event       uuid;
  v_last_rev    uuid;
  v_rev_date    date;
BEGIN
  -- (0) Alleen de argumenten: niets over opgeslagen gegevens.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een bankcorrectie kan alleen in een READ COMMITTED transactie (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  IF _transaction_id IS NULL OR _grootboekrekening_id IS NULL OR _btw_percentage IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'Banktransactie, grootboekrekening, BTW-percentage en request_id zijn verplicht' USING ERRCODE = '22004';
  END IF;
  IF _btw_percentage NOT IN (0, 9, 21) THEN
    RAISE EXCEPTION 'Alleen 0, 9 of 21 procent BTW is toegestaan' USING ERRCODE = '22023';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(_reason, ''), E' \t\r\n'), '');
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'De toelichting is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;
  v_desc_arg := NULLIF(btrim(COALESCE(_description, ''), E' \t\r\n'), '');
  IF length(v_desc_arg) > 500 THEN
    RAISE EXCEPTION 'De omschrijving is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;

  -- (1) De rijgrendel: elk verzoek op deze transactie wacht hier op het vorige.
  SELECT * INTO v_tx
  FROM public.bank_transactions bt
  WHERE bt.id = _transaction_id
  FOR UPDATE;

  -- (2) Leesdrempel: "bestaat niet" en "niet van jou" zijn niet te onderscheiden.
  IF NOT FOUND
     OR v_tx.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_tx.organization_id, 'read_only') THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  -- (3) Schrijfdrempel.
  IF NOT public.has_min_role(v_uid, v_tx.organization_id, 'assistant') THEN
    RAISE EXCEPTION 'Geen rechten om te boeken voor deze organisatie' USING ERRCODE = '42501';
  END IF;

  -- (4) Herhaling: alleen eigen request_id's, en pas na de drempels.
  SELECT e.* INTO v_prev
  FROM public.bank_transaction_posting_events e
  WHERE e.actor_id = v_uid AND e.request_id = _request_id
  ORDER BY e.seq DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_prev.bank_transaction_id IS DISTINCT FROM v_tx.id
       OR v_prev.request_kind <> 'reclassify'
       OR v_prev.event_type NOT IN ('posted', 'reclassified', 'reposted', 'unchanged')
       OR v_prev.expected_posting_group_id IS DISTINCT FROM _expected_posting_group_id
       OR v_prev.requested_grootboekrekening_id IS DISTINCT FROM _grootboekrekening_id
       OR v_prev.requested_btw_percentage IS DISTINCT FROM _btw_percentage
       OR v_prev.requested_description IS DISTINCT FROM v_desc_arg
       OR v_prev.reason IS DISTINCT FROM v_reason THEN
      RAISE EXCEPTION 'Deze request_id is al gebruikt voor een andere aanvraag; gebruik een nieuwe' USING ERRCODE = '22023';
    END IF;

    IF (v_prev.event_type <> 'posted'
        OR EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                   WHERE e.actor_id = v_uid AND e.request_id = _request_id AND e.event_type = 'returned'))
       AND NOT public.has_min_role(v_uid, v_tx.organization_id, 'accountant') THEN
      RAISE EXCEPTION 'Geen rechten om een geboekte banktransactie te corrigeren (accountant vereist)' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY SELECT
      CASE WHEN EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                        WHERE e.actor_id = v_uid AND e.request_id = _request_id AND e.event_type = 'returned')
           THEN 'reposted_after_release' ELSE v_prev.event_type END,
      true,
      COALESCE(v_prev.replacement_posting_group_id,
               CASE WHEN v_prev.event_type = 'unchanged' THEN v_prev.expected_posting_group_id END),
      v_prev.superseded_posting_group_id,
      v_prev.reversal_posting_group_id,
      v_prev.id;
    RETURN;
  END IF;

  -- De administratie moet bij de organisatie van de transactie horen — vóór de
  -- boekingsblokkade, zodat die nooit iets over een andere tenant zegt of
  -- grendelt (RLS toetst alleen de organisatie op de bankregel zelf).
  IF NOT EXISTS (SELECT 1 FROM public.clients c
                 WHERE c.id = v_tx.client_id AND c.organization_id = v_tx.organization_id) THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  -- (5) De boekingsblokkade op de transactiedatum; neemt eerst de
  --     administratiegrendel, zodat een blokkade niet tussendoor kan wijzigen.
  PERFORM public.assert_posting_allowed(v_tx.client_id, v_tx.transaction_date);

  -- De configuratie ligt vast tot COMMIT: een gelijktijdige wijziging van de
  -- bank- of BTW-rekening kan niet tussen toets en boeking vallen.
  SELECT * INTO v_client
  FROM public.clients c
  WHERE c.id = v_tx.client_id
  FOR SHARE;

  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_tx.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  -- (6) De toestand, onder de grendels gelezen.
  SELECT m.* INTO v_marker
  FROM public.bank_transaction_postings m
  WHERE m.bank_transaction_id = v_tx.id;
  v_has_marker := FOUND;

  IF v_has_marker THEN
    SELECT r.reversal_posting_group_id INTO v_reversal
    FROM public.ledger_reversal_postings r
    WHERE r.original_posting_group_id = v_marker.posting_group_id;
    v_state := CASE WHEN v_reversal IS NULL THEN 'S1' ELSE 'S2' END;
  ELSE
    SELECT e.event_type, e.reversal_posting_group_id INTO v_last, v_last_rev
    FROM public.bank_transaction_posting_events e
    WHERE e.bank_transaction_id = v_tx.id
    ORDER BY e.seq DESC
    LIMIT 1;
    IF v_last IN ('posted', 'reclassified', 'reposted') THEN
      RAISE EXCEPTION 'De boekingsgeschiedenis van deze banktransactie is niet consistent; corrigeer niet automatisch' USING ERRCODE = '23514';
    END IF;
    v_state := CASE WHEN v_last = 'released' THEN 'S3' ELSE 'S0' END;
  END IF;

  -- (7a) Verwachte toestand.
  IF (v_state IN ('S0', 'S3') AND _expected_posting_group_id IS NOT NULL)
     OR (v_state IN ('S1', 'S2') AND _expected_posting_group_id IS DISTINCT FROM v_marker.posting_group_id) THEN
    RAISE EXCEPTION 'De boekingstoestand is gewijzigd; ververs en probeer opnieuw' USING ERRCODE = '55000';
  END IF;

  -- (7b) Factuurkoppelingen vallen buiten v1.
  IF EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = v_tx.id) THEN
    RAISE EXCEPTION 'Deze banktransactie is aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie' USING ERRCODE = '22023';
  END IF;

  -- (7b') Ook een gematchte transactie zonder koppelingsrij (een oudere koppeling
  --       via de match) is een factuurkoppeling. Dat kan alleen in S0: een
  --       directe boeking staat altijd op handmatig_geboekt. Een factuurmatch op
  --       een handmatig geboekte regel (een achtergebleven suggestie) laat de RPC
  --       ongemoeid; alleen een onbevestigde suggestie wordt gewist (zie de UPDATE).
  IF v_tx.match_status = 'gematcht' THEN
    RAISE EXCEPTION 'Deze banktransactie is via de match aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie' USING ERRCODE = '22023';
  END IF;

  -- (7c) Een geboekte of vrijgegeven transactie: accountant en een toelichting.
  IF v_state <> 'S0' THEN
    IF NOT public.has_min_role(v_uid, v_tx.organization_id, 'accountant') THEN
      RAISE EXCEPTION 'Geen rechten om een geboekte banktransactie te corrigeren (accountant vereist)' USING ERRCODE = '42501';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'Een toelichting (1 tot 500 tekens) is verplicht bij het corrigeren van een geboekte banktransactie' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- (7c') Een bestaande storno op een latere datum dan de transactie: opnieuw
  --       boeken op de transactiedatum zou bank, kosten en BTW in de periode
  --       daartussen dubbel boeken. Alleen een storno op de transactiedatum
  --       (zoals deze RPC er zelf een maakt) laat herboeken toe.
  IF v_state IN ('S2', 'S3') THEN
    SELECT r.posting_date INTO v_rev_date
    FROM public.ledger_reversal_postings r
    WHERE r.reversal_posting_group_id = CASE WHEN v_state = 'S2' THEN v_reversal ELSE v_last_rev END;
    IF v_rev_date IS DISTINCT FROM v_tx.transaction_date THEN
      RAISE EXCEPTION 'De tegenboeking staat op %, niet op de transactiedatum %: opnieuw boeken op de transactiedatum zou de periode daartussen dubbel boeken. Corrigeer dit met een memoriaalboeking.',
        v_rev_date, v_tx.transaction_date
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- (7d) De nieuwe codering. Eerst de reikwijdte (zonder grendel: een rekening
  --      van een andere tenant wordt nooit gegrendeld), dan de rekening FOR
  --      SHARE tot COMMIT: een gelijktijdige deactivering kan niet tussen deze
  --      toets en de boeking vallen — de schrijver toetst `actief` zelf niet.
  IF NOT public.posting_account_ok(_grootboekrekening_id, v_tx.organization_id, v_tx.client_id) THEN
    RAISE EXCEPTION 'De gekozen grootboekrekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';
  END IF;
  SELECT g.* INTO v_account
  FROM public.grootboekrekeningen g
  WHERE g.id = _grootboekrekening_id
  FOR SHARE;
  IF NOT FOUND OR NOT COALESCE(v_account.actief, false) THEN
    RAISE EXCEPTION 'De gekozen grootboekrekening is niet actief' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_client.btw_vrijgesteld, false) AND _btw_percentage <> 0 THEN
    RAISE EXCEPTION 'Deze administratie is btw-vrijgesteld; alleen 0 procent BTW is toegestaan' USING ERRCODE = '22023';
  END IF;
  IF _btw_percentage > 0
     AND (CASE WHEN v_tx.amount < 0 THEN v_client.btw_te_vorderen_rekening_id
               ELSE v_client.btw_te_betalen_rekening_id END) IS NULL THEN
    RAISE EXCEPTION 'Geen BTW-rekening ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  -- De omschrijving die de schrijver straks gebruikt, met zijn eigen regel.
  v_new_desc := COALESCE(NULLIF(btrim(COALESCE(v_desc_arg, v_tx.description)), ''), 'Bankboeking');

  IF v_state IN ('S1', 'S2') THEN
    SELECT lp.description INTO v_old_desc
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = v_marker.posting_group_id
    ORDER BY lp.line_no, lp.id
    LIMIT 1;
  END IF;

  -- (7e) D7: een correctie verplaatst geen bedragen naar een andere bank- of
  --      BTW-rekening. Alleen voor een actieve (niet tegengeboekte) groep.
  IF v_state = 'S1' THEN
    -- De bankzijde: credit bij geld eraf, debet bij geld erbij — precies één regel.
    SELECT count(*), min(lp.grootboekrekening_id::text)::uuid INTO v_lines, v_line_acct
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = v_marker.posting_group_id
      AND ((v_tx.amount < 0 AND lp.credit_amount > 0) OR (v_tx.amount > 0 AND lp.debit_amount > 0));
    IF v_lines <> 1 THEN
      RAISE EXCEPTION 'De bestaande boeking heeft niet de vorm van een directe bankboeking; corrigeer haar via het grootboek' USING ERRCODE = '23514';
    END IF;
    IF v_line_acct IS DISTINCT FROM v_client.bank_rekening_id THEN
      RAISE EXCEPTION 'De bankrekening van deze administratie is gewijzigd sinds de boeking; een correctie zou het bedrag naar een andere bankrekening verplaatsen. Geef de boeking vrij en boek haar daarna opnieuw.'
        USING ERRCODE = '23514';
    END IF;

    -- De tegenzijde: de kostenregel, plus de BTW-regel als er BTW is geboekt.
    SELECT count(*) INTO v_lines
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = v_marker.posting_group_id
      AND ((v_tx.amount < 0 AND lp.debit_amount > 0) OR (v_tx.amount > 0 AND lp.credit_amount > 0));
    IF v_lines <> (CASE WHEN v_marker.btw_amount > 0 THEN 2 ELSE 1 END) THEN
      RAISE EXCEPTION 'De bestaande boeking heeft niet de vorm van een directe bankboeking; corrigeer haar via het grootboek' USING ERRCODE = '23514';
    END IF;

    IF v_marker.btw_amount > 0 THEN
      SELECT lp.grootboekrekening_id, lp.debit_amount + lp.credit_amount INTO v_line_acct, v_line_amount
      FROM public.ledger_postings lp
      WHERE lp.posting_group_id = v_marker.posting_group_id
        AND ((v_tx.amount < 0 AND lp.debit_amount > 0) OR (v_tx.amount > 0 AND lp.credit_amount > 0))
      ORDER BY lp.line_no DESC, lp.id DESC
      LIMIT 1;
      IF v_line_amount IS DISTINCT FROM v_marker.btw_amount THEN
        RAISE EXCEPTION 'De bestaande boeking heeft niet de vorm van een directe bankboeking; corrigeer haar via het grootboek' USING ERRCODE = '23514';
      END IF;
      v_vat_acct := CASE WHEN v_tx.amount < 0 THEN v_client.btw_te_vorderen_rekening_id
                         ELSE v_client.btw_te_betalen_rekening_id END;
      IF v_line_acct IS DISTINCT FROM v_vat_acct THEN
        RAISE EXCEPTION 'De BTW-rekening van deze administratie is gewijzigd sinds de boeking; een correctie zou BTW naar een andere rekening verplaatsen. Geef de boeking vrij en boek haar daarna opnieuw.'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    -- (7f) Effectief dezelfde codering en omschrijving: niets te boeken. De
    --      aanvraag wordt wel vastgelegd, zodat haar request_id verbruikt is:
    --      een herhaling (bv. na een verloren antwoord) geeft exact dit antwoord,
    --      ook als de boeking inmiddels handmatig is tegengeboekt.
    IF v_marker.grootboekrekening_id = _grootboekrekening_id
       AND COALESCE(v_marker.btw_percentage, 0) = _btw_percentage
       AND v_old_desc IS NOT DISTINCT FROM v_new_desc THEN
      INSERT INTO public.bank_transaction_posting_events (
        request_id, actor_id, request_kind, event_type,
        bank_transaction_id, organization_id, client_id,
        expected_posting_group_id,
        requested_grootboekrekening_id, requested_btw_percentage, requested_description,
        reason, created_xact_id
      ) VALUES (
        _request_id, v_uid, 'reclassify', 'unchanged',
        v_tx.id, v_tx.organization_id, v_tx.client_id,
        _expected_posting_group_id,
        _grootboekrekening_id, _btw_percentage, v_desc_arg,
        v_reason, pg_current_xact_id()
      )
      RETURNING id INTO v_event;
      RETURN QUERY SELECT 'unchanged'::text, false, v_marker.posting_group_id, NULL::uuid, NULL::uuid, v_event;
      RETURN;
    END IF;
  END IF;

  -- (8) De mutaties, in vaste volgorde. Grootboekregels komen uitsluitend van
  --     reverse_posting_group() en post_bank_transaction().
  IF v_state = 'S1' THEN
    v_reversal := public.reverse_posting_group(v_marker.posting_group_id, v_tx.transaction_date, v_reason);
  END IF;

  IF v_state IN ('S1', 'S2') THEN
    DELETE FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = v_tx.id;
  ELSIF v_state = 'S3' THEN
    INSERT INTO public.bank_transaction_posting_events (
      request_id, actor_id, request_kind, event_type,
      bank_transaction_id, organization_id, client_id,
      expected_posting_group_id, reason, created_xact_id
    ) VALUES (
      _request_id, v_uid, 'reclassify', 'returned',
      v_tx.id, v_tx.organization_id, v_tx.client_id,
      _expected_posting_group_id, v_reason, pg_current_xact_id()
    );
  END IF;

  -- De factuurmatch blijft zoals hij is (de RPC herrekent geen facturen), behalve
  -- een onbevestigde suggestie: die vervalt, zoals bij bulk boeken.
  UPDATE public.bank_transactions bt SET
    match_status         = 'handmatig_geboekt',
    grootboekrekening_id = _grootboekrekening_id,
    btw_percentage       = _btw_percentage,
    matched_invoice_id   = CASE WHEN v_tx.match_status = 'suggestie' THEN NULL ELSE bt.matched_invoice_id END,
    match_confidence     = CASE WHEN v_tx.match_status = 'suggestie' THEN NULL ELSE bt.match_confidence END,
    description          = COALESCE(v_desc_arg, bt.description)
  WHERE bt.id = v_tx.id;

  v_new_group := public.post_bank_transaction(v_tx.id);

  INSERT INTO public.bank_transaction_posting_events (
    request_id, actor_id, request_kind, event_type,
    bank_transaction_id, organization_id, client_id,
    expected_posting_group_id,
    superseded_posting_group_id, reversal_posting_group_id, replacement_posting_group_id,
    requested_grootboekrekening_id, requested_btw_percentage, requested_description, replacement_description,
    superseded_grootboekrekening_id, superseded_btw_percentage,
    superseded_gross_amount, superseded_net_amount, superseded_btw_amount,
    superseded_posting_date, superseded_boekjaar, superseded_posted_by, superseded_posted_at,
    superseded_description, reason, created_xact_id
  ) VALUES (
    _request_id, v_uid, 'reclassify',
    CASE v_state WHEN 'S1' THEN 'reclassified' WHEN 'S2' THEN 'reposted' ELSE 'posted' END,
    v_tx.id, v_tx.organization_id, v_tx.client_id,
    _expected_posting_group_id,
    CASE WHEN v_has_marker THEN v_marker.posting_group_id END,
    CASE WHEN v_has_marker THEN v_reversal END,
    v_new_group,
    _grootboekrekening_id, _btw_percentage, v_desc_arg, v_new_desc,
    CASE WHEN v_has_marker THEN v_marker.grootboekrekening_id END,
    CASE WHEN v_has_marker THEN v_marker.btw_percentage END,
    CASE WHEN v_has_marker THEN v_marker.gross_amount END,
    CASE WHEN v_has_marker THEN v_marker.net_amount END,
    CASE WHEN v_has_marker THEN v_marker.btw_amount END,
    CASE WHEN v_has_marker THEN v_marker.posting_date END,
    CASE WHEN v_has_marker THEN v_marker.boekjaar END,
    CASE WHEN v_has_marker THEN v_marker.user_id END,
    CASE WHEN v_has_marker THEN v_marker.created_at END,
    v_old_desc, v_reason, pg_current_xact_id()
  )
  RETURNING id INTO v_event;

  RETURN QUERY SELECT
    CASE v_state WHEN 'S0' THEN 'posted' WHEN 'S1' THEN 'reclassified'
                 WHEN 'S2' THEN 'reposted' ELSE 'reposted_after_release' END,
    false,
    v_new_group,
    CASE WHEN v_has_marker THEN v_marker.posting_group_id END,
    CASE WHEN v_has_marker THEN v_reversal END,
    v_event;
END;
$$;

REVOKE ALL ON FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text) IS
'Boekt een directe banktransactie met de opgegeven grootboekrekening, BTW (0/9/21) en optioneel een nieuwe omschrijving. Niet geboekt (S0): eerste boeking (assistant). Geboekt (S1): storno + herboeking op de transactiedatum, of unchanged bij dezelfde codering (vastgelegd, zodat een herhaling exact dat antwoord geeft). Handmatig tegengeboekt (S2): herboeking zonder tweede storno. Vrijgegeven (S3): returned + herboeking. S2 en S3 alleen als de bestaande storno op de transactiedatum staat (anders 22023: memoriaal). S1–S3 vereisen accountant en een toelichting. _expected_posting_group_id = de actieve groep (NULL = niet geboekt), anders 55000. Idempotent per (auth.uid(), _request_id). Grootboekregels alleen via reverse_posting_group en post_bank_transaction.';
