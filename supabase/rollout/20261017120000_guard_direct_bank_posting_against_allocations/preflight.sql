-- ═════════════════════════════════════════════════════════════════════════════
-- PRE — leescontroles vóór 20261017120000_guard_direct_bank_posting_against_allocations.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor (Lovable → Cloud-icoon, of
-- Cmd/Ctrl+K → "Cloud"), NA visuele bevestiging dat het actieve project exact
-- `alxlbdhpbwlehbdbfejw` is (zie de controlelijst in PROJECT_MAP.md: de
-- projectref in de editor en de `sb-project-ref`-header in het netwerktabblad).
-- Nooit het persoonlijke Supabase-dashboard, nooit de Vercel Marketplace-
-- database, nooit olumcwneiejjefhkzgmz of ycuofllsdssoezwwpqmv.
--
-- Alles hieronder is ALLEEN LEZEN. Voer de blokken één voor één uit en bewaar
-- de uitkomst van PRE 6 en PRE 7: POST 5 en POST 6 moeten er letterlijk gelijk
-- aan zijn.
--
-- MOMENT: voer PRE, migratie en POST direct na elkaar uit op een rustig moment
-- (geen gebruikers actief in BoekAssist). POST 5 en POST 7 vergelijken byte-
-- voor-byte met PRE; elke boeking of koppeling door een gebruiker daartussen
-- geeft een afwijking. Ook dan: STOP en melden, niet zelf verklaren of
-- herhalen. Zet vóór de migratie in dezelfde editorsessie `SET lock_timeout =
-- '5s';` — bij een time-out is er niets toegepast (alles of niets): STOP en
-- melden.
--
-- STOP (niet uitvoeren, niets herstellen, uitkomst doorgeven) als:
--   • PRE 1 of PRE 2 ergens `false` geeft;
--   • PRE 4 `stop = true` geeft (een banktransactie is al zowel direct als via
--     een aflettering geboekt — een bestaande dubbele boeking);
--   • PRE 8 `stop = true` geeft (een banktransactie hoort bij een andere
--     organisatie dan haar administratie: guard 1 zou daar een legitieme
--     koppeling neutraal weigeren).
-- Een koppeling op een direct geboekte transactie ZONDER geboekte aflettering
-- (PRE 4 `ongeboekte_koppelingen_op_direct_geboekt` > 0) is géén STOP: zij kan
-- na deze migratie niet meer worden geboekt. PRE 5 noemt ze voor de eigenaar;
-- er wordt niets automatisch hersteld.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── PRE 1. Vereisten aanwezig, de guards nog niet ──────────────────────────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  to_regclass('public.bank_transactions')            IS NOT NULL AS bank_transactions,
  to_regclass('public.bank_transaction_allocations') IS NOT NULL AS koppelingen,
  to_regclass('public.bank_allocation_postings')     IS NOT NULL AS afletteringsmarker,
  to_regclass('public.bank_transaction_postings')    IS NOT NULL AS directe_marker,
  to_regclass('public.ledger_postings')              IS NOT NULL AS grootboek,
  to_regclass('public.ledger_reversal_postings')     IS NOT NULL AS tegenboekingsmarker,
  to_regprocedure('public.post_bank_transaction(uuid)')         IS NOT NULL AS schrijver_direct,
  to_regprocedure('public.post_bank_allocation(uuid)')          IS NOT NULL AS schrijver_aflettering,
  to_regprocedure('public.post_bank_transactions_bulk(uuid[])') IS NOT NULL AS bulk,
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'bank_transaction_allocations' AND column_name IN ('id', 'bank_transaction_id'))
       OR (table_name = 'bank_allocation_postings'     AND column_name IN ('allocation_id', 'bank_transaction_id'))
       OR (table_name = 'bank_transaction_postings'    AND column_name = 'bank_transaction_id'))) = 5 AS kolommen,
  -- 20261010120000 moet aantoonbaar zijn toegepast (tabel, triggerfunctie, trigger, drie policies).
  to_regclass('public.bank_match_rejections') IS NOT NULL
    AND to_regprocedure('public.enforce_bank_match_rejection_scope()') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'enforce_bank_match_rejection_scope_trigger')
    AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_match_rejections') = 3
                                                       AS migratie_20261010120000_toegepast,
  to_regprocedure('public.enforce_bank_allocation_not_directly_posted()')         IS NULL
    AND to_regprocedure('public.enforce_bank_allocation_posting_not_directly_posted()') IS NULL
    AND to_regprocedure('public.enforce_bank_direct_posting_without_allocations()')     IS NULL
                                                       AS guardfuncties_nog_afwezig,
  NOT EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname IN ('validate_bank_allocation_not_directly_posted_trigger',
                               'validate_bank_allocation_posting_not_directly_posted_trigger',
                               'validate_bank_direct_posting_without_allocations_trigger'))
                                                       AS guardtriggers_nog_afwezig;


-- ── PRE 2. De acht PR H-functies hebben exact het beoordeelde lichaam ───────
-- Verwacht: 8 rijen, `gelijk` overal `true`. De proeven draaiden tegen precies
-- deze lichamen; een afwijking betekent een onbekende versie in productie.
SELECT h.naam, md5(p.prosrc) AS md5_productie, h.verwacht, coalesce(md5(p.prosrc) = h.verwacht, false) AS gelijk
FROM (VALUES
  ('post_purchase_invoice',        '6366f052209d9a171f197de77eaf477a'),
  ('post_sales_invoice',           'cb467b35301239c3051c8b918662ea45'),
  ('post_bank_allocation',         '863d9e87ef89f7230a9ef020c49b168d'),
  ('post_manual_journal',          '2668c9ed24ef515b7016be29e8b6ffe5'),
  ('post_opening_balance',         '98cbf351067c0135943d910f86e792d6'),
  ('reverse_posting_group',        'b5db0ca04b5dcfbcec5dea1a7844fe13'),
  ('post_bank_transaction',        '2369978c713ac78a0c039dd5c3e5eb4c'),
  ('bank_bulk_posting_candidates', '946bef45005d6e572a7565da6fc12cdb')) h(naam, verwacht)
LEFT JOIN pg_proc p ON p.proname = h.naam
  AND p.pronamespace = 'public'::regnamespace
ORDER BY h.naam;


-- ── PRE 3. Omvang (informatief) ─────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM public.bank_transactions)            AS banktransacties,
  (SELECT count(*) FROM public.bank_transaction_postings)    AS directe_boekingen,
  (SELECT count(*) FROM public.bank_transaction_allocations) AS koppelingen,
  (SELECT count(*) FROM public.bank_allocation_postings)     AS geboekte_afletteringen,
  (SELECT count(*) FROM public.ledger_postings)              AS grootboekregels,
  (SELECT count(*) FROM public.ledger_reversal_postings)     AS tegenboekingen;


-- ── PRE 4. Bestaande botsingen (STOP-controle) ──────────────────────────────
-- Verwacht: stop = false.
WITH direct AS (SELECT bank_transaction_id, posting_group_id FROM public.bank_transaction_postings),
     posted AS (SELECT bank_transaction_id, posting_group_id FROM public.bank_allocation_postings),
     reversed AS (SELECT original_posting_group_id FROM public.ledger_reversal_postings)
SELECT
  (SELECT count(DISTINCT d.bank_transaction_id) FROM direct d
   JOIN public.bank_transaction_allocations a ON a.bank_transaction_id = d.bank_transaction_id
   WHERE NOT EXISTS (SELECT 1 FROM posted p WHERE p.bank_transaction_id = d.bank_transaction_id))
                                                       AS ongeboekte_koppelingen_op_direct_geboekt,
  (SELECT count(DISTINCT d.bank_transaction_id) FROM direct d
   JOIN posted p ON p.bank_transaction_id = d.bank_transaction_id)
                                                       AS direct_en_aflettering_geboekt,
  (SELECT count(DISTINCT d.bank_transaction_id) FROM direct d
   JOIN posted p ON p.bank_transaction_id = d.bank_transaction_id
   WHERE NOT EXISTS (SELECT 1 FROM reversed r WHERE r.original_posting_group_id = d.posting_group_id)
     AND NOT EXISTS (SELECT 1 FROM reversed r WHERE r.original_posting_group_id = p.posting_group_id))
                                                       AS actief_dubbel_geboekt,
  EXISTS (SELECT 1 FROM direct d JOIN posted p ON p.bank_transaction_id = d.bank_transaction_id)
                                                       AS stop;


-- ── PRE 5. Welke koppelingen staan er op een direct geboekte transactie ─────
-- Informatief, voor de eigenaar. Niets automatisch herstellen.
SELECT d.bank_transaction_id, bt.transaction_date, bt.amount, bt.client_id,
       a.id AS koppeling_id, a.invoice_type, a.invoice_id, a.amount AS koppelingsbedrag,
       EXISTS (SELECT 1 FROM public.bank_allocation_postings p WHERE p.allocation_id = a.id) AS aflettering_geboekt
FROM public.bank_transaction_postings d
JOIN public.bank_transactions bt ON bt.id = d.bank_transaction_id
JOIN public.bank_transaction_allocations a ON a.bank_transaction_id = d.bank_transaction_id
ORDER BY bt.transaction_date, d.bank_transaction_id, a.id
LIMIT 200;


-- ── PRE 6. Nulmeting van de data ────────────────────────────────────────────
-- Bewaar deze uitkomst; POST 5 moet er letterlijk gelijk aan zijn.
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
-- Bewaar deze uitkomst; POST 6 moet exact +3 functies en +3 triggers tonen en
-- verder letterlijk gelijk zijn.
SELECT
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace) AS publieke_functies,
  (SELECT count(*) FROM pg_trigger t
   WHERE NOT t.tgisinternal
     AND t.tgrelid IN ('public.bank_transaction_allocations'::regclass, 'public.bank_allocation_postings'::regclass,
                       'public.bank_transaction_postings'::regclass, 'public.bank_transactions'::regclass))
                                                                              AS triggers_op_banktabellen,
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')) AS tabellen,
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('v', 'm')) AS views,
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S')        AS sequences,
  (SELECT count(*) FROM pg_type  WHERE typnamespace = 'public'::regnamespace)                           AS types,
  (SELECT md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), ',' ORDER BY c.relname))
   FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p'))         AS tabelrechten_digest,
  (SELECT md5(string_agg(polname || ':' || polrelid::regclass::text, ',' ORDER BY polrelid::regclass::text, polname))
   FROM pg_policy)                                                                                     AS policies_digest;


-- ── PRE 8. Tenantconsistentie van de banktransacties (STOP-controle) ────────
-- Guard 1 weigert een koppeling waarvan organisatie of administratie afwijkt
-- van haar banktransactie. De app laat de organisatie uit de administratie
-- afleiden; dat klopt alleen als elke banktransactie bij de organisatie van
-- haar eigen administratie hoort. Verwacht: afwijkend = 0, stop = false.
SELECT count(*) AS afwijkend, count(*) > 0 AS stop
FROM public.bank_transactions bt
JOIN public.clients c ON c.id = bt.client_id
WHERE bt.organization_id IS DISTINCT FROM c.organization_id;


-- ── PRE 9. Bestaande afwijkingen (informatief, verwacht 0) ──────────────────
-- Bestaande rijen blijven ongemoeid; alleen een nieuwe koppeling of een
-- verplaatsing wordt getoetst. Een waarde > 0 is een bestaand datapunt voor de
-- eigenaar, geen reden om iets te herstellen.
SELECT
  (SELECT count(*) FROM public.bank_transaction_allocations a
   JOIN public.bank_transactions bt ON bt.id = a.bank_transaction_id
   WHERE a.organization_id IS DISTINCT FROM bt.organization_id OR a.client_id <> bt.client_id)
                                                       AS koppelingen_met_afwijkende_tenant,
  (SELECT count(*) FROM public.bank_allocation_postings p
   JOIN public.bank_transaction_allocations a ON a.id = p.allocation_id
   WHERE a.bank_transaction_id <> p.bank_transaction_id)
                                                       AS afletteringsmarkers_op_andere_transactie;


-- ── PRE 10. Policies op de koppelingen (informatief) ────────────────────────
-- Verwacht exact vier: role_bank_transaction_allocations_select (read_only),
-- _insert en _update (assistant), _delete (accountant), alle TO authenticated.
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'bank_transaction_allocations'
ORDER BY policyname;
