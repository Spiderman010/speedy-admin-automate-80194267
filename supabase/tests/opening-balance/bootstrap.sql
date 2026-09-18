-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- Recreates only the prerequisites that 20260914120000 (ledger_postings
-- foundation) and 20260919120000 (opening balance) actually reference, so both
-- real migration files can be applied verbatim to a throwaway local cluster and
-- their behaviour proved against a real PostgreSQL.
--
-- The role ladder helpers, prevent_org_user_rebind(), set_organization_id() and
-- update_updated_at_column() are copied from the repository migrations that
-- define them (20260613001452, 20260616014119, 20260411182021) so the proof
-- exercises the real logic, not a simplification.
--
-- auth.uid() is the one deliberate simplification: Supabase derives it from the
-- request JWT, which does not exist here, so it reads a session GUC instead.
-- That changes WHO the caller is, never WHAT the code under test does.

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
GRANT SELECT ON auth.users TO authenticated, service_role;

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

CREATE TABLE IF NOT EXISTS public.profiles (
  user_id                 uuid PRIMARY KEY,
  default_organization_id uuid NULL
);

CREATE TABLE IF NOT EXISTS public.clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NULL REFERENCES public.organizations (id),
  user_id             uuid NULL,
  name                text NOT NULL,
  afgesloten_boekjaar integer NULL
);

CREATE TABLE IF NOT EXISTS public.grootboekrekeningen (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NULL,
  client_id       uuid NULL REFERENCES public.clients (id),
  organization_id uuid NULL REFERENCES public.organizations (id),
  nummer          integer NOT NULL,
  omschrijving    text NOT NULL,
  categorie       text NOT NULL DEFAULT 'kosten',
  actief          boolean NOT NULL DEFAULT true
);

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

-- ── copied verbatim from 20260616014119 ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_organization_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id    uuid;
  v_user_id      uuid;
  v_org_id       uuid;
  v_member_count int;
BEGIN
  IF NEW.organization_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  BEGIN v_client_id := NEW.client_id; EXCEPTION WHEN undefined_column THEN v_client_id := NULL; END;
  BEGIN v_user_id   := NEW.user_id;   EXCEPTION WHEN undefined_column THEN v_user_id   := NULL; END;

  IF v_client_id IS NOT NULL THEN
    SELECT c.organization_id INTO v_org_id
    FROM public.clients c
    WHERE c.id = v_client_id;
  END IF;

  IF v_org_id IS NULL AND v_user_id IS NOT NULL THEN
    SELECT p.default_organization_id INTO v_org_id
    FROM public.profiles p
    WHERE p.user_id = v_user_id;
  END IF;

  IF v_org_id IS NULL AND v_user_id IS NOT NULL THEN
    SELECT count(*) INTO v_member_count
    FROM public.organization_members
    WHERE user_id = v_user_id;

    IF v_member_count = 1 THEN
      SELECT organization_id INTO v_org_id
      FROM public.organization_members
      WHERE user_id = v_user_id;
    END IF;
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION
      'organization_id kon niet worden afgeleid voor insert op %; geef organization_id expliciet mee of zorg dat client_id/profile/membership beschikbaar is',
      TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.organization_id := v_org_id;
  RETURN NEW;
END;
$function$;

-- ── the shared updated_at trigger function ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

-- ── ledger_link_org_ok exists in production; referenced only in comments by
--    the foundation, but created here so the schema is complete. ────────────

CREATE OR REPLACE FUNCTION public.ledger_link_org_ok(_link_id uuid, _organization_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _link_id IS NULL OR EXISTS (
    SELECT 1 FROM public.grootboekrekeningen g
    WHERE g.id = _link_id
      AND g.organization_id IS NOT DISTINCT FROM _organization_id
  );
$$;

-- Read grants the application role has in production. RLS is not replicated on
-- these prerequisite tables: the code under test only reads them from inside
-- SECURITY DEFINER functions, and the proof's own fixture helpers need to read
-- clients and accounts directly.
GRANT SELECT ON public.organizations, public.organization_members, public.user_roles,
                public.profiles, public.clients, public.grootboekrekeningen
  TO authenticated, service_role;
