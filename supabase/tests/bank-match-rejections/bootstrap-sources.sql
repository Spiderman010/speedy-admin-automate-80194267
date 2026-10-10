-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- Alleen wat de afwijzingstrigger leest en wat dit bewijs nodig heeft om te
-- laten zien dat er NIETS anders verandert: de twee factuurtabellen (id +
-- client_id, de echte namen en typen uit 20260411182021) en de leespolicy op de
-- afletteringen (20260613001452). bank_transactions en
-- bank_transaction_allocations komen uit ../bank-transaction-posting/bootstrap-extra.sql.

\set ON_ERROR_STOP on
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS public.purchase_invoices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid REFERENCES public.clients (id),
  status     text NOT NULL DEFAULT 'te_controleren',
  amount_incl numeric(12,2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sales_invoices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES public.clients (id),
  status     text NOT NULL DEFAULT 'concept',
  amount_incl numeric(12,2),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bank_transaction_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_bank_transaction_allocations_select ON public.bank_transaction_allocations;
CREATE POLICY role_bank_transaction_allocations_select ON public.bank_transaction_allocations
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));
