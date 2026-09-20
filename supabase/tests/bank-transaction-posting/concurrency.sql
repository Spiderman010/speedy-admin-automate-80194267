-- REAL POSTGRESQL CONCURRENCY PROOF for post_bank_transaction() — throwaway
-- cluster only.
--
-- Twee werkelijk gelijktijdige sessies: deze psql-sessie (A) en een tweede
-- backend via dblink (B). Beide boeken DEZELFDE bankregel. De assertie gaat
-- over de INVARIANT — precies één marker, precies één boekingsgroep, precies
-- twee grootboekregels — want die moet gelden wat de timing ook doet.
--
-- Sessie B verbindt als postgres en omzeilt dus RLS; de rolcontroles ín de
-- writer draaien onverkort, want die lezen auth.uid() uit de sessie-GUC die op
-- die verbinding wordt gezet. Rechten en RLS worden in proof.sql bewezen.
--
-- Draait na proof.sql (schrijft in proof.result).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

CREATE TABLE IF NOT EXISTS proof.deadlock_baseline_bank AS
  SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();

CREATE OR REPLACE FUNCTION proof.remote_result_bank(_n text, _name text, _conn text, _needle text)
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

CREATE OR REPLACE FUNCTION proof.record_busy_bank(_n text, _name text, _busy integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO proof.result VALUES (_n, _name, _busy = 1, format('dblink_is_busy=%s', _busy));
END $$;

-- Twee verse bankregels: één voor de race op dezelfde regel, één om te tonen
-- dat verschillende regels elkaar niet in de weg zitten.
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-0000000000c1', -121.00, 21);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-0000000000c1',  -30.00, NULL);

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT dblink_connect('b', :'conn');
SELECT * FROM dblink('b', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$) AS t(x text);

-- ── 12: twee gelijktijdige boekingen van DEZELFDE bankregel ─────────────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000201');
SELECT dblink_send_query('b', $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000201')::text$$);
SELECT pg_sleep(0.4);

-- B moet wachten: eerst op de rijgrendel van SELECT ... FOR UPDATE, daarna op
-- de primary key van de marker. Dat wachten IS het bewijs dat de twee niet
-- langs elkaar heen kunnen werken. Eerst noteren (binnen de transactie van A,
-- die zo meteen commit), dan pas committen.
SELECT proof.record_busy_bank('12a', 'de tweede boeking van dezelfde bankregel wacht', dblink_is_busy('b'));
COMMIT;

SELECT proof.remote_result_bank('12b', 'en wordt daarna geweigerd', 'b', 'al geboekt');
SELECT dblink_exec('b', 'ROLLBACK');

SELECT proof.expect_true('12c', 'precies één marker, één boekingsgroep en drie regels', $$
  SELECT (SELECT count(*) FROM public.bank_transaction_postings
          WHERE bank_transaction_id = '00000000-0000-0000-0000-000000000201') = 1
     AND (SELECT count(DISTINCT posting_group_id) FROM public.ledger_postings
          WHERE source_id = '00000000-0000-0000-0000-000000000201') = 1
     AND (SELECT count(*) FROM public.ledger_postings
          WHERE source_id = '00000000-0000-0000-0000-000000000201') = 3
$$);

SELECT proof.expect_true('12d', 'en die ene boeking sluit: 121,00 debet tegenover 121,00 credit', $$
  SELECT (SELECT sum(debit_amount) = 121.00 AND sum(credit_amount) = 121.00
          FROM public.ledger_postings WHERE source_id = '00000000-0000-0000-0000-000000000201')
$$);

-- ── 12e: verschillende bankregels blokkeren elkaar niet ─────────────────────

SELECT dblink_exec('b', 'BEGIN');
BEGIN;
SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000202');
SELECT dblink_send_query('b', $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000109')::text$$);
SELECT pg_sleep(0.4);
SELECT proof.record_busy_bank('12e', 'een boeking van een ANDERE bankregel loopt gewoon door',
  1 - dblink_is_busy('b'));
COMMIT;

-- 109 is in proof.sql al geboekt, dus B hoort met "al geboekt" te eindigen —
-- wat er hier toe doet is dat B niet op A hoefde te wachten.
SELECT proof.remote_result_bank('12f', 'en eindigt op haar eigen merites, niet op die van A', 'b', 'al geboekt');
SELECT dblink_exec('b', 'ROLLBACK');

SELECT dblink_disconnect('b');

SELECT proof.expect_true('12g', 'geen enkele deadlock tijdens deze scenario''s', $$
  SELECT (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database())
       = (SELECT deadlocks FROM proof.deadlock_baseline_bank)
$$);
