-- Allow org-members to read invoice attachments in storage bucket 'invoices'.
-- Write/Update/Delete remain uploader-only via the existing per-user-folder policies.

CREATE POLICY "invoices_org_members_can_read"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'invoices'
    AND EXISTS (
      SELECT 1
      FROM public.purchase_invoices pi
      WHERE pi.file_path = storage.objects.name
        AND pi.organization_id IS NOT NULL
        AND public.is_organization_member(auth.uid(), pi.organization_id)
    )
  );

-- rollback: DROP POLICY "invoices_org_members_can_read" ON storage.objects;
