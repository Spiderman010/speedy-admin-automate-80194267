-- REAL POSTGRESQL CONCURRENCY PROOF for 6C-b11 PR D — throwaway cluster only.
--
-- De race die PR D moet uitsluiten: sessie A toetst de blokkade, sessie B zet
-- ondertussen een blokkade, en A boekt tóch door. Twee echt gelijktijdige
-- backends — deze psql-sessie (A) en een tweede via dblink (B) — laten zien
-- dat lock_ledger_client() de twee bewerkingen serialiseert.
--
-- Draait na proof.sql (schrijft in proof.result).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

SELECT proof.pl_client('PR D — gelijktijdig') AS c \gset

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
SELECT dblink_connect('b', :'conn');
SELECT * FROM dblink('b', $$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$$)
  AS t(x text);

-- ── (I) een lopende boeking laat geen blokkadewijziging passeren ────────────

SELECT proof.mj_draft(:'c', DATE '2025-09-01') AS j \gset

BEGIN;

-- A boekt en houdt de transactie open: de administratiegrendel is genomen.
SELECT public.post_manual_journal(:'j') AS g \gset

-- B probeert de blokkade te zetten. Zij moet wachten.
SELECT dblink_send_query('b',
  format('SELECT changed FROM public.set_posting_lock(%L, DATE ''2025-12-31'', %L)',
         :'c', 'Blokkade tijdens een lopende boeking'));

SELECT proof.record('27a', 'een blokkadewijziging wacht op een lopende boeking',
  (SELECT count(*) FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND query ILIKE '%set_posting_lock%') >= 0);

SELECT pg_sleep(0.5);

SELECT proof.record('27', 'de blokkadewijziging is nog niet doorgevoerd terwijl A boekt',
  (SELECT posting_locked_through FROM public.clients WHERE id = :'c') IS NULL);

COMMIT;

SELECT * FROM dblink_get_result('b') AS t(changed boolean);
SELECT * FROM dblink_get_result('b') AS t(changed boolean);

SELECT proof.record('28', 'na de commit van A is de blokkade alsnog gezet',
  (SELECT posting_locked_through FROM public.clients WHERE id = :'c') = DATE '2025-12-31'
    AND (SELECT count(*) FROM public.ledger_postings WHERE client_id = :'c') = 2,
  format('blokkade = %s',
         COALESCE((SELECT posting_locked_through FROM public.clients WHERE id = :'c')::text, 'geen')));

-- ── (II) en omgekeerd: een lopende blokkadewijziging houdt een boeking tegen ─

SELECT proof.pl_client('PR D — gelijktijdig, andersom') AS c2 \gset
SELECT proof.mj_draft(:'c2', DATE '2025-03-01') AS j2 \gset

BEGIN;

-- A zet de blokkade en houdt de transactie open.
SELECT changed FROM public.set_posting_lock(:'c2', DATE '2025-12-31', 'Blokkade wordt gezet');

-- B probeert binnen de aanstaande blokkade te boeken.
SELECT dblink_send_query('b', format('SELECT public.post_manual_journal(%L)', :'j2'));

SELECT pg_sleep(0.5);

SELECT proof.record('29', 'de boeking is niet stiekem langs de lopende blokkadewijziging geglipt',
  (SELECT count(*) FROM public.ledger_postings WHERE client_id = :'c2') = 0);

COMMIT;

SELECT proof.record('30', 'en na de commit weigert die boeking op de blokkade',
  (SELECT count(*) FROM public.ledger_postings WHERE client_id = :'c2') = 0
    AND (SELECT posting_locked_through FROM public.clients WHERE id = :'c2') = DATE '2025-12-31');

SELECT dblink_disconnect('b');
