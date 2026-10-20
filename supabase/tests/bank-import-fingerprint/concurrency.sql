-- ECHTE GELIJKTIJDIGHEID — twee afzonderlijke backends ('a' en 'b', via dblink),
-- beide als authenticated assistent onder RLS. Deze psql-sessie regisseert en
-- legt clock_timestamp() vast. Throwaway database only.
--
--   C1  A: BEGIN; INSERT X; pg_sleep(2); COMMIT.
--       B start TIJDENS A's slaap met dezelfde X  ⇒ B wacht op A's transactie
--       (pg_blocking_pids), en faalt na A's commit met 23505. Precies één rij X.
--   C2  Omgekeerd: A: BEGIN; INSERT Y; pg_sleep(2); ROLLBACK.
--       B wacht, en slaagt zodra A terugdraait. Precies één rij Y — die van B.
--   C3  Twee op inhoud identieke regels met VERSCHILLENDE vingerafdruk tegelijk:
--       B wacht niet en beide commits slagen.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

SELECT proof.open_session('a', :'conn');
SELECT proof.open_session('b', :'conn');

CREATE TABLE proof.race (
  n          text PRIMARY KEY,
  a_pid      int,
  b_pid      int,
  a_insert   text,
  a_inserted timestamptz,
  b_sent     timestamptz,
  b_busy     boolean,
  b_waits    boolean,
  b_blocker  boolean,
  a_end      timestamptz,
  a_ended    timestamptz,
  b_result   text,
  b_commit   text
);

CREATE FUNCTION proof.race_round(_n text, _fp_a text, _fp_b text, _a_end text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_a int := (SELECT x::int FROM dblink('a', 'SELECT pg_backend_pid()::text') t(x text));
  v_b int := (SELECT x::int FROM dblink('b', 'SELECT pg_backend_pid()::text') t(x text));
BEGIN
  INSERT INTO proof.race (n, a_pid, b_pid) VALUES (_n, v_a, v_b);

  -- A: BEGIN; INSERT; pg_sleep(2) — de slaap draait asynchroon.
  PERFORM dblink_exec('a', 'BEGIN');
  UPDATE proof.race SET a_insert = proof.remote_run('a',
      format('SELECT proof.timed_insert(%L, %L)', _fp_a, _n || ' sessie A')),
    a_inserted = clock_timestamp() WHERE n = _n;
  PERFORM dblink_send_query('a', 'SELECT pg_sleep(2)::text');

  -- B start tijdens A's slaap, in autocommit-stijl: eigen BEGIN … COMMIT.
  PERFORM dblink_exec('b', 'BEGIN');
  UPDATE proof.race SET b_sent = clock_timestamp() WHERE n = _n;
  PERFORM dblink_send_query('b', format('SELECT proof.timed_insert(%L, %L)', _fp_b, _n || ' sessie B'));

  PERFORM pg_sleep(0.7);
  UPDATE proof.race SET
    b_busy    = dblink_is_busy('b') = 1,
    b_waits   = EXISTS (SELECT 1 FROM pg_stat_activity
                        WHERE pid = v_b AND wait_event_type = 'Lock' AND wait_event = 'transactionid'),
    b_blocker = v_a = ANY (pg_blocking_pids(v_b))
  WHERE n = _n;

  -- A wordt wakker en sluit af.
  PERFORM * FROM dblink_get_result('a') AS t(x text);
  PERFORM * FROM dblink_get_result('a') AS t(x text);
  UPDATE proof.race SET a_end = clock_timestamp() WHERE n = _n;
  PERFORM dblink_exec('a', _a_end);
  UPDATE proof.race SET a_ended = clock_timestamp() WHERE n = _n;

  UPDATE proof.race SET b_result = proof.remote_outcome('b') WHERE n = _n;
  UPDATE proof.race SET b_commit = proof.remote_run('b', 'COMMIT') WHERE n = _n;
END $$;

/** 'ok: start|einde|uitkomst' → het gevraagde deel. */
CREATE FUNCTION proof.part(_s text, _i int)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN _s LIKE 'ok: %' THEN nullif(split_part(substr(_s, 5), '|', _i), '') END
$$;

-- ── C1 ──────────────────────────────────────────────────────────────────────
SELECT proof.race_round('C1', proof.fp('C1-X'), proof.fp('C1-X'), 'COMMIT');

SELECT proof.record('C1a', 'C1: A schrijft X en slaapt 2 s in een open transactie',
  proof.part(a_insert, 3) = 'ok', a_insert) FROM proof.race WHERE n = 'C1';
SELECT proof.record('C1b', 'C1: B (gestart tijdens A''s slaap) wacht: busy, Lock/transactionid, geblokkeerd door A''s pid',
  b_busy AND b_waits AND b_blocker,
  format('busy=%s lock=%s blocker=%s a_pid=%s b_pid=%s', b_busy, b_waits, b_blocker, a_pid, b_pid)) FROM proof.race WHERE n = 'C1';
SELECT proof.record('C1c', 'C1: B faalt na A''s COMMIT met 23505 op de index',
  proof.part(b_result, 3) LIKE '23505: %bank_transactions_client_import_fingerprint_key%', b_result) FROM proof.race WHERE n = 'C1';
SELECT proof.record('C1d', 'C1: tijdlijn — B begon vóór A''s COMMIT en eindigde pas daarna (≥ 1 s geblokkeerd)',
  proof.part(b_result, 1)::timestamptz < a_end
  AND proof.part(b_result, 2)::timestamptz >= a_end
  AND proof.part(b_result, 2)::timestamptz - proof.part(b_result, 1)::timestamptz >= interval '1 second',
  format('A insert %s | B start %s | A COMMIT %s | B einde %s | B wachtte %s',
    to_char(a_inserted, 'HH24:MI:SS.MS'), to_char(proof.part(b_result, 1)::timestamptz, 'HH24:MI:SS.MS'),
    to_char(a_end, 'HH24:MI:SS.MS'), to_char(proof.part(b_result, 2)::timestamptz, 'HH24:MI:SS.MS'),
    proof.part(b_result, 2)::timestamptz - proof.part(b_result, 1)::timestamptz))
FROM proof.race WHERE n = 'C1';
SELECT proof.record('C1e', 'C1: precies één rij met X, en het is die van A',
  (SELECT count(*) FROM public.bank_transactions WHERE import_fingerprint = proof.fp('C1-X')) = 1
  AND (SELECT description FROM public.bank_transactions WHERE import_fingerprint = proof.fp('C1-X')) = 'C1 sessie A');

-- ── C2 ──────────────────────────────────────────────────────────────────────
SELECT proof.race_round('C2', proof.fp('C2-Y'), proof.fp('C2-Y'), 'ROLLBACK');

SELECT proof.record('C2a', 'C2: B wacht op A''s open transactie met dezelfde Y',
  b_busy AND b_waits AND b_blocker,
  format('busy=%s lock=%s blocker=%s', b_busy, b_waits, b_blocker)) FROM proof.race WHERE n = 'C2';
SELECT proof.record('C2b', 'C2: A draait terug ⇒ B slaagt en commit',
  proof.part(b_result, 3) = 'ok' AND b_commit LIKE 'ok%', b_result || ' / ' || b_commit) FROM proof.race WHERE n = 'C2';
SELECT proof.record('C2c', 'C2: tijdlijn — B eindigde pas na A''s ROLLBACK',
  proof.part(b_result, 2)::timestamptz >= a_end AND proof.part(b_result, 1)::timestamptz < a_end,
  format('B start %s | A ROLLBACK %s | B einde %s', to_char(proof.part(b_result, 1)::timestamptz, 'HH24:MI:SS.MS'),
    to_char(a_end, 'HH24:MI:SS.MS'), to_char(proof.part(b_result, 2)::timestamptz, 'HH24:MI:SS.MS')))
FROM proof.race WHERE n = 'C2';
SELECT proof.record('C2d', 'C2: precies één rij met Y, en het is die van B',
  (SELECT count(*) FROM public.bank_transactions WHERE import_fingerprint = proof.fp('C2-Y')) = 1
  AND (SELECT description FROM public.bank_transactions WHERE import_fingerprint = proof.fp('C2-Y')) = 'C2 sessie B');

-- ── C3 ──────────────────────────────────────────────────────────────────────
SELECT proof.race_round('C3', proof.fp('C3-ref-1'), proof.fp('C3-ref-2'), 'COMMIT');

SELECT proof.record('C3a', 'C3: verschillende vingerafdruk, identieke inhoud — B wacht NIET op A',
  NOT b_busy AND NOT b_waits AND NOT b_blocker,
  format('busy=%s lock=%s blocker=%s', b_busy, b_waits, b_blocker)) FROM proof.race WHERE n = 'C3';
SELECT proof.record('C3b', 'C3: beide regels gecommit',
  proof.part(b_result, 3) = 'ok' AND b_commit LIKE 'ok%'
  AND (SELECT count(*) FROM public.bank_transactions WHERE import_fingerprint IN (proof.fp('C3-ref-1'), proof.fp('C3-ref-2'))) = 2,
  b_result) FROM proof.race WHERE n = 'C3';

SELECT proof.record('C4', 'geen sessie bleef in een transactie of met een fout achter (geen 40P01, geen time-out)',
  NOT EXISTS (SELECT 1 FROM proof.race WHERE a_insert LIKE 'fout%' OR b_result LIKE 'fout%' OR b_commit LIKE 'fout%')
  AND NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid IN (SELECT a_pid FROM proof.race UNION SELECT b_pid FROM proof.race)
                  AND state LIKE 'idle in transaction%'));

SELECT dblink_disconnect('a'), dblink_disconnect('b');
