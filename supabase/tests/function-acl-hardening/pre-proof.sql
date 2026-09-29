-- REAL POSTGRESQL PROOF — the state BEFORE 20260929120000. Throwaway cluster
-- only; never run this against any BoekAssist database. See run-proof.sh.
--
-- Twee dingen gebeuren hier:
--   1. de blootstelling uit productie wordt AANGETOOND (V1-V9), zodat het
--      na-bewijs niet slaagt over een toestand die nooit open stond;
--   2. een momentopname van elke functie en elke tabel in `public` wordt
--      vastgelegd, zodat het na-bewijs kan laten zien dat de migratie verder
--      NIETS verandert.
--
-- De indeling die het hele bewijs draagt:
--   INTERN      — alleen de eigenaar mag ze uitvoeren
--   TOEGANG     — bewuste /rpc-toegangspunten voor authenticated

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE TABLE proof.fn_class (sig text PRIMARY KEY, klasse text NOT NULL CHECK (klasse IN ('intern', 'toegang')));
INSERT INTO proof.fn_class VALUES
  ('public.lock_ledger_client(uuid)',                    'intern'),
  ('public.ledger_client_lock_key(uuid)',                'intern'),
  ('public.posting_allowed(uuid,date)',                  'intern'),
  ('public.assert_posting_allowed(uuid,date)',           'intern'),
  ('public.post_purchase_invoice(uuid)',                 'toegang'),
  ('public.post_sales_invoice(uuid)',                    'toegang'),
  ('public.post_bank_allocation(uuid)',                  'toegang'),
  ('public.post_manual_journal(uuid)',                   'toegang'),
  ('public.post_opening_balance(uuid)',                  'toegang'),
  ('public.declare_opening_balance_nil(uuid)',           'toegang'),
  ('public.reverse_posting_group(uuid,date,text)',       'toegang'),
  ('public.post_bank_transaction(uuid)',                 'toegang'),
  ('public.post_bank_transactions_bulk(uuid[])',         'toegang'),
  ('public.bank_bulk_posting_candidates(uuid,integer)',  'toegang'),
  ('public.close_fiscal_year(uuid,integer)',             'toegang'),
  ('public.set_posting_lock(uuid,date,text)',            'toegang');

/* Mag deze rol deze functie uitvoeren? */
CREATE FUNCTION proof.can(_role text, _sig text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT has_function_privilege(_role, to_regprocedure(_sig), 'EXECUTE')
$$;

-- ── Momentopnamen ──────────────────────────────────────────────────────────

CREATE TABLE proof.fn_before AS
SELECT p.oid::regprocedure::text AS sig,
       md5(p.prosrc)             AS body_md5,
       p.prosecdef, p.provolatile::text AS vol,
       array_to_string(p.proconfig, ',') AS config,
       pg_get_userbyid(p.proowner) AS owner,
       pg_get_function_result(p.oid) AS result,
       COALESCE(p.proacl::text, '(default)') AS acl
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace;

CREATE TABLE proof.tbl_before AS
SELECT c.relname, c.relkind::text AS relkind,
       COALESCE(c.relacl::text, '(default)') AS acl,
       c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p');

CREATE TABLE proof.col_acl_before AS
SELECT c.relname, a.attname, a.attacl::text AS acl
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL;

CREATE TABLE proof.pol_before AS
SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
FROM pg_policies WHERE schemaname = 'public';

CREATE TABLE proof.trg_before AS
SELECT c.relname, t.tgname, t.tgenabled::text AS enabled, t.tgfoid::regproc::text AS fn
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal;

CREATE TABLE proof.defacl_before AS
SELECT pg_get_userbyid(defaclrole) AS role, defaclnamespace, defaclobjtype::text AS objtype, defaclacl::text AS acl
FROM pg_default_acl;

-- ── V1-V9: de blootstelling, zoals in productie ────────────────────────────

SELECT proof.record('V1', 'VOOR: anon kan lock_ledger_client uitvoeren (de productiebevinding)',
  proof.can('anon', 'public.lock_ledger_client(uuid)'));
SELECT proof.record('V2', 'VOOR: authenticated kan lock_ledger_client uitvoeren (de productiebevinding)',
  proof.can('authenticated', 'public.lock_ledger_client(uuid)'));
SELECT proof.record('V3', 'VOOR: anon en authenticated kunnen posting_allowed uitvoeren (de productiebevinding)',
  proof.can('anon', 'public.posting_allowed(uuid,date)')
    AND proof.can('authenticated', 'public.posting_allowed(uuid,date)'));
SELECT proof.record('V4', 'VOOR: ledger_client_lock_key heeft dezelfde directe toekenningen',
  proof.can('anon', 'public.ledger_client_lock_key(uuid)')
    AND proof.can('authenticated', 'public.ledger_client_lock_key(uuid)')
    AND proof.can('service_role', 'public.ledger_client_lock_key(uuid)'),
  (SELECT acl FROM proof.fn_before WHERE sig = 'ledger_client_lock_key(uuid)'));
SELECT proof.record('V5', 'VOOR: de oorzaak is directe toekenning, niet PUBLIC (PUBLIC is al ingetrokken)',
  (SELECT acl FROM proof.fn_before WHERE sig = 'lock_ledger_client(uuid)') LIKE '%anon=X/%'
    AND (SELECT acl FROM proof.fn_before WHERE sig = 'lock_ledger_client(uuid)') NOT LIKE '%{=X/%'
    AND (SELECT acl FROM proof.fn_before WHERE sig = 'lock_ledger_client(uuid)') NOT LIKE '%,=X/%',
  (SELECT acl FROM proof.fn_before WHERE sig = 'lock_ledger_client(uuid)'));
SELECT proof.record('V6', 'VOOR: post_purchase_invoice is onvolledig vastgezet (anon en service_role kunnen erbij)',
  proof.can('authenticated', 'public.post_purchase_invoice(uuid)')
    AND proof.can('anon', 'public.post_purchase_invoice(uuid)')
    AND proof.can('service_role', 'public.post_purchase_invoice(uuid)'),
  (SELECT acl FROM proof.fn_before WHERE sig = 'post_purchase_invoice(uuid)'));
SELECT proof.record('V7', 'VOOR: assert_posting_allowed staat al op alleen-eigenaar',
  NOT proof.can('anon', 'public.assert_posting_allowed(uuid,date)')
    AND NOT proof.can('authenticated', 'public.assert_posting_allowed(uuid,date)')
    AND NOT proof.can('service_role', 'public.assert_posting_allowed(uuid,date)'),
  (SELECT acl FROM proof.fn_before WHERE sig = 'assert_posting_allowed(uuid,date)'));
SELECT proof.record('V8', 'VOOR: elk bewust toegangspunt is uitvoerbaar voor authenticated',
  (SELECT bool_and(proof.can('authenticated', sig)) FROM proof.fn_class WHERE klasse = 'toegang'),
  (SELECT string_agg(sig, ', ') FROM proof.fn_class WHERE klasse = 'toegang' AND NOT proof.can('authenticated', sig)));
SELECT proof.record('V9', 'VOOR: de zes andere gedateerde schrijvers stonden al dicht voor anon',
  NOT proof.can('anon', 'public.post_sales_invoice(uuid)')
    AND NOT proof.can('anon', 'public.post_bank_allocation(uuid)')
    AND NOT proof.can('anon', 'public.post_manual_journal(uuid)')
    AND NOT proof.can('anon', 'public.post_opening_balance(uuid)')
    AND NOT proof.can('anon', 'public.reverse_posting_group(uuid,date,text)')
    AND NOT proof.can('anon', 'public.post_bank_transaction(uuid)'));
