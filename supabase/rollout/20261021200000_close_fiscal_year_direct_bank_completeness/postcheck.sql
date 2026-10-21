-- ═════════════════════════════════════════════════════════════════════════════
-- POST — leescontrole direct ná 20261021200000_close_fiscal_year_direct_bank_completeness.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor van alxlbdhpbwlehbdbfejw, in
-- dezelfde rustige periode als PRE en de migratie. ALLEEN LEZEN.
--
-- Vul eerst de zes PRE 3-waarden in op de regels met `NULL::… AS pre_…`
-- (getallen zonder aanhalingstekens, de md5 tussen enkele aanhalingstekens).
-- Een niet-ingevulde waarde geeft `false`: dat is bewust.
--
-- Verwacht: één rij, elke kolom `true`. Eén `false` → STOP en melden; de
-- rollback staat in rollback.sql (alleen met akkoord van de eigenaar).
-- ═════════════════════════════════════════════════════════════════════════════

WITH pre AS (
  SELECT
    NULL::bigint AS pre_jaarafsluitingen,
    NULL::bigint AS pre_gebeurtenissen,
    NULL::text   AS pre_watermerk_en_blokkade_md5,
    NULL::bigint AS pre_banktransacties,
    NULL::bigint AS pre_directe_boekingen,
    NULL::bigint AS pre_grootboekregels
), f AS (
  SELECT p.* FROM pg_proc p WHERE p.oid = to_regprocedure('public.close_fiscal_year(uuid,integer)')
)
SELECT
  -- Structuur: exact het beoordeelde lichaam, verder niets aan de functie veranderd.
  (SELECT md5(f.prosrc) = '8b87b888e2468a58ecf378a643121151' FROM f)                  AS lichaam_p7,
  (SELECT f.prosecdef AND f.proconfig = ARRAY['search_path=public'] FROM f)          AS definer_en_search_path,
  (SELECT pg_get_function_arguments(f.oid) = '_client_id uuid, _fiscal_year integer'
      AND pg_get_function_result(f.oid) =
          'TABLE(client_id uuid, organization_id uuid, fiscal_year integer, closed_at timestamp with time zone, closed_by uuid, created boolean)'
   FROM f)                                                                           AS handtekening,
  -- ACL: alleen authenticated (naast de eigenaar).
  (SELECT has_function_privilege('authenticated', f.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', f.oid, 'EXECUTE')
      AND NOT has_function_privilege('service_role', f.oid, 'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM aclexplode(f.proacl) a WHERE a.grantee = 0)
      AND (SELECT array_agg(DISTINCT a.grantee::regrole::text ORDER BY a.grantee::regrole::text)
           FROM aclexplode(f.proacl) a WHERE a.grantee <> f.proowner) = ARRAY['authenticated']
   FROM f)                                                                           AS acl_alleen_authenticated,
  (SELECT obj_description(f.oid, 'pg_proc') LIKE '%gecodeerde bankregels voor de directe bankboeking%' FROM f)
                                                                                     AS commentaar,
  -- De heropener is niet aangeraakt.
  (SELECT md5(p.prosrc) = '3aa768e46f8de8e3f50291501d29d22c'
   FROM pg_proc p WHERE p.oid = to_regprocedure('public.reopen_fiscal_year(uuid,integer,text)'))
                                                                                     AS heropener_onaangeroerd,
  -- Geen onverwachte backfill: geen afsluiting, gebeurtenis, watermerk, blokkade
  -- of boeking erbij of af.
  coalesce((SELECT count(*) FROM public.year_closures)      = (SELECT pre_jaarafsluitingen FROM pre), false) AS jaarafsluitingen_gelijk,
  coalesce((SELECT count(*) FROM public.fiscal_year_events) = (SELECT pre_gebeurtenissen FROM pre), false)   AS gebeurtenissen_gelijk,
  coalesce((SELECT md5(coalesce(string_agg(format('%s:%s:%s', c.id, c.afgesloten_boekjaar, c.posting_locked_through),
                                           ',' ORDER BY c.id), ''))
            FROM public.clients c) = (SELECT pre_watermerk_en_blokkade_md5 FROM pre), false)                AS watermerken_gelijk,
  coalesce((SELECT count(*) FROM public.bank_transactions)         = (SELECT pre_banktransacties FROM pre), false)   AS banktransacties_gelijk,
  coalesce((SELECT count(*) FROM public.bank_transaction_postings) = (SELECT pre_directe_boekingen FROM pre), false) AS directe_boekingen_gelijk,
  coalesce((SELECT count(*) FROM public.ledger_postings)           = (SELECT pre_grootboekregels FROM pre), false)   AS grootboek_gelijk;
