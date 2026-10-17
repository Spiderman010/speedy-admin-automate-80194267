-- ═════════════════════════════════════════════════════════════════════════════
-- POST — leescontroles ná 20261018120000_add_bank_transaction_corrections.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor van `alxlbdhpbwlehbdbfejw`, in
-- hetzelfde editortabblad als de PRE (zelfde project, visueel bevestigd).
-- Alles hieronder is ALLEEN LEZEN; er wordt niets getest door te schrijven —
-- geen testdata in productie. Dat de correcties werken, is bewezen in
-- supabase/tests/bank-transaction-corrections/; hier wordt bewezen dat
-- productie exact die objecten draagt (POST 1–3) en dat verder niets veranderde.
--
-- Bij ELKE afwijking: STOP, niets herstellen, uitkomst doorgeven. De rollback
-- staat in de kop van de migratie en vraagt akkoord van de eigenaar.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── POST 1. De tien nieuwe functies: exact het beoordeelde lichaam en veilig ──
-- Verwacht: 10 rijen, elke booleaanse kolom `true`.
SELECT h.naam,
       coalesce(md5(p.prosrc) = h.md5_lichaam, false)                          AS lichaam_exact,
       coalesce(p.prosecdef, false)                                            AS security_definer,
       coalesce(p.proconfig = ARRAY['search_path=public'], false)              AS search_path_vast,
       coalesce(p.provolatile = 'v', false)                                    AS volatile,
       coalesce(p.proowner = (SELECT proowner FROM pg_proc
                     WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure), false) AS eigenaar_als_schrijvers,
       p.oid IS NOT NULL
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE') = h.rpc
       AND NOT has_function_privilege('anon',         p.oid, 'EXECUTE')
       AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS uitvoerrecht_exact
FROM (VALUES
  ('enforce_bank_allocation_not_released',             '42dc33ad0be7438a99c66cd666145a11', false),
  ('enforce_bank_transaction_posting_event',           '3ea2b4ed4896ca42e986421be9789432', false),
  ('enforce_bank_transaction_posting_marker_delete',   '864dd9bf71ba88b267519dfe6e1e7ffe', false),
  ('enforce_bank_transaction_posting_marker_lineage',  'b0c9006afaf0772080159ab24e1d7053', false),
  ('enforce_bank_transaction_release_hold',            '812d151a7041cdd48b7a784cd193a159', false),
  ('prevent_bank_transaction_posting_event_mutation',  'fc27ac341d6b72c0a20afb2b306393f7', false),
  ('prevent_bank_transaction_posting_marker_mutation', '3fe50540a21d6daffd9b0ea98324a8aa', false),
  ('reclassify_bank_transaction',                      '56433abfb8baa40335f42f394e93451d', true),
  ('release_bank_transaction_posting',                 '30bc7aaf9bdfce2aeb0d31f00641d4ad', true),
  ('return_bank_transaction_to_workflow',              '5334092758eb40def4c58a97403c841c', true)) h(naam, md5_lichaam, rpc)
LEFT JOIN pg_proc p ON p.proname = h.naam AND p.pronamespace = 'public'::regnamespace
ORDER BY h.naam;


-- ── POST 2. De negen triggers: exacte definitie en inschakeling ─────────────
-- Verwacht: 9 rijen, `definitie_exact` en `inschakeling_exact` overal `true`.
-- Weigerende triggers zijn ENABLE ALWAYS ('A'), valideringstriggers gewoon ('O').
SELECT h.tgname,
       coalesce(pg_get_triggerdef(t.oid) = h.definitie, false) AS definitie_exact,
       coalesce(t.tgenabled = h.modus, false)                  AS inschakeling_exact
FROM (VALUES
  ('enforce_bank_transaction_posting_event_trigger', 'O',
   'CREATE TRIGGER enforce_bank_transaction_posting_event_trigger BEFORE INSERT ON public.bank_transaction_posting_events FOR EACH ROW EXECUTE FUNCTION enforce_bank_transaction_posting_event()'),
  ('enforce_bank_transaction_posting_marker_delete_trigger', 'A',
   'CREATE TRIGGER enforce_bank_transaction_posting_marker_delete_trigger BEFORE DELETE ON public.bank_transaction_postings FOR EACH ROW EXECUTE FUNCTION enforce_bank_transaction_posting_marker_delete()'),
  ('enforce_bank_transaction_posting_marker_lineage_trigger', 'A',
   'CREATE CONSTRAINT TRIGGER enforce_bank_transaction_posting_marker_lineage_trigger AFTER DELETE ON public.bank_transaction_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_bank_transaction_posting_marker_lineage()'),
  ('enforce_bank_transaction_release_hold_trigger', 'A',
   'CREATE TRIGGER enforce_bank_transaction_release_hold_trigger BEFORE DELETE OR UPDATE ON public.bank_transactions FOR EACH ROW EXECUTE FUNCTION enforce_bank_transaction_release_hold()'),
  ('prevent_bank_transaction_posting_event_mutation_trigger', 'A',
   'CREATE TRIGGER prevent_bank_transaction_posting_event_mutation_trigger BEFORE DELETE OR UPDATE ON public.bank_transaction_posting_events FOR EACH ROW EXECUTE FUNCTION prevent_bank_transaction_posting_event_mutation()'),
  ('prevent_bank_transaction_posting_event_truncate_trigger', 'A',
   'CREATE TRIGGER prevent_bank_transaction_posting_event_truncate_trigger BEFORE TRUNCATE ON public.bank_transaction_posting_events FOR EACH STATEMENT EXECUTE FUNCTION prevent_bank_transaction_posting_event_mutation()'),
  ('prevent_bank_transaction_posting_marker_truncate_trigger', 'A',
   'CREATE TRIGGER prevent_bank_transaction_posting_marker_truncate_trigger BEFORE TRUNCATE ON public.bank_transaction_postings FOR EACH STATEMENT EXECUTE FUNCTION prevent_bank_transaction_posting_marker_mutation()'),
  ('prevent_bank_transaction_posting_marker_update_trigger', 'A',
   'CREATE TRIGGER prevent_bank_transaction_posting_marker_update_trigger BEFORE UPDATE ON public.bank_transaction_postings FOR EACH ROW EXECUTE FUNCTION prevent_bank_transaction_posting_marker_mutation()'),
  ('validate_bank_allocation_not_released_trigger', 'O',
   'CREATE TRIGGER validate_bank_allocation_not_released_trigger AFTER INSERT OR UPDATE OF bank_transaction_id ON public.bank_transaction_allocations FOR EACH ROW EXECUTE FUNCTION enforce_bank_allocation_not_released()'))
  h(tgname, modus, definitie)
LEFT JOIN pg_trigger t ON t.tgname = h.tgname
ORDER BY h.tgname;


-- ── POST 3. De gebeurtenistabel: leeg, alleen-lezen, RLS, juiste vorm ───────
-- Verwacht: één rij, elke booleaanse kolom `true`.
SELECT
  to_regclass('public.bank_transaction_posting_events') IS NOT NULL                     AS bestaat,
  (SELECT count(*) FROM public.bank_transaction_posting_events) = 0                     AS leeg,
  (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class
   WHERE oid = 'public.bank_transaction_posting_events'::regclass)                      AS rls_aan,
  (SELECT array_agg(format('%s/%s/%s', policyname, cmd, roles)) FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'bank_transaction_posting_events')
    = ARRAY['role_bank_transaction_posting_events_select/SELECT/{authenticated}']
  AND (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_transaction_posting_events')
      LIKE '%read_only%'                                                                AS een_leespolicy,
  has_table_privilege('authenticated', 'public.bank_transaction_posting_events', 'SELECT')
  AND has_table_privilege('service_role', 'public.bank_transaction_posting_events', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.bank_transaction_posting_events', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  AND NOT has_table_privilege('service_role',  'public.bank_transaction_posting_events', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  AND NOT has_table_privilege('anon',          'public.bank_transaction_posting_events', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
                                                                                         AS alleen_lezen,
  NOT has_sequence_privilege('anon',          'public.bank_transaction_posting_events_seq_seq', 'USAGE, SELECT, UPDATE')
  AND NOT has_sequence_privilege('authenticated', 'public.bank_transaction_posting_events_seq_seq', 'USAGE, SELECT, UPDATE')
  AND NOT has_sequence_privilege('service_role',  'public.bank_transaction_posting_events_seq_seq', 'USAGE, SELECT, UPDATE')
                                                                                         AS sequence_dicht,
  (SELECT relowner FROM pg_class WHERE oid = 'public.bank_transaction_posting_events'::regclass)
    = (SELECT proowner FROM pg_proc WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure) AS eigenaar_als_schrijvers,
  (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.bank_transaction_posting_events'::regclass AND contype = 'f') = 7
  AND (SELECT array_agg(conname::text ORDER BY conname COLLATE "C") FROM pg_constraint
       WHERE conrelid = 'public.bank_transaction_posting_events'::regclass AND contype <> 'f')
      = ARRAY['bank_transaction_posting_events_description_check', 'bank_transaction_posting_events_groups_distinct_check',
              'bank_transaction_posting_events_kind_check', 'bank_transaction_posting_events_percentage_check',
              'bank_transaction_posting_events_pkey', 'bank_transaction_posting_events_reason_check',
              'bank_transaction_posting_events_replacement_key', 'bank_transaction_posting_events_request_key',
              'bank_transaction_posting_events_reversal_key', 'bank_transaction_posting_events_seq_key',
              'bank_transaction_posting_events_shape_check', 'bank_transaction_posting_events_snapshot_check',
              'bank_transaction_posting_events_superseded_key', 'bank_transaction_posting_events_type_check']
                                                                                         AS constraints_exact,
  -- De definities zelf (niet alleen de namen), zoals beoordeeld.
  (SELECT md5(string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname COLLATE "C"))
   FROM pg_constraint WHERE conrelid = 'public.bank_transaction_posting_events'::regclass)
    = '18d7dde03f4eccbe157666d0809dbb2c'                                                 AS constraint_definities_exact,
  -- Eén request_id is één handeling.
  pg_get_indexdef('public.bank_transaction_posting_events_request_once'::regclass)
    = 'CREATE UNIQUE INDEX bank_transaction_posting_events_request_once ON public.bank_transaction_posting_events USING btree (actor_id, request_id) WHERE (NOT ((event_type = ''returned''::text) AND (request_kind = ''reclassify''::text)))'
                                                                                         AS request_once_exact;


-- ── POST 4. De acht PR H-functies en de drie PR 0-guards zijn onaangeroerd ──
-- Verwacht: 11 rijen, `gelijk` overal `true` (dezelfde query als PRE 2).
SELECT h.naam, md5(p.prosrc) AS md5_productie, h.verwacht, coalesce(md5(p.prosrc) = h.verwacht, false) AS gelijk
FROM (VALUES
  ('post_purchase_invoice',        '6366f052209d9a171f197de77eaf477a'),
  ('post_sales_invoice',           'cb467b35301239c3051c8b918662ea45'),
  ('post_bank_allocation',         '863d9e87ef89f7230a9ef020c49b168d'),
  ('post_manual_journal',          '2668c9ed24ef515b7016be29e8b6ffe5'),
  ('post_opening_balance',         '98cbf351067c0135943d910f86e792d6'),
  ('reverse_posting_group',        'b5db0ca04b5dcfbcec5dea1a7844fe13'),
  ('post_bank_transaction',        '2369978c713ac78a0c039dd5c3e5eb4c'),
  ('bank_bulk_posting_candidates', '946bef45005d6e572a7565da6fc12cdb'),
  ('enforce_bank_allocation_not_directly_posted',         '8855c971ecaa5bab46579c3ca5af5e58'),
  ('enforce_bank_allocation_posting_not_directly_posted', 'fb390f45211a7c4e909e4fc8590389b0'),
  ('enforce_bank_direct_posting_without_allocations',     '2c5174b792b86c1ee007c853be0602c7')) h(naam, verwacht)
LEFT JOIN pg_proc p ON p.proname = h.naam AND p.pronamespace = 'public'::regnamespace
ORDER BY h.naam;


-- ── POST 5. Markers: nog steeds alleen lezen voor applicatierollen ──────────
-- Verwacht: één rij, elke kolom `false`.
SELECT
  has_table_privilege('authenticated', 'public.bank_transaction_postings', 'INSERT, UPDATE, DELETE') AS auth_schrijft_directe_marker,
  has_table_privilege('service_role',  'public.bank_transaction_postings', 'INSERT, UPDATE, DELETE') AS service_schrijft_directe_marker,
  has_table_privilege('authenticated', 'public.ledger_reversal_postings',  'INSERT, UPDATE, DELETE') AS auth_schrijft_tegenboekingsmarker,
  has_table_privilege('service_role',  'public.ledger_reversal_postings',  'INSERT, UPDATE, DELETE') AS service_schrijft_tegenboekingsmarker,
  has_table_privilege('anon',          'public.bank_transaction_postings', 'SELECT, INSERT')         AS anon_raakt_directe_marker;


-- ── POST 6. Data onveranderd ────────────────────────────────────────────────
-- Exact dezelfde query als PRE 6. Verwacht: letterlijk dezelfde rijen en digests.
SELECT 'bank_transactions' AS tabel, count(*) AS rijen,
       md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) AS digest
FROM public.bank_transactions t
UNION ALL
SELECT 'bank_transaction_allocations', count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), ''))
FROM public.bank_transaction_allocations t
UNION ALL
SELECT 'bank_allocation_postings', count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t.allocation_id), ''))
FROM public.bank_allocation_postings t
UNION ALL
SELECT 'bank_transaction_postings', count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t.bank_transaction_id), ''))
FROM public.bank_transaction_postings t
UNION ALL
SELECT 'ledger_postings', count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), ''))
FROM public.ledger_postings t
UNION ALL
SELECT 'ledger_reversal_postings', count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t.original_posting_group_id), ''))
FROM public.ledger_reversal_postings t;


-- ── POST 7. Catalogus: precies de nieuwe objecten, verder letterlijk gelijk ──
-- Exact dezelfde query als PRE 7. Verwacht t.o.v. PRE 7:
--   publieke_functies + 10, triggers_public + 9, tabellen + 1, sequences + 1,
--   policies + 1; ALLE andere kolommen letterlijk gelijk.
SELECT
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)                            AS publieke_functies,
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace)                                AS triggers_public,
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p'))  AS tabellen,
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S')         AS sequences,
  (SELECT count(*) FROM pg_policy)                                                                       AS policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace <> 'public'::regnamespace)                           AS functies_buiten_public,
  (SELECT count(*) FROM pg_event_trigger)                                                                AS event_triggers,
  (SELECT md5(coalesce(string_agg(format('%s|%s|%s|%s', c.oid::regclass, c.relkind, coalesce(c.relacl::text, ''),
                                         c.relrowsecurity), ',' ORDER BY c.oid::regclass::text), ''))
   FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname NOT IN ('bank_transaction_posting_events', 'bank_transaction_posting_events_seq_seq')
     AND c.relname NOT LIKE 'bank_transaction_posting_events_%'
     AND c.relname NOT LIKE 'idx_bank_transaction_posting_events_%')                                   AS bestaande_relaties_digest,
  (SELECT md5(coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', polrelid::regclass, polname, polcmd, polroles::text,
                                         pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)),
                                  ',' ORDER BY polrelid::regclass::text, polname), ''))
   FROM pg_policy WHERE polrelid <> coalesce(to_regclass('public.bank_transaction_posting_events')::oid, 0::oid)) AS bestaande_policies_digest,
  (SELECT md5(coalesce(string_agg(format('%s|%s|%s|%s', p.oid::regprocedure, md5(p.prosrc), pg_get_userbyid(p.proowner),
                                         coalesce(p.proacl::text, '')), ',' ORDER BY p.oid::regprocedure::text), ''))
   FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname NOT IN (
     'reclassify_bank_transaction', 'release_bank_transaction_posting', 'return_bank_transaction_to_workflow',
     'enforce_bank_transaction_posting_event', 'prevent_bank_transaction_posting_event_mutation',
     'prevent_bank_transaction_posting_marker_mutation', 'enforce_bank_transaction_posting_marker_delete',
     'enforce_bank_transaction_posting_marker_lineage', 'enforce_bank_transaction_release_hold',
     'enforce_bank_allocation_not_released'))                                                          AS bestaande_functies_digest,
  (SELECT md5(coalesce(string_agg(format('%s|%s|%s', t.tgrelid::regclass, t.tgname, t.tgenabled),
                                  ',' ORDER BY t.tgrelid::regclass::text, t.tgname), ''))
   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND t.tgname NOT IN (
     'enforce_bank_transaction_posting_event_trigger', 'prevent_bank_transaction_posting_event_mutation_trigger',
     'prevent_bank_transaction_posting_event_truncate_trigger', 'prevent_bank_transaction_posting_marker_update_trigger',
     'prevent_bank_transaction_posting_marker_truncate_trigger', 'enforce_bank_transaction_posting_marker_delete_trigger',
     'enforce_bank_transaction_posting_marker_lineage_trigger', 'enforce_bank_transaction_release_hold_trigger',
     'validate_bank_allocation_not_released_trigger'))                                                 AS bestaande_triggers_digest;


-- ── POST 8. Lineage-nulpunt: elke directe bankgroep is de actieve marker ────
-- Zonder gebeurtenissen moet elke directe bankgroep de groep van haar marker
-- zijn; dan is de hold voor elke bestaande regel inactief. Verwacht: 0 en 0.
SELECT
  (SELECT count(DISTINCT lp.posting_group_id) FROM public.ledger_postings lp
   WHERE lp.source_type = 'bank_transaction'
     AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                     WHERE m.bank_transaction_id = lp.source_id AND m.posting_group_id = lp.posting_group_id)) AS groepen_zonder_marker,
  (SELECT count(*) FROM public.bank_transaction_posting_events)                                               AS gebeurtenissen;
