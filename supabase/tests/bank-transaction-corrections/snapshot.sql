-- NULMETING — vóór 20261018120000. Throwaway database only.
-- Elke bestaande functie (lichaam, rechten, eigenaar, eigenschappen), elke
-- bestaande trigger en elke grootboekregel wordt vastgelegd; final.sql en
-- proof.sql toetsen dat PR 1 daar niets aan verandert.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE TABLE proof.functions_before AS
SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS body, p.prosecdef, p.provolatile,
       coalesce(p.proconfig::text, '') AS config, pg_get_userbyid(p.proowner) AS owner, coalesce(p.proacl::text, '') AS acl
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;

CREATE TABLE proof.triggers_before AS
SELECT t.tgrelid::regclass::text AS tbl, t.tgname, t.tgenabled::text AS enabled, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace;

CREATE TABLE proof.relations_before AS
SELECT c.oid::regclass::text AS rel, c.relkind::text AS kind, coalesce(c.relacl::text, '') AS acl,
       c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace;

CREATE TABLE proof.policies_before AS
SELECT polrelid::regclass::text AS rel, polname, polcmd::text AS cmd, polroles::text AS roles,
       coalesce(pg_get_expr(polqual, polrelid), '') AS qual, coalesce(pg_get_expr(polwithcheck, polrelid), '') AS chk
FROM pg_policy;

CREATE TABLE proof.ledger_before AS SELECT * FROM public.ledger_postings;
CREATE TABLE proof.reversals_before AS SELECT * FROM public.ledger_reversal_postings;

INSERT INTO proof.state VALUES
  ('ledger_writers_before',
   (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND prosrc ILIKE '%INSERT INTO public.ledger_postings%')),
  ('digest_before_migration', proof.digest());

GRANT SELECT ON ALL TABLES IN SCHEMA proof TO public;
