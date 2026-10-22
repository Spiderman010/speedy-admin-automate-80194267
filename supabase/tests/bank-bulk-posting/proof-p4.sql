-- FASE 2 — de bulklaag zoals zij NU is (20261021170000), op de volledige keten
-- — THROWAWAY cluster only. Zie run-proof.sh.
--
-- Fase 1 zaaide regels zonder btw-keuze (NULL) als gewone "geen BTW"-regels;
-- de preflight noemde ze 'ready' en de schrijver boekte ze stil als 0% (bug
-- E-06). Hier de sterkere vervanging, op de huidige preflight en schrijver:
-- zo'n regel is 'review_needed' met de reden die de app toont, wordt in een
-- partij geweigerd met 22004 en de eigen melding, en houdt de rest van de
-- partij niet tegen. Alles wat 'ready' heet, boekt ook werkelijk.
--
-- Draait na ../writer-vat-nan-validation/build-chain.sh, diens helpers.sql en
-- de migratie 20261021170000.

SELECT proof.plan(ARRAY['P4-B1', 'P4-B2', 'P4-B3', 'P4-B4', 'P4-B5']);

SELECT proof.p4_tx(301, -30.00, NULL);                                                       -- gecodeerd, geen keuze
SELECT proof.p4_tx(302, -40.00, 0);                                                          -- gecodeerd, "Geen BTW"
SELECT proof.p4_tx(303, -121.00, 21);                                                        -- gecodeerd, 21%
SELECT proof.p4_tx(304, -50.00, NULL, '00000000-0000-0000-0000-0000000000c1', DATE '2027-03-01', 'handmatig_geboekt', NULL);  -- geen rekening
SELECT proof.p4_tx(305, -60.00, NULL, '00000000-0000-0000-0000-0000000000c1', DATE '2027-03-01', 'niet_gematcht');           -- niet gecodeerd
SELECT proof.p4_tx(306, -70.00, NULL, '00000000-0000-0000-0000-0000000000c2');               -- vrijgesteld, geen keuze
SELECT proof.p4_tx(307, -80.00, 0, '00000000-0000-0000-0000-0000000000c2');                  -- vrijgesteld, "Geen BTW"

SELECT proof.put('b1', proof.call(proof.u(2), format($q$
  SELECT string_agg(format('%%s=%%s|%%s', right(transaction_id::text, 3), workflow_state, coalesce(reason, '')), E'\n' ORDER BY transaction_id)
  FROM public.bank_bulk_posting_candidates(%L::uuid, NULL)$q$, '00000000-0000-0000-0000-0000000000c1')));
SELECT proof.record('P4-B1', 'preflight: zonder keuze review_needed met de reden van de app; eerdere armen gaan voor; 0 en 21 zijn ready',
  proof.get('b1') = 'ok: '
    || '301=review_needed|Het BTW-percentage is nog niet gekozen. Kies het bij het coderen of in de details van de bankregel op de bankpagina.' || E'\n'
    || '302=ready|' || E'\n'
    || '303=ready|' || E'\n'
    || '304=review_needed|Deze banktransactie heeft nog geen grootboekrekening.' || E'\n'
    || '305=review_needed|Status is niet_gematcht; alleen handmatig gecodeerde banktransacties kunnen zo geboekt worden.',
  proof.get('b1'));

SELECT proof.put('b2', proof.call(proof.u(2), format(
  'SELECT string_agg(right(transaction_id::text, 3) || ''='' || workflow_state, '','' ORDER BY transaction_id) FROM public.bank_bulk_posting_candidates(%L::uuid, NULL)',
  '00000000-0000-0000-0000-0000000000c2')));
SELECT proof.record('P4-B2', 'ook bij een vrijgestelde administratie: zonder keuze review_needed, met "Geen BTW" ready',
  proof.get('b2') = 'ok: 306=review_needed,307=ready', proof.get('b2'));

-- Een partij met een regel zonder keuze ertussen.
SELECT proof.put('b3', proof.call(proof.u(2), format($q$
  SELECT string_agg(format('%%s|%%s|%%s|%%s', ordinal, outcome, coalesce(error_code, '-'), message), E'\n' ORDER BY ordinal)
  FROM public.post_bank_transactions_bulk(ARRAY[%L::uuid, %L::uuid, %L::uuid])$q$,
  proof.uid(1400, 302), proof.uid(1400, 301), proof.uid(1400, 303))));
SELECT proof.record('P4-B3', 'bulk: de regel zonder keuze rejected met 22004 en de eigen melding; de rest van de partij boekt gewoon',
  proof.get('b3') = 'ok: '
    || '1|posted|-|Geboekt in het grootboek.' || E'\n'
    || '2|rejected|22004|Het BTW-percentage van deze banktransactie is nog niet gekozen; kies 0 (geen BTW), 9 of 21 procent en boek daarna opnieuw' || E'\n'
    || '3|posted|-|Geboekt in het grootboek.'
  AND proof.marker(proof.uid(1400, 301)) IS NULL
  AND proof.p4_lines('bank_transaction', proof.uid(1400, 302)) = '4700:40.00:0.00,1100:0.00:40.00'
  AND proof.p4_lines('bank_transaction', proof.uid(1400, 303)) = '4700:100.00:0.00,1520:21.00:0.00,1100:0.00:121.00',
  proof.get('b3'));

SELECT proof.record('P4-B4', 'na de partij staat de regel zonder keuze nog steeds ongeboekt en review_needed',
  proof.call(proof.u(2), format(
    'SELECT workflow_state FROM public.bank_bulk_posting_candidates(%L::uuid, NULL) WHERE transaction_id = %L::uuid',
    '00000000-0000-0000-0000-0000000000c1', proof.uid(1400, 301))) = 'ok: review_needed');

-- Alles wat 'ready' heet, boekt ook: de vrijgestelde "Geen BTW"-regel via de bulk.
SELECT proof.put('b5', proof.call(proof.u(2), format(
  'SELECT string_agg(outcome, '','' ORDER BY ordinal) FROM public.post_bank_transactions_bulk(ARRAY[%L::uuid])', proof.uid(1400, 307))));
SELECT proof.record('P4-B5', 'een ready-regel boekt ook werkelijk (vrijgesteld, "Geen BTW": bruto zonder btw)',
  proof.get('b5') = 'ok: posted'
  AND proof.p4_lines('bank_transaction', proof.uid(1400, 307)) = '4700:80.00:0.00,1100:0.00:80.00',
  proof.get('b5'));
