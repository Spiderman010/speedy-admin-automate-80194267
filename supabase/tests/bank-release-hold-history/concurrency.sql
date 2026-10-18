-- R — GELIJKTIJDIGHEID OP HISTORISCHE REGELS, MET TWEE ECHTE SESSIES. Throwaway database only.
--
-- Per race: sessie b WACHT zichtbaar (pg_locks), precies één route wint.
--   R1  vrijgeven (a) ↔ app-codering (b): b wacht, ziet daarna de vrijgave → 42501
--   R2  twee keer "Opnieuw boeken" na de vrijgave: één wint, de ander 55000
--   R3  twee correcties (S1) tegelijk: één wint, de ander 55000; één storno
--   R4  vrijgeven (a) ↔ correctie (b): de correctie wacht en krijgt 55000; daarna is de app dicht
-- De hold leest de vrijgave in een verse snapshot (VOLATILE); de hulpfunctie
-- (STABLE) ziet dezelfde snapshot als die query.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['R1','R2a','R2b','R3a','R3b','R4','RZ']);

SELECT proof.open_session('a', :'conn');
SELECT proof.open_session('b', :'conn');

CREATE TABLE proof.race (n text PRIMARY KEY, waited text, a text, b text);
GRANT ALL ON proof.race TO public;

/** a voert _a uit in een open transactie; b stuurt _b; we noteren waar b op wacht;
    a sluit af; daarna b's uitkomst; b sluit af. */
CREATE FUNCTION proof.race(_n text, _a text, _b text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_a text; v_wait text; v_b text;
BEGIN
  PERFORM dblink_exec('a', 'BEGIN');
  v_a := proof.remote_run('a', _a);
  PERFORM dblink_exec('b', 'BEGIN');
  PERFORM dblink_send_query('b', _b);
  v_wait := proof.until_waiting('b');
  PERFORM dblink_exec('a', 'COMMIT');
  v_b := proof.remote_outcome('b');
  PERFORM proof.remote_exec('b', 'COMMIT');
  INSERT INTO proof.race VALUES (_n, v_wait, v_a, v_b);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

-- R1
SELECT proof.race('R1',
  format('SELECT proof.rel(%L, %L, %L, %L, %L)', proof.u(1), proof.uid(1000, 14), proof.m(14), proof.req(14001), 'Vrijgeven'),
  'SELECT proof.app_code(14)');
SELECT proof.record('R1', 'vrijgeven ↔ app-codering: b wacht op de rij en wordt na de vrijgave geweigerd (42501) — de historische groep schakelt de hold niet uit',
  waited = 'transactionid' AND a LIKE 'ok: ok: released|f||%' AND b LIKE 'ok: fout [42501] Deze banktransactie is vrijgegeven%'
  AND proof.m(14) IS NULL AND proof.net(proof.uid(1000, 14), proof.acct(1)) = 0,
  concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R1';

-- R2
SELECT proof.race('R2',
  format('SELECT proof.rc(%L, %L, NULL, %L, 0, %L, %L)', proof.u(1), proof.uid(1000, 14), proof.acct(6), proof.req(14002), 'Opnieuw boeken (a)'),
  format('SELECT proof.rc(%L, %L, NULL, %L, 0, %L, %L)', proof.u(5), proof.uid(1000, 14), proof.acct(7), proof.req(14003), 'Opnieuw boeken (b)'));
SELECT proof.record('R2a', 'twee keer "Opnieuw boeken" tegelijk: b wacht, a herboekt, b krijgt 55000',
  waited <> 'none' AND a LIKE 'ok: ok: reposted_after_release|f|%' AND b LIKE 'ok: fout [55000]%', concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R2';
SELECT proof.record('R2b', 'eindstand: één herboeking, bank € 300 precies één keer, op 8250',
  proof.net(proof.uid(1000, 14), proof.acct(1)) = -300.00 AND proof.net(proof.uid(1000, 14), proof.acct(6)) = 300.00
  AND proof.net(proof.uid(1000, 14), proof.acct(7)) = 0 AND proof.group_count(14) = 3);

-- R3
SELECT proof.put('r3_g17', proof.m(17)::text);
SELECT proof.race('R3',
  format('SELECT proof.rc(%L, %L, %L, %L, 0, %L, %L)', proof.u(1), proof.uid(1000, 17), proof.m(17), proof.acct(6), proof.req(17001), 'Correctie a'),
  format('SELECT proof.rc(%L, %L, %L, %L, 9, %L, %L)', proof.u(5), proof.uid(1000, 17), proof.m(17), proof.acct(6), proof.req(17002), 'Correctie b'));
SELECT proof.record('R3a', 'twee correcties tegelijk op een historische regel: b wacht, a wint, b krijgt 55000',
  waited <> 'none' AND a LIKE 'ok: ok: reclassified|f|%' AND b LIKE 'ok: fout [55000]%', concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R3';
SELECT proof.record('R3b', 'eindstand: precies één storno van de actieve groep; de historische groep blijft bewezen',
  (SELECT count(*) FROM public.ledger_reversal_postings WHERE original_posting_group_id = proof.get('r3_g17')::uuid) = 1
  AND proof.reversal_count(17) = 2 AND proof.settled(17, proof.h_orig(17)) AND proof.net(proof.uid(1000, 17), proof.acct(1)) = -99.00);

-- R4
SELECT proof.race('R4',
  format('SELECT proof.rel(%L, %L, %L, %L, %L)', proof.u(1), proof.uid(1000, 15), proof.m(15), proof.req(15001), 'Vrijgeven'),
  format('SELECT proof.rc(%L, %L, %L, %L, 0, %L, %L)', proof.u(5), proof.uid(1000, 15), proof.m(15), proof.acct(6), proof.req(15002), 'Correctie'));
SELECT proof.record('R4', 'vrijgeven ↔ correctie: de correctie wacht en krijgt 55000; daarna is de app dicht (twee historische groepen)',
  waited <> 'none' AND a LIKE 'ok: ok: released|f||%' AND b LIKE 'ok: fout [55000]%'
  AND o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%',
  concat_ws(' || ', waited, a, b, o))
FROM proof.race, proof.app_code(15) o WHERE n = 'R4';

SELECT proof.expect_true('RZ', 'na alle races: lineage met geschiedenis in orde voor 14, 15 en 17', $$
  proof.hist_lineage_violations(ARRAY[14, 15, 17]) = 0 $$);

SELECT dblink_disconnect('a'), dblink_disconnect('b');
