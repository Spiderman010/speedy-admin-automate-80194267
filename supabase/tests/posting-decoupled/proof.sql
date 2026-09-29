-- REAL POSTGRESQL PROOF for 6C-b11 PR H — deel 2, NA de migratie.
-- Run against a THROWAWAY local cluster only. See run-proof.sh.
--
-- Eén vraag: is de boekingsblokkade nu de ENIGE datumgrendel, zonder dat de
-- jaarafsluiting iets van haar betekenis, haar geschiedenis of haar
-- onafhankelijkheid verliest — en zonder dat er ergens een schrijfweg is
-- ontstaan die géén van beide toetst?

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- ═══ 0. DE MIGRATIE RAAKTE NIETS ANDERS ═════════════════════════════════════
--
-- Eerst, vóór enige boeking: wat is er veranderd tussen de momentopname van
-- deel 1 en nu? Precies acht functielichamen — en verder niets.

DO $$
DECLARE
  v_naam text;
  v_zelfde text := '';
  v_anders text := '';
BEGIN
  FOREACH v_naam IN ARRAY proof.changed_functions() LOOP
    PERFORM proof.snap_put('post.hash.' || v_naam, proof.hash(v_naam));
    IF proof.hash(v_naam) IS NOT DISTINCT FROM proof.snap_get('pre.hash.' || v_naam) THEN
      v_zelfde := v_zelfde || v_naam || ' ';
    END IF;
    IF proof.acl(v_naam) IS DISTINCT FROM proof.snap_get('pre.acl.' || v_naam) THEN
      v_anders := v_anders || v_naam || '(acl) ';
    END IF;
  END LOOP;
  PERFORM proof.record('0a', 'de acht herdefinieerde functies hebben een nieuw lichaam',
    v_zelfde = '', format('ongewijzigd gebleven: %s', COALESCE(NULLIF(v_zelfde, ''), 'niemand')));
  PERFORM proof.record('0b', 'maar exact dezelfde eigenaar, SECURITY DEFINER, search_path en rechten',
    v_anders = '', format('afwijkend: %s', COALESCE(NULLIF(v_anders, ''), 'niets')));

  v_anders := '';
  FOREACH v_naam IN ARRAY proof.untouched_functions() LOOP
    PERFORM proof.snap_put('post.hash.' || v_naam, proof.hash(v_naam));
    IF proof.hash(v_naam) IS DISTINCT FROM proof.snap_get('pre.hash.' || v_naam)
       OR proof.acl(v_naam) IS DISTINCT FROM proof.snap_get('pre.acl.' || v_naam) THEN
      v_anders := v_anders || v_naam || ' ';
    END IF;
  END LOOP;
  PERFORM proof.record('0c', 'levenscyclus, blokkade, assertie, nihilverklaring en bulk-orkestratie zijn byte-identiek gebleven',
    v_anders = '', format('afwijkend: %s', COALESCE(NULLIF(v_anders, ''), 'niets')));

  PERFORM proof.record('0d', 'er is geen enkele functie bijgekomen of verdwenen (geen resultaatboeking, geen doorrol)',
    proof.function_set() = proof.snap_get('pre.functions')
      AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname ~* '(result|resultaat|carry|doorrol)'));

  PERFORM proof.record('0e', 'posting_lock_events is onaangeroerd',
    proof.table_digest('public.posting_lock_events') = proof.snap_get('pre.digest.posting_lock_events'));
  PERFORM proof.record('0f', 'fiscal_year_events is onaangeroerd',
    proof.table_digest('public.fiscal_year_events') = proof.snap_get('pre.digest.fiscal_year_events'));
  PERFORM proof.record('0g', 'year_closures, het grootboek, elk watermerk en elke blokkade zijn onaangeroerd',
    proof.table_digest('public.year_closures') = proof.snap_get('pre.digest.year_closures')
      AND proof.table_digest('public.ledger_postings') = proof.snap_get('pre.digest.ledger_postings')
      AND (SELECT COALESCE(md5(string_agg(format('%s:%s:%s', id, afgesloten_boekjaar, posting_locked_through), '|' ORDER BY id)), 'leeg')
           FROM public.clients) = proof.snap_get('pre.digest.clients'));
  PERFORM proof.record('0h', 'de rechten en triggers op het grootboek zijn onaangeroerd (authenticated schrijft nog steeds niets)',
    format('auth:%s%s%s anon:%s svc:%s%s%s',
      has_table_privilege('authenticated', 'public.ledger_postings', 'INSERT'),
      has_table_privilege('authenticated', 'public.ledger_postings', 'UPDATE'),
      has_table_privilege('authenticated', 'public.ledger_postings', 'DELETE'),
      has_table_privilege('anon', 'public.ledger_postings', 'SELECT'),
      has_table_privilege('service_role', 'public.ledger_postings', 'INSERT'),
      has_table_privilege('service_role', 'public.ledger_postings', 'UPDATE'),
      has_table_privilege('service_role', 'public.ledger_postings', 'DELETE'))
      = proof.snap_get('pre.ledger_privs')
    AND proof.snap_get('pre.ledger_privs') LIKE 'auth:fff anon:f%'
    AND (SELECT string_agg(tgname || ':' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger
          WHERE tgrelid = 'public.ledger_postings'::regclass AND NOT tgisinternal) = proof.snap_get('pre.ledger_triggers'),
    proof.snap_get('pre.ledger_privs'));
END $$;

-- ═══ 1. SCENARIO A: AFGESLOTEN JAAR, GEEN BLOKKADE → HET WATERMERK WEIGERT NIET MEER ═
--
-- Dezelfde administratie als N1/N2 in deel 1. Daar weigerde het watermerk;
-- hier boekt dezelfde schrijver door. Dát is de negatieve controle.

DO $$
DECLARE
  v_c uuid;
  v_g uuid;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'A';
  PERFORM proof.snap_put('A.events', proof.events(v_c, 2025));
  PERFORM proof.snap_put('A.lock_events', (SELECT count(*)::text FROM public.posting_lock_events WHERE client_id = v_c));

  v_g := public.post_manual_journal(proof.mj_draft(v_c, DATE '2025-06-01'));
  INSERT INTO proof.subject VALUES ('A_groep', v_g);
  PERFORM proof.record('1', 'A: NÁ de migratie boekt een memoriaal in het afgesloten jaar (geen blokkade) — waar N1 vóór de migratie weigerde',
    v_g IS NOT NULL AND (SELECT count(*) FROM public.ledger_postings WHERE posting_group_id = v_g) = 2);

  PERFORM proof.expect_ok('1b', 'A: en een directe bankboeking (N2 weigerde vóór de migratie)',
    format('SELECT public.post_bank_transaction(%L)', proof.tx_draft(v_c, DATE '2025-06-02')));
END $$;

DO $$
DECLARE v_c uuid := proof.pl_client('PR H — A: beginbalans in afgesloten jaar');
BEGIN
  INSERT INTO proof.subject VALUES ('A_ob', v_c);
  PERFORM proof.seed_group(v_c, 2025);
END $$;
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'A_ob'), 2025);

DO $$
DECLARE
  v_c uuid;
  v_g uuid;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'A_ob';
  PERFORM proof.expect_ok('1c', 'A: de beginbalansschrijver boekt in een afgesloten jaar zonder blokkade',
    format('SELECT public.post_opening_balance(%L)', proof.ob_draft(v_c, DATE '2025-01-01')));

  -- De tegenboeking van de memoriaal uit bewijs 1, gedateerd in het afgesloten jaar.
  SELECT client_id INTO v_g FROM proof.subject WHERE rol = 'A_groep';
  PERFORM proof.expect_ok('1d', 'A: een tegenboeking gedateerd in het afgesloten jaar mag ook (geen blokkade)',
    format('SELECT public.reverse_posting_group(%L, DATE ''2025-06-03'', %L)', v_g, 'Correctie in afgesloten jaar'));

  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'A';
  PERFORM proof.record('1e', 'A: de boekjaarstatus, het watermerk en de gebeurtenissen zijn door die boekingen niet veranderd',
    proof.status(v_c, 2025) = 'closed' AND proof.watermark(v_c) = 2025 AND proof.lock_of(v_c) IS NULL
      AND proof.events(v_c, 2025) = proof.snap_get('A.events')
      AND (SELECT count(*)::text FROM public.posting_lock_events WHERE client_id = v_c) = proof.snap_get('A.lock_events'),
    format('status=%s watermerk=%s events=%s', proof.status(v_c, 2025), proof.watermark(v_c), proof.events(v_c, 2025)));

  PERFORM proof.record('1f', 'A: elke boeking draagt het juiste boekjaar; er is niets naar een ander jaar verschoven',
    NOT EXISTS (SELECT 1 FROM public.ledger_postings WHERE client_id = v_c
                  AND boekjaar <> EXTRACT(YEAR FROM posting_date)::integer));
END $$;

-- ═══ 2. SCENARIO B: HEROPEND JAAR, BLOKKADE DEKT DE DATUM → GEWEIGERD DOOR DE BLOKKADE ═

DO $$
DECLARE v_c uuid := proof.pl_client('PR H — B: heropend, blokkade dekt');
BEGIN
  INSERT INTO proof.subject VALUES ('B', v_c);
  PERFORM proof.seed_group(v_c, 2025);
END $$;
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'B'), 2025);
SELECT proof.lock_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'B'), DATE '2025-12-31', 'Aangifte 2025 ingediend');

DO $$
DECLARE
  v_c  uuid;
  v_n  integer;
  v_ok boolean;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'B';
  SELECT count(*) INTO v_n FROM public.posting_lock_events WHERE client_id = v_c;
  PERFORM proof.snap_put('B.lock_events', v_n::text);

  -- Eerst heropenen, dan pas kijken: een STABLE helper in dezelfde
  -- instructie zou nog de stand van vóór de aanroep zien.
  v_ok := proof.reopen_as('00000000-0000-0000-0000-0000000000e1', v_c, 2025, 'Nagekomen factuur');
  PERFORM proof.record('2a', 'B: heropenen slaagt terwijl de blokkade staat',
    v_ok AND proof.status(v_c, 2025) = 'reopened' AND proof.watermark(v_c) IS NULL,
    format('reopened=%s status=%s watermerk=%s', v_ok, proof.status(v_c, 2025), proof.watermark(v_c)));

  PERFORM proof.record('6', 'F: heropenen laat posting_locked_through EXACT staan en schrijft geen blokkadegebeurtenis',
    proof.lock_of(v_c) = DATE '2025-12-31'
      AND (SELECT count(*) FROM public.posting_lock_events WHERE client_id = v_c) = v_n,
    format('blokkade=%s', proof.lock_of(v_c)));

  PERFORM proof.expect_error('2', 'B: heropend jaar mét blokkade — een memoriaal wordt geweigerd door de blokkade',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2025-06-01')),
    'valt binnen de boekingsblokkade t/m 2025-12-31');
  PERFORM proof.expect_error('2b', 'B: en een bankboeking',
    format('SELECT public.post_bank_transaction(%L)', proof.tx_draft(v_c, DATE '2025-06-02')),
    'valt binnen de boekingsblokkade t/m 2025-12-31');
  PERFORM proof.expect_error('2c', 'B: en een beginbalans',
    format('SELECT public.post_opening_balance(%L)', proof.ob_draft(v_c, DATE '2025-01-01')),
    'valt binnen de boekingsblokkade t/m 2025-12-31');
  PERFORM proof.record('2d', 'B: de weigering noemt uitsluitend de blokkade, nooit meer het watermerk',
    proof.identity(format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2025-06-01')))
      NOT ILIKE '%is afgesloten voor deze administratie%');
  PERFORM proof.expect_ok('2e', 'B: ná de blokkade boekt het heropende jaar gewoon',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2026-01-05')));
END $$;

-- ═══ 3. SCENARIO C: HEROPEND JAAR, GEEN BLOKKADE → BOEKEN MAG; DAARNA OPNIEUW AFSLUITEN ═

DO $$
DECLARE v_c uuid := proof.pl_client('PR H — C: heropend, geen blokkade');
BEGIN
  INSERT INTO proof.subject VALUES ('C', v_c);
  PERFORM proof.seed_group(v_c, 2025);
END $$;
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'C'), 2025);
SELECT proof.reopen_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'C'), 2025, 'Correctie');

DO $$
DECLARE v_c uuid;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'C';
  PERFORM proof.record('3a', 'C: uitgangspunt — heropend, geen blokkade',
    proof.status(v_c, 2025) = 'reopened' AND proof.lock_of(v_c) IS NULL);
  PERFORM proof.expect_ok('3', 'C: een memoriaal in het heropende jaar boekt',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2025-06-10')));
  PERFORM proof.expect_ok('3b', 'C: en een bankboeking',
    format('SELECT public.post_bank_transaction(%L)', proof.tx_draft(v_c, DATE '2025-06-11')));
END $$;

-- Opnieuw afsluiten, in een eigen transactie (de bankregel hierboven is geboekt,
-- dus er is geen postbaar-maar-ongeboekt werk meer).
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'C'), 2025);

DO $$
DECLARE v_c uuid;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'C';
  PERFORM proof.record('7', 'G: opnieuw afsluiten zet géén blokkade en schrijft geen blokkadegebeurtenis',
    proof.status(v_c, 2025) = 'closed' AND proof.watermark(v_c) = 2025
      AND proof.lock_of(v_c) IS NULL
      AND (SELECT count(*) FROM public.posting_lock_events WHERE client_id = v_c) = 0
      AND proof.events(v_c, 2025) = 'closed,reopened,closed',
    format('status=%s blokkade=%s events=%s', proof.status(v_c, 2025), proof.lock_of(v_c), proof.events(v_c, 2025)));
END $$;

-- ═══ 4-5. SCENARIO D EN E: AFGESLOTEN + BLOKKADE → BLOKKADE WEIGERT; OPHEFFEN HEROPENT NIET ═

DO $$
DECLARE v_c uuid := proof.pl_client('PR H — D/E: afgesloten, blokkade');
BEGIN
  INSERT INTO proof.subject VALUES ('D', v_c);
  PERFORM proof.seed_group(v_c, 2025);
END $$;
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'D'), 2025);

DO $$
DECLARE v_c uuid;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'D';
  PERFORM proof.snap_put('D.fy_events', proof.events(v_c, 2025));

  PERFORM proof.record('7b', 'G: afsluiten zette géén blokkade',
    proof.status(v_c, 2025) = 'closed' AND proof.lock_of(v_c) IS NULL
      AND (SELECT count(*) FROM public.posting_lock_events WHERE client_id = v_c) = 0);

  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2025-12-31', 'Dicht t/m 2025');
  PERFORM proof.expect_error('4', 'D: afgesloten jaar mét blokkade — geweigerd door de blokkade',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2025-06-01')),
    'valt binnen de boekingsblokkade t/m 2025-12-31');
  PERFORM proof.record('4b', 'D: de identiteit van die weigering is exact die van de blokkade',
    proof.identity(format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2025-06-01')))
      = '22023 | Boekingsdatum 2025-06-01 valt binnen de boekingsblokkade t/m 2025-12-31 voor deze administratie');

  -- E: opheffen.
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, NULL, 'Blokkade niet meer nodig');
  PERFORM proof.record('5', 'E: de blokkade opheffen laat status, watermerk en boekjaargeschiedenis exact staan',
    proof.lock_of(v_c) IS NULL
      AND proof.status(v_c, 2025) = 'closed' AND proof.watermark(v_c) = 2025
      AND proof.events(v_c, 2025) = proof.snap_get('D.fy_events'),
    format('status=%s watermerk=%s events=%s', proof.status(v_c, 2025), proof.watermark(v_c), proof.events(v_c, 2025)));
  PERFORM proof.record('5b', 'E: en de twee blokkadewijzigingen staan wél in hun eigen auditspoor',
    (SELECT count(*) FROM public.posting_lock_events WHERE client_id = v_c) = 2);
END $$;

-- ═══ 8. ALLE ZEVEN GEDATEERDE SCHRIJVERS, UIT DE CATALOGUS ══════════════════

DO $$
DECLARE
  v_paren text[][] := ARRAY[
    ARRAY['post_purchase_invoice', 'PERFORM public.assert_posting_allowed(v_inv.client_id, v_inv.invoice_date);'],
    ARRAY['post_sales_invoice',    'PERFORM public.assert_posting_allowed(v_inv.client_id, v_inv.invoice_date);'],
    ARRAY['post_bank_allocation',  'PERFORM public.assert_posting_allowed(v_alloc.client_id, v_tx.transaction_date);'],
    ARRAY['post_manual_journal',   'PERFORM public.assert_posting_allowed(v_journal.client_id, v_journal.posting_date);'],
    ARRAY['post_opening_balance',  'PERFORM public.assert_posting_allowed(v_header.client_id, v_header.opening_date);'],
    ARRAY['reverse_posting_group', 'PERFORM public.assert_posting_allowed(v_client_id, _posting_date);'],
    ARRAY['post_bank_transaction', 'PERFORM public.assert_posting_allowed(v_tx.client_id, v_tx.transaction_date);']
  ];
  v_i    integer;
  v_src  text;
  v_mist text := '';
  v_oud  text := '';
  v_orde text := '';
BEGIN
  FOR v_i IN 1 .. array_length(v_paren, 1) LOOP
    v_src := proof.src(v_paren[v_i][1]);
    IF v_src IS NULL OR position(v_paren[v_i][2] IN v_src) = 0 THEN
      v_mist := v_mist || v_paren[v_i][1] || ' ';
    END IF;
    IF v_src LIKE '%afgesloten_boekjaar IS NOT NULL%' OR v_src LIKE '%is afgesloten voor deze administratie%' THEN
      v_oud := v_oud || v_paren[v_i][1] || ' ';
    END IF;
    -- Rechten vóór de assertie, de assertie vóór de eerste grootboekregel.
    IF position('Geen rechten' IN v_src) = 0
       OR position('Geen rechten' IN v_src) > position('assert_posting_allowed' IN v_src)
       OR position('assert_posting_allowed' IN v_src) > position('INSERT INTO public.ledger_postings' IN v_src) THEN
      v_orde := v_orde || v_paren[v_i][1] || ' ';
    END IF;
  END LOOP;

  PERFORM proof.record('8', 'alle zeven gedateerde schrijvers toetsen de blokkade op hun eigen datum',
    v_mist = '', format('ontbreekt bij: %s', COALESCE(NULLIF(v_mist, ''), 'niemand')));
  PERFORM proof.record('8b', 'en geen van de zeven draagt nog het watermerk als boekingstoets',
    v_oud = '', format('nog aanwezig bij: %s', COALESCE(NULLIF(v_oud, ''), 'niemand')));
  PERFORM proof.record('8c', 'bij alle zeven: rol/tenant → blokkadetoets → pas dan de grootboekregel, in dezelfde functie (= dezelfde transactie)',
    v_orde = '', format('volgorde mis bij: %s', COALESCE(NULLIF(v_orde, ''), 'niemand')));

  -- De uitzondering draagt het watermerk nog wél, en kent de blokkade niet.
  v_src := proof.src('declare_opening_balance_nil');
  PERFORM proof.record('8d', 'declare_opening_balance_nil houdt haar levenscyclusregel en kent de blokkade niet',
    v_src LIKE '%afgesloten_boekjaar IS NOT NULL%' AND v_src NOT LIKE '%posting_allowed%'
      AND v_src NOT LIKE '%INSERT INTO public.ledger_postings%');
END $$;

-- ═══ 9. BULK: PREFLIGHT EN UITVOERING ZEGGEN HETZELFDE ═════════════════════

DO $$
DECLARE v_c uuid := proof.pl_client('PR H — bulk');
BEGIN
  INSERT INTO proof.subject VALUES ('BULK', v_c);
  PERFORM proof.seed_group(v_c, 2025);
END $$;
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'BULK'), 2025);

DO $$
DECLARE
  v_c     uuid;
  v_tx1   uuid;
  v_tx2   uuid;
  v_state text;
  v_reden text;
  v_uit   record;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'BULK';
  v_tx1 := proof.tx_draft(v_c, DATE '2025-05-01');

  SELECT workflow_state, reason INTO v_state, v_reden
  FROM public.bank_bulk_posting_candidates(v_c, 2025) WHERE transaction_id = v_tx1;
  PERFORM proof.record('9a', 'preflight: een bankregel in het afgesloten jaar zonder blokkade is nu ready (N4 zei blocked)',
    v_state = 'ready' AND v_reden IS NULL, format('%s — %s', COALESCE(v_state, 'geen'), COALESCE(v_reden, 'geen reden')));

  CREATE TEMP TABLE bulk_a ON COMMIT DROP AS SELECT * FROM public.post_bank_transactions_bulk(ARRAY[v_tx1]);
  SELECT * INTO v_uit FROM bulk_a;
  PERFORM proof.record('9b', 'bulk: en de uitvoering boekt die regel via de echte schrijver',
    v_uit.outcome = 'posted' AND v_uit.posting_group_id IS NOT NULL, v_uit.outcome);

  -- Nu een blokkade: de preflight en de bulk moeten beide weigeren.
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2025-06-30', 'Halfjaar dicht');
  v_tx2 := proof.tx_draft(v_c, DATE '2025-05-02');
  SELECT workflow_state, reason INTO v_state, v_reden
  FROM public.bank_bulk_posting_candidates(v_c, 2025) WHERE transaction_id = v_tx2;
  PERFORM proof.record('9c', 'preflight: mét blokkade is die regel blocked, met de blokkade als reden',
    v_state = 'blocked' AND v_reden ILIKE '%boekingsblokkade t/m 2025-06-30%'
      AND v_reden NOT ILIKE '%is afgesloten%',
    format('%s — %s', COALESCE(v_state, 'geen'), COALESCE(v_reden, 'geen reden')));

  CREATE TEMP TABLE bulk_b ON COMMIT DROP AS SELECT * FROM public.post_bank_transactions_bulk(ARRAY[v_tx2]);
  SELECT * INTO v_uit FROM bulk_b;
  PERFORM proof.record('9d', 'bulk: kan de blokkade niet omzeilen',
    v_uit.outcome <> 'posted' AND v_uit.message ILIKE '%boekingsblokkade t/m 2025-06-30%',
    format('%s — %s', v_uit.outcome, COALESCE(v_uit.message, 'geen melding')));
  PERFORM proof.record('9e', 'bulk: de orkestratie heeft geen eigen grootboekregel en geen eigen oordeel',
    proof.src('post_bank_transactions_bulk') LIKE '%public.post_bank_transaction(%'
      AND proof.src('post_bank_transactions_bulk') NOT LIKE '%INSERT INTO public.ledger_postings%'
      AND proof.src('post_bank_transactions_bulk') NOT LIKE '%posting_locked_through%'
      AND proof.src('post_bank_transactions_bulk') NOT LIKE '%afgesloten_boekjaar%');
END $$;

-- ═══ 10-11. TEGENBOEKING EN BEGINBALANS KUNNEN DE BLOKKADE NIET OMZEILEN ════

DO $$
DECLARE v_c uuid := proof.pl_client('PR H — tegenboeking');
BEGIN
  INSERT INTO proof.subject VALUES ('T', v_c);
  INSERT INTO proof.subject VALUES ('T_groep', public.post_manual_journal(proof.mj_draft(v_c, DATE '2024-12-01')));
END $$;
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'T'), 2024);

DO $$
DECLARE
  v_c uuid;
  v_g uuid;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'T';
  SELECT client_id INTO v_g FROM proof.subject WHERE rol = 'T_groep';
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2025-12-31', 'Dicht t/m 2025');

  PERFORM proof.expect_error('10', 'tegenboeking: gedateerd binnen de blokkade → geweigerd, ook al is het origineel ouder',
    format('SELECT public.reverse_posting_group(%L, DATE ''2025-06-01'', %L)', v_g, 'Correctie'),
    'valt binnen de boekingsblokkade t/m 2025-12-31');
  PERFORM proof.record('10b', 'tegenboeking: en er is niets tegengeboekt',
    (SELECT count(*) FROM public.ledger_reversal_postings WHERE original_posting_group_id = v_g) = 0);
  PERFORM proof.expect_ok('10c', 'tegenboeking: ná de blokkade mag zij, ook al ligt het origineel in een afgesloten jaar',
    format('SELECT public.reverse_posting_group(%L, DATE ''2026-01-10'', %L)', v_g, 'Correctie'));

  PERFORM proof.expect_error('11', 'beginbalans: binnen de blokkade → geweigerd',
    format('SELECT public.post_opening_balance(%L)', proof.ob_draft(v_c, DATE '2025-01-01')),
    'valt binnen de boekingsblokkade t/m 2025-12-31');
END $$;

-- ═══ 12-13. GEEN ANDERE WEG NAAR HET GROOTBOEK ══════════════════════════════

DO $$
DECLARE
  v_schrijvers text;
  v_zonder     text;
BEGIN
  -- Inhaalslag en app-hooks roepen uitsluitend deze functies aan; er bestaat
  -- in de catalogus geen andere functie die een grootboekregel schrijft.
  SELECT string_agg(p.proname, ',' ORDER BY p.proname) INTO v_schrijvers
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosrc LIKE '%INSERT INTO public.ledger_postings%';
  PERFORM proof.record('12', 'catch-up/app: precies de zeven gedateerde schrijvers schrijven grootboekregels, geen enkele andere functie',
    v_schrijvers = 'post_bank_allocation,post_bank_transaction,post_manual_journal,post_opening_balance,post_purchase_invoice,post_sales_invoice,reverse_posting_group',
    v_schrijvers);

  SELECT string_agg(p.proname, ',') INTO v_zonder
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosrc LIKE '%INSERT INTO public.ledger_postings%'
    AND p.prosrc NOT LIKE '%assert_posting_allowed(%';
  PERFORM proof.record('12b', 'en elke functie die een grootboekregel schrijft, toetst de blokkade',
    v_zonder IS NULL, format('zonder toets: %s', COALESCE(v_zonder, 'niemand')));

  PERFORM proof.record('13', 'geen directe grootboekmutatie: authenticated en anon hebben INSERT/UPDATE/DELETE noch ontvangen',
    NOT has_table_privilege('authenticated', 'public.ledger_postings', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.ledger_postings', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.ledger_postings', 'DELETE')
      AND NOT has_table_privilege('anon', 'public.ledger_postings', 'INSERT'));
END $$;

-- ═══ 14-15. TENANT EN ROL: ONGEWIJZIGD ══════════════════════════════════════

DO $$
DECLARE
  v_c uuid;
  v_t text;
  v_r text;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'A';
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e3', false);
  v_t := proof.identity(format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2026-03-03')));
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);
  v_r := proof.identity(format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2026-03-04')));
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

  PERFORM proof.record('14', 'tenant: een accountant van een andere organisatie krijgt exact dezelfde weigering als vóór de migratie',
    v_t = proof.snap_get('pre.identity.tenant') AND v_t LIKE '42501 |%', v_t);
  PERFORM proof.record('15', 'rol: een assistent krijgt exact dezelfde weigering als vóór de migratie',
    v_r = proof.snap_get('pre.identity.role') AND v_r LIKE '42501 |%', v_r);
END $$;

-- ═══ 16-18. AUDITSPOREN EN GROOTBOEK: NIETS VERZONNEN ═══════════════════════

DO $$
BEGIN
  -- Alles wat hierboven is geboekt, heeft zijn eigen bron; er is nooit een
  -- boekjaargebeurtenis door een boeking ontstaan of een blokkadegebeurtenis
  -- door een afsluiting of heropening.
  PERFORM proof.record('16', 'posting_lock_events bevat uitsluitend gebeurtenissen uit set_posting_lock (oude ≠ nieuwe waarde, reden aanwezig)',
    NOT EXISTS (SELECT 1 FROM public.posting_lock_events
                 WHERE new_locked_through IS NOT DISTINCT FROM previous_locked_through
                    OR btrim(reason) = ''));
  PERFORM proof.record('17', 'fiscal_year_events bevat uitsluitend closed/reopened en elke heropening heeft een reden',
    NOT EXISTS (SELECT 1 FROM public.fiscal_year_events
                 WHERE event_type NOT IN ('closed', 'reopened')
                    OR (event_type = 'reopened' AND NULLIF(btrim(reason), '') IS NULL)));
  PERFORM proof.record('18', 'het grootboek is append-only gebleven en elke groep sluit',
    NOT EXISTS (SELECT 1 FROM public.ledger_postings
                 GROUP BY posting_group_id HAVING sum(debit_amount) <> sum(credit_amount)));
END $$;

-- ═══ 19. IDEMPOTENT ═════════════════════════════════════════════════════════
--
-- run-proof.sh heeft de migratie twee keer toegepast en na de eerste keer de
-- hashes vastgelegd; nu moeten zij gelijk zijn.

DO $$
DECLARE
  v_naam text;
  v_mis  text := '';
BEGIN
  FOREACH v_naam IN ARRAY proof.changed_functions() LOOP
    IF proof.hash(v_naam) IS DISTINCT FROM proof.snap_get('once.hash.' || v_naam) THEN
      v_mis := v_mis || v_naam || ' ';
    END IF;
  END LOOP;
  PERFORM proof.record('19', 'een tweede toepassing verandert geen enkel lichaam (idempotent)',
    v_mis = '', format('afwijkend: %s', COALESCE(NULLIF(v_mis, ''), 'niets')));
END $$;

-- ═══ 20. DE UITZONDERING GEDRAAGT ZICH NOG ALS LEVENSCYCLUSREGEL ════════════

DO $$
DECLARE
  v_c  uuid;
  v_ob uuid;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'D';   -- afgesloten 2025, geen blokkade
  v_ob := proof.ob_draft(v_c, DATE '2025-01-01');
  DELETE FROM public.opening_balance_lines WHERE opening_balance_id = v_ob;
  PERFORM proof.expect_error('20', 'nihilverklaring over een afgesloten boekjaar blijft geweigerd (levenscyclusregel)',
    format('SELECT public.declare_opening_balance_nil(%L)', v_ob),
    'is afgesloten voor deze administratie');

  v_ob := proof.ob_draft(v_c, DATE '2026-01-01');
  DELETE FROM public.opening_balance_lines WHERE opening_balance_id = v_ob;
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2030-12-31', 'Alles dicht');
  PERFORM proof.expect_ok('20b', 'en over een open boekjaar mag zij, ook onder een blokkade die alles dekt',
    format('SELECT public.declare_opening_balance_nil(%L)', v_ob));
END $$;
