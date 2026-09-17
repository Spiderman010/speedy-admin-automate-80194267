-- REAL POSTGRESQL PROOF for 6C-b8 PR 1 — run against a THROWAWAY local cluster.
-- Never run this against any BoekAssist database. See run-proof.sh.
--
-- Everything below runs as the role `authenticated` with a session user id, so
-- RLS, the column-level grants and the function grants are exercised for real,
-- exactly as a PostgREST caller would hit them. Fixtures are created as the
-- owner first.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ── result collection ───────────────────────────────────────────────────────

DROP SCHEMA IF EXISTS proof CASCADE;
CREATE SCHEMA proof;
GRANT USAGE ON SCHEMA proof TO public;

CREATE TABLE proof.result (
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
END
$$;

CREATE OR REPLACE FUNCTION proof.expect_ok(_n text, _name text, _sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE _sql;
  INSERT INTO proof.result VALUES (_n, _name, true, 'uitgevoerd zonder fout');
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('onverwachte fout: %s', SQLERRM));
END
$$;

-- _expr is a boolean SQL expression.
CREATE OR REPLACE FUNCTION proof.expect_true(_n text, _name text, _expr text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  EXECUTE format('SELECT (%s)', _expr) INTO v_ok;
  INSERT INTO proof.result VALUES (_n, _name, COALESCE(v_ok, false), COALESCE(v_ok::text, 'NULL'));
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('fout bij evaluatie: %s', SQLERRM));
END
$$;

GRANT EXECUTE ON FUNCTION proof.expect_error(text, text, text, text) TO public;
GRANT EXECUTE ON FUNCTION proof.expect_ok(text, text, text) TO public;
GRANT EXECUTE ON FUNCTION proof.expect_true(text, text, text) TO public;

-- ── fixtures (as owner) ─────────────────────────────────────────────────────

TRUNCATE public.opening_balance_lines, public.opening_balances CASCADE;

-- ledger_postings is append-only; the proof always runs on a fresh database.

INSERT INTO public.organizations (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Org A'),
  ('00000000-0000-0000-0000-0000000000a2', 'Org B');

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'acc1@test'),
  ('00000000-0000-0000-0000-0000000000e2', 'asst1@test'),
  ('00000000-0000-0000-0000-0000000000e3', 'ro1@test'),
  ('00000000-0000-0000-0000-0000000000e4', 'acc2@test');

INSERT INTO public.organization_members (user_id, organization_id) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a2');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'accountant'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'assistant'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', 'read_only'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a2', 'accountant');

-- Administraties: c1..c8 in org A (one per scenario that posts), c9 in org B.
INSERT INTO public.clients (id, organization_id, name, afgesloten_boekjaar) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Klant 1', NULL),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'Klant 2', NULL),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'Klant 3', 2027),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'Klant 4', NULL),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000a1', 'Klant 5', NULL),
  ('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000a1', 'Klant 6', NULL),
  ('00000000-0000-0000-0000-0000000000c7', '00000000-0000-0000-0000-0000000000a1', 'Klant 7', NULL),
  ('00000000-0000-0000-0000-0000000000c8', '00000000-0000-0000-0000-0000000000a1', 'Klant 8', NULL),
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000a2', 'Klant 9', NULL),
  ('00000000-0000-0000-0000-0000000000ca', '00000000-0000-0000-0000-0000000000a1', 'Klant 10', NULL),
  ('00000000-0000-0000-0000-0000000000cb', '00000000-0000-0000-0000-0000000000a1', 'Klant 11', NULL),
  ('00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-0000000000a1', 'Klant 12', NULL);

-- Shared org-A accounts (client_id NULL), one per category plus the edge cases.
INSERT INTO public.grootboekrekeningen (id, organization_id, client_id, nummer, omschrijving, categorie, actief) VALUES
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000a1', NULL, 1200, 'Bank',            'activa',  true),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000000a1', NULL, 1600, 'Crediteuren',     'passiva', true),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-0000000000a1', NULL, 8000, 'Omzet',           'omzet',   true),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-0000000000a1', NULL, 4000, 'Kosten',          'kosten',  true),
  ('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-0000000000a1', NULL, 1690, 'Prive',           'privé',   true),
  ('00000000-0000-0000-0000-00000000f006', '00000000-0000-0000-0000-0000000000a1', NULL, 9000, 'Vrije tekst',     'iets anders', true),
  ('00000000-0000-0000-0000-00000000f007', '00000000-0000-0000-0000-0000000000a1', NULL, 9100, 'Inactief',        'activa',  false),
  ('00000000-0000-0000-0000-00000000f008', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2', 1250, 'Alleen klant 2', 'activa', true),
  ('00000000-0000-0000-0000-00000000f009', '00000000-0000-0000-0000-0000000000a2', NULL, 1200, 'Bank org B',      'activa',  true);

-- Fixture helper: a draft header plus lines, written as the owner so the proof
-- can set up scenarios without going through the RPC under test.
CREATE OR REPLACE FUNCTION proof.draft(
  _id uuid, _client uuid, _date date, _year integer DEFAULT NULL, _desc text DEFAULT 'Beginbalans'
) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.opening_balances (id, organization_id, client_id, user_id, boekjaar, opening_date, description)
  SELECT _id, c.organization_id, _client, '00000000-0000-0000-0000-0000000000e1',
         COALESCE(_year, EXTRACT(YEAR FROM _date)::integer), _date, _desc
  FROM public.clients c WHERE c.id = _client;
  RETURN _id;
END
$$;

CREATE OR REPLACE FUNCTION proof.line(
  _header uuid, _account uuid, _debit numeric, _credit numeric, _sort integer DEFAULT 0, _desc text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.opening_balance_lines (
    id, opening_balance_id, organization_id, client_id, user_id,
    grootboekrekening_id, debit_amount, credit_amount, sort_order, description)
  SELECT v_id, _header, ob.organization_id, ob.client_id, '00000000-0000-0000-0000-0000000000e1',
         _account, _debit, _credit, _sort, _desc
  FROM public.opening_balances ob WHERE ob.id = _header;
  RETURN v_id;
END
$$;

GRANT EXECUTE ON FUNCTION proof.draft(uuid, uuid, date, integer, text) TO public;
GRANT EXECUTE ON FUNCTION proof.line(uuid, uuid, numeric, numeric, integer, text) TO public;

-- ── everything below runs as the application role ───────────────────────────

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
SET ROLE authenticated;

-- 1 balanced 2-line opening ─────────────────────────────────────────────────
SELECT proof.draft('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000c1', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000f001', 1000.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000f002', 0, 1000.00, 2);
SELECT proof.expect_ok('1', 'sluitende beginbalans van twee regels wordt geboekt',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b001')$$);
SELECT proof.expect_true('1b', 'twee grootboekregels, één groep, in balans', $$
  SELECT count(*) = 2
     AND count(DISTINCT posting_group_id) = 1
     AND SUM(debit_amount) = SUM(credit_amount)
     AND SUM(debit_amount) = 1000.00
  FROM public.ledger_postings WHERE source_id = '00000000-0000-0000-0000-00000000b001'
$$);

-- 4 debit line / 5 credit line ──────────────────────────────────────────────
SELECT proof.expect_true('4', 'de debetregel staat als debet in het grootboek', $$
  SELECT debit_amount = 1000.00 AND credit_amount = 0
  FROM public.ledger_postings
  WHERE source_id = '00000000-0000-0000-0000-00000000b001' AND grootboekrekening_id = '00000000-0000-0000-0000-00000000f001'
$$);
SELECT proof.expect_true('5', 'de creditregel staat als credit in het grootboek', $$
  SELECT credit_amount = 1000.00 AND debit_amount = 0
  FROM public.ledger_postings
  WHERE source_id = '00000000-0000-0000-0000-00000000b001' AND grootboekrekening_id = '00000000-0000-0000-0000-00000000f002'
$$);

-- 14 EUR literal ────────────────────────────────────────────────────────────
SELECT proof.expect_true('14', 'valuta is altijd EUR', $$
  SELECT bool_and(currency = 'EUR') FROM public.ledger_postings WHERE source_type = 'opening_balance'
$$);

-- 34 marker fields correct ──────────────────────────────────────────────────
SELECT proof.expect_true('34', 'de claim legt groep, boekjaar, datum, regelaantal, totaal en gebruiker vast', $$
  SELECT m.posting_group_id = (SELECT DISTINCT posting_group_id FROM public.ledger_postings WHERE source_id = m.opening_balance_id)
     AND m.boekjaar = 2027 AND m.opening_date = DATE '2027-01-01'
     AND m.line_count = 2 AND m.total_amount = 1000.00
     AND m.user_id = '00000000-0000-0000-0000-0000000000e1'
     AND m.client_id = '00000000-0000-0000-0000-0000000000c1'
  FROM public.opening_balance_postings m WHERE m.opening_balance_id = '00000000-0000-0000-0000-00000000b001'
$$);

-- 15 duplicate post refused ─────────────────────────────────────────────────
SELECT proof.expect_error('15', 'dezelfde beginbalans kan niet twee keer worden geboekt',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b001')$$,
  'Deze beginbalans is al geboekt');

-- 17 second effective opening balance for the same administratie refused ────
SELECT proof.draft('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-0000000000c1', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-00000000f001', 5.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-00000000f002', 0, 5.00, 2);
SELECT proof.expect_error('17', 'een tweede beginbalans voor dezelfde administratie wordt geweigerd',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b002')$$,
  'al een geboekte beginbalans');

-- 25 posted state immutable ─────────────────────────────────────────────────
SELECT proof.expect_error('25a', 'een geboekte kop kan niet worden gewijzigd',
  $$UPDATE public.opening_balances SET description = 'anders' WHERE id = '00000000-0000-0000-0000-00000000b001'$$,
  'vastgelegd');
SELECT proof.expect_error('25b', 'een geboekte kop kan niet worden verwijderd',
  $$DELETE FROM public.opening_balances WHERE id = '00000000-0000-0000-0000-00000000b001'$$,
  'geboekt');
SELECT proof.expect_error('25c', 'regels van een geboekte beginbalans kunnen niet worden gewijzigd',
  $$UPDATE public.opening_balance_lines SET debit_amount = 2.00 WHERE opening_balance_id = '00000000-0000-0000-0000-00000000b001'$$,
  'vastgelegd');
SELECT proof.expect_error('25d', 'regels van een geboekte beginbalans kunnen niet worden verwijderd',
  $$DELETE FROM public.opening_balance_lines WHERE opening_balance_id = '00000000-0000-0000-0000-00000000b001'$$,
  'vastgelegd');
SELECT proof.expect_error('25e', 'save_opening_balance_lines weigert een geboekte beginbalans',
  $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-00000000b001', '[]'::jsonb)$$,
  'geboekt');

-- 26 posted + nil impossible ────────────────────────────────────────────────
SELECT proof.expect_error('26', 'na boeken is een nihil-verklaring onmogelijk',
  $$SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-00000000b002')$$,
  'al een geboekte beginbalans');

-- 28 direct ledger insert without a claim refused ───────────────────────────
SELECT proof.expect_error('28', 'een losse grootboekregel met deze bronsoort wordt geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id, source_line_id, user_id)
  VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f001', gen_random_uuid(), 1, DATE '2027-01-01', 2027, 1.00, 0, 'EUR',
    'opening_balance', gen_random_uuid(), gen_random_uuid(), '00000000-0000-0000-0000-0000000000e1')
$$, 'niet geboekt via de boekingsfunctie');

-- 29 a second ledger row for the same source line refused ───────────────────
-- 29a proves the partial index exists. It is belt-and-braces and unreachable
-- from outside the posting transaction: the marker's line_count equals the true
-- line count, so every line_no is taken, and a later transaction cannot append
-- to a committed group at all — the foundation's created_xact_id seal refuses
-- first. 29b proves that refusal.
SELECT proof.expect_true('29a', 'de partiële unieke index op (groep, bronregel) bestaat', $$
  SELECT count(*) = 1 FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'idx_ledger_postings_opening_balance_line'
    AND indexdef LIKE '%posting_group_id, source_line_id%'
    AND indexdef LIKE '%opening_balance%'
$$);
SELECT proof.expect_error('29b', 'dezelfde beginbalansregel kan niet twee keer in het grootboek staan', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id, source_line_id, user_id)
  SELECT lp.organization_id, lp.client_id, lp.grootboekrekening_id, lp.posting_group_id, 2,
         lp.posting_date, lp.boekjaar, lp.debit_amount, lp.credit_amount, 'EUR',
         'opening_balance', lp.source_id, lp.source_line_id, lp.user_id
  FROM public.ledger_postings lp
  WHERE lp.source_id = '00000000-0000-0000-0000-00000000b001' AND lp.line_no = 1
$$, 'al vastgelegd door een eerdere transactie');

-- 30 reversal_of_posting_id refused for this source ─────────────────────────
SELECT proof.expect_error('30', 'een tegenboeking mag deze bronsoort niet gebruiken', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id,
    source_line_id, reversal_of_posting_id, user_id)
  SELECT lp.organization_id, lp.client_id, lp.grootboekrekening_id, gen_random_uuid(), 1,
         lp.posting_date, lp.boekjaar, 0, lp.debit_amount, 'EUR', 'opening_balance', lp.source_id,
         lp.source_line_id, lp.id, lp.user_id
  FROM public.ledger_postings lp
  WHERE lp.source_id = '00000000-0000-0000-0000-00000000b001' AND lp.line_no = 1
$$, 'tegenboeking gebruikt een eigen bronsoort');

-- 2 balanced many-line opening, 31/32/33 category-neutral, 35 line numbering ─
SELECT proof.draft('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-0000000000c2', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-00000000f001', 300.00, 0, 40);
SELECT proof.line('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-00000000f003', 0, 250.00, 30);
SELECT proof.line('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-00000000f004', 150.00, 0, 20);
SELECT proof.line('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-00000000f005', 0, 100.00, 10);
SELECT proof.line('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-00000000f006', 0, 100.00, 5);
SELECT proof.expect_ok('2', 'sluitende beginbalans van vijf regels wordt geboekt',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b003')$$);
SELECT proof.expect_true('2b', 'vijf grootboekregels, in balans', $$
  SELECT count(*) = 5 AND SUM(debit_amount) = 450.00 AND SUM(credit_amount) = 450.00
  FROM public.ledger_postings WHERE source_id = '00000000-0000-0000-0000-00000000b003'
$$);
SELECT proof.expect_true('31', 'omzet- en kostenrekeningen zijn toegestaan', $$
  SELECT count(*) = 2 FROM public.ledger_postings lp
  JOIN public.grootboekrekeningen g ON g.id = lp.grootboekrekening_id
  WHERE lp.source_id = '00000000-0000-0000-0000-00000000b003' AND g.categorie IN ('omzet', 'kosten')
$$);
SELECT proof.expect_true('32', 'een privé-rekening is toegestaan', $$
  SELECT count(*) = 1 FROM public.ledger_postings lp
  JOIN public.grootboekrekeningen g ON g.id = lp.grootboekrekening_id
  WHERE lp.source_id = '00000000-0000-0000-0000-00000000b003' AND g.categorie = 'privé'
$$);
SELECT proof.expect_true('33', 'een onbekende categorie (vrije tekst) is toegestaan', $$
  SELECT count(*) = 1 FROM public.ledger_postings lp
  JOIN public.grootboekrekeningen g ON g.id = lp.grootboekrekening_id
  WHERE lp.source_id = '00000000-0000-0000-0000-00000000b003' AND g.categorie = 'iets anders'
$$);
SELECT proof.expect_true('35', 'regelnummering volgt sort_order, id — deterministisch 1..n', $$
  SELECT array_agg(lp.line_no ORDER BY l.sort_order, l.id) = ARRAY[1,2,3,4,5]
     AND array_agg(DISTINCT lp.line_no) = ARRAY[1,2,3,4,5]
  FROM public.ledger_postings lp
  JOIN public.opening_balance_lines l ON l.id = lp.source_line_id
  WHERE lp.source_id = '00000000-0000-0000-0000-00000000b003'
$$);

-- 3 unbalanced refused, with both totals and the difference in the message ──
SELECT proof.draft('00000000-0000-0000-0000-00000000b004', '00000000-0000-0000-0000-0000000000c4', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b004', '00000000-0000-0000-0000-00000000f001', 100.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000b004', '00000000-0000-0000-0000-00000000f002', 0, 60.00, 2);
SELECT proof.expect_error('3', 'een niet-sluitende beginbalans wordt geweigerd met debet, credit en verschil',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b004')$$,
  'niet in balans: debet 100.00 is ongelijk aan credit 60.00 (verschil 40.00)');
SELECT proof.expect_true('3b', 'na de weigering bestaat er geen claim en geen grootboekregel', $$
  SELECT NOT EXISTS (SELECT 1 FROM public.opening_balance_postings WHERE opening_balance_id = '00000000-0000-0000-0000-00000000b004')
     AND NOT EXISTS (SELECT 1 FROM public.ledger_postings WHERE source_id = '00000000-0000-0000-0000-00000000b004')
$$);

-- 6 0/0 draft allowed, posting refused ──────────────────────────────────────
SELECT proof.expect_ok('6a', 'een concept mag een regel zonder bedrag bevatten',
  $$SELECT proof.line('00000000-0000-0000-0000-00000000b004', '00000000-0000-0000-0000-00000000f003', 0, 0, 3)$$);
SELECT proof.expect_error('6b', 'boeken met een regel zonder bedrag wordt geweigerd',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b004')$$,
  'zonder bedrag');

-- 7/8/9 both sides, negative and NaN refused at table level and in the save RPC
SELECT proof.expect_error('7a', 'een regel kan niet tegelijk debet en credit zijn (tabelcontrole)',
  $$SELECT proof.line('00000000-0000-0000-0000-00000000b004', '00000000-0000-0000-0000-00000000f003', 5, 5, 4)$$,
  'single_side');
SELECT proof.expect_error('7b', 'save_opening_balance_lines weigert een dubbelzijdige regel',
  $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-00000000b004',
    '[{"grootboekrekening_id":"00000000-0000-0000-0000-00000000f001","debit_amount":5,"credit_amount":5}]'::jsonb)$$,
  'tegelijk debet en credit');
SELECT proof.expect_error('8a', 'een negatief bedrag wordt geweigerd (tabelcontrole)',
  $$SELECT proof.line('00000000-0000-0000-0000-00000000b004', '00000000-0000-0000-0000-00000000f003', -5, 0, 4)$$,
  'debit_amount_check');
SELECT proof.expect_error('8b', 'save_opening_balance_lines weigert een negatief bedrag',
  $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-00000000b004',
    '[{"grootboekrekening_id":"00000000-0000-0000-0000-00000000f001","debit_amount":-5}]'::jsonb)$$,
  'negatieve bedragen');
SELECT proof.expect_error('9a', 'NaN wordt geweigerd (tabelcontrole)',
  $$SELECT proof.line('00000000-0000-0000-0000-00000000b004', '00000000-0000-0000-0000-00000000f003', 'NaN'::numeric, 0, 4)$$,
  'no_nan');
SELECT proof.expect_error('9b', 'save_opening_balance_lines weigert NaN',
  $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-00000000b004',
    '[{"grootboekrekening_id":"00000000-0000-0000-0000-00000000f001","debit_amount":"NaN"}]'::jsonb)$$,
  'moeten getallen zijn');
SELECT proof.expect_error('9c', 'save_opening_balance_lines weigert meer dan twee decimalen',
  $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-00000000b004',
    '[{"grootboekrekening_id":"00000000-0000-0000-0000-00000000f001","debit_amount":1.005}]'::jsonb)$$,
  'twee decimalen');

-- 10 inactive account refused ───────────────────────────────────────────────
SELECT proof.draft('00000000-0000-0000-0000-00000000b005', '00000000-0000-0000-0000-0000000000c5', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b005', '00000000-0000-0000-0000-00000000f007', 10.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000b005', '00000000-0000-0000-0000-00000000f002', 0, 10.00, 2);
SELECT proof.expect_error('10', 'boeken op een niet-actieve rekening wordt geweigerd',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b005')$$,
  'niet-actieve grootboekrekening (9100)');

-- 11 account of another administratie refused ───────────────────────────────
SELECT proof.expect_ok('11a', 'vervang de regels door een rekening van een andere administratie',
  $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-00000000b005',
    '[{"grootboekrekening_id":"00000000-0000-0000-0000-00000000f008","debit_amount":10},
      {"grootboekrekening_id":"00000000-0000-0000-0000-00000000f002","credit_amount":10}]'::jsonb)$$);
SELECT proof.expect_error('11', 'een rekening van een andere administratie wordt geweigerd',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b005')$$,
  'buiten deze organisatie of van een andere administratie');

-- 12 account of another organisation refused ────────────────────────────────
SELECT proof.expect_ok('12a', 'vervang de regels door een rekening van een andere organisatie',
  $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-00000000b005',
    '[{"grootboekrekening_id":"00000000-0000-0000-0000-00000000f009","debit_amount":10},
      {"grootboekrekening_id":"00000000-0000-0000-0000-00000000f002","credit_amount":10}]'::jsonb)$$);
SELECT proof.expect_error('12', 'een rekening van een andere organisatie wordt geweigerd',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b005')$$,
  'buiten deze organisatie of van een andere administratie');

-- 13 tenant misuse: an accountant of another organisation may not post ──────
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e4', false);
SELECT proof.expect_error('13a', 'een accountant van een andere organisatie mag niet boeken',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b003')$$,
  'Geen rechten');
SELECT proof.expect_error('13b', 'een accountant van een andere organisatie mag niet op nihil verklaren',
  $$SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-00000000b004')$$,
  'Geen rechten');
SELECT proof.expect_true('13c', 'RLS verbergt de beginbalans van een andere organisatie',
  $$SELECT count(*) = 0 FROM public.opening_balances WHERE client_id = '00000000-0000-0000-0000-0000000000c1'$$);
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- 18 closed year refused ────────────────────────────────────────────────────
SELECT proof.draft('00000000-0000-0000-0000-00000000b006', '00000000-0000-0000-0000-0000000000c3', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b006', '00000000-0000-0000-0000-00000000f001', 10.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000b006', '00000000-0000-0000-0000-00000000f002', 0, 10.00, 2);
SELECT proof.expect_error('18a', 'boeken in een afgesloten boekjaar wordt geweigerd',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b006')$$,
  'Boekjaar 2027 is afgesloten');
SELECT proof.draft('00000000-0000-0000-0000-00000000b013', '00000000-0000-0000-0000-0000000000c3', DATE '2027-01-01');
SELECT proof.expect_error('18b', 'een nihil-verklaring in een afgesloten boekjaar wordt geweigerd',
  $$SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-00000000b013')$$,
  'Boekjaar 2027 is afgesloten');

-- 19 an earlier ledger posting refuses the opening balance ──────────────────
-- Klant 6 gets a memoriaal-like posting on 2026-12-31 through the ledger
-- directly (a second source is not needed to prove the rule).
SELECT proof.expect_ok('19a', 'er staat al een boeking vóór de openingsdatum', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, user_id)
  SELECT '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c6', g, gid, n,
         DATE '2026-12-31', 2026, d, c, 'EUR', 'proof_seed', '00000000-0000-0000-0000-0000000000e1'
  FROM (VALUES
    ('00000000-0000-0000-0000-00000000f001'::uuid, 1, 7.00::numeric, 0::numeric),
    ('00000000-0000-0000-0000-00000000f002'::uuid, 2, 0::numeric, 7.00::numeric)
  ) AS v(g, n, d, c), (SELECT '00000000-0000-0000-0000-0000000099f1'::uuid AS gid) AS grp
$$);
SELECT proof.draft('00000000-0000-0000-0000-00000000b007', '00000000-0000-0000-0000-0000000000c6', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b007', '00000000-0000-0000-0000-00000000f001', 10.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000b007', '00000000-0000-0000-0000-00000000f002', 0, 10.00, 2);
SELECT proof.expect_error('19', 'een beginbalans na bestaande boekingen wordt geweigerd',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b007')$$,
  'moet het eerste feit zijn');

-- 20 boekjaar/date mismatch refused ─────────────────────────────────────────
SELECT proof.expect_error('20', 'een boekjaar dat niet bij de openingsdatum hoort wordt geweigerd',
  $$SELECT proof.draft('00000000-0000-0000-0000-00000000b008', '00000000-0000-0000-0000-0000000000c7', DATE '2027-01-01', 2026)$$,
  'boekjaar_matches_date');

-- 21 mid-year cutover accepted ──────────────────────────────────────────────
SELECT proof.draft('00000000-0000-0000-0000-00000000b009', '00000000-0000-0000-0000-0000000000c7', DATE '2027-07-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b009', '00000000-0000-0000-0000-00000000f001', 20.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000b009', '00000000-0000-0000-0000-00000000f003', 0, 20.00, 2);
SELECT proof.expect_ok('21', 'een beginbalans halverwege het jaar wordt geboekt',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b009')$$);
SELECT proof.expect_true('21b', 'de boekingsdatum en het boekjaar staan zoals vastgelegd', $$
  SELECT bool_and(posting_date = DATE '2027-07-01' AND boekjaar = 2027)
  FROM public.ledger_postings WHERE source_id = '00000000-0000-0000-0000-00000000b009'
$$);

-- 22 nil declaration with lines refused ─────────────────────────────────────
SELECT proof.draft('00000000-0000-0000-0000-00000000b010', '00000000-0000-0000-0000-0000000000c8', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b010', '00000000-0000-0000-0000-00000000f001', 1.00, 0, 1);
SELECT proof.expect_error('22', 'een nihil-verklaring met regels wordt geweigerd',
  $$SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-00000000b010')$$,
  'verwijder ze eerst');

-- 23 nil declaration writes no marker and no ledger row ─────────────────────
SELECT proof.expect_ok('23a', 'verwijder de regels van het concept',
  $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-00000000b010', '[]'::jsonb)$$);
SELECT proof.expect_ok('23b', 'de nihil-verklaring wordt vastgelegd',
  $$SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-00000000b010')$$);
SELECT proof.expect_true('23', 'nihil schrijft geen claim en geen grootboekregel, en legt wie en wanneer vast', $$
  SELECT ob.nil_declaration
     AND ob.nil_declared_at IS NOT NULL
     AND ob.nil_declared_by = '00000000-0000-0000-0000-0000000000e1'
     AND NOT EXISTS (SELECT 1 FROM public.opening_balance_postings WHERE client_id = ob.client_id)
     AND NOT EXISTS (SELECT 1 FROM public.ledger_postings WHERE client_id = ob.client_id)
  FROM public.opening_balances ob WHERE ob.id = '00000000-0000-0000-0000-00000000b010'
$$);

-- 24 nil state immutable ────────────────────────────────────────────────────
SELECT proof.expect_error('24a', 'een nihil-verklaarde kop kan niet worden gewijzigd',
  $$UPDATE public.opening_balances SET description = 'anders' WHERE id = '00000000-0000-0000-0000-00000000b010'$$,
  'vastgelegd');
SELECT proof.expect_error('24b', 'een nihil-verklaring kan niet worden ingetrokken', $$
  UPDATE public.opening_balances SET nil_declaration = false, nil_declared_at = NULL, nil_declared_by = NULL
  WHERE id = '00000000-0000-0000-0000-00000000b010'$$,
  'permission denied');
SELECT proof.expect_error('24c', 'een nihil-verklaarde kop kan niet worden verwijderd',
  $$DELETE FROM public.opening_balances WHERE id = '00000000-0000-0000-0000-00000000b010'$$,
  'nihil verklaard');
SELECT proof.expect_error('24d', 'aan een nihil-verklaarde beginbalans kunnen geen regels worden toegevoegd',
  $$SELECT proof.line('00000000-0000-0000-0000-00000000b010', '00000000-0000-0000-0000-00000000f001', 1.00, 0, 1)$$,
  'vastgelegd');
SELECT proof.expect_error('24e', 'save_opening_balance_lines weigert een nihil-verklaarde beginbalans',
  $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-00000000b010', '[]'::jsonb)$$,
  'nihil verklaard');
SELECT proof.expect_error('24f', 'een tweede nihil-verklaring op dezelfde kop wordt geweigerd',
  $$SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-00000000b010')$$,
  'al op nihil verklaard');

-- 27 nil + post impossible ──────────────────────────────────────────────────
SELECT proof.draft('00000000-0000-0000-0000-00000000b011', '00000000-0000-0000-0000-0000000000c8', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b011', '00000000-0000-0000-0000-00000000f001', 3.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000b011', '00000000-0000-0000-0000-00000000f002', 0, 3.00, 2);
SELECT proof.expect_error('27a', 'na een nihil-verklaring kan een andere beginbalans van dezelfde administratie niet worden geboekt',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b011')$$,
  'nihil-verklaring');
SELECT proof.expect_error('27b', 'een tweede nihil-verklaring voor dezelfde administratie wordt geweigerd',
  $$SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-00000000b011')$$,
  'al een nihil-verklaring');

-- 36 assistant may draft but not post, 38 anonymous refused ─────────────────
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);
SELECT proof.expect_ok('36a', 'een assistent mag een concept aanmaken', $$
  INSERT INTO public.opening_balances (id, organization_id, client_id, user_id, boekjaar, opening_date, description)
  VALUES ('00000000-0000-0000-0000-00000000b012', '00000000-0000-0000-0000-0000000000a1',
          '00000000-0000-0000-0000-0000000000ca', '00000000-0000-0000-0000-0000000000e2', 2028, DATE '2028-01-01', 'Concept')
$$);
SELECT proof.expect_ok('36b', 'een assistent mag regels opslaan',
  $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-00000000b012',
    '[{"grootboekrekening_id":"00000000-0000-0000-0000-00000000f001","debit_amount":4},
      {"grootboekrekening_id":"00000000-0000-0000-0000-00000000f002","credit_amount":4}]'::jsonb)$$);
SELECT proof.expect_error('36c', 'een assistent mag niet boeken',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b012')$$,
  'accountant vereist');
SELECT proof.expect_error('36d', 'een assistent mag niet op nihil verklaren',
  $$SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-00000000b012')$$,
  'accountant vereist');
SELECT proof.expect_error('36e', 'een assistent kan de nihil-kolommen niet zelf zetten',
  $$UPDATE public.opening_balances SET nil_declaration = true WHERE id = '00000000-0000-0000-0000-00000000b012'$$,
  'permission denied');

SELECT set_config('test.user_id', '', false);
SELECT proof.expect_error('38a', 'zonder ingelogde gebruiker wordt boeken geweigerd',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b012')$$,
  'Niet ingelogd');
SELECT proof.expect_error('38b', 'zonder ingelogde gebruiker wordt een nihil-verklaring geweigerd',
  $$SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-00000000b012')$$,
  'Niet ingelogd');
SELECT proof.expect_error('38c', 'zonder ingelogde gebruiker worden regels niet opgeslagen',
  $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-00000000b012', '[]'::jsonb)$$,
  'Niet ingelogd');
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- 37 accountant may post (the same draft an assistant prepared) ─────────────
SELECT proof.expect_ok('37', 'een accountant boekt het concept van de assistent',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b012')$$);

-- 39 rollback leaves no marker and no ledger rows ───────────────────────────
SELECT proof.draft('00000000-0000-0000-0000-00000000b014', '00000000-0000-0000-0000-0000000000cb', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b014', '00000000-0000-0000-0000-00000000f001', 12.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000b014', '00000000-0000-0000-0000-00000000f002', 0, 12.00, 2);
BEGIN;
SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b014');
ROLLBACK;
SELECT proof.expect_true('39', 'na een teruggedraaide transactie bestaat er geen claim en geen grootboekregel', $$
  SELECT NOT EXISTS (SELECT 1 FROM public.opening_balance_postings WHERE opening_balance_id = '00000000-0000-0000-0000-00000000b014')
     AND NOT EXISTS (SELECT 1 FROM public.ledger_postings WHERE source_id = '00000000-0000-0000-0000-00000000b014')
$$);
SELECT proof.expect_ok('39b', 'en de beginbalans kan daarna alsnog gewoon worden geboekt',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b014')$$);

-- S1 two drafts for one administratie may coexist ───────────────────────────
SELECT proof.draft('00000000-0000-0000-0000-00000000b015', '00000000-0000-0000-0000-0000000000cc', DATE '2027-01-01');
SELECT proof.expect_ok('S1', 'twee concepten voor één administratie mogen naast elkaar bestaan',
  $$SELECT proof.draft('00000000-0000-0000-0000-00000000b016', '00000000-0000-0000-0000-0000000000cc', DATE '2027-01-01')$$);

-- read_only may not write ───────────────────────────────────────────────────
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e3', false);
SELECT proof.expect_error('R1', 'een read_only-gebruiker kan geen concept aanmaken', $$
  INSERT INTO public.opening_balances (id, organization_id, client_id, user_id, boekjaar, opening_date, description)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c7',
          '00000000-0000-0000-0000-0000000000e3', 2029, DATE '2029-01-01', 'Nee')
$$, 'row-level security');
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- the marker table is read-only for the application ─────────────────────────
SELECT proof.expect_error('R2', 'de claimtabel is niet schrijfbaar voor de applicatie', $$
  INSERT INTO public.opening_balance_postings (opening_balance_id, posting_group_id, organization_id,
    client_id, boekjaar, opening_date, line_count, total_amount, user_id)
  VALUES (gen_random_uuid(), gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000c7', 2027, DATE '2027-01-01', 2, 1.00,
    '00000000-0000-0000-0000-0000000000e1')
$$, 'permission denied');
SELECT proof.expect_error('R3', 'een claim kan niet worden verwijderd door de applicatie',
  $$DELETE FROM public.opening_balance_postings WHERE opening_balance_id = '00000000-0000-0000-0000-00000000b001'$$,
  'permission denied');

RESET ROLE;
