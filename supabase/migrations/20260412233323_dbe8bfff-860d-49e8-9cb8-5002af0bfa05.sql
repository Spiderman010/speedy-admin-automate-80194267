
ALTER TABLE public.clients
  ADD COLUMN rechtsvorm text,
  ADD COLUMN btw_type text NOT NULL DEFAULT 'plichtig',
  ADD COLUMN ibans text[] DEFAULT '{}';

-- Migrate existing btw_vrijgesteld data to btw_type
UPDATE public.clients SET btw_type = 'vrijgesteld' WHERE btw_vrijgesteld = true;
