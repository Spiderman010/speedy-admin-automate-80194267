-- REAL POSTGRESQL PROOF — part 1, run BEFORE the migration under test.
-- Throwaway cluster only. Never run this against any BoekAssist database.
--
-- Creates the result schema and the assertion helpers (same shape as
-- supabase/tests/opening-balance/proof.sql), inserts "existing" rows with the
-- categorie values production is known to carry — including a free-text one —
-- and snapshots everything the migration must leave untouched: the rows, the
-- table's relfilenode (a rewrite would change it), and the counts of
-- constraints, triggers, indexes and policies on the table.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

DROP SCHEMA IF EXISTS proof CASCADE;
CREATE SCHEMA proof;
GRANT USAGE ON SCHEMA proof TO public;

CREATE TABLE proof.result (
  n      text,
  name   text,
  ok     boolean,
  detail text
);
GRANT INSERT, SELECT ON proof.result TO public;

CREATE OR REPLACE FUNCTION proof.expect_error(_n text, _name text, _sql text, _needle text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_msg text;
BEGIN
  BEGIN
    EXECUTE _sql;
    INSERT INTO proof.result VALUES (_n, _name, false, 'GEEN fout, terwijl een fout werd verwacht');
    RETURN;
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;
  IF position(lower(_needle) IN lower(v_msg)) > 0 THEN
    INSERT INTO proof.result VALUES (_n, _name, true, v_msg);
  ELSE
    INSERT INTO proof.result VALUES (_n, _name, false, format('andere fout dan verwacht (%s): %s', _needle, v_msg));
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION proof.expect_ok(_n text, _name text, _sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE _sql;
  INSERT INTO proof.result VALUES (_n, _name, true, 'uitgevoerd zonder fout');
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('onverwachte fout: %s', SQLERRM));
END
$$;

-- _expr is a boolean SQL expression.
CREATE OR REPLACE FUNCTION proof.expect_true(_n text, _name text, _expr text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  EXECUTE format('SELECT (%s)', _expr) INTO v_ok;
  INSERT INTO proof.result VALUES (_n, _name, COALESCE(v_ok, false), COALESCE(v_ok::text, 'NULL'));
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('fout bij evaluatie: %s', SQLERRM));
END
$$;

-- Evaluates the CHECK expression of one named constraint, as stored in the
-- catalog, against a single literal row — so each constraint can be judged in
-- isolation and, crucially, its result can be told apart as TRUE / FALSE /
-- NULL (a NULL result would make PostgreSQL ACCEPT the row).
CREATE OR REPLACE FUNCTION proof.eval_check(_conname text, _statement_type text, _report_group text, _normal_side text, _report_sort integer)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_expr text; v_res boolean;
BEGIN
  SELECT regexp_replace(pg_get_constraintdef(oid), '^CHECK\s*', '') INTO v_expr
  FROM pg_constraint WHERE conrelid = 'public.grootboekrekeningen'::regclass AND conname = _conname;
  IF v_expr IS NULL THEN RETURN 'constraint ontbreekt'; END IF;
  EXECUTE format('SELECT %s FROM (VALUES ($1::text, $2::text, $3::text, $4::integer)) AS r(statement_type, report_group, normal_side, report_sort)', v_expr)
    INTO v_res USING _statement_type, _report_group, _normal_side, _report_sort;
  RETURN COALESCE(v_res::text, 'NULL');
END
$$;

GRANT EXECUTE ON FUNCTION proof.eval_check(text, text, text, text, integer) TO public;
GRANT EXECUTE ON FUNCTION proof.expect_error(text, text, text, text) TO public;
GRANT EXECUTE ON FUNCTION proof.expect_ok(text, text, text) TO public;
GRANT EXECUTE ON FUNCTION proof.expect_true(text, text, text) TO public;

-- ── "existing" data, as production carries it ───────────────────────────────

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-00000000aaaa', 'u1@test.local'),
  ('00000000-0000-0000-0000-00000000bbbb', 'u2@test.local');

-- The seed's five values, a free-text value, the "Resultaat" account, an
-- organisation-wide row (client_id NULL) and client-specific rows. No
-- classification column exists yet at this point.
INSERT INTO public.grootboekrekeningen (user_id, client_id, nummer, omschrijving, categorie, actief) VALUES
  ('00000000-0000-0000-0000-00000000aaaa', NULL,                                   1000, 'Kas',                    'activa',  true),
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0001', 1600, 'Crediteuren',            'passiva', true),
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0001', 8000, 'Omzet',                  'omzet',   true),
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0002', 4000, 'Huur',                   'kosten',  true),
  ('00000000-0000-0000-0000-00000000aaaa', NULL,                                    651, 'Privé-stortingen',       'privé',   true),
  ('00000000-0000-0000-0000-00000000aaaa', NULL,                                   4711, 'Vrije tekst categorie',  'Kostem',  false),
  ('00000000-0000-0000-0000-00000000bbbb', NULL,                                   9998, 'Resultaat',              'passiva', true),
  ('00000000-0000-0000-0000-00000000bbbb', NULL,                                   4712, 'Zonder categorie (default)', DEFAULT, true);

-- Snapshot of every existing column of every existing row.
CREATE TABLE proof.rows_before AS
  SELECT id, user_id, client_id, organization_id, nummer, omschrijving, categorie, actief, created_at, updated_at
  FROM public.grootboekrekeningen;

CREATE TABLE proof.meta AS
  SELECT
    (SELECT relfilenode FROM pg_class WHERE oid = 'public.grootboekrekeningen'::regclass)                         AS relfilenode,
    (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.grootboekrekeningen'::regclass)                  AS constraints,
    (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.grootboekrekeningen'::regclass AND NOT tgisinternal) AS triggers,
    (SELECT count(*) FROM pg_index WHERE indrelid = 'public.grootboekrekeningen'::regclass)                       AS indexes,
    (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.grootboekrekeningen'::regclass)                      AS policies,
    (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grootboekrekeningen') AS columns,
    (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grootboekrekeningen' AND column_name = 'categorie') AS categorie_default,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')      AS public_functions;
