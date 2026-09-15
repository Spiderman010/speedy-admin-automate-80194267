-- Migration: client VAT ledger configuration (phase 6C-b2a)
--
-- Purpose: make the two BTW ledger accounts an explicit, per-administratie
-- configuration, so the posting writers can post VAT to a real account instead
-- of guessing one:
--
--   1. clients.btw_te_vorderen_rekening_id  — voorbelasting, debited on a
--      purchase invoice (needed by 6C-b3)
--   2. clients.btw_te_betalen_rekening_id   — af te dragen BTW, credited on a
--      sales invoice (needed by 6C-b4)
--
-- Both are added in one pass because they share a table, a validation trigger
-- and one configuration screen; splitting them would mean touching the same
-- surfaces twice for no benefit. Only the first is required by 6C-b3.
--
-- THIS MIGRATION IS CONFIGURATION ONLY.
--   • no posting is created anywhere;
--   • purchase/sales posting logic is untouched;
--   • both columns start NULL for every administratie.
--
-- NO BACKFILL, deliberately. Unlike 1300/1600 in 20260904120000, there is no
-- unambiguous Dutch default to map: an administratie may use 1520/1530, a
-- single combined BTW account, or a per-rate split, and guessing would silently
-- post VAT to the wrong account on an immutable ledger. Nothing is auto-mapped;
-- client-readiness surfaces the absence instead.
--
-- ACCOUNT SCOPE — stricter than the 20260904120000 columns, deliberately.
-- grootboekrekeningen is scoped one level finer than the organisation: an
-- account is either organisation-wide (client_id IS NULL, the seeded chart) or
-- owned by one administratie (client_id set). These two columns therefore reuse
-- public.posting_account_ok(), which requires the account to sit in the same
-- organisation AND be either shared or owned by this very client. That is the
-- same predicate ledger_postings enforces per row, so configuration cannot
-- record an account that posting would later refuse.
--
-- The existing debiteuren/crediteuren columns keep their looser org-only check
-- (ledger_link_org_ok). Tightening them here would risk rejecting configuration
-- that production already holds, so it is left as a separate, deliberate
-- follow-up rather than smuggled into this migration.
--
-- rollback:
--   DROP TRIGGER IF EXISTS validate_client_ledger_org_trigger ON public.clients;
--   CREATE TRIGGER validate_client_ledger_org_trigger
--     BEFORE INSERT OR UPDATE OF debiteuren_rekening_id, crediteuren_rekening_id, organization_id
--     ON public.clients FOR EACH ROW EXECUTE FUNCTION public.enforce_client_ledger_org();
--   -- (and restore enforce_client_ledger_org() from 20260904120000)
--   ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_btw_te_betalen_rekening_id_fkey;
--   DROP INDEX IF EXISTS public.idx_clients_btw_te_betalen_rekening_id;
--   ALTER TABLE public.clients DROP COLUMN IF EXISTS btw_te_betalen_rekening_id;
--   ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_btw_te_vorderen_rekening_id_fkey;
--   DROP INDEX IF EXISTS public.idx_clients_btw_te_vorderen_rekening_id;
--   ALTER TABLE public.clients DROP COLUMN IF EXISTS btw_te_vorderen_rekening_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Columns — nullable, no default, no backfill
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS btw_te_vorderen_rekening_id uuid;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS btw_te_betalen_rekening_id uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Indexes (mirrors 20260904120000)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_clients_btw_te_vorderen_rekening_id
  ON public.clients (btw_te_vorderen_rekening_id);

CREATE INDEX IF NOT EXISTS idx_clients_btw_te_betalen_rekening_id
  ON public.clients (btw_te_betalen_rekening_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Foreign keys — ON DELETE SET NULL, idempotent
--
--    SET NULL rather than RESTRICT: these are optional configuration links, not
--    accounting identity. Deleting a grootboekrekening must never be blocked by
--    a client's configuration, and an unconfigured client is a state the
--    readiness check already understands and reports. (ledger_postings uses
--    RESTRICT for the opposite reason: posted history must never lose its
--    account.)
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
      AND c.conname = 'clients_btw_te_vorderen_rekening_id_fkey'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_btw_te_vorderen_rekening_id_fkey
      FOREIGN KEY (btw_te_vorderen_rekening_id)
      REFERENCES public.grootboekrekeningen (id)
      ON DELETE SET NULL;
  ELSE
    RAISE NOTICE 'Constraint clients_btw_te_vorderen_rekening_id_fkey already exists, skipping';
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
      AND c.conname = 'clients_btw_te_betalen_rekening_id_fkey'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_btw_te_betalen_rekening_id_fkey
      FOREIGN KEY (btw_te_betalen_rekening_id)
      REFERENCES public.grootboekrekeningen (id)
      ON DELETE SET NULL;
  ELSE
    RAISE NOTICE 'Constraint clients_btw_te_betalen_rekening_id_fkey already exists, skipping';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Tenant + administratie consistency
--
--    enforce_client_ledger_org() is REPLACED (not redefined elsewhere) so the
--    two existing checks keep working exactly as before and the two new columns
--    are validated alongside them by the same trigger.
--
--    NULL stays allowed on all four columns: NULL means "not configured yet",
--    which is precisely what client-readiness reports. The FK's ON DELETE SET
--    NULL therefore keeps working — nulling a link always passes.
-- ─────────────────────────────────────────────────────────────────────────────

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

  -- The BTW links use the stricter account-scope predicate: same organisation,
  -- and either a shared account (client_id IS NULL) or one owned by this very
  -- administratie. Another administratie's account is refused.
  IF NEW.btw_te_vorderen_rekening_id IS NOT NULL
     AND NOT public.posting_account_ok(NEW.btw_te_vorderen_rekening_id, NEW.organization_id, NEW.id) THEN
    RAISE EXCEPTION 'btw_te_vorderen_rekening_id verwijst naar een grootboekrekening buiten deze organisatie of van een andere administratie'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.btw_te_betalen_rekening_id IS NOT NULL
     AND NOT public.posting_account_ok(NEW.btw_te_betalen_rekening_id, NEW.organization_id, NEW.id) THEN
    RAISE EXCEPTION 'btw_te_betalen_rekening_id verwijst naar een grootboekrekening buiten deze organisatie of van een andere administratie'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_client_ledger_org() FROM PUBLIC;

-- The trigger must be recreated: its UPDATE OF column list decides when it
-- fires, so without the two new columns an update touching only a BTW link
-- would skip validation entirely. The "validate_" prefix still sorts after
-- "set_organization_id_trigger", so organization_id is resolved before it is
-- compared.
DROP TRIGGER IF EXISTS validate_client_ledger_org_trigger ON public.clients;
CREATE TRIGGER validate_client_ledger_org_trigger
  BEFORE INSERT OR UPDATE OF
    debiteuren_rekening_id,
    crediteuren_rekening_id,
    btw_te_vorderen_rekening_id,
    btw_te_betalen_rekening_id,
    organization_id
  ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.enforce_client_ledger_org();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Documentation
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON COLUMN public.clients.btw_te_vorderen_rekening_id IS
'Grootboekrekening voor BTW te vorderen (voorbelasting): wordt gedebiteerd bij een inkoopfactuur. NULL = nog niet geconfigureerd; client-readiness meldt dit als config_ontbreekt. Bewust niet automatisch op 1520 of een ander nummer gemapt.';

COMMENT ON COLUMN public.clients.btw_te_betalen_rekening_id IS
'Grootboekrekening voor BTW te betalen (af te dragen BTW): wordt gecrediteerd bij een verkoopfactuur. NULL = nog niet geconfigureerd; client-readiness meldt dit als config_ontbreekt. Bewust niet automatisch op 1530 of een ander nummer gemapt.';
