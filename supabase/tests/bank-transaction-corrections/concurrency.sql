-- K4 + K11 — GELIJKTIJDIGHEID MET TWEE ECHTE SESSIES. Throwaway database only.
--
-- Per race: de tweede sessie WACHT zichtbaar (pg_locks), precies één route
-- wint, de ander krijgt een gerichte weigering of exact de opgeslagen
-- uitkomst, en er blijft nooit iets half achter.
--   R1  twee correcties, verschillende request_id's → één wint, de ander 55000
--   R2  dubbelklik: dezelfde request_id → de tweede wacht en krijgt replayed
--   R3  dezelfde request_id, origineel teruggedraaid → de tweede voert uit
--   R4  correctie ↔ handmatige tegenboeking, beide volgordes → nooit twee storno's
--   R5  vrijgeven ↔ sjabloon-UPDATE (D12) → de UPDATE wacht en wordt geweigerd
--   R6  vrijgeven ↔ koppeling (Facturen/Verkoop) → wacht en wordt geweigerd
--   R7  koppeling ↔ eerste boeking, beide volgordes
--   R8  terugzetten ↔ sjabloon-UPDATE → wacht en mag daarna
--   R9  herboeken na vrijgave ↔ bulk → één boeking
--   R10 REPEATABLE READ: een updater tegen vrijgeven → 40001; de RPC zelf → 25000
--   R11 correctie ↔ boekingsblokkade, beide volgordes
--   R12 twee correcties op verschillende regels van één administratie → beide
--   R13 de bestaande cyclus bulk ↔ T→L-schrijver: één 40P01, niets half

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY[
  'R1a','R1b','R1c','R2a','R2b','R3a','R3b',
  'R4a','R4b','R4c','R4d',
  'R5a','R5b','R6a','R6b',
  'R7a','R7b','R7c','R7d',
  'R8a','R8b','R9a','R9b',
  'R10a','R10b',
  'R11a','R11b','R11c','R11d',
  'R12a','R13a','R13b',
  'RZ']);

SELECT proof.open_session('a', :'conn');
SELECT proof.open_session('b', :'conn');

-- Uitgangstoestanden.
SELECT proof.tx(n, -121.00) FROM generate_series(700, 720) n;
SELECT format('SELECT proof.put(%L, proof.rc(proof.u(2), proof.uid(1000, %s), NULL, proof.acct(6), 21, proof.req(%s)))', 'c' || n, n, 70000 + n)
FROM generate_series(700, 720) n WHERE n NOT IN (713, 714) \gexec
SELECT proof.put('c705r', proof.rel(proof.u(1), proof.uid(1000, 705), proof.f(proof.get('c705'), 3)::uuid, proof.req(71705)));
SELECT proof.put('c706r', proof.rel(proof.u(1), proof.uid(1000, 706), proof.f(proof.get('c706'), 3)::uuid, proof.req(71706)));
SELECT proof.put('c708r', proof.rel(proof.u(1), proof.uid(1000, 708), proof.f(proof.get('c708'), 3)::uuid, proof.req(71708)));
SELECT proof.put('c709r', proof.rel(proof.u(1), proof.uid(1000, 709), proof.f(proof.get('c709'), 3)::uuid, proof.req(71709)));
SELECT proof.put('c710r', proof.rel(proof.u(1), proof.uid(1000, 710), proof.f(proof.get('c710'), 3)::uuid, proof.req(71710)));
SELECT proof.purchase(706, 121.00), proof.purchase(713, 121.00), proof.purchase(714, 121.00);

CREATE FUNCTION proof.g(_n integer) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT proof.f(proof.get('c' || _n), 3)::uuid $$;
CREATE FUNCTION proof.events(_n integer) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(e.event_type, ',' ORDER BY e.seq), '') FROM public.bank_transaction_posting_events e WHERE e.bank_transaction_id = proof.uid(1000, _n);
$$;
CREATE FUNCTION proof.reversals(_n integer) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM public.ledger_reversal_postings r
  WHERE r.original_posting_group_id IN (SELECT DISTINCT lp.posting_group_id FROM public.ledger_postings lp
                                        WHERE lp.source_type = 'bank_transaction' AND lp.source_id = proof.uid(1000, _n));
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

/** Een letterlijke waarde voor gebruik BINNEN een al gequote SQL-string (quotes verdubbeld). */
CREATE FUNCTION proof.ql2(_v anyelement) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(quote_literal(_v::text), '''', '''''');
$$;
GRANT EXECUTE ON FUNCTION proof.ql2(anyelement) TO public;

CREATE TABLE proof.race (n text PRIMARY KEY, waited text, a text, b text);
GRANT ALL ON proof.race TO public;

/** a voert _a uit in een open transactie; b stuurt _b; we noteren waar b op wacht;
    a sluit af met _end (COMMIT of ROLLBACK); daarna b's uitkomst; b sluit af. */
CREATE FUNCTION proof.race(_n text, _a text, _b text, _end text DEFAULT 'COMMIT', _b_iso text DEFAULT 'BEGIN')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_a text; v_wait text; v_b text;
BEGIN
  PERFORM dblink_exec('a', 'BEGIN');
  v_a := proof.remote_run('a', _a);
  PERFORM dblink_exec('b', _b_iso);
  PERFORM dblink_send_query('b', _b);
  v_wait := proof.until_waiting('b');
  PERFORM dblink_exec('a', _end);
  v_b := proof.remote_outcome('b');
  PERFORM proof.remote_exec('b', 'COMMIT');
  INSERT INTO proof.race VALUES (_n, v_wait, v_a, v_b);
END $$;
GRANT EXECUTE ON FUNCTION proof.race(text, text, text, text, text) TO public;

CREATE FUNCTION proof.rcq(_user integer, _n integer, _expected uuid, _acct integer, _pct integer, _req integer, _reason text DEFAULT 'Race')
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT format('SELECT proof.rc(proof.u(%s), proof.uid(1000, %s), %L::uuid, proof.acct(%s), %s, proof.req(%s), %L)',
                _user, _n, _expected, _acct, _pct, _req, _reason);
$$;
GRANT EXECUTE ON FUNCTION proof.rcq(integer, integer, uuid, integer, integer, integer, text) TO public;

-- ── R1: twee accountants corrigeren tegelijk dezelfde regel ─────────────────
SELECT proof.race('R1', proof.rcq(1, 700, proof.g(700), 7, 21, 72001), proof.rcq(5, 700, proof.g(700), 7, 9, 72002));
SELECT proof.record('R1a', 'R1 de tweede correctie wacht op de rijgrendel van de eerste', waited IN ('transactionid', 'tuple'), waited) FROM proof.race WHERE n = 'R1';
SELECT proof.record('R1b', 'R1 de eerste wint, de tweede krijgt 55000 (verouderde verwachting) — geen dubbele correctie',
  a LIKE 'ok: ok: reclassified|f|%' AND b LIKE 'ok: fout [55000]%', a || ' || ' || b) FROM proof.race WHERE n = 'R1';
SELECT proof.record('R1c', 'R1 precies één storno en één opvolger', proof.events(700) = 'posted,reclassified' AND proof.reversals(700) = 1, proof.events(700));

-- ── R2: dubbelklik, dezelfde request_id ─────────────────────────────────────
SELECT proof.race('R2', proof.rcq(1, 701, proof.g(701), 7, 21, 72011), proof.rcq(1, 701, proof.g(701), 7, 21, 72011));
SELECT proof.record('R2a', 'R2 de herhaling wacht en krijgt daarna exact dezelfde rij met replayed = true',
  waited IN ('transactionid', 'tuple') AND replace(a, '|f|', '|t|') = b, concat_ws(' || ', waited, a, b)) FROM proof.race WHERE n = 'R2';
SELECT proof.record('R2b', 'R2 één gebeurtenis, één storno', proof.events(701) = 'posted,reclassified' AND proof.reversals(701) = 1, proof.events(701));

-- ── R3: dezelfde request_id, het origineel wordt teruggedraaid ──────────────
SELECT proof.race('R3', proof.rcq(1, 702, proof.g(702), 7, 21, 72021), proof.rcq(1, 702, proof.g(702), 7, 21, 72021), 'ROLLBACK');
SELECT proof.record('R3a', 'R3 origineel teruggedraaid: de herhaling voert het nu voor het eerst uit (replayed = false)',
  waited IN ('transactionid', 'tuple') AND a LIKE 'ok: ok: reclassified|f|%' AND b LIKE 'ok: ok: reclassified|f|%' AND a <> b,
  concat_ws(' || ', waited, a, b)) FROM proof.race WHERE n = 'R3';
SELECT proof.record('R3b', 'R3 en er staat precies één correctie', proof.events(702) = 'posted,reclassified' AND proof.reversals(702) = 1, proof.events(702));

-- ── R4: correctie ↔ handmatige tegenboeking ─────────────────────────────────
SELECT proof.race('R4a', proof.rcq(1, 703, proof.g(703), 7, 21, 72031),
  format($q$SELECT public.reverse_posting_group(%L, DATE '2027-03-20', 'Handmatig')::text$q$, proof.g(703)));
SELECT proof.record('R4a', 'R4 correctie eerst: de handmatige tegenboeking wacht op de administratiegrendel en weigert daarna (al tegengeboekt)',
  waited = 'advisory' AND a LIKE 'ok: ok: reclassified|f|%' AND b LIKE 'fout [23505] Deze boekingsgroep is al tegengeboekt%',
  concat_ws(' || ', waited, a, b)) FROM proof.race WHERE n = 'R4a';
SELECT proof.record('R4b', 'R4 precies één storno van het origineel', proof.reversals(703) = 1 AND proof.events(703) = 'posted,reclassified', proof.events(703));

SELECT proof.race('R4c', format($q$SELECT public.reverse_posting_group(%L, DATE '2027-03-20', 'Handmatig')::text$q$, proof.g(704)),
  proof.rcq(1, 704, proof.g(704), 7, 21, 72041));
SELECT proof.record('R4c', 'R4 handmatig eerst: de correctie wacht en herboekt daarna met de bestaande storno (reposted)',
  waited = 'advisory' AND a LIKE 'ok: %' AND b LIKE 'ok: ok: reposted|f|%', concat_ws(' || ', waited, a, b)) FROM proof.race WHERE n = 'R4c';
SELECT proof.record('R4d', 'R4 ook hier precies één storno', proof.reversals(704) = 1 AND proof.events(704) = 'posted,reposted', proof.events(704));

-- ── R5: vrijgeven ↔ sjabloon-UPDATE (D12) ───────────────────────────────────
SELECT proof.tx(721, -121.00);
SELECT proof.put('c721', proof.rc(proof.u(2), proof.uid(1000, 721), NULL, proof.acct(6), 21, proof.req(70721)));
SELECT proof.race('R5', format('SELECT proof.rel(proof.u(1), proof.uid(1000, 721), %L::uuid, proof.req(72051))', proof.g(721)),
  format($q$SELECT proof.call(proof.u(2), 'UPDATE public.bank_transactions SET match_status = ''handmatig_geboekt'', grootboekrekening_id = %s WHERE id = %s RETURNING id::text')$q$,
         proof.ql2(proof.acct(7)), proof.ql2(proof.uid(1000, 721))));
SELECT proof.record('R5a', 'R5 de sjabloon-UPDATE wacht op de vrijgave',
  waited IN ('transactionid', 'tuple'), waited) FROM proof.race WHERE n = 'R5';
SELECT proof.record('R5b', 'R5 en wordt daarna door de hold geweigerd (de VOLATILE trigger ziet de net gecommitte vrijgave)',
  a LIKE 'ok: ok: released|f|%' AND b LIKE 'ok: fout [42501] Deze banktransactie is vrijgegeven%', a || ' || ' || b) FROM proof.race WHERE n = 'R5';

-- ── R6: vrijgeven ↔ koppeling vanuit Facturen ───────────────────────────────
SELECT proof.race('R6', format('SELECT proof.rel(proof.u(1), proof.uid(1000, 707), %L::uuid, proof.req(72061))', proof.g(707)),
  format($q$SELECT proof.call(proof.u(1), 'INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id) VALUES (%s, ''inkoop'', %s, ''00000000-0000-0000-0000-0000000000c1'', 121.00, %s) RETURNING id::text')$q$,
         proof.ql2(proof.uid(1000, 707)), proof.ql2(proof.uid(2000, 706)), proof.ql2(proof.u(1))));
SELECT proof.record('R6a', 'R6 de koppeling wacht (KEY SHARE tegenover FOR UPDATE)', waited IN ('transactionid', 'tuple'), waited) FROM proof.race WHERE n = 'R6';
SELECT proof.record('R6b', 'R6 en wordt daarna geweigerd: geen koppeling op een vrijgegeven regel',
  a LIKE 'ok: ok: released|f|%' AND b LIKE 'ok: fout [23514] Deze banktransactie is vrijgegeven%'
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 707)),
  a || ' || ' || b) FROM proof.race WHERE n = 'R6';

-- ── R7: koppeling ↔ eerste boeking ──────────────────────────────────────────
SELECT proof.race('R7a',
  format($q$SELECT proof.call(proof.u(1), 'INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id) VALUES (%s, ''inkoop'', %s, ''00000000-0000-0000-0000-0000000000c1'', 121.00, %s) RETURNING id::text')$q$,
         proof.ql2(proof.uid(1000, 713)), proof.ql2(proof.uid(2000, 713)), proof.ql2(proof.u(1))),
  proof.rcq(2, 713, NULL, 7, 21, 72071));
SELECT proof.record('R7a', 'R7 koppeling eerst: de eerste boeking wacht', waited IN ('transactionid', 'tuple'), waited) FROM proof.race WHERE n = 'R7a';
SELECT proof.record('R7b', 'R7 en weigert daarna (gekoppeld, 22023); geen directe boeking',
  a LIKE 'ok: ok: %' AND b LIKE 'ok: fout [22023] Deze banktransactie is aan een factuur gekoppeld%' AND proof.marker(proof.uid(1000, 713)) IS NULL,
  a || ' || ' || b) FROM proof.race WHERE n = 'R7a';

SELECT proof.race('R7c', proof.rcq(2, 714, NULL, 7, 21, 72072),
  format($q$SELECT proof.call(proof.u(1), 'INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id) VALUES (%s, ''inkoop'', %s, ''00000000-0000-0000-0000-0000000000c1'', 121.00, %s) RETURNING id::text')$q$,
         proof.ql2(proof.uid(1000, 714)), proof.ql2(proof.uid(2000, 714)), proof.ql2(proof.u(1))));
SELECT proof.record('R7c', 'R7 eerste boeking eerst: de koppeling wacht', waited IN ('transactionid', 'tuple'), waited) FROM proof.race WHERE n = 'R7c';
SELECT proof.record('R7d', 'R7 en wordt daarna door guard 1 (PR 0) geweigerd',
  a LIKE 'ok: ok: posted|f|%' AND b LIKE 'ok: fout [23514] Deze banktransactie is al rechtstreeks%'
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 714)),
  a || ' || ' || b) FROM proof.race WHERE n = 'R7c';

-- ── R8: terugzetten ↔ sjabloon-UPDATE ───────────────────────────────────────
SELECT proof.race('R8', 'SELECT proof.ret(proof.u(1), proof.uid(1000, 708), proof.req(72081))',
  format($q$SELECT proof.call(proof.u(2), 'UPDATE public.bank_transactions SET match_status = ''handmatig_geboekt'', grootboekrekening_id = %s WHERE id = %s RETURNING id::text')$q$,
         proof.ql2(proof.acct(7)), proof.ql2(proof.uid(1000, 708))));
SELECT proof.record('R8a', 'R8 de sjabloon-UPDATE wacht op het terugzetten', waited IN ('transactionid', 'tuple'), waited) FROM proof.race WHERE n = 'R8';
SELECT proof.record('R8b', 'R8 en mag daarna (teruggezet = gewone werkstroom)',
  a LIKE 'ok: ok: returned|f|%' AND b LIKE 'ok: ok: %', a || ' || ' || b) FROM proof.race WHERE n = 'R8';

-- ── R9: herboeken na vrijgave ↔ bulk ────────────────────────────────────────
SELECT proof.race('R9', proof.rcq(1, 709, NULL, 7, 21, 72091),
  format($q$SELECT proof.call(proof.u(1), 'SELECT outcome FROM public.post_bank_transactions_bulk(ARRAY[%s]::uuid[])')$q$, proof.ql2(proof.uid(1000, 709))));
SELECT proof.record('R9a', 'R9 de bulk wacht op de herboeking', waited IN ('transactionid', 'tuple'), waited) FROM proof.race WHERE n = 'R9';
SELECT proof.record('R9b', 'R9 en boekt daarna niet nog eens: precies één actieve groep',
  a LIKE 'ok: ok: reposted_after_release|f|%' AND b NOT LIKE 'ok: ok: posted%'
  AND (SELECT count(DISTINCT lp.posting_group_id) FROM public.ledger_postings lp
       WHERE lp.source_type = 'bank_transaction' AND lp.source_id = proof.uid(1000, 709)
         AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r WHERE r.original_posting_group_id = lp.posting_group_id)) = 1,
  a || ' || ' || b) FROM proof.race WHERE n = 'R9';

-- ── R10: REPEATABLE READ ────────────────────────────────────────────────────
SELECT proof.race('R10', format('SELECT proof.rel(proof.u(1), proof.uid(1000, 711), %L::uuid, proof.req(72101))', proof.g(711)),
  format($q$SELECT proof.call(proof.u(2), 'UPDATE public.bank_transactions SET grootboekrekening_id = %s WHERE id = %s RETURNING id::text')$q$,
         proof.ql2(proof.acct(7)), proof.ql2(proof.uid(1000, 711))),
  'COMMIT', 'BEGIN ISOLATION LEVEL REPEATABLE READ');
SELECT proof.record('R10a', 'R10 een updater onder REPEATABLE READ tegen een vrijgave: 40001 (fail closed)',
  a LIKE 'ok: ok: released|f|%' AND b LIKE 'ok: fout [40001]%', a || ' || ' || b) FROM proof.race WHERE n = 'R10';

SELECT dblink_exec('a', 'BEGIN ISOLATION LEVEL REPEATABLE READ');
SELECT proof.put('R10b', proof.remote_run('a', proof.rcq(1, 712, proof.g(712), 7, 21, 72102)));
SELECT dblink_exec('a', 'ROLLBACK');
SELECT proof.record('R10b', 'R10 de RPC zelf onder REPEATABLE READ: 25000, vóór er iets gelezen of gegrendeld wordt',
  proof.get('R10b') LIKE 'ok: fout [25000] Een bankcorrectie kan alleen in een READ COMMITTED transactie%', proof.get('R10b'));

-- ── R11: correctie ↔ boekingsblokkade ───────────────────────────────────────
SELECT proof.race('R11a',
  $$SELECT proof.call(proof.u(1), 'SELECT changed::text FROM public.set_posting_lock(''00000000-0000-0000-0000-0000000000c1'', DATE ''2027-03-31'', ''Race'')')$$,
  proof.rcq(1, 715, proof.g(715), 7, 9, 72111));
SELECT proof.record('R11a', 'R11 blokkade eerst: de correctie wacht op de administratiegrendel', waited = 'advisory', waited) FROM proof.race WHERE n = 'R11a';
SELECT proof.record('R11b', 'R11 en weigert daarna op de net gezette blokkade (22023)',
  b LIKE 'ok: fout [22023] Boekingsdatum%', b) FROM proof.race WHERE n = 'R11a';
SELECT proof.call(proof.u(1), $$SELECT changed::text FROM public.set_posting_lock('00000000-0000-0000-0000-0000000000c1', NULL, 'Race voorbij')$$);

SELECT proof.race('R11c', proof.rcq(1, 716, proof.g(716), 7, 9, 72112),
  $$SELECT proof.call(proof.u(1), 'SELECT changed::text FROM public.set_posting_lock(''00000000-0000-0000-0000-0000000000c1'', DATE ''2027-03-31'', ''Race'')')$$);
SELECT proof.record('R11c', 'R11 correctie eerst: de blokkade wacht', waited = 'advisory', waited) FROM proof.race WHERE n = 'R11c';
SELECT proof.record('R11d', 'R11 en wordt daarna gezet; de correctie staat vóór de blokkade vast',
  a LIKE 'ok: ok: reclassified|f|%' AND b LIKE 'ok: ok: %', a || ' || ' || b) FROM proof.race WHERE n = 'R11c';
SELECT proof.call(proof.u(1), $$SELECT changed::text FROM public.set_posting_lock('00000000-0000-0000-0000-0000000000c1', NULL, 'Race voorbij')$$);

-- ── R12: twee regels van dezelfde administratie ─────────────────────────────
SELECT proof.race('R12', proof.rcq(1, 717, proof.g(717), 7, 21, 72121), proof.rcq(5, 718, proof.g(718), 7, 21, 72122));
SELECT proof.record('R12a', 'R12 de tweede wacht alleen op de administratiegrendel en slaagt daarna; geen deadlock',
  waited = 'advisory' AND a LIKE 'ok: ok: reclassified|f|%' AND b LIKE 'ok: ok: reclassified|f|%', concat_ws(' || ', waited, a, b))
FROM proof.race WHERE n = 'R12';

-- ── R13: de bestaande cyclus bulk ↔ T→L ─────────────────────────────────────
-- b: bulk [719, 720] boekt 719 (houdt L) en wil dan T(720); a houdt T(720) en wil L.
SELECT proof.tx(722, -10.00);
UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = proof.acct(7) WHERE id = proof.uid(1000, 722);
SELECT dblink_exec('a', 'BEGIN');
SELECT proof.remote_run('a', format('SELECT id::text FROM public.bank_transactions WHERE id = %L FOR UPDATE', proof.uid(1000, 720)));
SELECT dblink_exec('b', 'BEGIN');
SELECT dblink_send_query('b', format($q$SELECT proof.call(proof.u(1), 'SELECT string_agg(outcome || '':'' || coalesce(error_code, ''''), '','' ORDER BY ordinal) FROM public.post_bank_transactions_bulk(ARRAY[%s, %s]::uuid[])')$q$,
                                     proof.ql2(proof.uid(1000, 722)), proof.ql2(proof.uid(1000, 720))));
SELECT proof.until_waiting('b');
SELECT dblink_send_query('a', proof.rcq(1, 720, proof.g(720), 7, 9, 72131));

/** Wie van de twee eerst klaar is (de andere wacht op diens grendels), wordt
    eerst uitgelezen en gecommit; daarna de ander. */
CREATE FUNCTION proof.settle(_n text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i integer; v_a text; v_b text;
BEGIN
  FOR i IN 1..200 LOOP
    EXIT WHEN dblink_is_busy('a') = 0 OR dblink_is_busy('b') = 0;
    PERFORM pg_sleep(0.05);
  END LOOP;
  IF dblink_is_busy('a') = 0 THEN
    v_a := proof.remote_outcome('a'); PERFORM proof.remote_exec('a', 'COMMIT');
    v_b := proof.remote_outcome('b'); PERFORM proof.remote_exec('b', 'COMMIT');
  ELSE
    v_b := proof.remote_outcome('b'); PERFORM proof.remote_exec('b', 'COMMIT');
    v_a := proof.remote_outcome('a'); PERFORM proof.remote_exec('a', 'COMMIT');
  END IF;
  INSERT INTO proof.race (n, a, b) VALUES (_n, v_a, v_b);
END $$;
GRANT EXECUTE ON FUNCTION proof.settle(text) TO public;

SELECT proof.settle('R13');
SELECT proof.record('R13a', 'R13 de cyclus wordt door PostgreSQL gebroken met precies één 40P01: óf de RPC valt terug, óf de bulk meldt die regel als rejected',
  ((a LIKE 'ok: fout [40P01]%') <> (b LIKE '%rejected:40P01%'))
  AND b LIKE 'ok: ok: posted:%' AND b NOT LIKE '%,posted:%',
  a || ' || ' || b) FROM proof.race WHERE n = 'R13';
SELECT proof.record('R13b', 'R13 en niets half: regel 720 heeft precies één actieve groep, alles in balans, lineage compleet',
  (SELECT count(DISTINCT lp.posting_group_id) FROM public.ledger_postings lp
   WHERE lp.source_type = 'bank_transaction' AND lp.source_id = proof.uid(1000, 720)
     AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r WHERE r.original_posting_group_id = lp.posting_group_id)) = 1
  AND proof.unbalanced() = 0 AND proof.lineage_violations() = 0);

SELECT proof.record('RZ', 'na alle races: alles in balans en de lineage compleet', proof.unbalanced() = 0 AND proof.lineage_violations() = 0,
  format('uit balans %s, lineage %s', proof.unbalanced(), proof.lineage_violations()));

SELECT dblink_disconnect('a');
SELECT dblink_disconnect('b');

-- Voor rollback.sql: één vrijgegeven regel (S3) en één geboekte regel (S1).
SELECT proof.tx(950, -121.00), proof.tx(951, -121.00);
SELECT proof.put('c950', proof.rc(proof.u(2), proof.uid(1000, 950), NULL, proof.acct(7), 21, proof.req(9500)));
SELECT proof.put('c950r', proof.rel(proof.u(1), proof.uid(1000, 950), proof.f(proof.get('c950'), 3)::uuid, proof.req(9501)));
SELECT proof.put('c951', proof.rc(proof.u(2), proof.uid(1000, 951), NULL, proof.acct(7), 21, proof.req(9510)));
