-- L — TWEE (OF DRIE) ECHTE SESSIES, via dblink. Throwaway database only.
--
-- Elke race: sessie a houdt een open transactie (en dus haar grendels), sessie
-- b (en c) start de botsende aanroep asynchroon; we wachten tot b aantoonbaar
-- op een grendel wacht, committen a en lezen dan b. Geen enkele uitkomst mag
-- een deadlock (40P01) of een time-out zijn; na afloop gelden de invarianten.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['L1','L2','L3','L4','L5','L6','L7','L8','L9','L10','L11','L12','L13','L14','L15','L16','L17','L18']);

/** Sessie _name werkt voortaan als _user met de rol authenticated. */
CREATE FUNCTION proof.as_user(_name text, _user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM proof.remote_exec(_name, 'RESET ROLE');
  PERFORM * FROM dblink(_name, format($q$SELECT set_config('test.user_id', %L, false)$q$, _user)) AS t(x text);
  PERFORM proof.remote_exec(_name, 'SET ROLE authenticated');
END $$;

/** Start _sql asynchroon in sessie _name. */
CREATE FUNCTION proof.send(_name text, _sql text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dblink_send_query(_name, _sql);
END $$;

CREATE FUNCTION proof.lsql(_tx uuid, _type text, _inv uuid, _amount numeric, _req uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT format('SELECT format(''%%s|%%s|%%s'', outcome, invoice_remaining, replayed) FROM public.link_bank_payment(%L, %L, %L, %L, %L)',
                _tx, _type, _inv, _amount, _req);
$$;
CREATE FUNCTION proof.usql(_tx uuid, _req uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT format('SELECT format(''%%s|%%s'', outcome, removed_count) FROM public.unlink_bank_payment(%L, %L)', _tx, _req);
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

SELECT proof.open_session('a', :'conn');
SELECT proof.open_session('b', :'conn');
SELECT proof.open_session('c', :'conn');

-- ── L1: 600 + 400 + 100 op een factuur van 1000, drie transacties tegelijk ──
SELECT proof.tx(1100, 600.00), proof.tx(1101, 400.00), proof.tx(1102, 100.00), proof.sinv(1100, 1000.00);
SELECT proof.as_user('a', proof.u(6)), proof.as_user('b', proof.u(6)), proof.as_user('c', proof.u(6));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l1a', proof.remote_run('a', proof.lsql(proof.uid(1000, 1100), 'verkoop', proof.uid(3000, 1100), 600, proof.req(1100))));
SELECT proof.send('b', proof.lsql(proof.uid(1000, 1101), 'verkoop', proof.uid(3000, 1100), 400, proof.req(1101)));
SELECT proof.put('l1wb', proof.until_waiting('b'));
SELECT proof.send('c', proof.lsql(proof.uid(1000, 1102), 'verkoop', proof.uid(3000, 1100), 100, proof.req(1102)));
SELECT proof.put('l1wc', proof.until_waiting('c'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l1b', proof.remote_outcome('b'));
SELECT proof.put('l1c', proof.remote_outcome('c'));
SELECT proof.record('L1', '600 + 400 + 100 op 1000 tegelijk: b en c wachten op de factuurgrendel; precies één geweigerd (23514), Σ ≤ 1000 en het restant sluit aan',
  proof.get('l1a') LIKE 'ok: created|400.00|%' AND proof.get('l1wb') <> 'none' AND proof.get('l1wc') <> 'none'
  AND ((proof.get('l1b') LIKE 'ok: created|%') :: int + (proof.get('l1c') LIKE 'ok: created|%') :: int) = 1
  AND (proof.get('l1b') LIKE 'fout [23514]%factuurbedrag%' OR proof.get('l1c') LIKE 'fout [23514]%factuurbedrag%')
  AND (SELECT sum(amount) FROM public.bank_transaction_allocations WHERE invoice_id = proof.uid(3000, 1100)) <= 1000
  AND proof.writer_violations() = 0,
  proof.get('l1b') || ' / ' || proof.get('l1c'));

-- ── L2: één transactie van 1000 tegelijk op twee facturen van 700 ──
SELECT proof.tx(1103, 1000.00), proof.sinv(1103, 700.00), proof.sinv(1104, 700.00);
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l2a', proof.remote_run('a', proof.lsql(proof.uid(1000, 1103), 'verkoop', proof.uid(3000, 1103), 700, proof.req(1103))));
SELECT proof.send('b', proof.lsql(proof.uid(1000, 1103), 'verkoop', proof.uid(3000, 1104), 700, proof.req(1104)));
SELECT proof.put('l2w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l2b', proof.remote_outcome('b'));
SELECT proof.record('L2', 'één transactie tegelijk op twee facturen (700 + 700 > 1000): b wacht op de transactiegrendel en wordt geweigerd; Σ(T) ≤ |T|',
  proof.get('l2a') LIKE 'ok: created|%' AND proof.get('l2w') <> 'none' AND proof.get('l2b') LIKE 'fout [23514]%transactiebedrag%'
  AND (SELECT sum(amount) FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 1103)) = 700,
  proof.get('l2b'));

-- ── L3/L4: geen deadlock tegen post_bank_allocation, in beide volgordes ──
SELECT proof.tx(1105, 100.00), proof.sinv(1105, 60.00, 'gecontroleerd', true), proof.sinv(1106, 40.00);
SELECT proof.put('l3l', proof.link(proof.u(6), proof.uid(1000, 1105), 'verkoop', proof.uid(3000, 1105), 60, proof.req(1105)));
SELECT proof.as_user('a', proof.u(1));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l3p', proof.remote_run('a', format('SELECT public.post_bank_allocation(%L)::text', proof.f(proof.get('l3l'), 1))));
SELECT proof.send('b', proof.lsql(proof.uid(1000, 1105), 'verkoop', proof.uid(3000, 1106), 40, proof.req(1106)));
SELECT proof.put('l3w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l3b', proof.remote_outcome('b'));
SELECT proof.record('L3', 'post_bank_allocation houdt A → T; link op dezelfde transactie wacht en slaagt daarna (geen deadlock)',
  proof.get('l3p') LIKE 'ok: %' AND proof.get('l3w') <> 'none' AND proof.get('l3b') LIKE 'ok: created|%', proof.get('l3b'));

SELECT proof.tx(1107, 100.00), proof.sinv(1107, 60.00, 'gecontroleerd', true), proof.sinv(1108, 40.00);
SELECT proof.put('l4l', proof.link(proof.u(6), proof.uid(1000, 1107), 'verkoop', proof.uid(3000, 1107), 60, proof.req(1107)));
SELECT proof.as_user('a', proof.u(6)), proof.as_user('b', proof.u(1));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l4a', proof.remote_run('a', proof.lsql(proof.uid(1000, 1107), 'verkoop', proof.uid(3000, 1108), 40, proof.req(1108))));
SELECT proof.send('b', format('SELECT public.post_bank_allocation(%L)::text', proof.f(proof.get('l4l'), 1)));
SELECT proof.put('l4w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l4b', proof.remote_outcome('b'));
SELECT proof.record('L4', 'link houdt T; post_bank_allocation (A → T) wacht en boekt daarna (geen deadlock)',
  proof.get('l4a') LIKE 'ok: created|%' AND proof.get('l4w') <> 'none' AND proof.get('l4b') LIKE 'ok: %'
  AND EXISTS (SELECT 1 FROM public.bank_allocation_postings WHERE allocation_id = proof.f(proof.get('l4l'), 1)::uuid),
  proof.get('l4b'));

-- ── L5/L6: unlink tegen post_bank_allocation, in beide volgordes ──
SELECT proof.tx(1109, 50.00), proof.sinv(1109, 50.00, 'gecontroleerd', true);
SELECT proof.put('l5l', proof.link(proof.u(6), proof.uid(1000, 1109), 'verkoop', proof.uid(3000, 1109), 50, proof.req(1109)));
SELECT proof.as_user('a', proof.u(1)), proof.as_user('b', proof.u(6));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l5p', proof.remote_run('a', format('SELECT public.post_bank_allocation(%L)::text', proof.f(proof.get('l5l'), 1))));
SELECT proof.send('b', proof.usql(proof.uid(1000, 1109), proof.req(1110)));
SELECT proof.put('l5w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l5b', proof.remote_outcome('b'));
SELECT proof.record('L5', 'post_bank_allocation eerst; unlink wacht op de koppeling en weigert daarna de geboekte aflettering (23514), geen deadlock',
  proof.get('l5w') <> 'none' AND proof.get('l5b') LIKE 'fout [23514]%aflettering%', proof.get('l5b'));

SELECT proof.tx(1111, 50.00), proof.sinv(1111, 50.00, 'gecontroleerd', true);
SELECT proof.put('l6l', proof.link(proof.u(6), proof.uid(1000, 1111), 'verkoop', proof.uid(3000, 1111), 50, proof.req(1111)));
SELECT proof.as_user('a', proof.u(6)), proof.as_user('b', proof.u(1));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l6a', proof.remote_run('a', proof.usql(proof.uid(1000, 1111), proof.req(1112))));
SELECT proof.send('b', format('SELECT public.post_bank_allocation(%L)::text', proof.f(proof.get('l6l'), 1)));
SELECT proof.put('l6w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l6b', proof.remote_outcome('b'));
SELECT proof.record('L6', 'unlink eerst; post_bank_allocation wacht en vindt daarna geen koppeling meer (P0002), geen deadlock, geen boeking',
  proof.get('l6a') = 'ok: unlinked|1' AND proof.get('l6w') <> 'none' AND proof.get('l6b') LIKE 'fout [P0002]%'
  AND NOT EXISTS (SELECT 1 FROM public.ledger_postings WHERE source_type = 'bank_allocation' AND source_id = proof.f(proof.get('l6l'), 1)::uuid),
  proof.get('l6b'));

-- ── L7: de oude app (directe INSERT) tegen de betaalschrijver, hetzelfde paar ──
SELECT proof.tx(1113, 50.00), proof.sinv(1113, 50.00);
SELECT proof.as_user('a', proof.u(6)), proof.as_user('b', proof.u(1));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l7a', proof.remote_run('a', proof.lsql(proof.uid(1000, 1113), 'verkoop', proof.uid(3000, 1113), 50, proof.req(1113))));
SELECT proof.send('b', format(
  'INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
   SELECT id, ''verkoop'', %L, client_id, 50, user_id FROM public.bank_transactions WHERE id = %L RETURNING id::text',
  proof.uid(3000, 1113), proof.uid(1000, 1113)));
SELECT proof.put('l7w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l7b', proof.remote_outcome('b'));
SELECT proof.record('L7', 'directe INSERT van hetzelfde paar wacht vóór de unieke index (guard-grendel) en krijgt daarna 23505 — geen deadlock, één koppeling',
  proof.get('l7a') LIKE 'ok: created|%' AND proof.get('l7w') <> 'none' AND proof.get('l7b') LIKE 'fout [23505]%'
  AND (SELECT count(*) FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 1113)) = 1,
  proof.get('l7b'));

-- ── L8/L9: afwijzing tegen koppeling, in beide volgordes (A1-24) ──
SELECT proof.tx(1114, 30.00), proof.sinv(1114, 30.00);
SELECT proof.as_user('a', proof.u(6)), proof.as_user('b', proof.u(1));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l8a', proof.remote_run('a', proof.lsql(proof.uid(1000, 1114), 'verkoop', proof.uid(3000, 1114), 30, proof.req(1114))));
SELECT proof.send('b', format(
  'INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id) VALUES (%L, ''verkoop'', %L) RETURNING id::text',
  proof.uid(1000, 1114), proof.uid(3000, 1114)));
SELECT proof.put('l8w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l8b', proof.remote_outcome('b'));
SELECT proof.record('L8', 'koppeling eerst; een gelijktijdige afwijzing van hetzelfde paar wacht en wordt daarna geweigerd (23514) — de scopetrigger zag de koppeling niet',
  proof.get('l8w') <> 'none' AND proof.get('l8b') LIKE 'fout [23514]%ontkoppel eerst%'
  AND NOT EXISTS (SELECT 1 FROM public.bank_match_rejections WHERE bank_transaction_id = proof.uid(1000, 1114)),
  proof.get('l8b'));

SELECT proof.tx(1115, 30.00), proof.sinv(1115, 30.00);
SELECT proof.as_user('a', proof.u(1)), proof.as_user('b', proof.u(6));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l9a', proof.remote_run('a', format(
  'INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id) VALUES (%L, ''verkoop'', %L) RETURNING id::text',
  proof.uid(1000, 1115), proof.uid(3000, 1115))));
SELECT proof.send('b', proof.lsql(proof.uid(1000, 1115), 'verkoop', proof.uid(3000, 1115), 30, proof.req(1115)));
SELECT proof.put('l9w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l9b', proof.remote_outcome('b'));
SELECT proof.record('L9', 'afwijzing eerst; een gelijktijdige koppeling wacht en wordt daarna geweigerd (23514)',
  proof.get('l9a') LIKE 'ok:%' AND proof.get('l9w') <> 'none' AND proof.get('l9b') LIKE 'fout [23514]%afgewezen%'
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 1115)),
  proof.get('l9b'));

-- ── L10: unlink tegen een gelijktijdige nieuwe koppeling op dezelfde transactie ──
SELECT proof.tx(1116, 100.00), proof.sinv(1116, 50.00), proof.sinv(1117, 50.00);
SELECT proof.link(proof.u(6), proof.uid(1000, 1116), 'verkoop', proof.uid(3000, 1116), 50, proof.req(1116));
SELECT proof.as_user('a', proof.u(6)), proof.as_user('b', proof.u(6));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l10a', proof.remote_run('a', proof.lsql(proof.uid(1000, 1116), 'verkoop', proof.uid(3000, 1117), 50, proof.req(1117))));
SELECT proof.send('b', proof.usql(proof.uid(1000, 1116), proof.req(1118)));
SELECT proof.put('l10w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l10b', proof.remote_outcome('b'));
SELECT proof.record('L10', 'unlink grendelt de bestaande koppeling, wacht op T; er kwam een koppeling bij → 55000 (geen grendel ná T, geen deadlock)',
  proof.get('l10a') LIKE 'ok: created|%' AND proof.get('l10w') <> 'none' AND proof.get('l10b') LIKE 'fout [55000]%'
  AND (SELECT count(*) FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 1116)) = 2,
  proof.get('l10b'));

-- ── L11: dezelfde request_id tegelijk: de tweede krijgt het antwoord van de eerste ──
SELECT proof.tx(1119, 25.00), proof.sinv(1119, 25.00);
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l11a', proof.remote_run('a', proof.lsql(proof.uid(1000, 1119), 'verkoop', proof.uid(3000, 1119), 25, proof.req(1119))));
SELECT proof.send('b', proof.lsql(proof.uid(1000, 1119), 'verkoop', proof.uid(3000, 1119), 25, proof.req(1119)));
SELECT proof.put('l11w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l11b', proof.remote_outcome('b'));
SELECT proof.record('L11', 'een gelijktijdige herhaling (zelfde actor, request_id en argumenten) wacht en krijgt het opgeslagen antwoord (replayed)',
  proof.get('l11a') = 'ok: created|0.00|f' AND proof.get('l11w') <> 'none' AND proof.get('l11b') = 'ok: created|0.00|t'
  AND (SELECT count(*) FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 1119)) = 1,
  proof.get('l11b'));

-- ── L12/L13: correctie-RPC tegen koppeling, in beide volgordes ──
SELECT proof.tx(1120, -121.00), proof.pinv(1120, 121.00);
SELECT proof.as_user('a', proof.u(2)), proof.as_user('b', proof.u(2));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l12a', proof.remote_run('a', proof.lsql(proof.uid(1000, 1120), 'inkoop', proof.uid(2000, 1120), 121, proof.req(1120))));
SELECT proof.send('b', format(
  'SELECT outcome FROM public.reclassify_bank_transaction(%L::uuid, NULL::uuid, %L::uuid, 21::numeric, %L::uuid, NULL::text, NULL::text)',
  proof.uid(1000, 1120), proof.acct(6), proof.req(1121)));
SELECT proof.put('l12w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l12b', proof.remote_outcome('b'));
SELECT proof.record('L12', 'koppeling eerst; een gelijktijdige herclassificatie wacht en weigert daarna (22023)',
  proof.get('l12a') LIKE 'ok: created|%' AND proof.get('l12w') <> 'none' AND proof.get('l12b') LIKE 'fout [22023]%gekoppeld%',
  proof.get('l12b'));

SELECT proof.tx(1122, -121.00), proof.pinv(1122, 121.00);
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l13a', proof.remote_run('a', format(
  'SELECT outcome FROM public.reclassify_bank_transaction(%L::uuid, NULL::uuid, %L::uuid, 21::numeric, %L::uuid, NULL::text, NULL::text)',
  proof.uid(1000, 1122), proof.acct(6), proof.req(1122))));
SELECT proof.send('b', proof.lsql(proof.uid(1000, 1122), 'inkoop', proof.uid(2000, 1122), 121, proof.req(1123)));
SELECT proof.put('l13w', proof.until_waiting('b'));
SELECT proof.remote_exec('a', 'COMMIT');
SELECT proof.put('l13b', proof.remote_outcome('b'));
SELECT proof.record('L13', 'herclassificatie (directe boeking) eerst; een gelijktijdige koppeling wacht en weigert daarna (23514)',
  proof.get('l13a') = 'ok: posted' AND proof.get('l13w') <> 'none' AND proof.get('l13b') LIKE 'fout [23514]%rechtstreeks%',
  proof.get('l13b'));

-- ── L14: twee directe over-allocaties van de oude app tegelijk (vangnet bij COMMIT) ──
SELECT proof.tx(1124, 80.00), proof.tx(1125, 80.00), proof.sinv(1124, 100.00);
SELECT proof.as_user('a', proof.u(1)), proof.as_user('b', proof.u(1));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l14a', proof.remote_run('a', format(
  'INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
   SELECT id, ''verkoop'', %L, client_id, 80, user_id FROM public.bank_transactions WHERE id = %L RETURNING id::text',
  proof.uid(3000, 1124), proof.uid(1000, 1124))));
SELECT proof.put('l14b', proof.remote_exec('b', format(
  'INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
   SELECT id, ''verkoop'', %L, client_id, 80, user_id FROM public.bank_transactions WHERE id = %L',
  proof.uid(3000, 1124), proof.uid(1000, 1125))));
SELECT proof.put('l14c', proof.remote_exec('a', 'COMMIT'));
SELECT proof.record('L14', 'twee gelijktijdige directe koppelingen van 80 op 100: b commit eerst, a''s COMMIT ziet daarna 160 en weigert (23514) — zonder P5a beide aanvaard (N2)',
  proof.get('l14a') LIKE 'ok:%' AND proof.get('l14b') = 'ok' AND proof.get('l14c') LIKE 'fout [23514]%factuurbedrag%'
  AND (SELECT sum(amount) FROM public.bank_transaction_allocations WHERE invoice_id = proof.uid(3000, 1124)) = 80,
  proof.get('l14c'));
SELECT proof.remote_exec('a', 'ROLLBACK');

-- ── L16: upsert van de oude app (INSERT … ON CONFLICT DO UPDATE) tegen link op hetzelfde bestaande paar ──
-- c houdt T vast (FOR SHARE). b (oude app) doet de upsert: de guard grendelt
-- eerst de bestaande paar-rij, dan T (wacht op c). a (betaalschrijver) wil
-- dezelfde paar-rij (A → T) en wacht op b. c commit: b en a lopen na elkaar af.
-- Zonder de A-grendel in de guard: b houdt T en wacht op A, a houdt A en wacht
-- op T → 40P01 (review P5-DB §2).
SELECT proof.tx(1126, 50.00), proof.sinv(1126, 100.00);
SELECT proof.put('l16s', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 1126), 'verkoop', proof.uid(3000, 1126), 50));
SELECT proof.as_user('a', proof.u(6)), proof.as_user('b', proof.u(1));
SELECT proof.remote_exec('c', 'RESET ROLE');
SELECT proof.remote_exec('c', 'BEGIN');
SELECT proof.put('l16c', proof.remote_run('c', format('SELECT id::text FROM public.bank_transactions WHERE id = %L FOR SHARE', proof.uid(1000, 1126))));
SELECT proof.send('b', format(
  'INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
   SELECT id, ''verkoop'', %L, client_id, 50, user_id FROM public.bank_transactions WHERE id = %L
   ON CONFLICT (bank_transaction_id, invoice_id) DO UPDATE SET amount = EXCLUDED.amount RETURNING id::text',
  proof.uid(3000, 1126), proof.uid(1000, 1126)));
SELECT proof.put('l16wb', proof.until_waiting('b'));
SELECT proof.send('a', proof.lsql(proof.uid(1000, 1126), 'verkoop', proof.uid(3000, 1126), 50, proof.req(1126)));
SELECT proof.put('l16wa', proof.until_waiting('a'));
SELECT proof.remote_exec('c', 'COMMIT');
SELECT proof.put('l16b', proof.remote_outcome('b'));
SELECT proof.put('l16a', proof.remote_outcome('a'));
SELECT proof.record('L16', 'upsert (ON CONFLICT DO UPDATE) van de oude app en link op hetzelfde bestaande paar, met T bezet: beide wachten, geen deadlock (40P01); één koppeling',
  proof.get('l16s') LIKE 'ok:%' AND proof.get('l16c') LIKE 'ok:%' AND proof.get('l16wb') <> 'none' AND proof.get('l16wa') <> 'none'
  AND proof.get('l16b') NOT LIKE 'fout [40P01]%' AND proof.get('l16a') NOT LIKE 'fout [40P01]%'
  AND (SELECT count(*) FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 1126)) = 1,
  proof.get('l16b') || ' / ' || proof.get('l16a'));

-- ── L17/L18: vervalst schrijversbewijs ná een legitieme aanroep, onder alleen
-- P5a (geen factuurguard): pas de controle bij COMMIT houdt het tegen (review P5-DB §1).
-- L17 (G1): inkoop 100, koppelingen 40 + 30; ontkoppel 40, vlag met de hand, bedrag onder Σ.
SELECT proof.pinv(1127, 100.00), proof.tx(1127, -40.00), proof.tx(1128, -30.00);
SELECT proof.put('l17l1', proof.link(proof.u(6), proof.uid(1000, 1127), 'inkoop', proof.uid(2000, 1127), 40, proof.req(1127)));
SELECT proof.put('l17l2', proof.link(proof.u(6), proof.uid(1000, 1128), 'inkoop', proof.uid(2000, 1127), 30, proof.req(1128)));
SELECT proof.as_user('a', proof.u(6));
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l17u', proof.remote_run('a', proof.usql(proof.uid(1000, 1127), proof.req(11270))));
SELECT proof.put('l17f', proof.remote_run('a', 'SELECT set_config(''boekassist.betaalschrijver'', pg_current_xact_id()::text, true)'));
SELECT proof.put('l17x', proof.remote_exec('a', format(
  'UPDATE public.purchase_invoices SET amount_excl = 20, amount_incl = 20, remaining_amount = -10 WHERE id = %L', proof.uid(2000, 1127))));
SELECT proof.put('l17c', proof.remote_exec('a', 'COMMIT'));
SELECT proof.remote_exec('a', 'ROLLBACK');
SELECT proof.record('L17', 'G1 onder P5a: na een legitieme unlink de vlag met de hand zetten en het factuurbedrag onder Σ brengen — de UPDATE lukt, de COMMIT weigert (23514); factuur en koppelingen onveranderd',
  proof.get('l17l1') LIKE 'ok:%' AND proof.get('l17l2') LIKE 'ok:%' AND proof.get('l17u') LIKE 'ok: unlinked|%'
  AND proof.get('l17x') = 'ok' AND proof.get('l17c') LIKE 'fout [23514]%'
  AND proof.inv('inkoop', proof.uid(2000, 1127)) LIKE '30.00|%'
  AND (SELECT amount_incl FROM public.purchase_invoices WHERE id = proof.uid(2000, 1127)) = 100
  AND (SELECT sum(amount) FROM public.bank_transaction_allocations WHERE invoice_id = proof.uid(2000, 1127)) = 70,
  proof.get('l17x') || ' / ' || proof.get('l17c'));

-- L18 (F2): volledige betaling op een concept-verkoopfactuur; daarna vlag met de hand en status betaald.
SELECT proof.tx(1129, 100.00), proof.sinv(1129, 100.00, 'concept');
SELECT proof.remote_exec('a', 'BEGIN');
SELECT proof.put('l18l', proof.remote_run('a', proof.lsql(proof.uid(1000, 1129), 'verkoop', proof.uid(3000, 1129), 100, proof.req(1129))));
SELECT proof.put('l18f', proof.remote_run('a', 'SELECT set_config(''boekassist.betaalschrijver'', pg_current_xact_id()::text, true)'));
SELECT proof.put('l18x', proof.remote_exec('a', format(
  'UPDATE public.sales_invoices SET status = ''betaald'' WHERE id = %L', proof.uid(3000, 1129))));
SELECT proof.put('l18c', proof.remote_exec('a', 'COMMIT'));
SELECT proof.remote_exec('a', 'ROLLBACK');
SELECT proof.record('L18', 'F2 onder P5a: na een legitieme link (concept, restant 0) de vlag met de hand zetten en status betaald — de UPDATE lukt, de COMMIT weigert (23514); factuur blijft concept/100, geen koppeling',
  proof.get('l18l') LIKE 'ok: created|0.00|%' AND proof.get('l18x') = 'ok' AND proof.get('l18c') LIKE 'fout [23514]%'
  AND proof.inv('verkoop', proof.uid(3000, 1129)) = '100.00|concept'
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 1129)),
  proof.get('l18x') || ' / ' || proof.get('l18c'));

SELECT dblink_disconnect('a'), dblink_disconnect('b'), dblink_disconnect('c');

SELECT proof.expect_true('L15', 'na alle races: geen deadlock of time-out in enige uitkomst, en alle invarianten van de schrijver gelden',
  $$NOT EXISTS (SELECT 1 FROM proof.state WHERE key LIKE 'l%' AND (value LIKE 'fout [40P01]%' OR value LIKE 'fout [55P03]%' OR value LIKE 'fout [57014]%'))
    AND proof.writer_violations() = 0 AND proof.unbalanced() = 0$$);
