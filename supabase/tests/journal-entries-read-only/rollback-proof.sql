-- REAL POSTGRESQL PROOF — the documented ROLLBACK of 20260930120000 restores
-- the pre-migration state EXACTLY. Throwaway cluster only; see run-proof.sh.
--
-- run-proof.sh runs the rollback block from the migration header (between
-- ROLLBACK-BEGIN and ROLLBACK-END) verbatim, then these proofs compare the
-- result against the snapshot taken in pre-proof.sql. A rollback that restores
-- only part of the ACL or only some policies fails here.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

/* Een ACL als verzameling (volgorde telt niet: PostgreSQL voegt een hertoegekende rol achteraan toe). */
CREATE OR REPLACE FUNCTION proof.acl_set(_acl text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg(a::text ORDER BY a::text), '{}') FROM unnest(_acl::aclitem[]) a
$$;

SELECT proof.record('R1', 'rollback: de tabel-ACL bevat exact dezelfde toekenningen als vóór de migratie',
  proof.acl_set((SELECT relacl::text FROM pg_class WHERE oid = 'public.journal_entries'::regclass))
    = proof.acl_set((SELECT acl FROM proof.tbl_acl_before WHERE relname = 'journal_entries')),
  (SELECT relacl::text FROM pg_class WHERE oid = 'public.journal_entries'::regclass)
    || ' | voor: ' || (SELECT acl FROM proof.tbl_acl_before WHERE relname = 'journal_entries'));

SELECT proof.record('R2', 'rollback: per rol exact dezelfde rechten (anon, authenticated, service_role, PUBLIC)',
  NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
    WHERE has_table_privilege(r, 'public.journal_entries', p)
          IS DISTINCT FROM (position(
            CASE p WHEN 'SELECT' THEN 'r' WHEN 'INSERT' THEN 'a' WHEN 'UPDATE' THEN 'w' WHEN 'DELETE' THEN 'd'
                   WHEN 'TRUNCATE' THEN 'D' WHEN 'REFERENCES' THEN 'x' ELSE 't' END
            IN COALESCE(substring((SELECT acl FROM proof.tbl_acl_before WHERE relname = 'journal_entries')
                                  FROM '[{,]' || r || '=([a-zA-Z]*)/'), '')) > 0))
  AND (SELECT relacl::text FROM pg_class WHERE oid = 'public.journal_entries'::regclass) !~ '[{,]=');

SELECT proof.record('R3', 'rollback: de policies zijn exact die van vóór de migratie (alle vier, inclusief tekst)',
  NOT EXISTS (
    (SELECT policyname, cmd, roles, qual, with_check FROM proof.pol_before WHERE tablename = 'journal_entries'
     EXCEPT SELECT policyname, cmd, roles::text, qual, with_check FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'journal_entries')
    UNION ALL
    (SELECT policyname, cmd, roles::text, qual, with_check FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'journal_entries'
     EXCEPT SELECT policyname, cmd, roles, qual, with_check FROM proof.pol_before WHERE tablename = 'journal_entries')),
  (SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'journal_entries'));

SELECT proof.record('R4', 'rollback: RLS staat aan en de regels zijn onaangeroerd',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.journal_entries'::regclass)
    AND (SELECT md5(string_agg(j::text, '|' ORDER BY j.id)) FROM public.journal_entries j) = (SELECT digest FROM proof.rows_before));

SELECT proof.record('R5', 'rollback: geen andere tabel-ACL of policy is geraakt',
  NOT EXISTS (
    SELECT 1 FROM proof.tbl_acl_before b JOIN pg_class c ON c.relname = b.relname AND c.relnamespace = 'public'::regnamespace
    WHERE b.relname <> 'journal_entries' AND COALESCE(c.relacl::text, '(default)') <> b.acl)
  AND NOT EXISTS (
    (SELECT tablename, policyname, cmd, roles, qual, with_check FROM proof.pol_before WHERE tablename <> 'journal_entries'
     EXCEPT SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
            WHERE schemaname = 'public' AND tablename <> 'journal_entries')));

-- De rollback is idempotent: nog een keer toepassen verandert niets (run-proof.sh doet dat vóór R6).
SELECT proof.record('R6', 'rollback is idempotent (twee keer toegepast, zelfde uitkomst als R1/R3)',
  proof.acl_set((SELECT relacl::text FROM pg_class WHERE oid = 'public.journal_entries'::regclass))
    = proof.acl_set((SELECT acl FROM proof.tbl_acl_before WHERE relname = 'journal_entries'))
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'journal_entries') = 4);
