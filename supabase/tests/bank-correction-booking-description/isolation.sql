-- I — NIEMAND ANDERS ZIET DE TIJDELIJKE OMSCHRIJVING. Throwaway database only.
--
-- Drie echte sessies. Sessie a voert een correctie uit die — met een
-- harnas-trigger — midden in de schrijver stilstaat: precies op het moment dat
-- bank_transactions.description de boekingstekst draagt (niet gecommit). De
-- trigger meldt via een eigen, losse verbinding wat sessie a op dat moment zelf
-- ziet, zodat vaststaat dat de tussenstand echt bestaat. Sessie b en deze
-- sessie proberen haar dan op elke manier te lezen.
--   I1  tijdens de pauze: READ COMMITTED, REPEATABLE READ, zoeken op de tekst,
--       FOR SHARE NOWAIT, SKIP LOCKED, als `authenticated` (RLS), de
--       duplicaatsleutel, de rest van de oude toestand
--   I2  na COMMIT: de bankregel is de geïmporteerde tekst, het grootboek de boekingstekst
--   I3  een echte annulering midden in de pauze: alles teruggedraaid
--   I4  een app-UPDATE van de omschrijving tijdens de pauze wacht, en landt daarna
--       op de herstelde rij (het herstel overschrijft niets van een ander)
--   I5  andersom: de RPC wacht op een open app-UPDATE en behoudt daarna precies
--       die gecommitte tekst

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY[
  'I1a','I1b','I1c','I1d','I1e','I1f','I1g','I1h','I1i',
  'I2a','I2b',
  'I3a','I3b',
  'I4a','I4b',
  'I5a','I5b']);

SELECT proof.open_session('a', :'conn');
SELECT proof.open_session('b', :'conn');
SELECT proof.remote_exec('a', format('SET proof.conn = %L', :'conn'));

/** Staat stil zodra sessie a (proof.pause = on) haar eerste grootboekregel van de
    schrijver invoegt, en meldt eerst via een losse verbinding wat a dan ziet. */
CREATE FUNCTION proof.pause_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  IF current_setting('proof.pause', true) = 'on' THEN
    PERFORM set_config('proof.pause', 'off', true);
    SELECT coalesce(bt.description, '∅') INTO v FROM public.bank_transactions bt WHERE bt.id = NEW.source_id;
    PERFORM dblink_exec(current_setting('proof.conn'),
      format('INSERT INTO proof.state VALUES (%L, %L) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
             'inside_' || NEW.source_id::text, v));
    PERFORM pg_advisory_xact_lock(424242);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proof_pause BEFORE INSERT ON public.ledger_postings FOR EACH ROW
  WHEN (NEW.source_type = 'bank_transaction') EXECUTE FUNCTION proof.pause_fn();
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

/** Wacht (hooguit ~5 s) tot de pauze haar melding heeft gedaan. */
CREATE FUNCTION proof.until_inside(_n integer) RETURNS text LANGUAGE plpgsql AS $$
DECLARE i integer;
BEGIN
  FOR i IN 1..100 LOOP
    IF proof.get('inside_' || proof.uid(1000, _n)::text) IS NOT NULL THEN
      RETURN proof.get('inside_' || proof.uid(1000, _n)::text);
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
  RETURN NULL;
END $$;

-- ── I1/I2: één correctie die midden in de schrijver stilstaat ───────────────
SELECT proof.btx(200, -121.00, 'BOL.COM BV 1234567 Bestelling 99', _counter => 'NL99INGB0001234567');
SELECT proof.put('i_post', proof.rc(proof.u(2), proof.uid(1000, 200), NULL, proof.acct(7), 21, proof.req(2000)));
SELECT proof.put('i_old_group', proof.m(200)::text);

SELECT pg_advisory_lock(424242);
SELECT proof.remote_exec('a', 'SET proof.pause = on');
SELECT dblink_send_query('a', format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, %L, %L)',
  proof.u(1), proof.uid(1000, 200), proof.m(200), proof.acct(6), proof.req(2001), 'Andere rekening', 'Tijdelijk zichtbaar?'));
SELECT proof.put('i_inside', proof.until_inside(200));
SELECT proof.put('i_wait', proof.until_waiting('a'));

SELECT proof.record('I1a', 'tijdens de pauze, sessie b (READ COMMITTED): de geïmporteerde tekst — terwijl sessie a zelf de boekingstekst ziet',
  proof.get('i_inside') = 'Tijdelijk zichtbaar?' AND proof.get('i_wait') = 'advisory'
  AND o = 'ok: ''BOL.COM BV 1234567 Bestelling 99''',
  concat_ws(' || ', proof.get('i_inside'), proof.get('i_wait'), o))
FROM proof.remote_run('b', format('SELECT quote_nullable(description) FROM public.bank_transactions WHERE id = %L', proof.uid(1000, 200))) o;

SELECT proof.remote_exec('b', 'BEGIN ISOLATION LEVEL REPEATABLE READ');
SELECT proof.record('I1b', 'tijdens de pauze, sessie b (REPEATABLE READ): de geïmporteerde tekst',
  o = 'ok: BOL.COM BV 1234567 Bestelling 99', o)
FROM proof.remote_run('b', format('SELECT description FROM public.bank_transactions WHERE id = %L', proof.uid(1000, 200))) o;
SELECT proof.remote_exec('b', 'COMMIT');

SELECT proof.record('I1c', 'tijdens de pauze: zoeken op de tijdelijke tekst vindt niets — niet in de bankregels, niet in het grootboek',
  o = 'ok: 0|0', o)
FROM proof.remote_run('b', $q$SELECT (SELECT count(*) FROM public.bank_transactions WHERE description = 'Tijdelijk zichtbaar?') || '|' ||
                                 (SELECT count(*) FROM public.ledger_postings WHERE description LIKE '%Tijdelijk zichtbaar?%')$q$) o;

SELECT proof.record('I1d', 'tijdens de pauze: FOR SHARE NOWAIT faalt (55P03) — wie wil grendelen om te lezen, komt er niet bij',
  o LIKE 'fout [55P03]%', o)
FROM proof.remote_run('b', format('SELECT description FROM public.bank_transactions WHERE id = %L FOR SHARE NOWAIT', proof.uid(1000, 200))) o;

SELECT proof.record('I1e', 'tijdens de pauze: SKIP LOCKED slaat de rij over',
  o = 'ok: 0', o)
FROM proof.remote_run('b', format('SELECT count(*) FROM (SELECT 1 FROM public.bank_transactions WHERE id = %L FOR UPDATE SKIP LOCKED) x', proof.uid(1000, 200))) o;

SELECT proof.record('I1f', 'tijdens de pauze, als de app (authenticated, RLS, accountant): de geïmporteerde tekst',
  o = 'ok: ok: BOL.COM BV 1234567 Bestelling 99', o)
FROM proof.remote_run('b', format($q$SELECT proof.call('00000000-0000-0000-0000-0000000000e1',
  'SELECT description FROM public.bank_transactions WHERE id = %s')$q$, proof.lit2(proof.uid(1000, 200)::text))) o;

SELECT proof.record('I1g', 'tijdens de pauze: de duplicaatsleutel van de import is ongewijzigd',
  o = 'ok: ' || (SELECT dedup FROM proof.original WHERE tx = proof.uid(1000, 200)), o)
FROM proof.remote_run('b', 'SELECT proof.dedup_key(200)') o;

SELECT proof.record('I1h', 'tijdens de pauze ziet een derde sessie de volledige oude toestand: de oude marker, geen storno, geen nieuwe groep',
  proof.m(200) = proof.get('i_old_group')::uuid AND proof.reversal_count(200) = 0 AND proof.group_count(200) = 1
  AND (SELECT description FROM public.bank_transactions WHERE id = proof.uid(1000, 200)) = 'BOL.COM BV 1234567 Bestelling 99');

SELECT proof.record('I1i', 'sessie a wachtte op de harnasgrendel, niet op een rijgrendel van een ander',
  proof.get('i_wait') = 'advisory', proof.get('i_wait'));

SELECT pg_advisory_unlock(424242);
SELECT proof.put('i_done', proof.remote_outcome('a'));
SELECT proof.remote_exec('a', 'RESET proof.pause');

SELECT proof.record('I2a', 'na COMMIT: de correctie is gelukt; de bankregel draagt byte-gelijk de geïmporteerde tekst',
  proof.get('i_done') LIKE 'ok: ok: reclassified|f|%' AND proof.intact(200)
  AND o = 'ok: BOL.COM BV 1234567 Bestelling 99',
  concat_ws(' || ', proof.get('i_done'), o))
FROM proof.remote_run('b', format('SELECT description FROM public.bank_transactions WHERE id = %L', proof.uid(1000, 200))) o;

SELECT proof.record('I2b', 'en het grootboek draagt de boekingstekst; de duplicaatsleutel is die van de import',
  proof.texts_of(proof.m(200)) = 'Tijdelijk zichtbaar? / BTW Tijdelijk zichtbaar? / Tijdelijk zichtbaar?'
  AND proof.dedup_key(200) = (SELECT dedup FROM proof.original WHERE tx = proof.uid(1000, 200)),
  proof.texts_of(proof.m(200)));

-- ── I3: een echte annulering midden in de pauze ─────────────────────────────
SELECT proof.btx(201, -121.00, 'COOLBLUE BV ORDER 778');
SELECT proof.put('i3_post', proof.rc(proof.u(2), proof.uid(1000, 201), NULL, proof.acct(7), 21, proof.req(2010)));
SELECT proof.put('i3_digest', proof.digest());
SELECT pg_advisory_lock(424242);
SELECT proof.remote_exec('a', 'SET proof.pause = on');
SELECT dblink_send_query('a', format('SELECT proof.rc(%L, %L, %L, %L, 21, %L, %L, %L)',
  proof.u(1), proof.uid(1000, 201), proof.m(201), proof.acct(6), proof.req(2011), 'Wordt afgebroken', 'Nooit gecommit'));
SELECT proof.put('i3_inside', proof.until_inside(201));
SELECT proof.put('i3_wait', proof.until_waiting('a'));
SELECT pg_cancel_backend(proof.get('pid_a')::integer);
SELECT proof.put('i3_out', proof.remote_outcome('a'));
SELECT pg_advisory_unlock(424242);
SELECT proof.remote_exec('a', 'RESET proof.pause');

SELECT proof.record('I3a', 'annulering terwijl de tijdelijke tekst geschreven staat: de aanroep faalt, en niets blijft — geen storno, geen marker, geen gebeurtenis, geen tekst',
  proof.get('i3_inside') = 'Nooit gecommit' AND proof.get('i3_wait') = 'advisory'
  AND (proof.get('i3_out') LIKE 'ok: fout [57014]%' OR proof.get('i3_out') LIKE 'fout [57014]%')
  AND proof.digest() = proof.get('i3_digest') AND proof.intact(201),
  concat_ws(' || ', proof.get('i3_inside'), proof.get('i3_out')));
SELECT proof.put('i3b', proof.rc(proof.u(1), proof.uid(1000, 201), proof.m(201), proof.acct(6), 21, proof.req(2012), 'Opnieuw', 'Nu wel'));
SELECT proof.record('I3b', 'en dezelfde correctie (nieuwe request_id) lukt daarna gewoon',
  proof.get('i3b') LIKE 'ok: reclassified|f|%' AND proof.intact(201) AND proof.text_of(proof.m(201)) = 'Nu wel', proof.get('i3b'));

-- ── I4: een app-UPDATE van de omschrijving tijdens de pauze ─────────────────
SELECT proof.btx(202, -121.00, 'KPN BV FACTUUR 2027-03');
SELECT proof.put('i4_post', proof.rc(proof.u(2), proof.uid(1000, 202), NULL, proof.acct(7), 21, proof.req(2020)));
SELECT pg_advisory_lock(424242);
SELECT proof.remote_exec('a', 'SET proof.pause = on');
SELECT dblink_send_query('a', format('SELECT proof.rc(%L, %L, %L, %L, 21, %L, %L, %L)',
  proof.u(1), proof.uid(1000, 202), proof.m(202), proof.acct(6), proof.req(2021), 'Correctie', 'Telefonie maart'));
SELECT proof.put('i4_inside', proof.until_inside(202));
SELECT dblink_send_query('b', format($q$SELECT proof.call('00000000-0000-0000-0000-0000000000e2',
  'UPDATE public.bank_transactions SET description = ''Toelichting van de app'' WHERE id = %s RETURNING description')$q$,
  proof.lit2(proof.uid(1000, 202)::text)));
SELECT proof.put('i4_wait', proof.until_waiting('b'));
SELECT pg_advisory_unlock(424242);
SELECT proof.put('i4_a', proof.remote_outcome('a'));
SELECT proof.put('i4_b', proof.remote_outcome('b'));
SELECT proof.remote_exec('a', 'RESET proof.pause');

SELECT proof.record('I4a', 'de app-UPDATE wacht op de rijgrendel van de correctie (zij ziet de tijdelijke tekst nooit) en landt daarna op de herstelde rij',
  proof.get('i4_inside') = 'Telefonie maart' AND proof.get('i4_wait') IN ('transactionid', 'tuple')
  AND proof.get('i4_a') LIKE 'ok: ok: reclassified|f|%'
  AND proof.get('i4_b') = 'ok: ok: Toelichting van de app',
  concat_ws(' || ', proof.get('i4_wait'), proof.get('i4_a'), proof.get('i4_b')));
SELECT proof.record('I4b', 'eindstand: de tekst van de app (haar eigen, latere schrijfactie — buiten deze PR) op de bankregel, de boekingstekst in het grootboek; het herstel overschreef niets van een ander',
  (SELECT description FROM public.bank_transactions WHERE id = proof.uid(1000, 202)) = 'Toelichting van de app'
  AND proof.text_of(proof.m(202)) = 'Telefonie maart');

-- ── I5: de RPC wacht op een open app-UPDATE ──────────────────────────────────
SELECT proof.btx(203, -121.00, 'ZIGGO SERVICES BV');
SELECT proof.put('i5_post', proof.rc(proof.u(2), proof.uid(1000, 203), NULL, proof.acct(7), 21, proof.req(2030)));
SELECT proof.remote_exec('b', 'BEGIN');
SELECT proof.put('i5_b', proof.remote_run('b', format('UPDATE public.bank_transactions SET description = %L WHERE id = %L RETURNING description',
  'Door de app gewijzigd', proof.uid(1000, 203))));
SELECT dblink_send_query('a', format('SELECT proof.rc(%L, %L, %L, %L, 21, %L, %L, %L)',
  proof.u(1), proof.uid(1000, 203), proof.m(203), proof.acct(6), proof.req(2031), 'Correctie', 'Internet maart'));
SELECT proof.put('i5_wait', proof.until_waiting('a'));
SELECT proof.remote_exec('b', 'COMMIT');
SELECT proof.put('i5_a', proof.remote_outcome('a'));

SELECT proof.record('I5a', 'de correctie wacht op de open app-UPDATE (FOR UPDATE) en slaagt daarna',
  proof.get('i5_wait') = 'transactionid' AND proof.get('i5_a') LIKE 'ok: ok: reclassified|f|%',
  concat_ws(' || ', proof.get('i5_wait'), proof.get('i5_a')));
SELECT proof.record('I5b', 'en behoudt precies de gecommitte tekst van dat moment (onder de rijgrendel gelezen), byte-gelijk; het grootboek draagt de boekingstekst',
  (SELECT description FROM public.bank_transactions WHERE id = proof.uid(1000, 203)) = 'Door de app gewijzigd'
  AND proof.text_of(proof.m(203)) = 'Internet maart');

DROP TRIGGER proof_pause ON public.ledger_postings;
SELECT dblink_disconnect('a'), dblink_disconnect('b');
