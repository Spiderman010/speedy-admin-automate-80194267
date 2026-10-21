-- P2 — READ-ONLY PREFLIGHT, vóór de vier P2-migraties (20261021160000 …
-- 20261021163000). Plakken in de Lovable Cloud SQL-editor van project
-- alxlbdhpbwlehbdbfejw, pas na de omgevingscontrole uit PROJECT_MAP.md. Wijzigt
-- niets. Eén rij:
--   * elke kolom die op _ok eindigt hoort true te zijn (de verwachte begintoestand);
--   * de overige kolommen zijn tellingen: de impact, en het vergelijkingspunt
--     voor de postcheck ("geen onverwachte backfill").
-- Dezelfde query draait in supabase/tests/intake-authz-storage/run-proof.sh.
WITH pol AS (
  SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'storage.objects'::regclass
), preds AS (
  SELECT oid FROM pg_proc
  WHERE oid IN (to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)'),
                to_regprocedure('public.posting_client_org_ok(uuid,uuid)'),
                to_regprocedure('public.ledger_link_org_ok(uuid,uuid)'))
), refs AS (
  SELECT o.name,
         (storage.foldername(o.name))[1] AS map,
         ARRAY(SELECT pi.organization_id FROM public.purchase_invoices pi WHERE pi.file_path = o.name
               UNION ALL
               SELECT si.organization_id FROM public.sales_invoices si WHERE si.pdf_path = o.name) AS orgs
  FROM storage.objects o
  WHERE o.bucket_id = 'invoices'
)
SELECT
  -- B2-08: de oude opslagpolicies (20260802201226) staan er, de nieuwe nog niet
  EXISTS (SELECT 1 FROM pol WHERE polname = 'invoices_read_own_folder_or_org_member' AND polcmd = 'r') AS oude_leespolicy_ok,
  EXISTS (SELECT 1 FROM pol WHERE polname = 'invoices_delete_own_folder' AND polcmd = 'd') AS oude_verwijderpolicy_ok,
  EXISTS (SELECT 1 FROM pol WHERE polname = 'invoices_upload_own_folder' AND polcmd = 'a') AS uploadpolicy_ok,
  NOT EXISTS (SELECT 1 FROM pol WHERE polname IN ('invoices_read_current_org_member',
                                                  'invoices_delete_own_folder_current_member')) AS nieuwe_policies_afwezig_ok,
  NOT EXISTS (SELECT 1 FROM pol WHERE polcmd IN ('w', '*')) AS geen_update_policy_ok,
  to_regprocedure('public.is_organization_member(uuid,uuid)') IS NOT NULL AS is_organization_member_ok,
  -- A2-17: nog geen FK van regel naar factuur en geen regeltrigger
  NOT EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.purchase_invoice_lines'::regclass AND contype = 'f'
                AND confrelid = 'public.purchase_invoices'::regclass) AS geen_regel_fk_ok,
  to_regprocedure('public.enforce_purchase_invoice_line_parent()') IS NULL AS geen_regeltrigger_ok,
  -- A2-07: de opslagfuncties zijn exact die uit de repo (20260718202037, 20260721010000)
  (SELECT md5(prosrc) = '5d9205b73629cd99a6a2c80a019a0cc3' AND NOT prosecdef FROM pg_proc
   WHERE oid = to_regprocedure('public.replace_purchase_invoice_lines(uuid,jsonb)')) AS replace_functie_zoals_repo_ok,
  (SELECT md5(prosrc) = '155930f2b08953e6e81468bd13c5e596' FROM pg_proc
   WHERE oid = to_regprocedure('public.save_purchase_invoice_with_lines(uuid,jsonb,jsonb)')) AS save_functie_zoals_repo_ok,
  -- B1-05: de drie predicaten bestaan en worden alleen door SECURITY DEFINER-functies van dezelfde eigenaar gebruikt
  (SELECT count(*) FROM preds) = 3 AS predicaten_bestaan_ok,
  NOT EXISTS (SELECT 1 FROM pg_depend d
              WHERE d.refclassid = 'pg_proc'::regclass AND d.classid <> 'pg_proc'::regclass
                AND d.refobjid IN (SELECT oid FROM preds)) AS predicaten_niet_in_policies_ok,
  NOT EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.prosrc ~ '(posting_account_ok|posting_client_org_ok|ledger_link_org_ok)'
                AND p.oid NOT IN (SELECT oid FROM preds)
                AND NOT (p.prosecdef AND p.proowner = (SELECT pr.proowner FROM pg_proc pr
                                                        WHERE pr.oid = to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)')))) AS predicaten_alleen_via_definer_ok,
  -- Informatief: true = het orakel van B1-05 is (nog) open
  has_function_privilege('anon', 'public.posting_account_ok(uuid,uuid,uuid)', 'EXECUTE') AS predicaat_orakel_open,
  -- Impact en vergelijkingspunt
  (SELECT count(*) FROM refs) AS objecten,
  (SELECT count(*) FROM refs WHERE cardinality(orgs) = 0) AS wees_objecten,
  (SELECT count(*) FROM refs WHERE cardinality(orgs) > 0
     AND NOT EXISTS (SELECT 1 FROM unnest(orgs) AS g(org) WHERE g.org IS NOT NULL)) AS objecten_alleen_null_org,
  (SELECT count(*) FROM refs r
   WHERE EXISTS (SELECT 1 FROM unnest(r.orgs) AS g(org) WHERE g.org IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM unnest(r.orgs) AS g(org)
                     JOIN public.organization_members m ON m.organization_id = g.org AND m.user_id::text = r.map)) AS objecten_uploader_geen_lid,
  (SELECT count(*) FROM public.purchase_invoice_lines) AS regels,
  (SELECT count(*) FROM public.purchase_invoice_lines l
   JOIN public.purchase_invoices pi ON pi.id = l.purchase_invoice_id
   WHERE l.organization_id IS DISTINCT FROM pi.organization_id) AS regels_andere_organisatie,
  (SELECT count(*) FROM public.purchase_invoice_lines l
   WHERE NOT EXISTS (SELECT 1 FROM public.purchase_invoices pi WHERE pi.id = l.purchase_invoice_id)) AS weesregels;
