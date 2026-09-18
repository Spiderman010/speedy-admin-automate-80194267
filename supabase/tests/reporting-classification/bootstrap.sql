-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- Recreates only what the REAL chart-of-accounts migration (20260412222343)
-- references, so that migration and the migration under test
-- (20260918143850_add_reporting_classification.sql) can be applied verbatim to
-- a throwaway local cluster and their behaviour proved against a real
-- PostgreSQL.
--
-- Copied from the repository migrations that define them:
--   update_updated_at_column()   20260411182021 (verbatim)
-- auth.uid() is the one deliberate simplification: Supabase derives it from
-- the request JWT, which does not exist here, so it reads a session GUC.
-- The two later shape changes that production carries on this table are
-- replayed as the exact statements those migrations contain:
--   ALTER COLUMN client_id DROP NOT NULL          20260412225236 (step 1)
--   ADD COLUMN IF NOT EXISTS organization_id uuid  20260531223619 (line 17)
-- The Supabase default privilege (ALL on public tables to the API roles) is
-- granted explicitly, so the `authenticated` probes hit RLS, not a missing
-- grant.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);

-- Test double: the current user id comes from a session GUC.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('test.user_id', true), '')::uuid $$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- ── copied verbatim from 20260411182021 ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;
