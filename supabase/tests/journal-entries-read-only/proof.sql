-- REAL POSTGRESQL PROOF for 20260930120000_make_journal_entries_read_only.sql —
-- run against a THROWAWAY local cluster. Never run this against any BoekAssist
-- database. See run-proof.sh.
--
--   A. rechten en policies: alleen nog lezen
--   B. echt geprobeerd, als elke rol: lezen werkt, schrijven niet
--   C. verdediging in de diepte: ook mét een schrijfrecht weigert RLS
--   D. verder is niets veranderd

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ═══ A. RECHTEN EN POLICIES ════════════════════════════════════════════════

SELECT proof.record('1', 'RLS staat nog aan (en is niet geforceerd of uitgezet)',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.journal_entries'::regclass)
    AND (SELECT (c.relrowsecurity, c.relforcerowsecurity) = (b.relrowsecurity, b.relforcerowsecurity)
         FROM pg_class c, proof.tbl_acl_before b
         WHERE c.oid = 'public.journal_entries'::regclass AND b.relname = 'journal_entries'));

SELECT proof.record('2', 'authenticated: SELECT ja; INSERT, UPDATE, DELETE, TRUNCATE nee',
  proof.priv('authenticated', 'SELECT')
    AND NOT proof.priv('authenticated', 'INSERT') AND NOT proof.priv('authenticated', 'UPDATE')
    AND NOT proof.priv('authenticated', 'DELETE') AND NOT proof.priv('authenticated', 'TRUNCATE'));

SELECT proof.record('3', 'service_role: SELECT ja; INSERT, UPDATE, DELETE, TRUNCATE nee',
  proof.priv('service_role', 'SELECT')
    AND NOT proof.priv('service_role', 'INSERT') AND NOT proof.priv('service_role', 'UPDATE')
    AND NOT proof.priv('service_role', 'DELETE') AND NOT proof.priv('service_role', 'TRUNCATE'));

SELECT proof.record('4', 'anon: helemaal niets (ook geen SELECT; RLS gaf anon al geen rijen)',
  NOT proof.priv('anon', 'SELECT') AND NOT proof.priv('anon', 'INSERT') AND NOT proof.priv('anon', 'UPDATE')
    AND NOT proof.priv('anon', 'DELETE') AND NOT proof.priv('anon', 'TRUNCATE'));

SELECT proof.record('5', 'de ACL: eigenaar, authenticated=r en service_role=r — geen PUBLIC, geen anon',
  (SELECT relacl::text FROM pg_class WHERE oid = 'public.journal_entries'::regclass) LIKE '%,authenticated=r/%'
    AND (SELECT relacl::text FROM pg_class WHERE oid = 'public.journal_entries'::regclass) LIKE '%,service_role=r/%'
    AND (SELECT relacl::text FROM pg_class WHERE oid = 'public.journal_entries'::regclass) NOT LIKE '%anon=%'
    AND (SELECT relacl::text FROM pg_class WHERE oid = 'public.journal_entries'::regclass) !~ '[{,]=',
  (SELECT relacl::text FROM pg_class WHERE oid = 'public.journal_entries'::regclass));

SELECT proof.record('6', 'geen kolomrechten die een schrijfactie alsnog toestaan',
  NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.journal_entries'::regclass AND attacl IS NOT NULL));

SELECT proof.record('7', 'policies: alleen nog role_journal_entries_select, en die is ongewijzigd',
  (SELECT string_agg(policyname || ':' || cmd, ',') FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'journal_entries') = 'role_journal_entries_select:SELECT'
    AND EXISTS (SELECT 1 FROM pg_policies p JOIN proof.pol_before b
                  ON b.tablename = p.tablename AND b.policyname = p.policyname
                WHERE p.schemaname = 'public' AND p.tablename = 'journal_entries'
                  AND p.policyname = 'role_journal_entries_select'
                  AND (p.cmd, p.roles::text, p.qual, p.with_check) IS NOT DISTINCT FROM (b.cmd, b.roles, b.qual, b.with_check)));

-- ═══ B. ECHT GEPROBEERD, ALS ELKE ROL ══════════════════════════════════════

SET ROLE authenticated;

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);  -- accountant, Agio Finance
SELECT proof.record('8', 'accountant: ziet de drie historische regels (leespad voor pagina, Bronmutaties, Rapportages, export)',
  (SELECT count(*) FROM public.journal_entries) = 3);
SELECT proof.record('9', 'accountant: INSERT → 42501',
  proof.try(format(
    'INSERT INTO public.journal_entries (user_id, client_id, organization_id, entry_date, amount) VALUES (%L, %L, %L, DATE ''2025-05-01'', 1.00)',
    '00000000-0000-0000-0000-0000000000e1', (SELECT id FROM proof.ids WHERE k = 'client'),
    '00000000-0000-0000-0000-00000000a001')) LIKE '42501 | permission denied for table journal_entries%',
  proof.try(format(
    'INSERT INTO public.journal_entries (user_id, client_id, organization_id, entry_date, amount) VALUES (%L, %L, %L, DATE ''2025-05-01'', 1.00)',
    '00000000-0000-0000-0000-0000000000e1', (SELECT id FROM proof.ids WHERE k = 'client'),
    '00000000-0000-0000-0000-00000000a001')));
SELECT proof.record('10', 'accountant: UPDATE → 42501',
  proof.try('UPDATE public.journal_entries SET description = ''gewijzigd''') LIKE '42501 | permission denied for table journal_entries%',
  proof.try('UPDATE public.journal_entries SET description = ''gewijzigd'''));
SELECT proof.record('11', 'accountant: DELETE → 42501',
  proof.try('DELETE FROM public.journal_entries') LIKE '42501 | permission denied for table journal_entries%',
  proof.try('DELETE FROM public.journal_entries'));
SELECT proof.record('12', 'accountant: TRUNCATE → 42501',
  proof.try('TRUNCATE public.journal_entries') LIKE '42501 | permission denied for table journal_entries%',
  proof.try('TRUNCATE public.journal_entries'));

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);  -- assistent, Agio Finance
SELECT proof.record('13', 'assistent: ziet de drie regels, maar kan niet toevoegen of wijzigen',
  (SELECT count(*) FROM public.journal_entries) = 3
    AND proof.try('UPDATE public.journal_entries SET description = ''x''') LIKE '42501 | %'
    AND proof.try(format(
      'INSERT INTO public.journal_entries (user_id, client_id, organization_id, entry_date, amount) VALUES (%L, %L, %L, DATE ''2025-05-01'', 1.00)',
      '00000000-0000-0000-0000-0000000000e2', (SELECT id FROM proof.ids WHERE k = 'client'),
      '00000000-0000-0000-0000-00000000a001')) LIKE '42501 | %');

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e3', false);  -- accountant, andere organisatie
SELECT proof.record('14', 'tenant-isolatie ongewijzigd: een andere organisatie ziet nul regels',
  (SELECT count(*) FROM public.journal_entries) = 0);

RESET ROLE;

SET ROLE service_role;
SELECT proof.record('15', 'service_role: leest (BYPASSRLS) maar kan niet schrijven',
  (SELECT count(*) FROM public.journal_entries) = 3
    AND proof.try('UPDATE public.journal_entries SET description = ''x''') LIKE '42501 | permission denied for table journal_entries%'
    AND proof.try('DELETE FROM public.journal_entries') LIKE '42501 | permission denied for table journal_entries%'
    AND proof.try(format(
      'INSERT INTO public.journal_entries (user_id, client_id, organization_id, entry_date, amount) VALUES (%L, %L, %L, DATE ''2025-05-01'', 1.00)',
      '00000000-0000-0000-0000-0000000000e1', (SELECT id FROM proof.ids WHERE k = 'client'),
      '00000000-0000-0000-0000-00000000a001')) LIKE '42501 | permission denied for table journal_entries%');
RESET ROLE;

SET ROLE anon;
SELECT proof.record('16', 'anon: lezen → 42501',
  proof.try('SELECT * FROM public.journal_entries') LIKE '42501 | permission denied for table journal_entries%',
  proof.try('SELECT * FROM public.journal_entries'));
RESET ROLE;

-- ═══ C. VERDEDIGING IN DE DIEPTE ═══════════════════════════════════════════
--
-- Komt er ooit per ongeluk weer een schrijfrecht bij (bv. een standaardrecht
-- op een hersteld object), dan weigert RLS nog steeds: er is geen
-- schrijfpolicy meer. Tijdelijk toegekend en weer teruggedraaid.

DO $$
DECLARE v_ins text; v_upd text; v_del text;
BEGIN
  BEGIN
    GRANT INSERT, UPDATE, DELETE ON public.journal_entries TO authenticated;
    PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
    SET LOCAL ROLE authenticated;
    v_ins := proof.try(format(
      'INSERT INTO public.journal_entries (user_id, client_id, organization_id, entry_date, amount) VALUES (%L, %L, %L, DATE ''2025-05-01'', 1.00)',
      '00000000-0000-0000-0000-0000000000e1', (SELECT id FROM proof.ids WHERE k = 'client'),
      '00000000-0000-0000-0000-00000000a001'));
    v_upd := proof.try('UPDATE public.journal_entries SET description = ''x''');
    v_del := proof.try('DELETE FROM public.journal_entries');
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '__rollback__';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> '__rollback__' THEN RAISE; END IF;
  END;

  PERFORM proof.record('17', 'mét een teruggekeerd schrijfrecht: INSERT weigert op RLS',
    v_ins LIKE '42501 | new row violates row-level security policy%', v_ins);
  PERFORM proof.record('18', 'mét een teruggekeerd schrijfrecht: UPDATE en DELETE raken nul rijen',
    v_upd = 'OK rows=0' AND v_del = 'OK rows=0', v_upd || ' / ' || v_del);
END $$;

SELECT proof.record('19', 'en dat tijdelijke recht is echt weer weg',
  NOT proof.priv('authenticated', 'INSERT') AND NOT proof.priv('authenticated', 'UPDATE') AND NOT proof.priv('authenticated', 'DELETE'));

-- ═══ D. VERDER IS NIETS VERANDERD ══════════════════════════════════════════

SELECT proof.record('20', 'de historische regels zijn onaangeroerd (aantal en inhoud, byte voor byte)',
  (SELECT count(*) = b.n AND md5(string_agg(j::text, '|' ORDER BY j.id)) = b.digest
   FROM public.journal_entries j, proof.rows_before b GROUP BY b.n, b.digest),
  (SELECT count(*)::text FROM public.journal_entries) || ' rijen');

SELECT proof.record('21', 'kolommen, types, NOT NULL en defaults ongewijzigd',
  NOT EXISTS (
    (SELECT * FROM proof.cols_before
     EXCEPT SELECT a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
            FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = 'public.journal_entries'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
    UNION ALL
    (SELECT a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.journal_entries'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     EXCEPT SELECT * FROM proof.cols_before)));

SELECT proof.record('22', 'constraints en FK''s (incl. ON DELETE-acties) ongewijzigd',
  NOT EXISTS (
    (SELECT * FROM proof.cons_before
     EXCEPT SELECT conname, pg_get_constraintdef(oid), convalidated FROM pg_constraint WHERE conrelid = 'public.journal_entries'::regclass)
    UNION ALL
    (SELECT conname, pg_get_constraintdef(oid), convalidated FROM pg_constraint WHERE conrelid = 'public.journal_entries'::regclass
     EXCEPT SELECT * FROM proof.cons_before)),
  (SELECT count(*)::text FROM proof.cons_before) || ' constraints');

SELECT proof.record('23', 'indexen ongewijzigd',
  NOT EXISTS (
    (SELECT * FROM proof.idx_before
     EXCEPT SELECT indexrelid::regclass::text, pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid = 'public.journal_entries'::regclass)
    UNION ALL
    (SELECT indexrelid::regclass::text, pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid = 'public.journal_entries'::regclass
     EXCEPT SELECT * FROM proof.idx_before)));

SELECT proof.record('24', 'geen trigger in public gewijzigd (ook niet op journal_entries)',
  NOT EXISTS (
    (SELECT * FROM proof.trg_all_before
     EXCEPT SELECT c.relname, t.tgname, t.tgenabled::text, pg_get_triggerdef(t.oid)
            FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal)
    UNION ALL
    (SELECT c.relname, t.tgname, t.tgenabled::text, pg_get_triggerdef(t.oid)
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
     EXCEPT SELECT * FROM proof.trg_all_before)),
  (SELECT string_agg(tgname, ', ' ORDER BY tgname) FROM proof.trg_all_before WHERE relname = 'journal_entries'));

SELECT proof.record('25', 'alleen de schrijfpolicies van journal_entries zijn weg; elke andere policy is identiek',
  (SELECT string_agg(policyname, ',' ORDER BY policyname) FROM (
     SELECT tablename, policyname, cmd, roles, qual, with_check FROM proof.pol_before
     EXCEPT SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public') s)
    = 'role_journal_entries_delete,role_journal_entries_insert,role_journal_entries_update'
  AND NOT EXISTS (
     SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public'
     EXCEPT SELECT tablename, policyname, cmd, roles, qual, with_check FROM proof.pol_before));

SELECT proof.record('26', 'alleen de ACL van journal_entries is veranderd; elke andere tabel (incl. ledger_postings) identiek',
  (SELECT string_agg(b.relname, ',') FROM proof.tbl_acl_before b
   JOIN pg_class c ON c.relname = b.relname AND c.relnamespace = 'public'::regnamespace
   WHERE (COALESCE(c.relacl::text, '(default)'), c.relrowsecurity, c.relforcerowsecurity)
         IS DISTINCT FROM (b.acl, b.relrowsecurity, b.relforcerowsecurity)) = 'journal_entries',
  (SELECT acl FROM proof.tbl_acl_before WHERE relname = 'ledger_postings'));

SELECT proof.record('27', 'ledger_postings: authenticated nog steeds alleen SELECT',
  has_table_privilege('authenticated', 'public.ledger_postings', 'SELECT')
    AND NOT has_any_column_privilege('authenticated', 'public.ledger_postings', 'INSERT')
    AND NOT has_any_column_privilege('authenticated', 'public.ledger_postings', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.ledger_postings', 'DELETE'));

SELECT proof.record('28', 'geen functie gewijzigd: lichaam, SECURITY DEFINER, eigenaar, ACL',
  NOT EXISTS (
    (SELECT * FROM proof.fn_before
     EXCEPT SELECT p.oid::regprocedure::text, md5(p.prosrc), p.prosecdef, pg_get_userbyid(p.proowner), COALESCE(p.proacl::text, '(default)')
            FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace)
    UNION ALL
    (SELECT p.oid::regprocedure::text, md5(p.prosrc), p.prosecdef, pg_get_userbyid(p.proowner), COALESCE(p.proacl::text, '(default)')
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     EXCEPT SELECT * FROM proof.fn_before)),
  (SELECT count(*)::text FROM proof.fn_before) || ' functies');

SELECT proof.record('29', 'eigenaar van journal_entries ongewijzigd',
  (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.journal_entries'::regclass) = (SELECT owner FROM proof.owner_before));

-- De FK-acties schrijven journal_entries namens de EIGENAAR, niet namens de
-- gebruiker: een rekening verwijderen zet de verwijzing nog steeds op NULL.
DO $$
DECLARE v_before uuid; v_after uuid; v_n bigint; v_gb uuid := (SELECT id FROM proof.ids WHERE k = 'gb');
BEGIN
  SELECT grootboekrekening_id INTO v_before FROM public.journal_entries WHERE grootboekrekening_id = v_gb;
  BEGIN
    -- Als de accountant zelf, niet als superuser: journal_entries is voor hem
    -- nu alleen-lezen, en toch moet de FK-actie slagen.
    PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
    SET LOCAL ROLE authenticated;
    DELETE FROM public.grootboekrekeningen WHERE id = v_gb;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    SELECT grootboekrekening_id INTO v_after FROM public.journal_entries WHERE description = 'Kantoorartikelen';
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '__rollback__';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> '__rollback__' THEN RAISE; END IF;
  END;
  PERFORM proof.record('30', 'FK ON DELETE SET NULL (grootboekrekening) werkt nog — draait als tabeleigenaar',
    v_before = v_gb AND v_n = 1 AND v_after IS NULL,
    format('als authenticated: %s rekening verwijderd; verwijzing voor %s, na %s', v_n, v_before, COALESCE(v_after::text, 'NULL')));
END $$;
