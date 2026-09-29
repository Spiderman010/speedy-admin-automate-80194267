-- REAL POSTGRESQL PROOF — twee gelijktijdige heropeningen van hetzelfde jaar.
-- Throwaway cluster only; see run-proof.sh.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.pl_client('PR E — gelijktijdig') AS c \gset
SELECT proof.seed_group(:'c', 2024);
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', :'c', 2024);

SELECT dblink_connect('b', :'conn');
SELECT * FROM dblink('b', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$) AS t(x text);

BEGIN;
SELECT reopened AS a_reopened FROM public.reopen_fiscal_year(:'c', 2024, 'Sessie A') \gset

SELECT dblink_send_query('b', format('SELECT reopened FROM public.reopen_fiscal_year(%L, 2024, %L)', :'c', 'Sessie B'));
SELECT pg_sleep(0.5);

SELECT proof.record('48', 'een tweede heropening wacht op de grendel zolang de eerste loopt',
  dblink_is_busy('b') = 1);
COMMIT;

SELECT reopened AS b_reopened FROM dblink_get_result('b') AS t(reopened boolean) \gset
SELECT * FROM dblink_get_result('b') AS t(reopened boolean);

SELECT proof.record('49', 'precies één heropening telt: A reopened = true, B ziet de stand en krijgt reopened = false',
  :'a_reopened'::boolean AND NOT :'b_reopened'::boolean
    AND (SELECT count(*) FROM public.fiscal_year_events
         WHERE client_id = :'c' AND fiscal_year = 2024 AND event_type = 'reopened') = 1,
  format('A=%s B=%s', :'a_reopened', :'b_reopened'));

SELECT dblink_disconnect('b');
