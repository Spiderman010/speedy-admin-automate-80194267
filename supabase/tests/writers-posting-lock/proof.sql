-- REAL POSTGRESQL PROOF for 6C-b11 PR D — run against a THROWAWAY local
-- cluster. Never run this against any BoekAssist database. See run-proof.sh.
--
-- Drie vragen. Weigert élke gedateerde schrijver een boeking binnen de
-- blokkade, op precies dezelfde grens? Blijft alles wat eerder werd geweigerd
-- geweigerd, met dezelfde reden? En blijft de nihil-verklaring er bewust
-- buiten?

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ═══ 1. ZONDER BLOKKADE BOEKT ALLES GEWOON ══════════════════════════════════

DO $$
DECLARE
  v_c   uuid := proof.new_client('PR D — zonder blokkade');
  v_ok  integer := 0;
  v_id  uuid;
BEGIN
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  INSERT INTO proof.subject VALUES ('zonder', v_c);

  v_id := proof.new_purchase(v_c, DATE '2024-03-01'); PERFORM public.post_purchase_invoice(v_id); v_ok := v_ok + 1;
  v_id := proof.new_sales(v_c,    DATE '2024-03-02'); PERFORM public.post_sales_invoice(v_id);    v_ok := v_ok + 1;
  v_id := proof.new_manual(v_c,   DATE '2024-03-03'); PERFORM public.post_manual_journal(v_id);   v_ok := v_ok + 1;
  v_id := proof.new_bank_tx(v_c,  DATE '2024-03-04'); PERFORM public.post_bank_transaction(v_id); v_ok := v_ok + 1;

  PERFORM proof.record('1', 'zonder blokkade boekt elke schrijver gewoon, ook ver in het verleden',
    v_ok = 4 AND (SELECT posting_locked_through FROM public.clients WHERE id = v_c) IS NULL,
    format('%s van 4 schrijvers', v_ok));
END $$;

-- ═══ 2-11. MET EEN BLOKKADE T/M 31-12-2024 ══════════════════════════════════
--
-- Per schrijver drie datums: erná (mag), op de grens (mag niet), ervóór (mag
-- niet). De grens is het interessante geval — daar zou een off-by-one zitten.

-- ── inkoop ──
DO $$
DECLARE v_c uuid := proof.new_client('PR D — inkoop'); v_na uuid; v_op uuid; v_voor uuid;
BEGIN
  PERFORM proof.lock_as(v_c, DATE '2024-12-31', 'Aangifte 2024 ingediend');
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');

  v_na   := proof.new_purchase(v_c, DATE '2025-01-01');
  v_op   := proof.new_purchase(v_c, DATE '2024-12-31');
  v_voor := proof.new_purchase(v_c, DATE '2024-06-01');

  PERFORM public.post_purchase_invoice(v_na);
  PERFORM proof.record('2', 'inkoopfactuur ná de blokkade boekt', true);

  PERFORM proof.expect_error('3', 'inkoopfactuur OP de blokkadedatum wordt geweigerd',
    format('SELECT public.post_purchase_invoice(%L)', v_op), 'valt binnen de boekingsblokkade t/m');

  PERFORM proof.expect_error('4', 'inkoopfactuur VÓÓR de blokkade wordt geweigerd',
    format('SELECT public.post_purchase_invoice(%L)', v_voor), 'valt binnen de boekingsblokkade t/m');
END $$;

-- ── verkoop ──
DO $$
DECLARE v_c uuid := proof.new_client('PR D — verkoop'); v_na uuid; v_op uuid;
BEGIN
  PERFORM proof.lock_as(v_c, DATE '2024-12-31', 'Aangifte 2024');
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  v_na := proof.new_sales(v_c, DATE '2025-01-01');
  v_op := proof.new_sales(v_c, DATE '2024-12-31');

  PERFORM public.post_sales_invoice(v_na);
  PERFORM proof.record('5', 'verkoopfactuur ná de blokkade boekt', true);
  PERFORM proof.expect_error('6', 'verkoopfactuur OP de blokkadedatum wordt geweigerd',
    format('SELECT public.post_sales_invoice(%L)', v_op), 'valt binnen de boekingsblokkade t/m');
END $$;

-- ── memoriaal ──
DO $$
DECLARE v_c uuid := proof.new_client('PR D — memoriaal'); v_na uuid; v_op uuid;
BEGIN
  PERFORM proof.lock_as(v_c, DATE '2024-12-31', 'Aangifte 2024');
  v_na := proof.new_manual(v_c, DATE '2025-01-01');
  v_op := proof.new_manual(v_c, DATE '2024-12-31');

  PERFORM public.post_manual_journal(v_na);
  PERFORM proof.record('7', 'memoriaalboeking ná de blokkade boekt', true);
  PERFORM proof.expect_error('8', 'memoriaalboeking OP de blokkadedatum wordt geweigerd',
    format('SELECT public.post_manual_journal(%L)', v_op), 'valt binnen de boekingsblokkade t/m');
END $$;

-- ── banktransactie ──
DO $$
DECLARE v_c uuid := proof.new_client('PR D — bank'); v_na uuid; v_op uuid;
BEGIN
  PERFORM proof.lock_as(v_c, DATE '2024-12-31', 'Aangifte 2024');
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  INSERT INTO proof.subject VALUES ('bank', v_c);
  v_na := proof.new_bank_tx(v_c, DATE '2025-01-01');
  v_op := proof.new_bank_tx(v_c, DATE '2024-12-31');

  PERFORM public.post_bank_transaction(v_na);
  PERFORM proof.record('9', 'banktransactie ná de blokkade boekt', true);
  PERFORM proof.expect_error('10', 'banktransactie OP de blokkadedatum wordt geweigerd',
    format('SELECT public.post_bank_transaction(%L)', v_op), 'valt binnen de boekingsblokkade t/m');
END $$;

-- ── beginbalans ──
DO $$
DECLARE v_c uuid := proof.new_client('PR D — beginbalans'); v_ob uuid;
BEGIN
  PERFORM proof.lock_as(v_c, DATE '2024-12-31', 'Aangifte 2024');
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  -- De openingsdatum is de datum die op élke grootboekregel komt; dat is de
  -- autoriteit, niet het boekjaar.
  v_ob := proof.new_opening(v_c, DATE '2024-01-01');
  PERFORM proof.expect_error('11', 'beginbalans met een openingsdatum binnen de blokkade wordt geweigerd',
    format('SELECT public.post_opening_balance(%L)', v_ob), 'valt binnen de boekingsblokkade t/m');
END $$;

DO $$
DECLARE v_c uuid := proof.new_client('PR D — beginbalans ná'); v_ob uuid;
BEGIN
  PERFORM proof.lock_as(v_c, DATE '2024-12-31', 'Aangifte 2024');
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  v_ob := proof.new_opening(v_c, DATE '2025-01-01');
  PERFORM public.post_opening_balance(v_ob);
  PERFORM proof.record('11b', 'beginbalans ná de blokkade boekt gewoon', true);
END $$;

-- ── aflettering ──
DO $$
DECLARE
  v_c    uuid := proof.new_client('PR D — aflettering');
  v_inv  uuid;
  v_tx   uuid;
  v_al   uuid;
BEGIN
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  INSERT INTO proof.subject VALUES ('aflettering', v_c);
  -- Eerst de factuur boeken TERWIJL er nog geen blokkade is; de aflettering
  -- daarna is het onderwerp van de toets.
  v_inv := proof.new_purchase(v_c, DATE '2024-06-01');
  PERFORM public.post_purchase_invoice(v_inv);

  v_tx := proof.new_bank_tx(v_c, DATE '2024-12-31', -121.00);
  INSERT INTO public.bank_transaction_allocations
    (client_id, organization_id, bank_transaction_id, invoice_id, invoice_type, amount)
  VALUES (v_c, '00000000-0000-0000-0000-00000000a001', v_tx, v_inv, 'inkoop', 121.00)
  RETURNING id INTO v_al;

  PERFORM proof.lock_as(v_c, DATE '2024-12-31', 'Aangifte 2024');
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');

  -- De datum van de aflettering is die van de BANKTRANSACTIE.
  PERFORM proof.expect_error('12', 'aflettering op de datum van een geblokkeerde banktransactie wordt geweigerd',
    format('SELECT public.post_bank_allocation(%L)', v_al), 'valt binnen de boekingsblokkade t/m');
END $$;

-- ═══ 13-14. TEGENBOEKING: DE DATUM VAN DE TEGENBOEKING TELT ═════════════════

DO $$
DECLARE v_c uuid := proof.new_client('PR D — tegenboeking'); v_j uuid;
BEGIN
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  INSERT INTO proof.subject VALUES ('tegenboeking', v_c);
  -- Een boeking vóór de toekomstige blokkade, in een EIGEN transactie: het
  -- zegel van 6C-b2 weigert een tegenboeking van een groep uit dezelfde
  -- transactie.
  v_j := proof.new_manual(v_c, DATE '2024-12-01');
  PERFORM public.post_manual_journal(v_j);
END $$;

DO $$
DECLARE v_c uuid;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'tegenboeking';
  PERFORM proof.lock_as(v_c, DATE '2024-12-31', 'Aangifte 2024');
END $$;

DO $$
DECLARE
  v_c     uuid;
  v_groep uuid;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'tegenboeking';
  SELECT posting_group_id INTO v_groep FROM public.ledger_postings
   WHERE client_id = v_c LIMIT 1;
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');

  /*
   * HET ONDERSCHEID DAT ER TOE DOET. Het origineel staat op 01-12-2024, dus
   * binnen de blokkade. Zou de toets op de datum van het ORIGINEEL kijken, dan
   * was een correctie in januari onmogelijk — precies het werk waarvoor een
   * correctie bestaat. De toets kijkt naar de datum van de TEGENBOEKING.
   */
  PERFORM proof.expect_error('13', 'tegenboeking ÓP de blokkadedatum wordt geweigerd',
    format('SELECT public.reverse_posting_group(%L, DATE ''2024-12-31'')', v_groep),
    'valt binnen de boekingsblokkade t/m');

  PERFORM public.reverse_posting_group(v_groep, DATE '2025-01-10');
  PERFORM proof.record('14', 'tegenboeking ná de blokkade mag, ook al ligt het origineel erbinnen',
    true, 'origineel 01-12-2024, blokkade t/m 31-12-2024, tegenboeking 10-01-2025');
END $$;

-- ═══ 15-17. BULK: PREFLIGHT EN UITVOERING ZIJN HET EENS ═════════════════════

DO $$
DECLARE
  v_c      uuid;
  v_op     uuid;
  v_state  text;
  v_reason text;
  v_uitkomst text;
  v_melding  text;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'bank';
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  SELECT id INTO v_op FROM public.bank_transactions
   WHERE client_id = v_c AND transaction_date = DATE '2024-12-31' LIMIT 1;

  SELECT workflow_state, reason INTO v_state, v_reason
  FROM public.bank_bulk_posting_candidates(v_c) WHERE transaction_id = v_op;

  PERFORM proof.record('15', 'de bulk-preflight merkt een geblokkeerde regel als blocked',
    v_state = 'blocked', format('workflow_state = %s', v_state));

  PERFORM proof.record('16', 'en noemt dezelfde reden als de schrijver',
    v_reason LIKE '%valt binnen de boekingsblokkade t/m%', v_reason);

  -- De bulk mag geen sluipweg zijn: zij roept per regel de echte schrijver aan.
  SELECT b.outcome, b.message INTO v_uitkomst, v_melding
  FROM public.post_bank_transactions_bulk(ARRAY[v_op]) b;

  PERFORM proof.record('17', 'bulk boeken kan de blokkade niet omzeilen',
    v_uitkomst <> 'posted' AND v_melding LIKE '%valt binnen de boekingsblokkade t/m%',
    format('uitkomst = %s, melding = %s', v_uitkomst, v_melding));
END $$;

-- ═══ 18-20. HET OUDE WATERMERK STAAT ER NOG, EN GAAT VOOR ═══════════════════

DO $$
DECLARE v_aantal integer;
BEGIN
  SELECT count(*) INTO v_aantal
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('post_purchase_invoice', 'post_sales_invoice', 'post_bank_allocation',
                      'post_manual_journal', 'post_opening_balance', 'declare_opening_balance_nil',
                      'reverse_posting_group', 'post_bank_transaction')
    AND p.prosrc LIKE '%afgesloten_boekjaar IS NOT NULL%'
    AND p.prosrc LIKE '%is afgesloten voor deze administratie%';

  PERFORM proof.record('18', 'alle ACHT schrijvers dragen nog hun afgesloten-jaar-toets',
    v_aantal = 8, format('%s van 8', v_aantal));
END $$;

DO $$
DECLARE
  v_c uuid := proof.new_client('PR D — watermerk');
  v_j uuid;
BEGIN
  -- Een afgesloten boekjaar ZONDER boekingsblokkade: nog steeds geweigerd, en
  -- met exact dezelfde melding als vóór deze PR. Eerst afsluiten, dán het
  -- document maken: ongeboekt bronwerk zou de afsluiting zelf blokkeren.
  PERFORM proof.seed_close(v_c, 2024);
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  v_j := proof.new_manual(v_c, DATE '2024-06-01');

  PERFORM proof.expect_error('19', 'een afgesloten boekjaar blokkeert nog steeds, met de oude melding',
    format('SELECT public.post_manual_journal(%L)', v_j),
    'Boekjaar 2024 is afgesloten voor deze administratie');

  PERFORM proof.record('19b', 'en die administratie had geen boekingsblokkade',
    (SELECT posting_locked_through FROM public.clients WHERE id = v_c) IS NULL);
END $$;

-- ═══ 20-23. DE ONAFHANKELIJKHEIDSMATRIX ════════════════════════════════════

DO $$
DECLARE
  v_geen  uuid := proof.new_client('Matrix — geen van beide');
  v_slot  uuid := proof.new_client('Matrix — alleen blokkade');
  v_j     uuid;
BEGIN
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');

  -- (a) geen watermerk, geen blokkade → mag
  v_j := proof.new_manual(v_geen, DATE '2024-06-01');
  PERFORM public.post_manual_journal(v_j);
  PERFORM proof.record('20', 'open boekjaar én geen blokkade: boeken mag', true);

  -- (b) open boekjaar, wél blokkade → geblokkeerd door de NIEUWE toets
  PERFORM proof.lock_as(v_slot, DATE '2024-12-31', 'Alleen een blokkade');
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  v_j := proof.new_manual(v_slot, DATE '2024-06-01');
  PERFORM proof.expect_error('21', 'open boekjaar mét blokkade: geweigerd door de boekingsblokkade',
    format('SELECT public.post_manual_journal(%L)', v_j), 'valt binnen de boekingsblokkade t/m');
  PERFORM proof.record('21b', 'en dat jaar was aantoonbaar NIET afgesloten',
    (SELECT afgesloten_boekjaar FROM public.clients WHERE id = v_slot) IS NULL);
END $$;

DO $$
DECLARE
  v_beide uuid := proof.new_client('Matrix — beide');
  v_j     uuid;
BEGIN
  PERFORM proof.seed_close(v_beide, 2024);
  PERFORM proof.lock_as(v_beide, DATE '2024-12-31', 'Beide');
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  v_j := proof.new_manual(v_beide, DATE '2024-06-01');

  -- Beide aanwezig: geweigerd, en het OUDE watermerk gaat voor — zo houdt elke
  -- bestaande weigering haar bestaande reden.
  PERFORM proof.expect_error('22', 'watermerk én blokkade: geweigerd, met de oude melding voorop',
    format('SELECT public.post_manual_journal(%L)', v_j),
    'Boekjaar 2024 is afgesloten voor deze administratie');
END $$;

-- ═══ 24-25. DE NIHIL-VERKLARING DOET BEWUST NIET MEE ════════════════════════

DO $$
DECLARE v_bron text;
BEGIN
  SELECT prosrc INTO v_bron FROM pg_proc WHERE proname = 'declare_opening_balance_nil';
  PERFORM proof.record('24', 'declare_opening_balance_nil() toetst de blokkade NIET',
    v_bron NOT LIKE '%assert_posting_allowed%' AND v_bron NOT LIKE '%posting_allowed%'
      AND v_bron NOT LIKE '%posting_locked_through%');

  PERFORM proof.record('24b', 'maar houdt wél haar jaarregel',
    v_bron LIKE '%afgesloten_boekjaar IS NOT NULL%');
END $$;

DO $$
DECLARE
  v_c  uuid := proof.new_client('PR D — nihil onder blokkade');
  v_ob uuid;
BEGIN
  -- Een blokkade die het hele jaar bestrijkt houdt de nihil-verklaring NIET
  -- tegen: zij schrijft geen grootboekregel en doet een uitspraak over een
  -- boekjaar, niet over een datum.
  PERFORM proof.lock_as(v_c, DATE '2025-12-31', 'Alles dicht');
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');

  INSERT INTO public.opening_balances
    (client_id, organization_id, boekjaar, opening_date, description, user_id)
  VALUES (v_c, '00000000-0000-0000-0000-00000000a001', 2025, DATE '2025-01-01', 'Nihil',
          '00000000-0000-0000-0000-0000000000e1')
  RETURNING id INTO v_ob;

  PERFORM public.declare_opening_balance_nil(v_ob);
  PERFORM proof.record('25', 'een nihil-verklaring lukt ook met een blokkade over dat jaar',
    (SELECT nil_declaration FROM public.opening_balances WHERE id = v_ob) = true,
    'blokkade t/m 31-12-2025, nihil-verklaring over 2025');
END $$;

-- ═══ 26-29. BEVEILIGING EN VORM ═════════════════════════════════════════════

DO $$
BEGIN
  PERFORM proof.record('26', 'de gedeelde bewering is niet aanroepbaar voor applicatierollen',
    NOT has_function_privilege('authenticated', 'public.assert_posting_allowed(uuid, date)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.assert_posting_allowed(uuid, date)', 'EXECUTE'));

  PERFORM proof.record('26b', 'en is SECURITY DEFINER met een vastgezet zoekpad',
    (SELECT prosecdef FROM pg_proc WHERE proname = 'assert_posting_allowed')
      AND (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE proname = 'assert_posting_allowed')
          = 'search_path=public');

  -- De rolvloeren en rechten van de schrijvers zelf zijn niet verbreed.
  PERFORM proof.record('27', 'de schrijvers houden hun EXECUTE-rechten precies zoals ze waren',
    has_function_privilege('authenticated', 'public.post_manual_journal(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.post_manual_journal(uuid)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.post_purchase_invoice(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.post_purchase_invoice(uuid)', 'EXECUTE'));

  PERFORM proof.record('28', 'elke gedateerde schrijver neemt de administratiegrendel vóór de bewering',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('post_purchase_invoice', 'post_sales_invoice', 'post_bank_allocation',
                          'post_manual_journal', 'post_opening_balance', 'reverse_posting_group',
                          'post_bank_transaction')
        AND position('lock_ledger_client' IN p.prosrc) > 0
        AND position('lock_ledger_client' IN p.prosrc) < position('assert_posting_allowed' IN p.prosrc)
    ) = 7,
    'zeven schrijvers, grendel vóór toets');

  PERFORM proof.record('29', 'close_fiscal_year() en set_posting_lock() zijn niet aangeraakt',
    (SELECT prosrc FROM pg_proc WHERE proname = 'close_fiscal_year') NOT LIKE '%assert_posting_allowed%'
      AND (SELECT prosrc FROM pg_proc WHERE proname = 'set_posting_lock') NOT LIKE '%assert_posting_allowed%');
END $$;
