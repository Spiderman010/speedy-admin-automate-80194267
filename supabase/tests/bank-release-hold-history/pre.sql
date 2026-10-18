-- P — DE UITROLCONTROLES VÓÓR PR 1, LETTERLIJK UIT DE ROLLOUTBESTANDEN. Throwaway database only.
--
-- :'pre4', :'pre4b' en :'preb6' zijn de blokken PRE 4 en PRE 4b uit
-- supabase/rollout/20261018120000_…/preflight.sql en PRE B6 uit
-- supabase/rollout/20261018180000_…/preflight.sql, zonder wijziging.
-- :'pre4_oud' is PRE 4 zoals die op main stond vóór deze PR (commit 3669a94).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

SELECT proof.plan(ARRAY['P0', 'P1', 'P2', 'P3a', 'P3b', 'P3c', 'P3d', 'P3e', 'P3f', 'P3g', 'P3h', 'P3i', 'P3j', 'P3k', 'P3l', 'P3m', 'P3n', 'P3o', 'P4']);

-- De grootboekhistorie van vóór PR 1, voor de append-only-toets aan het eind (I4).
CREATE TABLE proof.ledger_before_pr1 AS SELECT * FROM public.ledger_postings;
CREATE TABLE proof.reversals_before_pr1 AS SELECT * FROM public.ledger_reversal_postings;
GRANT SELECT ON proof.ledger_before_pr1, proof.reversals_before_pr1 TO public;

SELECT proof.capture('pre4_oud', :'pre4_oud');
SELECT proof.record('P0', 'de oorspronkelijke PRE 4 (main 3669a94) geeft voor deze geschiedenis STOP, zonder onderscheid — zoals in productie',
  stop AND afwijkende_vorm = 0 AND bankgroepen_zonder_marker = 25, format('%s/%s/%s', afwijkende_vorm, bankgroepen_zonder_marker, stop))
FROM proof.pre4_oud;

SELECT proof.capture('pre4', :'pre4');
SELECT proof.capture('pre4b', :'pre4b');

SELECT proof.record('P1', 'PRE 4: vorm in orde, 25 groepen zonder marker — 11 bewezen historische storno''s en 14 onverklaard — dus STOP',
  afwijkende_vorm = 0 AND bankgroepen_zonder_marker = 25 AND waarvan_historische_storno = 11 AND waarvan_onverklaard = 14 AND stop,
  format('%s/%s/%s/%s/%s', afwijkende_vorm, bankgroepen_zonder_marker, waarvan_historische_storno, waarvan_onverklaard, stop))
FROM proof.pre4;

SELECT proof.record('P2', 'PRE 4b: elke geldige historische groep (10–19, bij 15 twee) is bewezen, met elk bewijsstuk waar',
  (SELECT count(*) FROM proof.pre4b b
   WHERE b.banktransactie IN (SELECT proof.uid(1000, n) FROM unnest(ARRAY[10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) n)
     AND b.bewezen AND b.b1_zelfde_transactie AND b.b2_reversalketen AND b.b3_transactiedatum AND b.b4_neutraal
     AND b.b5_storno_geldig AND b.b6_actuele_marker_daarna
     AND b.toestand LIKE 'bewezen historische storno%') = 11
  AND (SELECT count(*) FROM proof.pre4b b
       WHERE b.banktransactie IN (SELECT proof.uid(1000, n) FROM unnest(ARRAY[10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) n)) = 11);

/** Rij van PRE 4b voor testregel _n, als "b1b2b3b4b5b6/bewezen". */
CREATE FUNCTION proof.p4b(_n integer) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT string_agg(concat(b.b1_zelfde_transactie::int, b.b2_reversalketen::int, b.b3_transactiedatum::int, b.b4_neutraal::int,
                           b.b5_storno_geldig::int, b.b6_actuele_marker_daarna::int, '/', b.bewezen::int), ',' ORDER BY b.groep)
  FROM proof.pre4b b WHERE b.banktransactie = proof.uid(1000, _n);
$$;
GRANT EXECUTE ON FUNCTION proof.p4b(integer) TO public;

SELECT proof.record('P3a', '20 niet gestorneerd: onverklaard, "STOP — niet gestorneerd"',
  proof.p4b(20) LIKE '10%/0' AND (SELECT toestand FROM proof.pre4b WHERE banktransactie = proof.uid(1000, 20)) = 'STOP — niet gestorneerd', proof.p4b(20));
SELECT proof.record('P3b', '21 storno op een latere datum: alleen de datum onwaar',            proof.p4b(21) = '110111/0', proof.p4b(21));
SELECT proof.record('P3c', '22 geen nieuwe boeking en geen marker: "STOP — geen actuele marker"',
  proof.p4b(22) = '111110/0' AND (SELECT toestand FROM proof.pre4b WHERE banktransactie = proof.uid(1000, 22)) = 'STOP — geen actuele marker', proof.p4b(22));
SELECT proof.record('P3d', '23 storno zelf tegengeboekt: alleen "storno geldig" onwaar',      proof.p4b(23) = '111101/0', proof.p4b(23));
SELECT proof.record('P3e', '24 niet neutraal: alleen "neutraal" onwaar',                       proof.p4b(24) = '111011/0', proof.p4b(24));
SELECT proof.record('P3f', '25 regel van een andere transactie: "zelfde transactie" onwaar (ook onder 26)',
  proof.p4b(25) = '011111/0' AND proof.p4b(26) LIKE '0%/0', concat(proof.p4b(25), ' | ', proof.p4b(26)));
SELECT proof.record('P3g', '27 origineel op een andere datum: alleen de datum onwaar',          proof.p4b(27) = '110111/0', proof.p4b(27));
SELECT proof.record('P3h', '28 claim op een andere datum: alleen de datum onwaar',              proof.p4b(28) = '110111/0', proof.p4b(28));
SELECT proof.record('P3i', '29 storno mist een regel: reversalketen (en daardoor neutraliteit) onwaar', proof.p4b(29) = '101011/0', proof.p4b(29));
SELECT proof.record('P3j', '30 stornoregel zonder verwijzing: alleen de reversalketen onwaar',  proof.p4b(30) = '101111/0', proof.p4b(30));
SELECT proof.record('P3k', '31 claim van een andere bronsoort: alleen de reversalketen onwaar', proof.p4b(31) = '101111/0', proof.p4b(31));
SELECT proof.record('P3m', '32 stornoregel keert een regel van een andere groep om: alleen de reversalketen onwaar', proof.p4b(32) = '101111/0', proof.p4b(32));
SELECT proof.record('P3n', '33 stornoregel met een andere bron: alleen de reversalketen onwaar', proof.p4b(33) = '101111/0', proof.p4b(33));
SELECT proof.record('P3o', '34 stornoregels op een andere datum: alleen de datum onwaar', proof.p4b(34) = '110111/0', proof.p4b(34));
SELECT proof.record('P3l', 'de gewone regels 40 en 41 staan niet in PRE 4b',
  NOT EXISTS (SELECT 1 FROM proof.pre4b WHERE banktransactie IN (proof.uid(1000, 40), proof.uid(1000, 41))));

SELECT proof.capture('preb6', :'preb6');
SELECT proof.record('P4', 'PRE B6 (de bekende productiestorno) geeft hier STOP: de bekende groepen ontbreken en er is onverklaarde geschiedenis',
  stop AND NOT bekende_storno_bewezen AND onverklaard = 14, format('%s/%s/%s/%s', bewezen, onverklaard, bekende_storno_bewezen, stop))
FROM proof.preb6;
