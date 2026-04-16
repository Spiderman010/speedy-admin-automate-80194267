ALTER TABLE public.purchase_invoices
DROP CONSTRAINT IF EXISTS purchase_invoices_status_check;

ALTER TABLE public.purchase_invoices
ADD CONSTRAINT purchase_invoices_status_check
CHECK (
  status = ANY (
    ARRAY[
      'te_controleren'::text,
      'gecontroleerd'::text,
      'geexporteerd'::text,
      'betaald'::text
    ]
  )
);

ALTER TABLE public.purchase_invoices
ADD COLUMN IF NOT EXISTS remaining_amount NUMERIC(12,2);

ALTER TABLE public.sales_invoices
ADD COLUMN IF NOT EXISTS remaining_amount NUMERIC(12,2);

UPDATE public.purchase_invoices
SET remaining_amount = CASE
  WHEN status = 'betaald' THEN 0
  ELSE COALESCE(amount_incl, amount_excl)
END
WHERE remaining_amount IS NULL;

UPDATE public.sales_invoices
SET remaining_amount = CASE
  WHEN status = 'betaald' THEN 0
  ELSE COALESCE(amount_incl, amount_excl)
END
WHERE remaining_amount IS NULL;
