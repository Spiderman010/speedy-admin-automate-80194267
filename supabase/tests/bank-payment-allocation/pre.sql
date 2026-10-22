-- N — NEGATIEVE CONTROLE: de keten t/m 20261020120000, ZONDER P5a.
-- Throwaway database only.
--
-- Laat zien wat er zonder de betaalschrijver mis kan, en legt de legacy-rijen
-- neer waarvan P5a later moet bewijzen dat hij ze niet aanraakt en ze fail
-- closed behandelt:
--   L1  verkoopfactuur via een oude match betaald (restant 0, betaald, geen koppeling)
--   L2  idem, maar het restant niet bijgewerkt (oude match, restant = totaal)
--   L3  inkoopfactuur met de oude status betaald en een volledige koppeling
--   L4  factuur met een restant dat afwijkt van factuurbedrag − koppelingen
--   L5  banktransactie gecodeerd én gekoppeld
--   L6  oude koppeling van de app (vóór P5a) — created_by blijft leeg

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['N1','N2','N3','N4','N5']);

/** Een koppeling zoals de oude app haar schrijft: rechtstreeks, als authenticated. */
CREATE FUNCTION proof.direct_alloc(_user uuid, _tx uuid, _type text, _inv uuid, _amount numeric)
RETURNS text LANGUAGE sql AS $$
  SELECT proof.call(_user, format(
    'INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
     SELECT bt.id, %L, %L::uuid, bt.client_id, %L::numeric, bt.user_id FROM public.bank_transactions bt WHERE bt.id = %L::uuid
     RETURNING id::text', _type, _inv, _amount, _tx));
$$;
GRANT EXECUTE ON FUNCTION proof.direct_alloc(uuid, uuid, text, uuid, numeric) TO public;

SELECT proof.expect_true('N1', 'zonder P5a bestaat de betaalschrijver niet',
  $$to_regprocedure('public.link_bank_payment(uuid,text,uuid,numeric,uuid)') IS NULL
    AND to_regprocedure('public.unlink_bank_payment(uuid,uuid,uuid)') IS NULL$$);

-- N2: twee directe koppelingen van 80 op een factuur van 100 worden beide aanvaard.
SELECT proof.tx(50, 80.00), proof.tx(51, 80.00), proof.sinv(50, 100.00);
SELECT proof.put('n2a', proof.direct_alloc(proof.u(1), proof.uid(1000, 50), 'verkoop', proof.uid(3000, 50), 80));
SELECT proof.put('n2b', proof.direct_alloc(proof.u(1), proof.uid(1000, 51), 'verkoop', proof.uid(3000, 50), 80));
SELECT proof.record('N2', 'zonder P5a: twee koppelingen van 80 op een factuur van 100 worden aanvaard (over-allocatie)',
  proof.get('n2a') LIKE 'ok:%' AND proof.get('n2b') LIKE 'ok:%'
  AND (SELECT sum(amount) FROM public.bank_transaction_allocations WHERE invoice_id = proof.uid(3000, 50)) = 160,
  proof.get('n2b'));

-- N3: een koppeling op een afgewezen paar wordt aanvaard.
SELECT proof.tx(52, 40.00), proof.sinv(52, 40.00);
SELECT proof.put('n3r', proof.call(proof.u(1), format(
  'INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id) VALUES (%L, ''verkoop'', %L) RETURNING id::text',
  proof.uid(1000, 52), proof.uid(3000, 52))));
SELECT proof.put('n3a', proof.direct_alloc(proof.u(1), proof.uid(1000, 52), 'verkoop', proof.uid(3000, 52), 40));
SELECT proof.record('N3', 'zonder P5a: een koppeling op een afgewezen paar wordt aanvaard',
  proof.get('n3r') LIKE 'ok:%' AND proof.get('n3a') LIKE 'ok:%', proof.get('n3a'));

-- N4: een geboekte verkoopfactuur kan nooit meer van betaald terug, ook niet bij ontkoppelen.
SELECT proof.sinv(53, 70.00, 'gecontroleerd', true);
UPDATE public.sales_invoices SET status = 'betaald', remaining_amount = 0 WHERE id = proof.uid(3000, 53);
SELECT proof.put('n4', proof.call(proof.u(6), format(
  'UPDATE public.sales_invoices SET status = ''gecontroleerd'', remaining_amount = 70 WHERE id = %L RETURNING id::text',
  proof.uid(3000, 53))));
SELECT proof.record('N4', 'zonder P5a: betaald → gecontroleerd op een geboekte verkoopfactuur is voor iedereen geweigerd',
  proof.refused(proof.get('n4'), '42501', 'alleen nog van gecontroleerd naar betaald'), proof.get('n4'));

-- ── legacy-rijen (blijven tot het eind staan) ──
-- L1: oude match, factuur betaald zonder koppeling.
SELECT proof.tx(60, 120.00), proof.sinv(60, 120.00);
UPDATE public.sales_invoices SET status = 'betaald', remaining_amount = 0 WHERE id = proof.uid(3000, 60);
UPDATE public.bank_transactions SET match_status = 'gematcht', matched_invoice_id = proof.uid(3000, 60), match_confidence = 100
WHERE id = proof.uid(1000, 60);
-- L2: oude match, restant niet bijgewerkt.
SELECT proof.tx(61, 90.00), proof.sinv(61, 90.00);
UPDATE public.bank_transactions SET match_status = 'gematcht', matched_invoice_id = proof.uid(3000, 61), match_confidence = 100
WHERE id = proof.uid(1000, 61);
-- L3: inkoop met de oude status betaald en een volledige koppeling.
SELECT proof.tx(62, -75.00), proof.pinv(62, 75.00);
SELECT proof.direct_alloc(proof.u(1), proof.uid(1000, 62), 'inkoop', proof.uid(2000, 62), 75);
UPDATE public.purchase_invoices SET status = 'betaald', remaining_amount = 0 WHERE id = proof.uid(2000, 62);
UPDATE public.bank_transactions SET match_status = 'gematcht', matched_invoice_id = proof.uid(2000, 62), match_confidence = 100
WHERE id = proof.uid(1000, 62);
-- L4: restant wijkt af (koppeling 30 op 100, restant 55).
SELECT proof.tx(63, 30.00), proof.tx(64, 50.00), proof.sinv(63, 100.00);
SELECT proof.direct_alloc(proof.u(1), proof.uid(1000, 63), 'verkoop', proof.uid(3000, 63), 30);
UPDATE public.sales_invoices SET remaining_amount = 55 WHERE id = proof.uid(3000, 63);
UPDATE public.bank_transactions SET match_status = 'gematcht', matched_invoice_id = proof.uid(3000, 63), match_confidence = 100
WHERE id = proof.uid(1000, 63);
-- L5: gecodeerd én gekoppeld.
SELECT proof.tx(65, 45.00), proof.sinv(65, 45.00);
SELECT proof.direct_alloc(proof.u(1), proof.uid(1000, 65), 'verkoop', proof.uid(3000, 65), 45);
UPDATE public.sales_invoices SET remaining_amount = 0 WHERE id = proof.uid(3000, 65);
UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = proof.acct(7)
WHERE id = proof.uid(1000, 65);
-- L6: een gewone oude koppeling, consistent bijgewerkt door de oude app.
SELECT proof.tx(66, 25.00), proof.sinv(66, 100.00);
SELECT proof.direct_alloc(proof.u(1), proof.uid(1000, 66), 'verkoop', proof.uid(3000, 66), 25);
UPDATE public.sales_invoices SET remaining_amount = 75 WHERE id = proof.uid(3000, 66);
UPDATE public.bank_transactions SET match_status = 'gematcht', matched_invoice_id = proof.uid(3000, 66), match_confidence = 100
WHERE id = proof.uid(1000, 66);

SELECT proof.record('N5', 'legacy-rijen L1–L6 liggen klaar (zes transacties, vier koppelingen)',
  (SELECT count(*) FROM public.bank_transactions WHERE id IN (proof.uid(1000,60), proof.uid(1000,61), proof.uid(1000,62),
                                                              proof.uid(1000,63), proof.uid(1000,65), proof.uid(1000,66))) = 6
  AND (SELECT count(*) FROM public.bank_transaction_allocations
       WHERE bank_transaction_id IN (proof.uid(1000,62), proof.uid(1000,63), proof.uid(1000,65), proof.uid(1000,66))) = 4);
