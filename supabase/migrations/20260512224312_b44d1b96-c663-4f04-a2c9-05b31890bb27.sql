ALTER TABLE public.purchase_invoices
  ADD COLUMN IF NOT EXISTS document_route text NOT NULL DEFAULT 'pdf_route',
  ADD COLUMN IF NOT EXISTS original_ubl_path text,
  ADD COLUMN IF NOT EXISTS route_reason text;

ALTER TABLE public.purchase_invoices
  DROP CONSTRAINT IF EXISTS purchase_invoices_document_route_check;

ALTER TABLE public.purchase_invoices
  ADD CONSTRAINT purchase_invoices_document_route_check
  CHECK (document_route IN ('originele_ubl','boekassist_ubl','pdf_route','vraagpost','handmatig'));