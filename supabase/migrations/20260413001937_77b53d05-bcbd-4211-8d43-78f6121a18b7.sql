
-- Create app_settings table
CREATE TABLE public.app_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}',
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(user_id, key)
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own app settings"
  ON public.app_settings FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Add columns to booking_templates
ALTER TABLE public.booking_templates
  ADD COLUMN IF NOT EXISTS zoekterm text,
  ADD COLUMN IF NOT EXISTS zoek_in text DEFAULT 'alles',
  ADD COLUMN IF NOT EXISTS actie text DEFAULT 'grootboek',
  ADD COLUMN IF NOT EXISTS geldt_voor text DEFAULT 'alle',
  ADD COLUMN IF NOT EXISTS client_id_filter uuid,
  ADD COLUMN IF NOT EXISTS prioriteit integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actief boolean DEFAULT true;
