-- Transitional org-aware RLS (PR 4)
-- Additive policies; existing user_id policies remain in place.
-- PostgreSQL OR-combines permissive policies, so owner access stays intact.
-- app_settings intentionally excluded (per-user semantics).

DO $$
DECLARE
  t text;
  target_tables text[] := ARRAY[
    'clients',
    'sales_invoices',
    'purchase_invoices',
    'purchase_invoice_lines',
    'bank_transactions',
    'bank_transaction_allocations',
    'vraagposten',
    'leveranciers',
    'grootboekrekeningen',
    'ledger_accounts',
    'journal_entries',
    'booking_templates'
  ];
BEGIN
  FOREACH t IN ARRAY target_tables LOOP
    -- SELECT
    EXECUTE format('DROP POLICY IF EXISTS org_members_%I_select ON public.%I', t, t);
    EXECUTE format($p$
      CREATE POLICY org_members_%I_select ON public.%I
        FOR SELECT
        TO authenticated
        USING (
          auth.uid() = user_id
          OR public.is_organization_member(auth.uid(), organization_id)
        )
    $p$, t, t);

    -- INSERT
    EXECUTE format('DROP POLICY IF EXISTS org_members_%I_insert ON public.%I', t, t);
    EXECUTE format($p$
      CREATE POLICY org_members_%I_insert ON public.%I
        FOR INSERT
        TO authenticated
        WITH CHECK (
          auth.uid() = user_id
          AND public.is_organization_member(auth.uid(), organization_id)
        )
    $p$, t, t);

    -- UPDATE
    EXECUTE format('DROP POLICY IF EXISTS org_members_%I_update ON public.%I', t, t);
    EXECUTE format($p$
      CREATE POLICY org_members_%I_update ON public.%I
        FOR UPDATE
        TO authenticated
        USING (
          auth.uid() = user_id
          OR public.is_organization_member(auth.uid(), organization_id)
        )
        WITH CHECK (
          public.is_organization_member(auth.uid(), organization_id)
        )
    $p$, t, t);

    -- DELETE
    EXECUTE format('DROP POLICY IF EXISTS org_members_%I_delete ON public.%I', t, t);
    EXECUTE format($p$
      CREATE POLICY org_members_%I_delete ON public.%I
        FOR DELETE
        TO authenticated
        USING (
          auth.uid() = user_id
          OR public.is_organization_member(auth.uid(), organization_id)
        )
    $p$, t, t);
  END LOOP;
END $$;