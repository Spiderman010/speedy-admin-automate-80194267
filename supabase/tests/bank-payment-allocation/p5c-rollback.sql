-- Q — P5c terugdraaien (letterlijk uit de kop, twee keer) en opnieuw vooruit.
-- Throwaway database only.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['Q1','Q2']);

SELECT proof.expect_true('Q1', 'P5c-rollback: guards weg, rechten letterlijk terug zoals PRE 2 ze vóór P5c toonde, geen rij gewijzigd, P5a intact',
  $$NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('enforce_bank_allocation_writer_trigger', 'enforce_invoice_payment_state_trigger'))
    AND to_regprocedure('public.enforce_invoice_payment_state()') IS NULL
    AND proof.acl('public.bank_transaction_allocations') = proof.get('p5c_acl')
    AND proof.p5digest() = proof.get('p5c_digest_before_rollback')
    AND to_regprocedure('public.link_bank_payment(uuid,text,uuid,numeric,uuid)') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'guard_bank_allocation_write_trigger')$$);

SELECT proof.tx(1210, 10.00), proof.sinv(1210, 10.00);
SELECT proof.put('q2', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 1210), 'verkoop', proof.uid(3000, 1210), 10));
SELECT proof.record('Q2', 'na de P5c-rollback kan de oude app weer rechtstreeks koppelen (binnen het P5a-vangnet)',
  proof.get('q2') LIKE 'ok:%', proof.get('q2'));
