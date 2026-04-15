
ALTER TABLE public.bank_transactions ADD COLUMN grootboekrekening_id UUID REFERENCES public.grootboekrekeningen(id);

ALTER TABLE public.purchase_invoices ADD COLUMN grootboekrekening_id UUID REFERENCES public.grootboekrekeningen(id);
