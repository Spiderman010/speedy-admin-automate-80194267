-- NA HET OPNIEUW TOEPASSEN — throwaway database only.
--
-- De migratie is na de rollback opnieuw toegepast. Hier: exact het P7-lichaam
-- terug, het nieuwe gedrag terug, en over de hele run heen geen enkel ander
-- object van de catalogus veranderd en geen deadlock.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

SELECT proof.expect_true('F1', 'opnieuw toegepast: exact het P7-lichaam, met de rechten van PR E',
  $q$proof.close_md5() = 'aea0f0adc7e44613112615365d4eb38a'
     AND (SELECT proacl::text = proof.get('acl_pr_e') FROM pg_proc WHERE oid = 'public.close_fiscal_year(uuid,integer)'::regprocedure)$q$);
SELECT proof.record('F2', 'opnieuw toegepast: K7 (gecodeerde bankregel van 2027) weigert 2027 weer, K10 (bank zonder organisatie, onboekbaar) en K8 (andere organisatie) sluiten af',
  proof.try_close(proof.client(7), 2027) LIKE '[23514]%postbaar brondocument(en) open%'
  AND proof.try_close(proof.client(10), 2026) = 'created=true'
  AND proof.try_close(proof.client(8), 2026) = 'created=true', NULL);
SELECT proof.expect_true('F3', 'opnieuw toegepast: data-neutraal',
  $q$proof.data_digest() = proof.get('digest_voor_rollback')$q$);
SELECT proof.expect_true('F4', 'over de hele run: buiten close_fiscal_year is geen functie, trigger, policy, tabel of kolom veranderd',
  $q$proof.get('catalogus_na') = proof.get('catalogus_voor')$q$);
SELECT proof.expect_true('F5', 'over de hele run: geen enkele deadlock',
  $q$(SELECT deadlocks = 0 FROM pg_stat_database WHERE datname = current_database())$q$);
