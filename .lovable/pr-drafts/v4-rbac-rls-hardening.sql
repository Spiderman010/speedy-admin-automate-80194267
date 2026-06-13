-- =============================================================================
-- BoekAssist — Role-based RLS Hardening v4
-- STATUS: DRAFT — NIETS UITVOEREN ZONDER EXPLICIET AKKOORD
-- Output is gesplitst in DRIE aparte blokken:
--   BLOK 1: preflight / read-only queries
--   BLOK 2: demo-membership revoke (data-mutatie, aparte mini-migratie)
--   BLOK 3: hoofdmigratie + rollback
-- =============================================================================


-- #############################################################################
-- BLOK 1 — PREFLIGHT / READ-ONLY QUERIES
-- Alleen uitvoeren ter verificatie. Geen schrijfacties.
-- Vereist resultaat: 0a=1, 0b=1, 0c=0, en query 1 levert 0 rijen op.
-- #############################################################################

-- 0a) Naim moet owner zijn in org 5faf7b16-...
SELECT 'naim_owner_5faf' AS check_name, count(*) AS hits
FROM public.user_roles ur
JOIN public.organization_members om
  ON om.user_id = ur.user_id AND om.organization_id = ur.organization_id
WHERE ur.user_id = (SELECT id FROM auth.users WHERE email='naim_bouzian@live.nl')
  AND ur.organization_id = '5faf7b16-e11f-4602-ab72-71078997f706'
  AND ur.role = 'owner';

-- 0b) nbsafety1 moet owner zijn in eigen org 3fdc1925-...
SELECT 'nb_owner_3fdc' AS check_name, count(*) AS hits
FROM public.user_roles ur
JOIN public.organization_members om
  ON om.user_id = ur.user_id AND om.organization_id = ur.organization_id
WHERE ur.user_id = (SELECT id FROM auth.users WHERE email='nbsafety1@gmail.com')
  AND ur.organization_id = '3fdc1925-65ad-40bf-9725-5c1f229649c4'
  AND ur.role = 'owner';

-- 0c) nbsafety1 mag NIET lid zijn van Naims org
SELECT 'nb_not_in_naim_org' AS check_name, count(*) AS hits
FROM public.organization_members
WHERE user_id = (SELECT id FROM auth.users WHERE email='nbsafety1@gmail.com')
  AND organization_id = '5faf7b16-e11f-4602-ab72-71078997f706';

-- 1) NULL-check op organization_id en user_id voor alle 11 domeintabellen.
--    Vereist: 0 rijen. Anders STOP — niet migreren.
WITH counts AS (
  SELECT 'clients' AS t, count(*) FILTER (WHERE organization_id IS NULL) AS null_org, count(*) FILTER (WHERE user_id IS NULL) AS null_uid FROM public.clients
  UNION ALL SELECT 'leveranciers', count(*) FILTER (WHERE organization_id IS NULL), count(*) FILTER (WHERE user_id IS NULL) FROM public.leveranciers
  UNION ALL SELECT 'purchase_invoices', count(*) FILTER (WHERE organization_id IS NULL), count(*) FILTER (WHERE user_id IS NULL) FROM public.purchase_invoices
  UNION ALL SELECT 'purchase_invoice_lines', count(*) FILTER (WHERE organization_id IS NULL), count(*) FILTER (WHERE user_id IS NULL) FROM public.purchase_invoice_lines
  UNION ALL SELECT 'bank_transactions', count(*) FILTER (WHERE organization_id IS NULL), count(*) FILTER (WHERE user_id IS NULL) FROM public.bank_transactions
  UNION ALL SELECT 'bank_transaction_allocations', count(*) FILTER (WHERE organization_id IS NULL), count(*) FILTER (WHERE user_id IS NULL) FROM public.bank_transaction_allocations
  UNION ALL SELECT 'vraagposten', count(*) FILTER (WHERE organization_id IS NULL), count(*) FILTER (WHERE user_id IS NULL) FROM public.vraagposten
  UNION ALL SELECT 'booking_templates', count(*) FILTER (WHERE organization_id IS NULL), count(*) FILTER (WHERE user_id IS NULL) FROM public.booking_templates
  UNION ALL SELECT 'journal_entries', count(*) FILTER (WHERE organization_id IS NULL), count(*) FILTER (WHERE user_id IS NULL) FROM public.journal_entries
  UNION ALL SELECT 'grootboekrekeningen', count(*) FILTER (WHERE organization_id IS NULL), count(*) FILTER (WHERE user_id IS NULL) FROM public.grootboekrekeningen
  UNION ALL SELECT 'sales_invoices', count(*) FILTER (WHERE organization_id IS NULL), count(*) FILTER (WHERE user_id IS NULL) FROM public.sales_invoices
)
SELECT * FROM counts WHERE null_org > 0 OR null_uid > 0;

-- 2) Optionele policy-snapshot als export buiten DB (geen CREATE TABLE AS).
SELECT schemaname, tablename, policyname, permissive, cmd,
       roles::text AS roles, qual, with_check
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN ('clients','leveranciers','purchase_invoices','purchase_invoice_lines',
                    'bank_transactions','bank_transaction_allocations','vraagposten',
                    'booking_templates','journal_entries','grootboekrekeningen','sales_invoices')
ORDER BY tablename, cmd, policyname;


-- #############################################################################
-- BLOK 2 — DEMO-MEMBERSHIP REVOKE (data-mutatie, aparte mini-migratie)
-- organization_members kolommen: id, organization_id, user_id, created_at
-- Geen 'role' kolom: rollback gebruikt alleen bestaande kolommen.
-- #############################################################################

-- FORWARD: trek membership in
BEGIN;
DELETE FROM public.organization_members
WHERE user_id = (SELECT id FROM auth.users WHERE email='demo@agiofinance.nl')
  AND organization_id = '5faf7b16-e11f-4602-ab72-71078997f706';
COMMIT;

-- ROLLBACK BLOK 2 (alleen bij nodig):
-- BEGIN;
-- INSERT INTO public.organization_members (organization_id, user_id)
-- SELECT '5faf7b16-e11f-4602-ab72-71078997f706',
--        (SELECT id FROM auth.users WHERE email='demo@agiofinance.nl')
-- WHERE NOT EXISTS (
--   SELECT 1 FROM public.organization_members
--   WHERE organization_id='5faf7b16-e11f-4602-ab72-71078997f706'
--     AND user_id=(SELECT id FROM auth.users WHERE email='demo@agiofinance.nl')
-- );
-- COMMIT;


-- #############################################################################
-- BLOK 3 — HOOFDMIGRATIE + ROLLBACK (transactioneel)
-- Volledig uitgeschreven per tabel. Geen DO-loops, geen templates.
-- #############################################################################

-- ---------- BLOK 3A: HOOFDMIGRATIE FORWARD ----------
BEGIN;

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
-- prevent_org_user_rebind() draait enkel als trigger; geen EXECUTE grant nodig.

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

-- 3A.3 leveranciers (legacy = 4 gesplitste policies)
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

-- 3A.8 vraagposten (legacy = 4 gesplitste policies)
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

-- 3A.11 grootboekrekeningen (strenger: INSERT/UPDATE accountant+, DELETE owner only)
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

-- 3A.12 sales_invoices (geparkeerd: owner-only mutaties)
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

COMMIT;


-- ---------- BLOK 3B: HOOFDMIGRATIE ROLLBACK ----------
-- Volledig copy-paste uitvoerbaar. Recreate-statements zijn 1:1 afgeleid uit
-- de huidige pg_policies-inventory (zie BLOK 1, query 2).

BEGIN;

-- 3B.1 drop nieuwe triggers
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.clients;
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.leveranciers;
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.purchase_invoices;
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.purchase_invoice_lines;
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.bank_transactions;
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.bank_transaction_allocations;
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.vraagposten;
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.booking_templates;
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.journal_entries;
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.grootboekrekeningen;
DROP TRIGGER IF EXISTS prevent_org_user_rebind_trg ON public.sales_invoices;

-- 3B.2 drop nieuwe role_* policies
DROP POLICY IF EXISTS role_clients_select ON public.clients;
DROP POLICY IF EXISTS role_clients_insert ON public.clients;
DROP POLICY IF EXISTS role_clients_update ON public.clients;
DROP POLICY IF EXISTS role_clients_delete ON public.clients;
DROP POLICY IF EXISTS role_leveranciers_select ON public.leveranciers;
DROP POLICY IF EXISTS role_leveranciers_insert ON public.leveranciers;
DROP POLICY IF EXISTS role_leveranciers_update ON public.leveranciers;
DROP POLICY IF EXISTS role_leveranciers_delete ON public.leveranciers;
DROP POLICY IF EXISTS role_purchase_invoices_select ON public.purchase_invoices;
DROP POLICY IF EXISTS role_purchase_invoices_insert ON public.purchase_invoices;
DROP POLICY IF EXISTS role_purchase_invoices_update ON public.purchase_invoices;
DROP POLICY IF EXISTS role_purchase_invoices_delete ON public.purchase_invoices;
DROP POLICY IF EXISTS role_purchase_invoice_lines_select ON public.purchase_invoice_lines;
DROP POLICY IF EXISTS role_purchase_invoice_lines_insert ON public.purchase_invoice_lines;
DROP POLICY IF EXISTS role_purchase_invoice_lines_update ON public.purchase_invoice_lines;
DROP POLICY IF EXISTS role_purchase_invoice_lines_delete ON public.purchase_invoice_lines;
DROP POLICY IF EXISTS role_bank_transactions_select ON public.bank_transactions;
DROP POLICY IF EXISTS role_bank_transactions_insert ON public.bank_transactions;
DROP POLICY IF EXISTS role_bank_transactions_update ON public.bank_transactions;
DROP POLICY IF EXISTS role_bank_transactions_delete ON public.bank_transactions;
DROP POLICY IF EXISTS role_bank_transaction_allocations_select ON public.bank_transaction_allocations;
DROP POLICY IF EXISTS role_bank_transaction_allocations_insert ON public.bank_transaction_allocations;
DROP POLICY IF EXISTS role_bank_transaction_allocations_update ON public.bank_transaction_allocations;
DROP POLICY IF EXISTS role_bank_transaction_allocations_delete ON public.bank_transaction_allocations;
DROP POLICY IF EXISTS role_vraagposten_select ON public.vraagposten;
DROP POLICY IF EXISTS role_vraagposten_insert ON public.vraagposten;
DROP POLICY IF EXISTS role_vraagposten_update ON public.vraagposten;
DROP POLICY IF EXISTS role_vraagposten_delete ON public.vraagposten;
DROP POLICY IF EXISTS role_booking_templates_select ON public.booking_templates;
DROP POLICY IF EXISTS role_booking_templates_insert ON public.booking_templates;
DROP POLICY IF EXISTS role_booking_templates_update ON public.booking_templates;
DROP POLICY IF EXISTS role_booking_templates_delete ON public.booking_templates;
DROP POLICY IF EXISTS role_journal_entries_select ON public.journal_entries;
DROP POLICY IF EXISTS role_journal_entries_insert ON public.journal_entries;
DROP POLICY IF EXISTS role_journal_entries_update ON public.journal_entries;
DROP POLICY IF EXISTS role_journal_entries_delete ON public.journal_entries;
DROP POLICY IF EXISTS role_grootboekrekeningen_select ON public.grootboekrekeningen;
DROP POLICY IF EXISTS role_grootboekrekeningen_insert ON public.grootboekrekeningen;
DROP POLICY IF EXISTS role_grootboekrekeningen_update ON public.grootboekrekeningen;
DROP POLICY IF EXISTS role_grootboekrekeningen_delete ON public.grootboekrekeningen;
DROP POLICY IF EXISTS role_sales_invoices_select ON public.sales_invoices;
DROP POLICY IF EXISTS role_sales_invoices_insert ON public.sales_invoices;
DROP POLICY IF EXISTS role_sales_invoices_update ON public.sales_invoices;
DROP POLICY IF EXISTS role_sales_invoices_delete ON public.sales_invoices;

-- 3B.3 recreate oude policies exact zoals huidige inventory

-- clients
CREATE POLICY "Users manage own clients" ON public.clients
  FOR ALL TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY org_members_clients_select ON public.clients FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_clients_insert ON public.clients FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_clients_update ON public.clients FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))
  WITH CHECK (public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_clients_delete ON public.clients FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));

-- leveranciers
CREATE POLICY "Users select own leveranciers" ON public.leveranciers FOR SELECT TO public USING (auth.uid() = user_id);
CREATE POLICY "Users insert own leveranciers" ON public.leveranciers FOR INSERT TO public WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own leveranciers" ON public.leveranciers FOR UPDATE TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own leveranciers" ON public.leveranciers FOR DELETE TO public USING (auth.uid() = user_id);
CREATE POLICY org_members_leveranciers_select ON public.leveranciers FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_leveranciers_insert ON public.leveranciers FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_leveranciers_update ON public.leveranciers FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))
  WITH CHECK (public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_leveranciers_delete ON public.leveranciers FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));

-- purchase_invoices
CREATE POLICY "Users manage own purchase invoices" ON public.purchase_invoices
  FOR ALL TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY org_members_purchase_invoices_select ON public.purchase_invoices FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_purchase_invoices_insert ON public.purchase_invoices FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_purchase_invoices_update ON public.purchase_invoices FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))
  WITH CHECK (public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_purchase_invoices_delete ON public.purchase_invoices FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));

-- purchase_invoice_lines
CREATE POLICY "Users manage own purchase invoice lines" ON public.purchase_invoice_lines
  FOR ALL TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY org_members_purchase_invoice_lines_select ON public.purchase_invoice_lines FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_purchase_invoice_lines_insert ON public.purchase_invoice_lines FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_purchase_invoice_lines_update ON public.purchase_invoice_lines FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))
  WITH CHECK (public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_purchase_invoice_lines_delete ON public.purchase_invoice_lines FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));

-- bank_transactions
CREATE POLICY "Users manage own bank transactions" ON public.bank_transactions
  FOR ALL TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY org_members_bank_transactions_select ON public.bank_transactions FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_bank_transactions_insert ON public.bank_transactions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_bank_transactions_update ON public.bank_transactions FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))
  WITH CHECK (public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_bank_transactions_delete ON public.bank_transactions FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));

-- bank_transaction_allocations
CREATE POLICY "Users manage own bank transaction allocations" ON public.bank_transaction_allocations
  FOR ALL TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY org_members_bank_transaction_allocations_select ON public.bank_transaction_allocations FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_bank_transaction_allocations_insert ON public.bank_transaction_allocations FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_bank_transaction_allocations_update ON public.bank_transaction_allocations FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))
  WITH CHECK (public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_bank_transaction_allocations_delete ON public.bank_transaction_allocations FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));

-- vraagposten
CREATE POLICY "Users select own vraagposten" ON public.vraagposten FOR SELECT TO public USING (auth.uid() = user_id);
CREATE POLICY "Users insert own vraagposten" ON public.vraagposten FOR INSERT TO public WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own vraagposten" ON public.vraagposten FOR UPDATE TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own vraagposten" ON public.vraagposten FOR DELETE TO public USING (auth.uid() = user_id);
CREATE POLICY org_members_vraagposten_select ON public.vraagposten FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_vraagposten_insert ON public.vraagposten FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_vraagposten_update ON public.vraagposten FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))
  WITH CHECK (public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_vraagposten_delete ON public.vraagposten FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));

-- booking_templates
CREATE POLICY "Users manage own booking templates" ON public.booking_templates
  FOR ALL TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY org_members_booking_templates_select ON public.booking_templates FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_booking_templates_insert ON public.booking_templates FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_booking_templates_update ON public.booking_templates FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))
  WITH CHECK (public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_booking_templates_delete ON public.booking_templates FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));

-- journal_entries
CREATE POLICY "Users manage own journal entries" ON public.journal_entries
  FOR ALL TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY org_members_journal_entries_select ON public.journal_entries FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_journal_entries_insert ON public.journal_entries FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_journal_entries_update ON public.journal_entries FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))
  WITH CHECK (public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_journal_entries_delete ON public.journal_entries FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));

-- grootboekrekeningen
CREATE POLICY "Users manage own grootboekrekeningen" ON public.grootboekrekeningen
  FOR ALL TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY org_members_grootboekrekeningen_select ON public.grootboekrekeningen FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_grootboekrekeningen_insert ON public.grootboekrekeningen FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_grootboekrekeningen_update ON public.grootboekrekeningen FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))
  WITH CHECK (public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_grootboekrekeningen_delete ON public.grootboekrekeningen FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));

-- sales_invoices
CREATE POLICY "Users manage own sales invoices" ON public.sales_invoices
  FOR ALL TO public USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY org_members_sales_invoices_select ON public.sales_invoices FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_sales_invoices_insert ON public.sales_invoices FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_sales_invoices_update ON public.sales_invoices FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id))
  WITH CHECK (public.is_organization_member(auth.uid(), organization_id));
CREATE POLICY org_members_sales_invoices_delete ON public.sales_invoices FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.is_organization_member(auth.uid(), organization_id));

-- 3B.4 drop helperfuncties
DROP FUNCTION IF EXISTS public.has_min_role(uuid, uuid, public.app_role);
DROP FUNCTION IF EXISTS public.role_rank(public.app_role);
DROP FUNCTION IF EXISTS public.prevent_org_user_rebind();

COMMIT;

-- =============================================================================
-- BEVESTIGING
-- Geen SQL uitgevoerd, geen migratie toegepast, geen data gewijzigd,
-- geen branch/commit. Dit is uitsluitend de v4-draft ter review,
-- gesplitst in drie aparte blokken.
-- =============================================================================
