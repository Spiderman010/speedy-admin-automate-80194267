-- W1 — NA DE ROLLBACK VAN 20261018180000 (twee keer uitgevoerd). Throwaway database only.
--
-- De rollback zet de catalogus exact terug naar vóór de fix (PR 1 + PR 2),
-- verandert geen rij, en weigert vanuit een onbekende toestand.
-- :'rbguard' = het DO-blok uit rollback.sql, letterlijk.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['W1a','W1b','W1c','W1d','W1e']);

SELECT proof.record('W1a', 'de catalogus is exact die van vóór de fix: hold van PR 1 (lichaam, rechten, commentaar), geen hulpfunctie',
  proof.catalog_digest() = proof.get('catalog_before_fix')
  AND to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)') IS NULL
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.enforce_bank_transaction_release_hold()'::regprocedure) = '812d151a7041cdd48b7a784cd193a159');

SELECT proof.record('W1b', 'geen enkele rij veranderde door de rollback',
  proof.digest() = proof.get('digest_before_rollback') AND proof.rest_digest() = proof.get('rest_before_rollback'));

SELECT proof.prereq_refuses('W1c', 'de rollback weigert als de hold een onbekend lichaam heeft',
  $s$CREATE OR REPLACE FUNCTION public.enforce_bank_transaction_release_hold() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS 'BEGIN RETURN NEW; END'$s$,
  :'rbguard', 'Rollback geweigerd');
SELECT proof.prereq_refuses('W1d', 'de rollback weigert als de hold een andere eigenaar heeft',
  'ALTER FUNCTION public.enforce_bank_transaction_release_hold() OWNER TO authenticated', :'rbguard', 'Rollback geweigerd');

-- Het gedocumenteerde gevolg: weer het gedrag van PR 1 (alleen getoond, teruggedraaid).
SELECT proof.record('W1e', 'gedocumenteerd gevolg van de rollback: de historische regel valt na vrijgeven weer buiten de hold (teruggedraaid)',
  o LIKE 'ok: released|f||% || ok: %', o)
FROM proof.gap_probe(10) o;
