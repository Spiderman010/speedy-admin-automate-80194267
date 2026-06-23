-- Add CAMT.053 source fields to bank_transactions so the UI can highlight
-- which part of the description came from Ustrd / AddtlNtryInf / counterparty name.
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS camt_ustrd TEXT,
  ADD COLUMN IF NOT EXISTS camt_addtl_ntry_inf TEXT,
  ADD COLUMN IF NOT EXISTS camt_counterparty_name TEXT;

-- rollback: ALTER TABLE public.bank_transactions DROP COLUMN camt_ustrd, DROP COLUMN camt_addtl_ntry_inf, DROP COLUMN camt_counterparty_name;