-- BoekAssist bankcorrecties v1.1: gecombineerde POST, alleen SELECT.
-- Voer alleen uit via Lovable Cloud SQL-editor na bevestiging project alxlbdhpbwlehbdbfejw.
-- Behoud de volledige resultaten (JSON per oorspronkelijk controleblok) voor de vergelijking met PRE 6, PRE 7 en PRE B8.
-- Resultaten geven niet automatisch GO; alle voorwaarden in het originele uitvoerplan gelden.
SELECT * FROM (
SELECT 1 AS volgorde, 'PR1 POST 1'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
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
ORDER BY h.naam
) q
UNION ALL
SELECT 2 AS volgorde, 'PR1 POST 2'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
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
ORDER BY h.tgname
) q
UNION ALL
SELECT 3 AS volgorde, 'PR1 POST 3'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
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
  (SELECT md5(string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname COLLATE "C"))
   FROM pg_constraint WHERE conrelid = 'public.bank_transaction_posting_events'::regclass)
    = 'ad4f6acefcbfe1728f1594ebc92c665e'                                                 AS constraint_definities_exact,
  pg_get_indexdef('public.bank_transaction_posting_events_request_once'::regclass)
    = 'CREATE UNIQUE INDEX bank_transaction_posting_events_request_once ON public.bank_transaction_posting_events USING btree (actor_id, request_id) WHERE (NOT ((event_type = ''returned''::text) AND (request_kind = ''reclassify''::text)))'
                                                                                         AS request_once_exact
) q
UNION ALL
SELECT 4 AS volgorde, 'PR1 POST 4'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
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
ORDER BY h.naam
) q
UNION ALL
SELECT 5 AS volgorde, 'PR1 POST 5'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
SELECT
  has_table_privilege('authenticated', 'public.bank_transaction_postings', 'INSERT, UPDATE, DELETE') AS auth_schrijft_directe_marker,
  has_table_privilege('service_role',  'public.bank_transaction_postings', 'INSERT, UPDATE, DELETE') AS service_schrijft_directe_marker,
  has_table_privilege('authenticated', 'public.ledger_reversal_postings',  'INSERT, UPDATE, DELETE') AS auth_schrijft_tegenboekingsmarker,
  has_table_privilege('service_role',  'public.ledger_reversal_postings',  'INSERT, UPDATE, DELETE') AS service_schrijft_tegenboekingsmarker,
  has_table_privilege('anon',          'public.bank_transaction_postings', 'SELECT, INSERT')         AS anon_raakt_directe_marker
) q
UNION ALL
SELECT 6 AS volgorde, 'PR1 POST 6'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
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
FROM public.ledger_reversal_postings t
) q
UNION ALL
SELECT 7 AS volgorde, 'PR1 POST 7'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
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
     'validate_bank_allocation_not_released_trigger'))                                                 AS bestaande_triggers_digest
) q
UNION ALL
SELECT 8 AS volgorde, 'PR1 POST 8'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
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
      bt.id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.ledger_postings o WHERE o.posting_group_id = k.grp
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
                      FROM public.bank_transaction_posting_events f,
                           (SELECT x.created_at, x.created_xact_id FROM public.ledger_postings x
                            WHERE x.posting_group_id IN (k.grp, r.reversal_posting_group_id)
                            UNION ALL SELECT r.created_at, NULL::xid8) y
                      WHERE f.bank_transaction_id = k.tx
                        AND (y.created_at >= f.created_at OR y.created_xact_id >= f.created_xact_id)),
      false) AS historisch
  FROM kandidaat k
  LEFT JOIN public.bank_transactions bt ON bt.id = k.tx
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
FROM telling t
) q
UNION ALL
SELECT 9 AS volgorde, 'PR2 POST 1'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
SELECT
  coalesce(md5(p.prosrc) = '067939e0c44a672c26ec8883717ef6d2', false)                    AS lichaam_exact,
  coalesce(p.prosecdef, false)                                                            AS security_definer,
  coalesce(p.proconfig = ARRAY['search_path=public'], false)                              AS search_path_vast,
  coalesce(p.provolatile = 'v', false)                                                    AS volatile,
  coalesce(p.proowner = (SELECT proowner FROM pg_proc
                         WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure), false) AS eigenaar_als_schrijver,
  coalesce(pg_get_function_result(p.oid) = 'TABLE(outcome text, replayed boolean, posting_group_id uuid, superseded_posting_group_id uuid, reversal_posting_group_id uuid, event_id uuid)', false)
                                                                                          AS uitkomsttype_gelijk,
  p.oid IS NOT NULL
  AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND NOT has_function_privilege('anon',         p.oid, 'EXECUTE')
  AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)               AS uitvoerrecht_exact,
  coalesce(obj_description(p.oid, 'pg_proc') LIKE '%bank_transactions.description blijft na elke correctie byte-gelijk%', false)
                                                                                          AS commentaar_bijgewerkt
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)')
) q
UNION ALL
SELECT 10 AS volgorde, 'PR2 POST 2'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
SELECT h.naam,
       coalesce(md5(p.prosrc) = h.verwacht
                OR (h.naam = 'enforce_bank_transaction_release_hold' AND md5(p.prosrc) = '43347fb9f48ed4c161e291fa769577c2'), false) AS gelijk,
       CASE WHEN md5(p.prosrc) = h.verwacht THEN 'beoordeeld'
            WHEN h.naam = 'enforce_bank_transaction_release_hold' AND md5(p.prosrc) = '43347fb9f48ed4c161e291fa769577c2' THEN '20261018180000'
            ELSE 'ONBEKEND' END AS versie
FROM (VALUES
  ('post_bank_transaction',                            '2369978c713ac78a0c039dd5c3e5eb4c'),
  ('release_bank_transaction_posting',                 '2c3a2e8b93292336ea319fa512b7e09b'),
  ('return_bank_transaction_to_workflow',              '5334092758eb40def4c58a97403c841c'),
  ('enforce_bank_allocation_not_released',             '42dc33ad0be7438a99c66cd666145a11'),
  ('enforce_bank_transaction_posting_event',           '66128cecc40974265cebad258752650b'),
  ('enforce_bank_transaction_posting_marker_delete',   '864dd9bf71ba88b267519dfe6e1e7ffe'),
  ('enforce_bank_transaction_posting_marker_lineage',  'b0c9006afaf0772080159ab24e1d7053'),
  ('enforce_bank_transaction_release_hold',            '812d151a7041cdd48b7a784cd193a159'),
  ('prevent_bank_transaction_posting_event_mutation',  'fc27ac341d6b72c0a20afb2b306393f7'),
  ('prevent_bank_transaction_posting_marker_mutation', '3fe50540a21d6daffd9b0ea98324a8aa')) h(naam, verwacht)
LEFT JOIN pg_proc p ON p.proname = h.naam AND p.pronamespace = 'public'::regnamespace
ORDER BY h.naam
) q
UNION ALL
SELECT 11 AS volgorde, 'PR2 POST 3'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
WITH bekend(tgname, functie, md5, ingeschakeld) AS (VALUES
  ('enforce_bank_transaction_release_hold_trigger',    'enforce_bank_transaction_release_hold',    '812d151a7041cdd48b7a784cd193a159', 'A'),
  ('prevent_org_user_rebind_trg',                      'prevent_org_user_rebind',                  '9d75d3c98a66f0fc0299b795ee40461e', 'O'),
  ('prevent_posted_bank_transaction_mutation_trigger', 'prevent_posted_bank_transaction_mutation', 'a6437536b1942e78d5b072f22fe6a842', 'O'),
  ('set_organization_id_trigger',                      'set_organization_id',                      'e56450399d8f95c5ed42fd2df04bed06', 'O'),
  ('update_bank_transactions_updated_at',              'update_updated_at_column',                 '301a884953d37769916294bb60562e05', 'O')),
actueel AS (
  SELECT t.tgname::text AS tgname, p.proname::text AS functie, md5(p.prosrc) AS md5, t.tgenabled::text AS ingeschakeld
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.bank_transactions'::regclass AND NOT t.tgisinternal)
SELECT coalesce(a.tgname, b.tgname) AS tgname,
       (a.tgname IS NOT NULL AND b.tgname IS NOT NULL
        AND a.functie = b.functie AND a.ingeschakeld = b.ingeschakeld
        AND (a.md5 = b.md5 OR (a.functie = 'enforce_bank_transaction_release_hold' AND a.md5 = '43347fb9f48ed4c161e291fa769577c2'))) AS bekend,
       CASE WHEN a.md5 = b.md5 THEN 'beoordeeld'
            WHEN a.functie = 'enforce_bank_transaction_release_hold' AND a.md5 = '43347fb9f48ed4c161e291fa769577c2' THEN '20261018180000'
            ELSE 'ONBEKEND' END AS versie
FROM actueel a FULL JOIN bekend b ON b.tgname = a.tgname
ORDER BY 1
) q
UNION ALL
SELECT 12 AS volgorde, 'PR2 POST 4'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
SELECT
  (SELECT count(*) FROM public.bank_transactions)                                         AS banktransacties,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(encode(convert_to(description, 'UTF8'), 'hex'), '-'), ',' ORDER BY id), ''))
   FROM public.bank_transactions)                                                         AS bankomschrijvingen_md5,
  (SELECT count(*) FROM public.ledger_postings)                                           AS grootboekregels,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(description, '-'), ',' ORDER BY id), ''))
   FROM public.ledger_postings)                                                           AS grootboektekst_md5,
  (SELECT count(*) FROM public.bank_transaction_posting_events)                           AS gebeurtenissen,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)              AS functies_public,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)                                AS triggers
) q
UNION ALL
SELECT 13 AS volgorde, 'FIX POST C1'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
SELECT
  coalesce(md5(p.prosrc) = '697f9413067e9c5b73323b792c51cda9', false)                    AS lichaam_exact,
  coalesce(p.provolatile = 's', false)                                                    AS stable,
  coalesce(NOT p.prosecdef, false)                                                        AS geen_security_definer,
  coalesce(p.proconfig = ARRAY['search_path=public'], false)                              AS search_path_vast,
  coalesce(p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql'), false)       AS taal_sql,
  coalesce(p.proowner = (SELECT proowner FROM pg_proc
                         WHERE oid = to_regprocedure('public.post_bank_transaction(uuid)')), false) AS eigenaar_als_schrijver,
  p.oid IS NOT NULL
  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND NOT has_function_privilege('anon',          p.oid, 'EXECUTE')
  AND NOT has_function_privilege('service_role',  p.oid, 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)               AS uitvoerrecht_dicht
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)')
) q
UNION ALL
SELECT 14 AS volgorde, 'FIX POST C2'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
SELECT
  coalesce(md5(p.prosrc) = '43347fb9f48ed4c161e291fa769577c2', false)                    AS lichaam_exact,
  coalesce(p.prosecdef, false)                                                            AS security_definer,
  coalesce(p.proconfig = ARRAY['search_path=public'], false)                              AS search_path_vast,
  coalesce(p.provolatile = 'v', false)                                                    AS volatile,
  coalesce(p.proowner = (SELECT proowner FROM pg_proc
                         WHERE oid = to_regprocedure('public.post_bank_transaction(uuid)')), false) AS eigenaar_als_schrijver,
  p.oid IS NOT NULL
  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND NOT has_function_privilege('anon',          p.oid, 'EXECUTE')
  AND NOT has_function_privilege('service_role',  p.oid, 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)               AS uitvoerrecht_dicht,
  coalesce(obj_description(p.oid, 'pg_proc') LIKE '%schakelt die hold niet uit%', false)  AS commentaar_bijgewerkt
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()')
) q
UNION ALL
SELECT 15 AS volgorde, 'FIX POST C3'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
SELECT
  coalesce(pg_get_triggerdef(t.oid) =
    'CREATE TRIGGER enforce_bank_transaction_release_hold_trigger BEFORE DELETE OR UPDATE ON public.bank_transactions FOR EACH ROW EXECUTE FUNCTION enforce_bank_transaction_release_hold()', false) AS definitie_exact,
  coalesce(t.tgenabled = 'A', false)                                                      AS enable_always,
  coalesce(t.tgfoid = to_regprocedure('public.enforce_bank_transaction_release_hold()'), false) AS juiste_functie
FROM pg_trigger t
WHERE t.tgrelid = 'public.bank_transactions'::regclass AND t.tgname = 'enforce_bank_transaction_release_hold_trigger'
) q
UNION ALL
SELECT 16 AS volgorde, 'FIX POST C4'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
SELECT k.tx AS banktransactie, k.grp AS groep,
       EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e WHERE e.superseded_posting_group_id = k.grp) AS vervangen,
       public.bank_transaction_group_is_settled_history(k.tx, k.grp)                                           AS bewezen_historisch,
       k.grp = 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a'                                                          AS bekend,
       coalesce((SELECT max(x.created_at) FROM public.ledger_postings x
                 WHERE x.posting_group_id = k.grp
                    OR x.posting_group_id = (SELECT r.reversal_posting_group_id FROM public.ledger_reversal_postings r
                                             WHERE r.original_posting_group_id = k.grp)) < now()
                AND coalesce((SELECT r.created_at FROM public.ledger_reversal_postings r
                              WHERE r.original_posting_group_id = k.grp) < now(), true), false)                    AS in_verleden
FROM (SELECT DISTINCT lp.source_id AS tx, lp.posting_group_id AS grp
      FROM public.ledger_postings lp
      WHERE lp.source_type = 'bank_transaction'
        AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                        WHERE m.bank_transaction_id = lp.source_id AND m.posting_group_id = lp.posting_group_id)) k
ORDER BY k.tx, k.grp
) q
UNION ALL
SELECT 17 AS volgorde, 'FIX POST C5'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
SELECT m.bank_transaction_id AS banktransactie, m.posting_group_id AS actuele_groep,
       NOT EXISTS (
         SELECT 1 FROM public.ledger_postings lp
         WHERE lp.source_type = 'bank_transaction' AND lp.source_id = m.bank_transaction_id
           AND lp.posting_group_id <> m.posting_group_id
           AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                           WHERE e.superseded_posting_group_id = lp.posting_group_id)
           AND NOT public.bank_transaction_group_is_settled_history(m.bank_transaction_id, lp.posting_group_id)) AS hold_dekt_na_vrijgave
FROM public.bank_transaction_postings m
WHERE EXISTS (SELECT 1 FROM public.ledger_postings lp2
              WHERE lp2.source_type = 'bank_transaction' AND lp2.source_id = m.bank_transaction_id
                AND lp2.posting_group_id <> m.posting_group_id
                AND public.bank_transaction_group_is_settled_history(m.bank_transaction_id, lp2.posting_group_id))
ORDER BY 1
) q
UNION ALL
SELECT 18 AS volgorde, 'FIX POST C6'::text AS controle, count(*) AS rijen, coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) AS resultaat FROM (
SELECT
  (SELECT count(*) FROM public.bank_transactions)                                         AS banktransacties,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(encode(convert_to(description, 'UTF8'), 'hex'), '-'), ',' ORDER BY id), ''))
   FROM public.bank_transactions)                                                         AS bankomschrijvingen_md5,
  (SELECT count(*) FROM public.ledger_postings)                                           AS grootboekregels,
  (SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(description, '-'), ',' ORDER BY id), ''))
   FROM public.ledger_postings)                                                           AS grootboektekst_md5,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)              AS functies_public,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)                                AS triggers
) q
) AS combined ORDER BY volgorde;
