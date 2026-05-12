CREATE TABLE public.vraagposten (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  client_id uuid,
  source_type text NOT NULL CHECK (source_type IN ('purchase_invoice','bank_transaction','sales_invoice','handmatig')),
  source_id uuid,
  categorie text NOT NULL CHECK (categorie IN ('leverancier_kvk_ontbreekt','leverancier_adres_ontbreekt','btw_nummer_ontbreekt','bedrag_klopt_niet','dubbele_factuur','bank_zonder_factuur','kassabon_geen_ubl','klant_bewijs_nodig','overig')),
  titel text NOT NULL,
  omschrijving text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_behandeling','opgelost','genegeerd')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

ALTER TABLE public.vraagposten ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users select own vraagposten" ON public.vraagposten
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own vraagposten" ON public.vraagposten
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own vraagposten" ON public.vraagposten
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own vraagposten" ON public.vraagposten
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_vraagposten_updated_at
  BEFORE UPDATE ON public.vraagposten
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_vraagposten_user ON public.vraagposten(user_id);
CREATE INDEX idx_vraagposten_client ON public.vraagposten(client_id);
CREATE INDEX idx_vraagposten_status ON public.vraagposten(status);