-- TEST DOUBLE — NOT A MIGRATION. Throwaway database only. Never run this
-- against any BoekAssist database.
--
-- Draait na ../opening-balance/bootstrap.sql, ../bank-transaction-posting/
-- bootstrap-extra.sql (bank_transactions in de echte vorm) en
-- ../year-close/fixtures.sql (organisaties, gebruikers, rollen, proof.record),
-- en VÓÓR de migratie onder test.
--
-- 1. De schrijfrechten op bank_transactions zoals in productie.
--    bootstrap-extra.sql geeft authenticated alleen SELECT en alleen de
--    leespolicy (die harnassen schrijven als eigenaar). Een import schrijft als
--    authenticated, dus hier staan de drie overige rolpolicies LETTERLIJK zoals
--    20260613001452 ze aanmaakt (insert/update vanaf assistant, delete vanaf
--    accountant) en het tabelrecht dat Supabase authenticated geeft. Dit is de
--    toestand waarvan de migratie moet afblijven.
-- 2. Historische rijen, zonder vingerafdruk, met precies de gevallen die de
--    migratie NIET mag blokkeren of laten falen:
--      • twee echt verschillende, maar op inhoud identieke betalingen
--        (zelfde administratie, datum, bedrag, omschrijving, tegenrekening,
--        referentie) — 'parkeren';
--      • een bestaande dubbele import: dezelfde afschriftregel twee keer, met
--        dezelfde bankreferentie na '//';
--      • rijen in een tweede administratie en in een andere organisatie.
-- 3. De nulmeting: data (inhoud, ctid, xmin), relfilenode, policies, relacl.
-- 4. Hulpfuncties: proof.fp(), proof.attempt() (SQLSTATE-uitkomst),
--    proof.timed_insert() en de dblink-sessies voor de echte gelijktijdigheid.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

-- ── 1. schrijfrechten zoals in productie (20260613001452) ───────────────────
CREATE POLICY role_bank_transactions_insert ON public.bank_transactions FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_bank_transactions_update ON public.bank_transactions FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_bank_transactions_delete ON public.bank_transactions FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bank_transactions TO authenticated;
GRANT ALL ON public.bank_transactions TO service_role;

-- ── 2. administraties en historische rijen ──────────────────────────────────
INSERT INTO public.clients (id, organization_id, name) VALUES
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', 'Administratie A'),
  ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-00000000a001', 'Administratie B'),
  ('00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-00000000a002', 'Administratie andere organisatie');

-- Expliciet organization_id: bootstrap-extra.sql zet de afleidingstrigger niet neer.
INSERT INTO public.bank_transactions
  (id, user_id, client_id, organization_id, transaction_date, description, amount, counter_account, reference,
   match_status, created_at, updated_at)
VALUES
  -- twee verschillende parkeerbetalingen, op inhoud identiek
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000c0001',
   '00000000-0000-0000-0000-00000000a001', '2026-03-02', 'PARKEREN Q-PARK', -4.50, 'NL00BANK0000000001', NULL,
   'niet_gematcht', '2026-03-03 09:00:00+00', '2026-03-03 09:00:00+00'),
  ('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000c0001',
   '00000000-0000-0000-0000-00000000a001', '2026-03-02', 'PARKEREN Q-PARK', -4.50, 'NL00BANK0000000001', NULL,
   'niet_gematcht', '2026-03-03 09:00:00+00', '2026-03-03 09:00:00+00'),
  -- een bestaande dubbele import: dezelfde regel, dezelfde bankreferentie
  ('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000c0001',
   '00000000-0000-0000-0000-00000000a001', '2026-03-05', 'HUUR MAART', -1250.00, 'NL00BANK0000000002', 'NTRFNONREF//BANKREF-0001',
   'niet_gematcht', '2026-03-06 10:00:00+00', '2026-03-06 10:00:00+00'),
  ('00000000-0000-0000-0000-00000000b004', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000c0001',
   '00000000-0000-0000-0000-00000000a001', '2026-03-05', 'HUUR MAART', -1250.00, 'NL00BANK0000000002', 'NTRFNONREF//BANKREF-0001',
   'niet_gematcht', '2026-03-06 10:05:00+00', '2026-03-06 10:05:00+00'),
  -- gewone rijen
  ('00000000-0000-0000-0000-00000000b005', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000c0001',
   '00000000-0000-0000-0000-00000000a001', '2026-03-07', 'FACTUUR 2026-014', 605.00, 'NL00BANK0000000003', 'NTRF2026-014//BANKREF-0002',
   'gematcht', '2026-03-08 08:00:00+00', '2026-03-09 08:00:00+00'),
  ('00000000-0000-0000-0000-00000000b006', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000c0002',
   '00000000-0000-0000-0000-00000000a001', '2026-03-02', 'PARKEREN Q-PARK', -4.50, 'NL00BANK0000000001', NULL,
   'niet_gematcht', '2026-03-03 09:00:00+00', '2026-03-03 09:00:00+00'),
  ('00000000-0000-0000-0000-00000000b007', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000c0003',
   '00000000-0000-0000-0000-00000000a002', '2026-03-05', 'HUUR MAART', -1250.00, 'NL00BANK0000000002', 'NTRFNONREF//BANKREF-0001',
   'niet_gematcht', '2026-03-06 10:00:00+00', '2026-03-06 10:00:00+00');

-- ── 3. nulmeting ────────────────────────────────────────────────────────────
CREATE TABLE proof.state (k text PRIMARY KEY, v text);
GRANT SELECT ON proof.state TO public;

/** Inhoud van de opgegeven rijen, zonder de nieuwe kolom: vóór en ná vergelijkbaar. */
CREATE FUNCTION proof.digest(_ids uuid[] DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(coalesce(string_agg((to_jsonb(t) - 'import_fingerprint')::text, '|' ORDER BY t.id), ''))
  FROM public.bank_transactions t
  WHERE _ids IS NULL OR t.id = ANY (_ids)
$$;

/** Fysieke identiteit van de rijen: een herschrijving of UPDATE verandert ctid/xmin. */
CREATE FUNCTION proof.physical(_ids uuid[] DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(coalesce(string_agg(t.id::text || '@' || t.ctid::text || '#' || t.xmin::text, '|' ORDER BY t.id), ''))
  FROM public.bank_transactions t
  WHERE _ids IS NULL OR t.id = ANY (_ids)
$$;

CREATE FUNCTION proof.policies()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', policyname, permissive, roles, cmd, qual, with_check),
                             E'\n' ORDER BY policyname), '')
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_transactions'
$$;

CREATE FUNCTION proof.acl()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT format('relacl=%s rls=%s force=%s owner=%s', c.relacl::text, c.relrowsecurity, c.relforcerowsecurity,
                c.relowner::regrole)
  FROM pg_class c WHERE c.oid = 'public.bank_transactions'::regclass
$$;

/** Catalogusvoetafdruk van de tabel buiten de drie nieuwe objecten. */
CREATE FUNCTION proof.catalog_rest()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(concat_ws(E'\n',
    (SELECT string_agg(format('%s %s %s %s', attname, format_type(atttypid, atttypmod), attnotnull, attnum), ',' ORDER BY attnum)
     FROM pg_attribute WHERE attrelid = 'public.bank_transactions'::regclass AND attnum > 0 AND NOT attisdropped
       AND attname <> 'import_fingerprint'),
    (SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), ',' ORDER BY conname)
     FROM pg_constraint WHERE conrelid = 'public.bank_transactions'::regclass
       AND conname <> 'bank_transactions_import_fingerprint_format'),
    (SELECT string_agg(pg_get_indexdef(indexrelid), ',' ORDER BY indexrelid::regclass::text)
     FROM pg_index WHERE indrelid = 'public.bank_transactions'::regclass
       AND indexrelid <> coalesce(to_regclass('public.bank_transactions_client_import_fingerprint_key'), 0)),
    (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
     WHERE tgrelid = 'public.bank_transactions'::regclass AND NOT tgisinternal),
    (SELECT string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), ',' ORDER BY c.relname)
     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')),
    (SELECT count(*)::text FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind <> 'i'),
    (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace)))
$$;

INSERT INTO proof.state
SELECT 'historical_ids', array_agg(id ORDER BY id)::text FROM public.bank_transactions;
INSERT INTO proof.state VALUES
  ('rows_before',     (SELECT count(*)::text FROM public.bank_transactions)),
  ('digest_before',   proof.digest()),
  ('physical_before', proof.physical()),
  ('relfilenode_before', (SELECT relfilenode::text FROM pg_class WHERE oid = 'public.bank_transactions'::regclass)),
  ('policies_before', proof.policies()),
  ('acl_before',      proof.acl()),
  ('catalog_before',  proof.catalog_rest());

CREATE FUNCTION proof.historical()
RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT v::uuid[] FROM proof.state WHERE k = 'historical_ids' $$;

-- ── 4. hulpfuncties ─────────────────────────────────────────────────────────

/** Een geldige vingerafdruk: SHA-256 (hex, kleine letters) van een label. */
CREATE FUNCTION proof.fp(_label text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(convert_to(_label, 'UTF8')), 'hex') $$;

/** Voer SQL uit en geef 'ok' of 'SQLSTATE: melding' terug; de transactie blijft bruikbaar. */
CREATE FUNCTION proof.attempt(_sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE _sql;
  RETURN 'ok';
EXCEPTION WHEN others THEN
  RETURN SQLSTATE || ': ' || SQLERRM;
END $$;

/** Eén afschriftregel in administratie A (of _client), zoals de import haar schrijft. */
CREATE FUNCTION proof.import_sql(_fp text, _description text DEFAULT 'PARKEREN Q-PARK',
                                 _client uuid DEFAULT '00000000-0000-0000-0000-0000000c0001',
                                 _org uuid DEFAULT '00000000-0000-0000-0000-00000000a001',
                                 _user uuid DEFAULT '00000000-0000-0000-0000-0000000000e2')
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT format($f$INSERT INTO public.bank_transactions
      (user_id, client_id, organization_id, transaction_date, description, amount, counter_account, reference, import_fingerprint)
    VALUES (%L, %L, %L, '2026-03-02', %L, -4.50, 'NL00BANK0000000001', NULL, %s)$f$,
    _user, _client, _org, _description, coalesce(quote_literal(_fp), 'NULL'))
$$;

/** In een sessie: start, poging, einde, met tijdstempels. Vorm: 'start|einde|uitkomst'. */
CREATE FUNCTION proof.timed_insert(_fp text, _description text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_start timestamptz := clock_timestamp(); v_out text;
BEGIN
  v_out := proof.attempt(proof.import_sql(_fp, _description));
  RETURN format('%s|%s|%s', v_start, clock_timestamp(), v_out);
END $$;

-- ── twee echte sessies (dblink), als authenticated assistent ────────────────
CREATE FUNCTION proof.open_session(_name text, _conn text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dblink_connect(_name, _conn);
  PERFORM dblink_exec(_name, 'SET client_min_messages = warning');
  PERFORM dblink_exec(_name, 'SET statement_timeout = ''20s''');
  PERFORM dblink_exec(_name, 'SET lock_timeout = ''20s''');
  PERFORM * FROM dblink(_name, $q$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false)$q$) AS t(x text);
  PERFORM dblink_exec(_name, 'SET ROLE authenticated');
END $$;

CREATE FUNCTION proof.remote_run(_conn text, _sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  SELECT x INTO v FROM dblink(_conn, _sql) AS t(x text);
  RETURN 'ok: ' || coalesce(v, '');
EXCEPTION WHEN query_canceled OR others THEN
  RETURN format('fout [%s] %s', SQLSTATE, SQLERRM);
END $$;

CREATE FUNCTION proof.remote_outcome(_conn text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text; v_state text; v_msg text;
BEGIN
  BEGIN
    SELECT x INTO v FROM dblink_get_result(_conn) AS t(x text);
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
    RETURN 'ok: ' || coalesce(v, '');
  EXCEPTION WHEN query_canceled OR others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
  EXCEPTION WHEN query_canceled OR others THEN NULL;
  END;
  RETURN format('fout [%s] %s', v_state, v_msg);
END $$;

GRANT USAGE ON SCHEMA proof TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;
