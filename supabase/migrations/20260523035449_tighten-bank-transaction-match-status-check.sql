-- Migration: tighten bank_transactions.match_status CHECK constraint
-- Purpose: Remove wacht_op_factuur from the allowed match_status values.
--
-- Background:
--   The constraint was previously set to allow five values:
--     niet_gematcht | suggestie | gematcht | handmatig_geboekt | wacht_op_factuur
--   PR-G-code (PR #58) stopped all application code from writing wacht_op_factuur.
--   The constraint is now tightened to reflect only the four active statuses.
--
-- Precondition (verified by owner in Lovable Cloud SQL editor on 2026-05-23):
--   SELECT match_status, count(*) AS row_count
--   FROM public.bank_transactions
--   GROUP BY match_status
--   ORDER BY row_count DESC;
--
--   Result:
--     handmatig_geboekt  985
--     niet_gematcht      646
--     gematcht            19
--     suggestie            3
--   No wacht_op_factuur rows exist in production.
--
-- This migration contains no UPDATE / DELETE / TRUNCATE — purely structural.
--
-- rollback:
--   ALTER TABLE public.bank_transactions
--     DROP CONSTRAINT IF EXISTS bank_transactions_match_status_check;
--   ALTER TABLE public.bank_transactions
--     ADD CONSTRAINT bank_transactions_match_status_check
--     CHECK (match_status = ANY (ARRAY[
--       'niet_gematcht',
--       'suggestie',
--       'gematcht',
--       'handmatig_geboekt',
--       'wacht_op_factuur'
--     ]));

ALTER TABLE public.bank_transactions
  DROP CONSTRAINT IF EXISTS bank_transactions_match_status_check;

ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_transactions_match_status_check
  CHECK (match_status = ANY (ARRAY[
    'niet_gematcht',
    'suggestie',
    'gematcht',
    'handmatig_geboekt'
  ]));
