ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'NL',
  ADD COLUMN IF NOT EXISTS bank_dagboek integer,
  ADD COLUMN IF NOT EXISTS inkoop_dagboek integer,
  ADD COLUMN IF NOT EXISTS verkoop_dagboek integer,
  ADD COLUMN IF NOT EXISTS afgesloten_boekjaar integer;