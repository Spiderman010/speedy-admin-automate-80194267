-- Migration: client bank ledger configuration (phase 6C-b5a)
--
-- Purpose: make the bank general-ledger account an explicit, per-administratie
-- configuration, so a future bank-settlement writer has a provable account to
-- post against:
--
--   1. clients.bank_rekening_id — de grootboekrekening waarop bankmutaties /
--      afletteringen worden geboekt (needed by 6C-b5b)
--
-- WHY THIS EXISTS. The 6C-b5 audit proved that nothing in the schema today
-- identifies a client's bank grootboekrekening:
--   • clients.bank_dagboek is a SnelStart *dagboek* integer, not a
--     grootboekrekeningen FK, is often NULL, and the UI falls back to 1100;
--   • bank_transactions.grootboekrekening_id is the CONTRA account of a
--     mutation, not the bank account itself;
--   • bank_transactions.ledger_account_id points at the legacy ledger_accounts
--     table, not at grootboekrekeningen;
--   • grootboekrekeningen.categorie has no 'bank' value to filter on.
-- The account is therefore configured explicitly here and never inferred from a
-- number, from categorie, or from bank_dagboek.
--
-- PHASE SPLIT.
--   • 6C-b5a (this migration) = configuration only.
--   • 6C-b5b (next phase)     = the bank settlement writer that consumes it.
--
-- THIS MIGRATION IS CONFIGURATION ONLY.
--   • no posting is created anywhere;
--   • no settlement marker or writer is added (that is 6C-b5b);
--   • purchase/sales posting logic is untouched;
--   • the column starts NULL for every administratie.
--
-- NO BACKFILL, deliberately. Unlike 1300/1600 in 20260904120000, there is no
-- unambiguous default to map: an administratie may use 1100, 1101, one account
-- per bank or IBAN, or any other number, and 1100 is merely a UI fallback for a
-- *dagboek* — not evidence of a grootboekrekening. Guessing would silently post
-- settlements to the wrong account on an immutable ledger. Nothing is
-- auto-mapped; client-readiness surfaces the absence instead.
--
-- ACCOUNT SCOPE — the stricter predicate, as in 20260915120000.
-- grootboekrekeningen is scoped one level finer than the organisation: an
-- account is either organisation-wide (client_id IS NULL, the seeded chart) or
-- owned by one administratie (client_id set). This column therefore reuses
-- public.posting_account_ok(), which requires the account to sit in the same
-- organisation AND be either shared or owned by this very client. That is the
-- same predicate ledger_postings enforces per row, so configuration cannot
-- record an account that posting would later refuse.
--
-- The existing debiteuren/crediteuren columns keep their looser org-only check
-- (ledger_link_org_ok); they are not touched here.
--
-- rollback:
--   DROP TRIGGER IF EXISTS validate_client_ledger_org_trigger ON public.clients;
--   CREATE TRIGGER validate_client_ledger_org_trigger
--     BEFORE INSERT OR UPDATE OF
--       debiteuren_rekening_id,
--       crediteuren_rekening_id,
--       btw_te_vorderen_rekening_id,
--       btw_te_betalen_rekening_id,
--       organization_id
--     ON public.clients FOR EACH ROW EXECUTE FUNCTION public.enforce_client_ledger_org();
--   -- (and restore enforce_client_ledger_org() from 20260915120000, i.e. the
--   --  four-check version without the bank_rekening_id check)
--   ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_bank_rekening_id_fkey;
--   DROP INDEX IF EXISTS public.idx_clients_bank_rekening_id;
--   ALTER TABLE public.clients DROP COLUMN IF EXISTS bank_rekening_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Column — nullable, no default, no backfill
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS bank_rekening_id uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Index (mirrors 20260915120000)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_clients_bank_rekening_id
  ON public.clients (bank_rekening_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Foreign key — ON DELETE SET NULL, idempotent
--
--    SET NULL rather than RESTRICT: this is an optional configuration link, not
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
      AND c.conname = 'clients_bank_rekening_id_fkey'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_bank_rekening_id_fkey
      FOREIGN KEY (bank_rekening_id)
      REFERENCES public.grootboekrekeningen (id)
      ON DELETE SET NULL;
  ELSE
    RAISE NOTICE 'Constraint clients_bank_rekening_id_fkey already exists, skipping';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Tenant + administratie consistency
--
--    enforce_client_ledger_org() is REPLACED (not redefined elsewhere) so the
--    four existing checks keep working exactly as before and the new column is
--    validated alongside them by the same trigger. No new SECURITY DEFINER
--    function is introduced: this one already is the precedent.
--
--    NULL stays allowed on all five columns: NULL means "not configured yet",
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

  -- De bankrekening volgt hetzelfde strikte bereik als de BTW-koppelingen: de
  -- toekomstige afletteringsboeking (6C-b5b) schrijft op deze rekening, dus
  -- configuratie mag geen rekening vastleggen die het boeken later weigert.
  IF NEW.bank_rekening_id IS NOT NULL
     AND NOT public.posting_account_ok(NEW.bank_rekening_id, NEW.organization_id, NEW.id) THEN
    RAISE EXCEPTION 'bank_rekening_id verwijst naar een grootboekrekening buiten deze organisatie of van een andere administratie'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_client_ledger_org() FROM PUBLIC;

-- The trigger must be recreated: its UPDATE OF column list decides when it
-- fires, so without the new column an update touching only bank_rekening_id
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
    bank_rekening_id,
    organization_id
  ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.enforce_client_ledger_org();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Documentation
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON COLUMN public.clients.bank_rekening_id IS
'Grootboekrekening waarop bankmutaties en bankafletteringen worden geboekt. NULL = nog niet geconfigureerd; client-readiness meldt dit als config_ontbreekt. Bewust niet automatisch op 1100 of een ander nummer gemapt, en niet afgeleid uit bank_dagboek of categorie.';
