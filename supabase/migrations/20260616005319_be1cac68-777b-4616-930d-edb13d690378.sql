-- Trigger/utility SECURITY DEFINER functions: never need direct API execution.
REVOKE EXECUTE ON FUNCTION public.set_organization_id() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_org_user_rebind() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;

-- rollback:
-- GRANT EXECUTE ON FUNCTION public.set_organization_id() TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.prevent_org_user_rebind() TO PUBLIC;
-- GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO PUBLIC;
