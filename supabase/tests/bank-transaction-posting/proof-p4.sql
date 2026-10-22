-- FASE 2 — post_bank_transaction() zoals hij NU is (20261021170000), op de
-- volledige keten — THROWAWAY cluster only. Zie run-proof.sh.
--
-- De bewijzen van fase 1 gebruikten NULL als "geen BTW" en legden daarmee bug
-- E-06 vast: een ontbrekende btw-keuze boekte stil als 0%. Hier de sterkere
-- vervanging, op de huidige schrijver: NULL wordt geweigerd (22004) zonder dat
-- er iets gebeurt; expliciet 0 boekt exact twee regels; na de keuze boekt
-- dezelfde regel gewoon; de tenantpoort en de rechten zijn ongewijzigd.
--
-- Draait na ../writer-vat-nan-validation/build-chain.sh, diens helpers.sql en
-- de migratie 20261021170000 (gebruikers e1–e6, c1, de vrijgestelde c2, c3 van
-- organisatie B; rekeningen 1100 Bank, 4700 Kantoorkosten, 8000 Omzet).

SELECT proof.plan(ARRAY['P4-1', 'P4-2', 'P4-3', 'P4-4', 'P4-5', 'P4-6', 'P4-7', 'P4-8']);

SELECT proof.p4_tx(101, -100.00, NULL);
SELECT proof.put('p1', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 101)));
SELECT proof.record('P4-1', 'zonder btw-keuze: geweigerd (22004, duidelijke melding); geen marker, geen grootboekregel, de regel onaangeroerd',
  proof.p4_is_error(proof.get('p1'), '22004', 'Het BTW-percentage van deze banktransactie is nog niet gekozen')
  AND proof.marker(proof.uid(1400, 101)) IS NULL
  AND proof.p4_ledger_rows(proof.uid(1400, 101)) = 0
  AND (SELECT amount = -100.00 AND match_status = 'handmatig_geboekt' AND btw_percentage IS NULL
              AND grootboekrekening_id = '00000000-0000-0000-0000-00000000f007'
       FROM public.bank_transactions WHERE id = proof.uid(1400, 101)),
  proof.get('p1'));

SELECT proof.p4_tx(102, -100.00, NULL, '00000000-0000-0000-0000-0000000000c2');
SELECT proof.record('P4-2', 'ook bij een btw-vrijgestelde administratie: zonder keuze geweigerd (22004)',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 102)), '22004', 'nog niet gekozen'));

SELECT proof.p4_tx(103, -100.00, 0);
SELECT proof.put('p3', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 103)));
SELECT proof.record('P4-3', 'expliciet 0, uitgaand: exact twee regels — 4700 debet 100,00 en 1100 credit 100,00 — en een marker zonder percentage',
  proof.get('p3') LIKE 'ok: %'
  AND proof.p4_lines('bank_transaction', proof.uid(1400, 103)) = '4700:100.00:0.00,1100:0.00:100.00'
  AND proof.p4_ledger_rows(proof.uid(1400, 103)) = 2
  AND (SELECT btw_percentage IS NULL AND btw_amount = 0 FROM public.bank_transaction_postings
       WHERE bank_transaction_id = proof.uid(1400, 103)),
  proof.get('p3') || ' / ' || coalesce(proof.p4_lines('bank_transaction', proof.uid(1400, 103)), '-'));

SELECT proof.p4_tx(104, 250.00, 0, '00000000-0000-0000-0000-0000000000c1', DATE '2027-03-01', 'handmatig_geboekt',
                   '00000000-0000-0000-0000-00000000f008');
SELECT proof.put('p4', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 104)));
SELECT proof.record('P4-4', 'expliciet 0, inkomend: exact twee regels — 1100 debet 250,00 en 8000 credit 250,00',
  proof.p4_lines('bank_transaction', proof.uid(1400, 104)) = '1100:250.00:0.00,8000:0.00:250.00'
  AND proof.p4_ledger_rows(proof.uid(1400, 104)) = 2,
  proof.get('p4') || ' / ' || coalesce(proof.p4_lines('bank_transaction', proof.uid(1400, 104)), '-'));

-- Geweigerd → "Geen BTW" gekozen (als assistant, onder RLS) → geboekt.
SELECT proof.put('p5a', proof.call(proof.u(2), format(
  'UPDATE public.bank_transactions SET btw_percentage = 0 WHERE id = %L::uuid RETURNING btw_percentage::text', proof.uid(1400, 101))));
SELECT proof.put('p5b', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 101)));
SELECT proof.record('P4-5', 'na de keuze "Geen BTW" boekt dezelfde regel: exact twee regels, zonder btw',
  proof.get('p5a') = 'ok: 0' AND proof.get('p5b') LIKE 'ok: %'
  AND proof.p4_lines('bank_transaction', proof.uid(1400, 101)) = '4700:100.00:0.00,1100:0.00:100.00',
  concat_ws(' / ', proof.get('p5a'), proof.get('p5b')));

SELECT proof.p4_tx(105, -100.00, 21);
SELECT proof.put('p6', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 105)));
SELECT proof.record('P4-6', 'afronding ongewijzigd: 100,00 bruto bij 21% = 82,64 netto + 17,36 btw',
  (SELECT gross_amount = 100.00 AND net_amount = 82.64 AND btw_amount = 17.36 AND btw_percentage = 21
   FROM public.bank_transaction_postings WHERE bank_transaction_id = proof.uid(1400, 105))
  AND proof.p4_lines('bank_transaction', proof.uid(1400, 105)) = '4700:82.64:0.00,1520:17.36:0.00,1100:0.00:100.00',
  proof.get('p6'));

SELECT proof.p4_tx(106, -60.00, NULL);
SELECT proof.record('P4-7', 'de tenantpoort gaat vóór de btw-toets: een vreemde regel zonder keuze is niet te onderscheiden van een onbekende',
  proof.p4_post(proof.u(3), 'post_bank_transaction', proof.uid(1400, 106))
    = proof.p4_post(proof.u(3), 'post_bank_transaction', proof.uid(1400, 99999))
  AND proof.p4_post(proof.u(3), 'post_bank_transaction', proof.uid(1400, 106)) = 'fout [42501] Banktransactie niet beschikbaar |  | ',
  proof.p4_post(proof.u(3), 'post_bank_transaction', proof.uid(1400, 106)));

SELECT proof.expect_true('P4-8', 'rechten ongewijzigd: alleen authenticated mag uitvoeren; SECURITY DEFINER met vast search_path', $$
  SELECT has_function_privilege('authenticated', 'public.post_bank_transaction(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.post_bank_transaction(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('service_role', 'public.post_bank_transaction(uuid)', 'EXECUTE')
     AND (SELECT prosecdef AND proconfig = ARRAY['search_path=public']
          FROM pg_proc WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure)
$$);
