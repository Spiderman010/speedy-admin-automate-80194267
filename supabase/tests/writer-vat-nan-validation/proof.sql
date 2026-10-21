-- NÁ 20261021170000 (twee keer toegepast) — throwaway database only.
--
-- Gebruikers (fixtures): e1 accountant, e2 assistant, e4 read_only en e6 owner
-- van organisatie A; e3 accountant van organisatie B. c1 = gewone
-- administratie, c2 = btw-vrijgesteld (beide A), c3 = organisatie B.
-- Rekeningen: 1100 Bank, 1300 Debiteuren, 1520 BTW te vorderen, 1530 BTW te
-- betalen, 1600 Crediteuren, 4700 Kantoorkosten, 8000 Omzet.
-- Variabelen: prereq (de voorwaardencontrole uit de migratie, letterlijk),
-- pre5 (blok Q7 uit preflight.sql, letterlijk).

SELECT proof.plan(ARRAY[
  'M1', 'M1b', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7',
  'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8',
  'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15', 'B16',
  'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8',
  'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7',
  'F1', 'F2',
  'S1', 'S2', 'S3', 'S4',
  'H1', 'H2',
  'G1', 'G2']);

-- ── 0. een boekingsblokkade op c1 t/m 31-01-2027 (voor B9, H1, H2) ───────────
SELECT proof.put('lock', proof.call(proof.u(1), format(
  'SELECT public.set_posting_lock(%L::uuid, DATE ''2027-01-31'', ''P4-harnas'')::text',
  '00000000-0000-0000-0000-0000000000c1')));

-- ══ M — de migratie zelf ════════════════════════════════════════════════════

SELECT proof.record('M1', 'de vijf functies dragen exact de nieuwe lichamen (md5(prosrc))',
  proof.p4_md5s() = 'bank_bulk_posting_candidates=4b04544d2292704d8ac034edc909055c,'
                 || 'post_bank_transaction=28ac97ed4e030759bbb31082da50c118,'
                 || 'post_bank_transactions_bulk=885fe27bd78d6cc3836fc760412015ed,'
                 || 'post_purchase_invoice=4d183b1e5fe11f37d508a3e7f764176f,'
                 || 'post_sales_invoice=d05b6c0a4b9c3dd6ef6a835ff37f9b64',
  proof.p4_md5s());

SELECT proof.record('M1b', 'idempotent: de tweede toepassing veranderde niets (lichamen en constraints gelijk aan na de eerste)',
  proof.get('md5_na_eerste') = proof.p4_md5s() AND proof.get('constraints_na_eerste') = proof.p4_constraints());

SELECT proof.record('M2', 'eigenaar, SECURITY DEFINER/INVOKER, search_path, volatiliteit, taal, uitkomsttype en rechten: exact als vóór',
  proof.p4_attrs() = proof.get('attrs_voor'), proof.p4_attrs());

SELECT proof.expect_true('M3', 'uitvoerrecht exact: authenticated wel; anon, service_role en PUBLIC niet', $$
  SELECT bool_and(has_function_privilege('authenticated', f, 'EXECUTE')
              AND NOT has_function_privilege('anon', f, 'EXECUTE')
              AND NOT has_function_privilege('service_role', f, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = f AND a.grantee = 0))
     AND count(*) = 5
  FROM proof.p4_functions() f
$$);

SELECT proof.record('M4', 'vijf CHECK-constraints, exact, NOT VALID (bestaande rijen niet getoetst), één keer',
  proof.p4_constraints() =
     'bank_transactions.bank_transactions_amount_not_nan:false:CHECK ((amount <> ''NaN''::numeric)) NOT VALID' || E'\n'
  || 'ledger_postings.ledger_postings_amounts_not_nan:false:CHECK (((debit_amount <> ''NaN''::numeric) AND (credit_amount <> ''NaN''::numeric))) NOT VALID' || E'\n'
  || 'purchase_invoice_lines.purchase_invoice_lines_amount_finite:false:CHECK (((amount_excl <> ''NaN''::numeric) AND (amount_excl <> ''Infinity''::numeric) AND (amount_excl <> ''-Infinity''::numeric))) NOT VALID' || E'\n'
  || 'purchase_invoices.purchase_invoices_amounts_not_nan:false:CHECK (((amount_excl <> ''NaN''::numeric) AND (btw_amount <> ''NaN''::numeric) AND (amount_incl <> ''NaN''::numeric))) NOT VALID' || E'\n'
  || 'sales_invoices.sales_invoices_amounts_not_nan:false:CHECK (((amount_excl <> ''NaN''::numeric) AND (btw_amount <> ''NaN''::numeric) AND (amount_incl <> ''NaN''::numeric))) NOT VALID',
  proof.p4_constraints());

-- De voorwaardencontrole, letterlijk uit de migratie, in een subtransactie met
-- een geknoeide catalogus (die daarna vanzelf terugrolt).
SELECT proof.expect_error('M5', 'anti-clobber: een onbekend lichaam wordt geweigerd vóór elke CREATE OR REPLACE (55000)',
  format('DO $t$ BEGIN EXECUTE %L; EXECUTE %L; END $t$',
         'CREATE OR REPLACE FUNCTION public.post_sales_invoice(_invoice_id uuid) RETURNS uuid LANGUAGE sql AS $b$ SELECT NULL::uuid $b$',
         :'prereq'),
  '55000', 'onbekend lichaam');

SELECT proof.expect_error('M6', 'zonder PR 2 (20261018150000) weigert de voorwaardencontrole (55000)',
  format('DO $t$ BEGIN EXECUTE %L; EXECUTE %L; END $t$',
         'ALTER FUNCTION public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text) RENAME TO reclassify_tijdelijk_weg',
         :'prereq'),
  '55000', 'PR 2');

SELECT proof.record('M7', 'te vroeg toegepast (zonder PR 2): de hele migratie weigert en verandert niets — lichamen en constraints als vóór',
  position('PR 2' IN coalesce(proof.get('te_vroeg_err'), '')) > 0
  AND proof.get('te_vroeg_md5') = proof.get('md5_voor')
  AND proof.get('te_vroeg_constraints') = '',
  proof.get('te_vroeg_err'));

-- ══ K — het uitrolmateriaal ═════════════════════════════════════════════════

SELECT proof.record('K1', 'PRE 1 (voorwaarden) was overal true', proof.get('pre1_all_true') = 'true');
SELECT proof.record('K2', 'PRE 2 (de vijf lichamen exact, rechten exact) was overal true', proof.get('pre2_all_true') = 'true');

SELECT proof.record('K3', 'PRE 3 telt de bankregels zonder btw-keuze juist (wordt review_needed / ongeboekt / al geboekt, per vrijgesteld)',
  proof.get('pre3') = (
    SELECT string_agg(j::text, E'\n' ORDER BY j::text) FROM (VALUES
      (jsonb_build_object('administratie_vrijgesteld', false, 'wordt_review_needed', 1, 'ongeboekt_zonder_pct_totaal', 2,
                          'al_geboekt_zonder_keuze', 1, 'administraties', 1)),
      (jsonb_build_object('administratie_vrijgesteld', true, 'wordt_review_needed', 1, 'ongeboekt_zonder_pct_totaal', 1,
                          'al_geboekt_zonder_keuze', 0, 'administraties', 1))) v(j)),
  proof.get('pre3'));

SELECT proof.record('K4', 'PRE 4 telt vrijgesteld-met-btw (boekklaar, in controle, al geboekt) en fracties van een cent juist',
  proof.get('pre4') = jsonb_build_object('vrijgesteld_met_btw_boekklaar', 1, 'vrijgesteld_met_btw_in_controle', 1,
                                         'vrijgesteld_met_btw_geboekt', 1, 'fracties_van_een_cent', 1)::text,
  proof.get('pre4'));

SELECT proof.record('K5', 'PRE 5 (Q7) telt de bestaande NaN-rijen juist, ook ±oneindig in een regel',
  proof.get('pre5') = jsonb_build_object('ledger_postings_nan', 3, 'purchase_invoices_nan', 2, 'sales_invoices_nan', 1,
                                         'purchase_invoice_lines_niet_eindig', 3, 'bank_transactions_nan', 1)::text,
  proof.get('pre5'));

SELECT proof.record('K6', 'POST 1, POST 2 en POST 3 direct na de migratie: overal true',
  proof.get('post1_all_true') = 'true' AND proof.get('post2_all_true') = 'true' AND proof.get('post3_all_true') = 'true',
  concat_ws(' ', proof.get('post1_all_true'), proof.get('post2_all_true'), proof.get('post3_all_true')));

SELECT proof.record('K7', 'POST 4 = PRE 6: geen andere functie, trigger, RULE of policy gewijzigd en geen rij gewijzigd (geen backfill)',
  proof.get('post4') = proof.get('pre6'), proof.get('post4'));

SELECT proof.record('K8', 'preflight.sql en postcheck.sql draaien volledig in een read-only transactie, zonder fout',
  proof.get('ro') = 'ok', proof.get('ro'));

-- ══ B — E-06: de bankschrijver, de preflight en de bulk ═════════════════════

SELECT proof.put('b1', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 2)));
SELECT proof.record('B1', 'een gecodeerde bankregel zonder btw-keuze wordt geweigerd (22004, duidelijke melding); niets geboekt, de regel onaangeroerd',
  proof.p4_is_error(proof.get('b1'), '22004', 'Het BTW-percentage van deze banktransactie is nog niet gekozen; kies 0 (geen BTW), 9 of 21 procent')
  AND proof.marker(proof.uid(1400, 2)) IS NULL
  AND proof.p4_ledger_rows(proof.uid(1400, 2)) = 0
  AND (SELECT btw_percentage IS NULL AND match_status = 'handmatig_geboekt'
              AND grootboekrekening_id = '00000000-0000-0000-0000-00000000f007'
       FROM public.bank_transactions WHERE id = proof.uid(1400, 2)),
  proof.get('b1'));

SELECT proof.put('b2', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 4)));
SELECT proof.record('B2', 'ook bij een btw-vrijgestelde administratie: zonder keuze geweigerd (22004), zoals de app vraagt',
  proof.p4_is_error(proof.get('b2'), '22004', 'nog niet gekozen') AND proof.marker(proof.uid(1400, 4)) IS NULL,
  proof.get('b2'));

SELECT proof.p4_tx(10, -121.00, 0);
SELECT proof.put('b3', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 10)));
SELECT proof.record('B3', 'expliciet 0 ("Geen BTW") boekt zonder btw: precies kosten debet en bank credit; marker zonder percentage',
  proof.get('b3') LIKE 'ok: %'
  AND proof.p4_lines('bank_transaction', proof.uid(1400, 10)) = '4700:121.00:0.00,1100:0.00:121.00'
  AND (SELECT btw_percentage IS NULL AND btw_amount = 0 AND gross_amount = 121.00 AND net_amount = 121.00
       FROM public.bank_transaction_postings WHERE bank_transaction_id = proof.uid(1400, 10)),
  proof.get('b3') || ' / ' || coalesce(proof.p4_lines('bank_transaction', proof.uid(1400, 10)), '-'));

SELECT proof.p4_tx(11, -121.00, 21);
SELECT proof.put('b4', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 11)));
SELECT proof.record('B4', 'expliciet 21% uitgaand: netto debet, BTW te vorderen debet, bank credit (ongewijzigd)',
  proof.p4_lines('bank_transaction', proof.uid(1400, 11)) = '4700:100.00:0.00,1520:21.00:0.00,1100:0.00:121.00',
  proof.get('b4') || ' / ' || coalesce(proof.p4_lines('bank_transaction', proof.uid(1400, 11)), '-'));

SELECT proof.p4_tx(12, 109.00, 9);
SELECT proof.put('b5', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 12)));
SELECT proof.record('B5', 'expliciet 9% inkomend: bank debet, netto credit, BTW te betalen credit (ongewijzigd)',
  proof.p4_lines('bank_transaction', proof.uid(1400, 12)) = '1100:109.00:0.00,4700:0.00:100.00,1530:0.00:9.00',
  proof.get('b5') || ' / ' || coalesce(proof.p4_lines('bank_transaction', proof.uid(1400, 12)), '-'));

SELECT proof.p4_tx(13, -121.00, 21, '00000000-0000-0000-0000-0000000000c2');
SELECT proof.put('b6', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 13)));
SELECT proof.record('B6', 'vrijgesteld met een gekozen 21%: nog steeds nooit btw (bruto op de kostenrekening), zoals altijd',
  proof.p4_lines('bank_transaction', proof.uid(1400, 13)) = '4700:121.00:0.00,1100:0.00:121.00',
  proof.get('b6') || ' / ' || coalesce(proof.p4_lines('bank_transaction', proof.uid(1400, 13)), '-'));

-- De werkstroom: geweigerd → keuze maken (als assistant, onder RLS, zoals de bankpagina) → boeken.
SELECT proof.p4_tx(14, -242.00, NULL);
SELECT proof.put('b7a', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 14)));
SELECT proof.put('b7b', proof.call(proof.u(2), format(
  'UPDATE public.bank_transactions SET btw_percentage = 21 WHERE id = %L::uuid RETURNING btw_percentage::text', proof.uid(1400, 14))));
SELECT proof.put('b7c', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 14)));
SELECT proof.record('B7', 'na de keuze boekt dezelfde regel gewoon: geweigerd → 21% gekozen → geboekt met btw',
  proof.p4_is_error(proof.get('b7a'), '22004', 'nog niet gekozen')
  AND proof.get('b7b') = 'ok: 21'
  AND proof.get('b7c') LIKE 'ok: %'
  AND proof.p4_lines('bank_transaction', proof.uid(1400, 14)) = '4700:200.00:0.00,1520:42.00:0.00,1100:0.00:242.00',
  concat_ws(' / ', proof.get('b7a'), proof.get('b7b'), proof.get('b7c')));

-- De tenantpoort en de rolvloer gaan vóór: een regel zonder keuze verraadt niets.
SELECT proof.record('B8', 'tenantpoort ongewijzigd: een vreemde regel zonder keuze geeft exact de fout van een onbekende; read_only krijgt de rolvloer',
  proof.p4_post(proof.u(3), 'post_bank_transaction', proof.uid(1400, 2))
    = proof.p4_post(proof.u(3), 'post_bank_transaction', proof.uid(1400, 99999))
  AND proof.p4_post(proof.u(3), 'post_bank_transaction', proof.uid(1400, 2)) = 'fout [42501] Banktransactie niet beschikbaar |  | '
  AND proof.p4_post(proof.u(4), 'post_bank_transaction', proof.uid(1400, 2))
      = 'fout [42501] Geen rechten om te boeken voor deze organisatie |  | ',
  proof.p4_post(proof.u(4), 'post_bank_transaction', proof.uid(1400, 2)));

SELECT proof.p4_tx(15, -40.00, NULL, '00000000-0000-0000-0000-0000000000c1', DATE '2027-01-15');
SELECT proof.put('b9', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 15)));
SELECT proof.record('B9', 'de boekingsblokkade gaat vóór: een regel zonder keuze in een geblokkeerde periode krijgt de blokkadefout',
  proof.get('lock') LIKE 'ok: %'
  AND proof.p4_is_error(proof.get('b9'), '22023', 'boekingsblokkade'),
  concat_ws(' / ', proof.get('lock'), proof.get('b9')));

SELECT proof.p4_tx(16, -30.00, NULL);
SELECT proof.p4_purchase(20, '00000000-0000-0000-0000-0000000000c1', 30.00, 0, 30.00, 0, ARRAY[30.00]);
INSERT INTO public.bank_transaction_allocations
  (bank_transaction_id, organization_id, client_id, invoice_id, invoice_type, amount, user_id)
VALUES (proof.uid(1400, 16), '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1',
        proof.uid(2400, 20), 'inkoop', 30.00, '00000000-0000-0000-0000-0000000000e1');
SELECT proof.put('b10', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 16)));
SELECT proof.record('B10', 'de koppelingsgrendel (PR 0) gaat vóór: een gekoppelde regel zonder keuze krijgt de koppelingsfout',
  proof.p4_is_error(proof.get('b10'), '22023', 'aan een factuur gekoppeld'), proof.get('b10'));

SELECT proof.p4_tx(17, -10.00, 'NaN');
SELECT proof.p4_tx(18, -10.00, 'NaN', '00000000-0000-0000-0000-0000000000c2');
SELECT proof.p4_tx(19, -10.00, 'Infinity', '00000000-0000-0000-0000-0000000000c2');
SELECT proof.record('B11', 'een btw-percentage NaN of oneindig wordt geweigerd (22023), ook bij vrijgesteld (werd daar stil 0)',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 17)), '22023', 'Ongeldig BTW-percentage (NaN)')
  AND proof.p4_is_error(proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 18)), '22023', 'Ongeldig BTW-percentage (NaN)')
  AND proof.p4_is_error(proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 19)), '22023', 'Ongeldig BTW-percentage (Infinity)')
  AND proof.marker(proof.uid(1400, 18)) IS NULL AND proof.marker(proof.uid(1400, 19)) IS NULL,
  proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 18)));

SELECT proof.put('b12', proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 3)));
SELECT proof.record('B12', 'een bestaande NaN-bankregel wordt geweigerd (22023); niets geboekt',
  proof.p4_is_error(proof.get('b12'), '22023', 'geen getal (NaN)') AND proof.marker(proof.uid(1400, 3)) IS NULL,
  proof.get('b12'));

-- De preflight: alleen de arm vóór ELSE is erbij.
SELECT proof.p4_tx(20, -15.00, 0);
SELECT proof.put('b13', proof.call(proof.u(2), format($q$
  SELECT string_agg(format('%%s=%%s|%%s', right(transaction_id::text, 2), workflow_state, coalesce(reason, '')), E'\n' ORDER BY transaction_id)
  FROM public.bank_bulk_posting_candidates(%L::uuid, NULL)
  WHERE transaction_id IN (%L::uuid, %L::uuid, %L::uuid, %L::uuid, %L::uuid, %L::uuid)$q$,
  '00000000-0000-0000-0000-0000000000c1',
  proof.uid(1400, 2), proof.uid(1400, 5), proof.uid(1400, 10), proof.uid(1400, 15), proof.uid(1400, 16), proof.uid(1400, 20))));
SELECT proof.put('b13c2', proof.call(proof.u(2), format(
  'SELECT workflow_state || ''|'' || reason FROM public.bank_bulk_posting_candidates(%L::uuid, NULL) WHERE transaction_id = %L::uuid',
  '00000000-0000-0000-0000-0000000000c2', proof.uid(1400, 4))));
SELECT proof.record('B13', 'preflight: zonder keuze review_needed met de reden van de app; eerdere armen (status, blokkade, koppeling) gaan voor; expliciet 0 is ready',
  proof.get('b13') = 'ok: '
    || '02=review_needed|Het BTW-percentage is nog niet gekozen. Kies het bij het coderen of in de details van de bankregel op de bankpagina.' || E'\n'
    || '05=review_needed|Status is niet_gematcht; alleen handmatig gecodeerde banktransacties kunnen zo geboekt worden.' || E'\n'
    || '10=posted|' || E'\n'
    || '15=blocked|Boekingsdatum 2027-01-15 valt binnen de boekingsblokkade t/m 2027-01-31 voor deze administratie.' || E'\n'
    || '16=blocked|Deze banktransactie is aan een factuur gekoppeld; boek die via de aflettering.' || E'\n'
    || '20=ready|'
  AND proof.get('b13c2') = 'ok: review_needed|Het BTW-percentage is nog niet gekozen. Kies het bij het coderen of in de details van de bankregel op de bankpagina.',
  proof.get('b13') || ' // ' || proof.get('b13c2'));

-- De bulk: 22004 komt met de eigen melding naar buiten; de andere regel boekt gewoon.
SELECT proof.put('b14', proof.call(proof.u(2), format($q$
  SELECT string_agg(format('%%s|%%s|%%s|%%s', ordinal, outcome, coalesce(error_code, '-'), message), E'\n' ORDER BY ordinal)
  FROM public.post_bank_transactions_bulk(ARRAY[%L::uuid, %L::uuid])$q$, proof.uid(1400, 2), proof.uid(1400, 20))));
SELECT proof.record('B14', 'bulk: de regel zonder keuze wordt rejected met 22004 en de eigen, duidelijke melding; de regel met 0 boekt',
  proof.get('b14') = 'ok: '
    || '1|rejected|22004|Het BTW-percentage van deze banktransactie is nog niet gekozen; kies 0 (geen BTW), 9 of 21 procent en boek daarna opnieuw' || E'\n'
    || '2|posted|-|Geboekt in het grootboek.'
  AND proof.marker(proof.uid(1400, 2)) IS NULL
  AND proof.marker(proof.uid(1400, 20)) IS NOT NULL,
  proof.get('b14'));

-- De correctieroute (PR 1/PR 2): een nooit geboekte regel zonder keuze, met keuze, boekt; de bankomschrijving blijft.
SELECT proof.put('b15', proof.rc(proof.u(1), proof.uid(1400, 4), NULL, '00000000-0000-0000-0000-00000000f007', 0,
                                 proof.req(4001), 'P4: keuze gemaakt', 'Boekingsomschrijving P4'));
SELECT proof.put('b15null', proof.rc(proof.u(1), proof.uid(1400, 5), NULL, '00000000-0000-0000-0000-00000000f007', NULL,
                                     proof.req(4002), 'P4: zonder keuze'));
SELECT proof.record('B15', 'reclassify (PR 1/PR 2) werkt op de nieuwe schrijver: met keuze geboekt, bankomschrijving byte-gelijk; zonder keuze de eigen 22004 van PR 1',
  proof.f(proof.get('b15'), 1) = 'posted'
  AND (SELECT description FROM public.bank_transactions WHERE id = proof.uid(1400, 4)) = 'P4 bankregel 4'
  AND (SELECT btw_percentage FROM public.bank_transactions WHERE id = proof.uid(1400, 4)) = 0
  AND proof.p4_lines('bank_transaction', proof.uid(1400, 4)) = '4700:80.00:0.00,1100:0.00:80.00'
  AND (SELECT bool_and(description = 'Boekingsomschrijving P4') FROM public.ledger_postings
       WHERE posting_group_id = proof.marker(proof.uid(1400, 4)))
  AND proof.p4_is_error(proof.get('b15null'), '22004', 'BTW-percentage'),
  concat_ws(' / ', proof.get('b15'), proof.get('b15null')));

SELECT proof.record('B16', 'twee keer boeken kan nog steeds niet (23505, al geboekt)',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 10)), '23505', 'al geboekt'));

-- ══ C — F1c-N1: inkoop bij een btw-vrijgestelde administratie ═══════════════

SELECT proof.put('c1', proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 7)));
SELECT proof.record('C1', 'vrijgesteld met btw: geweigerd (0A000) met een duidelijke uitleg; geen voorbelasting, niets geboekt',
  proof.p4_is_error(proof.get('c1'), '0A000', 'btw-vrijgesteld en kan geen voorbelasting boeken')
  AND position('nog niet besloten' IN proof.get('c1')) > 0
  AND position('42.00' IN proof.get('c1')) > 0
  AND proof.p4_group('purchase_invoice', proof.uid(2400, 7)) IS NULL
  AND proof.p4_ledger_rows(proof.uid(2400, 7)) = 0,
  proof.get('c1'));

SELECT proof.p4_purchase(10, '00000000-0000-0000-0000-0000000000c2', 100.00, 0, 100.00, 0, ARRAY[100.00]);
SELECT proof.put('c2', proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 10)));
SELECT proof.record('C2', 'vrijgesteld zonder btw boekt zoals altijd: kosten debet, crediteur credit, geen regel BTW te vorderen',
  proof.get('c2') LIKE 'ok: %'
  AND proof.p4_lines('purchase_invoice', proof.uid(2400, 10)) = '4700:100.00:0.00,1600:0.00:100.00',
  proof.get('c2') || ' / ' || coalesce(proof.p4_lines('purchase_invoice', proof.uid(2400, 10)), '-'));

SELECT proof.p4_purchase(11, '00000000-0000-0000-0000-0000000000c2', 80.00, NULL, 80.00, NULL, ARRAY[80.00]);
SELECT proof.put('c3', proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 11)));
SELECT proof.record('C3', 'vrijgesteld met btw-bedrag NULL en excl = incl boekt zonder btw',
  proof.p4_lines('purchase_invoice', proof.uid(2400, 11)) = '4700:80.00:0.00,1600:0.00:80.00',
  proof.get('c3'));

SELECT proof.p4_purchase(12, '00000000-0000-0000-0000-0000000000c1', 100.00, 21.00, 121.00, 21, ARRAY[100.00]);
SELECT proof.put('c4', proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 12)));
SELECT proof.record('C4', 'een gewone administratie met 21% boekt ongewijzigd met voorbelasting',
  proof.p4_lines('purchase_invoice', proof.uid(2400, 12)) = '4700:100.00:0.00,1520:21.00:0.00,1600:0.00:121.00',
  proof.get('c4'));

-- D-01: € 100 / € 0 / € 100 met een ontbrekend kop-percentage (OCR).
SELECT proof.p4_purchase(13, '00000000-0000-0000-0000-0000000000c1', 100.00, 0, 100.00, NULL, ARRAY[100.00]);
SELECT proof.put('c5', proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 13)));
SELECT proof.record('C5', 'D-01: € 100 / € 0 / € 100 boekt zonder btw; de server verzint geen 21% en vult het kop-percentage niet in',
  proof.p4_lines('purchase_invoice', proof.uid(2400, 13)) = '4700:100.00:0.00,1600:0.00:100.00'
  AND (SELECT btw_percentage IS NULL FROM public.purchase_invoices WHERE id = proof.uid(2400, 13)),
  proof.get('c5'));

SELECT proof.record('C6', 'de statustoets gaat vóór: vrijgesteld met btw in controle krijgt de statusfout',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 8)), '22023', 'Alleen een gecontroleerde inkoopfactuur'));

SELECT proof.record('C7', 'rol en tenant gaan vóór: organisatie B en read_only krijgen de rechtenfout, niet de btw-uitleg',
  proof.p4_post(proof.u(3), 'post_purchase_invoice', proof.uid(2400, 7)) = 'fout [42501] Geen rechten om te boeken voor deze organisatie |  | '
  AND proof.p4_post(proof.u(4), 'post_purchase_invoice', proof.uid(2400, 7)) = 'fout [42501] Geen rechten om te boeken voor deze organisatie |  | ',
  proof.p4_post(proof.u(3), 'post_purchase_invoice', proof.uid(2400, 7)));

SELECT proof.record('C8', 'twee keer boeken kan nog steeds niet (23505)',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 12)), '23505', 'al geboekt'));

-- ══ D — A3-01: NaN ══════════════════════════════════════════════════════════

SELECT proof.expect_true('D1', 'PostgreSQL: NaN = NaN is waar, NaN > elk getal; x <> NaN is ONWAAR precies voor NaN; NULL laat de CHECK door', $$
  SELECT ('NaN'::numeric = 'NaN'::numeric) AND ('NaN'::numeric > 1e15) AND ('NaN'::numeric >= 0)
     AND NOT ('NaN'::numeric <> 'NaN'::numeric) AND (1::numeric <> 'NaN'::numeric)
     AND ((NULL::numeric <> 'NaN'::numeric) IS NULL)
$$);

SELECT proof.record('D2', 'elke documentschrijver weigert een bestaande NaN-bron (22023): inkoopkop, inkoopregel NaN en oneindig, verkoop',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 4)), '22023', 'Inkoopfactuur heeft een bedrag dat geen getal is (NaN)')
  AND proof.p4_is_error(proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 5)), '22023', 'Inkoopfactuur heeft een bedrag dat geen getal is (NaN)')
  AND proof.p4_is_error(proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 6)), '22023', 'Inkoopfactuur heeft een bedrag dat geen getal is (NaN)')
  AND proof.p4_is_error(proof.p4_post(proof.u(2), 'post_sales_invoice', proof.uid(3400, 1)), '22023', 'Verkoopfactuur heeft een bedrag dat geen getal is')
  AND proof.p4_group('purchase_invoice', proof.uid(2400, 4)) IS NULL
  AND proof.p4_group('purchase_invoice', proof.uid(2400, 5)) IS NULL
  AND proof.p4_group('purchase_invoice', proof.uid(2400, 6)) IS NULL
  AND proof.p4_group('sales_invoice', proof.uid(3400, 1)) IS NULL,
  proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 6)));

-- De CHECK houdt elke NIEUWE NaN tegen, ook buiten de schrijvers om (als eigenaar).
SELECT proof.expect_error('D3a', 'CHECK: geen nieuwe NaN-bankregel',
  $$INSERT INTO public.bank_transactions (id, user_id, client_id, organization_id, transaction_date, amount)
    VALUES (proof.uid(1400, 900), '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1',
            '00000000-0000-0000-0000-00000000a001', DATE '2027-03-01', 'NaN')$$,
  '23514', 'bank_transactions_amount_not_nan');
SELECT proof.expect_error('D3b', 'CHECK: geen nieuwe inkoopfactuur met NaN in btw_amount',
  $$SELECT proof.p4_purchase(901, '00000000-0000-0000-0000-0000000000c1', 100, 'NaN', 121, 21, ARRAY[]::numeric[])$$,
  '23514', 'purchase_invoices_amounts_not_nan');
SELECT proof.expect_error('D3c', 'CHECK: geen nieuwe verkoopfactuur met NaN in amount_incl',
  $$SELECT proof.p4_sales(902, '00000000-0000-0000-0000-0000000000c1', 100, 21, 'NaN', 21)$$,
  '23514', 'sales_invoices_amounts_not_nan');
SELECT proof.expect_error('D3d', 'CHECK: geen nieuwe inkoopregel NaN',
  format('INSERT INTO public.purchase_invoice_lines (purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl) VALUES (%L, %L, %L, ''x'', ''NaN'')',
         proof.uid(2400, 9), '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001'),
  '23514', 'purchase_invoice_lines_amount_finite');
SELECT proof.expect_error('D3e', 'CHECK: geen nieuwe inkoopregel -oneindig',
  format('INSERT INTO public.purchase_invoice_lines (purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl) VALUES (%L, %L, %L, ''x'', ''-Infinity'')',
         proof.uid(2400, 9), '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001'),
  '23514', 'purchase_invoice_lines_amount_finite');
SELECT proof.expect_error('D3f', 'CHECK: geen nieuwe NaN-grootboekregel, ook niet rechtstreeks',
  $$INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency, description, source_type, user_id)
    VALUES ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000f007',
            gen_random_uuid(), 1, DATE '2027-03-01', 2027, 0, 'NaN', 'EUR', 'x', 'proef', '00000000-0000-0000-0000-0000000000e1')$$,
  '23514', 'ledger_postings_amounts_not_nan');
SELECT proof.record('D3', 'de CHECK houdt elke nieuwe NaN tegen: bank, inkoop, verkoop, regel (ook oneindig) en grootboek',
  (SELECT bool_and(ok) AND count(*) = 6 FROM proof.result WHERE n IN ('D3a', 'D3b', 'D3c', 'D3d', 'D3e', 'D3f')));

SELECT proof.expect_error('D4a', 'CHECK: een bestaande rij bijwerken naar NaN kan niet (inkoop)',
  format('UPDATE public.purchase_invoices SET btw_amount = ''NaN'' WHERE id = %L', proof.uid(2400, 9)),
  '23514', 'purchase_invoices_amounts_not_nan');
SELECT proof.expect_error('D4b', 'CHECK: een bestaande rij bijwerken naar NaN kan niet (bank)',
  format('UPDATE public.bank_transactions SET amount = ''NaN'' WHERE id = %L', proof.uid(1400, 5)),
  '23514', 'bank_transactions_amount_not_nan');
SELECT proof.record('D4', 'een bestaande rij kan niet naar NaN worden bijgewerkt',
  (SELECT bool_and(ok) AND count(*) = 2 FROM proof.result WHERE n IN ('D4a', 'D4b')));

SELECT proof.expect_true('D5', 'NULL-bedragen blijven toegestaan (onbekend is geen NaN)', $$
  proof.p4_purchase(903, '00000000-0000-0000-0000-0000000000c1', NULL, NULL, NULL, NULL, ARRAY[]::numeric[]) IS NOT NULL
$$);

-- NOT VALID: de bestaande NaN-rijen staan er nog; VALIDATE loopt erop stuk, en slaagt zodra ze weg zijn.
SELECT proof.expect_error('D6a', 'VALIDATE ledger_postings faalt zolang de bestaande NaN-groep er staat',
  'ALTER TABLE public.ledger_postings VALIDATE CONSTRAINT ledger_postings_amounts_not_nan', '23514', 'ledger_postings_amounts_not_nan');
SELECT proof.expect_error('D6b', 'VALIDATE purchase_invoices faalt',
  'ALTER TABLE public.purchase_invoices VALIDATE CONSTRAINT purchase_invoices_amounts_not_nan', '23514', 'purchase_invoices_amounts_not_nan');
SELECT proof.expect_error('D6c', 'VALIDATE sales_invoices faalt',
  'ALTER TABLE public.sales_invoices VALIDATE CONSTRAINT sales_invoices_amounts_not_nan', '23514', 'sales_invoices_amounts_not_nan');
SELECT proof.expect_error('D6d', 'VALIDATE purchase_invoice_lines faalt',
  'ALTER TABLE public.purchase_invoice_lines VALIDATE CONSTRAINT purchase_invoice_lines_amount_finite', '23514', 'purchase_invoice_lines_amount_finite');
SELECT proof.expect_error('D6e', 'VALIDATE bank_transactions faalt',
  'ALTER TABLE public.bank_transactions VALIDATE CONSTRAINT bank_transactions_amount_not_nan', '23514', 'bank_transactions_amount_not_nan');
DO $$
DECLARE v_ok boolean; v_err text;
BEGIN
  BEGIN
    DELETE FROM public.bank_transactions WHERE amount = 'NaN'::numeric;
    ALTER TABLE public.bank_transactions VALIDATE CONSTRAINT bank_transactions_amount_not_nan;
    SELECT convalidated INTO v_ok FROM pg_constraint WHERE conname = 'bank_transactions_amount_not_nan';
    RAISE EXCEPTION 'terugdraaien' USING ERRCODE = 'P0001';
  EXCEPTION WHEN others THEN
    IF SQLSTATE <> 'P0001' THEN v_err := SQLERRM; END IF;
  END;
  PERFORM proof.record('D6f', 'zonder de NaN-rij slaagt VALIDATE (in een subtransactie die terugrolt)', coalesce(v_ok, false) AND v_err IS NULL, v_err);
END $$;
SELECT proof.record('D6', 'NOT VALID: bestaande NaN-rijen blijven staan en een latere VALIDATE faalt precies tot ze hersteld zijn',
  (SELECT bool_and(ok) AND count(*) = 6 FROM proof.result WHERE n IN ('D6a', 'D6b', 'D6c', 'D6d', 'D6e', 'D6f'))
  AND (SELECT NOT convalidated FROM pg_constraint WHERE conname = 'bank_transactions_amount_not_nan'));

SELECT proof.record('D7', 'Q7 ná de migratie telt exact hetzelfde als ervoor: niets hersteld, niets weggegooid, niets bijgekomen',
  proof.p4_rows(:'pre5') = proof.get('pre5'), proof.p4_rows(:'pre5'));

-- ══ F — A3-16: hele centen ══════════════════════════════════════════════════

SELECT proof.put('f1', proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 9)));
SELECT proof.record('F1', 'regels in fracties van een cent worden geweigerd (22023) met een duidelijke melding; niets geboekt',
  proof.p4_is_error(proof.get('f1'), '22023', '2 boekingsregel(s) met een bedrag in fracties van een cent')
  AND proof.p4_group('purchase_invoice', proof.uid(2400, 9)) IS NULL,
  proof.get('f1'));

SELECT proof.p4_purchase(15, '00000000-0000-0000-0000-0000000000c1', 20.01, 0, 20.01, 0, ARRAY[10.00, 10.01]);
SELECT proof.put('f2', proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 15)));
SELECT proof.record('F2', 'dezelfde factuur in hele centen boekt regel voor regel exact',
  proof.get('f2') LIKE 'ok: %'
  AND proof.p4_lines('purchase_invoice', proof.uid(2400, 15)) = '4700:10.00:0.00,4700:10.01:0.00,1600:0.00:20.01',
  proof.get('f2') || ' / ' || coalesce(proof.p4_lines('purchase_invoice', proof.uid(2400, 15)), '-'));

-- ══ S — verkoop ongewijzigd ═════════════════════════════════════════════════

SELECT proof.p4_sales(2, '00000000-0000-0000-0000-0000000000c1', 100.00, 21.00, 121.00, 21);
SELECT proof.put('s1', proof.p4_post(proof.u(2), 'post_sales_invoice', proof.uid(3400, 2)));
SELECT proof.record('S1', 'verkoop 21% boekt ongewijzigd: debiteur, omzet, BTW te betalen',
  proof.p4_lines('sales_invoice', proof.uid(3400, 2)) = '1300:121.00:0.00,8000:0.00:100.00,1530:0.00:21.00',
  proof.get('s1'));

SELECT proof.p4_sales(3, '00000000-0000-0000-0000-0000000000c1', 100.00, 0, 100.00, 0, 'gecontroleerd', true);
SELECT proof.record('S2', 'verlegde btw blijft geweigerd (0A000)',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_sales_invoice', proof.uid(3400, 3)), '0A000', 'verlegde BTW'));

SELECT proof.record('S3', 'twee keer boeken kan nog steeds niet (23505)',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_sales_invoice', proof.uid(3400, 2)), '23505', 'al geboekt'));

SELECT proof.record('S4', 'tenant en rol ongewijzigd: organisatie B en read_only krijgen de rechtenfout',
  proof.p4_post(proof.u(3), 'post_sales_invoice', proof.uid(3400, 1)) = 'fout [42501] Geen rechten om te boeken voor deze organisatie |  | '
  AND proof.p4_post(proof.u(4), 'post_sales_invoice', proof.uid(3400, 1)) = 'fout [42501] Geen rechten om te boeken voor deze organisatie |  | ',
  proof.p4_post(proof.u(3), 'post_sales_invoice', proof.uid(3400, 1)));

-- ══ H — de boekingsblokkade blijft afgedwongen ══════════════════════════════

SELECT proof.p4_purchase(16, '00000000-0000-0000-0000-0000000000c1', 100.00, 21.00, 121.00, 21, ARRAY[100.00],
                         'gecontroleerd', DATE '2027-01-10');
SELECT proof.record('H1', 'inkoop in een geblokkeerde periode: de blokkadefout (22023)',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 16)), '22023', 'boekingsblokkade'));

SELECT proof.p4_sales(4, '00000000-0000-0000-0000-0000000000c1', 100.00, 21.00, 121.00, 21, 'gecontroleerd', false, DATE '2027-01-10');
SELECT proof.record('H2', 'verkoop in een geblokkeerde periode: de blokkadefout (22023)',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_sales_invoice', proof.uid(3400, 4)), '22023', 'boekingsblokkade'));

-- ══ G — rechten ═════════════════════════════════════════════════════════════

SELECT proof.record('G1', 'anon en service_role kunnen geen van de vijf functies uitvoeren',
  proof.p4_is_error(proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 7), 'anon'), '42501', 'permission denied')
  AND proof.p4_is_error(proof.p4_post(proof.u(2), 'post_sales_invoice', proof.uid(3400, 1), 'anon'), '42501', 'permission denied')
  AND proof.p4_is_error(proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 2), 'anon'), '42501', 'permission denied')
  AND proof.p4_is_error(proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 2), 'service_role'), '42501', 'permission denied')
  AND proof.p4_is_error(proof.p4_post(proof.u(2), 'post_purchase_invoice', proof.uid(2400, 7), 'service_role'), '42501', 'permission denied')
  AND proof.p4_is_error(proof.call(proof.u(2), format('SELECT count(*)::text FROM public.bank_bulk_posting_candidates(%L::uuid, NULL)',
                          '00000000-0000-0000-0000-0000000000c1'), 'anon'), '42501', 'permission denied')
  AND proof.p4_is_error(proof.call(proof.u(2), format('SELECT count(*)::text FROM public.post_bank_transactions_bulk(ARRAY[%L::uuid])',
                          proof.uid(1400, 2)), 'service_role'), '42501', 'permission denied'));

SELECT proof.record('G2', 'de directe schrijfdeur naar het grootboek blijft dicht voor authenticated',
  proof.p4_is_error(proof.call(proof.u(1), $q$INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id,
      posting_group_id, line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, user_id)
    VALUES ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000f007',
            gen_random_uuid(), 1, DATE '2027-03-01', 2027, 1, 0, 'EUR', 'proef', '00000000-0000-0000-0000-0000000000e1')
    RETURNING id::text$q$), '42501', 'permission denied'));
