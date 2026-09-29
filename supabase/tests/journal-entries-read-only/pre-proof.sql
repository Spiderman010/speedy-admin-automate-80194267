-- REAL POSTGRESQL PROOF — the state BEFORE 20260930120000. Throwaway cluster
-- only; never run this against any BoekAssist database. See run-proof.sh.
--
--   V1-V7  de blootstelling: de database laat schrijven toe, op beide lagen
--   snapshot van alles wat de migratie NIET mag veranderen

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

/* Voer _sql uit en draai het meteen terug; geef 'OK rows=N' of 'SQLSTATE | fout'. */
CREATE OR REPLACE FUNCTION proof.try(_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE n bigint; st text; msg text;
BEGIN
  BEGIN
    EXECUTE _sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '__rollback__' || n;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    IF msg LIKE '\_\_rollback\_\_%' THEN RETURN 'OK rows=' || substr(msg, 13); END IF;
    RETURN st || ' | ' || msg;
  END;
END $$;

CREATE OR REPLACE FUNCTION proof.priv(_role text, _p text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN _p IN ('INSERT', 'UPDATE')
              THEN has_any_column_privilege(_role, 'public.journal_entries', _p)
              ELSE has_table_privilege(_role, 'public.journal_entries', _p) END
$$;

-- ── Snapshots ──────────────────────────────────────────────────────────────

CREATE TABLE proof.rows_before AS
SELECT count(*) AS n, md5(string_agg(j::text, '|' ORDER BY j.id)) AS digest FROM public.journal_entries j;

CREATE TABLE proof.cols_before AS
SELECT a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull,
       pg_get_expr(d.adbin, d.adrelid) AS def
FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = 'public.journal_entries'::regclass AND a.attnum > 0 AND NOT a.attisdropped;

CREATE TABLE proof.cons_before AS
SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
WHERE conrelid = 'public.journal_entries'::regclass;

CREATE TABLE proof.idx_before AS
SELECT indexrelid::regclass::text AS idx, pg_get_indexdef(indexrelid) AS def FROM pg_index
WHERE indrelid = 'public.journal_entries'::regclass;

CREATE TABLE proof.trg_all_before AS
SELECT c.relname, t.tgname, t.tgenabled::text AS enabled, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal;

CREATE TABLE proof.pol_before AS
SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'public';

CREATE TABLE proof.tbl_acl_before AS
SELECT c.relname, COALESCE(c.relacl::text, '(default)') AS acl, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p');

CREATE TABLE proof.fn_before AS
SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS body, p.prosecdef, pg_get_userbyid(p.proowner) AS owner,
       COALESCE(p.proacl::text, '(default)') AS acl
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;

CREATE TABLE proof.owner_before AS
SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'public.journal_entries'::regclass;

-- ── V1-V7: de blootstelling ────────────────────────────────────────────────

SELECT proof.record('V1', 'VOOR: authenticated heeft INSERT, UPDATE, DELETE en TRUNCATE op journal_entries',
  proof.priv('authenticated', 'INSERT') AND proof.priv('authenticated', 'UPDATE')
    AND proof.priv('authenticated', 'DELETE') AND proof.priv('authenticated', 'TRUNCATE'),
  (SELECT relacl::text FROM pg_class WHERE oid = 'public.journal_entries'::regclass));
SELECT proof.record('V2', 'VOOR: de drie schrijfpolicies bestaan (echt uit 20260613001452)',
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'journal_entries'
     AND policyname IN ('role_journal_entries_insert', 'role_journal_entries_update', 'role_journal_entries_delete')) = 3);
SELECT proof.record('V3', 'VOOR: service_role en anon hebben directe schrijfrechten (Supabase-standaard)',
  proof.priv('service_role', 'INSERT') AND proof.priv('service_role', 'DELETE')
    AND proof.priv('anon', 'INSERT') AND proof.priv('anon', 'SELECT'));

SET ROLE authenticated;

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);  -- assistent
SELECT proof.record('V4', 'VOOR: een assistent kan via de API een regel toevoegen',
  proof.try(format(
    'INSERT INTO public.journal_entries (user_id, client_id, organization_id, entry_date, amount) VALUES (%L, %L, %L, DATE ''2025-05-01'', 1.00)',
    '00000000-0000-0000-0000-0000000000e2', (SELECT id FROM proof.ids WHERE k = 'client'),
    '00000000-0000-0000-0000-00000000a001')) = 'OK rows=1');
SELECT proof.record('V5', 'VOOR: een assistent kan alle historische regels wijzigen',
  proof.try('UPDATE public.journal_entries SET description = ''gewijzigd''') = 'OK rows=3');

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);  -- accountant
SELECT proof.record('V6', 'VOOR: een accountant kan alle historische regels verwijderen',
  proof.try('DELETE FROM public.journal_entries') = 'OK rows=3');

RESET ROLE;

SELECT proof.record('V7', 'VOOR: de proeven hierboven hebben niets achtergelaten (3 rijen, ongewijzigd)',
  (SELECT count(*) = 3 AND md5(string_agg(j::text, '|' ORDER BY j.id)) = (SELECT digest FROM proof.rows_before)
   FROM public.journal_entries j));
