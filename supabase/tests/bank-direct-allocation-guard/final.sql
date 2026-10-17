-- EINDSTAND — na het OPNIEUW toepassen van de migratie. Throwaway database only.
--   F*  de migratie werkt na een rollback weer volledig
--   I*  de boekhoudkundige invarianten over de hele database, na alle
--       scenario's, races, de tegenboeking en de rollback-rondgang

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.record('F1', 'na opnieuw toepassen wordt dezelfde aanval weer geweigerd',
  o LIKE 'geweigerd [23514] Deze banktransactie is al rechtstreeks%', o)
FROM proof.attack('insert', proof.uid(1000, 1), proof.uid(2000, 1)) o;

SELECT proof.expect_true('F2', 'en de drie triggers staan er weer, ingeschakeld (O)', $$
  (SELECT count(*) FROM pg_trigger
   WHERE tgname IN ('validate_bank_allocation_not_directly_posted_trigger',
                    'validate_bank_allocation_posting_not_directly_posted_trigger',
                    'validate_bank_direct_posting_without_allocations_trigger')
     AND tgenabled = 'O') = 3 $$);

-- ── de invarianten ──────────────────────────────────────────────────────────

SELECT proof.expect_true('I1', 'geen enkele banktransactie heeft zowel een directe als een afletteringsmarker', $$
  NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings d
              JOIN public.bank_allocation_postings a ON a.bank_transaction_id = d.bank_transaction_id) $$);

SELECT proof.expect_true('I2', 'elke boekingsgroep is in evenwicht (debet = credit, > 0)', $$
  NOT EXISTS (SELECT 1 FROM public.ledger_postings GROUP BY posting_group_id
              HAVING sum(debit_amount) <> sum(credit_amount) OR sum(debit_amount) <= 0) $$);

SELECT proof.expect_true('I3', 'geen dubbele bankmutatie: per banktransactie netto nooit meer dan haar bedrag op de bank', $$
  NOT EXISTS (SELECT 1 FROM public.bank_transactions t WHERE abs(proof.bank_net(t.id)) > abs(t.amount)) $$);

SELECT proof.expect_true('I4', 'de enige koppeling op een direct geboekte transactie is de legacy-koppeling van vóór PR 0 (en die is niet geboekt)', $$
  (SELECT array_agg(a.id) FROM public.bank_transaction_allocations a
   JOIN public.bank_transaction_postings d ON d.bank_transaction_id = a.bank_transaction_id)
  = ARRAY[proof.uid(4000, 9)]
  AND NOT EXISTS (SELECT 1 FROM public.bank_allocation_postings WHERE allocation_id = proof.uid(4000, 9)) $$);

SELECT proof.expect_true('I5', 'append-only: elke grootboekregel van vóór PR 0 bestaat nog, byte-gelijk', $$
  NOT EXISTS (SELECT * FROM proof.ledger_before EXCEPT SELECT * FROM public.ledger_postings) $$);

SELECT proof.expect_true('I6', 'elke tegenboekingsregel wijst naar een bestaande originele regel (historie herleidbaar)', $$
  NOT EXISTS (SELECT 1 FROM public.ledger_postings r
              WHERE r.reversal_of_posting_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.ledger_postings o WHERE o.id = r.reversal_of_posting_id)) $$);

SELECT proof.expect_true('I7', 'de schrijvers zijn niet herdefinieerd: de acht PR H-lichamen staan er nog exact', $$
  (SELECT bool_and(md5(p.prosrc) = h.na) AND count(*) = 8
   FROM (VALUES
     ('post_purchase_invoice',        '6366f052209d9a171f197de77eaf477a'),
     ('post_sales_invoice',           'cb467b35301239c3051c8b918662ea45'),
     ('post_bank_allocation',         '863d9e87ef89f7230a9ef020c49b168d'),
     ('post_manual_journal',          '2668c9ed24ef515b7016be29e8b6ffe5'),
     ('post_opening_balance',         '98cbf351067c0135943d910f86e792d6'),
     ('reverse_posting_group',        'b5db0ca04b5dcfbcec5dea1a7844fe13'),
     ('post_bank_transaction',        '2369978c713ac78a0c039dd5c3e5eb4c'),
     ('bank_bulk_posting_candidates', '946bef45005d6e572a7565da6fc12cdb')) h(naam, na)
   JOIN pg_proc p ON p.proname = h.naam
   JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public') $$);
