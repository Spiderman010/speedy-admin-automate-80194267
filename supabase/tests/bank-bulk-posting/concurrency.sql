-- REAL POSTGRESQL CONCURRENCY PROOF for the bank bulk layer — throwaway
-- cluster only.
--
-- Twee werkelijk gelijktijdige sessies: deze psql-sessie (A) en een tweede
-- backend via dblink (B). De bewering gaat telkens over de INVARIANT — precies
-- één marker en één boekingsgroep per bankregel — want die moet gelden wat de
-- timing ook doet.
--
-- Sessie B verbindt als postgres en omzeilt dus RLS; de rolcontroles ín de
-- schrijver draaien onverkort, want die lezen auth.uid() uit de sessie-GUC die
-- op die verbinding wordt gezet. Rechten en RLS worden in proof.sql bewezen.
--
-- Draait na proof.sql (schrijft in proof.result).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

CREATE TABLE IF NOT EXISTS proof.deadlock_baseline_bulk AS
  SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();

CREATE OR REPLACE FUNCTION proof.remote_text(_n text, _name text, _conn text, _expect text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_got text;
BEGIN
  BEGIN
    SELECT x INTO v_got FROM dblink_get_result(_conn) AS t(x text);
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
  EXCEPTION WHEN others THEN
    v_got := 'FOUT: ' || SQLERRM;
  END;
  INSERT INTO proof.result VALUES (_n, _name, v_got IS NOT DISTINCT FROM _expect,
    format('tweede sessie gaf: %s', COALESCE(v_got, 'NULL')));
  BEGIN
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

CREATE OR REPLACE FUNCTION proof.remote_error(_n text, _name text, _conn text, _needle text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_msg text; v_dummy text;
BEGIN
  BEGIN
    SELECT x INTO v_dummy FROM dblink_get_result(_conn) AS t(x text);
    INSERT INTO proof.result VALUES (_n, _name, false,
      format('tweede sessie slaagde, terwijl een weigering werd verwacht: %s', v_dummy));
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
    RETURN;
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;
  INSERT INTO proof.result VALUES (_n, _name,
    position(lower(_needle) IN lower(v_msg)) > 0, v_msg);
  BEGIN
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

CREATE OR REPLACE FUNCTION proof.record_busy(_n text, _name text, _busy integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO proof.result VALUES (_n, _name, _busy = 1, format('dblink_is_busy=%s', _busy));
END $$;

-- Verse bankregels voor de races.
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-0000000000c1', -121.00, 21);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-0000000000c1', -242.00, 21);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000403', '00000000-0000-0000-0000-0000000000c1',  -30.00, NULL);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000404', '00000000-0000-0000-0000-0000000000c1',  -40.00, NULL);

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT dblink_connect('b', :'conn');
SELECT * FROM dblink('b', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$) AS t(x text);

-- ── 7: bulk tegenover de enkelvoudige schrijver, dezelfde bankregel ─────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT string_agg(outcome, ',') FROM public.post_bank_transactions_bulk(
  ARRAY['00000000-0000-0000-0000-000000000401']::uuid[]);
SELECT dblink_send_query('b', $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000401')::text$$);
SELECT pg_sleep(0.4);

-- B moet wachten: eerst op de rijgrendel van SELECT ... FOR UPDATE, daarna op
-- de primary key van de marker. Dat wachten IS het bewijs dat de twee niet
-- langs elkaar heen kunnen werken.
SELECT proof.record_busy('7a', 'de enkelvoudige schrijver wacht op de lopende bulk', dblink_is_busy('b'));
COMMIT;

SELECT proof.remote_error('7b', 'en wordt daarna geweigerd', 'b', 'al geboekt');
SELECT dblink_exec('b', 'ROLLBACK');

SELECT proof.expect_true('7c', 'precies één marker, één boekingsgroep en drie regels', $$
  SELECT proof.marker_count('00000000-0000-0000-0000-000000000401') = 1
     AND (SELECT count(DISTINCT posting_group_id) FROM public.ledger_postings
          WHERE source_id = '00000000-0000-0000-0000-000000000401') = 1
     AND proof.ledger_count('00000000-0000-0000-0000-000000000401') = 3
$$);

-- ── 8: bulk tegenover bulk, dezelfde bankregel ─────────────────────────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT string_agg(outcome, ',') FROM public.post_bank_transactions_bulk(
  ARRAY['00000000-0000-0000-0000-000000000402']::uuid[]);
SELECT dblink_send_query('b', $$SELECT string_agg(outcome, ',') FROM public.post_bank_transactions_bulk(
  ARRAY['00000000-0000-0000-0000-000000000402']::uuid[])$$);
SELECT pg_sleep(0.4);

SELECT proof.record_busy('8a', 'de tweede bulk wacht op de eerste', dblink_is_busy('b'));
COMMIT;

-- De tweede bulk mislukt niet: zij stelt vast dat de regel al geboekt is.
SELECT proof.remote_text('8b', 'en meldt daarna al-geboekt in plaats van te mislukken', 'b', 'already_posted');
SELECT dblink_exec('b', 'ROLLBACK');

SELECT proof.expect_true('8c', 'ook nu precies één marker, één boekingsgroep en drie regels', $$
  SELECT proof.marker_count('00000000-0000-0000-0000-000000000402') = 1
     AND (SELECT count(DISTINCT posting_group_id) FROM public.ledger_postings
          WHERE source_id = '00000000-0000-0000-0000-000000000402') = 1
     AND proof.ledger_count('00000000-0000-0000-0000-000000000402') = 3
$$);

-- ── 8d: twee VERSCHILLENDE bankregels zitten elkaar niet in de weg ─────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT string_agg(outcome, ',') FROM public.post_bank_transactions_bulk(
  ARRAY['00000000-0000-0000-0000-000000000403']::uuid[]);
SELECT dblink_send_query('b', $$SELECT string_agg(outcome, ',') FROM public.post_bank_transactions_bulk(
  ARRAY['00000000-0000-0000-0000-000000000404']::uuid[])$$);
SELECT pg_sleep(0.4);
SELECT proof.record_busy('8d', 'een bulk van een ANDERE bankregel loopt gewoon door', 1 - dblink_is_busy('b'));
COMMIT;

SELECT proof.remote_text('8e', 'en boekt op eigen kracht', 'b', 'posted');
SELECT dblink_exec('b', 'ROLLBACK');

SELECT dblink_disconnect('b');

-- ── 25: geen deadlocks ─────────────────────────────────────────────────────

SELECT proof.expect_true('25a', 'geen enkele deadlock tijdens deze scenario''s', $$
  SELECT (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database())
       = (SELECT deadlocks FROM proof.deadlock_baseline_bulk)
$$);

SELECT proof.expect_true('25b', 'en na alle gelijktijdigheid heeft nog steeds elke marker één sluitende groep', $$
  SELECT bool_and(d = c AND d > 0) FROM (
    SELECT sum(lp.debit_amount) AS d, sum(lp.credit_amount) AS c
    FROM public.bank_transaction_postings m
    JOIN public.ledger_postings lp ON lp.posting_group_id = m.posting_group_id
    GROUP BY m.bank_transaction_id
  ) t
$$);
