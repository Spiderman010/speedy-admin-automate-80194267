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

-- Proof F baseline: PostgreSQL counts every deadlock it breaks. If ANY of the
-- scenarios below formed a cycle, this counter would move.
CREATE TABLE IF NOT EXISTS proof.deadlock_baseline AS
  SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();

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

-- A recorder that survives a ROLLBACK of the session it is called from: some
-- scenarios must assert something WHILE holding a transaction they then roll
-- back, and an ordinary INSERT into proof.result would be rolled back with it.
-- dblink_exec on a connection without an open transaction commits on its own.
CREATE OR REPLACE FUNCTION proof.record_out_of_band(_conn text, _n text, _name text, _ok boolean, _detail text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dblink_exec(_conn, format(
    'INSERT INTO proof.result VALUES (%L, %L, %L, %L)', _n, _name, _ok, _detail));
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
SELECT * FROM dblink('c', $$SELECT pg_advisory_xact_lock(6118, public.ledger_client_lock_key('00000000-0000-0000-0000-0000000000d7'))::text$$) AS t(x text);

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

-- ═══════════════════════════════════════════════════════════════════════════
-- De kern van 6C-b8: "de beginbalans is het eerste feit" is een invariant, geen
-- momentopname. Elke grootboekschrijfactie neemt de per-administratie grendel,
-- dus de twee kanten worden echt geserialiseerd in plaats van alleen gelezen.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.clients (id, organization_id, name) VALUES
  ('00000000-0000-0000-0000-00000000cc01', '00000000-0000-0000-0000-0000000000a1', 'Eerste feit A'),
  ('00000000-0000-0000-0000-00000000cc02', '00000000-0000-0000-0000-0000000000a1', 'Eerste feit B'),
  ('00000000-0000-0000-0000-00000000cc03', '00000000-0000-0000-0000-0000000000a1', 'Eerste feit C'),
  ('00000000-0000-0000-0000-00000000cc04', '00000000-0000-0000-0000-0000000000a1', 'Eerste feit D'),
  ('00000000-0000-0000-0000-00000000cc05', '00000000-0000-0000-0000-0000000000a1', 'Eerste feit E'),
  ('00000000-0000-0000-0000-00000000cc06', '00000000-0000-0000-0000-0000000000a1', 'Los 1'),
  ('00000000-0000-0000-0000-00000000cc07', '00000000-0000-0000-0000-0000000000a1', 'Los 2'),
  ('00000000-0000-0000-0000-00000000cc08', '00000000-0000-0000-0000-0000000000a1', 'Rollback'),
  ('00000000-0000-0000-0000-00000000cc09', '00000000-0000-0000-0000-0000000000a1', 'Kruising');

-- Eén hulpfunctie zodat elke "gewone schrijver" in deze proeven er identiek
-- uitziet: twee sluitende regels, rechtstreeks in ledger_postings, met een
-- bronsoort van een bestaande schrijver.
CREATE OR REPLACE FUNCTION proof.ordinary_write(_client uuid, _date date, _amount numeric, _group uuid)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, user_id)
  SELECT '00000000-0000-0000-0000-0000000000a1', _client, g, _group, n,
         _date, EXTRACT(YEAR FROM _date)::integer, d, c, 'EUR', 'purchase_invoice',
         '00000000-0000-0000-0000-0000000000e1'
  FROM (VALUES
    ('00000000-0000-0000-0000-00000000f001'::uuid, 1, _amount, 0::numeric),
    ('00000000-0000-0000-0000-00000000f002'::uuid, 2, 0::numeric, _amount)
  ) AS v(g, n, d, c);
$$;
GRANT EXECUTE ON FUNCTION proof.ordinary_write(uuid, date, numeric, uuid) TO public;

SELECT proof.draft('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000cc01', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000f001', 100.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000f002', 0, 100.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-00000000bb02', '00000000-0000-0000-0000-00000000cc02', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000bb02', '00000000-0000-0000-0000-00000000f001', 100.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000bb02', '00000000-0000-0000-0000-00000000f002', 0, 100.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-00000000bb03', '00000000-0000-0000-0000-00000000cc03', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000bb03', '00000000-0000-0000-0000-00000000f001', 100.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000bb03', '00000000-0000-0000-0000-00000000f002', 0, 100.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-00000000bb04', '00000000-0000-0000-0000-00000000cc04', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000bb04', '00000000-0000-0000-0000-00000000f001', 100.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000bb04', '00000000-0000-0000-0000-00000000f002', 0, 100.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-00000000bb05', '00000000-0000-0000-0000-00000000cc05', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000bb05', '00000000-0000-0000-0000-00000000f001', 100.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000bb05', '00000000-0000-0000-0000-00000000f002', 0, 100.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-00000000bb06', '00000000-0000-0000-0000-00000000cc06', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000bb06', '00000000-0000-0000-0000-00000000f001', 100.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000bb06', '00000000-0000-0000-0000-00000000f002', 0, 100.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-00000000bb07', '00000000-0000-0000-0000-00000000cc07', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000bb07', '00000000-0000-0000-0000-00000000f001', 100.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000bb07', '00000000-0000-0000-0000-00000000f002', 0, 100.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-00000000bb08', '00000000-0000-0000-0000-00000000cc08', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000bb08', '00000000-0000-0000-0000-00000000f001', 100.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000bb08', '00000000-0000-0000-0000-00000000f002', 0, 100.00, 2);

SELECT proof.draft('00000000-0000-0000-0000-00000000bb09', '00000000-0000-0000-0000-00000000cc09', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000bb09', '00000000-0000-0000-0000-00000000f001', 100.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000bb09', '00000000-0000-0000-0000-00000000f002', 0, 100.00, 2);

-- ── A: de beginbalans begint eerst; een terugwerkende gewone boeking wacht op
--      de grendel en wordt daarna geweigerd. ───────────────────────────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000bb01');
SELECT dblink_send_query('b', $$SELECT proof.ordinary_write('00000000-0000-0000-0000-00000000cc01',
  DATE '2026-12-31', 50.00, '9a010000-0000-4000-8000-000000000001')::text$$);
SELECT pg_sleep(0.4);
-- De tweede sessie hangt hier aan de administratiegrendel, nog vóór haar
-- eerste rij: er is dus niets dat de beginbalans had kunnen missen.
SELECT proof.expect_true('A1', 'de terugwerkende schrijver wacht op de grendel en heeft nog niets geschreven', $$
  SELECT dblink_is_busy('b') = 1
$$);
COMMIT;

SELECT proof.remote_result('A2', 'na het committen van de beginbalans wordt de terugwerkende boeking geweigerd',
  'b', 'zou dubbel tellen');
SELECT dblink_exec('b', 'COMMIT');
SELECT proof.expect_true('A3', 'het grootboek bevat alleen de beginbalans', $$
  SELECT count(*) = 2 AND bool_and(source_type = 'opening_balance')
  FROM public.ledger_postings WHERE client_id = '00000000-0000-0000-0000-00000000cc01'
$$);

-- ── B: de terugwerkende gewone boeking begint eerst; de beginbalans wacht en
--      wordt daarna geweigerd. ───────────────────────────────────────────────

SELECT dblink_exec('b', 'BEGIN');
SELECT * FROM dblink('b', $$SELECT proof.ordinary_write('00000000-0000-0000-0000-00000000cc02',
  DATE '2026-12-31', 50.00, '9a020000-0000-4000-8000-000000000002')::text$$) AS t(x text);

-- De boeking van B is geschreven maar NIET gecommit; A ziet hem dus niet in
-- haar snapshot en moet toch geweigerd worden.
SELECT dblink_connect('c', :'conn');
SELECT * FROM dblink('c', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$) AS t(x text);
SELECT dblink_exec('c', 'BEGIN');
SELECT dblink_send_query('c', $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000bb02')::text$$);
SELECT pg_sleep(0.4);
SELECT proof.expect_true('B1', 'de beginbalans wacht op de grendel van de nog niet gecommitte boeking', $$
  SELECT dblink_is_busy('c') = 1
$$);
SELECT dblink_exec('b', 'COMMIT');

SELECT proof.remote_result('B2', 'na het committen van de terugwerkende boeking wordt de beginbalans geweigerd',
  'c', 'moet het eerste feit zijn');
SELECT dblink_exec('c', 'ROLLBACK');
SELECT proof.expect_true('B3', 'er is geen beginbalans geboekt voor deze administratie', $$
  SELECT count(*) = 0 FROM public.opening_balance_postings WHERE client_id = '00000000-0000-0000-0000-00000000cc02'
$$);
SELECT dblink_disconnect('c');

-- ── C: dezelfde twee races, maar de gewone schrijver is een RECHTSTREEKSE
--      INSERT die geen enkele schrijverfunctie passeert — het pad dat alleen de
--      grendels en triggers op ledger_postings zelf kunnen tegenhouden.
--
--      Deze INSERT draait als EIGENAAR, niet meer als `authenticated`. Sinds
--      20260920130000 heeft die rol geen INSERT-recht meer op ledger_postings,
--      dus als authenticated zou de poging al bij de rechtencontrole stranden en
--      zou de race nooit plaatsvinden — dan bewijst C niets over de grendel.
--      Als eigenaar blijft de race intact: de trigger en de rijgrendel zijn
--      precies wat hier wordt getoetst. ──────────────────────────────────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000bb03');
SELECT dblink_send_query('b', $$INSERT INTO public.ledger_postings (organization_id, client_id,
  grootboekrekening_id, posting_group_id, line_no, posting_date, boekjaar, debit_amount, credit_amount,
  currency, source_type, user_id)
  SELECT '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000cc03', g,
         '9a030000-0000-4000-8000-000000000003', n, DATE '2026-12-31', 2026, d, c, 'EUR',
         'purchase_invoice', '00000000-0000-0000-0000-0000000000e1'
  FROM (VALUES ('00000000-0000-0000-0000-00000000f001'::uuid, 1, 9.00::numeric, 0::numeric),
               ('00000000-0000-0000-0000-00000000f002'::uuid, 2, 0::numeric, 9.00::numeric)) AS v(g, n, d, c)$$);
SELECT pg_sleep(0.4);
SELECT proof.expect_true('C1', 'ook een rechtstreekse INSERT buiten de schrijvers om wacht op de grendel', $$
  SELECT dblink_is_busy('b') = 1
$$);
COMMIT;
SELECT proof.remote_result('C2', 'en wordt daarna geweigerd', 'b', 'zou dubbel tellen');
SELECT dblink_exec('b', 'ROLLBACK');
SELECT proof.expect_true('C3', 'het grootboek bevat alleen de beginbalans', $$
  SELECT count(*) = 2 AND bool_and(source_type = 'opening_balance')
  FROM public.ledger_postings WHERE client_id = '00000000-0000-0000-0000-00000000cc03'
$$);

-- C omgekeerd: rechtstreekse INSERT eerst, beginbalans wacht. Ook als eigenaar,
-- zie de toelichting bij C.
SELECT dblink_exec('b', 'BEGIN');
SELECT * FROM dblink('b', $$INSERT INTO public.ledger_postings (organization_id, client_id,
  grootboekrekening_id, posting_group_id, line_no, posting_date, boekjaar, debit_amount, credit_amount,
  currency, source_type, user_id)
  SELECT '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000cc04', g,
         '9a040000-0000-4000-8000-000000000004', n, DATE '2026-12-31', 2026, d, c, 'EUR',
         'purchase_invoice', '00000000-0000-0000-0000-0000000000e1'
  FROM (VALUES ('00000000-0000-0000-0000-00000000f001'::uuid, 1, 9.00::numeric, 0::numeric),
               ('00000000-0000-0000-0000-00000000f002'::uuid, 2, 0::numeric, 9.00::numeric)) AS v(g, n, d, c)
  RETURNING id::text$$) AS t(x text);
SELECT dblink_connect('c', :'conn');
SELECT * FROM dblink('c', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$) AS t(x text);
SELECT dblink_exec('c', 'BEGIN');
SELECT dblink_send_query('c', $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000bb04')::text$$);
SELECT pg_sleep(0.4);
SELECT proof.expect_true('C4', 'de beginbalans wacht op de rechtstreekse INSERT', $$SELECT dblink_is_busy('c') = 1$$);
SELECT dblink_exec('b', 'COMMIT');
SELECT proof.remote_result('C5', 'en wordt daarna geweigerd', 'c', 'moet het eerste feit zijn');
SELECT dblink_exec('c', 'ROLLBACK');
SELECT dblink_disconnect('c');

-- ── D: een gewone boeting NÁ de beginbalansdatum blijft gewoon werken. ──────

SELECT proof.expect_ok('D1', 'de beginbalans van deze administratie wordt geboekt',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000bb05')$$);
SELECT proof.expect_ok('D2', 'een gewone boeking ná de openingsdatum slaagt', $$
  SELECT proof.ordinary_write('00000000-0000-0000-0000-00000000cc05', DATE '2027-06-01', 25.00,
    '9a050000-0000-4000-8000-000000000005')
$$);
SELECT proof.expect_ok('D3', 'en een boeking op de openingsdatum zelf ook', $$
  SELECT proof.ordinary_write('00000000-0000-0000-0000-00000000cc05', DATE '2027-01-01', 25.00,
    '9a060000-0000-4000-8000-000000000006')
$$);
SELECT proof.expect_true('D4', 'alles staat in het grootboek', $$
  SELECT count(*) = 6 FROM public.ledger_postings WHERE client_id = '00000000-0000-0000-0000-00000000cc05'
$$);

-- ── E: twee losse administraties blokkeren elkaar niet, en binnen één
--      administratie blokkeren ze wél (anders zou de grendel niets doen). ────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
-- A houdt de grendel van administratie "Los 1".
SELECT public.lock_ledger_client('00000000-0000-0000-0000-00000000cc06');
SELECT dblink_send_query('b', $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000bb07')::text$$);
SELECT pg_sleep(0.5);
SELECT proof.expect_true('E1', 'een andere administratie loopt gewoon door terwijl deze grendel vastzit', $$
  SELECT dblink_is_busy('b') = 0
$$);
SELECT proof.remote_result('E2', 'en die boeking slaagt', 'b', '');
SELECT dblink_exec('b', 'COMMIT');

-- Positieve controle: dezelfde administratie blokkeert wél.
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000bb06')::text$$);
SELECT pg_sleep(0.4);
SELECT proof.expect_true('E3', 'dezelfde administratie wacht wél — de grendel doet echt iets', $$
  SELECT dblink_is_busy('b') = 1
$$);
COMMIT;
SELECT proof.remote_result('E4', 'en loopt door zodra de grendel vrijkomt', 'b', '');
SELECT dblink_exec('b', 'COMMIT');

-- ── G: een teruggedraaide eerste transactie geeft de grendel vrij en de
--      tweede herbeoordeelt correct — en slaagt, want er is niets gecommit. ──

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT proof.ordinary_write('00000000-0000-0000-0000-00000000cc08', DATE '2026-12-31', 5.00,
  '9a070000-0000-4000-8000-000000000007');
SELECT dblink_send_query('b', $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000bb08')::text$$);
SELECT pg_sleep(0.4);
-- Buiten de transactie om vastgelegd: deze transactie wordt zo teruggedraaid.
SELECT dblink_connect('d', :'conn');
SELECT proof.record_out_of_band('d', 'G1', 'de beginbalans wacht op de terugwerkende boeking',
  dblink_is_busy('b') = 1, format('dblink_is_busy=%s', dblink_is_busy('b')));
ROLLBACK;
SELECT dblink_disconnect('d');
SELECT proof.remote_result('G2', 'na een rollback komt de grendel vrij en slaagt de beginbalans alsnog', 'b', '');
SELECT dblink_exec('b', 'COMMIT');
SELECT proof.expect_true('G3', 'de teruggedraaide boeking bestaat niet en de beginbalans wel', $$
  SELECT (SELECT count(*) FROM public.ledger_postings WHERE client_id = '00000000-0000-0000-0000-00000000cc08') = 2
     AND (SELECT count(*) FROM public.opening_balance_postings WHERE client_id = '00000000-0000-0000-0000-00000000cc08') = 1
$$);

-- ── F: de kruising die onder een omgekeerde grendelvolgorde een deadlock zou
--      zijn — beginbalans (client → kop → groep) tegen gewone schrijver
--      (client → groep) — en daarna de globale deadlockteller. ───────────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000bb09');
SELECT dblink_send_query('b', $$SELECT proof.ordinary_write('00000000-0000-0000-0000-00000000cc09',
  DATE '2027-03-01', 7.00, '9a080000-0000-4000-8000-000000000008')::text$$);
SELECT pg_sleep(0.4);
COMMIT;
-- Eerlijke naam: dit toont dat een gewone boeking op de beginbalansgrendel
-- wacht en daarna gewoon slaagt. Het is GEEN discriminerend bewijs van de
-- grendelvolgorde: tegen de juiste volgorde is de omkering niet te construeren,
-- want geen enkel pad neemt de groepsgrendel vóór de clientgrendel. Wat de
-- volgorde wél toetst, is F0 hieronder — rechtstreeks uit pg_trigger.
SELECT proof.remote_result('F1', 'een gewone boeking wacht op de beginbalansgrendel en slaagt daarna', 'b', '');
SELECT dblink_exec('b', 'COMMIT');

-- F0 toetst de oorzaak in plaats van een gevolg: de clientgrendel moet de
-- EERSTE BEFORE INSERT rijtrigger op ledger_postings zijn, want PostgreSQL
-- vuurt ze in naamvolgorde en daar hangt de hele grendelvolgorde aan.
SELECT proof.expect_true('F0', 'de clientgrendel is de eerste BEFORE INSERT trigger op ledger_postings', $$
  SELECT (
    SELECT t.tgname FROM pg_trigger t
    WHERE t.tgrelid = 'public.ledger_postings'::regclass
      AND NOT t.tgisinternal
      AND (t.tgtype & 2) = 2      -- BEFORE
      AND (t.tgtype & 4) = 4      -- INSERT
      AND (t.tgtype & 1) = 1      -- FOR EACH ROW
    ORDER BY t.tgname LIMIT 1
  ) = 'lock_ledger_client_trigger'
$$);

SELECT proof.expect_true('F2', 'geen enkele deadlock tijdens de scenario-s hierboven (A t/m G)', $$
  SELECT (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database())
       = (SELECT deadlocks FROM proof.deadlock_baseline)
$$);

-- ── H: het schrijverscontract, bewezen in plaats van beloofd. Twee
--      administraties in omgekeerde volgorde binnen twee transacties is een
--      echte cyclus. PostgreSQL breekt hem af; niets halfs wordt vastgelegd.

INSERT INTO public.clients (id, organization_id, name) VALUES
  ('00000000-0000-0000-0000-00000000dd01', '00000000-0000-0000-0000-0000000000a1', 'Deadlock X'),
  ('00000000-0000-0000-0000-00000000dd02', '00000000-0000-0000-0000-0000000000a1', 'Deadlock Y');

CREATE TABLE proof.deadlock_before AS
  SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();

SELECT dblink_connect('d', :'conn');
SELECT * FROM dblink('d', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$) AS t(x text);
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_exec('d', 'BEGIN');

-- b pakt X, d pakt Y.
SELECT * FROM dblink('b', $$SELECT proof.ordinary_write('00000000-0000-0000-0000-00000000dd01',
  DATE '2027-06-01', 11.00, 'dd010000-0000-4000-8000-000000000001')::text$$) AS t(x text);
SELECT * FROM dblink('d', $$SELECT proof.ordinary_write('00000000-0000-0000-0000-00000000dd02',
  DATE '2027-06-01', 22.00, 'dd020000-0000-4000-8000-000000000002')::text$$) AS t(x text);

-- en nu kruislings: b wil Y, d wil X.
SELECT dblink_send_query('b', $$SELECT proof.ordinary_write('00000000-0000-0000-0000-00000000dd02',
  DATE '2027-06-01', 33.00, 'dd030000-0000-4000-8000-000000000003')::text$$);
SELECT dblink_send_query('d', $$SELECT proof.ordinary_write('00000000-0000-0000-0000-00000000dd01',
  DATE '2027-06-01', 44.00, 'dd040000-0000-4000-8000-000000000004')::text$$);
SELECT pg_sleep(2.0);   -- deadlock_timeout is standaard 1s

-- Precies één van de twee moet zijn afgebroken met 40P01.
CREATE OR REPLACE FUNCTION proof.collect_deadlock(_conn text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_msg text;
BEGIN
  PERFORM * FROM dblink_get_result(_conn) AS t(x text);
  PERFORM * FROM dblink_get_result(_conn) AS t(x text);
  RETURN 'ok';
EXCEPTION WHEN others THEN
  v_msg := SQLERRM;
  BEGIN
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
  EXCEPTION WHEN others THEN NULL;
  END;
  RETURN v_msg;
END
$$;

CREATE TABLE proof.h_outcome AS
  SELECT proof.collect_deadlock('b') AS b_result, proof.collect_deadlock('d') AS d_result;

SELECT proof.expect_true('H1', 'precies één van de twee transacties is afgebroken met een deadlock', $$
  SELECT (CASE WHEN b_result ILIKE '%deadlock%' THEN 1 ELSE 0 END
        + CASE WHEN d_result ILIKE '%deadlock%' THEN 1 ELSE 0 END) = 1
  FROM proof.h_outcome
$$);
SELECT dblink_exec('b', 'ROLLBACK');
SELECT dblink_exec('d', 'ROLLBACK');

-- Een backend spoelt zijn statistieken pas aan het eind van zijn transactie
-- door, dus de teller wordt pas ná die rollbacks gelezen.
SELECT pg_sleep(1.0);
SELECT proof.expect_true('H2', 'en PostgreSQL heeft die deadlock ook echt geteld', $$
  SELECT (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database())
       >= (SELECT deadlocks FROM proof.deadlock_before) + 1
$$);
SELECT proof.expect_true('H3', 'niets halfs vastgelegd: beide administraties zijn leeg gebleven', $$
  SELECT count(*) = 0 FROM public.ledger_postings
  WHERE client_id IN ('00000000-0000-0000-0000-00000000dd01', '00000000-0000-0000-0000-00000000dd02')
$$);

SELECT dblink_disconnect('d');
SELECT dblink_disconnect('b');
