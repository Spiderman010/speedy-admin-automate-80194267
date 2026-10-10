-- REAL POSTGRESQL PROOF for 20261010120000_add_bank_match_rejections.sql —
-- THROWAWAY cluster only. Never run this against any BoekAssist database.
--
-- Wat hier wordt bewezen, onder een echte SET ROLE en echte RLS:
--   • de afwijzing komt met de JUISTE organisatie, administratie, transactie en
--     factuuridentiteit in de tabel, afgeleid en niet geloofd;
--   • een herhaling is idempotent;
--   • een andere organisatie of administratie kan niets lezen, schrijven of weghalen;
--   • een bevestigde koppeling kan niet worden "afgewezen";
--   • niets anders verandert: transacties, afletteringen, facturen, grootboek.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ── S. Structuur, rechten, functie ──────────────────────────────────────────

SELECT proof.expect_true('S1', 'tabel bestaat en RLS staat aan',
  $$(SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bank_match_rejections'::regclass)$$);
SELECT proof.expect_true('S2', 'UNIQUE (bank_transaction_id, invoice_type, invoice_id) bestaat',
  $$EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_match_rejections_unique' AND contype = 'u')$$);
SELECT proof.expect_true('S3', 'invoice_type beperkt tot inkoop/verkoop',
  $$EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_match_rejections_invoice_type_check' AND contype = 'c')$$);
SELECT proof.expect_true('S4', 'authenticated: SELECT, INSERT, DELETE — geen UPDATE of TRUNCATE',
  $$has_table_privilege('authenticated', 'public.bank_match_rejections', 'SELECT')
    AND has_table_privilege('authenticated', 'public.bank_match_rejections', 'INSERT')
    AND has_table_privilege('authenticated', 'public.bank_match_rejections', 'DELETE')
    AND NOT has_table_privilege('authenticated', 'public.bank_match_rejections', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.bank_match_rejections', 'TRUNCATE')$$);
SELECT proof.expect_true('S5', 'service_role: alleen SELECT; anon: niets',
  $$has_table_privilege('service_role', 'public.bank_match_rejections', 'SELECT')
    AND NOT has_table_privilege('service_role', 'public.bank_match_rejections', 'INSERT')
    AND NOT has_table_privilege('service_role', 'public.bank_match_rejections', 'DELETE')
    AND NOT has_table_privilege('anon', 'public.bank_match_rejections', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.bank_match_rejections', 'INSERT')$$);
SELECT proof.expect_true('S6', 'triggerfunctie: SECURITY DEFINER, vaste search_path, niet aanroepbaar door applicatierollen',
  $$(SELECT prosecdef AND proconfig @> ARRAY['search_path=public'] FROM pg_proc WHERE oid = 'public.enforce_bank_match_rejection_scope()'::regprocedure)
    AND NOT has_function_privilege('authenticated', 'public.enforce_bank_match_rejection_scope()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.enforce_bank_match_rejection_scope()', 'EXECUTE')$$);
SELECT proof.expect_true('S7', 'na twee keer toepassen: precies drie policies en één trigger',
  $$(SELECT count(*) FROM pg_policies WHERE tablename = 'bank_match_rejections') = 3
    AND (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.bank_match_rejections'::regclass AND NOT tgisinternal) = 1$$);

-- ── A. De assistent van organisatie A ───────────────────────────────────────

SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);

SELECT proof.expect_ok('A1', 'assistent wijst een suggestie af (zonder organisatie/administratie mee te sturen)',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000001', 'inkoop', '20000000-0000-0000-0000-000000000001')$$);
SELECT proof.expect_true('A2', 'organisatie, administratie en afwijzer zijn afgeleid uit de transactie en de aanroeper',
  $$(SELECT organization_id = '00000000-0000-0000-0000-00000000a001'
        AND client_id = proof.id('a1')
        AND rejected_by = '00000000-0000-0000-0000-0000000000e2'
     FROM public.bank_match_rejections
     WHERE bank_transaction_id = '10000000-0000-0000-0000-000000000001')$$);
SELECT proof.expect_ok('A3', 'dezelfde afwijzing nogmaals met ON CONFLICT DO NOTHING is een no-op',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000001', 'inkoop', '20000000-0000-0000-0000-000000000001')
    ON CONFLICT (bank_transaction_id, invoice_type, invoice_id) DO NOTHING$$);
SELECT proof.expect_true('A4', 'idempotent: nog steeds precies één afwijzing',
  $$(SELECT count(*) FROM public.bank_match_rejections WHERE bank_transaction_id = '10000000-0000-0000-0000-000000000001') = 1$$);
SELECT proof.expect_error('A5', 'een kale tweede INSERT botst op de unieke sleutel',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000001', 'inkoop', '20000000-0000-0000-0000-000000000001')$$,
  'bank_match_rejections_unique');
SELECT proof.expect_true('A6', 'onderdrukking: de afgewezen factuur is voor déze transactie terug te vinden, een andere niet',
  $$EXISTS (SELECT 1 FROM public.bank_match_rejections
            WHERE bank_transaction_id = '10000000-0000-0000-0000-000000000001'
              AND invoice_type = 'inkoop' AND invoice_id = '20000000-0000-0000-0000-000000000001')
    AND NOT EXISTS (SELECT 1 FROM public.bank_match_rejections
            WHERE bank_transaction_id = '10000000-0000-0000-0000-000000000001'
              AND invoice_id = '20000000-0000-0000-0000-000000000002')$$);
SELECT proof.expect_error('A7', 'een meegestuurde verkeerde organisatie wordt geweigerd, niet vervangen',
  $$INSERT INTO public.bank_match_rejections (organization_id, bank_transaction_id, invoice_type, invoice_id)
    VALUES ('00000000-0000-0000-0000-00000000a002', '10000000-0000-0000-0000-000000000001', 'inkoop', '20000000-0000-0000-0000-000000000002')$$,
  'Organisatie hoort niet bij deze banktransactie');
SELECT proof.expect_error('A8', 'een meegestuurde verkeerde administratie wordt geweigerd',
  $$INSERT INTO public.bank_match_rejections (client_id, bank_transaction_id, invoice_type, invoice_id)
    SELECT proof.id('a2'), '10000000-0000-0000-0000-000000000001', 'inkoop', '20000000-0000-0000-0000-000000000002'$$,
  'Administratie hoort niet bij deze banktransactie');
SELECT proof.expect_error('A9', 'een factuur van een andere administratie wordt geweigerd',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000001', 'inkoop', '20000000-0000-0000-0000-000000000021')$$,
  'Factuur hoort niet bij de administratie');
SELECT proof.expect_error('A10', 'een inkoopfactuur als verkoop opgeven wordt geweigerd',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000001', 'verkoop', '20000000-0000-0000-0000-000000000002')$$,
  'Factuur hoort niet bij de administratie');
SELECT proof.expect_error('A11', 'een al bevestigde koppeling kan niet worden afgewezen',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000002', 'verkoop', '20000000-0000-0000-0000-000000000011')$$,
  'al aan de banktransactie gekoppeld');
SELECT proof.expect_error('A12', 'een transactie zonder organisatie: fail closed',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000005', 'inkoop', '20000000-0000-0000-0000-000000000002')$$,
  'Banktransactie niet beschikbaar');
SELECT proof.expect_error('A13', 'een niet-bestaande transactie: dezelfde neutrale fout',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-0000000000ff', 'inkoop', '20000000-0000-0000-0000-000000000002')$$,
  'Banktransactie niet beschikbaar');
SELECT proof.expect_error('A14', 'een andere gebruiker als afwijzer opgeven wordt door RLS geweigerd',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id, rejected_by)
    VALUES ('10000000-0000-0000-0000-000000000001', 'inkoop', '20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000e1')$$,
  'row-level security');
SELECT proof.expect_error('A15', 'een afwijzing herschrijven kan niet (geen UPDATE)',
  $$UPDATE public.bank_match_rejections SET invoice_id = '20000000-0000-0000-0000-000000000002'$$,
  'permission denied');
SELECT proof.expect_ok('A16', 'assistent wijst ook een suggestie in een tweede administratie van dezelfde organisatie af',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000003', 'inkoop', '20000000-0000-0000-0000-000000000021')$$);
SELECT proof.expect_true('A17', 'die tweede afwijzing staat op de eigen administratie, los van de eerste',
  $$(SELECT client_id FROM public.bank_match_rejections WHERE bank_transaction_id = '10000000-0000-0000-0000-000000000003') = proof.id('a2')$$);

RESET ROLE;

-- Een neutrale foutidentiteit: onbekend en vreemd moeten letterlijk gelijk zijn.
CREATE TEMP TABLE errs (k text, state text, msg text);
GRANT INSERT, SELECT ON errs TO authenticated;
SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);
DO $$
DECLARE s text; m text;
BEGIN
  BEGIN
    INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-0000000000ff', 'inkoop', '20000000-0000-0000-0000-000000000031');
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, m = MESSAGE_TEXT;
    INSERT INTO errs VALUES ('onbekend', s, m);
  END;
  BEGIN
    INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000004', 'inkoop', '20000000-0000-0000-0000-000000000031');
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, m = MESSAGE_TEXT;
    INSERT INTO errs VALUES ('vreemd', s, m);
  END;
END $$;
RESET ROLE;
SELECT proof.expect_true('A18', 'onbekende en vreemde transactie: identieke SQLSTATE én boodschap (geen tenant-orakel)',
  $$(SELECT count(DISTINCT (state, msg)) = 1 AND count(*) = 2 AND min(state) = '42501' FROM errs)$$);

-- ── B. Een accountant van organisatie B ─────────────────────────────────────

SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e3', false);

SELECT proof.expect_error('B1', 'organisatie B kan geen suggestie van organisatie A afwijzen',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000001', 'inkoop', '20000000-0000-0000-0000-000000000002')$$,
  'Banktransactie niet beschikbaar');
SELECT proof.expect_true('B2', 'organisatie B ziet geen enkele afwijzing van organisatie A',
  $$(SELECT count(*) FROM public.bank_match_rejections) = 0$$);
SELECT proof.expect_ok('B3', 'organisatie B probeert de afwijzingen van A weg te halen',
  $$DELETE FROM public.bank_match_rejections$$);
SELECT proof.expect_ok('B4', 'organisatie B wijst een eigen suggestie af',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000004', 'inkoop', '20000000-0000-0000-0000-000000000031')$$);
SELECT proof.expect_true('B5', 'en ziet daarna alleen die ene, eigen afwijzing',
  $$(SELECT count(*) = 1 AND bool_and(organization_id = '00000000-0000-0000-0000-00000000a002') FROM public.bank_match_rejections)$$);

RESET ROLE;
SELECT proof.expect_true('B6', 'de DELETE van organisatie B heeft niets van A geraakt',
  $$(SELECT count(*) FROM public.bank_match_rejections WHERE organization_id = '00000000-0000-0000-0000-00000000a001') = 2$$);

-- ── R. Meekijker (read_only) van organisatie A, anon en service_role ───────

SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e4', false);
SELECT proof.expect_true('R1', 'read_only ziet de afwijzingen van de eigen organisatie, niet die van B',
  $$(SELECT count(*) = 2 AND bool_and(organization_id = '00000000-0000-0000-0000-00000000a001') FROM public.bank_match_rejections)$$);
SELECT proof.expect_error('R2', 'read_only mag niet afwijzen',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000001', 'inkoop', '20000000-0000-0000-0000-000000000002')$$,
  'row-level security');
SELECT proof.expect_ok('R3', 'read_only probeert een afwijzing weg te halen', $$DELETE FROM public.bank_match_rejections$$);
RESET ROLE;
SELECT proof.expect_true('R4', 'die DELETE van read_only heeft niets weggehaald',
  $$(SELECT count(*) FROM public.bank_match_rejections) = 3$$);

SET ROLE anon;
SELECT proof.expect_error('R5', 'anon kan de tabel niet lezen', $$SELECT 1 FROM public.bank_match_rejections$$, 'permission denied');
RESET ROLE;
SET ROLE service_role;
SELECT proof.expect_error('R6', 'service_role kan niet afwijzen',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000001', 'inkoop', '20000000-0000-0000-0000-000000000002')$$,
  'permission denied');
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('test.user_id', '', false);
SELECT proof.expect_error('R7', 'zonder ingelogde gebruiker: geweigerd',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000001', 'inkoop', '20000000-0000-0000-0000-000000000002')$$,
  'Niet ingelogd');
RESET ROLE;

-- ── U. Herstellen en opnieuw afwijzen (assistent A) ─────────────────────────

SET ROLE authenticated;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);
SELECT proof.expect_ok('U1', 'assistent haalt een eigen afwijzing weg',
  $$DELETE FROM public.bank_match_rejections WHERE bank_transaction_id = '10000000-0000-0000-0000-000000000003'$$);
SELECT proof.expect_true('U2', 'die afwijzing is weg, de andere staat er nog',
  $$NOT EXISTS (SELECT 1 FROM public.bank_match_rejections WHERE bank_transaction_id = '10000000-0000-0000-0000-000000000003')
    AND EXISTS (SELECT 1 FROM public.bank_match_rejections WHERE bank_transaction_id = '10000000-0000-0000-0000-000000000001')$$);
SELECT proof.expect_ok('U3', 'en kan hem daarna opnieuw vastleggen',
  $$INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id)
    VALUES ('10000000-0000-0000-0000-000000000003', 'inkoop', '20000000-0000-0000-0000-000000000021')
    ON CONFLICT (bank_transaction_id, invoice_type, invoice_id) DO NOTHING$$);
RESET ROLE;

-- ── N. Niets anders veranderd ───────────────────────────────────────────────

SELECT proof.expect_true('N' || row_number() OVER (ORDER BY k), 'onveranderd: ' || k,
  format('proof.digest_of(%L) = %L', k, digest))
FROM proof.snap;
SELECT proof.expect_true('N7', 'het matchresultaat staat er nog: transactie 1 is nog steeds een suggestie voor factuur 1',
  $$(SELECT match_status = 'suggestie' AND matched_invoice_id = '20000000-0000-0000-0000-000000000001' AND match_confidence = 80
     FROM public.bank_transactions WHERE id = '10000000-0000-0000-0000-000000000001')$$);
SELECT proof.expect_true('N8', 'de bevestigde koppeling van transactie 2 is ongemoeid',
  $$(SELECT count(*) FROM public.bank_transaction_allocations WHERE id = '30000000-0000-0000-0000-000000000001' AND amount = 450.41) = 1$$);

-- ── C. Cascade (pas ná de momentopname, want dit wijzigt bank_transactions) ─

DELETE FROM public.bank_transactions WHERE id = '10000000-0000-0000-0000-000000000003';
SELECT proof.expect_true('C1', 'verdwijnt de banktransactie, dan verdwijnt haar afwijzing mee (geen wees-feedback)',
  $$NOT EXISTS (SELECT 1 FROM public.bank_match_rejections WHERE bank_transaction_id = '10000000-0000-0000-0000-000000000003')$$);
