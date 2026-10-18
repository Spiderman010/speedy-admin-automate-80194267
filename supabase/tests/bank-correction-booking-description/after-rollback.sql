-- B — NA DE GEDOCUMENTEERDE ROLLBACK (twee keer uitgevoerd). Throwaway database only.
--
-- supabase/rollout/20261018150000_keep_bank_description_on_correction/rollback.sql
-- zet reclassify_bank_transaction byte-gelijk terug naar PR 1. De catalogus is
-- dan exact de nulmeting van vóór PR 2, geen rij veranderde, en het gedrag van
-- PR 1 is terug (de negatieve controle opnieuw).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['B1', 'B2', 'B3', 'B4']);

SELECT proof.expect_true('B1', 'na de rollback: elke functie (lichaam, SECURITY DEFINER, volatiliteit, instellingen, eigenaar, rechten, uitkomsttype) exact als vóór PR 2; reclassify = de PR 1-pin', $$
  NOT EXISTS ((SELECT * FROM proof.cat_functions
               EXCEPT SELECT p.oid::regprocedure::text, md5(p.prosrc), p.prosecdef, p.provolatile::text,
                             coalesce(p.proconfig::text, ''), pg_get_userbyid(p.proowner), coalesce(p.proacl::text, ''), pg_get_function_result(p.oid)
                      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace)
              UNION ALL
              (SELECT p.oid::regprocedure::text, md5(p.prosrc), p.prosecdef, p.provolatile::text,
                      coalesce(p.proconfig::text, ''), pg_get_userbyid(p.proowner), coalesce(p.proacl::text, ''), pg_get_function_result(p.oid)
               FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
               EXCEPT SELECT * FROM proof.cat_functions))
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure) = 'a931207c1a4e97f06e7797ed105c0264' $$);

SELECT proof.expect_true('B2', 'en ook het functiecommentaar, de triggers, relaties, policies, constraints en indexen exact als vóór PR 2', $$
  NOT EXISTS ((SELECT * FROM proof.cat_comments
               EXCEPT SELECT d.objoid::regprocedure::text, d.description FROM pg_description d
                      WHERE d.classoid = 'pg_proc'::regclass AND d.objsubid = 0 AND d.objoid IN (SELECT oid FROM pg_proc WHERE pronamespace = 'public'::regnamespace))
              UNION ALL
              (SELECT d.objoid::regprocedure::text, d.description FROM pg_description d
               WHERE d.classoid = 'pg_proc'::regclass AND d.objsubid = 0 AND d.objoid IN (SELECT oid FROM pg_proc WHERE pronamespace = 'public'::regnamespace)
               EXCEPT SELECT * FROM proof.cat_comments))
  AND NOT EXISTS ((SELECT * FROM proof.cat_triggers
                   EXCEPT SELECT t.tgrelid::regclass::text, t.tgname::text, t.tgenabled::text, pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE NOT t.tgisinternal)
                  UNION ALL
                  (SELECT t.tgrelid::regclass::text, t.tgname::text, t.tgenabled::text, pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE NOT t.tgisinternal
                   EXCEPT SELECT * FROM proof.cat_triggers))
  AND NOT EXISTS (SELECT * FROM proof.cat_relations
                  EXCEPT SELECT c.oid::regclass::text, c.relkind::text, coalesce(c.relacl::text, ''), c.relrowsecurity, c.relforcerowsecurity
                         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace)
  AND NOT EXISTS (SELECT * FROM proof.cat_policies
                  EXCEPT SELECT polrelid::regclass::text, polname::text, polcmd::text, polroles::text,
                                coalesce(pg_get_expr(polqual, polrelid), ''), coalesce(pg_get_expr(polwithcheck, polrelid), '') FROM pg_policy)
  AND NOT EXISTS (SELECT * FROM proof.cat_constraints
                  EXCEPT SELECT conrelid::regclass::text, conname::text, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace)
  AND NOT EXISTS (SELECT * FROM proof.cat_indexes
                  EXCEPT SELECT indexrelid::regclass::text, pg_get_indexdef(indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace) $$);

SELECT proof.record('B3', 'de rollback (twee keer) veranderde geen enkele rij',
  proof.digest() = proof.get('digest_before_rollback') AND proof.rest_digest() = proof.get('rest_before_rollback'));

-- Het gedrag van PR 1 is terug: een correctie met omschrijving overschrijft de bankregel.
SELECT proof.btx(500, -121.00, 'Na de rollback');
SELECT proof.put('b_post', proof.rc(proof.u(2), proof.uid(1000, 500), NULL, proof.acct(7), 21, proof.req(5000)));
SELECT proof.put('b_fix', proof.rc(proof.u(1), proof.uid(1000, 500), proof.m(500), proof.acct(6), 21, proof.req(5001), 'PR 1-gedrag', 'Overschreven'));
SELECT proof.record('B4', 'na de rollback geldt weer PR 1: de correctie schrijft haar omschrijving in de bankregel (negatieve controle)',
  proof.get('b_fix') LIKE 'ok: reclassified|f|%' AND NOT proof.intact(500)
  AND (SELECT description FROM public.bank_transactions WHERE id = proof.uid(1000, 500)) = 'Overschreven',
  proof.get('b_fix'));
