-- R — GELIJKTIJDIGHEID MET TWEE ECHTE SESSIES. Throwaway database only.
--
-- Per race: sessie b WACHT zichtbaar (pg_locks), precies één route wint, de
-- ander krijgt een gerichte weigering of exact de opgeslagen uitkomst — en de
-- bankomschrijving is na afloop byte-gelijk, wie er ook won.
--   R1  twee correcties met verschillende omschrijving → één wint, de ander 55000
--   R2  dubbelklik: dezelfde request_id → de tweede wacht en krijgt replayed
--   R3  correctie ↔ handmatige storno, beide volgordes → nooit twee storno's
--   R4  correctie ↔ boekingsblokkade, beide volgordes
--   R5  correctie ↔ vrijgeven → het vrijgeven wacht en krijgt 55000
--   R6  twee correcties op twee regels van één administratie → beide

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY[
  'R1a','R1b','R2a','R2b',
  'R3a','R3b','R4a','R4b','R5a','R6a','RZ']);

SELECT proof.open_session('a', :'conn');
SELECT proof.open_session('b', :'conn');

SELECT proof.btx(n, -121.00, format('Racebankregel %s', n)) FROM generate_series(400, 409) n;
SELECT format('SELECT proof.put(%L, proof.rc(proof.u(2), proof.uid(1000, %s), NULL, proof.acct(7), 21, proof.req(%s), NULL, %L))',
              'r' || n, n, 40000 + n, format('Boeking %s', n))
FROM generate_series(400, 409) n \gexec

CREATE TABLE proof.race (n text PRIMARY KEY, waited text, a text, b text);
GRANT ALL ON proof.race TO public;

/** a voert _a uit in een open transactie; b stuurt _b; we noteren waar b op wacht;
    a sluit af met _end; daarna b's uitkomst; b sluit af. */
CREATE FUNCTION proof.race(_n text, _a text, _b text, _end text DEFAULT 'COMMIT')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_a text; v_wait text; v_b text;
BEGIN
  PERFORM dblink_exec('a', 'BEGIN');
  v_a := proof.remote_run('a', _a);
  PERFORM dblink_exec('b', 'BEGIN');
  PERFORM dblink_send_query('b', _b);
  v_wait := proof.until_waiting('b');
  PERFORM dblink_exec('a', _end);
  v_b := proof.remote_outcome('b');
  PERFORM proof.remote_exec('b', 'COMMIT');
  INSERT INTO proof.race VALUES (_n, v_wait, v_a, v_b);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

CREATE FUNCTION proof.rcsql(_user uuid, _n integer, _expected uuid, _acct uuid, _pct numeric, _req integer, _reason text, _desc text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT format('SELECT proof.rc(%L, %L, %L, %L, %s, %L, %L, %L)',
                _user, proof.uid(1000, _n), _expected, _acct, _pct, proof.req(_req), _reason, _desc);
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

-- R1: twee correcties met verschillende omschrijving.
SELECT proof.race('R1',
  proof.rcsql(proof.u(1), 400, proof.m(400), proof.acct(6), 21, 40100, 'Eerste', 'Tekst van a'),
  proof.rcsql(proof.u(5), 400, proof.m(400), proof.acct(6), 9, 40101, 'Tweede', 'Tekst van b'));
SELECT proof.record('R1a', 'twee correcties tegelijk: b wacht op de rij, a wint, b krijgt 55000',
  waited = 'transactionid' AND a LIKE 'ok: ok: reclassified|f|%' AND b LIKE 'ok: fout [55000]%', concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R1';
SELECT proof.record('R1b', 'eindstand: één storno, de tekst van de winnaar in het grootboek, de bankregel byte-gelijk',
  proof.reversal_count(400) = 1 AND proof.text_of(proof.m(400)) = 'Tekst van a' AND proof.intact(400));

-- R2: dubbelklik.
SELECT proof.race('R2',
  proof.rcsql(proof.u(1), 401, proof.m(401), proof.acct(6), 21, 40110, 'Dubbelklik', 'Eén tekst'),
  proof.rcsql(proof.u(1), 401, proof.m(401), proof.acct(6), 21, 40110, 'Dubbelklik', 'Eén tekst'));
SELECT proof.record('R2a', 'dezelfde request_id tegelijk: b wacht en krijgt exact het antwoord van a, met replayed',
  waited = 'transactionid' AND a LIKE 'ok: ok: reclassified|f|%' AND b = replace(a, '|f|', '|t|'), concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R2';
SELECT proof.record('R2b', 'eindstand: één storno, één herboeking, bankregel byte-gelijk',
  proof.reversal_count(401) = 1 AND proof.group_count(401) = 2 AND proof.intact(401));

-- R3: correctie ↔ handmatige storno, beide volgordes.
SELECT proof.put('r3_g402', proof.m(402)::text), proof.put('r3_g403', proof.m(403)::text);
SELECT proof.race('R3a',
  proof.rcsql(proof.u(1), 402, proof.m(402), proof.acct(6), 21, 40120, 'Correctie', 'Correctietekst'),
  format('SELECT public.reverse_posting_group(%L, DATE ''2027-03-01'', ''Handmatig'')::text', proof.m(402)));
SELECT proof.race('R3b',
  format('SELECT public.reverse_posting_group(%L, DATE ''2027-03-01'', ''Handmatig'')::text', proof.m(403)),
  proof.rcsql(proof.u(1), 403, proof.m(403), proof.acct(6), 21, 40130, 'Correctie', 'Correctietekst'));
SELECT proof.record('R3a', 'correctie eerst, handmatige storno erachter: de storno wacht en wordt geweigerd — één storno, de bankregel byte-gelijk',
  a LIKE 'ok: ok: reclassified|f|%' AND b LIKE 'fout %'
  AND (SELECT count(*) FROM public.ledger_reversal_postings WHERE original_posting_group_id = proof.get('r3_g402')::uuid) = 1
  AND proof.reversal_count(402) = 1 AND proof.intact(402),
  concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R3a';
SELECT proof.record('R3b', 'handmatige storno eerst, correctie erachter: de correctie wacht en wordt geweigerd (of herboekt zonder tweede storno) — nooit twee storno''s, bankregel byte-gelijk',
  a LIKE 'ok: %' AND (b LIKE 'ok: fout %' OR b LIKE 'ok: ok: reposted|f|%')
  AND (SELECT count(*) FROM public.ledger_reversal_postings WHERE original_posting_group_id = proof.get('r3_g403')::uuid) = 1
  AND proof.reversal_count(403) = 1 AND proof.intact(403),
  concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R3b';

-- R4: correctie ↔ boekingsblokkade, beide volgordes.
SELECT proof.race('R4a',
  proof.rcsql(proof.u(1), 404, proof.m(404), proof.acct(6), 21, 40140, 'Vóór de blokkade', 'Net op tijd'),
  format($q$SELECT proof.call(%L, 'SELECT changed::text FROM public.set_posting_lock(''00000000-0000-0000-0000-0000000000c1'', DATE ''2027-03-31'', ''Q1'')')$q$, proof.u(1)));
SELECT proof.call(proof.u(1), $q$SELECT changed::text FROM public.set_posting_lock('00000000-0000-0000-0000-0000000000c1', NULL, 'Opgeheven')$q$);
SELECT proof.race('R4b',
  format($q$SELECT proof.call(%L, 'SELECT changed::text FROM public.set_posting_lock(''00000000-0000-0000-0000-0000000000c1'', DATE ''2027-03-31'', ''Q1'')')$q$, proof.u(1)),
  proof.rcsql(proof.u(1), 405, proof.m(405), proof.acct(6), 21, 40150, 'Na de blokkade', 'Te laat'));
SELECT proof.call(proof.u(1), $q$SELECT changed::text FROM public.set_posting_lock('00000000-0000-0000-0000-0000000000c1', NULL, 'Opgeheven')$q$);
SELECT proof.record('R4a', 'correctie eerst: de blokkade wacht (administratiegrendel) en komt daarna; de correctie staat, bankregel byte-gelijk',
  waited <> 'none' AND a LIKE 'ok: ok: reclassified|f|%' AND b LIKE 'ok: ok: %' AND proof.text_of(proof.m(404)) = 'Net op tijd' AND proof.intact(404),
  concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R4a';
SELECT proof.record('R4b', 'blokkade eerst: de correctie wacht en wordt daarna geweigerd (22023); geen storno, bankregel byte-gelijk',
  waited <> 'none' AND a LIKE 'ok: ok: %' AND b LIKE 'ok: fout [22023] Boekingsdatum 2027-03-01 valt binnen de boekingsblokkade%'
  AND proof.reversal_count(405) = 0 AND proof.text_of(proof.m(405)) = 'Boeking 405' AND proof.intact(405),
  concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R4b';

-- R5: correctie ↔ vrijgeven.
SELECT proof.race('R5',
  proof.rcsql(proof.u(1), 406, proof.m(406), proof.acct(6), 21, 40160, 'Correctie', 'Gecorrigeerd'),
  format('SELECT proof.rel(%L, %L, %L, %L)', proof.u(5), proof.uid(1000, 406), proof.m(406), proof.req(40161)));
SELECT proof.record('R5a', 'correctie eerst, vrijgeven erachter: het vrijgeven wacht en krijgt 55000; bankregel byte-gelijk',
  waited = 'transactionid' AND a LIKE 'ok: ok: reclassified|f|%' AND b LIKE 'ok: fout [55000]%'
  AND proof.text_of(proof.m(406)) = 'Gecorrigeerd' AND proof.intact(406),
  concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R5';

-- R6: twee regels, één administratie.
SELECT proof.race('R6',
  proof.rcsql(proof.u(1), 407, proof.m(407), proof.acct(6), 21, 40170, 'Regel 407', 'Tekst 407'),
  proof.rcsql(proof.u(5), 408, proof.m(408), proof.acct(6), 21, 40180, 'Regel 408', 'Tekst 408'));
SELECT proof.record('R6a', 'twee correcties op twee regels van één administratie: b wacht op de administratiegrendel, daarna slagen beide; beide bankregels byte-gelijk',
  a LIKE 'ok: ok: reclassified|f|%' AND b LIKE 'ok: ok: reclassified|f|%'
  AND proof.text_of(proof.m(407)) = 'Tekst 407' AND proof.text_of(proof.m(408)) = 'Tekst 408'
  AND proof.intact(407) AND proof.intact(408),
  concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R6';

SELECT proof.expect_true('RZ', 'na alle races: lineage in orde, alles in balans, elke testregel byte-gelijk (behalve de twee die de app in I4/I5 zelf wijzigde)', $$
  proof.lineage_violations() = 0 AND proof.unbalanced() = 0 AND proof.all_intact(ARRAY[202, 203]) $$);

SELECT dblink_disconnect('a'), dblink_disconnect('b');
