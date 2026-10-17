-- ═════════════════════════════════════════════════════════════════════════════
-- PRE — leescontroles vóór 20261018120000_add_bank_transaction_corrections.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor (Lovable → Cloud-icoon, of
-- Cmd/Ctrl+K → "Cloud"), NA visuele bevestiging dat het actieve project exact
-- `alxlbdhpbwlehbdbfejw` is (controlelijst in PROJECT_MAP.md: de Request-URL-
-- host en de `sb-project-ref`-header in het netwerktabblad, en de projectref in
-- de editor). Nooit het persoonlijke Supabase-dashboard, nooit de Vercel
-- Marketplace-database, nooit olumcwneiejjefhkzgmz of ycuofllsdssoezwwpqmv.
--
-- Alles hieronder is ALLEEN LEZEN. Voer de blokken één voor één uit (de editor
-- toont van een meervoudige uitvoering alleen het laatste resultaat) en bewaar
-- de uitkomst van PRE 6 en PRE 7: POST 6 en POST 7 vergelijken ermee.
--
-- MOMENT: PRE, migratie en POST direct na elkaar op een rustig moment (niemand
-- actief in BoekAssist). Plak bij de migratie `SET lock_timeout = '5s';` als
-- EERSTE REGEL in DEZELFDE uitvoering als het ongewijzigde migratiebestand;
-- een losse uitvoering gebruikt niet gegarandeerd dezelfde verbinding.
--
-- STOP (niet migreren, niets herstellen, uitkomst doorgeven) als:
--   • PRE 1, PRE 2 of PRE 8 ergens `false` geeft;
--   • PRE 4 `stop = true` geeft (een bankboeking die niet de vorm van de
--     schrijver heeft, of een directe bankgroep zonder marker);
--   • een query een foutmelding geeft.
-- PRE 3, PRE 5, PRE 9 en PRE 10 zijn informatief.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── PRE 1. Vereisten aanwezig, PR 1 nog niet ────────────────────────────────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  to_regclass('public.bank_transactions')            IS NOT NULL
  AND to_regclass('public.bank_transaction_postings')    IS NOT NULL
  AND to_regclass('public.bank_transaction_allocations') IS NOT NULL
  AND to_regclass('public.bank_allocation_postings')     IS NOT NULL
  AND to_regclass('public.ledger_postings')              IS NOT NULL
  AND to_regclass('public.ledger_reversal_postings')     IS NOT NULL      AS tabellen,
  to_regprocedure('public.post_bank_transaction(uuid)')            IS NOT NULL
  AND to_regprocedure('public.reverse_posting_group(uuid,date,text)')  IS NOT NULL
  AND to_regprocedure('public.assert_posting_allowed(uuid,date)')      IS NOT NULL
  AND to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)')     IS NOT NULL
  AND to_regprocedure('public.has_min_role(uuid,uuid,app_role)')       IS NOT NULL AS schrijvers_en_hulpfuncties,
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'bank_transaction_postings'
           AND column_name IN ('bank_transaction_id', 'posting_group_id', 'grootboekrekening_id', 'posting_date',
                               'boekjaar', 'gross_amount', 'net_amount', 'btw_amount', 'btw_percentage',
                               'user_id', 'created_at'))
       OR (table_name = 'ledger_postings' AND column_name = 'created_xact_id')
       OR (table_name = 'ledger_reversal_postings'
           AND column_name IN ('original_posting_group_id', 'reversal_posting_group_id')))) = 14 AS kolommen,
  -- 20261017120000 (PR 0) moet aantoonbaar zijn toegepast: drie guards, ingeschakeld.
  to_regprocedure('public.enforce_bank_allocation_not_directly_posted()') IS NOT NULL
  AND to_regprocedure('public.enforce_bank_allocation_posting_not_directly_posted()') IS NOT NULL
  AND to_regprocedure('public.enforce_bank_direct_posting_without_allocations()') IS NOT NULL
  AND (SELECT count(*) FROM pg_trigger WHERE tgenabled = 'O' AND tgname IN
       ('validate_bank_allocation_not_directly_posted_trigger',
        'validate_bank_allocation_posting_not_directly_posted_trigger',
        'validate_bank_direct_posting_without_allocations_trigger')) = 3    AS pr0_toegepast,
  to_regclass('public.bank_transaction_posting_events') IS NULL
  AND to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') IS NULL
  AND to_regprocedure('public.release_bank_transaction_posting(uuid,uuid,uuid,text)') IS NULL
  AND to_regprocedure('public.return_bank_transaction_to_workflow(uuid,uuid,text)') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (
        'enforce_bank_transaction_posting_event', 'prevent_bank_transaction_posting_event_mutation',
        'prevent_bank_transaction_posting_marker_mutation', 'enforce_bank_transaction_posting_marker_delete',
        'enforce_bank_transaction_posting_marker_lineage', 'enforce_bank_transaction_release_hold',
        'enforce_bank_allocation_not_released'))
  AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN (
        'enforce_bank_transaction_posting_marker_delete_trigger', 'enforce_bank_transaction_posting_marker_lineage_trigger',
        'prevent_bank_transaction_posting_marker_update_trigger', 'prevent_bank_transaction_posting_marker_truncate_trigger',
        'enforce_bank_transaction_release_hold_trigger', 'validate_bank_allocation_not_released_trigger'))
                                                                          AS pr1_nog_afwezig;


-- ── PRE 2. De acht PR H-functies en de drie PR 0-guards: exact beoordeeld ──
-- Verwacht: 11 rijen, `gelijk` overal `true`.
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


-- ── PRE 3. Omvang (informatief) ─────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM public.bank_transactions)            AS banktransacties,
  (SELECT count(*) FROM public.bank_transaction_postings)    AS directe_boekingen,
  (SELECT count(*) FROM public.bank_transaction_postings m
   WHERE EXISTS (SELECT 1 FROM public.ledger_reversal_postings r WHERE r.original_posting_group_id = m.posting_group_id))
                                                             AS handmatig_tegengeboekt_s2,
  (SELECT count(*) FROM public.bank_transaction_allocations) AS koppelingen,
  (SELECT count(*) FROM public.bank_allocation_postings)     AS geboekte_afletteringen,
  (SELECT count(*) FROM public.ledger_postings)              AS grootboekregels,
  (SELECT count(*) FROM public.ledger_reversal_postings)     AS tegenboekingen;


-- ── PRE 4. Vorm van de bestaande directe bankboekingen (STOP-controle) ──────
-- De correctie-RPC leest het origineel als de schrijver het maakte: één regel
-- aan de bankzijde (het bruto), aan de tegenzijde netto (+ BTW), alle regels
-- van deze transactie en op de markerdatum. Een afwijkende groep kan de RPC
-- niet veilig corrigeren; een directe bankgroep zonder marker breekt de
-- lineage-aanname. Verwacht: beide 0, stop = false.
WITH g AS (
  SELECT m.bank_transaction_id AS tx, m.posting_group_id AS grp, m.gross_amount, m.net_amount, m.btw_amount,
         m.posting_date, bt.amount
  FROM public.bank_transaction_postings m
  JOIN public.bank_transactions bt ON bt.id = m.bank_transaction_id
), shape AS (
  SELECT g.grp,
         count(lp.*)                                                                             AS regels,
         count(*) FILTER (WHERE lp.source_type <> 'bank_transaction' OR lp.source_id <> g.tx
                             OR lp.posting_date <> g.posting_date)                               AS vreemd,
         count(*) FILTER (WHERE (g.amount < 0 AND lp.credit_amount > 0) OR (g.amount > 0 AND lp.debit_amount > 0)) AS bankzijde,
         count(*) FILTER (WHERE ((g.amount < 0 AND lp.credit_amount > 0) OR (g.amount > 0 AND lp.debit_amount > 0))
                             AND lp.debit_amount + lp.credit_amount = g.gross_amount)            AS bankzijde_bruto,
         count(*) FILTER (WHERE (g.amount < 0 AND lp.debit_amount > 0) OR (g.amount > 0 AND lp.credit_amount > 0)) AS tegenzijde,
         max(g.btw_amount) AS btw
  FROM g LEFT JOIN public.ledger_postings lp ON lp.posting_group_id = g.grp
  GROUP BY g.grp
)
SELECT
  (SELECT count(*) FROM shape
   WHERE regels NOT BETWEEN 2 AND 3 OR vreemd > 0 OR bankzijde <> 1 OR bankzijde_bruto <> 1
      OR tegenzijde <> CASE WHEN btw > 0 THEN 2 ELSE 1 END)                AS afwijkende_vorm,
  (SELECT count(DISTINCT lp.posting_group_id) FROM public.ledger_postings lp
   WHERE lp.source_type = 'bank_transaction'
     AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                     WHERE m.bank_transaction_id = lp.source_id AND m.posting_group_id = lp.posting_group_id))
                                                                           AS bankgroepen_zonder_marker,
  EXISTS (SELECT 1 FROM shape
          WHERE regels NOT BETWEEN 2 AND 3 OR vreemd > 0 OR bankzijde <> 1 OR bankzijde_bruto <> 1
             OR tegenzijde <> CASE WHEN btw > 0 THEN 2 ELSE 1 END)
  OR EXISTS (SELECT 1 FROM public.ledger_postings lp
             WHERE lp.source_type = 'bank_transaction'
               AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                               WHERE m.bank_transaction_id = lp.source_id AND m.posting_group_id = lp.posting_group_id))
                                                                           AS stop;


-- ── PRE 5. Handmatig tegengeboekte directe boekingen (S2, informatief) ──────
-- Na PR 1 kunnen deze via "Opnieuw boeken" worden herboekt, zonder tweede storno.
SELECT m.bank_transaction_id, bt.transaction_date, bt.amount, m.posting_group_id, r.reversal_posting_group_id,
       r.posting_date AS tegenboekingsdatum, r.reason
FROM public.bank_transaction_postings m
JOIN public.bank_transactions bt ON bt.id = m.bank_transaction_id
JOIN public.ledger_reversal_postings r ON r.original_posting_group_id = m.posting_group_id
ORDER BY bt.transaction_date, m.bank_transaction_id
LIMIT 200;


-- ── PRE 6. Nulmeting van de data ────────────────────────────────────────────
-- Bewaar deze uitkomst; POST 6 moet er letterlijk gelijk aan zijn.
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


-- ── PRE 7. Nulmeting van de catalogus ───────────────────────────────────────
-- Bewaar deze uitkomst; POST 7 noemt per kolom de verwachte verandering.
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


-- ── PRE 8. De editorrol kan dit uitvoeren zoals de schrijvers (STOP-controle) ──
-- De nieuwe functies krijgen de editorrol als eigenaar (SECURITY DEFINER: zij
-- lezen en schrijven onder die rol); ALTER TABLE … ENABLE ALWAYS TRIGGER vereist
-- het eigenaarschap van de tabel. Verwacht: elke kolom `true`.
SELECT
  current_user AS editorrol,
  current_user = (SELECT pg_get_userbyid(proowner) FROM pg_proc
                  WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure)            AS eigenaar_van_de_schrijvers,
  current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.bank_transactions'::regclass)
  AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.bank_transaction_postings'::regclass)
  AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.bank_transaction_allocations'::regclass)
                                                                                           AS eigenaar_van_de_tabellen;


-- ── PRE 9. Tenantconsistentie (informatief, verwacht 0) ─────────────────────
-- De RPC's weigeren een banktransactie waarvan de administratie bij een andere
-- organisatie hoort (42501); zo'n regel is daarna alleen niet corrigeerbaar.
SELECT count(*) AS transacties_met_afwijkende_tenant
FROM public.bank_transactions bt
JOIN public.clients c ON c.id = bt.client_id
WHERE bt.organization_id IS DISTINCT FROM c.organization_id;


-- ── PRE 10. Bestaande triggers op de vier banktabellen (informatief) ────────
SELECT c.relname AS tabel, t.tgname, t.tgenabled
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal
  AND c.oid IN ('public.bank_transactions'::regclass, 'public.bank_transaction_postings'::regclass,
                'public.bank_transaction_allocations'::regclass, 'public.bank_allocation_postings'::regclass)
ORDER BY c.relname, t.tgname;
