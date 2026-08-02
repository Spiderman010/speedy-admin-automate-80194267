-- Bank match rejections: persist explicitly rejected/unlinked
-- (bank_transaction, invoice) combinations so automatic matching never
-- re-suggests an invoice a user already rejected for that transaction.
-- Scope: only the exact rejected combination is excluded — the transaction
-- stays matchable to other invoices, and the invoice stays matchable to
-- other transactions. Manual confirmation of a rejected invoice remains
-- possible and clears the rejection row.
--
-- NOT executed against production by this PR. Rollout steps are documented
-- in the pull request description.

CREATE TABLE IF NOT EXISTS public.bank_match_rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  client_id uuid NOT NULL,
  bank_transaction_id uuid NOT NULL
    REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  -- No FK on invoice_id: it can reference purchase_invoices OR
  -- sales_invoices, disambiguated by invoice_type (same convention as
  -- bank_transaction_allocations).
  invoice_id uuid NOT NULL,
  invoice_type text NOT NULL CHECK (invoice_type IN ('inkoop', 'verkoop')),
  rejected_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One rejection row per scoped combination; the app upserts with
-- ignoreDuplicates so repeat rejections can never create duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS bank_match_rejections_tx_invoice_key
  ON public.bank_match_rejections (bank_transaction_id, invoice_id);

CREATE INDEX IF NOT EXISTS bank_match_rejections_org_idx
  ON public.bank_match_rejections (organization_id);

CREATE INDEX IF NOT EXISTS bank_match_rejections_client_idx
  ON public.bank_match_rejections (client_id);

ALTER TABLE public.bank_match_rejections ENABLE ROW LEVEL SECURITY;

-- Org-scoped RLS, consistent with the repository convention
-- (is_organization_member on a NOT NULL organization_id).
CREATE POLICY "org_members_bank_match_rejections_select"
ON public.bank_match_rejections
FOR SELECT
TO authenticated
USING (public.is_organization_member(auth.uid(), organization_id));

CREATE POLICY "org_members_bank_match_rejections_insert"
ON public.bank_match_rejections
FOR INSERT
TO authenticated
WITH CHECK (public.is_organization_member(auth.uid(), organization_id));

CREATE POLICY "org_members_bank_match_rejections_delete"
ON public.bank_match_rejections
FOR DELETE
TO authenticated
USING (public.is_organization_member(auth.uid(), organization_id));

-- No UPDATE policy: rejection rows are immutable facts. They are created on
-- reject/unlink and deleted when the same invoice is explicitly manually
-- confirmed again.

-- Verification (run read-only after applying):
-- V1: select to_regclass('public.bank_match_rejections');
-- V2: select indexname from pg_indexes
--       where tablename = 'bank_match_rejections';
-- V3: select policyname, cmd from pg_policies
--       where tablename = 'bank_match_rejections';

-- rollback:
--   DROP TABLE IF EXISTS public.bank_match_rejections;
--   (policies and indexes are dropped with the table)
