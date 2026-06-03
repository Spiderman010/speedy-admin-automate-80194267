-- Add additive org_members_* RLS policies on 12 domain tables.
-- Transitional: existing user_id-based policies remain untouched.
-- PostgreSQL combines permissive policies with OR, so owner access stays intact
-- while team members gain access via is_organization_member(auth.uid(), organization_id).
--
-- Scope: clients, sales_invoices, purchase_invoices, purchase_invoice_lines,
--        bank_transactions, bank_transaction_allocations, vraagposten, leveranciers,
--        grootboekrekeningen, ledger_accounts, journal_entries, booking_templates
-- Excluded: app_settings (stays per-user)
-- Idempotent via DROP POLICY IF EXISTS + CREATE POLICY.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
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
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'org_members_' || t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))',
      'org_members_' || t || '_select', t
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'org_members_' || t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id))',
      'org_members_' || t || '_insert', t
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'org_members_' || t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id)) WITH CHECK (public.is_organization_member(auth.uid(), organization_id))',
      'org_members_' || t || '_update', t
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'org_members_' || t || '_delete', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))',
      'org_members_' || t || '_delete', t
    );
  END LOOP;
END
$$;