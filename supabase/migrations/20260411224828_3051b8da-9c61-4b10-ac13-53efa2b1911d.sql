ALTER TABLE public.sales_invoices ADD COLUMN ledger_account_text text;
ALTER TABLE public.sales_invoices ADD COLUMN btw_verlegd boolean NOT NULL DEFAULT false;