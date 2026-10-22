-- F — OPNIEUW VOORUIT na de rollback, en de globale invarianten.
-- Throwaway database only.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['F1','F2','F3','F4','F5']);

SELECT proof.expect_true('F1', 'opnieuw toegepast: RPC''s en guards terug, P5a-versie van de verkooptrigger, catalogus buiten P5 ongewijzigd',
  $$to_regprocedure('public.link_bank_payment(uuid,text,uuid,numeric,uuid)') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'guard_bank_allocation_write_trigger')
    AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.prevent_posted_sales_invoice_mutation()'::regprocedure)
        = 'd7fa08d5356e5f0152928aa7f03438ad'
    AND proof.p5catalog() = proof.get('snap_catalog')$$);

SELECT proof.expect_true('F2', 'opnieuw toepassen wijzigt geen enkele rij',
  $$proof.p5digest() = proof.get('digest_before_rollback')$$);

SELECT proof.put('f5', proof.link(proof.u(6), proof.uid(1000, 100), 'verkoop', proof.uid(3000, 100), 30, proof.req(100)));
SELECT proof.record('F3', 'een claim van vóór de rollback geeft na opnieuw toepassen nog steeds hetzelfde antwoord (replayed)',
  proof.f(proof.get('f5'), 2) = 'created' AND proof.f(proof.get('f5'), 3) = '70.00' AND proof.f(proof.get('f5'), 6) = 't',
  proof.get('f5'));

SELECT proof.tx(1300, 10.00), proof.sinv(1300, 10.00);
SELECT proof.put('f4a', proof.link(proof.u(6), proof.uid(1000, 1300), 'verkoop', proof.uid(3000, 1300), 10, proof.req(1300)));
SELECT proof.put('f4b', proof.unlink(proof.u(6), proof.uid(1000, 1300), proof.req(1301)));
SELECT proof.record('F4', 'na opnieuw toepassen: koppelen en ontkoppelen werken',
  proof.f(proof.get('f4a'), 4) = 'betaald' AND proof.get('f4b') = 'ok: unlinked|1|niet_gematcht|f'
  AND proof.inv('verkoop', proof.uid(3000, 1300)) = '10.00|gecontroleerd', proof.get('f4b'));

SELECT proof.expect_true('F5', 'globaal: elke door de schrijver geraakte factuur en transactie sluit aan, grootboek in balans, legacy-rijen L4/L5 onaangeroerd',
  $$proof.writer_violations() = 0 AND proof.unbalanced() = 0
    AND proof.inv('verkoop', proof.uid(3000, 63)) = '55.00|gecontroleerd'
    AND proof.txs(proof.uid(1000, 65)) LIKE 'handmatig_geboekt|%|45.00|1'$$);
