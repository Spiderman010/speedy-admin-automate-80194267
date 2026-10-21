-- R — NA DE GEDOCUMENTEERDE ROLLBACK (letterlijk uit de kop, twee keer).
-- Throwaway database only.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['R1','R2','R3','R4','R5','R6']);

SELECT proof.expect_true('R1', 'rollback: RPC''s, guards, vangnet, postconditie en hulpfuncties zijn weg',
  $$to_regprocedure('public.link_bank_payment(uuid,text,uuid,numeric,uuid)') IS NULL
    AND to_regprocedure('public.unlink_bank_payment(uuid,uuid,uuid)') IS NULL
    AND to_regprocedure('public.bank_payment_writer_active(text,uuid)') IS NULL
    AND to_regprocedure('public.bank_payment_assert_consistent(text,uuid,uuid)') IS NULL
    AND to_regprocedure('public.guard_bank_allocation_write()') IS NULL
    AND to_regprocedure('public.enforce_bank_allocation_integrity()') IS NULL
    AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN (
          'guard_bank_allocation_write_trigger', 'validate_bank_allocation_integrity_trigger',
          'validate_bank_match_rejection_not_linked_trigger', 'verify_bank_payment_event_trigger'))$$);

SELECT proof.expect_true('R2', 'rollback: prevent_posted_sales_invoice_mutation is byte-voor-byte het origineel van 20260915160000, trigger actief',
  $$(SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.prevent_posted_sales_invoice_mutation()'::regprocedure)
      = 'aad983904aba6df9519d332389427b4e'
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'prevent_posted_sales_invoice_mutation_trigger' AND tgenabled = 'O')$$);

SELECT proof.expect_true('R3', 'rollback: claims, gebeurtenissen (met append-only) en created_by blijven als geschiedenis staan',
  $$(SELECT count(*) FROM public.bank_payment_requests) > 0
    AND (SELECT count(*) FROM public.bank_payment_events) > 0
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'prevent_bank_payment_event_mutation_trigger' AND tgenabled = 'A')
    AND EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE created_by IS NOT NULL)$$);

SELECT proof.expect_true('R4', 'rollback (twee keer) wijzigt geen enkele rij: koppelingen, facturen, transacties, claims en gebeurtenissen',
  $$proof.p5digest() = proof.get('digest_before_rollback')$$);

DO $r5$
DECLARE v boolean;
BEGIN
  BEGIN
    PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
    UPDATE public.bank_transaction_allocations SET amount = amount
    WHERE id = (SELECT allocation_id FROM public.bank_payment_events WHERE event_type = 'linked'
                AND allocation_id IN (SELECT id FROM public.bank_transaction_allocations) LIMIT 1);
    v := FOUND;
    RAISE EXCEPTION 'ongedaan maken';
  EXCEPTION WHEN raise_exception THEN NULL;
            WHEN others THEN v := false;
  END;
  PERFORM proof.record('R5', 'na de rollback is het gedrag van vóór P5a terug: een koppeling van de schrijver is weer rechtstreeks te wijzigen (proef, teruggedraaid)', coalesce(v, false));
END
$r5$;

SELECT proof.put('r6', proof.call(proof.u(6), format(
  'UPDATE public.sales_invoices SET status = ''gecontroleerd'' WHERE id = %L RETURNING status', proof.uid(3000, 606))));
SELECT proof.record('R6', 'na de rollback: betaald → gecontroleerd op een geboekte verkoopfactuur weer voor iedereen geweigerd (zoals N4)',
  proof.refused(proof.get('r6'), '42501', 'alleen nog van gecontroleerd naar betaald'), proof.get('r6'));
