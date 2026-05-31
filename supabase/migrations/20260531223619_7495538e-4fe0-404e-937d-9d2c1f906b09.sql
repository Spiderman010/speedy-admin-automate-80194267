-- =====================================================
-- Auto-set organization_id on domain inserts
-- Additive, non-destructive. Existing RLS policies unchanged.
-- rollback: DROP TRIGGER trg_set_org_id_<table> ON public.<table>;
--           ALTER TABLE public.<table> DROP COLUMN IF EXISTS organization_id;
--           DROP FUNCTION public.set_organization_id();
-- =====================================================

-- 1) Add organization_id column to domain tables (clients already has it)
ALTER TABLE public.sales_invoices                 ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.purchase_invoices              ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.purchase_invoice_lines         ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.bank_transactions              ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.bank_transaction_allocations   ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.vraagposten                    ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.leveranciers                   ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.grootboekrekeningen            ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.ledger_accounts                ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.journal_entries                ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.booking_templates              ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE public.app_settings                   ADD COLUMN IF NOT EXISTS organization_id uuid;

-- 2) Indexes for future RLS performance
CREATE INDEX IF NOT EXISTS idx_sales_invoices_org_id              ON public.sales_invoices(organization_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_org_id           ON public.purchase_invoices(organization_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_lines_org_id      ON public.purchase_invoice_lines(organization_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_org_id           ON public.bank_transactions(organization_id);
CREATE INDEX IF NOT EXISTS idx_bank_transaction_allocations_org_id ON public.bank_transaction_allocations(organization_id);
CREATE INDEX IF NOT EXISTS idx_vraagposten_org_id                 ON public.vraagposten(organization_id);
CREATE INDEX IF NOT EXISTS idx_leveranciers_org_id                ON public.leveranciers(organization_id);
CREATE INDEX IF NOT EXISTS idx_grootboekrekeningen_org_id         ON public.grootboekrekeningen(organization_id);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_org_id             ON public.ledger_accounts(organization_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_id             ON public.journal_entries(organization_id);
CREATE INDEX IF NOT EXISTS idx_booking_templates_org_id           ON public.booking_templates(organization_id);
CREATE INDEX IF NOT EXISTS idx_app_settings_org_id                ON public.app_settings(organization_id);
CREATE INDEX IF NOT EXISTS idx_clients_org_id                     ON public.clients(organization_id);

-- 3) Trigger function: resolve organization_id deterministically
CREATE OR REPLACE FUNCTION public.set_organization_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_client_id    uuid;
  v_user_id      uuid;
  v_org_id       uuid;
  v_member_count int;
BEGIN
  -- Idempotent: respect explicit value
  IF NEW.organization_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Pull candidate FKs if columns exist on this row
  BEGIN v_client_id := NEW.client_id; EXCEPTION WHEN undefined_column THEN v_client_id := NULL; END;
  BEGIN v_user_id   := NEW.user_id;   EXCEPTION WHEN undefined_column THEN v_user_id   := NULL; END;

  -- 1) Inherit from client
  IF v_client_id IS NOT NULL THEN
    SELECT c.organization_id INTO v_org_id
    FROM public.clients c
    WHERE c.id = v_client_id;
  END IF;

  -- 2) Fall back to profile default
  IF v_org_id IS NULL AND v_user_id IS NOT NULL THEN
    SELECT p.default_organization_id INTO v_org_id
    FROM public.profiles p
    WHERE p.user_id = v_user_id;
  END IF;

  -- 3) Fall back to sole membership
  IF v_org_id IS NULL AND v_user_id IS NOT NULL THEN
    SELECT count(*) INTO v_member_count
    FROM public.organization_members
    WHERE user_id = v_user_id;

    IF v_member_count = 1 THEN
      SELECT organization_id INTO v_org_id
      FROM public.organization_members
      WHERE user_id = v_user_id;
    END IF;
  END IF;

  NEW.organization_id := v_org_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_organization_id() FROM PUBLIC;

-- 4) Attach BEFORE INSERT triggers to every domain table (incl. clients)
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
    'booking_templates',
    'app_settings'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_set_org_id ON public.%I', t
    );
    EXECUTE format(
      'CREATE TRIGGER trg_set_org_id
         BEFORE INSERT ON public.%I
         FOR EACH ROW
         EXECUTE FUNCTION public.set_organization_id()', t
    );
  END LOOP;
END $$;

-- 5) One-off backfill for existing rows where organization_id IS NULL.
--    Mirrors the trigger logic, but runs in SQL (faster than per-row).

-- 5a) From client_id
UPDATE public.sales_invoices s
   SET organization_id = c.organization_id
  FROM public.clients c
 WHERE s.organization_id IS NULL
   AND s.client_id = c.id
   AND c.organization_id IS NOT NULL;

UPDATE public.purchase_invoices s
   SET organization_id = c.organization_id
  FROM public.clients c
 WHERE s.organization_id IS NULL AND s.client_id = c.id AND c.organization_id IS NOT NULL;

UPDATE public.purchase_invoice_lines pl
   SET organization_id = pi.organization_id
  FROM public.purchase_invoices pi
 WHERE pl.organization_id IS NULL AND pl.purchase_invoice_id = pi.id AND pi.organization_id IS NOT NULL;

UPDATE public.bank_transactions s
   SET organization_id = c.organization_id
  FROM public.clients c
 WHERE s.organization_id IS NULL AND s.client_id = c.id AND c.organization_id IS NOT NULL;

UPDATE public.bank_transaction_allocations s
   SET organization_id = c.organization_id
  FROM public.clients c
 WHERE s.organization_id IS NULL AND s.client_id = c.id AND c.organization_id IS NOT NULL;

UPDATE public.vraagposten s
   SET organization_id = c.organization_id
  FROM public.clients c
 WHERE s.organization_id IS NULL AND s.client_id = c.id AND c.organization_id IS NOT NULL;

UPDATE public.leveranciers s
   SET organization_id = c.organization_id
  FROM public.clients c
 WHERE s.organization_id IS NULL AND s.client_id = c.id AND c.organization_id IS NOT NULL;

UPDATE public.grootboekrekeningen s
   SET organization_id = c.organization_id
  FROM public.clients c
 WHERE s.organization_id IS NULL AND s.client_id = c.id AND c.organization_id IS NOT NULL;

UPDATE public.ledger_accounts s
   SET organization_id = c.organization_id
  FROM public.clients c
 WHERE s.organization_id IS NULL AND s.client_id = c.id AND c.organization_id IS NOT NULL;

UPDATE public.journal_entries s
   SET organization_id = c.organization_id
  FROM public.clients c
 WHERE s.organization_id IS NULL AND s.client_id = c.id AND c.organization_id IS NOT NULL;

UPDATE public.booking_templates s
   SET organization_id = c.organization_id
  FROM public.clients c
 WHERE s.organization_id IS NULL AND s.client_id = c.id AND c.organization_id IS NOT NULL;

-- 5b) Fallback to sole org membership (covers rows without client_id, and app_settings)
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'sales_invoices','purchase_invoices','purchase_invoice_lines',
    'bank_transactions','bank_transaction_allocations',
    'vraagposten','leveranciers','grootboekrekeningen','ledger_accounts',
    'journal_entries','booking_templates','app_settings'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format($f$
      UPDATE public.%I s
         SET organization_id = om.organization_id
        FROM public.organization_members om
       WHERE s.organization_id IS NULL
         AND s.user_id = om.user_id
         AND (SELECT count(*) FROM public.organization_members om2
                WHERE om2.user_id = s.user_id) = 1
    $f$, t);
  END LOOP;
END $$;
