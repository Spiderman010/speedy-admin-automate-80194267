ALTER TABLE public.purchase_invoices ADD COLUMN IF NOT EXISTS remaining_amount numeric;
ALTER TABLE public.sales_invoices ADD COLUMN IF NOT EXISTS remaining_amount numeric;
UPDATE public.purchase_invoices SET remaining_amount = COALESCE(amount_incl, amount_excl) WHERE remaining_amount IS NULL;
UPDATE public.sales_invoices SET remaining_amount = COALESCE(amount_incl, amount_excl) WHERE remaining_amount IS NULL;