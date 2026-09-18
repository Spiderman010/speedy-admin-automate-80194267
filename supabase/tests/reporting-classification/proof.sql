-- REAL POSTGRESQL PROOF — part 2, run AFTER the migration under test has been
-- applied TWICE (idempotency). Throwaway cluster only. Never run this against
-- any BoekAssist database. See run-proof.sh.
--
-- Sections:
--   A  the migration touched nothing it must not touch (rows, categorie,
--      relfilenode, triggers, indexes, policies, functions)
--   B  the four columns and the five constraints exist as specified
--   C  valid combinations are accepted (owner)
--   D  invalid combinations are refused, by the named constraint (owner)
--   E  the same holds for the API role `authenticated` under RLS
--   F  after every probe the pre-existing rows are still byte-identical

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ── A. untouched ─────────────────────────────────────────────────────────────

SELECT proof.expect_true('A1', 'geen rewrite: relfilenode van de tabel is ongewijzigd',
  $$ (SELECT relfilenode FROM pg_class WHERE oid = 'public.grootboekrekeningen'::regclass) = (SELECT relfilenode FROM proof.meta) $$);

SELECT proof.expect_true('A2', 'bestaande rijen: aantal ongewijzigd',
  $$ (SELECT count(*) FROM public.grootboekrekeningen) = (SELECT count(*) FROM proof.rows_before) $$);

SELECT proof.expect_true('A3', 'bestaande rijen: elke bestaande kolom byte-identiek (categorie, omschrijving, actief, updated_at, …)',
  $$ NOT EXISTS (
       (SELECT id, user_id, client_id, organization_id, nummer, omschrijving, categorie, actief, created_at, updated_at FROM public.grootboekrekeningen
        EXCEPT SELECT * FROM proof.rows_before)
       UNION ALL
       (SELECT * FROM proof.rows_before
        EXCEPT SELECT id, user_id, client_id, organization_id, nummer, omschrijving, categorie, actief, created_at, updated_at FROM public.grootboekrekeningen)) $$);

SELECT proof.expect_true('A4', 'bestaande rijen: alle vier nieuwe kolommen NULL (geen backfill)',
  $$ (SELECT count(*) FROM public.grootboekrekeningen WHERE statement_type IS NOT NULL OR report_group IS NOT NULL OR normal_side IS NOT NULL OR report_sort IS NOT NULL) = 0 $$);

SELECT proof.expect_true('A5', 'categorie: de vrije-tekstwaarde ''Kostem'' staat er nog letterlijk',
  $$ (SELECT categorie FROM public.grootboekrekeningen WHERE nummer = 4711) = 'Kostem' $$);

SELECT proof.expect_true('A6', 'categorie: de default is nog steeds ''kosten''',
  $$ (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grootboekrekeningen' AND column_name = 'categorie') = (SELECT categorie_default FROM proof.meta)
     AND (SELECT categorie_default FROM proof.meta) LIKE '%kosten%' $$);

SELECT proof.expect_true('A7', 'categorie: geen enkele constraint op de tabel noemt categorie',
  $$ NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.grootboekrekeningen'::regclass AND pg_get_constraintdef(oid) ILIKE '%categorie%') $$);

SELECT proof.expect_ok('A8', 'categorie: blijft vrije tekst — een nieuwe rij met categorie ''Willekeurig'' wordt aanvaard',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie) VALUES ('00000000-0000-0000-0000-00000000aaaa', 4713, 'Nog steeds vrije tekst', 'Willekeurig') $$);

SELECT proof.expect_true('A9', 'geen trigger toegevoegd',
  $$ (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.grootboekrekeningen'::regclass AND NOT tgisinternal) = (SELECT triggers FROM proof.meta) $$);

SELECT proof.expect_true('A10', 'geen index toegevoegd',
  $$ (SELECT count(*) FROM pg_index WHERE indrelid = 'public.grootboekrekeningen'::regclass) = (SELECT indexes FROM proof.meta) $$);

SELECT proof.expect_true('A11', 'geen RLS-policy toegevoegd of verwijderd',
  $$ (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.grootboekrekeningen'::regclass) = (SELECT policies FROM proof.meta) $$);

SELECT proof.expect_true('A12', 'geen functie toegevoegd in public',
  $$ (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') = (SELECT public_functions FROM proof.meta) $$);

SELECT proof.expect_true('A13', 'precies 4 kolommen erbij, precies 5 constraints erbij (ook na tweede toepassing: idempotent)',
  $$ (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grootboekrekeningen') = (SELECT columns FROM proof.meta) + 4
     AND (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.grootboekrekeningen'::regclass) = (SELECT constraints FROM proof.meta) + 5 $$);

-- ── B. shape ─────────────────────────────────────────────────────────────────

SELECT proof.expect_true('B1', 'statement_type: text, nullable, zonder default',
  $$ EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grootboekrekeningen' AND column_name = 'statement_type' AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL) $$);
SELECT proof.expect_true('B2', 'report_group: text, nullable, zonder default',
  $$ EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grootboekrekeningen' AND column_name = 'report_group' AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL) $$);
SELECT proof.expect_true('B3', 'normal_side: text, nullable, zonder default',
  $$ EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grootboekrekeningen' AND column_name = 'normal_side' AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL) $$);
SELECT proof.expect_true('B4', 'report_sort: integer, nullable, zonder default',
  $$ EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grootboekrekeningen' AND column_name = 'report_sort' AND data_type = 'integer' AND is_nullable = 'YES' AND column_default IS NULL) $$);

SELECT proof.expect_true('B5', 'de vijf benoemde CHECK-constraints bestaan en zijn gevalideerd',
  $$ (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.grootboekrekeningen'::regclass AND contype = 'c' AND convalidated
        AND conname IN ('grootboekrekeningen_statement_type_check', 'grootboekrekeningen_report_group_check',
                        'grootboekrekeningen_reporting_pair_check', 'grootboekrekeningen_normal_side_check',
                        'grootboekrekeningen_report_sort_check')) = 5 $$);

SELECT proof.expect_true('B6', 'geen NOT NULL op de nieuwe kolommen (attnotnull = false)',
  $$ (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.grootboekrekeningen'::regclass
      AND attname IN ('statement_type', 'report_group', 'normal_side', 'report_sort') AND NOT attnotnull AND NOT attisdropped) = 4 $$);

SELECT proof.expect_true('B7', 'geen opgeslagen default (attmissingval leeg) — de kolommen zijn catalogus-only toegevoegd',
  $$ (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.grootboekrekeningen'::regclass
      AND attname IN ('statement_type', 'report_group', 'normal_side', 'report_sort') AND NOT atthasdef AND NOT atthasmissing) = 4 $$);

-- ── C. valid (owner) ─────────────────────────────────────────────────────────

SELECT proof.expect_ok('C1', 'balans + vaste_activa + debet',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie, statement_type, report_group, normal_side, report_sort)
     VALUES ('00000000-0000-0000-0000-00000000aaaa', 20001, 'C1', 'activa', 'balans', 'vaste_activa', 'debet', 10) $$);
SELECT proof.expect_ok('C2', 'balans + eigen_vermogen + credit',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie, statement_type, report_group, normal_side, report_sort)
     VALUES ('00000000-0000-0000-0000-00000000aaaa', 20002, 'C2', 'passiva', 'balans', 'eigen_vermogen', 'credit', 0) $$);
SELECT proof.expect_ok('C3', 'balans + prive + debet',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie, statement_type, report_group, normal_side)
     VALUES ('00000000-0000-0000-0000-00000000aaaa', 20003, 'C3', 'privé', 'balans', 'prive', 'debet') $$);
SELECT proof.expect_ok('C4', 'winst_verlies + netto_omzet + credit',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie, statement_type, report_group, normal_side)
     VALUES ('00000000-0000-0000-0000-00000000aaaa', 20004, 'C4', 'omzet', 'winst_verlies', 'netto_omzet', 'credit') $$);
SELECT proof.expect_ok('C5', 'winst_verlies + afschrijvingen + debet',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie, statement_type, report_group, normal_side)
     VALUES ('00000000-0000-0000-0000-00000000aaaa', 20005, 'C5', 'kosten', 'winst_verlies', 'afschrijvingen', 'debet') $$);
SELECT proof.expect_ok('C6', 'alle classificatiekolommen NULL (een nieuwe, nog niet geclassificeerde rekening)',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie)
     VALUES ('00000000-0000-0000-0000-00000000aaaa', 20006, 'C6', 'kosten') $$);
SELECT proof.expect_ok('C7', 'geclassificeerd zonder normal_side en zonder report_sort (beide blijven vrij)',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie, statement_type, report_group)
     VALUES ('00000000-0000-0000-0000-00000000aaaa', 20007, 'C7', 'passiva', 'balans', 'kortlopende_schulden') $$);
SELECT proof.expect_ok('C8', 'normal_side zonder classificatie (onafhankelijk veld)',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie, normal_side, report_sort)
     VALUES ('00000000-0000-0000-0000-00000000aaaa', 20008, 'C8', 'kosten', 'credit', 5) $$);
SELECT proof.expect_ok('C9', 'elke balansgroep wordt aanvaard (7)',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie, statement_type, report_group)
     SELECT '00000000-0000-0000-0000-00000000aaaa', 21000 + ord, g, 'passiva', 'balans', g
     FROM unnest(ARRAY['vaste_activa','vlottende_activa','eigen_vermogen','voorzieningen','langlopende_schulden','kortlopende_schulden','prive']) WITH ORDINALITY AS t(g, ord) $$);
SELECT proof.expect_ok('C10', 'elke winst_verlies-groep wordt aanvaard (8)',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie, statement_type, report_group)
     SELECT '00000000-0000-0000-0000-00000000aaaa', 22000 + ord, g, 'kosten', 'winst_verlies', g
     FROM unnest(ARRAY['netto_omzet','kostprijs_omzet','personeelskosten','afschrijvingen','overige_bedrijfskosten','financiele_baten_lasten','belastingen','overig_resultaat']) WITH ORDINALITY AS t(g, ord) $$);
SELECT proof.expect_ok('C11', 'UPDATE van een nieuwe rij naar een geldige classificatie',
  $$ UPDATE public.grootboekrekeningen SET statement_type = 'winst_verlies', report_group = 'belastingen', normal_side = 'debet' WHERE nummer = 20006 $$);
SELECT proof.expect_ok('C12', 'UPDATE terug naar niet-geclassificeerd (beide NULL tegelijk)',
  $$ UPDATE public.grootboekrekeningen SET statement_type = NULL, report_group = NULL WHERE nummer = 20006 $$);

-- ── D. invalid (owner) — refused by the NAMED constraint ─────────────────────

SELECT proof.expect_error('D1', 'balans + netto_omzet → pair_check',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, statement_type, report_group) VALUES ('00000000-0000-0000-0000-00000000aaaa', 30001, 'D1', 'balans', 'netto_omzet') $$,
  'grootboekrekeningen_reporting_pair_check');
SELECT proof.expect_error('D2', 'winst_verlies + vaste_activa → pair_check',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, statement_type, report_group) VALUES ('00000000-0000-0000-0000-00000000aaaa', 30002, 'D2', 'winst_verlies', 'vaste_activa') $$,
  'grootboekrekeningen_reporting_pair_check');
SELECT proof.expect_error('D3', 'NULL statement_type + report_group → pair_check',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, report_group) VALUES ('00000000-0000-0000-0000-00000000aaaa', 30003, 'D3', 'eigen_vermogen') $$,
  'grootboekrekeningen_reporting_pair_check');
-- 'foo' violates BOTH the statement_type domain and the pair check; PostgreSQL
-- reports the first violated constraint in name order (…_reporting_pair_check
-- sorts before …_statement_type_check). The row is refused either way; D4b
-- proves the domain constraint refuses it on its own.
SELECT proof.expect_error('D4', 'statement_type = ''foo'' → geweigerd door een check constraint',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, statement_type, report_group) VALUES ('00000000-0000-0000-0000-00000000aaaa', 30004, 'D4', 'foo', 'eigen_vermogen') $$,
  'violates check constraint "grootboekrekeningen_');
SELECT proof.expect_true('D4b', 'statement_type_check op zichzelf: ''foo'' → exact FALSE',
  $$ proof.eval_check('grootboekrekeningen_statement_type_check', 'foo', 'eigen_vermogen', NULL, NULL) = 'false' $$);
SELECT proof.expect_error('D5', 'normal_side = ''links'' → normal_side_check',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, normal_side) VALUES ('00000000-0000-0000-0000-00000000aaaa', 30005, 'D5', 'links') $$,
  'grootboekrekeningen_normal_side_check');
SELECT proof.expect_error('D6', 'report_sort = -1 → report_sort_check',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, report_sort) VALUES ('00000000-0000-0000-0000-00000000aaaa', 30006, 'D6', -1) $$,
  'grootboekrekeningen_report_sort_check');
SELECT proof.expect_error('D7', 'balans + NULL report_group → geweigerd (geclassificeerd is nooit een halve uitspraak)',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, statement_type) VALUES ('00000000-0000-0000-0000-00000000aaaa', 30007, 'D7', 'balans') $$,
  'grootboekrekeningen_reporting_pair_check');
SELECT proof.expect_error('D8', 'balans + report_group ''foo'' → report_group_check',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, statement_type, report_group) VALUES ('00000000-0000-0000-0000-00000000aaaa', 30008, 'D8', 'balans', 'foo') $$,
  'grootboekrekeningen_report_group_check');
SELECT proof.expect_error('D9', 'hoofdlettervariant ''Balans'' → geweigerd (waarden zijn exact)',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, statement_type, report_group) VALUES ('00000000-0000-0000-0000-00000000aaaa', 30009, 'D9', 'Balans', 'vaste_activa') $$,
  'violates check constraint "grootboekrekeningen_');
SELECT proof.expect_true('D9b', 'statement_type_check op zichzelf: ''Balans'' → exact FALSE',
  $$ proof.eval_check('grootboekrekeningen_statement_type_check', 'Balans', 'vaste_activa', NULL, NULL) = 'false' $$);
SELECT proof.expect_error('D10', 'UPDATE naar een kruislingse groep → pair_check (ook op het update-pad)',
  $$ UPDATE public.grootboekrekeningen SET report_group = 'personeelskosten' WHERE nummer = 20001 $$,
  'grootboekrekeningen_reporting_pair_check');
SELECT proof.expect_error('D11', 'UPDATE die alleen statement_type op NULL zet terwijl de groep blijft → pair_check',
  $$ UPDATE public.grootboekrekeningen SET statement_type = NULL WHERE nummer = 20001 $$,
  'grootboekrekeningen_reporting_pair_check');
SELECT proof.expect_error('D12', 'report_sort = -2147483648 → report_sort_check',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, report_sort) VALUES ('00000000-0000-0000-0000-00000000aaaa', 30012, 'D12', -2147483648) $$,
  'grootboekrekeningen_report_sort_check');

-- Three-valued logic: a CHECK whose expression is NULL passes. Every refused
-- combination must therefore evaluate to exactly FALSE in the catalog
-- expression, never to NULL. (The naive OR-form did yield NULL for N1 and N2.)
SELECT proof.expect_true('N1', 'pair_check: NULL statement_type + groep → exact FALSE (niet NULL)',
  $$ proof.eval_check('grootboekrekeningen_reporting_pair_check', NULL, 'eigen_vermogen', NULL, NULL) = 'false' $$);
SELECT proof.expect_true('N2', 'pair_check: balans + NULL groep → exact FALSE (niet NULL)',
  $$ proof.eval_check('grootboekrekeningen_reporting_pair_check', 'balans', NULL, NULL, NULL) = 'false' $$);
SELECT proof.expect_true('N3', 'pair_check: winst_verlies + NULL groep → exact FALSE (niet NULL)',
  $$ proof.eval_check('grootboekrekeningen_reporting_pair_check', 'winst_verlies', NULL, NULL, NULL) = 'false' $$);
SELECT proof.expect_true('N4', 'pair_check: balans + winst_verlies-groep → exact FALSE',
  $$ proof.eval_check('grootboekrekeningen_reporting_pair_check', 'balans', 'netto_omzet', NULL, NULL) = 'false' $$);
SELECT proof.expect_true('N5', 'pair_check: winst_verlies + balansgroep → exact FALSE',
  $$ proof.eval_check('grootboekrekeningen_reporting_pair_check', 'winst_verlies', 'prive', NULL, NULL) = 'false' $$);
SELECT proof.expect_true('N6', 'pair_check: onbekend statement_type → exact FALSE (ELSE-tak)',
  $$ proof.eval_check('grootboekrekeningen_reporting_pair_check', 'foo', NULL, NULL, NULL) = 'false' $$);
SELECT proof.expect_true('N7', 'pair_check: beide NULL → exact TRUE',
  $$ proof.eval_check('grootboekrekeningen_reporting_pair_check', NULL, NULL, NULL, NULL) = 'true' $$);
SELECT proof.expect_true('N8', 'pair_check: balans + balansgroep → exact TRUE',
  $$ proof.eval_check('grootboekrekeningen_reporting_pair_check', 'balans', 'voorzieningen', NULL, NULL) = 'true' $$);
SELECT proof.expect_true('N9', 'report_group_check: NULL groep → exact TRUE; ''foo'' → exact FALSE',
  $$ proof.eval_check('grootboekrekeningen_report_group_check', NULL, NULL, NULL, NULL) = 'true'
     AND proof.eval_check('grootboekrekeningen_report_group_check', NULL, 'foo', NULL, NULL) = 'false' $$);
SELECT proof.expect_true('N10', 'normal_side_check: NULL → TRUE; ''links'' → exact FALSE',
  $$ proof.eval_check('grootboekrekeningen_normal_side_check', NULL, NULL, NULL, NULL) = 'true'
     AND proof.eval_check('grootboekrekeningen_normal_side_check', NULL, NULL, 'links', NULL) = 'false' $$);
SELECT proof.expect_true('N11', 'report_sort_check: NULL → TRUE; 0 → TRUE; -1 → exact FALSE',
  $$ proof.eval_check('grootboekrekeningen_report_sort_check', NULL, NULL, NULL, NULL) = 'true'
     AND proof.eval_check('grootboekrekeningen_report_sort_check', NULL, NULL, NULL, 0) = 'true'
     AND proof.eval_check('grootboekrekeningen_report_sort_check', NULL, NULL, NULL, -1) = 'false' $$);

SELECT proof.expect_true('D13', 'geen enkele geweigerde rij is blijven hangen',
  $$ (SELECT count(*) FROM public.grootboekrekeningen WHERE nummer BETWEEN 30001 AND 30012) = 0
     AND (SELECT report_group FROM public.grootboekrekeningen WHERE nummer = 20001) = 'vaste_activa' $$);

-- ── E. the API role under RLS ────────────────────────────────────────────────

SET ROLE authenticated;
SET test.user_id = '00000000-0000-0000-0000-00000000aaaa';

SELECT proof.expect_ok('E1', 'authenticated: eigen rij inserten mét classificatie',
  $$ INSERT INTO public.grootboekrekeningen (user_id, nummer, omschrijving, categorie, statement_type, report_group, normal_side)
     VALUES ('00000000-0000-0000-0000-00000000aaaa', 40001, 'E1', 'activa', 'balans', 'vlottende_activa', 'debet') $$);
SELECT proof.expect_ok('E2', 'authenticated: eigen bestaande rij classificeren via UPDATE',
  $$ UPDATE public.grootboekrekeningen SET statement_type = 'balans', report_group = 'vlottende_activa', normal_side = 'debet', report_sort = 1 WHERE nummer = 40001 $$);
SELECT proof.expect_error('E3', 'authenticated: ongeldige combinatie wordt óók voor de API-rol door de constraint geweigerd',
  $$ UPDATE public.grootboekrekeningen SET report_group = 'netto_omzet' WHERE nummer = 40001 $$,
  'grootboekrekeningen_reporting_pair_check');
SELECT proof.expect_true('E4', 'authenticated: de nieuwe kolommen zijn leesbaar via SELECT',
  $$ (SELECT statement_type || '/' || report_group || '/' || normal_side FROM public.grootboekrekeningen WHERE nummer = 40001) = 'balans/vlottende_activa/debet' $$);

RESET test.user_id;
RESET ROLE;

-- ── F. the pre-existing rows survived every probe untouched ──────────────────

SELECT proof.expect_true('F1', 'na alle probes: de vooraf bestaande rijen zijn nog steeds byte-identiek aan de snapshot',
  $$ NOT EXISTS (
       (SELECT * FROM proof.rows_before
        EXCEPT SELECT id, user_id, client_id, organization_id, nummer, omschrijving, categorie, actief, created_at, updated_at FROM public.grootboekrekeningen)) $$);

SELECT proof.expect_true('F2', 'na alle probes: de vooraf bestaande rijen hebben nog steeds geen classificatie',
  $$ (SELECT count(*) FROM public.grootboekrekeningen g JOIN proof.rows_before b ON b.id = g.id
      WHERE g.statement_type IS NOT NULL OR g.report_group IS NOT NULL OR g.normal_side IS NOT NULL OR g.report_sort IS NOT NULL) = 0 $$);
