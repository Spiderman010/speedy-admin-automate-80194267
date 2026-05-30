-- Tighten INSERT policy on organizations (was WITH CHECK (true)).
-- Org-creation in this PR is handled via backfill / service_role.
-- Future PR will add an owner-bootstrap flow.
DROP POLICY IF EXISTS "Authenticated can create organizations" ON public.organizations;

-- Lock down SECURITY DEFINER helpers: only authenticated + service_role.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) FROM anon;
GRANT  EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_organization_member(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_organization_member(uuid, uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.is_organization_member(uuid, uuid) TO authenticated, service_role;
