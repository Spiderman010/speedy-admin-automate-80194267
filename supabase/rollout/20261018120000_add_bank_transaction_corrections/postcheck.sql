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
--
-- GECOMBINEERDE UITROL (PR 1 + PR 2 + 20261018180000 in één uitvoering, zie
-- supabase/rollout/20261018180000_refine_release_hold_for_settled_history/uitvoerplan.md):
-- dan draagt reclassify_bank_transaction het lichaam van PR 2 en
-- enforce_bank_transaction_release_hold dat van 20261018180000. POST 1 noemt
-- per functie welke beoordeelde versie er staat (`lichaam_versie`); POST 7 en
-- POST 8 houden rekening met de hulpfunctie van 20261018180000.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── POST 1. De tien nieuwe functies: exact het beoordeelde lichaam en veilig ──
-- Verwacht: 10 rijen, elke booleaanse kolom `true`. `lichaam_versie` = 'PR 1',
-- of in de gecombineerde uitrol 'PR 2' (reclassify_bank_transaction) en
-- '20261018180000' (enforce_bank_transaction_release_hold).
SELECT h.naam,
       coalesce(md5(p.prosrc) = h.md5_lichaam
                OR (h.naam = 'reclassify_bank_transaction' AND md5(p.prosrc) = '067939e0c44a672c26ec8883717ef6d2')
                OR (h.naam = 'enforce_bank_transaction_release_hold' AND md5(p.prosrc) = '43347fb9f48ed4c161e291fa769577c2'),
                false)                                                         AS lichaam_exact,
       CASE md5(p.prosrc) WHEN h.md5_lichaam THEN 'PR 1'
                          WHEN '067939e0c44a672c26ec8883717ef6d2' THEN 'PR 2'
                          WHEN '43347fb9f48ed4c161e291fa769577c2' THEN '20261018180000'
                          ELSE 'ONBEKEND' END                                  AS lichaam_versie,
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
  ('enforce_bank_transaction_posting_event',           '66128cecc40974265cebad258752650b', false),
  ('enforce_bank_transaction_posting_marker_delete',   '864dd9bf71ba88b267519dfe6e1e7ffe', false),
  ('enforce_bank_transaction_posting_marker_lineage',  'b0c9006afaf0772080159ab24e1d7053', false),
  ('enforce_bank_transaction_release_hold',            '812d151a7041cdd48b7a784cd193a159', false),
  ('prevent_bank_transaction_posting_event_mutation',  'fc27ac341d6b72c0a20afb2b306393f7', false),
  ('prevent_bank_transaction_posting_marker_mutation', '3fe50540a21d6daffd9b0ea98324a8aa', false),
  ('reclassify_bank_transaction',                      'a931207c1a4e97f06e7797ed105c0264', true),
  ('release_bank_transaction_posting',                 '2c3a2e8b93292336ea319fa512b7e09b', true),
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
-- Verwacht: één rij, elke booleaanse kolom `true`. `constraint_definities_exact`
-- en `request_once_exact` (en in POST 2 `definitie_exact`) vergelijken gedeparste
-- tekst, beoordeeld op PostgreSQL 16. Is alléén zo'n kolom `false` en de rest
-- `true`, dan kan het een opmaakverschil van een andere serverversie zijn (zie
-- `serverversie` in PRE 8): ook dan STOP en melden, niet zelf verklaren.
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
    = 'ad4f6acefcbfe1728f1594ebc92c665e'                                                 AS constraint_definities_exact,
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
--   publieke_functies + 10 (+ 11 in de gecombineerde uitrol: de hulpfunctie
--   bank_transaction_group_is_settled_history), triggers_public + 9,
--   tabellen + 1, sequences + 1, policies + 1; ALLE andere kolommen letterlijk gelijk.
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
     'enforce_bank_allocation_not_released', 'bank_transaction_group_is_settled_history'))            AS bestaande_functies_digest,
  (SELECT md5(coalesce(string_agg(format('%s|%s|%s', t.tgrelid::regclass, t.tgname, t.tgenabled),
                                  ',' ORDER BY t.tgrelid::regclass::text, t.tgname), ''))
   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND t.tgname NOT IN (
     'enforce_bank_transaction_posting_event_trigger', 'prevent_bank_transaction_posting_event_mutation_trigger',
     'prevent_bank_transaction_posting_event_truncate_trigger', 'prevent_bank_transaction_posting_marker_update_trigger',
     'prevent_bank_transaction_posting_marker_truncate_trigger', 'enforce_bank_transaction_posting_marker_delete_trigger',
     'enforce_bank_transaction_posting_marker_lineage_trigger', 'enforce_bank_transaction_release_hold_trigger',
     'validate_bank_allocation_not_released_trigger'))                                                 AS bestaande_triggers_digest;


-- ── POST 8. Lineage-nulpunt: elke directe bankgroep is verklaard ─────────────
-- Elke directe bankgroep moet de groep van haar marker zijn, als vervangen in
-- een gebeurtenis staan, of een BEWEZEN historische storno zijn (dezelfde
-- bewijsstukken als PRE 4b, plus: in geen gebeurtenis genoemd en strikt ouder
-- dan de eerste gebeurtenis van die transactie). Alles daarbuiten is STOP.
-- `hold_versie` zegt of 20261018180000 er al is; alleen dan dekt de
-- vrijgave-hold een regel met een historische storno.
-- Verwacht direct na de migratie: waarvan_onverklaard = 0, gebeurtenissen = 0,
-- en `toestand` = 'IN ORDE'. 'TIJDELIJK …' betekent: PR 1 staat er zonder de
-- fix terwijl er een historische storno is — dat mag alleen binnen de
-- gecombineerde uitrol voorkomen en nooit zichtbaar worden (STOP, melden).
WITH kandidaat AS (
  SELECT DISTINCT lp.source_id AS tx, lp.posting_group_id AS grp
  FROM public.ledger_postings lp
  WHERE lp.source_type = 'bank_transaction'
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                    WHERE m.bank_transaction_id = lp.source_id AND m.posting_group_id = lp.posting_group_id)
), bewijs AS (
  SELECT k.tx, k.grp,
    EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e WHERE e.superseded_posting_group_id = k.grp) AS vervangen,
    coalesce(
      NOT EXISTS (SELECT 1 FROM public.ledger_postings o WHERE o.posting_group_id = k.grp
                  AND (o.source_type <> 'bank_transaction' OR o.source_id IS DISTINCT FROM k.tx))
      AND (SELECT count(*) FROM public.ledger_reversal_postings r1 WHERE r1.original_posting_group_id = k.grp) = 1
      AND r.original_source_type = 'bank_transaction'
      AND (SELECT count(*) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id)
          = (SELECT count(*) FROM public.ledger_postings o WHERE o.posting_group_id = k.grp)
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id
                      AND (v.source_type <> 'reversal' OR v.source_id IS DISTINCT FROM k.grp OR v.reversal_of_posting_id IS NULL
                           OR NOT EXISTS (SELECT 1 FROM public.ledger_postings o
                                          WHERE o.posting_group_id = k.grp AND o.id = v.reversal_of_posting_id)))
      AND (SELECT count(DISTINCT v.reversal_of_posting_id) FROM public.ledger_postings v WHERE v.posting_group_id = r.reversal_posting_group_id)
          = (SELECT count(*) FROM public.ledger_postings o WHERE o.posting_group_id = k.grp)
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings x
                      WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id) AND x.posting_date <> bt.transaction_date)
      AND r.posting_date = bt.transaction_date AND r.original_posting_date = bt.transaction_date
      AND NOT EXISTS (SELECT x.grootboekrekening_id FROM public.ledger_postings x
                      WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id)
                      GROUP BY x.grootboekrekening_id HAVING sum(x.debit_amount - x.credit_amount) <> 0)
      AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r2 WHERE r2.original_posting_group_id = r.reversal_posting_group_id)
      AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                      WHERE e.superseded_posting_group_id = k.grp OR e.replacement_posting_group_id = k.grp)
      AND EXISTS (SELECT 1 FROM public.ledger_postings g2
                  WHERE g2.source_type = 'bank_transaction' AND g2.source_id = k.tx AND g2.posting_group_id <> k.grp
                    AND g2.created_at >= (SELECT max(v.created_at) FROM public.ledger_postings v
                                          WHERE v.posting_group_id = r.reversal_posting_group_id))
      AND NOT EXISTS (SELECT 1
                      FROM (SELECT min(e.created_at) AS at FROM public.bank_transaction_posting_events e
                            WHERE e.bank_transaction_id = k.tx) f,
                           (SELECT x.created_at FROM public.ledger_postings x WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id)
                            UNION ALL SELECT r.created_at) y
                      WHERE f.at IS NOT NULL AND y.created_at >= f.at),
      false) AS historisch
  FROM kandidaat k
  JOIN public.bank_transactions bt ON bt.id = k.tx
  LEFT JOIN public.ledger_reversal_postings r ON r.original_posting_group_id = k.grp
), telling AS (
  SELECT
    (SELECT count(DISTINCT grp) FROM kandidaat)                                                   AS groepen_zonder_marker,
    (SELECT count(DISTINCT grp) FROM bewijs b WHERE b.vervangen
       AND NOT EXISTS (SELECT 1 FROM bewijs b2 WHERE b2.grp = b.grp AND NOT b2.vervangen))        AS waarvan_vervangen,
    (SELECT count(DISTINCT grp) FROM bewijs b WHERE NOT b.vervangen AND b.historisch
       AND NOT EXISTS (SELECT 1 FROM bewijs b2 WHERE b2.grp = b.grp AND NOT b2.historisch))       AS waarvan_historische_storno,
    (SELECT count(DISTINCT grp) FROM bewijs b WHERE NOT b.vervangen AND NOT b.historisch)          AS waarvan_onverklaard,
    (SELECT count(*) FROM public.bank_transaction_posting_events)                                 AS gebeurtenissen,
    CASE (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()'))
      WHEN '812d151a7041cdd48b7a784cd193a159' THEN 'PR 1'
      WHEN '43347fb9f48ed4c161e291fa769577c2' THEN '20261018180000'
      ELSE 'ONBEKEND' END                                                                         AS hold_versie
)
SELECT t.*,
       CASE WHEN t.waarvan_onverklaard > 0 OR t.hold_versie = 'ONBEKEND' THEN 'STOP'
            WHEN t.waarvan_historische_storno > 0 AND t.hold_versie = 'PR 1'
              THEN 'TIJDELIJK — de hold dekt de historische storno nog niet; geen gebruikersactiviteit tot 20261018180000 (STOP, melden)'
            ELSE 'IN ORDE' END                                                                    AS toestand
FROM telling t;
