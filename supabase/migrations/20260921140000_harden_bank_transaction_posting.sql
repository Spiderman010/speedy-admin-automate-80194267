-- ─────────────────────────────────────────────────────────────────────────────
-- Correctieve verharding van de directe bankboeking (20260920195805)
--
-- Die migratie is TOEGEPAST en wordt hier niet aangeraakt. Dit bestand zet er
-- additief drie dingen naast recht, zonder één cijfer aan de boekhouding te
-- veranderen.
--
-- WAT ER MIS WAS
--
-- 1. MARKERRECHTEN. De markertabel kreeg `GRANT ALL ... TO service_role`. De
--    marker is geen gewone tabel: haar primary key ÍS de idempotentiegarantie
--    ("deze banktransactie is precies één keer geboekt") en de claimtrigger op
--    ledger_postings leest hem als enige waarheid. Een rol die hem zelf mag
--    schrijven kan een claim verzinnen (en zo een legitieme boeking voor altijd
--    blokkeren) of er een verwijderen (en zo een dubbele boeking mogelijk
--    maken). Alle vijf de oudere markertabellen staan daarom op REVOKE ALL
--    gevolgd door GRANT SELECT; deze wijkt daarvan af.
--
-- 2. FUNCTIERECHTEN. Er stond alleen `REVOKE ALL ... FROM PUBLIC`. Dat is niet
--    genoeg: Lovable Cloud is er meermaals op betrapt dat het rechten
--    rechtstreeks aan `anon` of `service_role` geeft, en zo'n grant overleeft
--    een REVOKE die alleen PUBLIC noemt. Elke applicatierol moet expliciet
--    worden genoemd — zoals bij post_purchase_invoice, post_sales_invoice,
--    post_bank_allocation, post_manual_journal, post_opening_balance en
--    reverse_posting_group.
--
-- 3. TENANT-ORAKEL. De schrijver onderscheidde een niet-bestaande
--    banktransactie ('Banktransactie niet gevonden', P0002) van een
--    banktransactie van een andere organisatie ('Geen rechten om te boeken
--    voor deze organisatie', 42501). Omdat de functie SECURITY DEFINER is en
--    dus rijen ziet die RLS voor de aanroeper verbergt, is dat verschil een
--    orakel: een ingelogde buitenstaander kan id's aanbieden en aan de
--    foutboodschap aflezen wélke bestaan. Dat is een cross-tenant existence
--    leak, hoe klein ook.
--
-- DE NIEUWE POORT, IN TWEE DREMPELS
--
--   a. LEESDREMPEL — bestaat de rij niet, óf heeft de aanroeper geen
--      `read_only` op haar organisatie, dan is het antwoord exact hetzelfde:
--
--          SQLSTATE 42501   |   Banktransactie niet beschikbaar
--
--      Eén tekst, één code, geen enkel verschil om aan af te lezen.
--
--   b. SCHRIJFDREMPEL — haalt de aanroeper de leesdrempel, dan mag hij deze
--      banktransactie onder RLS toch al SELECTeren (`role_bank_transactions_select`
--      staat op `read_only`, organisatiebreed). Hem dan eerlijk vertellen dat
--      er `assistant` nodig is verraadt niets wat hij niet al kan opvragen, en
--      het scheelt een onbegrijpelijke melding. De rolvloer zelf is
--      ONGEWIJZIGD: assistant, precies als in de toegepaste migratie.
--
-- Pas ná beide drempels volgt élke inhoudelijke melding (status, koppeling,
-- rekening, bedrag, boekjaar, BTW).
--
-- WAT NADRUKKELIJK ONGEWIJZIGD BLIJFT
--   • debet/credit, de richting bij inkomend/uitgaand geld en de regelvolgorde;
--   • de BTW-splitsing (round(gross / (1 + pct/100), 2), btw = gross - net) en
--     de vrijstellingsregel;
--   • de keuze van bankrekening, tegenrekening en BTW-rekening;
--   • de afgesloten-boekjaarregel en de rolvloer `assistant`;
--   • source_type 'bank_transaction', de markeridentiteit en de claimtrigger;
--   • `SELECT ... FOR UPDATE` op exact dezelfde plek: de grendel blijft de
--     eerste aanraking van de rij, zodat het gelijktijdigheidsgedrag
--     letterlijk hetzelfde is als in de toegepaste versie. Alleen de
--     meldingen die daarna volgen zijn veranderd.
--
-- De functie wordt integraal opnieuw gedefinieerd, want een functielichaam is
-- niet te patchen. Alles buiten de poort is een letterlijke kopie van
-- 20260920195805.
--
-- LEESCONTROLE VOORAF (read-only, vóór toepassen in de Lovable Cloud SQL
-- editor van project alxlbdhpbwlehbdbfejw):
--
--   -- (a) de huidige rechten op de marker; verwacht o.a. service_role met ALL
--   SELECT grantee, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'public' AND table_name = 'bank_transaction_postings'
--   ORDER BY grantee, privilege_type;
--
--   -- (b) de huidige rechten op de functie
--   SELECT p.proname, pg_catalog.array_to_string(p.proacl, E'\n') AS acl
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'post_bank_transaction';
--
--   -- (c) de tabel en de functie moeten bestaan; verwacht beide gevuld
--   SELECT to_regclass('public.bank_transaction_postings') AS marker,
--          to_regprocedure('public.post_bank_transaction(uuid)') AS writer;
--
-- CONTROLE ACHTERAF: dezelfde queries (a) en (b). Verwacht:
--   marker   → authenticated SELECT, service_role SELECT, anon niets
--   functie  → uitsluitend authenticated EXECUTE
--
-- rollback — zet de rechten terug zoals 20260920195805 ze liet staan en
-- herstel de oude meldingen. De oude meldingen terugzetten betekent het
-- orakel terugzetten; doe dat alleen als deze migratie aantoonbaar iets breekt.
--   GRANT ALL ON public.bank_transaction_postings TO service_role;
--   -- en 20260920195805 opnieuw toepassen voor de oude functietekst.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0) Prerequisite guard ───────────────────────────────────────────────────
-- plpgsql valideert tabelverwijzingen niet bij CREATE FUNCTION; zonder deze
-- guard zou dit bestand schoon toepassen op een database zonder de toegepaste
-- bankmigratie en pas bij het eerste gebruik omvallen.

DO $$
BEGIN
  IF to_regclass('public.bank_transaction_postings') IS NULL THEN
    RAISE EXCEPTION 'Vereist: public.bank_transaction_postings (20260920195805)';
  END IF;
  IF to_regprocedure('public.post_bank_transaction(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Vereist: public.post_bank_transaction(uuid) (20260920195805)';
  END IF;
  IF to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Vereist: public.posting_account_ok(uuid,uuid,uuid) (6C-b2)';
  END IF;
  IF to_regprocedure('public.has_min_role(uuid,uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'Vereist: public.has_min_role(uuid,uuid,app_role)';
  END IF;
END
$$;

-- ── 1) Markerrechten: lezen mag, schrijven niet ─────────────────────────────
-- REVOKE ALL gevolgd door GRANT SELECT, geen opsomming: een opsomming kan
-- altijd één privilege tekortkomen ten opzichte van wat een platformdefault
-- morgen uitdeelt (MAINTAIN in PostgreSQL 17, bijvoorbeeld). REVOKE ALL wist
-- alles wat die rol op deze tabel heeft, bekend of niet, en daarna wordt
-- precies het bedoelde leesrecht teruggegeven.

REVOKE ALL ON public.bank_transaction_postings FROM anon, authenticated, service_role;
GRANT SELECT ON public.bank_transaction_postings TO authenticated, service_role;

COMMENT ON TABLE public.bank_transaction_postings IS
'Claim-registratie: bewijst dat één banktransactie precies één keer rechtstreeks in het grootboek is geboekt. De primary key op bank_transaction_id ís de idempotentiegarantie. Alleen public.post_bank_transaction() schrijft hier; applicatierollen mogen uitsluitend lezen.';

-- ── 2) Functierechten: elke applicatierol expliciet ─────────────────────────

REVOKE ALL ON FUNCTION public.post_bank_transaction(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_bank_transaction(uuid) TO authenticated;

-- ── 3) De schrijver, met de tenantpoort vooraan ─────────────────────────────

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

  -- De grendel blijft de eerste aanraking van de rij: exact dezelfde
  -- SELECT ... FOR UPDATE als in de toegepaste migratie, op exact dezelfde
  -- plek. Het gelijktijdigheidsgedrag verandert dus niet; alleen wat er
  -- daarna wordt gezegd.
  SELECT * INTO v_tx
  FROM public.bank_transactions
  WHERE id = _transaction_id
  FOR UPDATE;

  -- LEESDREMPEL. "Bestaat niet" en "niet van jou" zijn vanaf hier niet meer
  -- van elkaar te onderscheiden: dezelfde SQLSTATE, dezelfde tekst. Onder
  -- read_only verbergt RLS deze rij sowieso (role_bank_transactions_select),
  -- dus deze functie mag haar bestaan ook niet bevestigen.
  IF NOT FOUND
     OR v_tx.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_tx.organization_id, 'read_only') THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  -- SCHRIJFDREMPEL. Wie hier komt mag de rij onder RLS toch al lezen, dus een
  -- eerlijk antwoord over zijn eigen rol verraadt niets nieuws. De vloer is
  -- ongewijzigd: assistant.
  IF NOT public.has_min_role(v_uid, v_tx.organization_id, 'assistant') THEN
    RAISE EXCEPTION 'Geen rechten om te boeken voor deze organisatie' USING ERRCODE = '42501';
  END IF;

  -- ── Vanaf hier is alles een letterlijke kopie van 20260920195805 ──────────

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

-- CREATE OR REPLACE behoudt de bestaande ACL van de functie; de REVOKE/GRANT
-- hierboven staan er dus bewust vóór. Voor de zekerheid nog eens, zodat de
-- eindtoestand niet van die volgorde afhangt.
REVOKE ALL ON FUNCTION public.post_bank_transaction(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_bank_transaction(uuid) TO authenticated;

COMMENT ON FUNCTION public.post_bank_transaction(uuid) IS
'Boekt één handmatig gecodeerde banktransactie rechtstreeks in het grootboek en claimt haar in bank_transaction_postings, atomair en precies één keer. Vereist de rol assistant. Een onbekende banktransactie en een banktransactie waarvoor de aanroeper geen leesrecht heeft, geven exact dezelfde fout ("Banktransactie niet beschikbaar", SQLSTATE 42501), zodat het antwoord nooit het bestaan van andermans administratie bevestigt; inhoudelijke meldingen volgen pas daarna. Boekhoudkundig identiek aan 20260920195805.';
