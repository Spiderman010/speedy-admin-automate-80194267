-- P2 — READ-ONLY POSTCHECK, ná de zes P2-migraties. Plakken in de Lovable
-- Cloud SQL-editor van project alxlbdhpbwlehbdbfejw. Wijzigt niets. Eén rij:
--   * elke kolom die op _ok eindigt hoort true te zijn (structuur, ACL's, RLS);
--   * de tellingen (objecten … weesregels) horen GELIJK te zijn aan die van de
--     preflight: geen onverwachte backfill, geen verplaatst of verwijderd object.
--   * regel_fk_nog_not_valid is informatief: true tot de aparte VALIDATE.
-- Dezelfde query draait in supabase/tests/intake-authz-storage/run-proof.sh.
WITH pol AS (
  SELECT polname, polcmd, polroles,
         pg_get_expr(polqual, polrelid) AS qual
  FROM pg_policy WHERE polrelid = 'storage.objects'::regclass
), fk AS (
  SELECT confrelid, confdeltype, convalidated FROM pg_constraint
  WHERE conrelid = 'public.purchase_invoice_lines'::regclass
    AND conname = 'purchase_invoice_lines_purchase_invoice_id_fkey'
), refs AS (
  SELECT o.name,
         ARRAY(SELECT pi.organization_id FROM public.purchase_invoices pi WHERE pi.file_path = o.name
               UNION ALL
               SELECT si.organization_id FROM public.sales_invoices si WHERE si.pdf_path = o.name) AS orgs
  FROM storage.objects o
  WHERE o.bucket_id = 'invoices'
)
SELECT
  -- B2-08: lezen alleen via een factuur van een organisatie waarvan je nu lid bent;
  -- verwijderen alleen eigen map én huidig lid; uploaden ongewijzigd; geen UPDATE
  EXISTS (SELECT 1 FROM pol WHERE polname = 'invoices_read_current_org_member' AND polcmd = 'r'
            AND polroles = ARRAY['authenticated'::regrole]::oid[]
            AND qual LIKE '%is_organization_member%' AND qual NOT LIKE '%foldername%') AS leespolicy_ok,
  EXISTS (SELECT 1 FROM pol WHERE polname = 'invoices_delete_own_folder_current_member' AND polcmd = 'd'
            AND polroles = ARRAY['authenticated'::regrole]::oid[]
            AND qual LIKE '%foldername%' AND qual LIKE '%is_organization_member%') AS verwijderpolicy_ok,
  EXISTS (SELECT 1 FROM pol WHERE polname = 'invoices_upload_own_folder' AND polcmd = 'a') AS uploadpolicy_ongewijzigd_ok,
  NOT EXISTS (SELECT 1 FROM pol WHERE polname IN ('invoices_read_own_folder_or_org_member',
                                                  'invoices_delete_own_folder')) AS oude_policies_weg_ok,
  NOT EXISTS (SELECT 1 FROM pol WHERE polcmd IN ('w', '*')) AS geen_update_policy_ok,
  (SELECT count(*) FROM pol) = 3 AS drie_opslagpolicies_ok,
  -- A2-17: trigger, triggerfunctie en FK
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.purchase_invoice_lines'::regclass
            AND tgname = 'enforce_purchase_invoice_line_parent_trigger' AND tgenabled = 'O') AS regeltrigger_ok,
  coalesce((SELECT prosecdef AND proconfig = ARRAY['search_path=public']
              AND md5(prosrc) = '269d8ddbc04cc1079fea123511dbb3c9'
              AND NOT has_function_privilege('anon', oid, 'EXECUTE')
              AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
              AND NOT has_function_privilege('service_role', oid, 'EXECUTE')
            FROM pg_proc WHERE oid = to_regprocedure('public.enforce_purchase_invoice_line_parent()')), false) AS regeltriggerfunctie_ok,
  coalesce((SELECT confrelid = 'public.purchase_invoices'::regclass AND confdeltype = 'c' FROM fk), false) AS regel_fk_ok,
  (SELECT NOT convalidated FROM fk) AS regel_fk_nog_not_valid,
  -- A2-07: de guard zit erin, de rest is ongewijzigd
  coalesce((SELECT NOT prosecdef AND proconfig = ARRAY['search_path=public']
              AND md5(prosrc) = 'b7f59d6ef12c604df535c6504211ad82'
              AND has_function_privilege('authenticated', oid, 'EXECUTE')
            FROM pg_proc WHERE oid = to_regprocedure('public.replace_purchase_invoice_lines(uuid,jsonb)')), false) AS replace_guard_ok,
  coalesce((SELECT md5(prosrc) = '155930f2b08953e6e81468bd13c5e596' FROM pg_proc
            WHERE oid = to_regprocedure('public.save_purchase_invoice_with_lines(uuid,jsonb,jsonb)')), false) AS save_functie_ongewijzigd_ok,
  -- B1-05: geen EXECUTE meer voor de app-rollen
  NOT EXISTS (SELECT 1
              FROM unnest(ARRAY['public.posting_account_ok(uuid,uuid,uuid)',
                                'public.posting_client_org_ok(uuid,uuid)',
                                'public.ledger_link_org_ok(uuid,uuid)']) AS f(sig)
              CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(rol)
              WHERE has_function_privilege(r.rol, f.sig, 'EXECUTE')) AS predicaten_ingetrokken_ok,
  -- B2-08c: pointertrigger op beide tabellen, functie DEFINER zonder EXECUTE voor app-rollen
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'guard_invoice_document_pointer_trigger' AND tgenabled = 'O'
     AND tgrelid IN ('public.purchase_invoices'::regclass, 'public.sales_invoices'::regclass)) = 2 AS pointertrigger_ok,
  coalesce((SELECT prosecdef AND proconfig = ARRAY['search_path=public']
              AND md5(prosrc) = '0c285053e10c0d1420a7dfb5f07a2cda'
              AND NOT has_function_privilege('anon', oid, 'EXECUTE')
              AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
              AND NOT has_function_privilege('service_role', oid, 'EXECUTE')
            FROM pg_proc WHERE oid = to_regprocedure('public.guard_invoice_document_pointer()')), false) AS pointertriggerfunctie_ok,
  -- Geen onverwachte backfill: gelijk aan de preflight
  (SELECT count(*) FROM refs) AS objecten,
  (SELECT count(*) FROM refs WHERE cardinality(orgs) = 0) AS wees_objecten,
  (SELECT count(*) FROM public.purchase_invoice_lines) AS regels,
  (SELECT count(*) FROM public.purchase_invoice_lines l
   JOIN public.purchase_invoices pi ON pi.id = l.purchase_invoice_id
   WHERE l.organization_id IS DISTINCT FROM pi.organization_id) AS regels_andere_organisatie,
  (SELECT count(*) FROM public.purchase_invoice_lines l
   WHERE NOT EXISTS (SELECT 1 FROM public.purchase_invoices pi WHERE pi.id = l.purchase_invoice_id)) AS weesregels;
