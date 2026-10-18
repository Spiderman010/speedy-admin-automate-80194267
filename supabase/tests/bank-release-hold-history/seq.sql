-- Z — DE VIER TOESTANDEN, OP PRODUCTIEGELIJKE GESCHIEDENIS. Throwaway database only.
--
-- Database 2 heeft precies de ene historische storno (prodlike.sql). De
-- migraties zijn hier los na elkaar toegepast (PR 1, PR 2, fix) — de
-- volgorde die in productie NIET mag (zie uitvoerplan.md) — om elke
-- tussentoestand van de uitrolcontroles te laten zien:
--   (a) een aantoonbaar veilige historische storno: PRE 4 geen STOP, PRE 4b bewezen
--   (b) een werkelijk ontbrekende of inconsistente marker: STOP (database 1, P1/P3, Q1)
--   (c) de tijdelijke toestand vóór de fix: POST 8 'TIJDELIJK' (na PR 1 en na PR 2)
--   (d) de definitieve toestand na alle drie: POST 8 'IN ORDE', POST C4/C5 in orde
-- Plus: de fix vóór PR 2 wordt geweigerd, en in toestand (c) bestaat het gat echt.
-- De tabellen z_* zijn door run-proof.sh letterlijk uit de rolloutbestanden vastgelegd.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['Z1','Z2','Z3','Z4','Z5','Z6','Z7','Z8']);

SELECT proof.record('Z1', '(a) PRE 4: één bewezen historische storno, niets onverklaard — geen STOP voor de gecombineerde uitrol, wél STOP voor PR 1 los',
  afwijkende_vorm = 0 AND bankgroepen_zonder_marker = 1 AND waarvan_historische_storno = 1 AND waarvan_onverklaard = 0 AND NOT stop AND stop_losse_uitrol,
  format('%s/%s/%s/%s/%s/%s', afwijkende_vorm, bankgroepen_zonder_marker, waarvan_historische_storno, waarvan_onverklaard, stop, stop_losse_uitrol))
FROM proof.z_pre4;

SELECT proof.record('Z2', '(a) PRE 4b: die ene groep, elk bewijsstuk waar, "alleen via de gecombineerde uitrol"',
  (SELECT count(*) FROM proof.z_pre4b) = 1 AND bewezen AND toestand LIKE 'bewezen historische storno — alleen via de gecombineerde uitrol%',
  toestand)
FROM proof.z_pre4b;

SELECT proof.record('Z3', '(c) direct na PR 1: POST 8 = TIJDELIJK (hold van PR 1, één historische storno)',
  waarvan_historische_storno = 1 AND waarvan_onverklaard = 0 AND hold_versie = 'PR 1' AND toestand LIKE 'TIJDELIJK%', toestand)
FROM proof.z_post8_m1;

SELECT proof.record('Z4', 'de fix direct na PR 1 (zonder PR 2) wordt geweigerd: 55000 "PR 2 (20261018150000) is niet toegepast", en er veranderde niets',
  proof.get('z_fix_te_vroeg') LIKE '%PR 2 (20261018150000) is niet toegepast%'
  AND proof.get('z_catalog_na_weigering') = proof.get('z_catalog_m1'),
  proof.get('z_fix_te_vroeg'));

SELECT proof.record('Z5', '(c) na PR 2: POST 8 nog steeds TIJDELIJK',
  hold_versie = 'PR 1' AND toestand LIKE 'TIJDELIJK%', toestand)
FROM proof.z_post8_m2;

SELECT proof.record('Z6', '(c) in die tussentoestand bestaat het gat echt: na vrijgeven codeert de app de historische regel (teruggedraaid)',
  proof.get('z_gat') LIKE 'ok: released|f||% || ok: %', proof.get('z_gat'));

SELECT proof.record('Z7', '(d) na de fix: POST 8 = IN ORDE (hold van de fix, één historische storno, niets onverklaard)',
  waarvan_historische_storno = 1 AND waarvan_onverklaard = 0 AND gebeurtenissen = 0 AND hold_versie = '20261018180000' AND toestand = 'IN ORDE',
  toestand)
FROM proof.z_post8_m3;

SELECT proof.record('Z8', '(d) POST C4: één rij, bewezen historisch; POST C5: de hold dekt de regel na een vrijgave',
  (SELECT count(*) FROM proof.z_postc4) = 1 AND (SELECT bool_and(bewezen_historisch AND NOT vervangen) FROM proof.z_postc4)
  AND (SELECT count(*) FROM proof.z_postc5) = 1 AND (SELECT bool_and(hold_dekt_na_vrijgave) FROM proof.z_postc5));
