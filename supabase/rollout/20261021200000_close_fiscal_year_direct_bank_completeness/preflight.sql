-- ═════════════════════════════════════════════════════════════════════════════
-- PRE — leescontroles vóór 20261021200000_close_fiscal_year_direct_bank_completeness.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor (Lovable → Cloud-icoon, of
-- Cmd/Ctrl+K → "Cloud"), NA visuele bevestiging dat het actieve project exact
-- `alxlbdhpbwlehbdbfejw` is (zie de controlelijst in PROJECT_MAP.md: de
-- projectref in de editor en de `sb-project-ref`-header in het netwerktabblad).
-- Nooit het persoonlijke Supabase-dashboard, nooit de Vercel Marketplace-
-- database.
--
-- Alles hieronder is ALLEEN LEZEN. Voer de blokken één voor één uit en bewaar
-- de uitkomst van PRE 3: POST vergelijkt daar letterlijk mee. Voer daarnaast
-- impact.sql uit (ook alleen lezen) en geef de uitkomst aan de eigenaar: dat
-- zijn de administraties die na de uitrol een boekjaar pas kunnen afsluiten
-- nadat hun gecodeerde bankregels zijn geboekt.
--
-- MOMENT: voer PRE, migratie en POST direct na elkaar uit op een rustig moment
-- (geen jaarafsluiting of heropening bezig). Zet vóór de migratie in dezelfde
-- editorsessie `SET lock_timeout = '5s';` — bij een time-out is er niets
-- toegepast (alles of niets): STOP en melden.
--
-- STOP (niet uitvoeren, niets herstellen, uitkomst doorgeven) als:
--   • PRE 1 ergens `false` geeft. Is `nog_niet_toegepast` false, dan staat het
--     P7-lichaam er al: niets doen, alleen POST draaien;
--   • PRE 2 ergens `false` geeft (de rechten wijken af van wat PR E zette).
-- De migratie weigert zichzelf ook, zonder iets te wijzigen, zodra het lichaam
-- van close_fiscal_year() een ander is dan dat van PR E of van P7.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── PRE 1. Vereisten aanwezig, PR E-lichaam actief, P7 nog niet ─────────────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  to_regprocedure('public.close_fiscal_year(uuid,integer)')          IS NOT NULL AS afsluiter,
  to_regprocedure('public.reopen_fiscal_year(uuid,integer,text)')    IS NOT NULL AS heropener,
  to_regprocedure('public.lock_ledger_client(uuid)')                 IS NOT NULL AS administratiegrendel,
  to_regprocedure('public.post_bank_transaction(uuid)')              IS NOT NULL AS directe_bankschrijver,
  to_regclass('public.bank_transaction_postings')                    IS NOT NULL AS directe_marker,
  to_regclass('public.fiscal_year_events')                           IS NOT NULL AS gebeurtenissen,
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND column_name = 'organization_id'
     AND table_name IN ('purchase_invoices', 'sales_invoices', 'bank_transactions',
                        'bank_transaction_allocations', 'manual_journals', 'ledger_postings')) = 6
                                                                    AS organisatiekolommen,
  (SELECT md5(p.prosrc) = '14cdfaa498bbbc305e95dbf0faa52e26'
   FROM pg_proc p WHERE p.oid = to_regprocedure('public.close_fiscal_year(uuid,integer)'))
                                                                    AS lichaam_is_pr_e,
  (SELECT md5(p.prosrc) <> '8b87b888e2468a58ecf378a643121151'
   FROM pg_proc p WHERE p.oid = to_regprocedure('public.close_fiscal_year(uuid,integer)'))
                                                                    AS nog_niet_toegepast,
  (SELECT md5(p.prosrc) = '3aa768e46f8de8e3f50291501d29d22c'
   FROM pg_proc p WHERE p.oid = to_regprocedure('public.reopen_fiscal_year(uuid,integer,text)'))
                                                                    AS heropener_is_pr_e;


-- ── PRE 2. Rechten en definitie van de afsluiter (zoals PR E ze zette) ──────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  p.prosecdef                                                        AS security_definer,
  p.proconfig = ARRAY['search_path=public']                          AS search_path_public,
  has_function_privilege('authenticated', p.oid, 'EXECUTE')          AS authenticated_mag,
  NOT has_function_privilege('anon', p.oid, 'EXECUTE')               AS anon_mag_niet,
  NOT has_function_privilege('service_role', p.oid, 'EXECUTE')       AS service_role_mag_niet,
  NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_mag_niet,
  pg_get_function_result(p.oid) =
    'TABLE(client_id uuid, organization_id uuid, fiscal_year integer, closed_at timestamp with time zone, closed_by uuid, created boolean)'
                                                                     AS retourvorm
FROM pg_proc p
WHERE p.oid = 'public.close_fiscal_year(uuid,integer)'::regprocedure;


-- ── PRE 3. Uitgangstoestand voor POST ("geen onverwachte backfill") ─────────
-- BEWAAR deze ene rij: vul de zes waarden in op de plaatsen in postcheck.sql
-- (de regels met `NULL::… AS pre_…`).
SELECT
  (SELECT count(*) FROM public.year_closures)                         AS jaarafsluitingen,
  (SELECT count(*) FROM public.fiscal_year_events)                    AS gebeurtenissen,
  (SELECT md5(coalesce(string_agg(format('%s:%s:%s', c.id, c.afgesloten_boekjaar, c.posting_locked_through),
                                  ',' ORDER BY c.id), ''))
   FROM public.clients c)                                             AS watermerk_en_blokkade_md5,
  (SELECT count(*) FROM public.bank_transactions)                     AS banktransacties,
  (SELECT count(*) FROM public.bank_transaction_postings)             AS directe_boekingen,
  (SELECT count(*) FROM public.ledger_postings)                       AS grootboekregels;
