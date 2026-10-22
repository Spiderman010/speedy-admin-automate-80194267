-- P1: retain bank-statement reversal metadata across import and subsequent matching.
-- Rollout: add column before deploying importers/readers that use is_reversal.
-- Existing rows are NOT automatically classified; false is not proof of a normal payment.
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS is_reversal boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bank_transactions.is_reversal IS
  'True when a source MT940 RC/RD or CAMT RvslInd identifies a reversal; historical false/unknown rows need separate review.';

CREATE INDEX IF NOT EXISTS idx_bank_transactions_reversal
  ON public.bank_transactions (organization_id, is_reversal)
  WHERE is_reversal = true;

-- rollback (manual, separately authorized):
-- DROP INDEX IF EXISTS public.idx_bank_transactions_reversal;
-- ALTER TABLE public.bank_transactions DROP COLUMN IF EXISTS is_reversal;

-- Defense in depth without adding a trigger (bank posting trigger contract must stay unchanged).
-- Existing imported reversals default to false and require a separate historical review.
ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_reversal_cannot_be_invoice_match
  CHECK (NOT is_reversal OR (matched_invoice_id IS NULL AND match_status <> 'gematcht'));

-- rollback (manual only, separately authorized):
-- ALTER TABLE public.bank_transactions DROP CONSTRAINT bank_reversal_cannot_be_invoice_match;
