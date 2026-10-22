-- P — P5c (20261021183000), twee keer toegepast na P5a. Throwaway database only.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['P1','P2','P3','P4','P5','P6','P7','P8','P9','P10','P11','P12','P13','P14']);

SELECT proof.expect_true('P1', 'koppelingen: alleen SELECT voor authenticated en service_role, niets voor anon/PUBLIC; RLS-policies ongewijzigd; beide guards aanwezig',
  $$has_table_privilege('authenticated', 'public.bank_transaction_allocations', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.bank_transaction_allocations', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('service_role', 'public.bank_transaction_allocations', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('anon', 'public.bank_transaction_allocations', 'SELECT,INSERT,UPDATE,DELETE')
    AND (SELECT count(*) FROM pg_policies WHERE tablename = 'bank_transaction_allocations') = 4
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'enforce_bank_allocation_writer_trigger')
    AND (SELECT count(*) FROM pg_trigger WHERE tgname = 'enforce_invoice_payment_state_trigger') = 2
    AND proof.p5data() = proof.get('p5c_data')$$);

-- P2: de oude app (authenticated) kan niet meer rechtstreeks schrijven.
SELECT proof.tx(1200, 40.00), proof.sinv(1200, 40.00);
SELECT proof.put('p2a', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 1200), 'verkoop', proof.uid(3000, 1200), 10));
SELECT proof.put('p2b', proof.call(proof.u(1), format(
  'UPDATE public.bank_transaction_allocations SET amount = amount WHERE bank_transaction_id = %L RETURNING id::text', proof.uid(1000, 66))));
SELECT proof.put('p2c', proof.call(proof.u(1), format(
  'DELETE FROM public.bank_transaction_allocations WHERE bank_transaction_id = %L RETURNING id::text', proof.uid(1000, 62))));
SELECT proof.record('P2', 'authenticated: directe INSERT, UPDATE en DELETE op koppelingen → 42501 (geen recht)',
  proof.refused(proof.get('p2a'), '42501', 'permission denied') AND proof.refused(proof.get('p2b'), '42501', 'permission denied')
  AND proof.refused(proof.get('p2c'), '42501', 'permission denied'), proof.get('p2a'));

-- P3: de eigenaar (en elk pad als tabeleigenaar) loopt tegen de guard aan.
SELECT proof.put('p3a', proof.call(NULL, format(
  'INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
   SELECT id, ''verkoop'', %L, client_id, 10, user_id FROM public.bank_transactions WHERE id = %L RETURNING id::text',
  proof.uid(3000, 1200), proof.uid(1000, 1200)), 'postgres'));
SELECT proof.put('p3b', proof.call(NULL, format(
  'DELETE FROM public.bank_transaction_allocations WHERE bank_transaction_id = %L RETURNING id::text', proof.uid(1000, 62)), 'postgres'));
SELECT proof.put('p3c', proof.call(NULL, format(
  'UPDATE public.bank_transaction_allocations SET amount = amount WHERE bank_transaction_id = %L RETURNING id::text', proof.uid(1000, 62)), 'postgres'));
SELECT proof.record('P3', 'eigenaar: directe INSERT, UPDATE en DELETE → 42501 van de guard (een oude koppeling kan niet meer buiten de schrijver weg)',
  proof.refused(proof.get('p3a'), '42501', 'koppelen en ontkoppelen') AND proof.refused(proof.get('p3b'), '42501', 'koppelen en ontkoppelen')
  AND proof.refused(proof.get('p3c'), '42501', 'koppelen en ontkoppelen'), proof.get('p3b'));

SELECT proof.put('p4', proof.call(proof.u(1), format(
  'DELETE FROM public.bank_transactions WHERE id = %L RETURNING id::text', proof.uid(1000, 63))));
SELECT proof.record('P4', 'een banktransactie met (oude) koppelingen verwijderen: de cascade loopt tegen de guard (42501)',
  proof.refused(proof.get('p4'), '42501', 'koppelen en ontkoppelen')
  AND EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 63)), proof.get('p4'));

SELECT proof.put('p5a', proof.link(proof.u(6), proof.uid(1000, 1200), 'verkoop', proof.uid(3000, 1200), 40, proof.req(1200)));
SELECT proof.put('p5b', proof.unlink(proof.u(6), proof.uid(1000, 1200), proof.req(1201)));
SELECT proof.put('p5c', proof.link(proof.u(6), proof.uid(1000, 1200), 'verkoop', proof.uid(3000, 1200), 40, proof.req(1202)));
SELECT proof.record('P5', 'de schrijver werkt onder P5c: koppelen (betaald), ontkoppelen (gecontroleerd), opnieuw koppelen',
  proof.f(proof.get('p5a'), 4) = 'betaald' AND proof.get('p5b') = 'ok: unlinked|1|niet_gematcht|f'
  AND proof.f(proof.get('p5c'), 4) = 'betaald' AND proof.inv('verkoop', proof.uid(3000, 1200)) = '0.00|betaald', proof.get('p5c'));

-- P6: aanmaken.
SELECT proof.put('p6a', proof.call(proof.u(6), $q$INSERT INTO public.sales_invoices (user_id, client_id, customer_name, invoice_number, invoice_date, amount_excl, btw_amount, amount_incl, remaining_amount, status)
  VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'Nieuw', 'VK-N1', DATE '2027-04-01', 100, 21, 121, 121, 'concept') RETURNING remaining_amount::text$q$));
SELECT proof.put('p6b', proof.call(proof.u(2), $q$INSERT INTO public.purchase_invoices (user_id, client_id, supplier, amount_excl, remaining_amount, status)
  VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'Alleen excl', 50, 50, 'te_controleren') RETURNING remaining_amount::text$q$));
SELECT proof.put('p6c', proof.call(proof.u(2), $q$INSERT INTO public.purchase_invoices (user_id, client_id, supplier, remaining_amount, status)
  VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'OCR zonder bedrag', NULL, 'te_controleren') RETURNING coalesce(remaining_amount::text, 'leeg')$q$));
SELECT proof.put('p6d', proof.call(proof.u(2), $q$INSERT INTO public.purchase_invoices (user_id, client_id, supplier, remaining_amount, status)
  VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'Oude OCR', 0, 'te_controleren') RETURNING id::text$q$));
SELECT proof.put('p6e', proof.call(proof.u(6), $q$INSERT INTO public.sales_invoices (user_id, client_id, customer_name, invoice_number, invoice_date, amount_excl, btw_amount, amount_incl, remaining_amount, status)
  VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'Nieuw', 'VK-N2', DATE '2027-04-01', 100, 21, 121, 121, 'betaald') RETURNING id::text$q$));
SELECT proof.record('P6', 'aanmaken: restant = totaal, = excl zonder incl, of leeg mag; restant 0 zonder bedrag (oude OCR, A1-20) en status betaald worden geweigerd (23514)',
  proof.get('p6a') = 'ok: 121.00' AND proof.get('p6b') = 'ok: 50.00' AND proof.get('p6c') = 'ok: leeg'
  AND proof.refused(proof.get('p6d'), '23514', 'totaalbedrag of leeg') AND proof.refused(proof.get('p6e'), '23514', 'als betaald'),
  proof.get('p6d'));

-- P7: status.
SELECT proof.sinv(1203, 30.00, 'concept'), proof.pinv(1204, 30.00), proof.pinv(1205, 30.00, 'te_controleren');
SELECT proof.put('p7a', proof.call(proof.u(6), format('UPDATE public.sales_invoices SET status = ''betaald'' WHERE id = %L RETURNING status', proof.uid(3000, 1203))));
SELECT proof.put('p7b', proof.call(proof.u(2), format('UPDATE public.purchase_invoices SET status = ''betaald'' WHERE id = %L RETURNING status', proof.uid(2000, 1204))));
SELECT proof.put('p7c', proof.call(proof.u(6), format('UPDATE public.sales_invoices SET status = ''gecontroleerd'' WHERE id = %L RETURNING status', proof.uid(3000, 1200))));
SELECT proof.put('p7d', proof.call(proof.u(6), format('UPDATE public.sales_invoices SET status = ''gecontroleerd'' WHERE id = %L RETURNING status', proof.uid(3000, 1203))));
SELECT proof.put('p7e', proof.call(proof.u(2), format('UPDATE public.purchase_invoices SET status = ''gecontroleerd'' WHERE id = %L RETURNING status', proof.uid(2000, 1205))));
SELECT proof.put('p7f', proof.call(proof.u(2), format('UPDATE public.purchase_invoices SET status = ''geexporteerd'' WHERE id = %L RETURNING status', proof.uid(2000, 62))));
SELECT proof.record('P7', 'status: naar betaald (verkoop en inkoop) en verkoop uit betaald ("goedkeuren", A2-08) geweigerd; goedkeuren en exportmarkering (ook van een oude betaald-inkoop) mogen',
  proof.refused(proof.get('p7a'), '23514', 'status betaald') AND proof.refused(proof.get('p7b'), '23514', 'status betaald')
  AND proof.refused(proof.get('p7c'), '23514', 'status betaald')
  AND proof.get('p7d') = 'ok: gecontroleerd' AND proof.get('p7e') = 'ok: gecontroleerd' AND proof.get('p7f') = 'ok: geexporteerd',
  proof.get('p7c'));

-- P8: restant — alleen "niets betaald blijft niets betaald" (de bewerkdialoog), en nooit bij koppelingen.
SELECT proof.sinv(1206, 100.00, 'concept');
SELECT proof.put('p8a', proof.call(proof.u(6), format(
  'UPDATE public.sales_invoices SET amount_excl = 120, amount_incl = 120, remaining_amount = 120 WHERE id = %L RETURNING remaining_amount::text', proof.uid(3000, 1206))));
SELECT proof.put('p8b', proof.call(proof.u(6), format(
  'UPDATE public.sales_invoices SET remaining_amount = 50 WHERE id = %L RETURNING remaining_amount::text', proof.uid(3000, 1206))));
SELECT proof.put('p8c', proof.call(proof.u(6), format(
  'UPDATE public.sales_invoices SET remaining_amount = 40 WHERE id = %L RETURNING remaining_amount::text', proof.uid(3000, 106))));
SELECT proof.put('p8d', proof.call(proof.u(6), format(
  'UPDATE public.sales_invoices SET remaining_amount = NULL WHERE id = %L RETURNING coalesce(remaining_amount::text, ''leeg'')', proof.uid(3000, 1206))));
-- Legacy: inkoopfactuur via een oude match op 0 gezet, zonder koppeling. Stil
-- heropenen (restant 0 → 100) is geen open-sync en wordt geweigerd (review P5-DB §3).
SELECT proof.pinv(1215, 100.00, 'te_controleren');
SET session_replication_role = replica;
UPDATE public.purchase_invoices SET remaining_amount = 0 WHERE id = proof.uid(2000, 1215);
SET session_replication_role = origin;
SELECT proof.put('p8e', proof.call(proof.u(6), format(
  'UPDATE public.purchase_invoices SET remaining_amount = 100 WHERE id = %L RETURNING remaining_amount::text', proof.uid(2000, 1215))));
SELECT proof.record('P8', 'restant: meeschuiven met het totaal (geen koppelingen) en leegmaken mogen; een ander bedrag, welk restant dan ook bij koppelingen, of een legacy-factuur zonder koppeling stil heropenen (0 → 100) wordt geweigerd',
  proof.get('p8a') = 'ok: 120.00' AND proof.refused(proof.get('p8b'), '23514', 'openstaande bedrag')
  AND proof.refused(proof.get('p8c'), '23514', 'openstaande bedrag') AND proof.get('p8d') = 'ok: leeg'
  AND proof.refused(proof.get('p8e'), '23514', 'openstaande bedrag')
  AND (SELECT remaining_amount FROM public.purchase_invoices WHERE id = proof.uid(2000, 1215)) = 0,
  proof.get('p8b') || ' / ' || proof.get('p8e'));

-- P9: bedrag wijzigen zonder restant mee te sturen (inkoopwerkbank, save_purchase_invoice_with_lines).
SELECT proof.pinv(1207, 80.00, 'te_controleren'), proof.pinv(1208, 80.00, 'te_controleren'), proof.pinv(1209, 80.00, 'te_controleren');
UPDATE public.purchase_invoices SET remaining_amount = NULL WHERE id = proof.uid(2000, 1208);
SET session_replication_role = replica;
UPDATE public.purchase_invoices SET remaining_amount = 30 WHERE id = proof.uid(2000, 1209);
SET session_replication_role = origin;
SELECT proof.put('p9a', proof.call(proof.u(2), format(
  'UPDATE public.purchase_invoices SET amount_excl = 90, amount_incl = 90 WHERE id = %L RETURNING remaining_amount::text', proof.uid(2000, 1207))));
SELECT proof.put('p9b', proof.call(proof.u(2), format(
  'UPDATE public.purchase_invoices SET amount_excl = 90, amount_incl = 90 WHERE id = %L RETURNING coalesce(remaining_amount::text, ''leeg'')', proof.uid(2000, 1208))));
SELECT proof.put('p9c', proof.call(proof.u(2), format(
  'UPDATE public.purchase_invoices SET amount_excl = 90, amount_incl = 90 WHERE id = %L RETURNING remaining_amount::text', proof.uid(2000, 1209))));
SELECT proof.put('p9d', proof.call(proof.u(6), format(
  'UPDATE public.sales_invoices SET amount_excl = 101, amount_incl = 101 WHERE id = %L RETURNING id::text', proof.uid(3000, 106))));
SELECT proof.record('P9', 'bedrag wijzigen: onbetaald → restant volgt (90); leeg blijft leeg; een afwijkend oud restant (30) blijft staan; met koppelingen geweigerd',
  proof.get('p9a') = 'ok: 90.00' AND proof.get('p9b') = 'ok: leeg' AND proof.get('p9c') = 'ok: 30.00'
  AND proof.refused(proof.get('p9d'), '23514', 'ontkoppel eerst'), proof.get('p9d'));

SELECT proof.put('p10a', proof.call(proof.u(6), format('DELETE FROM public.sales_invoices WHERE id = %L RETURNING id::text', proof.uid(3000, 106))));
SELECT proof.put('p10b', proof.call(proof.u(6), format('DELETE FROM public.sales_invoices WHERE id = %L RETURNING id::text', proof.uid(3000, 1206))));
SELECT proof.record('P10', 'een factuur met koppelingen verwijderen: 23514; zonder koppelingen mag het',
  proof.refused(proof.get('p10a'), '23514', 'ontkoppel eerst') AND proof.get('p10b') LIKE 'ok:%', proof.get('p10a'));

-- P11: een aanroeper die de vlag vervalst, komt nergens.
SELECT proof.put('p11', proof.call(proof.u(6), format('SELECT proof.forge_flag_update(%L)', proof.uid(3000, 106))));
SELECT proof.record('P11', 'een zelf gezette vlag van de betaalschrijver opent de guard niet (geen gebeurtenis in deze transactie)',
  proof.refused(proof.get('p11'), '23514', 'status betaald'), proof.get('p11'));

SELECT proof.expect_true('P12', 'onder P5c: alle invarianten van de schrijver gelden, grootboek in balans',
  $$proof.writer_violations() = 0 AND proof.unbalanced() = 0$$);

-- ── P13/P14: vervalst schrijversbewijs ná een legitieme aanroep in dezelfde
-- transactie (review P5-DB §1). Echte COMMIT in een tweede sessie.
SELECT proof.open_session('g', :'conn');

-- P13 (G1): inkoop 100, koppelingen 40 + 30; ontkoppel 40, zet de vlag met de
-- hand en verlaag het factuurbedrag tot onder Σ (restant negatief).
SELECT proof.pinv(1216, 100.00), proof.tx(1216, -40.00), proof.tx(1217, -30.00);
SELECT proof.put('p13l1', proof.link(proof.u(6), proof.uid(1000, 1216), 'inkoop', proof.uid(2000, 1216), 40, proof.req(1216)));
SELECT proof.put('p13l2', proof.link(proof.u(6), proof.uid(1000, 1217), 'inkoop', proof.uid(2000, 1216), 30, proof.req(1217)));
SELECT proof.as_user('g', proof.u(6));
SELECT proof.remote_exec('g', 'BEGIN');
SELECT proof.put('p13u', proof.remote_run('g', proof.usql(proof.uid(1000, 1216), proof.req(12160))));
SELECT proof.put('p13f', proof.remote_run('g', 'SELECT set_config(''boekassist.betaalschrijver'', pg_current_xact_id()::text, true)'));
SELECT proof.put('p13x', proof.remote_exec('g', format(
  'UPDATE public.purchase_invoices SET amount_excl = 20, amount_incl = 20, remaining_amount = -10 WHERE id = %L', proof.uid(2000, 1216))));
SELECT proof.put('p13c', proof.remote_exec('g', 'COMMIT'));
SELECT proof.remote_exec('g', 'ROLLBACK');
SELECT proof.record('P13', 'G1 onder P5c: na een legitieme unlink de vlag met de hand zetten en het factuurbedrag onder Σ brengen — de UPDATE zelf wordt geweigerd (23514); factuur en koppelingen onveranderd (onder alleen P5a: L17, bij COMMIT)',
  proof.get('p13l1') LIKE 'ok:%' AND proof.get('p13l2') LIKE 'ok:%' AND proof.get('p13u') LIKE 'ok: unlinked|%'
  AND proof.refused(proof.get('p13x'), '23514', 'alleen het restant en de status')
  AND proof.inv('inkoop', proof.uid(2000, 1216)) LIKE '30.00|%'
  AND (SELECT amount_incl FROM public.purchase_invoices WHERE id = proof.uid(2000, 1216)) = 100
  AND (SELECT sum(amount) FROM public.bank_transaction_allocations WHERE invoice_id = proof.uid(2000, 1216)) = 70,
  proof.get('p13x') || ' / ' || proof.get('p13c'));

-- P14 (F2): volledige betaling op een concept-verkoopfactuur (restant 0, blijft
-- concept); daarna vlag met de hand en status → betaald.
SELECT proof.tx(1218, 100.00), proof.sinv(1218, 100.00, 'concept');
SELECT proof.remote_exec('g', 'BEGIN');
SELECT proof.put('p14l', proof.remote_run('g', proof.lsql(proof.uid(1000, 1218), 'verkoop', proof.uid(3000, 1218), 100, proof.req(1218))));
SELECT proof.put('p14f', proof.remote_run('g', 'SELECT set_config(''boekassist.betaalschrijver'', pg_current_xact_id()::text, true)'));
SELECT proof.put('p14x', proof.remote_exec('g', format(
  'UPDATE public.sales_invoices SET status = ''betaald'' WHERE id = %L', proof.uid(3000, 1218))));
SELECT proof.put('p14c', proof.remote_exec('g', 'COMMIT'));
SELECT proof.remote_exec('g', 'ROLLBACK');
SELECT proof.record('P14', 'F2 onder P5c: na een legitieme link (concept, restant 0) de vlag met de hand zetten en status betaald — de UPDATE zelf wordt geweigerd (23514); factuur blijft concept/100, geen koppeling (onder alleen P5a: L18, bij COMMIT)',
  proof.get('p14l') LIKE 'ok: created|0.00|%' AND proof.refused(proof.get('p14x'), '23514', 'alleen het restant en de status')
  AND proof.inv('verkoop', proof.uid(3000, 1218)) = '100.00|concept'
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 1218)),
  proof.get('p14x') || ' / ' || proof.get('p14c'));

SELECT dblink_disconnect('g');
