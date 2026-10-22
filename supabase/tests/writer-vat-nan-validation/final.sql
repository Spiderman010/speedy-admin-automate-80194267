-- NÁ opnieuw toepassen (als één uitvoering, met SET lock_timeout ervoor, zoals
-- in de SQL editor) — throwaway database only.

SELECT proof.plan(ARRAY['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6']);

SELECT proof.record('Z1', 'opnieuw toegepast: weer exact de nieuwe lichamen, de vijf constraints NOT VALID, rechten als vóór',
  proof.p4_md5s() = proof.get('md5_na_eerste')
  AND proof.p4_constraints() = proof.get('constraints_na_eerste')
  AND proof.p4_attrs() = proof.get('attrs_voor'),
  proof.p4_md5s());

SELECT proof.record('Z2', 'na opnieuw toepassen weigert de schrijver weer een regel zonder keuze (22004)',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 2)), '22004', 'nog niet gekozen'));

SELECT proof.expect_true('Z3', 'het grootboek: elke groep in balans, en de enige NaN-regels zijn de drie van vóór de migratie', $$
  proof.unbalanced() = 0
  AND (SELECT count(*) FROM public.ledger_postings
       WHERE debit_amount = 'NaN'::numeric OR credit_amount = 'NaN'::numeric) = 3
  AND (SELECT count(*) FROM public.ledger_postings
       WHERE (debit_amount = 'NaN'::numeric OR credit_amount = 'NaN'::numeric)
         AND source_id IS DISTINCT FROM proof.uid(2400, 2)) = 0
$$);

SELECT proof.expect_true('Z4', 'de historie van vóór de migratie is onaangeroerd (geen backfill): N1, N2, N3 en N5 boeken exact zoals toen', $$
  proof.p4_lines('bank_transaction', proof.uid(1400, 1)) = '4700:121.00:0.00,1100:0.00:121.00'
  AND (SELECT btw_percentage IS NULL FROM public.bank_transactions WHERE id = proof.uid(1400, 1))
  AND proof.p4_lines('purchase_invoice', proof.uid(2400, 1)) = '4700:100.00:0.00,1520:21.00:0.00,1600:0.00:121.00'
  AND proof.p4_ledger_rows(proof.uid(2400, 2)) = 3
  AND proof.p4_lines('purchase_invoice', proof.uid(2400, 3)) = '4700:10.00:0.00,4700:10.01:0.00,1600:0.00:20.01'
$$);

SELECT proof.expect_true('Z5', 'alles wat geweigerd werd, staat nog ongeboekt', $$
  proof.marker(proof.uid(1400, 2)) IS NULL AND proof.marker(proof.uid(1400, 3)) IS NULL
  AND proof.marker(proof.uid(1400, 17)) IS NULL AND proof.marker(proof.uid(1400, 18)) IS NULL
  AND proof.p4_group('purchase_invoice', proof.uid(2400, 4)) IS NULL
  AND proof.p4_group('purchase_invoice', proof.uid(2400, 5)) IS NULL
  AND proof.p4_group('purchase_invoice', proof.uid(2400, 6)) IS NULL
  AND proof.p4_group('purchase_invoice', proof.uid(2400, 7)) IS NULL
  AND proof.p4_group('purchase_invoice', proof.uid(2400, 9)) IS NULL
  AND proof.p4_group('sales_invoice', proof.uid(3400, 1)) IS NULL
$$);

SELECT proof.expect_true('Z6', 'geen enkele weigering noemt een uuid (tenantveilig)', $$
  NOT EXISTS (SELECT 1 FROM proof.refusal
              WHERE outcome ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
$$);
