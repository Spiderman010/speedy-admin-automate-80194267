-- REAL POSTGRESQL PROOF for 20260929120000_harden_internal_function_acls.sql —
-- run against a THROWAWAY local cluster. Never run this against any BoekAssist
-- database. See run-proof.sh.
--
-- Drie vragen:
--   A. Zijn de interne hulpfuncties nu alleen nog voor de eigenaar?
--   B. Werkt elk bewust toegangspunt nog — ECHT aangeroepen als
--      `authenticated`, zodat de hele keten schrijver → assert → grendel →
--      sleutel onder SECURITY DEFINER wordt doorlopen?
--   C. Heeft de migratie verder helemaal niets veranderd — geen functielichaam,
--      geen eigenaar, geen tabelrecht, geen policy, geen trigger, geen
--      standaardrecht?

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

/* De volledige foutidentiteit (SQLSTATE | boodschap) van een aanroep. */
CREATE FUNCTION proof.err(_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  EXECUTE _sql;
  RETURN 'GEEN FOUT';
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  RETURN v_state || ' | ' || v_msg;
END $$;

-- ═══ A. ALLEEN DE EIGENAAR ═════════════════════════════════════════════════

SELECT proof.record('1', 'lock_ledger_client: anon, authenticated, service_role mogen niet',
  NOT proof.can('anon', 'public.lock_ledger_client(uuid)')
    AND NOT proof.can('authenticated', 'public.lock_ledger_client(uuid)')
    AND NOT proof.can('service_role', 'public.lock_ledger_client(uuid)'));
SELECT proof.record('2', 'ledger_client_lock_key: anon, authenticated, service_role mogen niet',
  NOT proof.can('anon', 'public.ledger_client_lock_key(uuid)')
    AND NOT proof.can('authenticated', 'public.ledger_client_lock_key(uuid)')
    AND NOT proof.can('service_role', 'public.ledger_client_lock_key(uuid)'));
SELECT proof.record('3', 'posting_allowed: anon, authenticated, service_role mogen niet',
  NOT proof.can('anon', 'public.posting_allowed(uuid,date)')
    AND NOT proof.can('authenticated', 'public.posting_allowed(uuid,date)')
    AND NOT proof.can('service_role', 'public.posting_allowed(uuid,date)'));
SELECT proof.record('4', 'assert_posting_allowed: blijft alleen-eigenaar (niet verzwakt)',
  NOT proof.can('anon', 'public.assert_posting_allowed(uuid,date)')
    AND NOT proof.can('authenticated', 'public.assert_posting_allowed(uuid,date)')
    AND NOT proof.can('service_role', 'public.assert_posting_allowed(uuid,date)'));

-- Wat productie werkelijk nodig heeft: daar is de eigenaar GEEN superuser, dus
-- moet zijn eigen toekenning in de ACL blijven staan. Exact die ene regel.
SELECT proof.record('5', 'de vier interne functies: de ACL bevat uitsluitend de eigenaar',
  (SELECT bool_and(COALESCE(p.proacl::text, '') = '{' || pg_get_userbyid(p.proowner) || '=X/' || pg_get_userbyid(p.proowner) || '}')
   FROM proof.fn_class f JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
   WHERE f.klasse = 'intern'),
  (SELECT string_agg(f.sig || ' ' || COALESCE(p.proacl::text, '(default)'), '; ')
   FROM proof.fn_class f JOIN pg_proc p ON p.oid = to_regprocedure(f.sig) WHERE f.klasse = 'intern'));

SELECT proof.record('6', 'post_purchase_invoice: authenticated mag, anon en service_role niet',
  proof.can('authenticated', 'public.post_purchase_invoice(uuid)')
    AND NOT proof.can('anon', 'public.post_purchase_invoice(uuid)')
    AND NOT proof.can('service_role', 'public.post_purchase_invoice(uuid)'));
SELECT proof.record('7', 'post_purchase_invoice: de ACL is eigenaar + authenticated, niets anders',
  (SELECT p.proacl::text = '{' || pg_get_userbyid(p.proowner) || '=X/' || pg_get_userbyid(p.proowner)
                           || ',authenticated=X/' || pg_get_userbyid(p.proowner) || '}'
   FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_purchase_invoice(uuid)')),
  (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_purchase_invoice(uuid)')));
SELECT proof.record('8', 'post_purchase_invoice staat nu gelijk met zijn broers post_sales_invoice en post_bank_allocation',
  (SELECT count(DISTINCT replace(p.proacl::text, pg_get_userbyid(p.proowner), 'EIGENAAR')) = 1
   FROM pg_proc p
   WHERE p.oid IN (to_regprocedure('public.post_purchase_invoice(uuid)'),
                   to_regprocedure('public.post_sales_invoice(uuid)'),
                   to_regprocedure('public.post_bank_allocation(uuid)'))));
SELECT proof.record('9', 'elk bewust toegangspunt blijft uitvoerbaar voor authenticated',
  (SELECT bool_and(proof.can('authenticated', sig)) FROM proof.fn_class WHERE klasse = 'toegang'),
  (SELECT string_agg(sig, ', ') FROM proof.fn_class WHERE klasse = 'toegang' AND NOT proof.can('authenticated', sig)));

-- ═══ B. ECHT AANGEROEPEN, ALS DE ROLLEN ZELF ═══════════════════════════════
--
-- Klaarzetten gebeurt als de eigenaar (de fixtures schrijven rechtstreeks in
-- brontabellen). Aanroepen gebeurt daarna ONDER `SET ROLE`, zodat PostgreSQL
-- elk EXECUTE-recht werkelijk toetst.

CREATE TABLE proof.ids (k text PRIMARY KEY, id uuid NOT NULL);

DO $$
DECLARE
  v_mj  uuid := proof.pl_client('ACL — memoriaal en tegenboeking');
  v_ob  uuid := proof.pl_client('ACL — beginbalans');
  v_tx  uuid := proof.pl_client('ACL — bank');
  v_nil uuid := proof.pl_client('ACL — nihilverklaring');
  v_jr  uuid := proof.new_client('ACL — jaarafsluiting');
  v_x   uuid;
BEGIN
  INSERT INTO proof.ids VALUES
    ('mj_client', v_mj),
    ('mj_open',   proof.mj_draft(v_mj, DATE '2025-03-10')),
    ('mj_dicht',  proof.mj_draft(v_mj, DATE '2025-02-01')),
    ('ob',        proof.ob_draft(v_ob, DATE '2025-01-01')),
    ('tx',        proof.tx_draft(v_tx, DATE '2025-04-01')),
    ('tx_bulk',   proof.tx_draft(v_tx, DATE '2025-04-02')),
    ('jr_client', v_jr);
  v_x := proof.ob_draft(v_nil, DATE '2024-01-01');
  DELETE FROM public.opening_balance_lines WHERE opening_balance_id = v_x;
  INSERT INTO proof.ids VALUES ('ob_nil', v_x);
END $$;

GRANT USAGE ON SCHEMA proof TO anon, authenticated, service_role;
GRANT SELECT ON proof.ids TO anon, authenticated, service_role;
GRANT INSERT ON proof.ids TO authenticated;

-- ── Als authenticated: elke keten naar de grendel werkt nog ─────────────────

SET ROLE authenticated;

DO $$
DECLARE
  v_g   uuid;
  v_rev uuid;
  v_ok  boolean;
  v_err text;
  v_out record;
BEGIN
  PERFORM proof.record('10', 'draait werkelijk als authenticated (geen superuser)',
    current_user = 'authenticated'
      AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user),
    current_user::text);

  -- post_manual_journal → assert_posting_allowed → lock_ledger_client → ledger_client_lock_key, posting_allowed
  v_g := public.post_manual_journal((SELECT id FROM proof.ids WHERE k = 'mj_open'));
  PERFORM proof.record('11', 'post_manual_journal boekt als authenticated (keten via assert → grendel → blokkadetoets)',
    v_g IS NOT NULL AND (SELECT count(*) FROM public.ledger_postings WHERE posting_group_id = v_g) = 2,
    format('groep = %s', COALESCE(v_g::text, 'geen')));
  INSERT INTO proof.ids VALUES ('mj_group', v_g);
END $$;

-- Een tegenboeking kan pas in een LATERE transactie dan de boeking zelf
-- (bewuste regel van de tegenboekingsmotor); dus een eigen DO-blok.
DO $$
DECLARE
  v_g   uuid;
  v_rev uuid;
  v_ok  boolean;
  v_err text;
  v_out record;
BEGIN
  -- reverse_posting_group → lock_ledger_client (eigen aanroep) + assert
  v_rev := public.reverse_posting_group((SELECT id FROM proof.ids WHERE k = 'mj_group'), DATE '2025-03-11', 'ACL-bewijs');
  PERFORM proof.record('12', 'reverse_posting_group boekt als authenticated (roept lock_ledger_client zelf aan)',
    v_rev IS NOT NULL, format('tegenboeking = %s', COALESCE(v_rev::text, 'geen')));

  -- post_opening_balance → lock_ledger_client (eigen aanroep) + assert
  v_g := public.post_opening_balance((SELECT id FROM proof.ids WHERE k = 'ob'));
  PERFORM proof.record('13', 'post_opening_balance boekt als authenticated (roept lock_ledger_client zelf aan)',
    v_g IS NOT NULL, format('groep = %s', COALESCE(v_g::text, 'geen')));

  -- post_bank_transaction → assert
  v_g := public.post_bank_transaction((SELECT id FROM proof.ids WHERE k = 'tx'));
  PERFORM proof.record('14', 'post_bank_transaction boekt als authenticated',
    v_g IS NOT NULL, format('groep = %s', COALESCE(v_g::text, 'geen')));

  -- post_bank_transactions_bulk is SECURITY INVOKER: het enige toegangspunt dat
  -- ALS authenticated een andere functie aanroept. Het mag alleen de schrijver
  -- nodig hebben, geen hulpfunctie.
  SELECT * INTO v_out FROM public.post_bank_transactions_bulk(ARRAY[(SELECT id FROM proof.ids WHERE k = 'tx_bulk')]);
  PERFORM proof.record('15', 'post_bank_transactions_bulk (SECURITY INVOKER) boekt als authenticated',
    v_out.outcome = 'posted', format('%s — %s', v_out.outcome, COALESCE(v_out.message, 'geen melding')));

  -- declare_opening_balance_nil → lock_ledger_client
  PERFORM public.declare_opening_balance_nil((SELECT id FROM proof.ids WHERE k = 'ob_nil'));
  PERFORM proof.record('16', 'declare_opening_balance_nil werkt als authenticated (roept lock_ledger_client aan)',
    (SELECT nil_declared_at IS NOT NULL FROM public.opening_balances WHERE id = (SELECT id FROM proof.ids WHERE k = 'ob_nil')));

  -- set_posting_lock → lock_ledger_client
  SELECT s.changed INTO v_ok
  FROM public.set_posting_lock((SELECT id FROM proof.ids WHERE k = 'mj_client'), DATE '2025-02-28', 'ACL-bewijs') s;
  PERFORM proof.record('17', 'set_posting_lock werkt als authenticated (roept lock_ledger_client aan)',
    v_ok IS TRUE, format('changed = %s', COALESCE(v_ok::text, 'null')));

  -- De blokkade wordt nog steeds GETOETST: dit antwoord komt pas nádat
  -- posting_allowed() onder de eigenaar false heeft teruggegeven.
  v_err := proof.err(format('SELECT public.post_manual_journal(%L)', (SELECT id FROM proof.ids WHERE k = 'mj_dicht')));
  PERFORM proof.record('18', 'en de blokkade wordt nog steeds gehandhaafd (22023, niet "permission denied")',
    v_err LIKE '22023 | %valt binnen de boekingsblokkade t/m 2025-02-28%', v_err);

  -- close_fiscal_year → lock_ledger_client
  SELECT c.created INTO v_ok FROM public.close_fiscal_year((SELECT id FROM proof.ids WHERE k = 'jr_client'), 2023) c;
  PERFORM proof.record('19', 'close_fiscal_year werkt als authenticated (roept lock_ledger_client aan)',
    v_ok IS TRUE, format('created = %s', COALESCE(v_ok::text, 'null')));

  -- De drie schrijvers zonder brontabellen in dit harnas: het toegangspunt
  -- moet bereikbaar zijn. Een "niet gevonden"-fout bewijst dat; een 42501
  -- "permission denied for function" zou het tegendeel zijn.
  v_err := proof.err(format('SELECT public.post_purchase_invoice(%L)', gen_random_uuid()));
  PERFORM proof.record('20', 'post_purchase_invoice is bereikbaar als authenticated (fout komt uit het lichaam, niet uit de ACL)',
    v_err NOT ILIKE '%permission denied for function%', v_err);
  v_err := proof.err(format('SELECT public.post_sales_invoice(%L)', gen_random_uuid()));
  PERFORM proof.record('21', 'post_sales_invoice is bereikbaar als authenticated',
    v_err NOT ILIKE '%permission denied for function%', v_err);
  v_err := proof.err(format('SELECT public.post_bank_allocation(%L)', gen_random_uuid()));
  PERFORM proof.record('22', 'post_bank_allocation is bereikbaar als authenticated',
    v_err NOT ILIKE '%permission denied for function%', v_err);

  -- En rechtstreeks: dicht.
  v_err := proof.err(format('SELECT public.lock_ledger_client(%L)', gen_random_uuid()));
  PERFORM proof.record('23', 'authenticated: lock_ledger_client direct → 42501', v_err LIKE '42501 | permission denied for function lock_ledger_client%', v_err);
  v_err := proof.err(format('SELECT public.ledger_client_lock_key(%L)', gen_random_uuid()));
  PERFORM proof.record('24', 'authenticated: ledger_client_lock_key direct → 42501', v_err LIKE '42501 | permission denied for function ledger_client_lock_key%', v_err);
  v_err := proof.err(format('SELECT public.posting_allowed(%L, DATE ''2025-01-01'')', gen_random_uuid()));
  PERFORM proof.record('25', 'authenticated: posting_allowed direct → 42501', v_err LIKE '42501 | permission denied for function posting_allowed%', v_err);
  v_err := proof.err(format('SELECT public.assert_posting_allowed(%L, DATE ''2025-01-01'')', gen_random_uuid()));
  PERFORM proof.record('26', 'authenticated: assert_posting_allowed direct → 42501', v_err LIKE '42501 | permission denied for function assert_posting_allowed%', v_err);
END $$;

RESET ROLE;

-- ── Als anon ────────────────────────────────────────────────────────────────

SET ROLE anon;

DO $$
DECLARE v_err text;
BEGIN
  v_err := proof.err(format('SELECT public.lock_ledger_client(%L)', gen_random_uuid()));
  PERFORM proof.record('27', 'anon: lock_ledger_client → 42501', v_err LIKE '42501 | permission denied for function lock_ledger_client%', v_err);
  v_err := proof.err(format('SELECT public.ledger_client_lock_key(%L)', gen_random_uuid()));
  PERFORM proof.record('28', 'anon: ledger_client_lock_key → 42501', v_err LIKE '42501 | permission denied for function ledger_client_lock_key%', v_err);
  v_err := proof.err(format('SELECT public.posting_allowed(%L, DATE ''2025-01-01'')', gen_random_uuid()));
  PERFORM proof.record('29', 'anon: posting_allowed → 42501', v_err LIKE '42501 | permission denied for function posting_allowed%', v_err);
  v_err := proof.err(format('SELECT public.post_purchase_invoice(%L)', gen_random_uuid()));
  PERFORM proof.record('30', 'anon: post_purchase_invoice → 42501', v_err LIKE '42501 | permission denied for function post_purchase_invoice%', v_err);
END $$;

RESET ROLE;

-- ── Als service_role ────────────────────────────────────────────────────────

SET ROLE service_role;

DO $$
DECLARE v_err text;
BEGIN
  v_err := proof.err(format('SELECT public.lock_ledger_client(%L)', gen_random_uuid()));
  PERFORM proof.record('31', 'service_role: lock_ledger_client → 42501', v_err LIKE '42501 | permission denied for function lock_ledger_client%', v_err);
  v_err := proof.err(format('SELECT public.posting_allowed(%L, DATE ''2025-01-01'')', gen_random_uuid()));
  PERFORM proof.record('32', 'service_role: posting_allowed → 42501', v_err LIKE '42501 | permission denied for function posting_allowed%', v_err);
  v_err := proof.err(format('SELECT public.post_purchase_invoice(%L)', gen_random_uuid()));
  PERFORM proof.record('33', 'service_role: post_purchase_invoice → 42501', v_err LIKE '42501 | permission denied for function post_purchase_invoice%', v_err);
END $$;

RESET ROLE;

-- ═══ C. VERDER IS NIETS VERANDERD ══════════════════════════════════════════

SELECT proof.record('34', 'geen enkele functie in public: lichaam, SECURITY DEFINER, volatiliteit, search_path, eigenaar of resultaattype gewijzigd',
  NOT EXISTS (
    SELECT 1 FROM proof.fn_before b
    FULL JOIN (
      SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS body_md5, p.prosecdef,
             p.provolatile::text AS vol, array_to_string(p.proconfig, ',') AS config,
             pg_get_userbyid(p.proowner) AS owner, pg_get_function_result(p.oid) AS result
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    ) a ON a.sig = b.sig
    WHERE a.sig IS NULL OR b.sig IS NULL
       OR (a.body_md5, a.prosecdef, a.vol, a.config, a.owner, a.result)
          IS DISTINCT FROM (b.body_md5, b.prosecdef, b.vol, b.config, b.owner, b.result)),
  format('%s functies vergeleken', (SELECT count(*) FROM proof.fn_before)));

SELECT proof.record('35', 'alleen de ACL van precies deze vier functies is veranderd',
  (SELECT string_agg(b.sig, ',' ORDER BY b.sig)
   FROM proof.fn_before b
   JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text = b.sig
   WHERE COALESCE(p.proacl::text, '(default)') <> b.acl)
  = 'ledger_client_lock_key(uuid),lock_ledger_client(uuid),post_purchase_invoice(uuid),posting_allowed(uuid,date)',
  (SELECT string_agg(b.sig, ',' ORDER BY b.sig)
   FROM proof.fn_before b
   JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text = b.sig
   WHERE COALESCE(p.proacl::text, '(default)') <> b.acl));

SELECT proof.record('36', 'geen tabelrecht, geen kolomrecht en geen RLS-vlag in public gewijzigd',
  NOT EXISTS (
    SELECT 1 FROM proof.tbl_before b
    FULL JOIN (SELECT c.relname, COALESCE(c.relacl::text, '(default)') AS acl, c.relrowsecurity, c.relforcerowsecurity
               FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p')) a
      ON a.relname = b.relname
    WHERE a.relname IS NULL OR b.relname IS NULL
       OR (a.acl, a.relrowsecurity, a.relforcerowsecurity) IS DISTINCT FROM (b.acl, b.relrowsecurity, b.relforcerowsecurity))
  AND NOT EXISTS (
    (SELECT relname, attname, acl FROM proof.col_acl_before
     EXCEPT
     SELECT c.relname, a.attname, a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL)
    UNION ALL
    (SELECT c.relname, a.attname, a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL
     EXCEPT
     SELECT relname, attname, acl FROM proof.col_acl_before)));

SELECT proof.record('37', 'ledger_postings: authenticated nog steeds alleen SELECT, anon niets',
  has_table_privilege('authenticated', 'public.ledger_postings', 'SELECT')
    AND NOT has_any_column_privilege('authenticated', 'public.ledger_postings', 'INSERT')
    AND NOT has_any_column_privilege('authenticated', 'public.ledger_postings', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.ledger_postings', 'DELETE')
    AND NOT has_table_privilege('authenticated', 'public.ledger_postings', 'TRUNCATE')
    AND NOT has_table_privilege('anon', 'public.ledger_postings', 'SELECT'),
  (SELECT relacl::text FROM pg_class WHERE oid = 'public.ledger_postings'::regclass));

SELECT proof.record('38', 'geen policy gewijzigd',
  NOT EXISTS (
    (SELECT * FROM proof.pol_before
     EXCEPT SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public')
    UNION ALL
    (SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public'
     EXCEPT SELECT * FROM proof.pol_before)));

SELECT proof.record('39', 'geen trigger gewijzigd',
  NOT EXISTS (
    (SELECT * FROM proof.trg_before
     EXCEPT SELECT c.relname, t.tgname, t.tgenabled::text, t.tgfoid::regproc::text
            FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal)
    UNION ALL
    (SELECT c.relname, t.tgname, t.tgenabled::text, t.tgfoid::regproc::text
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
     EXCEPT SELECT * FROM proof.trg_before)));

SELECT proof.record('40', 'pg_default_acl ongewijzigd: de migratie raakt toekomstige functies niet',
  NOT EXISTS (
    (SELECT * FROM proof.defacl_before
     EXCEPT SELECT pg_get_userbyid(defaclrole), defaclnamespace, defaclobjtype::text, defaclacl::text FROM pg_default_acl)
    UNION ALL
    (SELECT pg_get_userbyid(defaclrole), defaclnamespace, defaclobjtype::text, defaclacl::text FROM pg_default_acl
     EXCEPT SELECT * FROM proof.defacl_before))
  AND EXISTS (SELECT 1 FROM pg_default_acl),
  (SELECT string_agg(defaclacl::text, '; ') FROM pg_default_acl));
