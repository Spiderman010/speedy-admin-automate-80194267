CREATE TABLE public.purchase_invoice_lines (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  purchase_invoice_id UUID NOT NULL,
  user_id UUID NOT NULL,
  omschrijving TEXT NOT NULL,
  amount_excl NUMERIC NOT NULL,
  btw_percentage NUMERIC,
  grootboekrekening_id UUID,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_pil_invoice ON public.purchase_invoice_lines(purchase_invoice_id);

ALTER TABLE public.purchase_invoice_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own purchase invoice lines"
ON public.purchase_invoice_lines
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);