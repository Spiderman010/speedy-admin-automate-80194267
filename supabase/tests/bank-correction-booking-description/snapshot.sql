-- NULMETING vóór PR 2 — throwaway database only.
--
-- De volledige catalogus (functies, triggers, relaties, policies, constraints,
-- indexen, commentaar) en de data, zodat na de migratie precies kan worden
-- getoetst wat er veranderde: alleen het lichaam (en het commentaar) van
-- reclassify_bank_transaction, en geen enkele rij.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE TABLE proof.cat_functions AS
SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS body, p.prosecdef, p.provolatile::text AS vol,
       coalesce(p.proconfig::text, '') AS config, pg_get_userbyid(p.proowner) AS owner, coalesce(p.proacl::text, '') AS acl,
       pg_get_function_result(p.oid) AS result
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;

CREATE TABLE proof.cat_triggers AS
SELECT t.tgrelid::regclass::text AS tbl, t.tgname::text, t.tgenabled::text, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t WHERE NOT t.tgisinternal;

CREATE TABLE proof.cat_relations AS
SELECT c.oid::regclass::text AS rel, c.relkind::text, coalesce(c.relacl::text, '') AS acl, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace;

CREATE TABLE proof.cat_policies AS
SELECT polrelid::regclass::text AS tbl, polname::text, polcmd::text, polroles::text,
       coalesce(pg_get_expr(polqual, polrelid), '') AS qual, coalesce(pg_get_expr(polwithcheck, polrelid), '') AS chk
FROM pg_policy;

CREATE TABLE proof.cat_constraints AS
SELECT conrelid::regclass::text AS tbl, conname::text, pg_get_constraintdef(oid) AS def
FROM pg_constraint WHERE connamespace = 'public'::regnamespace;

CREATE TABLE proof.cat_indexes AS
SELECT indexrelid::regclass::text AS idx, pg_get_indexdef(indexrelid) AS def
FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace;

CREATE TABLE proof.cat_comments AS
SELECT d.objoid::regprocedure::text AS sig, d.description
FROM pg_description d WHERE d.classoid = 'pg_proc'::regclass AND d.objsubid = 0
  AND d.objoid IN (SELECT oid FROM pg_proc WHERE pronamespace = 'public'::regnamespace);

GRANT SELECT ON ALL TABLES IN SCHEMA proof TO public;

SELECT proof.put('digest_before_migration', proof.digest());
SELECT proof.put('rest_before_migration', proof.rest_digest());
SELECT proof.put('descriptions_before_migration',
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(encode(convert_to(description, 'UTF8'), 'hex'), '∅'), ',' ORDER BY id), ''))
   FROM public.bank_transactions));
