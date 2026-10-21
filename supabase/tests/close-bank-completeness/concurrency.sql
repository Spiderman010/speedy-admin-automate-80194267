-- CONCURRENCY — throwaway database only. Twee echte sessies via dblink.
--
-- K13: een gecodeerde, nog niet geboekte bankregel van 2026. Sessie A boekt
-- haar met de echte schrijver en houdt de transactie open (de schrijver houdt
-- dan de administratiegrendel vast). Sessie B probeert intussen 2026 af te
-- sluiten. De afsluiting moet WACHTEN op de grendel en daarna de vastgelegde
-- boeking zien: geen weigering op een verouderde stand, geen afsluiting
-- tussendoor.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

SELECT proof.put('deadlocks_voor', (SELECT deadlocks::text FROM pg_stat_database WHERE datname = current_database()));

SELECT dblink_connect('p7a', :'conn');
SELECT dblink_connect('p7b', :'conn');

SELECT dblink_exec('p7a', 'BEGIN');
SELECT * FROM dblink('p7a', format('SELECT set_config(''test.user_id'', %L, false)', proof.assistant())) AS t(x text);
SELECT proof.put('c_groep', (SELECT g FROM dblink('p7a',
  format('SELECT public.post_bank_transaction(%L)::text', proof.uid(1000, 1301))) AS t(g text)));

SELECT * FROM dblink('p7b', format('SELECT set_config(''test.user_id'', %L, false)', proof.accountant())) AS t(x text);
SELECT dblink_send_query('p7b', format('SELECT created::text FROM public.close_fiscal_year(%L, 2026)', proof.client(13)));
SELECT pg_sleep(1.0);

SELECT proof.record('C1', 'gelijktijdig: de afsluiting wacht op de administratiegrendel zolang de boeking niet is vastgelegd',
  dblink_is_busy('p7b') = 1
  AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.locktype = 'advisory' AND NOT l.granted),
  format('busy=%s, wachtende adviesgrendels=%s', dblink_is_busy('p7b'),
         (SELECT count(*) FROM pg_locks l WHERE l.locktype = 'advisory' AND NOT l.granted)));

SELECT dblink_exec('p7a', 'COMMIT');
SELECT proof.put('c_close', (SELECT created FROM dblink_get_result('p7b') AS t(created text)));
-- dblink_get_result moet tot de lege uitkomst worden leeggelezen.
SELECT count(*) FROM dblink_get_result('p7b') AS t(created text);

SELECT proof.record('C2', 'gelijktijdig: daarna ziet de afsluiting de vastgelegde boeking en sluit zij 2026 af (created = true)',
  proof.get('c_close') = 'true' AND proof.get('c_groep') IS NOT NULL,
  format('afsluiting=%s groep=%s', proof.get('c_close'), proof.get('c_groep')));

SELECT proof.expect_true('C3', 'gelijktijdig: precies één afsluitbewijs en één gebeurtenis voor K13 2026, en de bankregel is één keer geboekt',
  format($q$(SELECT count(*) = 1 FROM public.year_closures WHERE client_id = %1$L AND fiscal_year = 2026)
            AND (SELECT count(*) = 1 FROM public.fiscal_year_events WHERE client_id = %1$L AND fiscal_year = 2026)
            AND (SELECT count(*) = 1 FROM public.bank_transaction_postings WHERE bank_transaction_id = %2$L)$q$,
         proof.client(13), proof.uid(1000, 1301)));

SELECT dblink_disconnect('p7a');
SELECT dblink_disconnect('p7b');

-- Het isolatiecontract: buiten READ COMMITTED weigert de afsluiting (25000).
SELECT dblink_connect('p7c', :'conn');
SELECT dblink_exec('p7c', 'BEGIN ISOLATION LEVEL REPEATABLE READ');
SELECT * FROM dblink('p7c', format('SELECT set_config(''test.user_id'', %L, false)', proof.accountant())) AS t(x text);
DO $$
DECLARE v_state text; v_msg text;
BEGIN
  BEGIN
    PERFORM * FROM dblink('p7c', format('SELECT created::text FROM public.close_fiscal_year(%L, 2025)', proof.client(12))) AS t(created text);
    PERFORM proof.record('C4', 'isolatiecontract: buiten READ COMMITTED wordt geweigerd (25000)', false, 'GEEN fout');
  EXCEPTION WHEN others THEN
    v_state := SQLSTATE; v_msg := SQLERRM;
    PERFORM proof.record('C4', 'isolatiecontract: buiten READ COMMITTED wordt geweigerd (25000)',
      v_state = '25000' AND v_msg LIKE '%alleen in een READ COMMITTED transactie%', format('[%s] %s', v_state, v_msg));
  END;
END
$$;
SELECT dblink_exec('p7c', 'ROLLBACK');
SELECT dblink_disconnect('p7c');

SELECT proof.record('C5', 'geen deadlock in de hele gelijktijdigheidsproef',
  (SELECT deadlocks::text FROM pg_stat_database WHERE datname = current_database()) = proof.get('deadlocks_voor'),
  (SELECT deadlocks::text FROM pg_stat_database WHERE datname = current_database()));
