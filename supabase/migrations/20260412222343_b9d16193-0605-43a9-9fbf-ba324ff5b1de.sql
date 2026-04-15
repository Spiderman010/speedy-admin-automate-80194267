
CREATE TABLE public.grootboekrekeningen (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  client_id UUID NOT NULL,
  nummer INTEGER NOT NULL,
  omschrijving TEXT NOT NULL,
  categorie TEXT NOT NULL DEFAULT 'kosten',
  actief BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, client_id, nummer)
);

ALTER TABLE public.grootboekrekeningen ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own grootboekrekeningen"
ON public.grootboekrekeningen
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_grootboekrekeningen_updated_at
BEFORE UPDATE ON public.grootboekrekeningen
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
