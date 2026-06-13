-- BLOK 3A: RBAC/RLS hardening forward migration
-- 3A.1 HELPERS
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

REVOKE ALL ON FUNCTION public.role_rank(public.app_role)                   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_min_role(uuid, uuid, public.app_role)    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_org_user_rebind()                    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.role_rank(public.app_role)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_min_role(uuid, uuid, public.app_role) TO authenticated;

-- 3A.2 clients
DROP POLICY IF EXISTS "Users manage own clients" ON public.clients;
DROP POLICY IF EXISTS org_members_clients_select ON public.clients;
DROP POLICY IF EXISTS org_members_clients_insert ON public.clients;
DROP POLICY IF EXISTS org_members_clients_update ON public.clients;
DROP POLICY IF EXISTS org_members_clients_delete ON public.clients;
CREATE POLICY role_clients_select ON public.clients FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_clients_insert ON public.clients FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_clients_update ON public.clients FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_clients_delete ON public.clients FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.clients;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- 3A.3 leveranciers
DROP POLICY IF EXISTS "Users select own leveranciers" ON public.leveranciers;
DROP POLICY IF EXISTS "Users insert own leveranciers" ON public.leveranciers;
DROP POLICY IF EXISTS "Users update own leveranciers" ON public.leveranciers;
DROP POLICY IF EXISTS "Users delete own leveranciers" ON public.leveranciers;
DROP POLICY IF EXISTS org_members_leveranciers_select ON public.leveranciers;
DROP POLICY IF EXISTS org_members_leveranciers_insert ON public.leveranciers;
DROP POLICY IF EXISTS org_members_leveranciers_update ON public.leveranciers;
DROP POLICY IF EXISTS org_members_leveranciers_delete ON public.leveranciers;
CREATE POLICY role_leveranciers_select ON public.leveranciers FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_leveranciers_insert ON public.leveranciers FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_leveranciers_update ON public.leveranciers FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_leveranciers_delete ON public.leveranciers FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.leveranciers;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.leveranciers
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- 3A.4 purchase_invoices
DROP POLICY IF EXISTS "Users manage own purchase invoices" ON public.purchase_invoices;
DROP POLICY IF EXISTS org_members_purchase_invoices_select ON public.purchase_invoices;
DROP POLICY IF EXISTS org_members_purchase_invoices_insert ON public.purchase_invoices;
DROP POLICY IF EXISTS org_members_purchase_invoices_update ON public.purchase_invoices;
DROP POLICY IF EXISTS org_members_purchase_invoices_delete ON public.purchase_invoices;
CREATE POLICY role_purchase_invoices_select ON public.purchase_invoices FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_purchase_invoices_insert ON public.purchase_invoices FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_purchase_invoices_update ON public.purchase_invoices FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_purchase_invoices_delete ON public.purchase_invoices FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.purchase_invoices;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.purchase_invoices
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- 3A.5 purchase_invoice_lines
DROP POLICY IF EXISTS "Users manage own purchase invoice lines" ON public.purchase_invoice_lines;
DROP POLICY IF EXISTS org_members_purchase_invoice_lines_select ON public.purchase_invoice_lines;
DROP POLICY IF EXISTS org_members_purchase_invoice_lines_insert ON public.purchase_invoice_lines;
DROP POLICY IF EXISTS org_members_purchase_invoice_lines_update ON public.purchase_invoice_lines;
DROP POLICY IF EXISTS org_members_purchase_invoice_lines_delete ON public.purchase_invoice_lines;
CREATE POLICY role_purchase_invoice_lines_select ON public.purchase_invoice_lines FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_purchase_invoice_lines_insert ON public.purchase_invoice_lines FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_purchase_invoice_lines_update ON public.purchase_invoice_lines FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_purchase_invoice_lines_delete ON public.purchase_invoice_lines FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.purchase_invoice_lines;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.purchase_invoice_lines
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- 3A.6 bank_transactions
DROP POLICY IF EXISTS "Users manage own bank transactions" ON public.bank_transactions;
DROP POLICY IF EXISTS org_members_bank_transactions_select ON public.bank_transactions;
DROP POLICY IF EXISTS org_members_bank_transactions_insert ON public.bank_transactions;
DROP POLICY IF EXISTS org_members_bank_transactions_update ON public.bank_transactions;
DROP POLICY IF EXISTS org_members_bank_transactions_delete ON public.bank_transactions;
CREATE POLICY role_bank_transactions_select ON public.bank_transactions FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_bank_transactions_insert ON public.bank_transactions FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_bank_transactions_update ON public.bank_transactions FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_bank_transactions_delete ON public.bank_transactions FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.bank_transactions;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.bank_transactions
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- 3A.7 bank_transaction_allocations
DROP POLICY IF EXISTS "Users manage own bank transaction allocations" ON public.bank_transaction_allocations;
DROP POLICY IF EXISTS org_members_bank_transaction_allocations_select ON public.bank_transaction_allocations;
DROP POLICY IF EXISTS org_members_bank_transaction_allocations_insert ON public.bank_transaction_allocations;
DROP POLICY IF EXISTS org_members_bank_transaction_allocations_update ON public.bank_transaction_allocations;
DROP POLICY IF EXISTS org_members_bank_transaction_allocations_delete ON public.bank_transaction_allocations;
CREATE POLICY role_bank_transaction_allocations_select ON public.bank_transaction_allocations FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_bank_transaction_allocations_insert ON public.bank_transaction_allocations FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_bank_transaction_allocations_update ON public.bank_transaction_allocations FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_bank_transaction_allocations_delete ON public.bank_transaction_allocations FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.bank_transaction_allocations;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.bank_transaction_allocations
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- 3A.8 vraagposten
DROP POLICY IF EXISTS "Users select own vraagposten" ON public.vraagposten;
DROP POLICY IF EXISTS "Users insert own vraagposten" ON public.vraagposten;
DROP POLICY IF EXISTS "Users update own vraagposten" ON public.vraagposten;
DROP POLICY IF EXISTS "Users delete own vraagposten" ON public.vraagposten;
DROP POLICY IF EXISTS org_members_vraagposten_select ON public.vraagposten;
DROP POLICY IF EXISTS org_members_vraagposten_insert ON public.vraagposten;
DROP POLICY IF EXISTS org_members_vraagposten_update ON public.vraagposten;
DROP POLICY IF EXISTS org_members_vraagposten_delete ON public.vraagposten;
CREATE POLICY role_vraagposten_select ON public.vraagposten FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_vraagposten_insert ON public.vraagposten FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_vraagposten_update ON public.vraagposten FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_vraagposten_delete ON public.vraagposten FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.vraagposten;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.vraagposten
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- 3A.9 booking_templates
DROP POLICY IF EXISTS "Users manage own booking templates" ON public.booking_templates;
DROP POLICY IF EXISTS org_members_booking_templates_select ON public.booking_templates;
DROP POLICY IF EXISTS org_members_booking_templates_insert ON public.booking_templates;
DROP POLICY IF EXISTS org_members_booking_templates_update ON public.booking_templates;
DROP POLICY IF EXISTS org_members_booking_templates_delete ON public.booking_templates;
CREATE POLICY role_booking_templates_select ON public.booking_templates FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_booking_templates_insert ON public.booking_templates FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_booking_templates_update ON public.booking_templates FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_booking_templates_delete ON public.booking_templates FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.booking_templates;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.booking_templates
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- 3A.10 journal_entries
DROP POLICY IF EXISTS "Users manage own journal entries" ON public.journal_entries;
DROP POLICY IF EXISTS org_members_journal_entries_select ON public.journal_entries;
DROP POLICY IF EXISTS org_members_journal_entries_insert ON public.journal_entries;
DROP POLICY IF EXISTS org_members_journal_entries_update ON public.journal_entries;
DROP POLICY IF EXISTS org_members_journal_entries_delete ON public.journal_entries;
CREATE POLICY role_journal_entries_select ON public.journal_entries FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_journal_entries_insert ON public.journal_entries FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_journal_entries_update ON public.journal_entries FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'assistant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'assistant'));
CREATE POLICY role_journal_entries_delete ON public.journal_entries FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'accountant'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.journal_entries;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- 3A.11 grootboekrekeningen
DROP POLICY IF EXISTS "Users manage own grootboekrekeningen" ON public.grootboekrekeningen;
DROP POLICY IF EXISTS org_members_grootboekrekeningen_select ON public.grootboekrekeningen;
DROP POLICY IF EXISTS org_members_grootboekrekeningen_insert ON public.grootboekrekeningen;
DROP POLICY IF EXISTS org_members_grootboekrekeningen_update ON public.grootboekrekeningen;
DROP POLICY IF EXISTS org_members_grootboekrekeningen_delete ON public.grootboekrekeningen;
CREATE POLICY role_grootboekrekeningen_select ON public.grootboekrekeningen FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_grootboekrekeningen_insert ON public.grootboekrekeningen FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'accountant'));
CREATE POLICY role_grootboekrekeningen_update ON public.grootboekrekeningen FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'accountant'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'accountant'));
CREATE POLICY role_grootboekrekeningen_delete ON public.grootboekrekeningen FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'owner'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.grootboekrekeningen;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.grootboekrekeningen
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();

-- 3A.12 sales_invoices
DROP POLICY IF EXISTS "Users manage own sales invoices" ON public.sales_invoices;
DROP POLICY IF EXISTS org_members_sales_invoices_select ON public.sales_invoices;
DROP POLICY IF EXISTS org_members_sales_invoices_insert ON public.sales_invoices;
DROP POLICY IF EXISTS org_members_sales_invoices_update ON public.sales_invoices;
DROP POLICY IF EXISTS org_members_sales_invoices_delete ON public.sales_invoices;
CREATE POLICY role_sales_invoices_select ON public.sales_invoices FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
CREATE POLICY role_sales_invoices_insert ON public.sales_invoices FOR INSERT TO authenticated
  WITH CHECK (public.has_min_role(auth.uid(), organization_id, 'owner'));
CREATE POLICY role_sales_invoices_update ON public.sales_invoices FOR UPDATE TO authenticated
  USING       (public.has_min_role(auth.uid(), organization_id, 'owner'))
  WITH CHECK  (public.has_min_role(auth.uid(), organization_id, 'owner'));
CREATE POLICY role_sales_invoices_delete ON public.sales_invoices FOR DELETE TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'owner'));
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.sales_invoices;
CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.sales_invoices
FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind();