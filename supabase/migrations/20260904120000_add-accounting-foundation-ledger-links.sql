-- Migration: accounting foundation — explicit ledger links
--
-- Purpose: add the three grootboekrekening references that a future general
-- ledger needs, and make the configuration explicit instead of implied:
--
--   1. clients.debiteuren_rekening_id   → default/backfill: rekening 1300
--   2. clients.crediteuren_rekening_id  → default/backfill: rekening 1600
--   3. sales_invoices.grootboekrekening_id (one omzetrekening per invoice)
--
-- This migration is PURELY ADDITIVE:
--   • no column is dropped or renamed (ledger_account_text stays untouched);
--   • all three columns are NULLABLE — historic administrations may have
--     missing or ambiguous configuration, and client-readiness surfaces that
--     rather than the migration failing;
--   • no NOT NULL, no DEFAULT (the correct uuid differs per organisation);
--   • no RLS policy is touched — new columns on existing tables inherit the
--     table's existing policies;
--   • NO postings are generated. This is configuration only.
--
-- FK behaviour follows the repository convention established by
-- 20260718213000 (purchase_invoice_lines), 20260718234500 (booking_templates)
-- and 20260719201000 (journal_entries): ON DELETE SET NULL — deleting a ledger
-- account must never cascade-delete a client or an invoice.
--
-- Backfill safety: every backfill below maps ONLY when exactly one candidate
-- exists within the same organization_id. Zero matches or multiple matches
-- leave the column NULL; nothing is guessed and no LIMIT 1 is used. Global
-- accounts (organization_id IS NULL) are deliberately NOT auto-mapped to
-- organisation-scoped rows, so no implicit cross-organisation mapping occurs.
--
-- Tenant isolation: the single-column FKs below only guarantee that the ledger
-- account EXISTS. They cannot express "and it belongs to the same organisation".
-- A composite FK on (id, organization_id) was rejected for three concrete
-- reasons: (a) ON DELETE SET NULL would null the parent's organization_id too
-- unless the PostgreSQL 15+ column-list form is available, which cannot be
-- verified from here; (b) MATCH SIMPLE silently skips enforcement whenever the
-- parent organization_id is NULL; (c) it would drag organization_id into an FK
-- that the existing immutability trigger also governs. Instead this migration
-- adds two small BEFORE INSERT OR UPDATE triggers, mirroring the repository's
-- existing set_organization_id() / prevent_org_user_rebind() convention:
-- SECURITY DEFINER, SET search_path = public, REVOKEd from PUBLIC, and never
-- granted to authenticated — they are triggers, not callable RPCs.
--
-- rollback:
--   DROP TRIGGER IF EXISTS validate_sales_invoice_ledger_org_trigger ON public.sales_invoices;
--   DROP TRIGGER IF EXISTS validate_client_ledger_org_trigger ON public.clients;
--   DROP FUNCTION IF EXISTS public.enforce_sales_invoice_ledger_org();
--   DROP FUNCTION IF EXISTS public.enforce_client_ledger_org();
--   DROP FUNCTION IF EXISTS public.ledger_link_org_ok(uuid, uuid);
--   ALTER TABLE public.sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_grootboekrekening_id_fkey;
--   DROP INDEX IF EXISTS public.idx_sales_invoices_grootboekrekening_id;
--   ALTER TABLE public.sales_invoices DROP COLUMN IF EXISTS grootboekrekening_id;
--   ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_crediteuren_rekening_id_fkey;
--   DROP INDEX IF EXISTS public.idx_clients_crediteuren_rekening_id;
--   ALTER TABLE public.clients DROP COLUMN IF EXISTS crediteuren_rekening_id;
--   ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_debiteuren_rekening_id_fkey;
--   DROP INDEX IF EXISTS public.idx_clients_debiteuren_rekening_id;
--   ALTER TABLE public.clients DROP COLUMN IF EXISTS debiteuren_rekening_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS debiteuren_rekening_id uuid;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS crediteuren_rekening_id uuid;

ALTER TABLE public.sales_invoices
  ADD COLUMN IF NOT EXISTS grootboekrekening_id uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Backfill: clients.debiteuren_rekening_id → rekening 1300
--
--    Scoped to the client's own organization_id. Only an unambiguous match
--    (exactly one active 1300 in that organisation) is applied.
-- ─────────────────────────────────────────────────────────────────────────────

WITH debiteuren_candidates AS (
  SELECT
    client.id AS client_id,
    grootboek.id AS rekening_id,
    COUNT(*) OVER (PARTITION BY client.id) AS match_count
  FROM public.clients AS client
  JOIN public.grootboekrekeningen AS grootboek
    ON grootboek.organization_id = client.organization_id
   AND grootboek.nummer = 1300
   AND grootboek.actief = true
  WHERE client.debiteuren_rekening_id IS NULL
)
UPDATE public.clients AS client
SET debiteuren_rekening_id = candidate.rekening_id
FROM debiteuren_candidates AS candidate
WHERE client.id = candidate.client_id
  AND client.debiteuren_rekening_id IS NULL
  AND candidate.match_count = 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Backfill: clients.crediteuren_rekening_id → rekening 1600
-- ─────────────────────────────────────────────────────────────────────────────

WITH crediteuren_candidates AS (
  SELECT
    client.id AS client_id,
    grootboek.id AS rekening_id,
    COUNT(*) OVER (PARTITION BY client.id) AS match_count
  FROM public.clients AS client
  JOIN public.grootboekrekeningen AS grootboek
    ON grootboek.organization_id = client.organization_id
   AND grootboek.nummer = 1600
   AND grootboek.actief = true
  WHERE client.crediteuren_rekening_id IS NULL
)
UPDATE public.clients AS client
SET crediteuren_rekening_id = candidate.rekening_id
FROM crediteuren_candidates AS candidate
WHERE client.id = candidate.client_id
  AND client.crediteuren_rekening_id IS NULL
  AND candidate.match_count = 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Backfill: sales_invoices.grootboekrekening_id from ledger_account_text
--
--    Identical strategy to 20260719201000 (journal_entries): exact normalised
--    label match ("<nummer> - <omschrijving>", case/whitespace insensitive)
--    within the same organisation, applied only when unique. No fuzzy matching.
--    ledger_account_text is preserved as-is.
-- ─────────────────────────────────────────────────────────────────────────────

WITH backfill_candidates AS (
  SELECT
    invoice.id AS sales_invoice_id,
    grootboek.id AS grootboekrekening_id,
    COUNT(*) OVER (PARTITION BY invoice.id) AS match_count
  FROM public.sales_invoices AS invoice
  JOIN public.grootboekrekeningen AS grootboek
    ON grootboek.organization_id = invoice.organization_id
   AND lower(trim(invoice.ledger_account_text)) = lower(trim(grootboek.nummer::text || ' - ' || grootboek.omschrijving))
  WHERE invoice.grootboekrekening_id IS NULL
    AND invoice.ledger_account_text IS NOT NULL
    AND btrim(invoice.ledger_account_text) <> ''
)
UPDATE public.sales_invoices AS invoice
SET grootboekrekening_id = candidate.grootboekrekening_id
FROM backfill_candidates AS candidate
WHERE invoice.id = candidate.sales_invoice_id
  AND invoice.grootboekrekening_id IS NULL
  AND candidate.match_count = 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Indexes (mirrors 20260719201000)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_clients_debiteuren_rekening_id
  ON public.clients (debiteuren_rekening_id);

CREATE INDEX IF NOT EXISTS idx_clients_crediteuren_rekening_id
  ON public.clients (crediteuren_rekening_id);

CREATE INDEX IF NOT EXISTS idx_sales_invoices_grootboekrekening_id
  ON public.sales_invoices (grootboekrekening_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) Foreign keys — ON DELETE SET NULL, idempotent (mirrors 20260719201000)
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'clients'
      AND c.conname = 'clients_debiteuren_rekening_id_fkey'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_debiteuren_rekening_id_fkey
      FOREIGN KEY (debiteuren_rekening_id)
      REFERENCES public.grootboekrekeningen (id)
      ON DELETE SET NULL;
  ELSE
    RAISE NOTICE 'Constraint clients_debiteuren_rekening_id_fkey already exists, skipping';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'clients'
      AND c.conname = 'clients_crediteuren_rekening_id_fkey'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_crediteuren_rekening_id_fkey
      FOREIGN KEY (crediteuren_rekening_id)
      REFERENCES public.grootboekrekeningen (id)
      ON DELETE SET NULL;
  ELSE
    RAISE NOTICE 'Constraint clients_crediteuren_rekening_id_fkey already exists, skipping';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'sales_invoices'
      AND c.conname = 'sales_invoices_grootboekrekening_id_fkey'
  ) THEN
    ALTER TABLE public.sales_invoices
      ADD CONSTRAINT sales_invoices_grootboekrekening_id_fkey
      FOREIGN KEY (grootboekrekening_id)
      REFERENCES public.grootboekrekeningen (id)
      ON DELETE SET NULL;
  ELSE
    RAISE NOTICE 'Constraint sales_invoices_grootboekrekening_id_fkey already exists, skipping';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) Tenant consistency — a ledger link may never cross organisations
--
--    The FKs above guarantee existence only. These triggers additionally
--    guarantee that a non-NULL link points at a grootboekrekening in the SAME
--    organisation, so a cross-organisation reference is refused by PostgreSQL
--    even when the UI is bypassed.
--
--    NULL stays allowed (unconfigured / historically unresolved rows), and the
--    FK's ON DELETE SET NULL keeps working: nulling a link always passes.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ledger_link_org_ok(
  _account_id uuid,
  _organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- NULL link = allowed. Otherwise the account must exist AND sit in the same
  -- organisation. IS NOT DISTINCT FROM so a NULL-org row only matches a
  -- NULL-org parent; it never lets an organisation borrow a global account or
  -- vice versa.
  SELECT _account_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.grootboekrekeningen g
        WHERE g.id = _account_id
          AND g.organization_id IS NOT DISTINCT FROM _organization_id
      );
$$;

CREATE OR REPLACE FUNCTION public.enforce_client_ledger_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.ledger_link_org_ok(NEW.debiteuren_rekening_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'debiteuren_rekening_id verwijst naar een grootboekrekening buiten de organisatie van deze administratie'
      USING ERRCODE = '23514';
  END IF;

  IF NOT public.ledger_link_org_ok(NEW.crediteuren_rekening_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'crediteuren_rekening_id verwijst naar een grootboekrekening buiten de organisatie van deze administratie'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.enforce_sales_invoice_ledger_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.ledger_link_org_ok(NEW.grootboekrekening_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'grootboekrekening_id verwijst naar een grootboekrekening buiten de organisatie van deze verkoopfactuur'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.ledger_link_org_ok(uuid, uuid)      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_client_ledger_org()         FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_sales_invoice_ledger_org()  FROM PUBLIC;

-- Trigger names deliberately start with "validate_" so they sort AFTER the
-- existing "set_organization_id_trigger". PostgreSQL fires per-row triggers in
-- name order, and organization_id must already be resolved before it is
-- compared. UPDATE OF <columns> keeps the trigger off unrelated updates.
DROP TRIGGER IF EXISTS validate_client_ledger_org_trigger ON public.clients;
CREATE TRIGGER validate_client_ledger_org_trigger
  BEFORE INSERT OR UPDATE OF debiteuren_rekening_id, crediteuren_rekening_id, organization_id
  ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.enforce_client_ledger_org();

DROP TRIGGER IF EXISTS validate_sales_invoice_ledger_org_trigger ON public.sales_invoices;
CREATE TRIGGER validate_sales_invoice_ledger_org_trigger
  BEFORE INSERT OR UPDATE OF grootboekrekening_id, organization_id
  ON public.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_invoice_ledger_org();

COMMENT ON FUNCTION public.ledger_link_org_ok(uuid, uuid) IS
'TRUE wanneer een grootboek-link leeg is, of verwijst naar een rekening binnen dezelfde organisatie. Gebruikt door de tenant-consistency triggers op clients en sales_invoices.';

COMMENT ON COLUMN public.clients.debiteuren_rekening_id IS
'Grootboekrekening waarop openstaande verkoopvorderingen worden geboekt (standaard 1300 Debiteuren). NULL = nog niet geconfigureerd; client-readiness meldt dit als config_ontbreekt.';

COMMENT ON COLUMN public.clients.crediteuren_rekening_id IS
'Grootboekrekening waarop openstaande inkoopschulden worden geboekt (standaard 1600 Crediteuren). NULL = nog niet geconfigureerd; client-readiness meldt dit als config_ontbreekt.';

COMMENT ON COLUMN public.sales_invoices.grootboekrekening_id IS
'Expliciete omzetrekening voor deze verkoopfactuur. Vervangt op termijn de vrije tekst in ledger_account_text, die voor historie en de bestaande export behouden blijft.';
