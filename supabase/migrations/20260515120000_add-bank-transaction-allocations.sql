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

CREATE TABLE IF NOT EXISTS public.bank_transaction_allocations (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id UUID          NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  invoice_type        TEXT          NOT NULL CHECK (invoice_type IN ('inkoop', 'verkoop')),
  invoice_id          UUID          NOT NULL,
  client_id           UUID          NOT NULL REFERENCES public.clients(id),
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  user_id             UUID          NOT NULL REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Prevent duplicate (tx, invoice) pairings; used as the conflict target for upserts.
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

-- Row-level security: users may only see and modify their own allocation rows.
ALTER TABLE public.bank_transaction_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own bank transaction allocations"
  ON public.bank_transaction_allocations
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Keep updated_at current using the project-wide trigger function.
CREATE TRIGGER update_bank_transaction_allocations_updated_at
  BEFORE UPDATE ON public.bank_transaction_allocations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
