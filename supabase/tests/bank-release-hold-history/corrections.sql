-- S — REGULIERE CORRECTIES NA DE FIX: NIETS ONBEDOELD GEBLOKKEERD. Throwaway database only.
--
-- Op historische regels (11, 12, 18) en op gewone regels (40, 41): elke
-- route van de correctie-RPC werkt zoals onder PR 1/PR 2 — en de historische
-- groep blijft daarbij bewezen geschiedenis, ook ná de eerste gebeurtenissen.
-- Een lopende correctie (marker net los, gebeurtenis volgt) gaat in elk van
-- deze aanroepen door de hold heen; F2 (window.sql) toont dat ook voor een
-- vrijgegeven regel.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['S1a','S1b','S1c','S2','S3','S4','S5','S6','S7','S8']);

-- S1: een historische regel corrigeren (S1: actieve groep, andere rekening).
SELECT proof.record('S1a', 'historisch (12), S1 door een assistent: geweigerd (accountant vereist) — zoals onder PR 1',
  o LIKE 'fout [42501] Geen rechten om een geboekte banktransactie te corrigeren%', o)
FROM proof.rc(proof.u(2), proof.uid(1000, 12), proof.m(12), proof.acct(6), 0, proof.req(12001), 'Assistent') o;

SELECT proof.put('s_g12', proof.m(12)::text);
SELECT proof.put('s_rc12', proof.rc(proof.u(1), proof.uid(1000, 12), proof.m(12), proof.acct(6), 0, proof.req(12002), 'Naar 8250'));
SELECT proof.record('S1b', 'historisch (12), S1 door de accountant: storno + herboeking op 8250; bank € 500 precies één keer; bankregel byte-gelijk',
  proof.get('s_rc12') LIKE format('ok: reclassified|f|%%|%s|%%', proof.get('s_g12'))
  AND proof.net(proof.uid(1000, 12), proof.acct(1)) = -500.00 AND proof.net(proof.uid(1000, 12), proof.acct(6)) = 500.00
  AND proof.net(proof.uid(1000, 12), proof.acct(7)) = 0 AND proof.intact(12),
  proof.get('s_rc12'));
SELECT proof.record('S1c', 'de historische groep van 12 blijft daarna bewezen geschiedenis (ouder dan de eerste gebeurtenis), de vervangen groep niet',
  proof.settled(12, proof.h_orig(12)) AND NOT proof.settled(12, proof.get('s_g12')::uuid));

-- S2: de actieve groep was al vóór PR 1 handmatig gestorneerd (marker behouden).
SELECT proof.put('s_g18', proof.m(18)::text);
SELECT proof.put('s_rc18', proof.rc(proof.u(1), proof.uid(1000, 18), proof.m(18), proof.acct(6), 0, proof.req(18001), 'Opnieuw boeken'));
SELECT proof.record('S2', 'historisch (18), S2: herboekt zonder tweede storno; bank € 60,50 precies één keer',
  proof.get('s_rc18') LIKE 'ok: reposted|f|%'
  AND (SELECT count(*) FROM public.ledger_reversal_postings WHERE original_posting_group_id = proof.get('s_g18')::uuid) = 1
  AND proof.net(proof.uid(1000, 18), proof.acct(1)) = -60.50 AND proof.intact(18) AND proof.settled(18, proof.h_orig(18)),
  proof.get('s_rc18'));

-- S3 / S4: dezelfde codering (unchanged), daarna BTW 21 → 9.
SELECT proof.put('s_un11', proof.rc(proof.u(1), proof.uid(1000, 11), proof.m(11), proof.acct(7), 21, proof.req(11001), 'Controle'));
SELECT proof.record('S3', 'historisch (11), dezelfde codering: unchanged — geen nieuwe groep',
  proof.get('s_un11') LIKE 'ok: unchanged|f|%' AND proof.group_count(11) = 2, proof.get('s_un11'));
SELECT proof.put('s_btw11', proof.rc(proof.u(1), proof.uid(1000, 11), proof.m(11), proof.acct(7), 9, proof.req(11002), 'BTW 9%'));
SELECT proof.record('S4', 'historisch (11, geld erbij), BTW 21 → 9: bedragen juist (121 → 111,01 + 9,99)',
  proof.get('s_btw11') LIKE 'ok: reclassified|f|%'
  AND proof.net(proof.uid(1000, 11), proof.acct(1)) = 121.00 AND proof.net(proof.uid(1000, 11), proof.acct(7)) = -111.01
  AND proof.net(proof.uid(1000, 11), proof.acct(5)) = -9.99 AND proof.intact(11),
  proof.get('s_btw11'));

-- S5: na een correctie opnieuw vrijgeven: de hold dekt.
SELECT proof.put('s_rel12', proof.rel(proof.u(1), proof.uid(1000, 12), proof.m(12), proof.req(12003), 'Vrijgeven na correctie'));
SELECT proof.record('S5', 'historisch (12), na de correctie vrijgegeven: de app is dicht',
  proof.get('s_rel12') LIKE 'ok: released|f||%' AND o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', proof.get('s_rel12') || ' || ' || o)
FROM proof.app_code(12) o;

-- S6 / S7: gewone regels.
SELECT proof.put('s_s0', proof.rc(proof.u(2), proof.uid(1000, 40), NULL, proof.acct(7), 0, proof.req(40001)));
SELECT proof.record('S6', 'gewoon (40), eerste boeking via de RPC (S0) door een assistent: posted',
  proof.get('s_s0') LIKE 'ok: posted|f|%' AND proof.net(proof.uid(1000, 40), proof.acct(1)) = -40.00, proof.get('s_s0'));
SELECT proof.put('s_s3', proof.rc(proof.u(1), proof.uid(1000, 41), NULL, proof.acct(7), 0, proof.req(41002), 'Opnieuw boeken'));
SELECT proof.record('S7', 'gewoon (41, vrijgegeven in N5), "Opnieuw boeken" (S3): herboekt',
  proof.get('s_s3') LIKE 'ok: reposted_after_release|f|%' AND proof.net(proof.uid(1000, 41), proof.acct(1)) = -41.00, proof.get('s_s3'));

SELECT proof.expect_true('S8', 'elke directe bankgroep van deze regels is actief, precies één keer vervangen of bewezen geschiedenis', $$
  proof.hist_lineage_violations(ARRAY[10, 11, 12, 13, 16, 18, 40, 41]) = 0 $$);
