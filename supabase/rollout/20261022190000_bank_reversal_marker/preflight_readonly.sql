-- READ-ONLY preflight for PR #302 (P1 reversal persistence).
-- Execute ONLY after separately authorizing a read-only check in the correct
-- Lovable Cloud SQL editor, project alxlbdhpbwlehbdbfejw.
-- Do not execute against a personal Supabase project.
-- No data mutation; queries intentionally report aggregate counts only.
-- Run the checks BEFORE applying 20261022190000_bank_reversal_marker.sql.
SELECT
  COUNT(*) AS bank_rows,
  COUNT(*) FILTER (WHERE matched_invoice_id IS NOT NULL OR match_status = 'gematcht')
    AS historically_matched_rows,
  COUNT(*) FILTER (WHERE match_status = 'gematcht' AND matched_invoice_id IS NULL)
    AS status_matched_without_invoice_id
FROM public.bank_transactions;

SELECT
  COUNT(*) AS allocations,
  COUNT(DISTINCT bank_transaction_id) AS allocated_bank_rows
FROM public.bank_transaction_allocations;

-- AFTER the additive column exists, run these SELECT-only checks BEFORE
-- enabling / validating the NOT VALID constraint or allocation trigger.
-- New column remains NULL on historical imports until classification is verified.
-- SELECT COUNT(*) AS historical_unclassified,
--   COUNT(*) FILTER (WHERE matched_invoice_id IS NOT NULL OR match_status = 'gematcht')
--     AS unclassified_with_invoice_match
-- FROM public.bank_transactions WHERE is_reversal IS NULL;
--
-- SELECT COUNT(*) AS allocations_on_unclassified_rows
-- FROM public.bank_transaction_allocations a
-- JOIN public.bank_transactions b ON b.id = a.bank_transaction_id
-- WHERE b.is_reversal IS DISTINCT FROM FALSE;
--
-- HOLD rollout if any existing match or allocation would lose its update path:
-- classify historical rows using source evidence in a separately approved plan.
-- Do not infer is_reversal = false from absence of reversal metadata.
