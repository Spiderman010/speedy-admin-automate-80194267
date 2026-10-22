-- NÁ rollback.sql (twee keer) — throwaway database only.
-- Variabelen: rbguard (de bewaking uit rollback.sql, letterlijk), pre6 (blok
-- PRE 6 uit preflight.sql, letterlijk).

SELECT proof.plan(ARRAY['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);

SELECT proof.record('R1', 'rollback: de vijf lichamen zijn byte-gelijk die van vóór de migratie (md5)',
  proof.p4_md5s() = proof.get('md5_voor'), proof.p4_md5s());

SELECT proof.record('R2', 'rollback: eigenaar, security, search_path, volatiliteit, taal, uitkomsttype en rechten exact als vóór',
  proof.p4_attrs() = proof.get('attrs_voor'), proof.p4_attrs());

SELECT proof.record('R3', 'rollback: de vijf constraints zijn weg', proof.p4_constraints() = '', proof.p4_constraints());

SELECT proof.expect_error('R4', 'de rollbackbewaking weigert een onbekend lichaam (55000) en verandert niets',
  format('DO $t$ BEGIN EXECUTE %L; EXECUTE %L; END $t$',
         'CREATE OR REPLACE FUNCTION public.post_sales_invoice(_invoice_id uuid) RETURNS uuid LANGUAGE sql AS $b$ SELECT NULL::uuid $b$',
         :'rbguard'),
  '55000', 'niet de beoordeelde versie');

-- Het oude gedrag is werkelijk terug (in een subtransactie die terugrolt): de
-- regel zonder keuze boekt weer stil als 0%, en de preflight noemt haar ready.
DO $$
DECLARE v_out text; v_lines text; v_state text; v_err text;
BEGIN
  BEGIN
    v_state := proof.call(proof.u(2), format(
      'SELECT workflow_state FROM public.bank_bulk_posting_candidates(%L::uuid, NULL) WHERE transaction_id = %L::uuid',
      '00000000-0000-0000-0000-0000000000c1', proof.uid(1400, 2)));
    v_out := proof.p4_post(proof.u(2), 'post_bank_transaction', proof.uid(1400, 2));
    v_lines := proof.p4_lines('bank_transaction', proof.uid(1400, 2));
    RAISE EXCEPTION 'terugdraaien' USING ERRCODE = 'P0001';
  EXCEPTION WHEN others THEN
    IF SQLSTATE <> 'P0001' THEN v_err := SQLERRM; END IF;
  END;
  PERFORM proof.record('R5', 'rollback herstelt werkelijk het oude gedrag: zonder keuze weer ready en stil 0% (E-06) — vandaar de bewaking',
    v_state = 'ok: ready' AND v_out LIKE 'ok: %' AND v_lines = '4700:50.00:0.00,1100:0.00:50.00' AND v_err IS NULL,
    concat_ws(' / ', v_state, v_out, v_lines, v_err));
END $$;

SELECT proof.record('R6', 'de rollback is data-neutraal: PRE 6 (functies buiten de vijf, triggers, rijen, bedragen) gelijk aan ervoor',
  proof.p4_rows(:'pre6') = proof.get('pre6_voor_rollback'), proof.p4_rows(:'pre6'));
