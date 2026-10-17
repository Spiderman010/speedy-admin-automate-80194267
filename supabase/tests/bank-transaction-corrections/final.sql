-- EINDSTAND — na het OPNIEUW toepassen van de migratie. Throwaway database only.
--   F*  de migratie werkt na een rollback weer volledig, ook voor wat in de
--       tussentijd zonder gebeurtenis werd geboekt
--   I*  de boekhoudkundige invarianten over de hele database, na alle
--       scenario's, fouten, races, de rollback en het opnieuw toepassen

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['F1','F2','F3','F4','I10','I11','I12','I13','I14','I15','I16','I17']);

SELECT proof.expect_true('F1', 'opnieuw toegepast: tien functies en negen triggers, met de juiste inschakeling', $$
  (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.oid::regprocedure::text NOT IN (SELECT sig FROM proof.functions_before)) = 10
  AND (SELECT array_agg(t.tgenabled::text ORDER BY t.tgname COLLATE "C") FROM pg_trigger t
       WHERE t.tgname IN ('enforce_bank_transaction_posting_event_trigger','enforce_bank_transaction_posting_marker_delete_trigger',
                          'enforce_bank_transaction_posting_marker_lineage_trigger','enforce_bank_transaction_release_hold_trigger',
                          'prevent_bank_transaction_posting_event_mutation_trigger','prevent_bank_transaction_posting_event_truncate_trigger',
                          'prevent_bank_transaction_posting_marker_truncate_trigger','prevent_bank_transaction_posting_marker_update_trigger',
                          'validate_bank_allocation_not_released_trigger'))
      = ARRAY['O','A','A','A','A','A','A','A','O'] $$);

SELECT proof.put('f950', proof.rc(proof.u(1), proof.uid(1000, 950), proof.get('b950')::uuid, proof.acct(6), 21, proof.req(9502), 'Na rollback geboekt, nu corrigeren'));
SELECT proof.record('F2', 'de tijdens de rollback zonder gebeurtenis geboekte groep is gewoon corrigeerbaar',
  proof.get('f950') LIKE format('ok: reclassified|f|%%|%s|%%', proof.get('b950')), proof.get('f950'));

SELECT proof.put('f951', proof.rel(proof.u(1), proof.uid(1000, 951), proof.marker(proof.uid(1000, 951)), proof.req(9511), 'Vrijgeven na heropname'));
SELECT proof.record('F3', 'de hold werkt weer: na vrijgeven weigert een sjabloon-UPDATE',
  proof.get('f951') LIKE 'ok: released|f|%' AND o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', proof.get('f951') || ' || ' || o)
FROM proof.call(proof.u(2), format($q$UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = %L WHERE id = %L RETURNING id::text$q$,
                                   proof.acct(7), proof.uid(1000, 951))) o;

SELECT proof.expect_error('F4', 'en de marker is weer beschermd',
  format('DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = %L', proof.uid(1000, 950)),
  '42501', 'alleen worden losgemaakt nadat zij is tegengeboekt');

-- ── de invarianten ──────────────────────────────────────────────────────────

SELECT proof.record('I10', 'elke boekingsgroep is in evenwicht (debet = credit, > 0)', proof.unbalanced() = 0, proof.unbalanced()::text);

SELECT proof.record('I11', 'lineage: elke directe bankgroep is actief of precies één keer vervangen; per transactie hoogstens één open groep, en die is de marker',
  proof.lineage_violations() = 0, proof.lineage_violations()::text);

SELECT proof.expect_true('I12', 'geen banktransactie heeft zowel een directe als een afletteringsmarker', $$
  NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings d
              JOIN public.bank_allocation_postings a ON a.bank_transaction_id = d.bank_transaction_id) $$);

SELECT proof.expect_true('I13', 'per banktransactie staat het bankbedrag nooit meer dan één keer netto in het grootboek', $$
  NOT EXISTS (SELECT 1 FROM public.bank_transactions t
              WHERE abs(proof.net(t.id, '00000000-0000-0000-0000-00000000f001') + proof.net(t.id, '00000000-0000-0000-0000-00000000f010'))
                    > abs(t.amount)) $$);

SELECT proof.expect_true('I14', 'append-only: elke grootboekregel en tegenboekingsmarker van vóór PR 1 bestaat nog, byte-gelijk', $$
  NOT EXISTS (SELECT * FROM proof.ledger_before EXCEPT SELECT * FROM public.ledger_postings)
  AND NOT EXISTS (SELECT * FROM proof.reversals_before EXCEPT SELECT * FROM public.ledger_reversal_postings) $$);

SELECT proof.expect_true('I15', 'elke tegenboekingsregel wijst naar een bestaande originele regel; geen tegenboeking van een tegenboeking', $$
  NOT EXISTS (SELECT 1 FROM public.ledger_postings r
              WHERE r.reversal_of_posting_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.ledger_postings o WHERE o.id = r.reversal_of_posting_id AND o.source_type <> 'reversal')) $$);

SELECT proof.expect_true('I16', 'de schrijvers en PR 0 zijn niet herdefinieerd: alle bestaande functies byte-gelijk aan vóór PR 1', $$
  NOT EXISTS (SELECT * FROM proof.functions_before
              EXCEPT SELECT p.oid::regprocedure::text, md5(p.prosrc), p.prosecdef, p.provolatile,
                            coalesce(p.proconfig::text, ''), pg_get_userbyid(p.proowner), coalesce(p.proacl::text, '')
                     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace) $$);

SELECT proof.expect_true('I17', 'geen enkele weigering in het hele harnas noemt een uuid (bericht, detail of hint)', $$
  NOT EXISTS (SELECT 1 FROM proof.refusal WHERE outcome ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}') $$);
