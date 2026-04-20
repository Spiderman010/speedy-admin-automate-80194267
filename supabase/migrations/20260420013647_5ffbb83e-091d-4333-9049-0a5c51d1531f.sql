ALTER TABLE public.grootboekrekeningen_backup_20260420 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_tx_grootboek_backup_20260420 ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own grootboek backup"
ON public.grootboekrekeningen_backup_20260420
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users read own bank_tx backup"
ON public.bank_tx_grootboek_backup_20260420
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.bank_transactions bt
    WHERE bt.id = bank_tx_grootboek_backup_20260420.id
      AND bt.user_id = auth.uid()
  )
);