-- Z — OPNIEUW TOEGEPAST, EN DE INVARIANTEN OVER DE HELE DATABASE. Throwaway database only.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['Z1', 'Z2', 'Z3', 'Z4', 'Z5']);

SELECT proof.expect_true('Z1', 'opnieuw toegepast na de rollback: reclassify heeft weer het PR 2-lichaam, met dezelfde rechten, eigenaar en instellingen', $$
  (SELECT md5(prosrc) = '067939e0c44a672c26ec8883717ef6d2' AND prosecdef AND proconfig = ARRAY['search_path=public']
   FROM pg_proc WHERE oid = 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure)
  AND (SELECT coalesce(p.proacl::text, '') FROM pg_proc p WHERE p.oid = 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure)
      = (SELECT acl FROM proof.cat_functions WHERE sig = 'reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') $$);

SELECT proof.btx(501, -121.00, 'Weer vooruit');
SELECT proof.put('z_post', proof.rc(proof.u(2), proof.uid(1000, 501), NULL, proof.acct(7), 21, proof.req(5010)));
SELECT proof.put('z_fix', proof.rc(proof.u(1), proof.uid(1000, 501), proof.m(501), proof.acct(6), 21, proof.req(5011), 'PR 2-gedrag', 'Alleen in het grootboek'));
SELECT proof.record('Z2', 'en het gedrag van PR 2 is terug: de boekingstekst in het grootboek, de bankregel byte-gelijk',
  proof.get('z_fix') LIKE 'ok: reclassified|f|%' AND proof.intact(501) AND proof.text_of(proof.m(501)) = 'Alleen in het grootboek',
  proof.get('z_fix'));

SELECT proof.expect_true('Z3', 'over de hele database: lineage in orde, elke groep in balans, geen groep twee keer tegengeboekt', $$
  proof.lineage_violations() = 0 AND proof.unbalanced() = 0
  AND NOT EXISTS (SELECT r.original_posting_group_id FROM public.ledger_reversal_postings r GROUP BY 1 HAVING count(*) > 1) $$);

SELECT proof.expect_true('Z4', 'elke testregel draagt byte-gelijk haar geïmporteerde omschrijving en duplicaatsleutel — behalve de twee die de app zelf wijzigde (I4, I5) en de PR 1-controle na de rollback (B4)', $$
  proof.all_intact(ARRAY[202, 203, 500])
  AND (SELECT bool_and(o.dedup = proof.dedup_key(split_part(o.tx::text, '-', 5)::integer)) FROM proof.original o
       WHERE o.tx NOT IN (proof.uid(1000, 202), proof.uid(1000, 203), proof.uid(1000, 500)))
  AND (SELECT count(*) FROM proof.original) >= 40 $$);

SELECT proof.expect_true('Z5', 'geen enkele weigering noemt een uuid', $$
  NOT EXISTS (SELECT 1 FROM proof.refusal WHERE outcome ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}') $$);
