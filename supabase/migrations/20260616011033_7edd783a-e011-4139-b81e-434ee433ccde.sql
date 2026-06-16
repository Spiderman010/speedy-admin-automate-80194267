-- Harden ledger_accounts RLS (PR-SEC-1)

DROP POLICY IF EXISTS "Users manage own ledger accounts" ON public.ledger_accounts;
DROP POLICY IF EXISTS org_members_ledger_accounts_select ON public.ledger_accounts;
DROP POLICY IF EXISTS org_members_ledger_accounts_insert ON public.ledger_accounts;
DROP POLICY IF EXISTS org_members_ledger_accounts_update ON public.ledger_accounts;
DROP POLICY IF EXISTS org_members_ledger_accounts_delete ON public.ledger_accounts;

CREATE POLICY org_members_ledger_accounts_select
  ON public.ledger_accounts FOR SELECT TO authenticated
  USING (
    organization_id IS NOT NULL
    AND public.is_organization_member(auth.uid(), organization_id)
  );

CREATE POLICY org_members_ledger_accounts_insert
  ON public.ledger_accounts FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND organization_id IS NOT NULL
    AND public.is_organization_member(auth.uid(), organization_id)
  );

CREATE POLICY org_members_ledger_accounts_update
  ON public.ledger_accounts FOR UPDATE TO authenticated
  USING (
    organization_id IS NOT NULL
    AND public.is_organization_member(auth.uid(), organization_id)
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND public.is_organization_member(auth.uid(), organization_id)
  );

CREATE POLICY org_members_ledger_accounts_delete
  ON public.ledger_accounts FOR DELETE TO authenticated
  USING (
    organization_id IS NOT NULL
    AND public.is_organization_member(auth.uid(), organization_id)
  );

-- rollback: drop the four new policies and recreate the previous versions
-- (the original "Users manage own ledger accounts" ALL policy plus the
-- previous org_members_ledger_accounts_* policies with the auth.uid() = user_id OR-branch).
