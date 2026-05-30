-- =====================================================================
-- PR 1: Organization / profile / role foundation (additive, non-breaking)
-- rollback: drop table public.user_roles, public.organization_members,
--          public.profiles, public.organizations cascade;
--          drop type public.app_role;
--          drop function public.has_role(uuid, uuid, public.app_role);
--          alter table public.clients drop column organization_id;
-- =====================================================================

-- 1. app_role enum -----------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('owner', 'accountant', 'assistant', 'read_only');
  END IF;
END$$;

-- 2. organizations -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT ALL ON public.organizations TO service_role;

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- 3. organization_members ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON public.organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org  ON public.organization_members(organization_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_members TO authenticated;
GRANT ALL ON public.organization_members TO service_role;

ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

-- 4. profiles ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id uuid PRIMARY KEY,
  display_name text,
  default_organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 5. user_roles --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_org  ON public.user_roles(organization_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- 6. has_role() SECURITY DEFINER helper --------------------------------
CREATE OR REPLACE FUNCTION public.has_role(
  _user_id uuid,
  _organization_id uuid,
  _role public.app_role
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND organization_id = _organization_id
      AND role = _role
  )
$$;

-- 7. is_organization_member() helper (used by RLS to avoid recursion) --
CREATE OR REPLACE FUNCTION public.is_organization_member(
  _user_id uuid,
  _organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE user_id = _user_id
      AND organization_id = _organization_id
  )
$$;

-- 8. RLS policies for new tables ---------------------------------------

-- organizations: members can read; owners can update/delete; authenticated can insert (creator becomes owner via app logic later)
DROP POLICY IF EXISTS "Members can view their organizations" ON public.organizations;
CREATE POLICY "Members can view their organizations"
ON public.organizations FOR SELECT TO authenticated
USING (public.is_organization_member(auth.uid(), id));

DROP POLICY IF EXISTS "Authenticated can create organizations" ON public.organizations;
CREATE POLICY "Authenticated can create organizations"
ON public.organizations FOR INSERT TO authenticated
WITH CHECK (true);

DROP POLICY IF EXISTS "Owners can update organizations" ON public.organizations;
CREATE POLICY "Owners can update organizations"
ON public.organizations FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), id, 'owner'))
WITH CHECK (public.has_role(auth.uid(), id, 'owner'));

DROP POLICY IF EXISTS "Owners can delete organizations" ON public.organizations;
CREATE POLICY "Owners can delete organizations"
ON public.organizations FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), id, 'owner'));

-- organization_members: members can view co-members; owners can manage
DROP POLICY IF EXISTS "Members can view co-members" ON public.organization_members;
CREATE POLICY "Members can view co-members"
ON public.organization_members FOR SELECT TO authenticated
USING (public.is_organization_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "Owners can add members" ON public.organization_members;
CREATE POLICY "Owners can add members"
ON public.organization_members FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), organization_id, 'owner'));

DROP POLICY IF EXISTS "Owners can update members" ON public.organization_members;
CREATE POLICY "Owners can update members"
ON public.organization_members FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), organization_id, 'owner'))
WITH CHECK (public.has_role(auth.uid(), organization_id, 'owner'));

DROP POLICY IF EXISTS "Owners can remove members" ON public.organization_members;
CREATE POLICY "Owners can remove members"
ON public.organization_members FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), organization_id, 'owner'));

-- profiles: users manage their own profile
DROP POLICY IF EXISTS "Users view own profile" ON public.profiles;
CREATE POLICY "Users view own profile"
ON public.profiles FOR SELECT TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own profile" ON public.profiles;
CREATE POLICY "Users insert own profile"
ON public.profiles FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
CREATE POLICY "Users update own profile"
ON public.profiles FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- user_roles: members can view roles in their org; owners can manage roles
DROP POLICY IF EXISTS "Members can view roles in their org" ON public.user_roles;
CREATE POLICY "Members can view roles in their org"
ON public.user_roles FOR SELECT TO authenticated
USING (public.is_organization_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "Owners can assign roles" ON public.user_roles;
CREATE POLICY "Owners can assign roles"
ON public.user_roles FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), organization_id, 'owner'));

DROP POLICY IF EXISTS "Owners can update roles" ON public.user_roles;
CREATE POLICY "Owners can update roles"
ON public.user_roles FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), organization_id, 'owner'))
WITH CHECK (public.has_role(auth.uid(), organization_id, 'owner'));

DROP POLICY IF EXISTS "Owners can revoke roles" ON public.user_roles;
CREATE POLICY "Owners can revoke roles"
ON public.user_roles FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), organization_id, 'owner'));

-- 9. updated_at triggers (reuses existing public.update_updated_at_column)
DROP TRIGGER IF EXISTS update_organizations_updated_at ON public.organizations;
CREATE TRIGGER update_organizations_updated_at
BEFORE UPDATE ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_profiles_updated_at ON public.profiles;
CREATE TRIGGER update_profiles_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 10. clients.organization_id (additive, nullable) ---------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clients_organization_id ON public.clients(organization_id);

-- 11. Backfill ---------------------------------------------------------
-- 11a. One organization per distinct user_id that owns existing clients.
INSERT INTO public.organizations (id, name)
SELECT gen_random_uuid(), 'Mijn kantoor'
FROM (
  SELECT DISTINCT c.user_id
  FROM public.clients c
  WHERE c.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.organization_members om WHERE om.user_id = c.user_id
    )
) u;

-- 11b. Owner membership for each user that just got an org.
-- Strategy: pair each user with an organization that has no members yet.
WITH unassigned_users AS (
  SELECT DISTINCT c.user_id
  FROM public.clients c
  WHERE c.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.organization_members om WHERE om.user_id = c.user_id
    )
),
unassigned_orgs AS (
  SELECT o.id, ROW_NUMBER() OVER (ORDER BY o.created_at, o.id) AS rn
  FROM public.organizations o
  WHERE NOT EXISTS (
    SELECT 1 FROM public.organization_members om WHERE om.organization_id = o.id
  )
),
numbered_users AS (
  SELECT user_id, ROW_NUMBER() OVER (ORDER BY user_id) AS rn
  FROM unassigned_users
)
INSERT INTO public.organization_members (organization_id, user_id)
SELECT o.id, u.user_id
FROM numbered_users u
JOIN unassigned_orgs o ON o.rn = u.rn;

-- 11c. Owner role for each new member.
INSERT INTO public.user_roles (user_id, organization_id, role)
SELECT om.user_id, om.organization_id, 'owner'::public.app_role
FROM public.organization_members om
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles ur
  WHERE ur.user_id = om.user_id
    AND ur.organization_id = om.organization_id
    AND ur.role = 'owner'
);

-- 11d. Backfill clients.organization_id from owner membership.
UPDATE public.clients c
SET organization_id = om.organization_id
FROM public.organization_members om
WHERE c.user_id = om.user_id
  AND c.organization_id IS NULL;

-- 11e. Profile row per user that has clients (display_name left null).
INSERT INTO public.profiles (user_id, default_organization_id)
SELECT om.user_id, om.organization_id
FROM public.organization_members om
WHERE NOT EXISTS (
  SELECT 1 FROM public.profiles p WHERE p.user_id = om.user_id
);

-- =====================================================================
-- Verification queries (read-only, for PR description):
--
-- 1) Counts:
--    select
--      (select count(*) from public.organizations)         as organizations,
--      (select count(*) from public.organization_members)  as members,
--      (select count(*) from public.user_roles where role='owner') as owner_roles,
--      (select count(*) from public.profiles)              as profiles;
--
-- 2) Every user that owns clients has exactly one org + owner role:
--    select c.user_id,
--           count(distinct om.organization_id) as orgs,
--           count(distinct ur.id) filter (where ur.role='owner') as owner_roles
--    from public.clients c
--    left join public.organization_members om on om.user_id = c.user_id
--    left join public.user_roles ur on ur.user_id = c.user_id and ur.organization_id = om.organization_id
--    group by c.user_id;
--
-- 3) No clients left without organization_id:
--    select count(*) as clients_without_org
--    from public.clients
--    where organization_id is null and user_id is not null;
--
-- 4) Existing RLS still intact on domain tables (no replacements made):
--    select schemaname, tablename, policyname
--    from pg_policies
--    where schemaname='public'
--      and tablename in ('clients','sales_invoices','purchase_invoices',
--                        'bank_transactions','vraagposten','leveranciers',
--                        'grootboekrekeningen','journal_entries')
--    order by tablename, policyname;
-- =====================================================================
