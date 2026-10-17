-- ═════════════════════════════════════════════════════════════════════════════
-- POST — leescontroles ná 20261017120000_guard_direct_bank_posting_against_allocations.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor van `alxlbdhpbwlehbdbfejw`, in
-- dezelfde sessie-context als de PRE (zelfde project, visueel bevestigd).
-- Alles hieronder is ALLEEN LEZEN; er wordt niets getest door te schrijven —
-- geen testdata in productie. Dat de guards werken, is bewezen in
-- supabase/tests/bank-direct-allocation-guard/; hier wordt bewezen dat
-- productie exact die guards draagt (POST 1–2) en dat verder niets veranderde.
--
-- Bij ELKE afwijking: STOP, niets herstellen, uitkomst doorgeven. De
-- rollback staat in de kop van de migratie.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── POST 1. De drie guardfuncties: exact het beoordeelde lichaam en veilig ──
-- Verwacht: 3 rijen, elke booleaanse kolom `true`.
SELECT h.naam,
       md5(p.prosrc) = h.md5_lichaam                                          AS lichaam_exact,
       p.prosecdef                                                            AS security_definer,
       p.proconfig = ARRAY['search_path=public']                              AS search_path_vast,
       p.provolatile = 'v'                                                    AS volatile,
       p.proowner = (SELECT proowner FROM pg_proc
                     WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure) AS eigenaar_als_schrijvers,
       NOT has_function_privilege('anon',          p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('service_role',  p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS geen_uitvoerrecht
FROM (VALUES
  ('enforce_bank_allocation_not_directly_posted',         '84097cea905288c5b6d9aea5c3ef8a55'),
  ('enforce_bank_allocation_posting_not_directly_posted', '9add7f0705f7228addc776dbbfcdb57a'),
  ('enforce_bank_direct_posting_without_allocations',     '40937abcc75869096153dd1d68ae119e')) h(naam, md5_lichaam)
LEFT JOIN pg_proc p ON p.proname = h.naam AND p.pronamespace = 'public'::regnamespace
ORDER BY h.naam;


-- ── POST 2. De drie triggers: exacte definitie, ingeschakeld ───────────────
-- Verwacht: 3 rijen, `definitie_exact` en `ingeschakeld` overal `true`.
SELECT h.tgname,
       pg_get_triggerdef(t.oid) = h.definitie AS definitie_exact,
       t.tgenabled = 'O'                      AS ingeschakeld
FROM (VALUES
  ('validate_bank_allocation_not_directly_posted_trigger',
   'CREATE TRIGGER validate_bank_allocation_not_directly_posted_trigger AFTER INSERT OR UPDATE OF bank_transaction_id ON public.bank_transaction_allocations FOR EACH ROW EXECUTE FUNCTION enforce_bank_allocation_not_directly_posted()'),
  ('validate_bank_allocation_posting_not_directly_posted_trigger',
   'CREATE TRIGGER validate_bank_allocation_posting_not_directly_posted_trigger BEFORE INSERT ON public.bank_allocation_postings FOR EACH ROW EXECUTE FUNCTION enforce_bank_allocation_posting_not_directly_posted()'),
  ('validate_bank_direct_posting_without_allocations_trigger',
   'CREATE TRIGGER validate_bank_direct_posting_without_allocations_trigger BEFORE INSERT ON public.bank_transaction_postings FOR EACH ROW EXECUTE FUNCTION enforce_bank_direct_posting_without_allocations()')) h(tgname, definitie)
LEFT JOIN pg_trigger t ON t.tgname = h.tgname
ORDER BY h.tgname;


-- ── POST 3. De acht PR H-functies zijn onaangeroerd ─────────────────────────
-- Verwacht: 8 rijen, `gelijk` overal `true` (dezelfde query als PRE 2).
SELECT h.naam, md5(p.prosrc) AS md5_productie, h.verwacht, md5(p.prosrc) = h.verwacht AS gelijk
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


-- ── POST 4. Markertabellen: nog steeds alleen lezen voor applicatierollen ───
-- Verwacht: één rij, elke kolom `false`.
SELECT
  has_table_privilege('authenticated', 'public.bank_transaction_postings', 'INSERT, UPDATE, DELETE') AS auth_schrijft_directe_marker,
  has_table_privilege('service_role',  'public.bank_transaction_postings', 'INSERT, UPDATE, DELETE') AS service_schrijft_directe_marker,
  has_table_privilege('authenticated', 'public.bank_allocation_postings',  'INSERT, UPDATE, DELETE') AS auth_schrijft_afletteringsmarker,
  has_table_privilege('service_role',  'public.bank_allocation_postings',  'INSERT, UPDATE, DELETE') AS service_schrijft_afletteringsmarker,
  has_table_privilege('anon',          'public.bank_transaction_postings', 'SELECT, INSERT')         AS anon_raakt_directe_marker;


-- ── POST 5. Data onveranderd ────────────────────────────────────────────────
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


-- ── POST 6. Catalogus: exact +3 functies en +3 triggers, verder gelijk ──────
-- Exact dezelfde query als PRE 7. Verwacht: publieke_functies = PRE + 3,
-- triggers_op_banktabellen = PRE + 3, alle andere kolommen letterlijk als PRE.
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


-- ── POST 7. Botsingen onveranderd ───────────────────────────────────────────
-- Exact dezelfde query als PRE 4. Verwacht: letterlijk dezelfde aantallen;
-- stop = false.
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
