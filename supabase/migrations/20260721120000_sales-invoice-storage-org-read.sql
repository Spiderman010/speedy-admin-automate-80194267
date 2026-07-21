-- Allow org-members to read sales invoice PDFs in storage bucket 'invoices'.
-- Mirrors the purchase-invoice policy from 20260616011827 (invoices_org_members_can_read),
-- which joins on purchase_invoices.file_path and therefore does not cover
-- sales_invoices.pdf_path (uploaded at {user_id}/sales/{client_id}/...).
-- Write/Update/Delete remain uploader-only via the existing per-user-folder policies.

CREATE POLICY "invoices_org_members_can_read_sales"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'invoices'
    AND EXISTS (
      SELECT 1
      FROM public.sales_invoices si
      WHERE si.pdf_path = storage.objects.name
        AND si.organization_id IS NOT NULL
        AND public.is_organization_member(auth.uid(), si.organization_id)
    )
  );

-- rollback: DROP POLICY "invoices_org_members_can_read_sales" ON storage.objects;

-- ============================================================
-- Verification SQL (read-only; run in the Lovable Cloud SQL editor
-- for project alxlbdhpbwlehbdbfejw after applying this migration)
-- ============================================================

-- V1. Both org-read policies exist (expect 2 rows: purchase + sales)
-- SELECT policyname, cmd, qual
-- FROM pg_policies
-- WHERE schemaname = 'storage' AND tablename = 'objects'
--   AND policyname IN ('invoices_org_members_can_read', 'invoices_org_members_can_read_sales');

-- V2. Same-organization access logic: every sales PDF resolves to exactly
--     the org whose members may read it (expect: rows listing pdf_path + org;
--     no row with a NULL organization_id)
-- SELECT si.pdf_path, si.organization_id
-- FROM public.sales_invoices si
-- WHERE si.pdf_path IS NOT NULL
-- ORDER BY si.created_at DESC
-- LIMIT 20;

-- V3. Cross-organization denial: no sales invoice references a pdf_path that
--     also belongs to a sales or purchase invoice of a DIFFERENT organization
--     (expect: 0 rows — each object maps to exactly one org)
-- SELECT a.pdf_path, a.organization_id AS org_a, b.organization_id AS org_b
-- FROM public.sales_invoices a
-- JOIN public.sales_invoices b
--   ON a.pdf_path = b.pdf_path AND a.id <> b.id
--   AND a.organization_id IS DISTINCT FROM b.organization_id
-- UNION ALL
-- SELECT s.pdf_path, s.organization_id, p.organization_id
-- FROM public.sales_invoices s
-- JOIN public.purchase_invoices p
--   ON p.file_path = s.pdf_path
--   AND p.organization_id IS DISTINCT FROM s.organization_id;

-- V4. Existing purchase policy remains present and unchanged (expect 1 row
--     whose qual references purchase_invoices and is_organization_member)
-- SELECT policyname, qual
-- FROM pg_policies
-- WHERE schemaname = 'storage' AND tablename = 'objects'
--   AND policyname = 'invoices_org_members_can_read';
