
CREATE TABLE public.leveranciers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  naam text NOT NULL,
  btw_nummer text,
  kvk_nummer text,
  adres text,
  postcode text,
  plaats text,
  land text NOT NULL DEFAULT 'NL',
  iban text,
  standaard_grootboekrekening_id uuid REFERENCES public.grootboekrekeningen(id) ON DELETE SET NULL,
  actief boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_leveranciers_client_id ON public.leveranciers(client_id);
CREATE INDEX idx_leveranciers_user_id ON public.leveranciers(user_id);
CREATE INDEX idx_leveranciers_actief ON public.leveranciers(actief);
CREATE INDEX idx_leveranciers_btw_nummer ON public.leveranciers(btw_nummer);
CREATE INDEX idx_leveranciers_kvk_nummer ON public.leveranciers(kvk_nummer);

ALTER TABLE public.leveranciers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users select own leveranciers"
  ON public.leveranciers FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own leveranciers"
  ON public.leveranciers FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own leveranciers"
  ON public.leveranciers FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users delete own leveranciers"
  ON public.leveranciers FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_leveranciers_updated_at
  BEFORE UPDATE ON public.leveranciers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.purchase_invoices
  ADD COLUMN leverancier_id uuid REFERENCES public.leveranciers(id) ON DELETE SET NULL;

CREATE INDEX idx_purchase_invoices_leverancier_id ON public.purchase_invoices(leverancier_id);
