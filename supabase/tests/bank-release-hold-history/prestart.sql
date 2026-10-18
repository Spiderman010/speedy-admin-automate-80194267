-- X1 — TRANSACTIES DIE VÓÓR DE EERSTE GEBEURTENIS BEGONNEN (Codex, P2). Throwaway database only.
--
-- created_at is now(): de START van de transactie die de rij schreef. Twee
-- sessies (t en b) beginnen hier vóórdat regel 41 haar eerste gebeurtenis krijgt
-- (een vrijgave), en schrijven pas daarna — in een functionele rollback-
-- tussentijd zonder PR 1: t boekt 41 opnieuw (G_A), b storneert G_A op de
-- transactiedatum, haalt de marker weg en boekt opnieuw. Alle created_at van
-- G_A, haar storno en claim liggen dan vóór de eerste gebeurtenis; hun
-- created_xact_id (toegekend bij de eerste schrijfactie) niet. xid-check.sql
-- toetst dat de hulpfunctie G_A niet als geschiedenis telt.
-- :'rbfix', :'rb2', :'rb1' = de drie rollbacks, letterlijk (fix, PR 2, PR 1).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.open_session('t', :'conn');
SELECT proof.open_session('b', :'conn');

-- Beide beginnen nu; ze lezen niets en schrijven niets, en houden dus geen grendel.
SELECT dblink_exec('t', 'BEGIN'), dblink_exec('b', 'BEGIN');
SELECT proof.put('x_t0', x) FROM dblink('t', 'SELECT now()::text') AS r(x text);
SELECT proof.put('x_b0', x) FROM dblink('b', 'SELECT now()::text') AS r(x text);
SELECT pg_sleep(0.05);

-- De eerste gebeurtenis van 41.
SELECT proof.put('x_rel41', proof.rel(proof.u(1), proof.uid(1000, 41), proof.m(41), proof.req(41901), 'Vrijgeven'));

-- De functionele rollback, in de gedocumenteerde volgorde.
:rbfix
:rb2
:rb1

-- t boekt de vrijgegeven regel via de gewone werkstroom.
SELECT proof.put('x_t_code', proof.remote_run('t', 'SELECT proof.app_code(41)'));
SELECT proof.put('x_t_post', proof.remote_run('t', 'SELECT proof.app_post(41)'));
SELECT proof.put('x_t_commit', proof.remote_exec('t', 'COMMIT'));

-- b storneert die boeking op de transactiedatum, haalt de marker weg en boekt opnieuw.
SELECT proof.put('x_ga', proof.m(41)::text);
SELECT proof.put('x_b_rev', proof.remote_run('b', format('SELECT public.reverse_posting_group(%L, DATE ''2025-11-25'', ''Storno in de tussentijd'')::text', proof.get('x_ga'))));
SELECT proof.put('x_b_unmark', proof.remote_exec('b', format('DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = %L', proof.uid(1000, 41))));
SELECT proof.put('x_b_post', proof.remote_run('b', format('SELECT public.post_bank_transaction(%L)::text', proof.uid(1000, 41))));
SELECT proof.put('x_b_commit', proof.remote_exec('b', 'COMMIT'));

SELECT dblink_disconnect('t'), dblink_disconnect('b');
