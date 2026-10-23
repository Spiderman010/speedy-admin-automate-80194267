-- P1: retain bank-statement reversal metadata across import and subsequent matching.
-- Rollout: add column before deploying importers/readers that use is_reversal.
-- Existing rows are NOT automatically classified; false is not proof of a normal payment.
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS is_reversal boolean;

COMMENT ON COLUMN public.bank_transactions.is_reversal IS
  'True when a source MT940 RC/RD or CAMT RvslInd identifies a reversal; historical false/unknown rows need separate review.';

CREATE INDEX IF NOT EXISTS idx_bank_transactions_reversal
  ON public.bank_transactions (organization_id, is_reversal)
  WHERE is_reversal = true;

-- rollback (manual, separately authorized):
-- DROP INDEX IF EXISTS public.idx_bank_transactions_reversal;
-- ALTER TABLE public.bank_transactions DROP COLUMN IF EXISTS is_reversal;

-- Defense in depth without adding a trigger (bank posting trigger contract must stay unchanged).
-- Existing rows retain NULL (unclassified) until source evidence is independently reviewed.
-- NOT VALID avoids rejecting historical matches until they can be classified; new
-- and updated rows must not acquire or retain an invoice match while UNKNOWN.
-- Before validating, audit historical NULL rows and repair them explicitly.
ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_reversal_cannot_be_invoice_match
  CHECK (is_reversal IS FALSE OR (matched_invoice_id IS NULL AND match_status <> 'gematcht')) NOT VALID;

-- rollback (manual only, separately authorized):
-- ALTER TABLE public.bank_transactions DROP CONSTRAINT bank_reversal_cannot_be_invoice_match;

-- P5 compatibility: enforce evidence at the allocation writer boundary.
-- This also covers link_bank_payment() and direct writes through older clients.
-- Do not alter the protected bank_transactions trigger set.
CREATE OR REPLACE FUNCTION public.reject_unverified_bank_payment_allocation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bank_transactions bt
    WHERE bt.id = NEW.bank_transaction_id AND bt.is_reversal IS FALSE
  ) THEN
    RAISE EXCEPTION 'Storno-status ontbreekt of transactie is een storno; factuurallocatie geweigerd'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reject_unverified_bank_payment_allocation ON public.bank_transaction_allocations;
CREATE TRIGGER reject_unverified_bank_payment_allocation
  BEFORE INSERT OR UPDATE ON public.bank_transaction_allocations
  FOR EACH ROW EXECUTE FUNCTION public.reject_unverified_bank_payment_allocation();

-- rollback (manual only, separately authorized):
-- DROP TRIGGER IF EXISTS reject_unverified_bank_payment_allocation ON public.bank_transaction_allocations;
-- DROP FUNCTION IF EXISTS public.reject_unverified_bank_payment_allocation();
