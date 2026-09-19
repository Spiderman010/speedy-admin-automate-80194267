-- REAL POSTGRESQL CONCURRENCY PROOF for 6C-b9 — throwaway cluster only.
--
-- Twee werkelijk gelijktijdige sessies: deze psql-sessie (A) en een tweede
-- backend via dblink (B). A start een tegenboeking en houdt haar transactie
-- open; B krijgt dezelfde aanroep asynchroon en blokkeert; A commit; B gaat
-- door en moet worden geweigerd. De assertie gaat over de INVARIANT — precies
-- één marker, precies één tegenboekingsgroep, precies N tegenregels — want die
-- moet gelden wat de timing ook doet.
--
-- Sessie B verbindt als postgres en omzeilt dus RLS; de rolcontroles ín de RPC
-- draaien onverkort, want die lezen auth.uid() uit de sessie-GUC die op die
-- verbinding wordt gezet. Hier wordt de grendeling en de uniciteit bewezen;
-- rechten en RLS worden in proof.sql bewezen.
--
-- Draait na proof.sql (schrijft in proof.result).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

-- PostgreSQL telt elke deadlock die het verbreekt. Zou een van de scenario's
-- hieronder een cyclus vormen, dan beweegt deze teller.
CREATE TABLE IF NOT EXISTS proof.deadlock_baseline_rev AS
  SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();

CREATE OR REPLACE FUNCTION proof.remote_result_rev(_n text, _name text, _conn text, _needle text)
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

  BEGIN
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
  EXCEPTION WHEN others THEN
    NULL;
  END;
END $$;

-- Twee originelen om gelijktijdig tegen te boeken.
SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-0000000000d2',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f003',
        '00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[100.00, 21.00, 0]::numeric[], ARRAY[0, 0, 121.00]::numeric[]);

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT dblink_connect('b', :'conn');
SELECT * FROM dblink('b', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$) AS t(x text);

-- Wachten of niet wachten is hier de waarneming; deze helper legt haar vast.
CREATE OR REPLACE FUNCTION proof.record_busy(_n text, _name text, _busy integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO proof.result VALUES (_n, _name, _busy = 1, format('dblink_is_busy=%s', _busy));
END $$;

-- ── R1: twee gelijktijdige tegenboekingen van DEZELFDE groep ────────────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000201', DATE '2027-06-01', 'sessie A');
SELECT dblink_send_query('b', $$SELECT public.reverse_posting_group(
  '00000000-0000-0000-0000-000000000201', DATE '2027-06-01', 'sessie B')::text$$);
SELECT pg_sleep(0.4);

-- B moet wachten: eerst op de administratiegrendel, daarna op de primary key
-- van de marker. Dat wachten IS het bewijs dat de twee niet langs elkaar heen
-- kunnen werken. Eerst noteren (binnen de transactie van A, die zo meteen
-- commit), dan pas committen.
SELECT proof.record_busy('R1', 'de tweede tegenboeking van dezelfde groep wacht', dblink_is_busy('b'));
COMMIT;

SELECT proof.remote_result_rev('R2', 'en wordt daarna geweigerd', 'b', 'al tegengeboekt');
SELECT dblink_exec('b', 'ROLLBACK');

SELECT proof.expect_true('R3', 'precies één marker, één tegenboekingsgroep en drie tegenregels', $$
  SELECT (SELECT count(*) FROM public.ledger_reversal_postings
          WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000201') = 1
     AND (SELECT count(DISTINCT t.posting_group_id) FROM public.ledger_postings t
          JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
          WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000201') = 1
     AND (SELECT count(*) FROM public.ledger_postings t
          JOIN public.ledger_reversal_postings r ON r.reversal_posting_group_id = t.posting_group_id
          WHERE r.original_posting_group_id = '00000000-0000-0000-0000-000000000201') = 3
$$);

SELECT proof.expect_true('R4', 'de administratie is netjes op nul geboekt: geen halve tegenboeking', $$
  SELECT (SELECT COALESCE(sum(debit_amount) - sum(credit_amount), 0) FROM public.ledger_postings
          WHERE client_id = '00000000-0000-0000-0000-0000000000d2') = 0
     AND (SELECT count(*) FROM public.ledger_postings
          WHERE client_id = '00000000-0000-0000-0000-0000000000d2') = 6
$$);

SELECT proof.expect_true('R5', 'de verliezende sessie heeft precies één toelichting achtergelaten: die van de winnaar', $$
  SELECT (SELECT reason FROM public.ledger_reversal_postings
          WHERE original_posting_group_id = '00000000-0000-0000-0000-000000000201') = 'sessie A'
$$);

-- ── R6: verschillende administraties blokkeren elkaar niet ──────────────────

SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-0000000000d1',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[8.00, 0]::numeric[], ARRAY[0, 8.00]::numeric[]);

SELECT proof.seed_group(
  '00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-0000000000cd',
  DATE '2027-03-01', 'purchase_invoice',
  ARRAY['00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-00000000f001']::uuid[],
  ARRAY[8.00, 0]::numeric[], ARRAY[0, 8.00]::numeric[]);

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.reverse_posting_group('00000000-0000-0000-0000-000000000202', DATE '2027-06-01');
SELECT dblink_send_query('b', $$SELECT public.reverse_posting_group(
  '00000000-0000-0000-0000-000000000203', DATE '2027-06-01')::text$$);
SELECT pg_sleep(0.4);
SELECT proof.record_busy('R6', 'een tegenboeking van een ANDERE administratie loopt gewoon door', 1 - dblink_is_busy('b'));
COMMIT;

SELECT proof.remote_result_rev('R7', 'en slaagt', 'b', '');
SELECT dblink_exec('b', 'COMMIT');

SELECT proof.expect_true('R8', 'beide administraties hebben hun eigen tegenboeking', $$
  SELECT (SELECT count(*) FROM public.ledger_reversal_postings
          WHERE original_posting_group_id IN ('00000000-0000-0000-0000-000000000202',
                                              '00000000-0000-0000-0000-000000000203')) = 2
$$);

SELECT dblink_disconnect('b');

SELECT proof.expect_true('R9', 'geen enkele deadlock tijdens deze scenario''s', $$
  SELECT (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database())
       = (SELECT deadlocks FROM proof.deadlock_baseline_rev)
$$);
