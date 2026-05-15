ALTER TABLE public.purchase_invoices
  ADD COLUMN IF NOT EXISTS snelstart_package_downloaded_at timestamptz NULL;

ALTER TABLE public.purchase_invoices
  ADD COLUMN IF NOT EXISTS snelstart_package_download_count integer NOT NULL DEFAULT 0;

-- rollback: ALTER TABLE public.purchase_invoices DROP COLUMN snelstart_package_downloaded_at, DROP COLUMN snelstart_package_download_count;