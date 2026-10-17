-- ROLLBACK-RONDGANG — na het TWEE keer uitvoeren van het ROLLBACK-blok uit de
-- kop van de migratie. Throwaway database only.
--   R1  de drie guards en hun functies zijn weg — en verder niets
--   R2  de rollback raakte geen data
--   R3  het gat is terug: dezelfde aanval als N1 lukt weer. Dat bewijst dat
--       juist deze drie guards de bescherming dragen (en dat de negatieve
--       controle een ontbrekende guard ook echt zou opmerken).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.expect_true('R1', 'na de rollback: functies en triggers weer exact die van vóór PR 0', $$
  (SELECT string_agg(p.oid::regprocedure::text, ';' ORDER BY p.oid::regprocedure::text)
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
  = (SELECT value FROM proof.state WHERE key = 'functions_before_pr0')
  AND (SELECT string_agg(c.relname || '.' || t.tgname || ':' || t.tgenabled::text, ';' ORDER BY c.relname, t.tgname)
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal)
  = (SELECT value FROM proof.state WHERE key = 'triggers_before_pr0')
$$);

SELECT proof.expect_true('R2', 'de rollback raakte geen enkele rij',
  $$ proof.digest() = (SELECT value FROM proof.state WHERE key = 'digest_before_rollback') $$);

SELECT proof.record('R3', 'zonder de guards is het gat terug: dezelfde aanval als N1 boekt de bank weer dubbel',
  o LIKE 'dubbel: 2 bankregels, netto -200.00%', o)
FROM proof.attack('insert', proof.uid(1000, 1), proof.uid(2000, 1)) o;

SELECT proof.expect_true('R4', 'en ook die aanval liet niets achter',
  $$ proof.digest() = (SELECT value FROM proof.state WHERE key = 'digest_before_rollback') $$);
