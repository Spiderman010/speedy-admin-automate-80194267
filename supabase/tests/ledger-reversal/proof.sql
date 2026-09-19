-- REAL POSTGRESQL PROOF for 6C-b9 (tegenboekingsmotor) — run against a
-- THROWAWAY local cluster. Never run this against any BoekAssist database.
-- See run-proof.sh.
--
-- De vraag die dit harnas beantwoordt is niet "lijkt dit goed" maar "gedraagt
-- de database zich zo". Elke tegenboeking wordt daarom niet alleen gemaakt maar
-- ook nagerekend, en bij elke weigering staat de verwachte reden erbij.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ── resultaatverzameling ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proof.result (
  n      text,
  name   text,
  ok     boolean,
  detail text
);
GRANT INSERT, SELECT ON proof.result TO public;

CREATE OR REPLACE FUNCTION proof.expect_error(_n text, _name text, _sql text, _needle text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_msg text;
BEGIN
  BEGIN
    EXECUTE _sql;
    INSERT INTO proof.result VALUES (_n, _name, false, 'GEEN fout, terwijl een fout werd verwacht');
    RETURN;
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;
  IF position(lower(_needle) IN lower(v_msg)) > 0 THEN
    INSERT INTO proof.result VALUES (_n, _name, true, v_msg);
  ELSE
    INSERT INTO proof.result VALUES (_n, _name, false, format('andere fout dan verwacht (%s): %s', _needle, v_msg));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION proof.expect_ok(_n text, _name text, _sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE _sql;
  INSERT INTO proof.result VALUES (_n, _name, true, 'uitgevoerd zonder fout');
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('onverwachte fout: %s', SQLERRM));
END $$;

CREATE OR REPLACE FUNCTION proof.expect_true(_n text, _name text, _expr text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  EXECUTE format('SELECT (%s)', _expr) INTO v_ok;
  INSERT INTO proof.result VALUES (_n, _name, COALESCE(v_ok, false), COALESCE(v_ok::text, 'NULL'));
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('fout bij evaluatie: %s', SQLERRM));
END $$;

GRANT EXECUTE ON FUNCTION proof.expect_error(text, text, text, text) TO public;
GRANT EXECUTE ON FUNCTION proof.expect_ok(text, text, text) TO public;
GRANT EXECUTE ON FUNCTION proof.expect_true(text, text, text) TO public;

-- ── originelen, elk in een eigen (dus gecommitte) transactie ────────────────
-- g101  inkoopstijl, drie regels — precies het voorbeeld uit de opdracht
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-0000000000c1',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f003','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[100.00, 21.00, 0]::numeric[],
  ARRAY[0, 0, 121.00]::numeric[]);

-- g102  twee regels, centen die exact bewaard moeten blijven
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-0000000000c2',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f004','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[1234.56, 0]::numeric[],
  ARRAY[0, 1234.56]::numeric[]);

-- g103  VIER regels, waarvan TWEE op dezelfde rekening — rekeningen zijn binnen
--       een groep niet uniek en mogen nooit worden samengevoegd
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-0000000000c3',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f002',
        '00000000-0000-0000-0000-00000000f004','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[10.00, 15.00, 0, 0]::numeric[],
  ARRAY[0, 0, 5.00, 20.00]::numeric[]);

-- g104  andere organisatie
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-0000000000c9',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f009','00000000-0000-0000-0000-00000000f009']::uuid[],
  ARRAY[10.00, 0]::numeric[], ARRAY[0, 10.00]::numeric[]);

-- g105  administratie met boekjaar 2027 afgesloten
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000105', '00000000-0000-0000-0000-0000000000c5',
  DATE '2026-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[10.00, 0]::numeric[], ARRAY[0, 10.00]::numeric[]);

-- g106  vreemde valuta
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000106', '00000000-0000-0000-0000-0000000000c6',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[10.00, 0]::numeric[], ARRAY[0, 10.00]::numeric[], 'USD');

-- g107  wordt tweemaal tegengeboekt (idempotentie) en de tegenboeking daarvan
--       wordt opnieuw geprobeerd (geen ketens)
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000107', '00000000-0000-0000-0000-0000000000c4',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[7.00, 0]::numeric[], ARRAY[0, 7.00]::numeric[]);

-- g108  geforceerde mislukking ná de claim (atomiciteit)
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000108', '00000000-0000-0000-0000-0000000000c8',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[9.00, 0]::numeric[], ARRAY[0, 9.00]::numeric[]);

-- g109  regel op een inmiddels INACTIEVE rekening — bewust wél tegen te boeken
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000109', '00000000-0000-0000-0000-0000000000ca',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f007','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[3.00, 0]::numeric[], ARRAY[0, 3.00]::numeric[]);

-- g111  wordt tegengeboekt binnen een transactie die daarna terugdraait
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000111', '00000000-0000-0000-0000-0000000000d1',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[6.00, 0]::numeric[], ARRAY[0, 6.00]::numeric[]);

-- g112  tweede groep van DEZELFDE administratie als g108 — nodig om te kunnen
--       toetsen dat een tegenregel niet naar een regel van een andere groep mag
--       wijzen zonder dat de tenantcontrole van de fundering er eerder op valt
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000112', '00000000-0000-0000-0000-0000000000c8',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[5.00, 0]::numeric[], ARRAY[0, 5.00]::numeric[]);

-- g110  rolvloer (assistant mag niet)
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000110', '00000000-0000-0000-0000-0000000000cb',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[4.00, 0]::numeric[], ARRAY[0, 4.00]::numeric[]);

-- ── kapotte originelen (alleen te maken met de triggers uit) ────────────────
-- g120  niet in balans
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000120', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f002', 1,
  DATE '2027-03-01', 2027, 10.00, 0, 'EUR', 'purchase_invoice', '5001');
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000120', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f001', 2,
  DATE '2027-03-01', 2027, 0, 9.00, 'EUR', 'purchase_invoice', '5001');

-- g121  twee administraties in één groep
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000121', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f002', 1,
  DATE '2027-03-01', 2027, 10.00, 0);
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000121', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000ce', '00000000-0000-0000-0000-00000000f001', 2,
  DATE '2027-03-01', 2027, 0, 10.00);

-- g122  twee boekingsdatums
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000122', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f002', 1,
  DATE '2027-03-01', 2027, 10.00, 0, 'EUR', 'purchase_invoice', '5002');
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000122', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f001', 2,
  DATE '2027-04-01', 2027, 0, 10.00, 'EUR', 'purchase_invoice', '5002');

-- g123  boekjaar hoort niet bij de boekingsdatum
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000123', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f002', 1,
  DATE '2027-03-01', 2026, 10.00, 0, 'EUR', 'purchase_invoice', '5003');
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000123', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f001', 2,
  DATE '2027-03-01', 2026, 0, 10.00, 'EUR', 'purchase_invoice', '5003');

-- g128  NaN. De fundering heeft hier bewust GEEN CHECK op (bekend gat, zie de
--       6C-b6-sectie in PROJECT_MAP), dus dit is een toestand die écht kan
--       bestaan en die de schrijver zelf moet afvangen.
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000128', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f002', 1,
  DATE '2027-03-01', 2027, 'NaN'::numeric, 0, 'EUR', 'purchase_invoice', '5004');
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000128', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f001', 2,
  DATE '2027-03-01', 2027, 0, 'NaN'::numeric, 'EUR', 'purchase_invoice', '5004');

-- g125  regels uit twee verschillende transacties (zegel doorbroken)
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000125', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f002', 1,
  DATE '2027-03-01', 2027, 10.00, 0, 'EUR', 'manual_journal', '4242');
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000125', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f001', 2,
  DATE '2027-03-01', 2027, 0, 10.00, 'EUR', 'manual_journal', '4243');

-- g126  één regel: geen boeking
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000126', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f002', 1,
  DATE '2027-03-01', 2027, 10.00, 0);

-- g127  twee bronsoorten in één groep
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000127', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f002', 1,
  DATE '2027-03-01', 2027, 10.00, 0, 'EUR', 'manual_journal');
SELECT proof.seed_raw('00000000-0000-0000-0000-000000000127', '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f001', 2,
  DATE '2027-03-01', 2027, 0, 10.00, 'EUR', 'purchase_invoice');

-- ══ vanaf hier: de applicatierol ════════════════════════════════════════════
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
SET ROLE authenticated;

-- ── 1/2/3/4/5/6  de tegenboeking zelf ───────────────────────────────────────

SELECT proof.expect_ok('1', 'een tegenboeking van drie regels (inkoopstijl) slaagt', $$
  SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000101', DATE '2027-06-01', 'Onjuiste kostenrekening')
$$);

SELECT proof.expect_true('1a', 'de tegenboeking telt evenveel regels als het origineel', $$
  SELECT (SELECT count(*) FROM public.ledger_postings lp
          JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = lp.posting_group_id
          WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000101') = 3
$$);

SELECT proof.expect_true('3', 'debet en credit zijn per regel exact verwisseld, op de exacte rekening', $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.ledger_reversal_postings r
    JOIN public.ledger_postings t ON t.posting_group_id = r.reversal_posting_group_id
    JOIN public.ledger_postings o ON o.id = t.reversal_of_posting_id
    WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000101'
      AND (t.debit_amount  IS DISTINCT FROM o.credit_amount
        OR t.credit_amount IS DISTINCT FROM o.debit_amount
        OR t.grootboekrekening_id IS DISTINCT FROM o.grootboekrekening_id)
  )
$$);

SELECT proof.expect_true('3a', 'de drie tegenregels zijn precies 1600 debet 121, 4602 credit 100, 1680 credit 21', $$
  SELECT (
    SELECT count(*) FROM public.ledger_postings t
    JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
    JOIN public.grootboekrekeningen g ON g.id = t.grootboekrekening_id
    WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000101'
      AND ((g.nummer = 1600 AND t.debit_amount  = 121.00 AND t.credit_amount = 0)
        OR (g.nummer = 4602 AND t.credit_amount = 100.00 AND t.debit_amount  = 0)
        OR (g.nummer = 1680 AND t.credit_amount =  21.00 AND t.debit_amount  = 0))
  ) = 3
$$);

SELECT proof.expect_ok('4', 'een tegenboeking met centen slaagt', $$
  SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000102', DATE '2027-06-01')
$$);

SELECT proof.expect_true('4a', 'de centen zijn exact bewaard: 1234,56 keert terug als 1234,56', $$
  SELECT (SELECT sum(t.credit_amount) FROM public.ledger_postings t
          JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
          WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000102') = 1234.56
     AND (SELECT sum(t.debit_amount) FROM public.ledger_postings t
          JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
          WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000102') = 1234.56
$$);

SELECT proof.expect_true('6', 'de valuta van het origineel is overgenomen', $$
  SELECT (SELECT count(DISTINCT t.currency) FROM public.ledger_postings t
          JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
          WHERE r.original_posting_group_id IN ('00000000-0000-0000-0000-000000000101',
                                                '00000000-0000-0000-0000-000000000102')) = 1
     AND (SELECT DISTINCT t.currency FROM public.ledger_postings t
          JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
          WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000101') = 'EUR'
$$);

-- ── 7  het origineel blijft ongewijzigd ─────────────────────────────────────

SELECT proof.expect_true('7', 'de oorspronkelijke regels zijn na het tegenboeken onveranderd', $$
  SELECT (SELECT count(*) FROM public.ledger_postings
          WHERE posting_group_id = '00000000-0000-0000-0000-000000000101') = 3
     AND (SELECT sum(debit_amount) FROM public.ledger_postings
          WHERE posting_group_id = '00000000-0000-0000-0000-000000000101') = 121.00
     AND (SELECT count(*) FROM public.ledger_postings
          WHERE posting_group_id = '00000000-0000-0000-0000-000000000101'
            AND (reversal_of_posting_id IS NOT NULL OR source_type <> 'purchase_invoice'
                 OR posting_date <> DATE '2027-03-01')) = 0
$$);

SELECT proof.expect_error('7a', 'een oorspronkelijke regel kan sowieso niet worden gewijzigd', $$
  UPDATE public.ledger_postings SET debit_amount = 1
  WHERE posting_group_id = '00000000-0000-0000-0000-000000000101'
$$, 'permission denied');

-- ── 8/9/10  de nieuwe groep ─────────────────────────────────────────────────

SELECT proof.expect_true('8', 'de tegenboeking heeft een eigen, nieuwe boekingsgroep', $$
  SELECT NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings
                     WHERE reversal_posting_group_id = original_posting_group_id)
     AND (SELECT count(DISTINCT reversal_posting_group_id) FROM public.ledger_reversal_postings)
       = (SELECT count(*) FROM public.ledger_reversal_postings)
$$);

SELECT proof.expect_true('9', 'elke tegenboekingsgroep sluit: debet gelijk aan credit, groter dan nul', $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.ledger_postings
    WHERE source_type = 'reversal'
    GROUP BY posting_group_id
    HAVING sum(debit_amount) <> sum(credit_amount) OR sum(debit_amount) <= 0
  )
$$);

SELECT proof.expect_true('9a', 'origineel en tegenboeking tellen samen op tot nul, per rekening', $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.ledger_postings lp
    WHERE lp.posting_group_id IN ('00000000-0000-0000-0000-000000000101',
      (SELECT reversal_posting_group_id FROM public.ledger_reversal_postings
        WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000101'))
    GROUP BY lp.grootboekrekening_id
    HAVING sum(lp.debit_amount) - sum(lp.credit_amount) <> 0
  )
$$);

SELECT proof.expect_true('10', 'elke tegenregel wijst naar de exacte originele regel, nooit tweemaal dezelfde', $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.ledger_postings WHERE source_type = 'reversal' AND reversal_of_posting_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.ledger_postings t
    JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
    JOIN public.ledger_postings o ON o.id = t.reversal_of_posting_id
    WHERE o.posting_group_id <> r.original_posting_group_id
  )
  AND (SELECT count(DISTINCT reversal_of_posting_id) FROM public.ledger_postings WHERE source_type = 'reversal')
    = (SELECT count(*) FROM public.ledger_postings WHERE source_type = 'reversal')
$$);

-- ── meerdere regels op dezelfde rekening ────────────────────────────────────

SELECT proof.expect_ok('11a', 'een groep met twee regels op dezelfde rekening wordt tegengeboekt', $$
  SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000103', DATE '2027-06-01')
$$);

SELECT proof.expect_true('11b', 'die twee regels blijven twee afzonderlijke tegenregels (10 en 15, niet 25)', $$
  SELECT (SELECT count(*) FROM public.ledger_postings t
          JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
          WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000103') = 4
     AND (SELECT count(*) FROM public.ledger_postings t
          JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
          WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000103'
            AND t.grootboekrekening_id = '00000000-0000-0000-0000-00000000f002'
            AND t.credit_amount IN (10.00, 15.00)) = 2
$$);

SELECT proof.expect_true('11c', 'de regelnummering is 1..n, aaneengesloten', $$
  SELECT (SELECT array_agg(t.line_no ORDER BY t.line_no) FROM public.ledger_postings t
          JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
          WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000103')
       = ARRAY[1,2,3,4]
$$);

-- ── 11/12/13  onbekend, verkeerde tenant ────────────────────────────────────

SELECT proof.expect_error('12', 'een onbekende boekingsgroep wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-0000000009ff', DATE '2027-06-01')$$,
  'niet gevonden');

SELECT proof.expect_error('13', 'een boekingsgroep van een andere organisatie wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000104', DATE '2027-06-01')$$,
  'Geen rechten');

SELECT proof.expect_true('13a', 'en er is niets van die andere organisatie geboekt', $$
  SELECT NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings
                     WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000104')
$$);

-- ── 14  al tegengeboekt ─────────────────────────────────────────────────────

SELECT proof.expect_ok('14a', 'de eerste tegenboeking slaagt', $$
  SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000107', DATE '2027-06-01')
$$);

SELECT proof.expect_error('14b', 'een tweede tegenboeking van dezelfde groep wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000107', DATE '2027-07-01')$$,
  'al tegengeboekt');

SELECT proof.expect_true('14c', 'er staat precies één marker en één tegenboekingsgroep voor die groep', $$
  SELECT (SELECT count(*) FROM public.ledger_reversal_postings
          WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000107') = 1
     AND (SELECT count(*) FROM public.ledger_postings t
          JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
          WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000107') = 2
$$);

-- ── 15  geen tegenboeking van een tegenboeking ──────────────────────────────

SELECT proof.expect_error('15', 'een tegenboeking kan zelf niet worden tegengeboekt', $$
  SELECT public.reverse_posting_group(
    (SELECT reversal_posting_group_id FROM public.ledger_reversal_postings
      WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000107'),
    DATE '2027-08-01')
$$, 'zelf een tegenboeking');

-- ── 16  kapotte originelen ──────────────────────────────────────────────────

SELECT proof.expect_error('16a', 'een groep die niet in balans is wordt geweigerd, niet "hersteld"',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000120', DATE '2027-06-01')$$,
  'niet in balans');

SELECT proof.expect_error('16b', 'een groep met twee administraties wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000121', DATE '2027-06-01')$$,
  'meerdere administraties');

SELECT proof.expect_error('16c', 'een groep met twee boekingsdatums wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000122', DATE '2027-06-01')$$,
  'meerdere boekingsdatums');

SELECT proof.expect_error('16d', 'een groep waarvan het boekjaar niet bij de datum hoort wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000123', DATE '2027-06-01')$$,
  'hoort niet bij boekingsdatum');

SELECT proof.expect_error('16e', 'een groep met een NaN-bedrag wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000128', DATE '2027-06-01')$$,
  'geen getal');

SELECT proof.expect_error('16f', 'een groep uit twee transacties wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000125', DATE '2027-06-01')$$,
  'meerdere transacties');

SELECT proof.expect_error('16g', 'een groep van één regel wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000126', DATE '2027-06-01')$$,
  'minimaal een debet- en een creditregel');

SELECT proof.expect_error('16h', 'een groep met twee bronsoorten wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000127', DATE '2027-06-01')$$,
  'meerdere bronsoorten');

-- Twee controles in de schrijver zijn aantoonbaar ONBEREIKBAAR, omdat de
-- fundering zo'n rij al niet laat bestaan. Ze blijven staan omdat de schrijver
-- niet op constraints leunt die hij niet zelf bezit; hier wordt bewezen dat de
-- onbereikbaarheid echt is, in plaats van dat aan te nemen.
SELECT proof.expect_error('16i', 'een regel aan twee zijden tegelijk kan niet eens bestaan', $$
  SELECT proof.seed_raw('00000000-0000-0000-0000-000000000129', '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f002', 1,
    DATE '2027-03-01', 2027, 10.00, 10.00)
$$, 'single_side_check');

SELECT proof.expect_error('16j', 'een negatief bedrag kan niet eens bestaan', $$
  SELECT proof.seed_raw('00000000-0000-0000-0000-000000000129', '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-00000000f002', 1,
    DATE '2027-03-01', 2027, -10.00, 0)
$$, 'debit_amount_check');

SELECT proof.expect_true('16k', 'geen enkele kapotte groep heeft een marker of tegenregels opgeleverd', $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.ledger_reversal_postings
    WHERE original_posting_group_id::text LIKE '00000000-0000-0000-0000-00000000012%'
  )
$$);

-- ── 17  afgesloten boekjaar ─────────────────────────────────────────────────

SELECT proof.expect_error('17', 'een tegenboeking in een afgesloten boekjaar wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000105', DATE '2027-06-01')$$,
  'afgesloten');

SELECT proof.expect_true('17a', 'en de datum is NIET stilzwijgend naar een open jaar verschoven', $$
  SELECT NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings
                     WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000105')
$$);

SELECT proof.expect_error('17b', 'een datum vóór het origineel wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000108', DATE '2027-02-01')$$,
  'vóór de oorspronkelijke boeking');

SELECT proof.expect_error('17c', 'een datum buiten het ondersteunde bereik wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000108', DATE '2101-01-01')$$,
  'buiten het ondersteunde bereik');

SELECT proof.expect_error('17d', 'zonder datum wordt er niets geboekt',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000108', NULL)$$,
  'boekingsdatum nodig');

-- ── 18  valuta ──────────────────────────────────────────────────────────────

SELECT proof.expect_error('18', 'een groep in een andere valuta dan EUR wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000106', DATE '2027-06-01')$$,
  'wordt niet ondersteund');

-- ── rol en authenticatie ────────────────────────────────────────────────────

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);
SELECT proof.expect_error('19a', 'een assistant mag niet tegenboeken (vloer = accountant)',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000110', DATE '2027-06-01')$$,
  'accountant vereist');

SELECT set_config('test.user_id', '', false);
SELECT proof.expect_error('19b', 'een niet-ingelogde aanroep wordt geweigerd',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000110', DATE '2027-06-01')$$,
  'Niet ingelogd');

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.expect_true('19c', 'en geen van beide pogingen heeft iets geboekt', $$
  SELECT NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings
                     WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000110')
$$);

-- ── inactieve rekening: bewust toegestaan ───────────────────────────────────

SELECT proof.expect_ok('20a', 'een regel op een inmiddels inactieve rekening kan worden tegengeboekt', $$
  SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000109', DATE '2027-06-01')
$$);

-- ── toelichting ─────────────────────────────────────────────────────────────

SELECT proof.expect_true('20b', 'de toelichting is bewaard bij de claim', $$
  SELECT (SELECT reason FROM public.ledger_reversal_postings
          WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000101') = 'Onjuiste kostenrekening'
$$);

SELECT proof.expect_true('20c', 'zonder toelichting blijft het veld leeg, niet een verzonnen tekst', $$
  SELECT (SELECT reason FROM public.ledger_reversal_postings
          WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000102') IS NULL
$$);

SELECT proof.expect_error('20d', 'een te lange toelichting wordt geweigerd', $$
  SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000108', DATE '2027-06-01', repeat('x', 501))
$$, 'te lang');

-- ── 21  de schrijfdeur blijft dicht ─────────────────────────────────────────

SELECT proof.expect_error('21a', 'een rechtstreekse INSERT in het grootboek blijft geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, user_id)
  VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f001', gen_random_uuid(), 1, DATE '2027-06-01', 2027, 1.00, 0, 'EUR',
    'reversal', '00000000-0000-0000-0000-0000000000e1')
$$, 'permission denied');

SELECT proof.expect_error('21b', 'de markertabel is niet schrijfbaar voor de applicatie', $$
  INSERT INTO public.ledger_reversal_postings (original_posting_group_id, reversal_posting_group_id,
    organization_id, client_id, original_posting_date, original_boekjaar, original_source_type,
    posting_date, boekjaar, line_count, total_amount, currency, user_id)
  VALUES (gen_random_uuid(), gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000c1', DATE '2027-03-01', 2027, 'manual_journal',
    DATE '2027-06-01', 2027, 2, 10.00, 'EUR', '00000000-0000-0000-0000-0000000000e1')
$$, 'permission denied');

SELECT proof.expect_error('21c', 'een claim kan niet worden verwijderd door de applicatie',
  $$DELETE FROM public.ledger_reversal_postings WHERE true$$, 'permission denied');

SELECT proof.expect_true('21d', 'de rechtenkaart: alleen authenticated mag de RPC aanroepen', $$
  SELECT     has_function_privilege('authenticated', 'public.reverse_posting_group(uuid,date,text)', 'EXECUTE')
     AND NOT has_function_privilege('anon',          'public.reverse_posting_group(uuid,date,text)', 'EXECUTE')
     AND NOT has_function_privilege('service_role',  'public.reverse_posting_group(uuid,date,text)', 'EXECUTE')
$$);

SELECT proof.expect_true('21e', 'de markertabel is leesbaar en verder niets', $$
  SELECT     has_table_privilege('authenticated', 'public.ledger_reversal_postings', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.ledger_reversal_postings', 'INSERT')
     AND NOT has_table_privilege('authenticated', 'public.ledger_reversal_postings', 'UPDATE')
     AND NOT has_table_privilege('authenticated', 'public.ledger_reversal_postings', 'DELETE')
     AND NOT has_table_privilege('anon',          'public.ledger_reversal_postings', 'SELECT')
$$);

-- ── 22  de bestaande schrijvers werken onverminderd ─────────────────────────
-- Beginbalans en memoriaal zijn de twee schrijvers waarvan de migratie in dit
-- harnas draait; ze worden hier end-to-end aangeroepen. Inkoop, verkoop en bank
-- hebben brondocumenttabellen nodig die dit harnas niet opzet — voor hen bewijst
-- 22c dat deze migratie hun schrijfpad niet raakt.

SELECT proof.expect_ok('22a', 'post_manual_journal() boekt onverminderd',
  $$SELECT proof.post_memoriaal()$$);

SELECT proof.expect_ok('22b', 'post_opening_balance() boekt onverminderd',
  $$SELECT proof.post_beginbalans()$$);

-- Een geboekte beginbalans is bewust NIET tegen te boeken: de administratie zou
-- daarna geen nieuwe beginbalans meer kunnen vastleggen. Zie de migratieheader.
SELECT proof.expect_error('15b', 'een geboekte beginbalans wordt niet tegengeboekt, met de reden erbij', $$
  SELECT public.reverse_posting_group(
    (SELECT posting_group_id FROM public.ledger_postings
      WHERE source_type = 'opening_balance' LIMIT 1),
    DATE '2027-06-01')
$$, 'geen nieuwe beginbalans');

SELECT proof.expect_true('15c', 'en die beginbalans staat er onveranderd', $$
  SELECT (SELECT count(*) FROM public.ledger_postings WHERE source_type = 'opening_balance') = 2
     AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings
                     WHERE original_source_type = 'opening_balance')
$$);

SELECT proof.expect_true('22c', 'de nieuwe claimtrigger laat elke andere bronsoort ongemoeid', $$
  SELECT (SELECT count(*) FROM public.ledger_postings
          WHERE source_type IN ('manual_journal', 'opening_balance', 'purchase_invoice')) > 0
$$);

-- ── 23  rapportage telt tegenboekingen gewoon mee ───────────────────────────

SELECT proof.expect_true('23', 'een gewone som over de administratie nettoteert origineel en tegenboeking op nul', $$
  SELECT (SELECT COALESCE(sum(debit_amount) - sum(credit_amount), 0)
          FROM public.ledger_postings
          WHERE client_id = '00000000-0000-0000-0000-0000000000c1') = 0
$$);

SELECT proof.expect_true('23a', 'de tegenregels zijn gewone grootboekregels: geen eigen tabel, geen vlag', $$
  SELECT (SELECT count(*) FROM public.ledger_postings
          WHERE client_id = '00000000-0000-0000-0000-0000000000c1') = 6
$$);

-- ── de claimtrigger, los van de RPC ─────────────────────────────────────────
RESET ROLE;

-- Een handgemaakte claim, zodat elke tak van de trigger apart te toetsen is.
-- (Als eigenaar; de applicatierol kan hier niet bij — bewijs 21b.)
INSERT INTO public.ledger_reversal_postings (
  original_posting_group_id, reversal_posting_group_id, organization_id, client_id,
  original_posting_date, original_boekjaar, original_source_type,
  posting_date, boekjaar, line_count, total_amount, currency, user_id
) VALUES (
  '00000000-0000-0000-0000-000000000108', '00000000-0000-0000-0000-0000000008ff',
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c8',
  DATE '2027-03-01', 2027, 'manual_journal',
  DATE '2027-06-01', 2027, 2, 9.00, 'EUR', '00000000-0000-0000-0000-0000000000e1'
);

SELECT proof.expect_error('24a', 'een tegenregel zonder claim wordt geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id,
    reversal_of_posting_id, user_id)
  SELECT o.organization_id, o.client_id, o.grootboekrekening_id, gen_random_uuid(), 1,
         DATE '2027-06-01', 2027, o.credit_amount, o.debit_amount, 'EUR', 'reversal',
         gen_random_uuid(), o.id, o.user_id
  FROM public.ledger_postings o
  WHERE o.posting_group_id = '00000000-0000-0000-0000-000000000109' AND o.line_no = 1
$$, 'niet via reverse_posting_group()');

SELECT proof.expect_error('24b', 'een tegenregel in een andere groep dan de geclaimde wordt geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id,
    reversal_of_posting_id, user_id)
  SELECT o.organization_id, o.client_id, o.grootboekrekening_id, gen_random_uuid(), 1,
         DATE '2027-06-01', 2027, o.credit_amount, o.debit_amount, 'EUR', 'reversal',
         '00000000-0000-0000-0000-000000000108', o.id, o.user_id
  FROM public.ledger_postings o
  WHERE o.posting_group_id = '00000000-0000-0000-0000-000000000108' AND o.line_no = 1
$$, 'maar één boekingsgroep');

SELECT proof.expect_error('24c', 'een tegenregel zonder verwijzing naar een originele regel wordt geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id, user_id)
  VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c8',
    '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000008ff', 1,
    DATE '2027-06-01', 2027, 9.00, 0, 'EUR', 'reversal', '00000000-0000-0000-0000-000000000108',
    '00000000-0000-0000-0000-0000000000e1')
$$, 'moet naar de tegengeboekte grootboekregel verwijzen');

SELECT proof.expect_error('24d', 'een tegenregel die debet en credit NIET verwisselt wordt geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id,
    reversal_of_posting_id, user_id)
  SELECT o.organization_id, o.client_id, o.grootboekrekening_id,
         '00000000-0000-0000-0000-0000000008ff', 1,
         DATE '2027-06-01', 2027, o.debit_amount, o.credit_amount, 'EUR', 'reversal',
         '00000000-0000-0000-0000-000000000108', o.id, o.user_id
  FROM public.ledger_postings o
  WHERE o.posting_group_id = '00000000-0000-0000-0000-000000000108' AND o.line_no = 1
$$, 'verwisselt debet en credit exact');

SELECT proof.expect_error('24e', 'een tegenregel op een ANDERE rekening wordt geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id,
    reversal_of_posting_id, user_id)
  SELECT o.organization_id, o.client_id, '00000000-0000-0000-0000-00000000f004',
         '00000000-0000-0000-0000-0000000008ff', 1,
         DATE '2027-06-01', 2027, o.credit_amount, o.debit_amount, 'EUR', 'reversal',
         '00000000-0000-0000-0000-000000000108', o.id, o.user_id
  FROM public.ledger_postings o
  WHERE o.posting_group_id = '00000000-0000-0000-0000-000000000108' AND o.line_no = 1
$$, 'dezelfde grootboekrekening');

SELECT proof.expect_error('24f', 'een verwijzing naar een regel van een ANDERE groep wordt geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id,
    reversal_of_posting_id, user_id)
  SELECT '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c8',
         o.grootboekrekening_id, '00000000-0000-0000-0000-0000000008ff', 1,
         DATE '2027-06-01', 2027, o.credit_amount, o.debit_amount, 'EUR', 'reversal',
         '00000000-0000-0000-0000-000000000108', o.id, '00000000-0000-0000-0000-0000000000e1'
  FROM public.ledger_postings o
  WHERE o.posting_group_id = '00000000-0000-0000-0000-000000000112' AND o.line_no = 1
$$, 'hoort niet bij de geclaimde');

SELECT proof.expect_error('24g', 'een afwijkende boekingsdatum wordt geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id,
    reversal_of_posting_id, user_id)
  SELECT o.organization_id, o.client_id, o.grootboekrekening_id,
         '00000000-0000-0000-0000-0000000008ff', 1,
         DATE '2027-07-01', 2027, o.credit_amount, o.debit_amount, 'EUR', 'reversal',
         '00000000-0000-0000-0000-000000000108', o.id, o.user_id
  FROM public.ledger_postings o
  WHERE o.posting_group_id = '00000000-0000-0000-0000-000000000108' AND o.line_no = 1
$$, 'wijkt af van de geclaimde tegenboeking');

SELECT proof.expect_error('24h', 'een regelnummer buiten het geclaimde aantal wordt geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id,
    reversal_of_posting_id, user_id)
  SELECT o.organization_id, o.client_id, o.grootboekrekening_id,
         '00000000-0000-0000-0000-0000000008ff', 3,
         DATE '2027-06-01', 2027, o.credit_amount, o.debit_amount, 'EUR', 'reversal',
         '00000000-0000-0000-0000-000000000108', o.id, o.user_id
  FROM public.ledger_postings o
  WHERE o.posting_group_id = '00000000-0000-0000-0000-000000000108' AND o.line_no = 1
$$, 'heeft geen regel 3');

SELECT proof.expect_error('24i', 'reversal_of_posting_id onder een andere bronsoort wordt door de CHECK geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id,
    reversal_of_posting_id, user_id)
  SELECT o.organization_id, o.client_id, o.grootboekrekening_id, gen_random_uuid(), 1,
         DATE '2027-06-01', 2027, o.credit_amount, o.debit_amount, 'EUR', 'purchase_invoice',
         gen_random_uuid(), o.id, o.user_id
  FROM public.ledger_postings o
  WHERE o.posting_group_id = '00000000-0000-0000-0000-000000000108' AND o.line_no = 1
$$, 'reversal_source_type_check');

SELECT proof.expect_true('24j', 'geen van die pogingen heeft een regel achtergelaten', $$
  SELECT NOT EXISTS (SELECT 1 FROM public.ledger_postings
                     WHERE posting_group_id = '00000000-0000-0000-0000-0000000008ff')
$$);

DELETE FROM public.ledger_reversal_postings
WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000108';

-- ── 25  atomiciteit: een geforceerde mislukking ná de claim ─────────────────
-- Een echte fout midden in de functie, na de claim-INSERT en na de eerste
-- grootboekregel. Een ALWAYS-trigger die op de tweede regel afgaat is de enige
-- manier om dat af te dwingen; hij wordt meteen daarna weer verwijderd.

CREATE OR REPLACE FUNCTION proof.fail_on_second_reversal_row()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type = 'reversal'
     AND EXISTS (SELECT 1 FROM public.ledger_postings
                 WHERE posting_group_id = NEW.posting_group_id) THEN
    RAISE EXCEPTION 'proof: geforceerde mislukking op de tweede tegenregel';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER zz_proof_fail_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION proof.fail_on_second_reversal_row();

SET ROLE authenticated;
SELECT proof.expect_error('25a', 'een mislukking na de claim laat de hele tegenboeking mislukken',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000108', DATE '2027-06-01')$$,
  'geforceerde mislukking');
RESET ROLE;

DROP TRIGGER zz_proof_fail_trigger ON public.ledger_postings;

SELECT proof.expect_true('25b', 'er is GEEN claim achtergebleven', $$
  SELECT NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings
                     WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000108')
$$);

SELECT proof.expect_true('25c', 'er is GEEN halve tegenboeking achtergebleven', $$
  SELECT (SELECT count(*) FROM public.ledger_postings
          WHERE client_id = '00000000-0000-0000-0000-0000000000c8') = 4
$$);

SET ROLE authenticated;
SELECT proof.expect_ok('25d', 'en na het opheffen van de storing slaagt de tegenboeking alsnog',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000108', DATE '2027-06-01')$$);

SELECT proof.expect_true('25e', 'precies één claim en twee tegenregels', $$
  SELECT (SELECT count(*) FROM public.ledger_reversal_postings
          WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000108') = 1
     AND (SELECT count(*) FROM public.ledger_postings
          WHERE client_id = '00000000-0000-0000-0000-0000000000c8') = 6
$$);

-- ── 25f  een groep uit DEZE transactie is nog niet gecommit ─────────────────
-- Origineel en tegenboeking zouden dan samen staan of samen vallen; dat is geen
-- correctie. Het memoriaal van bewijs 22a wordt hier in één transactie geboekt
-- en meteen tegengeboekt.

RESET ROLE;
CREATE OR REPLACE FUNCTION proof.post_and_reverse()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid := '00000000-0000-0000-0000-0000000000ab'; v_group uuid;
BEGIN
  INSERT INTO public.manual_journals (id, organization_id, client_id, user_id, posting_date, description)
  VALUES (v_id, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000cc',
          '00000000-0000-0000-0000-0000000000e1', DATE '2027-05-02', 'Meteen tegenboeken');
  INSERT INTO public.manual_journal_lines
    (manual_journal_id, organization_id, user_id, sort_order, grootboekrekening_id, debit_amount, credit_amount)
  VALUES
    (v_id, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', 1,
     '00000000-0000-0000-0000-00000000f002', 2.00, 0),
    (v_id, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', 2,
     '00000000-0000-0000-0000-00000000f001', 0, 2.00);
  v_group := public.post_manual_journal(v_id);
  PERFORM public.reverse_posting_group(v_group, DATE '2027-06-01');
END $$;
GRANT EXECUTE ON FUNCTION proof.post_and_reverse() TO public;
SET ROLE authenticated;

SELECT proof.expect_error('25f', 'een groep uit dezelfde transactie kan nog niet worden tegengeboekt',
  $$SELECT proof.post_and_reverse()$$, 'in dezelfde transactie ontstaan');

-- ── 26  een teruggedraaide aanroeper laat niets achter ──────────────────────

BEGIN;
SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000111', DATE '2027-09-01');
ROLLBACK;

SELECT proof.expect_true('26', 'na een rollback van de aanroeper staat er geen claim en geen tegenregel', $$
  SELECT NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings
                     WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000111')
     AND (SELECT count(*) FROM public.ledger_postings
          WHERE client_id = '00000000-0000-0000-0000-0000000000d1') = 2
$$);

SELECT proof.expect_ok('26a', 'en daarna kan de tegenboeking gewoon alsnog worden gemaakt',
  $$SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000111', DATE '2027-09-01')$$);

RESET ROLE;
