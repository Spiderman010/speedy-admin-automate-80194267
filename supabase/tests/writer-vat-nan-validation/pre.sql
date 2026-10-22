-- VÓÓR 20261021170000 — throwaway database only.
--
-- NEGATIEVE CONTROLES: met de echte keten tot en met 20261020120000 bestaan de
-- bugs werkelijk (rood), zodat de bewijzen ná de migratie (groen) iets zeggen.
-- Wat hier geboekt wordt, blijft staan als HISTORIE, zoals in productie: de
-- migratie mag die niet aanraken (geen backfill).
--
-- Daarnaast de bestaande toestand die de migratie moet verdragen: NaN-rijen van
-- vóór de CHECK (NOT VALID laat ze staan), ongeboekte bankregels zonder
-- btw-keuze, ongeboekte facturen van een vrijgestelde administratie met btw.
-- Tot slot de PRE-blokken uit preflight.sql, letterlijk.

SELECT proof.plan(ARRAY['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8']);

SELECT proof.put('md5_voor', proof.p4_md5s());
SELECT proof.put('attrs_voor', proof.p4_attrs());

-- ── N1. E-06: een bankregel zonder btw-keuze boekt stil als 0% ──────────────
SELECT proof.p4_tx(1, -121.00, NULL);
SELECT proof.put('n1', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 1)));
SELECT proof.record('N1', 'vóór: een gecodeerde bankregel zonder btw-keuze wordt stil als 0% geboekt (E-06)',
  proof.get('n1') LIKE 'ok: %'
  AND proof.p4_lines('bank_transaction', proof.uid(1400, 1)) = '4700:121.00:0.00,1100:0.00:121.00',
  proof.get('n1') || ' / ' || coalesce(proof.p4_lines('bank_transaction', proof.uid(1400, 1)), '-'));

-- ── N2. F1c-N1: btw van een vrijgestelde administratie wordt voorbelasting ──
SELECT proof.p4_purchase(1, '00000000-0000-0000-0000-0000000000c2', 100.00, 21.00, 121.00, 21, ARRAY[100.00]);
SELECT proof.put('n2', proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 1)));
SELECT proof.record('N2', 'vóór: een vrijgestelde administratie boekt btw als voorbelasting (1520) (F1c-N1)',
  proof.get('n2') LIKE 'ok: %'
  AND proof.p4_lines('purchase_invoice', proof.uid(2400, 1)) = '4700:100.00:0.00,1520:21.00:0.00,1600:0.00:121.00',
  proof.get('n2') || ' / ' || coalesce(proof.p4_lines('purchase_invoice', proof.uid(2400, 1)), '-'));

-- ── N3. A3-01: een NaN-inkoopfactuur komt in het grootboek, "in balans" ─────
-- Echt vastgelegd (eigen transactie, met de uitgestelde balanscontrole bij
-- COMMIT): deze groep is de bestaande NaN-historie die Q7 telt en waarop een
-- latere VALIDATE moet stuklopen.
SELECT proof.p4_purchase(2, '00000000-0000-0000-0000-0000000000c1', 'NaN', 'NaN', 'NaN', 21, ARRAY['NaN'::numeric]);
SELECT proof.put('n3', proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 2)));
SELECT proof.record('N3', 'vóór: een NaN-inkoopfactuur wordt geboekt; NaN = NaN, dus de groep heet in balans (A3-01)',
  proof.get('n3') LIKE 'ok: %'
  AND (SELECT count(*) FROM public.ledger_postings
       WHERE source_id = proof.uid(2400, 2) AND (debit_amount = 'NaN'::numeric OR credit_amount = 'NaN'::numeric)) = 3
  AND proof.unbalanced() = 0,
  proof.get('n3') || ' / ' || coalesce(proof.p4_lines('purchase_invoice', proof.uid(2400, 2)), '-'));

-- ── N4. E-06: de preflight noemt een regel zonder btw-keuze 'ready' ─────────
SELECT proof.p4_tx(2, -50.00, NULL);
SELECT proof.record('N4', 'vóór: de preflight noemt een gecodeerde regel zonder btw-keuze ''ready''',
  proof.call(proof.u(2), format(
    'SELECT workflow_state || coalesce(reason, '''') FROM public.bank_bulk_posting_candidates(%L::uuid, NULL) WHERE transaction_id = %L::uuid',
    '00000000-0000-0000-0000-0000000000c1', proof.uid(1400, 2))) = 'ok: ready',
  proof.call(proof.u(2), format(
    'SELECT workflow_state FROM public.bank_bulk_posting_candidates(%L::uuid, NULL) WHERE transaction_id = %L::uuid',
    '00000000-0000-0000-0000-0000000000c1', proof.uid(1400, 2))));

-- ── N5. A3-16: regels in fracties van een cent worden stil afgerond ─────────
SELECT proof.p4_purchase(3, '00000000-0000-0000-0000-0000000000c1', 20.01, 0, 20.01, 0, ARRAY[10.004, 10.006]);
SELECT proof.put('n5', proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 3)));
SELECT proof.record('N5', 'vóór: regels 10,004 en 10,006 worden stil als 10,00 en 10,01 geboekt (A3-16)',
  proof.get('n5') LIKE 'ok: %'
  AND proof.p4_lines('purchase_invoice', proof.uid(2400, 3)) = '4700:10.00:0.00,4700:10.01:0.00,1600:0.00:20.01',
  proof.get('n5') || ' / ' || coalesce(proof.p4_lines('purchase_invoice', proof.uid(2400, 3)), '-'));

-- ── N6/N7. A3-01: NaN-bank- en -verkoopbedragen komen door schrijver én balans ──
-- In een subtransactie die daarna wordt teruggedraaid; de bronrijen blijven
-- als bestaande NaN-rijen staan voor de bewijzen ná de migratie.
SELECT proof.p4_tx(3, 'NaN', 0);
SELECT proof.p4_sales(1, '00000000-0000-0000-0000-0000000000c1', 'NaN', 'NaN', 'NaN', 21);
DO $$
DECLARE
  v_bank text; v_bank_lines text; v_bank_err text;
  v_sales text; v_sales_lines text; v_sales_err text;
BEGIN
  BEGIN
    v_bank := proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 3));
    v_bank_lines := proof.p4_lines('bank_transaction', proof.uid(1400, 3));
    SET CONSTRAINTS ALL IMMEDIATE;   -- de uitgestelde groepsbalans, nu
    RAISE EXCEPTION 'terugdraaien' USING ERRCODE = 'P0001';
  EXCEPTION WHEN others THEN
    IF SQLSTATE <> 'P0001' THEN v_bank_err := SQLERRM; END IF;
  END;
  BEGIN
    v_sales := proof.p4_post(proof.u(2), 'post_sales_invoice', proof.uid(3400, 1));
    v_sales_lines := proof.p4_lines('sales_invoice', proof.uid(3400, 1));
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'terugdraaien' USING ERRCODE = 'P0001';
  EXCEPTION WHEN others THEN
    IF SQLSTATE <> 'P0001' THEN v_sales_err := SQLERRM; END IF;
  END;
  PERFORM proof.record('N6', 'vóór: een NaN-bankbedrag komt door de schrijver en de groepsbalans (A3-01)',
    v_bank LIKE 'ok: %' AND v_bank_lines LIKE '%NaN%' AND v_bank_err IS NULL,
    concat_ws(' / ', v_bank, v_bank_lines, v_bank_err));
  PERFORM proof.record('N7', 'vóór: een NaN-verkoopfactuur komt door de schrijver en de groepsbalans (A3-01)',
    v_sales LIKE 'ok: %' AND v_sales_lines LIKE '%NaN%' AND v_sales_err IS NULL,
    concat_ws(' / ', v_sales, v_sales_lines, v_sales_err));
END $$;

-- ── de bestaande toestand ───────────────────────────────────────────────────
-- Bank: c2 (vrijgesteld) zonder keuze, een niet-gecodeerde regel zonder keuze.
SELECT proof.p4_tx(4, -80.00, NULL, '00000000-0000-0000-0000-0000000000c2');
SELECT proof.p4_tx(5, -60.00, NULL, '00000000-0000-0000-0000-0000000000c1', DATE '2027-03-01', 'niet_gematcht');
-- Inkoop: NaN in de kop, NaN of oneindig in een regel (kolom zonder schaal).
SELECT proof.p4_purchase(4, '00000000-0000-0000-0000-0000000000c1', 'NaN', 0, 100.00, 0, ARRAY[100.00]);
SELECT proof.p4_purchase(5, '00000000-0000-0000-0000-0000000000c1', 100.00, 0, 100.00, 0, ARRAY['NaN'::numeric]);
SELECT proof.p4_purchase(6, '00000000-0000-0000-0000-0000000000c1', 100.00, 0, 100.00, 0, ARRAY['Infinity'::numeric]);
-- Vrijgesteld met btw: boekklaar en nog in controle.
SELECT proof.p4_purchase(7, '00000000-0000-0000-0000-0000000000c2', 200.00, 42.00, 242.00, 21, ARRAY[200.00]);
SELECT proof.p4_purchase(8, '00000000-0000-0000-0000-0000000000c2', 50.00, 10.50, 60.50, 21, ARRAY[50.00], 'te_controleren');
-- Fracties van een cent, ongeboekt.
SELECT proof.p4_purchase(9, '00000000-0000-0000-0000-0000000000c1', 30.01, 0, 30.01, 0, ARRAY[15.005, 15.005]);

SELECT proof.record('N8', 'vóór: de bestaande NaN-rijen staan er (geen CHECK houdt ze tegen)',
  (SELECT count(*) FROM public.purchase_invoices WHERE amount_excl = 'NaN'::numeric) = 2
  AND (SELECT count(*) FROM public.purchase_invoice_lines
       WHERE amount_excl IN ('NaN'::numeric, 'Infinity'::numeric)) = 3
  AND (SELECT count(*) FROM public.sales_invoices WHERE amount_excl = 'NaN'::numeric) = 1
  AND (SELECT count(*) FROM public.bank_transactions WHERE amount = 'NaN'::numeric) = 1);

-- ── de PRE-blokken uit preflight.sql, letterlijk ────────────────────────────
SELECT proof.put('pre1_all_true', proof.p4_all_true(:'pre1')::text);
SELECT proof.put('pre2_all_true', proof.p4_all_true(:'pre2')::text);
SELECT proof.put('pre3', proof.p4_rows(:'pre3'));
SELECT proof.put('pre4', proof.p4_rows(:'pre4'));
SELECT proof.put('pre5', proof.p4_rows(:'pre5'));
SELECT proof.put('pre6', proof.p4_rows(:'pre6'));
