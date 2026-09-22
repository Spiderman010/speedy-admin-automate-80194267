-- REAL POSTGRESQL PROOF for 6C-b11 PR D — run against a THROWAWAY local
-- cluster. Never run this against any BoekAssist database. See run-proof.sh.
--
-- Eén vraag, in vijf gedaanten. Handhaaft ELKE gedateerde schrijver de nieuwe
-- boekingsblokkade, op de datum die die schrijver zelf al gezaghebbend vindt —
-- zonder dat de oude jaargrendel ook maar iets verliest, zonder dat de
-- nihilverklaring wordt meegesleept, zonder dat de bulklaag een sluiproute
-- wordt, en zonder dat een gelijktijdige blokkadewijziging erlangs kan glippen?

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- Alles hieronder gebeurt als de accountant van Agio Finance; de rolcontroles
-- in de schrijvers lezen deze GUC via de auth.uid()-dubbel.
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- ═══ 1-2. ZONDER BLOKKADE VERANDERT ER NIETS ════════════════════════════════

DO $$
DECLARE
  v_c  uuid := proof.pl_client('PR D — geen blokkade');
  v_j  uuid;
  v_g  uuid;
BEGIN
  INSERT INTO proof.subject VALUES ('vrij', v_c);
  v_j := proof.mj_draft(v_c, DATE '2025-03-10');
  v_g := public.post_manual_journal(v_j);

  PERFORM proof.record('1', 'zonder blokkade boekt een memoriaal gewoon door',
    v_g IS NOT NULL
      AND (SELECT count(*) FROM public.ledger_postings WHERE posting_group_id = v_g) = 2,
    format('groep = %s', COALESCE(v_g::text, 'geen')));

  PERFORM proof.record('2', 'en die administratie had inderdaad geen blokkade',
    (SELECT posting_locked_through FROM public.clients WHERE id = v_c) IS NULL);
END $$;

-- ═══ 3-6. DE GRENS, OP DE SCHRIJVER ZELF ════════════════════════════════════

DO $$
DECLARE
  v_c uuid := proof.pl_client('PR D — grens memoriaal');
BEGIN
  INSERT INTO proof.subject VALUES ('grens', v_c);
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2024-12-31',
                        'Aangifte 2024 ingediend');

  PERFORM proof.expect_ok('3', 'ná de blokkade mag een memoriaal nog steeds',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2025-01-01')));

  -- De grens ligt EROP: "dicht t/m 31-12-2024" sluit die dag zelf in.
  PERFORM proof.expect_error('4', 'op de blokkadedatum mag het niet',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2024-12-31')),
    'valt binnen de boekingsblokkade t/m 2024-12-31');

  PERFORM proof.expect_error('5', 'vóór de blokkade evenmin',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_c, DATE '2024-01-05')),
    'valt binnen de boekingsblokkade t/m 2024-12-31');

  PERFORM proof.record('6', 'een geweigerde boeking laat geen grootboekregel achter',
    (SELECT count(*) FROM public.ledger_postings
      WHERE client_id = v_c AND posting_date <= DATE '2024-12-31') = 0);
END $$;

-- ═══ 7. ÉÉN TEKST, ÉÉN SQLSTATE ═════════════════════════════════════════════

DO $$
DECLARE
  v_c   uuid;
  v_id1 text;
  v_id2 text;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'grens';
  v_id1 := proof.identity(format('SELECT public.post_manual_journal(%L)',
                                 proof.mj_draft(v_c, DATE '2024-06-01')));
  v_id2 := proof.identity(format('SELECT public.post_bank_transaction(%L)',
                                 proof.tx_draft(v_c, DATE '2024-06-01')));

  PERFORM proof.record('7', 'twee verschillende schrijvers geven exact dezelfde weigering',
    v_id1 = v_id2
      AND v_id1 = '22023 | Boekingsdatum 2024-06-01 valt binnen de boekingsblokkade t/m 2024-12-31 voor deze administratie',
    format('memoriaal: %s | bank: %s', v_id1, v_id2));
END $$;

-- ═══ 8-11. DE UITVOERBARE SCHRIJVERS, STUK VOOR STUK ════════════════════════

-- (a) beginbalans — op haar EIGEN gezaghebbende datum, opening_date
DO $$
DECLARE v_c uuid := proof.pl_client('PR D — beginbalans');
BEGIN
  INSERT INTO proof.subject VALUES ('beginbalans', v_c);
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2024-12-31', 'Dicht t/m 2024');

  PERFORM proof.expect_error('8', 'de beginbalansschrijver handhaaft de blokkade',
    format('SELECT public.post_opening_balance(%L)', proof.ob_draft(v_c, DATE '2024-01-01')),
    'valt binnen de boekingsblokkade t/m 2024-12-31');

  PERFORM proof.expect_ok('8b', 'en boekt na de blokkade gewoon',
    format('SELECT public.post_opening_balance(%L)', proof.ob_draft(v_c, DATE '2025-01-01')));
END $$;

-- (b) directe bankboeking — transaction_date
DO $$
DECLARE v_c uuid := proof.pl_client('PR D — bank');
BEGIN
  INSERT INTO proof.subject VALUES ('bank', v_c);
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2025-06-30', 'Halfjaar dicht');

  PERFORM proof.expect_error('9', 'de bankschrijver handhaaft de blokkade',
    format('SELECT public.post_bank_transaction(%L)', proof.tx_draft(v_c, DATE '2025-06-30')),
    'valt binnen de boekingsblokkade t/m 2025-06-30');

  PERFORM proof.expect_ok('9b', 'en boekt een dag later wel',
    format('SELECT public.post_bank_transaction(%L)', proof.tx_draft(v_c, DATE '2025-07-01')));
END $$;

-- (c) tegenboeking — de datum van de TEGENBOEKING telt, niet die van het
--     origineel. In EEN EIGEN transactie geboekt, want een groep die in
--     dezelfde transactie ontstond mag (terecht) nog niet worden tegengeboekt.
DO $$
DECLARE v_c uuid := proof.pl_client('PR D — tegenboeking');
BEGIN
  INSERT INTO proof.subject VALUES ('tegenboeking', v_c);
  -- Origineel in december 2024, geboekt vóórdat de blokkade bestaat.
  INSERT INTO proof.subject VALUES
    ('tegenboeking_groep1', public.post_manual_journal(proof.mj_draft(v_c, DATE '2024-12-01'))),
    ('tegenboeking_groep2', public.post_manual_journal(proof.mj_draft(v_c, DATE '2024-12-02')));
END $$;

DO $$
DECLARE
  v_c    uuid;
  v_grp  uuid;
  v_grp2 uuid;
BEGIN
  SELECT client_id INTO v_c    FROM proof.subject WHERE rol = 'tegenboeking';
  SELECT client_id INTO v_grp  FROM proof.subject WHERE rol = 'tegenboeking_groep1';
  SELECT client_id INTO v_grp2 FROM proof.subject WHERE rol = 'tegenboeking_groep2';

  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2024-12-31', 'Dicht t/m 2024');

  -- Origineel binnen de blokkade, tegenboeking erbuiten: de blokkade laat door.
  PERFORM proof.expect_ok('10', 'een tegenboeking ná de blokkade mag, ook al ligt het origineel ervóór',
    format('SELECT public.reverse_posting_group(%L, DATE ''2025-01-10'', %L)', v_grp, 'Correctie'));

  -- Tegenboeking ÓP de blokkadedatum: geweigerd.
  PERFORM proof.expect_error('11', 'een tegenboeking op de blokkadedatum wordt geweigerd',
    format('SELECT public.reverse_posting_group(%L, DATE ''2024-12-31'', %L)', v_grp2, 'Correctie'),
    'valt binnen de boekingsblokkade t/m 2024-12-31');

  PERFORM proof.record('11b', 'en die tweede groep is dus niet tegengeboekt',
    (SELECT count(*) FROM public.ledger_reversal_postings
      WHERE original_posting_group_id = v_grp2) = 0);
END $$;


-- ═══ 12-14. BULK: PREFLIGHT EN UITVOERING ZEGGEN HETZELFDE ══════════════════

DO $$
DECLARE
  v_c    uuid := proof.pl_client('PR D — bulk');
  v_dicht uuid;
  v_open  uuid;
  v_state text;
  v_reden text;
  v_uit   record;
BEGIN
  INSERT INTO proof.subject VALUES ('bulk', v_c);
  v_dicht := proof.tx_draft(v_c, DATE '2025-05-01');
  v_open  := proof.tx_draft(v_c, DATE '2025-08-01');
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2025-06-30', 'Halfjaar dicht');

  SELECT workflow_state, reason INTO v_state, v_reden
  FROM public.bank_bulk_posting_candidates(v_c, 2025)
  WHERE transaction_id = v_dicht;

  PERFORM proof.record('12', 'de preflight noemt een geblokkeerde regel geblokkeerd, met reden',
    v_state = 'blocked' AND v_reden ILIKE '%boekingsblokkade t/m 2025-06-30%',
    format('%s — %s', COALESCE(v_state, 'geen'), COALESCE(v_reden, 'geen reden')));

  SELECT workflow_state INTO v_state
  FROM public.bank_bulk_posting_candidates(v_c, 2025)
  WHERE transaction_id = v_open;
  PERFORM proof.record('12b', 'en laat de regel ná de blokkade gewoon staan',
    v_state <> 'blocked', format('%s', COALESCE(v_state, 'geen')));

  -- De partij: één geblokkeerde en één toegestane regel, in één aanroep. De
  -- bestaande gedeeltelijke-succes-semantiek blijft: de ene faalt, de andere
  -- boekt, en de partij als geheel breekt niet af.
  CREATE TEMP TABLE bulk_uit ON COMMIT DROP AS
    SELECT * FROM public.post_bank_transactions_bulk(ARRAY[v_dicht, v_open]);

  SELECT * INTO v_uit FROM bulk_uit WHERE transaction_id = v_dicht;
  PERFORM proof.record('13', 'de bulk kan de blokkade niet omzeilen',
    v_uit.outcome <> 'posted' AND v_uit.message ILIKE '%boekingsblokkade t/m 2025-06-30%',
    format('%s — %s', v_uit.outcome, COALESCE(v_uit.message, 'geen melding')));

  SELECT * INTO v_uit FROM bulk_uit WHERE transaction_id = v_open;
  PERFORM proof.record('14', 'en de toegestane regel in dezelfde partij boekt wél',
    v_uit.outcome = 'posted' AND v_uit.posting_group_id IS NOT NULL,
    format('%s', v_uit.outcome));

  PERFORM proof.record('14b', 'er staat geen grootboekregel voor de geblokkeerde bankregel',
    (SELECT count(*) FROM public.bank_transaction_postings WHERE bank_transaction_id = v_dicht) = 0
      AND (SELECT count(*) FROM public.bank_transaction_postings WHERE bank_transaction_id = v_open) = 1);
END $$;

-- ═══ 15. DE SCHRIJVERS DIE HIER NIET UITVOERBAAR ZIJN ═══════════════════════
--
-- Inkoop, verkoop en afletteren hebben elk hun eigen brontabellen die dit
-- harnas niet opzet. Wat hier wél echt te toetsen is, is de vraag die ertoe
-- doet: staat de assertie in de gedeployde functie, op de datum die die
-- schrijver al gezaghebbend vindt — gelezen uit de catalogus, niet uit een
-- bestand.

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
  v_i      integer;
  v_src    text;
  v_mist   text := '';
BEGIN
  FOR v_i IN 1 .. array_length(v_paren, 1) LOOP
    v_src := proof.src(v_paren[v_i][1]);
    IF v_src IS NULL OR position(v_paren[v_i][2] IN v_src) = 0 THEN
      v_mist := v_mist || v_paren[v_i][1] || ' ';
    END IF;
  END LOOP;

  PERFORM proof.record('15', 'alle zeven gedateerde schrijvers toetsen de blokkade op hun eigen datum',
    v_mist = '', format('ontbreekt bij: %s', COALESCE(NULLIF(v_mist, ''), 'niemand')));

  -- En zij dragen alle zeven nog hun OUDE jaargrendel.
  PERFORM proof.record('15b', 'en alle zeven houden het oude afgesloten-jaar-watermerk',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('post_purchase_invoice','post_sales_invoice','post_bank_allocation',
                          'post_manual_journal','post_opening_balance','reverse_posting_group',
                          'post_bank_transaction')
        AND p.prosrc LIKE '%afgesloten_boekjaar IS NOT NULL%'
        AND p.prosrc LIKE '%is afgesloten voor deze administratie%') = 7);
END $$;

-- ═══ 16-17. DE UITZONDERING: DE NIHILVERKLARING ═════════════════════════════

DO $$
DECLARE
  v_c  uuid := proof.pl_client('PR D — nihilverklaring');
  v_ob uuid;
  v_src text := proof.src('declare_opening_balance_nil');
BEGIN
  INSERT INTO proof.subject VALUES ('nihil', v_c);

  PERFORM proof.record('16', 'de nihilverklaring kent de boekingsblokkade niet',
    v_src NOT LIKE '%assert_posting_allowed%'
      AND v_src NOT LIKE '%posting_allowed%'
      AND v_src NOT LIKE '%posting_locked_through%');

  -- Zij schrijft geen grootboekregel; zij doet een uitspraak over een JAAR. De
  -- blokkade staat dus bewust in de weg van niets — ook niet als zij de hele
  -- periode beslaat.
  v_ob := proof.ob_draft(v_c, DATE '2024-01-01');
  DELETE FROM public.opening_balance_lines WHERE opening_balance_id = v_ob;
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2030-12-31', 'Alles dicht');

  PERFORM proof.expect_ok('17', 'en blijft werken met een blokkade over de hele periode',
    format('SELECT public.declare_opening_balance_nil(%L)', v_ob));

  PERFORM proof.record('17b', 'haar eigen jaargrendel is onveranderd aanwezig',
    v_src LIKE '%afgesloten_boekjaar IS NOT NULL%'
      AND v_src LIKE '%is afgesloten voor deze administratie%');
END $$;

-- ═══ 18-21. DE DUBBELE GRENDEL ══════════════════════════════════════════════
--
-- Vier hoeken van dezelfde matrix, elk op een eigen administratie omdat
-- afsluiten onomkeerbaar is.

DO $$
DECLARE
  v_open  uuid := proof.pl_client('PR D — open jaar, wel blokkade');
  v_dicht uuid := proof.pl_client('PR D — dicht jaar, geen blokkade');
  v_beide uuid := proof.pl_client('PR D — beide');
  v_geen  uuid := proof.pl_client('PR D — geen van beide');
BEGIN
  -- (a) open boekjaar + blokkade => de NIEUWE grendel weigert
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_open, DATE '2025-12-31', 'Blokkade');
  PERFORM proof.expect_error('18', 'open boekjaar mét blokkade: geweigerd door de blokkade',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_open, DATE '2025-06-01')),
    'valt binnen de boekingsblokkade');

  -- (b) afgesloten boekjaar + geen blokkade => het OUDE watermerk weigert
  PERFORM proof.seed_group(v_dicht, 2025);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_dicht, 2025);
  PERFORM proof.expect_error('19', 'afgesloten boekjaar zónder blokkade: geweigerd door het watermerk',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_dicht, DATE '2025-06-01')),
    'is afgesloten voor deze administratie');

  -- (c) allebei => nog steeds geweigerd, en het oude watermerk spreekt eerst
  PERFORM proof.seed_group(v_beide, 2025);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_beide, 2025);
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_beide, DATE '2025-12-31', 'Blokkade');
  PERFORM proof.expect_error('20', 'allebei: geweigerd, met het bestaande watermerkantwoord voorop',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_beide, DATE '2025-06-01')),
    'is afgesloten voor deze administratie');

  -- (d) geen van beide => toegestaan
  PERFORM proof.expect_ok('21', 'geen van beide: gewoon toegestaan',
    format('SELECT public.post_manual_journal(%L)', proof.mj_draft(v_geen, DATE '2025-06-01')));
END $$;

-- ═══ 22-25. DE ASSERTIE ZELF: VORM, GRENDELVOLGORDE, RECHTEN ════════════════

DO $$
DECLARE
  v_src text := proof.src('assert_posting_allowed');
  v_p   pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'assert_posting_allowed';

  PERFORM proof.record('22', 'de assertie is SECURITY DEFINER met een vast search_path',
    v_p.prosecdef AND array_to_string(v_p.proconfig, ',') LIKE '%search_path=public%',
    format('secdef = %s, config = %s', v_p.prosecdef, array_to_string(v_p.proconfig, ',')));

  -- DE KERN VAN DE RACE: eerst de grendel, dán pas het oordeel. Staat het
  -- andersom, dan kan een blokkade tussen toets en boeking in worden gezet.
  PERFORM proof.record('23', 'zij neemt de administratiegrendel vóór zij oordeelt',
    position('lock_ledger_client' IN v_src) > 0
      AND position('lock_ledger_client' IN v_src) < position('posting_allowed(_client_id' IN v_src));

  PERFORM proof.record('24', 'niemand buiten de eigenaar mag haar uitvoeren',
    NOT has_function_privilege('authenticated', 'public.assert_posting_allowed(uuid, date)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.assert_posting_allowed(uuid, date)', 'EXECUTE')
      AND NOT has_function_privilege('service_role', 'public.assert_posting_allowed(uuid, date)', 'EXECUTE'));

  -- Geen nieuwe schrijfrechten: de grootboektabel blijft dicht.
  PERFORM proof.record('25', 'PR D heeft geen enkel nieuw schrijfrecht op het grootboek gegeven',
    NOT has_table_privilege('authenticated', 'public.ledger_postings', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.ledger_postings', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.ledger_postings', 'DELETE')
      AND NOT has_table_privilege('anon', 'public.ledger_postings', 'SELECT'));
END $$;

-- ═══ 26. GEEN TENANT-ORAKEL ═════════════════════════════════════════════════
--
-- De assertie is BEWUST tenant-onwetend: zij oordeelt alleen over datum en
-- blokkade. Dat is veilig omdat zij onbereikbaar is voor elke clientrol
-- (bewijs 24) en omdat elke schrijver haar pas aanroept NADAT hij zijn eigen
-- rol- en organisatiecontrole heeft gedaan. Precies dat wordt hier getoetst:
-- geen enkele schrijver noemt een blokkadedatum vóór de poort.

DO $$
DECLARE
  v_namen text[] := ARRAY['post_purchase_invoice','post_sales_invoice','post_bank_allocation',
                          'post_manual_journal','post_opening_balance','reverse_posting_group',
                          'post_bank_transaction'];
  v_i    integer;
  v_src  text;
  v_fout text := '';
BEGIN
  FOR v_i IN 1 .. array_length(v_namen, 1) LOOP
    v_src := proof.src(v_namen[v_i]);
    -- De rechtencontrole ('Geen rechten') staat vóór de assertie.
    IF position('Geen rechten' IN v_src) = 0
       OR position('Geen rechten' IN v_src) > position('assert_posting_allowed' IN v_src) THEN
      v_fout := v_fout || v_namen[v_i] || ' ';
    END IF;
  END LOOP;

  PERFORM proof.record('26', 'elke schrijver doet zijn rol- en tenantcontrole vóór hij de blokkade noemt',
    v_fout = '', format('mis bij: %s', COALESCE(NULLIF(v_fout, ''), 'niemand')));

  -- En de assertie zelf voegt geen enkel nieuw feit toe over een administratie
  -- die de aanroeper niet al mocht zien: zij leest alleen de blokkadedatum.
  PERFORM proof.record('26b', 'de assertie leest niets anders dan de blokkadedatum',
    proof.src('assert_posting_allowed') NOT LIKE '%organization%'
      AND proof.src('assert_posting_allowed') NOT LIKE '%has_min_role%');
END $$;

