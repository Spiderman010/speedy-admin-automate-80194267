-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist
-- database. See run-proof.sh.
--
-- Draait VÓÓR de migratie onder test, na ../year-close/fixtures.sql,
-- ../posting-lock-enforced/fixtures.sql en ../fiscal-year-reopen/fixtures.sql.
-- Alleen hulpfuncties: de catalogus lezen, hashes en rechten vastleggen, en
-- heropenen als een bepaalde gebruiker.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS proof.snap (k text PRIMARY KEY, v text);
CREATE TABLE IF NOT EXISTS proof.subject (rol text PRIMARY KEY, client_id uuid NOT NULL);

/* De lichaamshash van één publieke functie (NULL als zij ontbreekt). */
CREATE OR REPLACE FUNCTION proof.hash(_name text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = _name LIMIT 1
$$;

/* Eigenaar, SECURITY DEFINER, search_path en de volledige ACL van één functie. */
CREATE OR REPLACE FUNCTION proof.acl(_name text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT format('%s|%s|%s|%s', p.proowner::regrole, p.prosecdef,
                COALESCE(array_to_string(p.proconfig, ','), ''), COALESCE(p.proacl::text, 'default'))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = _name LIMIT 1
$$;

/* Alle publieke functienamen, als één gesorteerde lijst. */
CREATE OR REPLACE FUNCTION proof.function_set() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ',' ORDER BY p.proname, p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
$$;

/* Een digest van een hele tabel, op rijvolgorde van de primaire sleutel. */
CREATE OR REPLACE FUNCTION proof.table_digest(_table regclass) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  EXECUTE format('SELECT COALESCE(md5(string_agg(t::text, %L ORDER BY t::text)), %L) FROM %s t', '|', 'leeg', _table) INTO v;
  RETURN v;
END $$;

/* De blokkade van één administratie. */
CREATE OR REPLACE FUNCTION proof.lock_of(_client uuid) RETURNS date
LANGUAGE sql STABLE AS $$ SELECT posting_locked_through FROM public.clients WHERE id = _client $$;

/* Heropenen als een bepaalde gebruiker; geeft `reopened` terug. */
CREATE OR REPLACE FUNCTION proof.reopen_as(_uid uuid, _client uuid, _year integer, _reason text DEFAULT 'Correctie')
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v boolean;
BEGIN
  PERFORM set_config('test.user_id', _uid::text, true);
  SELECT r.reopened INTO v FROM public.reopen_fiscal_year(_client, _year, _reason) r;
  RETURN v;
END $$;

/* Waarde vastleggen / vergelijken. */
CREATE OR REPLACE FUNCTION proof.snap_put(_k text, _v text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO proof.snap VALUES (_k, _v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v
$$;
CREATE OR REPLACE FUNCTION proof.snap_get(_k text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT v FROM proof.snap WHERE k = _k $$;

/* De acht functies die deze migratie herdefinieert, en de zeven die niet. */
CREATE OR REPLACE FUNCTION proof.changed_functions() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['post_purchase_invoice','post_sales_invoice','post_bank_allocation','post_manual_journal',
               'post_opening_balance','reverse_posting_group','post_bank_transaction','bank_bulk_posting_candidates']
$$;
CREATE OR REPLACE FUNCTION proof.untouched_functions() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['declare_opening_balance_nil','assert_posting_allowed','posting_allowed','set_posting_lock',
               'enforce_posting_lock_change','close_fiscal_year','reopen_fiscal_year',
               'enforce_year_close_watermark','prevent_year_closure_mutation','post_bank_transactions_bulk']
$$;

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
