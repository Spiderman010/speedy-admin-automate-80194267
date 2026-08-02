-- 1. Backup tables: org-scoped read for authenticated only, writes fully denied
DROP POLICY IF EXISTS "Users read own grootboek backup" ON public.grootboekrekeningen_backup_20260420;
DROP POLICY IF EXISTS "Users read own bank_tx backup" ON public.bank_tx_grootboek_backup_20260420;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.grootboekrekeningen_backup_20260420 FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bank_tx_grootboek_backup_20260420 FROM anon, authenticated;
REVOKE ALL ON public.grootboekrekeningen_backup_20260420 FROM anon;
REVOKE ALL ON public.bank_tx_grootboek_backup_20260420 FROM anon;
GRANT SELECT ON public.grootboekrekeningen_backup_20260420 TO authenticated;
GRANT SELECT ON public.bank_tx_grootboek_backup_20260420 TO authenticated;

ALTER TABLE public.grootboekrekeningen_backup_20260420 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_tx_grootboek_backup_20260420 ENABLE ROW LEVEL SECURITY;

CREATE POLICY "grootboek_backup_org_members_can_read"
ON public.grootboekrekeningen_backup_20260420
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.grootboekrekeningen g
    WHERE g.id = grootboekrekeningen_backup_20260420.id
      AND g.organization_id IS NOT NULL
      AND public.is_organization_member(auth.uid(), g.organization_id)
  )
);

CREATE POLICY "bank_tx_backup_org_members_can_read"
ON public.bank_tx_grootboek_backup_20260420
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.bank_transactions bt
    WHERE bt.id = bank_tx_grootboek_backup_20260420.id
      AND bt.organization_id IS NOT NULL
      AND public.is_organization_member(auth.uid(), bt.organization_id)
  )
);

-- 2. Storage 'invoices': collapse duplicate/conflicting policies into one explicit model
DROP POLICY IF EXISTS "Users can view own invoice files" ON storage.objects;
DROP POLICY IF EXISTS "Users can view own invoices" ON storage.objects;
DROP POLICY IF EXISTS "invoices_org_members_can_read" ON storage.objects;
DROP POLICY IF EXISTS "invoices_org_members_can_read_sales" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload invoice files" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload own invoices" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own invoice files" ON storage.objects;

CREATE POLICY "invoices_read_own_folder_or_org_member"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'invoices'
  AND (
    (auth.uid())::text = (storage.foldername(name))[1]
    OR EXISTS (
      SELECT 1 FROM public.purchase_invoices pi
      WHERE pi.file_path = storage.objects.name
        AND pi.organization_id IS NOT NULL
        AND public.is_organization_member(auth.uid(), pi.organization_id)
    )
    OR EXISTS (
      SELECT 1 FROM public.sales_invoices si
      WHERE si.pdf_path = storage.objects.name
        AND si.organization_id IS NOT NULL
        AND public.is_organization_member(auth.uid(), si.organization_id)
    )
  )
);

CREATE POLICY "invoices_upload_own_folder"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'invoices'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

CREATE POLICY "invoices_delete_own_folder"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'invoices'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);