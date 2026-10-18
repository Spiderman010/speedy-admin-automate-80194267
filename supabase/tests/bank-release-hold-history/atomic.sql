-- A — HET UITVOERPLAN VOOR PRODUCTIE, OP PRODUCTIEGELIJKE GESCHIEDENIS. Throwaway database only.
--
-- Database 3 heeft precies de bekende historische storno, met de groeps-id's
-- uit productie (prodlike.sql, -v known=1). run-proof.sh heeft hier:
--   1. preflight.sql van PR 1 en van de fix VOLLEDIG gedraaid in een
--      read-only transactie (default_transaction_read_only = on) — en elk
--      STOP-blok letterlijk vastgelegd (a_*);
--   2. uitvoering.sql opdracht voor opdracht gedraaid (zoals een editor die
--      splitst): geweigerd vóór de eerste migratie;
--   3. uitvoering.sql als één uitvoering terwijl een andere sessie een
--      rijgrendel op bank_transactions vasthield: lock_timeout, niets toegepast;
--   4. uitvoering.sql met een gesaboteerde eindcontrole: niets toegepast,
--      óók niet de drie migraties die al waren gelopen;
--   5. uitvoering.sql als één uitvoering (zoals de editor): voltooid;
--   6. postcheck.sql van PR 1, PR 2 en de fix VOLLEDIG read-only gedraaid en
--      elk blok vastgelegd (p1_*, p2_*, c_*).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY[
  'A0','A1','A2','A3','A4','A5','A6','A7','A8','A9','A10','A11','A12',
  'A20','A21','A22','A23',
  'A30','A31','A32','A33','A34','A35','A36','A37','A38','A39','A40','A41','A42','A43','A44','A45','A46','A47']);

/** Heeft elke rij van tabel _t in elke booleaanse kolom (behalve _except) de waarde _v? En is er minstens één rij? */
CREATE FUNCTION proof.all_bools(_t text, _v boolean, _except text[] DEFAULT '{}') RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v boolean; n integer;
BEGIN
  EXECUTE format('SELECT count(*) FROM proof.%I', _t) INTO n;
  EXECUTE format($q$SELECT coalesce(bool_and((e.value)::text::boolean = %L), false)
                    FROM proof.%I t, jsonb_each(to_jsonb(t)) e
                    WHERE jsonb_typeof(e.value) = 'boolean' AND NOT (e.key = ANY (%L::text[]))$q$, _v, _t, _except) INTO v;
  RETURN n > 0 AND v;
END $$;
GRANT EXECUTE ON FUNCTION proof.all_bools(text, boolean, text[]) TO public;

-- ── vóór de uitvoering ──────────────────────────────────────────────────────
SELECT proof.record('A0', 'de bekende historische storno staat er met de productie-id''s (nagebootst); verder alleen gewone regels',
  proof.h_orig(10) = 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a' AND proof.storno_of(proof.h_orig(10)) = 'ff598a0f-e4e3-4b82-968a-9666b54c5ad8'
  AND proof.m(10) = '0b1aec4c-1bd1-42f3-b392-6a6125da98e3');
SELECT proof.record('A1', 'beide preflight.sql-bestanden draaien foutloos in een read-only transactie (ze schrijven niets)',
  proof.get('a_pre_readonly') = 'ok', proof.get('a_pre_readonly'));
SELECT proof.record('A2', 'PRE 1 (PR 1): elke kolom waar', proof.all_bools('a_pre1', true));
SELECT proof.record('A3', 'PRE 2 (PR 1): 11 rijen, gelijk', proof.all_bools('a_pre2', true) AND (SELECT count(*) FROM proof.a_pre2) = 11);
SELECT proof.record('A4', 'PRE 4 (PR 1): geen STOP — één bewezen historische storno, niets onverklaard',
  NOT stop AND afwijkende_vorm = 0 AND waarvan_historische_storno = 1 AND waarvan_onverklaard = 0,
  format('%s/%s/%s/%s', afwijkende_vorm, waarvan_historische_storno, waarvan_onverklaard, stop))
FROM proof.a_pre4;
SELECT proof.record('A5', 'PRE 4b (PR 1): één rij — de bekende groep, storno en actuele groep — bewezen',
  (SELECT count(*) FROM proof.a_pre4b) = 1 AND bewezen AND groep = 'fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a'
  AND storno = 'ff598a0f-e4e3-4b82-968a-9666b54c5ad8' AND actuele_groep = '0b1aec4c-1bd1-42f3-b392-6a6125da98e3', toestand)
FROM proof.a_pre4b;
SELECT proof.record('A6', 'PRE 8 (PR 1): de editorrol is eigenaar van schrijvers en tabellen', proof.all_bools('a_pre8', true));
SELECT proof.record('A7', 'PRE 11 (PR 1): geen onbekende trigger', NOT stop) FROM proof.a_pre11;
SELECT proof.record('A8', 'PRE B1: niets van PR 1, PR 2 of de fix; PR 0 toegepast', proof.all_bools('a_b1', true));
SELECT proof.record('A9', 'PRE B2 en B5: de schrijver exact beoordeeld, de editorrol is haar eigenaar',
  proof.all_bools('a_b2', true) AND proof.all_bools('a_b5', true));
SELECT proof.record('A10', 'PRE B3 en B4: de vier bekende triggers, geen RULE, geen publicatie',
  proof.all_bools('a_b3', true, ARRAY['stop']) AND proof.all_bools('a_b3', false, ARRAY['bekend']) AND (SELECT count(*) FROM proof.a_b3) = 4
  AND (SELECT NOT stop FROM proof.a_b4));
SELECT proof.record('A11', 'PRE B6: precies de bekende historische storno, niets anders — geen STOP',
  NOT stop AND bewezen = 1 AND onverklaard = 0 AND bekende_storno_bewezen AND andere_bewezen = 0,
  format('%s/%s/%s/%s/%s', bewezen, onverklaard, bekende_storno_bewezen, andere_bewezen, stop))
FROM proof.a_b6;
SELECT proof.record('A12', 'PRE B7: geen lopende applicatieverzoeken; PRE B9: de proef op één transactie slaagt bij één uitvoering en faalt bij losse opdrachten',
  (SELECT count(*) FROM proof.a_b7) = 0 AND proof.get('a_b9_een') = '4321ms|t' AND proof.get('a_b9_los') = '0|f',
  concat_ws(' / ', proof.get('a_b9_een'), proof.get('a_b9_los')));

-- ── geweigerde of mislukte uitvoeringen: niets toegepast ───────────────────
SELECT proof.record('A20', 'uitvoering.sql opdracht voor opdracht (een editor die splitst): geweigerd vóór de eerste migratie',
  proof.get('a_split') LIKE '%Uitrol geweigerd: deze uitvoering is niet één transactie%'
  AND proof.get('a_split_catalog') = proof.get('a_catalog_pre'), left(proof.get('a_split'), 200));
SELECT proof.record('A21', 'één uitvoering terwijl de app een grendel op bank_transactions vasthoudt: lock_timeout na 5 s, niets toegepast',
  proof.get('a_lock') LIKE '%lock timeout%' AND proof.get('a_lock_catalog') = proof.get('a_catalog_pre'), left(proof.get('a_lock'), 200));
SELECT proof.record('A22', 'een fout ná alle drie migraties (gesaboteerde eindcontrole): alles teruggedraaid, ook PR 1 en PR 2',
  proof.get('a_sabotage') LIKE '%Uitrol geweigerd: na de drie migraties is de eindtoestand niet de beoordeelde%'
  AND proof.get('a_sabotage_catalog') = proof.get('a_catalog_pre'), left(proof.get('a_sabotage'), 200));
SELECT proof.record('A23', 'en geen enkele rij veranderde door de drie mislukte pogingen', proof.get('a_digest_na_pogingen') = proof.get('a_digest_pre'));

-- ── na de ene uitvoering ────────────────────────────────────────────────────
SELECT proof.record('A30', 'uitvoering.sql als één uitvoering: voltooid (laatste uitkomst), nul gebeurtenissen',
  proof.get('a_uitkomst') LIKE 'gecombineerde uitrol voltooid|%|0', proof.get('a_uitkomst'));
SELECT proof.record('A31', 'alle drie postcheck.sql-bestanden draaien foutloos in een read-only transactie',
  proof.get('a_post_readonly') = 'ok', proof.get('a_post_readonly'));
SELECT proof.record('A32', 'POST 1 (PR 1): tien functies exact en veilig — reclassify in de versie van PR 2, de hold in die van de fix',
  proof.all_bools('p1_post1', true) AND (SELECT count(*) FROM proof.p1_post1) = 10
  AND (SELECT count(*) FROM proof.p1_post1 WHERE lichaam_versie <> 'PR 1') = 2,
  (SELECT string_agg(lichaam_versie, ',' ORDER BY lichaam_versie) FROM proof.p1_post1));
SELECT proof.record('A33', 'POST 2 (PR 1): negen triggers exact', proof.all_bools('p1_post2', true) AND (SELECT count(*) FROM proof.p1_post2) = 9);
SELECT proof.record('A34', 'POST 3 (PR 1): de gebeurtenistabel leeg, alleen lezen, RLS', proof.all_bools('p1_post3', true));
SELECT proof.record('A35', 'POST 4 (PR 1): de PR H-functies en PR 0-guards onaangeroerd', proof.all_bools('p1_post4', true));
SELECT proof.record('A36', 'POST 5 (PR 1): markers blijven alleen lezen voor de app', proof.all_bools('p1_post5', false));
SELECT proof.record('A37', 'POST 6 (PR 1): elke rij letterlijk gelijk aan PRE 6',
  NOT EXISTS (SELECT * FROM proof.a_pre6 EXCEPT SELECT * FROM proof.p1_post6)
  AND NOT EXISTS (SELECT * FROM proof.p1_post6 EXCEPT SELECT * FROM proof.a_pre6));
SELECT proof.record('A38', 'POST 7 (PR 1): functies + 11 (gecombineerd), triggers + 9, tabellen/sequences/policies + 1, de rest letterlijk gelijk',
  q.publieke_functies = p.publieke_functies + 11 AND q.triggers_public = p.triggers_public + 9
  AND q.tabellen = p.tabellen + 1 AND q.sequences = p.sequences + 1 AND q.policies = p.policies + 1
  AND q.functies_buiten_public = p.functies_buiten_public AND q.event_triggers = p.event_triggers
  AND q.bestaande_relaties_digest = p.bestaande_relaties_digest AND q.bestaande_policies_digest = p.bestaande_policies_digest
  AND q.bestaande_functies_digest = p.bestaande_functies_digest AND q.bestaande_triggers_digest = p.bestaande_triggers_digest,
  format('functies %s→%s, triggers %s→%s', p.publieke_functies, q.publieke_functies, p.triggers_public, q.triggers_public))
FROM proof.a_pre7 p, proof.p1_post7 q;
SELECT proof.record('A39', 'POST 8 (PR 1): IN ORDE — de hold van de fix, één historische storno, niets onverklaard, geen gebeurtenissen',
  toestand = 'IN ORDE' AND waarvan_historische_storno = 1 AND waarvan_onverklaard = 0 AND gebeurtenissen = 0 AND hold_versie = '20261018180000',
  toestand)
FROM proof.p1_post8;
SELECT proof.record('A40', 'POST 1 (PR 2): reclassify exact het PR 2-lichaam, veilig', proof.all_bools('p2_post1', true));
SELECT proof.record('A41', 'POST 2 en 3 (PR 2): de andere PR 1-functies en de vijf triggers gelijk — de hold in de versie van de fix',
  proof.all_bools('p2_post2', true) AND proof.all_bools('p2_post3', true)
  AND (SELECT count(*) FROM proof.p2_post2 WHERE versie = '20261018180000') = 1
  AND (SELECT count(*) FROM proof.p2_post3 WHERE versie = '20261018180000') = 1);
SELECT proof.record('A42', 'POST 4 (PR 2) t.o.v. PRE B8: data gelijk, functies + 11, triggers + 9, 0 gebeurtenissen',
  q.banktransacties = b.banktransacties AND q.bankomschrijvingen_md5 = b.bankomschrijvingen_md5
  AND q.grootboekregels = b.grootboekregels AND q.grootboektekst_md5 = b.grootboektekst_md5
  AND q.gebeurtenissen = 0 AND q.functies_public = b.functies_public + 11 AND q.triggers = b.triggers + 9)
FROM proof.a_b8 b, proof.p2_post4 q;
SELECT proof.record('A43', 'POST C1, C2, C3: hulpfunctie, hold en hold-trigger exact en veilig',
  proof.all_bools('c_c1', true) AND proof.all_bools('c_c2', true) AND proof.all_bools('c_c3', true));
SELECT proof.record('A44', 'POST C4: één rij, de bekende groep, bewezen historisch, niet vervangen',
  (SELECT count(*) FROM proof.c_c4) = 1 AND bekend AND bewezen_historisch AND NOT vervangen)
FROM proof.c_c4;
SELECT proof.record('A45', 'POST C5: de hold dekt de bekende regel na een vrijgave',
  (SELECT count(*) FROM proof.c_c5) = 1 AND hold_dekt_na_vrijgave AND actuele_groep = '0b1aec4c-1bd1-42f3-b392-6a6125da98e3')
FROM proof.c_c5;
SELECT proof.record('A46', 'POST C6 t.o.v. PRE B8: data gelijk, functies + 11, triggers + 9',
  q.banktransacties = b.banktransacties AND q.bankomschrijvingen_md5 = b.bankomschrijvingen_md5
  AND q.grootboekregels = b.grootboekregels AND q.grootboektekst_md5 = b.grootboektekst_md5
  AND q.functies_public = b.functies_public + 11 AND q.triggers = b.triggers + 9)
FROM proof.a_b8 b, proof.c_c6 q;

-- En het gedrag: de regel uit productie is na een vrijgave dicht voor de app; de RPC herboekt haar.
SELECT proof.put('a_rel10', proof.rel(proof.u(1), proof.uid(1000, 10), proof.m(10), proof.req(10101), 'Vrijgeven'));
SELECT proof.put('a_app10', proof.app_code(10));
SELECT proof.put('a_rp10', proof.rc(proof.u(1), proof.uid(1000, 10), NULL, proof.acct(6), 0, proof.req(10102), 'Opnieuw boeken'));
SELECT proof.record('A47', 'na de uitrol: de regel van 25-11-2025 vrijgegeven → de app geweigerd → "Opnieuw boeken" herboekt haar één keer',
  proof.get('a_rel10') LIKE 'ok: released|f||%' AND proof.get('a_app10') LIKE 'fout [42501] Deze banktransactie is vrijgegeven%'
  AND proof.get('a_rp10') LIKE 'ok: reposted_after_release|f|%' AND proof.net(proof.uid(1000, 10), proof.acct(1)) = -3993.00,
  concat_ws(' || ', proof.get('a_rel10'), proof.get('a_app10'), proof.get('a_rp10')));
