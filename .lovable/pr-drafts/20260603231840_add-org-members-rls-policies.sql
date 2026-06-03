-- PR DRAFT — NOT YET APPLIED TO PRODUCTION
-- Intended target filename when approved:
--   supabase/migrations/20260603231840_add-org-members-rls-policies.sql
--
-- Add additive org_members_* RLS policies on 12 domain tables.
-- Transitional: existing user_id-based policies remain untouched.
-- PostgreSQL combines permissive policies with OR, so owner access stays intact
-- while team members gain access via is_organization_member(auth.uid(), organization_id).
--
-- Scope: clients, sales_invoices, purchase_invoices, purchase_invoice_lines,
--        bank_transactions, bank_transaction_allocations, vraagposten, leveranciers,
--        grootboekrekeningen, ledger_accounts, journal_entries, booking_templates
-- Excluded: app_settings (stays per-user; org/client settings decided later)
--
-- Idempotent via DROP POLICY IF EXISTS + CREATE POLICY.
-- No existing policies are dropped. No frontend, fiscal_years, role-gating,
-- sales/export/UBL/bank logic, or types.ts changes in this PR.
--
-- rollback: see bottom of file (commented) — drops only org_members_* policies.

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
    -- SELECT
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'org_members_' || t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))',
      'org_members_' || t || '_select', t
    );

    -- INSERT
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'org_members_' || t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id))',
      'org_members_' || t || '_insert', t
    );

    -- UPDATE
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'org_members_' || t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id)) WITH CHECK (public.is_organization_member(auth.uid(), organization_id))',
      'org_members_' || t || '_update', t
    );

    -- DELETE
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'org_members_' || t || '_delete', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))',
      'org_members_' || t || '_delete', t
    );
  END LOOP;
END
$$;

-- ============================================================================
-- VERIFICATION QUERIES (run manually after applying)
-- ============================================================================
--
-- 1) All 48 org_members_* policies present (12 tables x 4 commands):
--    SELECT tablename, policyname, cmd
--    FROM pg_policies
--    WHERE schemaname = 'public' AND policyname LIKE 'org_members_%'
--    ORDER BY tablename, cmd;
--    -- expected: 48 rows
--
-- 2) Existing user_id-based policies still present (none dropped):
--    SELECT tablename, policyname, cmd
--    FROM pg_policies
--    WHERE schemaname = 'public' AND policyname NOT LIKE 'org_members_%'
--    ORDER BY tablename, policyname;
--
-- 3) app_settings has NO org_members_* policy:
--    SELECT count(*) AS app_settings_org_policies
--    FROM pg_policies
--    WHERE schemaname = 'public'
--      AND tablename = 'app_settings'
--      AND policyname LIKE 'org_members_%';
--    -- expected: 0
--
-- 4) No NULL organization_id values on the 12 in-scope tables:
--    SELECT 'clients' AS t, count(*) FROM public.clients WHERE organization_id IS NULL
--    UNION ALL SELECT 'sales_invoices', count(*) FROM public.sales_invoices WHERE organization_id IS NULL
--    UNION ALL SELECT 'purchase_invoices', count(*) FROM public.purchase_invoices WHERE organization_id IS NULL
--    UNION ALL SELECT 'purchase_invoice_lines', count(*) FROM public.purchase_invoice_lines WHERE organization_id IS NULL
--    UNION ALL SELECT 'bank_transactions', count(*) FROM public.bank_transactions WHERE organization_id IS NULL
--    UNION ALL SELECT 'bank_transaction_allocations', count(*) FROM public.bank_transaction_allocations WHERE organization_id IS NULL
--    UNION ALL SELECT 'vraagposten', count(*) FROM public.vraagposten WHERE organization_id IS NULL
--    UNION ALL SELECT 'leveranciers', count(*) FROM public.leveranciers WHERE organization_id IS NULL
--    UNION ALL SELECT 'grootboekrekeningen', count(*) FROM public.grootboekrekeningen WHERE organization_id IS NULL
--    UNION ALL SELECT 'ledger_accounts', count(*) FROM public.ledger_accounts WHERE organization_id IS NULL
--    UNION ALL SELECT 'journal_entries', count(*) FROM public.journal_entries WHERE organization_id IS NULL
--    UNION ALL SELECT 'booking_templates', count(*) FROM public.booking_templates WHERE organization_id IS NULL;
--    -- expected: 0 for every row
--
-- ============================================================================
-- ROLLBACK (drops ONLY org_members_* policies; user_id policies untouched)
-- ============================================================================
--
-- DO $$
-- DECLARE
--   t text;
--   c text;
--   tables text[] := ARRAY[
--     'clients','sales_invoices','purchase_invoices','purchase_invoice_lines',
--     'bank_transactions','bank_transaction_allocations','vraagposten','leveranciers',
--     'grootboekrekeningen','ledger_accounts','journal_entries','booking_templates'
--   ];
--   cmds text[] := ARRAY['select','insert','update','delete'];
-- BEGIN
--   FOREACH t IN ARRAY tables LOOP
--     FOREACH c IN ARRAY cmds LOOP
--       EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'org_members_' || t || '_' || c, t);
--     END LOOP;
--   END LOOP;
-- END $$;
