-- NULMETING — vlak vóór PR 0. Throwaway database only.
--
-- Draait als laatste stap vóór de migratie (na pre.sql en concurrency-pre.sql),
-- zodat M1–M4 in proof.sql kunnen bewijzen dat de migratie zelf geen data,
-- geen bestaande functie, trigger of tabelrecht heeft aangeraakt.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- N8: data en catalogus.
INSERT INTO proof.state VALUES ('digest_before_pr0', proof.digest());
INSERT INTO proof.state
SELECT 'functions_before_pr0', string_agg(p.oid::regprocedure::text, ';' ORDER BY p.oid::regprocedure::text)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';
INSERT INTO proof.state
SELECT 'triggers_before_pr0', string_agg(c.relname || '.' || t.tgname || ':' || t.tgenabled::text, ';' ORDER BY c.relname, t.tgname)
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal;
INSERT INTO proof.state
SELECT 'acl_before_pr0', md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), ',' ORDER BY c.relname))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');
SELECT proof.record('N8', 'nulmeting vastgelegd', true,
  (SELECT string_agg(key, ', ' ORDER BY key) FROM proof.state));

-- Volledige kopie van het grootboek, voor het append-only-bewijs (I5).
CREATE TABLE proof.ledger_before AS SELECT * FROM public.ledger_postings;
