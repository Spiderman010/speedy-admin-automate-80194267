-- Hardening: restrict EXECUTE on SECURITY DEFINER helper functions to authenticated only.
-- These helpers are used inside RLS policies and never need to be called by anonymous visitors.
-- No data-access semantics change: RLS still evaluates per-policy.

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_min_role(uuid, uuid, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_organization_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.role_rank(public.app_role) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_min_role(uuid, uuid, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_organization_member(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.role_rank(public.app_role) TO authenticated, service_role;

-- rollback:
-- GRANT EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.has_min_role(uuid, uuid, public.app_role) TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.is_organization_member(uuid, uuid) TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.role_rank(public.app_role) TO PUBLIC;
