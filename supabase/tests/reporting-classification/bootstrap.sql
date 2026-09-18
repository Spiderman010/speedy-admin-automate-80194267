-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- Recreates only what the REAL chart-of-accounts migration (20260412222343)
-- and the REAL role-policy block for this table (20260613001452 §3A.11,
-- replayed verbatim in shape.sql) reference, so both and the migration under
-- test (20260918143850_add_reporting_classification.sql) can be applied
-- verbatim to a throwaway local cluster and their behaviour proved against a
-- real PostgreSQL.
--
-- Copied verbatim from the repository migrations that define them:
--   update_updated_at_column()                       20260411182021
--   app_role, role_rank(), has_min_role(),
--   prevent_org_user_rebind()                        20260613001452
-- auth.uid() is the one deliberate simplification: Supabase derives it from
-- the request JWT, which does not exist here, so it reads a session GUC.
-- That changes WHO the caller is, never WHAT the code under test does.
-- The Supabase default privilege (ALL on public tables to the API roles) is
-- granted explicitly in shape.sql, so the `authenticated` probes hit RLS,
-- not a missing grant.

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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('owner', 'accountant', 'assistant', 'read_only');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.organizations (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.organization_members (
  user_id         uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  PRIMARY KEY (user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id         uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations (id),
  role            public.app_role NOT NULL,
  PRIMARY KEY (user_id, organization_id)
);

-- ── copied verbatim from 20260411182021 ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- ── copied verbatim from 20260613001452 ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.role_rank(_role public.app_role)
RETURNS int LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE _role
    WHEN 'owner'      THEN 4
    WHEN 'accountant' THEN 3
    WHEN 'assistant'  THEN 2
    WHEN 'read_only'  THEN 1
    ELSE 0
  END
$$;

CREATE OR REPLACE FUNCTION public.has_min_role(
  _user_id uuid, _organization_id uuid, _min public.app_role
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.organization_members om
      ON om.user_id = ur.user_id
     AND om.organization_id = ur.organization_id
    WHERE ur.user_id = _user_id
      AND ur.organization_id = _organization_id
      AND public.role_rank(ur.role) >= public.role_rank(_min)
  )
$$;

CREATE OR REPLACE FUNCTION public.prevent_org_user_rebind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'organization_id is immutable';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_id is immutable';
  END IF;
  RETURN NEW;
END
$$;

GRANT EXECUTE ON FUNCTION public.role_rank(public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_min_role(uuid, uuid, public.app_role) TO authenticated;
