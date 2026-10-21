-- NA DE ROLLBACK — throwaway database only.
--
-- run-proof.sh heeft supabase/rollout/…/rollback.sql (de bewaking + letterlijk
-- PR E-sectie 4) TWEE keer uitgevoerd. Hier wordt bewezen dat precies het
-- oude gedrag terug is, dat de rechten gelijk zijn en dat er geen enkele rij
-- is veranderd.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

SELECT proof.expect_true('R1', 'rollback: het lichaam is weer exact PR E (md5 14cdfaa4…)',
  $q$proof.close_md5() = '14cdfaa498bbbc305e95dbf0faa52e26'$q$);
SELECT proof.expect_true('R2', 'rollback: SECURITY DEFINER, search_path, eigenaar en ACL exact die van PR E',
  $q$(SELECT prosecdef AND proconfig = ARRAY['search_path=public'] AND proacl::text = proof.get('acl_pr_e')
             AND proowner::regrole::text = proof.get('owner_pr_e')
      FROM pg_proc WHERE oid = 'public.close_fiscal_year(uuid,integer)'::regprocedure)$q$);
SELECT proof.expect_true('R3', 'rollback: het commentaar is weer dat van PR E',
  $q$obj_description('public.close_fiscal_year(uuid,integer)'::regprocedure, 'pg_proc') NOT LIKE '%directe bankboeking%'
     AND obj_description('public.close_fiscal_year(uuid,integer)'::regprocedure, 'pg_proc') LIKE 'Sluit één boekjaar af%Rolvloer: accountant.'$q$);
SELECT proof.expect_true('R4', 'rollback: data-neutraal — elke boekhoudkundige en bronrij exact gelijk',
  $q$proof.data_digest() = proof.get('digest_voor_rollback')$q$);
SELECT proof.record('R5', 'rollback: de gecodeerde bankregel zonder organisatie (K10) telt ook onder PR E niet',
  proof.try_close(proof.client(10), 2026) = 'created=true', NULL);
SELECT proof.record('R6', 'rollback: en de rij van de andere organisatie (K8) telt weer wél (zonder organisatiefilter)',
  proof.try_close(proof.client(8), 2026) LIKE '[23514]%postbaar brondocument(en) open%', NULL);
SELECT proof.record('R7', 'rollback: de bewaking weigerde een onbekend lichaam en liet het staan (55000)',
  proof.get('rollback_guard') LIKE '%55000%Rollback geweigerd: close_fiscal_year is niet de beoordeelde versie%'
  AND proof.get('rollback_guard_md5_na') = proof.get('rollback_guard_md5_voor'),
  proof.get('rollback_guard'));
