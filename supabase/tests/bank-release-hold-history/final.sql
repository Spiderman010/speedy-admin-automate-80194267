-- I — EINDSTAND, na alle scenario's, races, de rollback en het opnieuw toepassen. Throwaway database only.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['I1','I2','I3','I4','I5','I6','I7','I8']);

SELECT proof.record('I1', 'elke boekingsgroep is in evenwicht — op de ene nagebootste corrupte storno (29) na',
  proof.unbalanced() = 1
  AND (SELECT count(*) FROM (SELECT posting_group_id FROM public.ledger_postings GROUP BY posting_group_id
                             HAVING sum(debit_amount) <> sum(credit_amount)) x
       WHERE x.posting_group_id = proof.storno_of(proof.h_orig(29))) = 1,
  proof.unbalanced()::text);

SELECT proof.expect_true('I2', 'lineage met geschiedenis: elke directe bankgroep van elke geldige testregel is actief, precies één keer vervangen of bewezen geschiedenis (12 en 19: de tussentijd, zie W3)', $$
  proof.hist_lineage_violations(ARRAY[10, 11, 13, 14, 15, 16, 17, 18, 40, 41]) = 0 $$);

SELECT proof.expect_true('I3', 'per banktransactie staat het bankbedrag hoogstens één keer netto in het grootboek — behalve 20 (niet gestorneerd, opnieuw geboekt: dubbel), precies waarop PRE 4 STOP geeft', $$
  (SELECT array_agg(t.id) FROM public.bank_transactions t
   WHERE abs(proof.net(t.id, '00000000-0000-0000-0000-00000000f001') + proof.net(t.id, '00000000-0000-0000-0000-00000000f010'))
         > abs(t.amount))
  = ARRAY[proof.uid(1000, 20)] $$);

SELECT proof.expect_true('I4', 'append-only: elke grootboekregel en storno van vóór PR 1 bestaat nog, byte-gelijk', $$
  NOT EXISTS (SELECT * FROM proof.ledger_before_pr1 EXCEPT SELECT * FROM public.ledger_postings)
  AND NOT EXISTS (SELECT * FROM proof.reversals_before_pr1 EXCEPT SELECT * FROM public.ledger_reversal_postings) $$);

SELECT proof.record('I5', 'elke bankomschrijving is byte-gelijk aan de geïmporteerde (PR 2)', proof.all_intact());

SELECT proof.expect_true('I6', 'de hold, de append-only-bewaking en de markerbewaking staan op ENABLE ALWAYS', $$
  (SELECT array_agg(t.tgenabled::text ORDER BY t.tgname COLLATE "C") FROM pg_trigger t
   WHERE t.tgname IN ('enforce_bank_transaction_release_hold_trigger', 'prevent_ledger_posting_mutation_trigger',
                      'enforce_bank_transaction_posting_marker_delete_trigger'))
  = ARRAY['A', 'A', 'A'] $$);

SELECT proof.expect_true('I7', 'geen enkele weigering in het hele harnas noemt een uuid (bericht, detail of hint)', $$
  NOT EXISTS (SELECT 1 FROM proof.refusal WHERE outcome ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}') $$);

SELECT proof.expect_true('I8', 'de hulpfunctie is nog steeds voor niemand uitvoerbaar en de hold heeft het lichaam van de fix', $$
  NOT has_function_privilege('authenticated', 'public.bank_transaction_group_is_settled_history(uuid,uuid)'::regprocedure, 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.bank_transaction_group_is_settled_history(uuid,uuid)'::regprocedure, 'EXECUTE')
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.enforce_bank_transaction_release_hold()'::regprocedure) = '43347fb9f48ed4c161e291fa769577c2' $$);
