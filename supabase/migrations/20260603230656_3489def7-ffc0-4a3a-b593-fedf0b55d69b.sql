-- Idempotently install BEFORE INSERT triggers that call public.set_organization_id()
-- on all domain tables that have an organization_id column.
-- Safe to re-run. Does not modify RLS policies or data.

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
    'booking_templates',
    'app_settings'
  ];
BEGIN
  FOREACH t IN ARRAY target_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_organization_id_trigger ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER set_organization_id_trigger
         BEFORE INSERT ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.set_organization_id()',
      t
    );
  END LOOP;
END $$;