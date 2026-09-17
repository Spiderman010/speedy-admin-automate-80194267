-- REAL POSTGRESQL CONCURRENCY PROOF for 6C-b8 PR 1 — throwaway cluster only.
--
-- Two genuinely concurrent sessions: this psql session (A) and a second backend
-- opened with dblink (B). A starts an assertion and holds its transaction open;
-- B is sent the competing statement asynchronously and blocks on the advisory
-- lock; A commits; B then proceeds and must be refused. The assertions are on
-- the INVARIANT ("exactly one"), which must hold whatever the timing does.
--
-- Session B connects as postgres, so it bypasses RLS; the role checks inside
-- the RPCs still run, because they read auth.uid() from the session GUC that is
-- set on that connection. This proves the locking and uniqueness, which is what
-- the scenario is about; RLS itself is proved in proof.sql.
--
-- Run after proof.sql (it writes into proof.result).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

-- Remote helper: run one statement on connection B and record the outcome.
CREATE OR REPLACE FUNCTION proof.remote_result(_n text, _name text, _conn text, _needle text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_msg text; v_dummy text;
BEGIN
  BEGIN
    SELECT x INTO v_dummy FROM dblink_get_result(_conn) AS t(x text);
    IF _needle = '' THEN
      INSERT INTO proof.result VALUES (_n, _name, true, format('tweede sessie slaagde: %s', v_dummy));
    ELSE
      INSERT INTO proof.result VALUES (_n, _name, false, 'tweede sessie slaagde, terwijl een weigering werd verwacht');
    END IF;
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
    RETURN;
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;
  IF _needle <> '' AND position(lower(_needle) IN lower(v_msg)) > 0 THEN
    INSERT INTO proof.result VALUES (_n, _name, true, v_msg);
  ELSE
    INSERT INTO proof.result VALUES (_n, _name, false, format('onverwachte uitkomst (verwacht: %s): %s', _needle, v_msg));
  END IF;

  -- Drain the failed async query, or the connection stays busy.
  BEGIN
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
  EXCEPTION WHEN others THEN
    NULL;
  END;
END
$$;

-- Fixtures for the concurrency scenarios. Each scenario gets its own
-- administratie so the scenarios cannot influence each other.
INSERT INTO public.clients (id, organization_id, name) VALUES
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Race 1'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Race 2'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', 'Race 3'),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a1', 'Race 4'),
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000a1', 'Race 5'),
  ('00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-0000000000a1', 'Race 6'),
  ('00000000-0000-0000-0000-0000000000d7', '00000000-0000-0000-0000-0000000000a1', 'Race 7'),
  ('00000000-0000-0000-0000-0000000000d8', '00000000-0000-0000-0000-0000000000a1', 'Race 8'),
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000a1', 'Race 9'),
  ('00000000-0000-0000-0000-0000000000da', '00000000-0000-0000-0000-0000000000a1', 'Race 10');

SELECT proof.draft('00000000-0000-0000-0000-000000000ab1', '00000000-0000-0000-0000-0000000000d1', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-000000000ab1', '00000000-0000-0000-0000-00000000f001', 10.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-000000000ab1', '00000000-0000-0000-0000-00000000f002', 0, 10.00, 2);
SELECT proof.draft('00000000-0000-0000-0000-000000000ab2', '00000000-0000-0000-0000-0000000000d1', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-000000000ab2', '00000000-0000-0000-0000-00000000f001', 20.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-000000000ab2', '00000000-0000-0000-0000-00000000f002', 0, 20.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-000000000ab3', '00000000-0000-0000-0000-0000000000d2', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-000000000ab3', '00000000-0000-0000-0000-00000000f001', 30.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-000000000ab3', '00000000-0000-0000-0000-00000000f002', 0, 30.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-000000000ab4', '00000000-0000-0000-0000-0000000000d3', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-000000000ab4', '00000000-0000-0000-0000-00000000f001', 40.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-000000000ab4', '00000000-0000-0000-0000-00000000f002', 0, 40.00, 2);
SELECT proof.draft('00000000-0000-0000-0000-000000000ab5', '00000000-0000-0000-0000-0000000000d3', DATE '2027-01-01');

SELECT proof.draft('00000000-0000-0000-0000-000000000ab6', '00000000-0000-0000-0000-0000000000d4', DATE '2027-01-01');
SELECT proof.draft('00000000-0000-0000-0000-000000000ab7', '00000000-0000-0000-0000-0000000000d4', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-000000000ab7', '00000000-0000-0000-0000-00000000f001', 50.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-000000000ab7', '00000000-0000-0000-0000-00000000f002', 0, 50.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-000000000ab8', '00000000-0000-0000-0000-0000000000d5', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-000000000ab8', '00000000-0000-0000-0000-00000000f001', 60.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-000000000ab8', '00000000-0000-0000-0000-00000000f002', 0, 60.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-000000000ab9', '00000000-0000-0000-0000-0000000000d6', DATE '2027-01-01');

-- C43: de kop wordt onder de wachtende boeker vandaan verwisseld.
SELECT proof.draft('00000000-0000-0000-0000-000000000aba', '00000000-0000-0000-0000-0000000000d7', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-000000000aba', '00000000-0000-0000-0000-00000000f001', 70.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-000000000aba', '00000000-0000-0000-0000-00000000f002', 0, 70.00, 2);

-- C44: losse regel-INSERT tegen een lopende boeking.
SELECT proof.draft('00000000-0000-0000-0000-000000000abb', '00000000-0000-0000-0000-0000000000d9', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-000000000abb', '00000000-0000-0000-0000-00000000f001', 80.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-000000000abb', '00000000-0000-0000-0000-00000000f002', 0, 80.00, 2);

-- C45: regels opslaan en dan boeken.
SELECT proof.draft('00000000-0000-0000-0000-000000000abc', '00000000-0000-0000-0000-0000000000da', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-000000000abc', '00000000-0000-0000-0000-00000000f001', 1.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-000000000abc', '00000000-0000-0000-0000-00000000f002', 0, 1.00, 2);

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- ── C16a: two posts of DIFFERENT headers of the same administratie ──────────

SELECT dblink_connect('b', :'conn');
SELECT * FROM dblink('b', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$) AS t(x text);
SELECT dblink_exec('b', 'BEGIN');

BEGIN;
SELECT public.post_opening_balance('00000000-0000-0000-0000-000000000ab1');
SELECT dblink_send_query('b', $$SELECT public.post_opening_balance('00000000-0000-0000-0000-000000000ab2')::text$$);
SELECT pg_sleep(0.4);
COMMIT;

SELECT proof.remote_result('16a', 'gelijktijdig boeken van twee beginbalansen van één administratie: de tweede wordt geweigerd',
  'b', 'al een geboekte beginbalans');
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.expect_true('16a2', 'precies één geboekte beginbalans voor deze administratie', $$
  SELECT count(*) = 1 FROM public.opening_balance_postings WHERE client_id = '00000000-0000-0000-0000-0000000000d1'
$$);

-- ── C16b: two posts of the SAME header ──────────────────────────────────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.post_opening_balance('00000000-0000-0000-0000-000000000ab3');
SELECT dblink_send_query('b', $$SELECT public.post_opening_balance('00000000-0000-0000-0000-000000000ab3')::text$$);
SELECT pg_sleep(0.4);
COMMIT;

SELECT proof.remote_result('16b', 'gelijktijdig twee keer dezelfde beginbalans boeken: de tweede wordt geweigerd',
  'b', 'al geboekt');
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.expect_true('16b2', 'precies één boekingsgroep en twee grootboekregels', $$
  SELECT count(*) = 2 AND count(DISTINCT posting_group_id) = 1
  FROM public.ledger_postings WHERE source_id = '00000000-0000-0000-0000-000000000ab3'
$$);

-- ── C40a: post (A) versus nil declaration (B) ───────────────────────────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.post_opening_balance('00000000-0000-0000-0000-000000000ab4');
SELECT dblink_send_query('b', $$SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-000000000ab5')::text$$);
SELECT pg_sleep(0.4);
COMMIT;

SELECT proof.remote_result('40a', 'gelijktijdig boeken en op nihil verklaren: de nihil-verklaring wordt geweigerd',
  'b', 'al een geboekte beginbalans');
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.expect_true('40a2', 'de administratie heeft precies één bewering: geboekt, niet nihil', $$
  SELECT (SELECT count(*) FROM public.opening_balance_postings WHERE client_id = '00000000-0000-0000-0000-0000000000d3') = 1
     AND (SELECT count(*) FROM public.opening_balances WHERE client_id = '00000000-0000-0000-0000-0000000000d3' AND nil_declared_at IS NOT NULL) = 0
$$);

-- ── C40b: nil declaration (A) versus post (B) — the reverse order ───────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-000000000ab6');
SELECT dblink_send_query('b', $$SELECT public.post_opening_balance('00000000-0000-0000-0000-000000000ab7')::text$$);
SELECT pg_sleep(0.4);
COMMIT;

SELECT proof.remote_result('40b', 'gelijktijdig op nihil verklaren en boeken: het boeken wordt geweigerd',
  'b', 'nihil-verklaring');
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.expect_true('40b2', 'de administratie heeft precies één bewering: nihil, niet geboekt', $$
  SELECT (SELECT count(*) FROM public.opening_balance_postings WHERE client_id = '00000000-0000-0000-0000-0000000000d4') = 0
     AND (SELECT count(*) FROM public.opening_balances WHERE client_id = '00000000-0000-0000-0000-0000000000d4' AND nil_declared_at IS NOT NULL) = 1
$$);

-- ── C41: post (A) versus save_opening_balance_lines (B) on the same header ──

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.post_opening_balance('00000000-0000-0000-0000-000000000ab8');
SELECT dblink_send_query('b', $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-000000000ab8',
  '[{"grootboekrekening_id":"00000000-0000-0000-0000-00000000f001","debit_amount":999}]'::jsonb)::text$$);
SELECT pg_sleep(0.4);
COMMIT;

SELECT proof.remote_result('41', 'gelijktijdig boeken en regels opslaan: het opslaan wordt geweigerd',
  'b', 'geboekt');
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.expect_true('41b', 'de geboekte regels zijn onveranderd', $$
  SELECT count(*) = 2 AND SUM(debit_amount) = 60.00
  FROM public.ledger_postings WHERE source_id = '00000000-0000-0000-0000-000000000ab8'
$$);

-- ── C42: nil declaration (A) versus save_opening_balance_lines (B) ──────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.declare_opening_balance_nil('00000000-0000-0000-0000-000000000ab9');
SELECT dblink_send_query('b', $$SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-000000000ab9',
  '[{"grootboekrekening_id":"00000000-0000-0000-0000-00000000f001","debit_amount":5},
    {"grootboekrekening_id":"00000000-0000-0000-0000-00000000f002","credit_amount":5}]'::jsonb)::text$$);
SELECT pg_sleep(0.4);
COMMIT;

SELECT proof.remote_result('42', 'gelijktijdig op nihil verklaren en regels opslaan: het opslaan wordt geweigerd',
  'b', 'nihil verklaard');
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.expect_true('42b', 'de nihil-verklaarde beginbalans heeft nog steeds geen regels', $$
  SELECT count(*) = 0 FROM public.opening_balance_lines WHERE opening_balance_id = '00000000-0000-0000-0000-000000000ab9'
$$);

-- ── C43: de advisory lock moet de administratie dekken die werkelijk wordt
--        geschreven. Drie sessies: C houdt de grendel van administratie 7,
--        B wil daar boeken en wacht, en A verwisselt intussen de kop naar
--        administratie 8. Zonder de hercontrole na LOCK 1 zou B committen voor
--        een administratie waarvan de grendel bij iemand anders ligt.

SELECT dblink_connect('c', :'conn');
SELECT * FROM dblink('c', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$) AS t(x text);
SELECT dblink_exec('c', 'BEGIN');
SELECT * FROM dblink('c', $$SELECT pg_advisory_xact_lock(6118, public.opening_balance_client_lock_key('00000000-0000-0000-0000-0000000000d7'))::text$$) AS t(x text);

SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$SELECT public.post_opening_balance('00000000-0000-0000-0000-000000000aba')::text$$);
SELECT pg_sleep(0.4);

-- A verwisselt de kop: zelfde id, andere administratie.
DELETE FROM public.opening_balance_lines WHERE opening_balance_id = '00000000-0000-0000-0000-000000000aba';
DELETE FROM public.opening_balances WHERE id = '00000000-0000-0000-0000-000000000aba';
SELECT proof.draft('00000000-0000-0000-0000-000000000aba', '00000000-0000-0000-0000-0000000000d8', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-000000000aba', '00000000-0000-0000-0000-00000000f001', 70.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-000000000aba', '00000000-0000-0000-0000-00000000f002', 0, 70.00, 2);

SELECT dblink_exec('c', 'ROLLBACK');   -- grendel van administratie 7 los; B loopt door

SELECT proof.remote_result('43', 'een kop die onder de wachtende boeker is verwisseld, wordt niet geboekt',
  'b', 'tussentijds gewijzigd');
-- COMMIT, niet ROLLBACK: als de tweede sessie tóch had geboekt, moet die
-- boeking blijven staan, zodat 43b hem ziet. (Op een afgebroken transactie is
-- COMMIT een rollback, dus na een terechte weigering verandert er niets.)
SELECT dblink_exec('b', 'COMMIT');
SELECT proof.expect_true('43b', 'er is niets geboekt voor de administratie waarvan de grendel niet werd gehouden', $$
  SELECT (SELECT count(*) FROM public.opening_balance_postings WHERE client_id = '00000000-0000-0000-0000-0000000000d8') = 0
     AND (SELECT count(*) FROM public.opening_balance_postings WHERE client_id = '00000000-0000-0000-0000-0000000000d7') = 0
$$);
SELECT dblink_disconnect('c');

-- ── C44: een losse regel-INSERT die tegen een lopende boeking aanloopt. De
--        bevriezingstrigger grendelt bij INSERT eerst de kop (FOR KEY SHARE),
--        dus de regel kan nooit ná de boeking alsnog binnenkomen.

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.post_opening_balance('00000000-0000-0000-0000-000000000abb');
SELECT dblink_send_query('b', $$INSERT INTO public.opening_balance_lines
  (opening_balance_id, organization_id, client_id, user_id, grootboekrekening_id, debit_amount, sort_order)
  VALUES ('00000000-0000-0000-0000-000000000abb', '00000000-0000-0000-0000-0000000000a1',
          '00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000e1',
          '00000000-0000-0000-0000-00000000f001', 5, 9)$$);
SELECT pg_sleep(0.4);
COMMIT;

SELECT proof.remote_result('44r', 'een losse regel kan niet ná een gelijktijdige boeking binnenkomen',
  'b', 'vastgelegd');
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.expect_true('44r2', 'de geboekte groep telt nog steeds twee regels', $$
  SELECT count(*) = 2 AND SUM(debit_amount) = 80.00
  FROM public.ledger_postings WHERE source_id = '00000000-0000-0000-0000-000000000abb'
$$);

-- ── C45: de andere richting van de kopgrendel — eerst opslaan, dan boeken.
--        De boeker wacht op LOCK 1 en leest daarna de vastgelegde NIEUWE regels.

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.save_opening_balance_lines('00000000-0000-0000-0000-000000000abc',
  '[{"grootboekrekening_id":"00000000-0000-0000-0000-00000000f001","debit_amount":90},
    {"grootboekrekening_id":"00000000-0000-0000-0000-00000000f002","credit_amount":90}]'::jsonb);
SELECT dblink_send_query('b', $$SELECT public.post_opening_balance('00000000-0000-0000-0000-000000000abc')::text$$);
SELECT pg_sleep(0.4);
COMMIT;

SELECT proof.remote_result('45r', 'boeken ná een gelijktijdige opslag slaagt', 'b', '');
SELECT dblink_exec('b', 'COMMIT');
SELECT proof.expect_true('45r2', 'en het geboekte bedrag is de NIEUWE regelset, niet de oude', $$
  SELECT count(*) = 2 AND SUM(debit_amount) = 90.00 AND SUM(credit_amount) = 90.00
  FROM public.ledger_postings WHERE source_id = '00000000-0000-0000-0000-000000000abc'
$$);

SELECT dblink_disconnect('b');
