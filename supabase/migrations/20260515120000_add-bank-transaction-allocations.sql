-- Migration: add bank_transaction_allocations
-- Purpose: foundation for many-to-many bank transaction / invoice matching.
--   Each row records that a specific bank transaction contributes `amount`
--   toward a specific invoice.  The invoice_id is an untyped UUID that may
--   point to either purchase_invoices or sales_invoices (same convention as
--   bank_transactions.matched_invoice_id).
-- This migration is fully additive: no existing columns or tables are changed.
--
-- rollback:
--   DROP TABLE IF EXISTS public.bank_transaction_allocations;
--   ALTER TABLE public.bank_transactions
--     DROP CONSTRAINT IF EXISTS bank_transactions_id_user_client_unique;

-- Step 1 ─────────────────────────────────────────────────────────────────────
-- Add a unique constraint on bank_transactions(id, user_id, client_id).
--
-- This is required as the referent for the composite FK below (PostgreSQL only
-- accepts a UNIQUE constraint, not a plain unique index, as an FK target).
-- Because `id` is already the primary key the combination is trivially unique;
-- the constraint adds no real restriction, only the catalog entry Postgres needs.
ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_transactions_id_user_client_unique
  UNIQUE (id, user_id, client_id);

-- Step 2 ─────────────────────────────────────────────────────────────────────
-- Create the allocation table.
--
-- Security model:
--   • The composite FK (bank_transaction_id, user_id, client_id) →
--     bank_transactions(id, user_id, client_id) enforces at the DB level that:
--       - allocation.user_id  = bank_transaction.user_id  (cross-user write blocked)
--       - allocation.client_id = bank_transaction.client_id (client mismatch blocked)
--   • The separate REFERENCES auth.users(id) on user_id keeps direct user integrity.
--   • The separate REFERENCES public.clients(id) on client_id keeps direct client
--     referential integrity even without traversing the bank_transactions path.
--   • RLS (auth.uid() = user_id) adds a second layer that prevents reads/writes
--     to rows not owned by the authenticated user.
CREATE TABLE IF NOT EXISTS public.bank_transaction_allocations (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id UUID          NOT NULL,
  invoice_type        TEXT          NOT NULL CHECK (invoice_type IN ('inkoop', 'verkoop')),
  invoice_id          UUID          NOT NULL,
  client_id           UUID          NOT NULL REFERENCES public.clients(id),
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  user_id             UUID          NOT NULL REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- Composite FK: enforces that user_id AND client_id are consistent with the
  -- referenced bank transaction.  ON DELETE CASCADE removes allocations when the
  -- parent transaction is deleted.
  CONSTRAINT bta_tx_user_client_fk
    FOREIGN KEY (bank_transaction_id, user_id, client_id)
    REFERENCES public.bank_transactions(id, user_id, client_id)
    ON DELETE CASCADE
);

-- Step 3 ─────────────────────────────────────────────────────────────────────
-- Indexes

-- Prevent duplicate (tx, invoice) pairings; serves as the conflict target for
-- upserts (ON CONFLICT (bank_transaction_id, invoice_id)).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bta_tx_invoice
  ON public.bank_transaction_allocations(bank_transaction_id, invoice_id);

-- Fast lookups by invoice (find all transactions that cover a given invoice).
CREATE INDEX IF NOT EXISTS idx_bta_invoice
  ON public.bank_transaction_allocations(invoice_id);

-- Fast lookups by client (list all allocations for a client).
CREATE INDEX IF NOT EXISTS idx_bta_client
  ON public.bank_transaction_allocations(client_id);

-- Fast lookups by transaction (list all invoices covered by a given transaction).
CREATE INDEX IF NOT EXISTS idx_bta_bank_transaction
  ON public.bank_transaction_allocations(bank_transaction_id);

-- Step 4 ─────────────────────────────────────────────────────────────────────
-- Row-level security

ALTER TABLE public.bank_transaction_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own bank transaction allocations"
  ON public.bank_transaction_allocations
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Step 5 ─────────────────────────────────────────────────────────────────────
-- Keep updated_at current using the project-wide trigger function.

CREATE TRIGGER update_bank_transaction_allocations_updated_at
  BEFORE UPDATE ON public.bank_transaction_allocations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
