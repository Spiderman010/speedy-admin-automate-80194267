-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- Replays, as the exact statements the repository migrations contain, the two
-- later shape changes production carries on public.grootboekrekeningen, so the
-- table under test has the production column set before the migration under
-- test is applied:
--   20260412225236 step 1:  ALTER COLUMN client_id DROP NOT NULL
--   20260531223619 line 17: ADD COLUMN IF NOT EXISTS organization_id uuid
-- plus the Supabase default privilege on public tables for the API roles.

ALTER TABLE public.grootboekrekeningen
  ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE public.grootboekrekeningen ADD COLUMN IF NOT EXISTS organization_id uuid;

GRANT ALL ON public.grootboekrekeningen TO anon, authenticated, service_role;
