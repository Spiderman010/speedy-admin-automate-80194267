-- Test double for the SOURCE tables that close_fiscal_year() re-checks.
--
-- Why doubles and not the real writer migrations: the purchase, sales and bank
-- writers (6C-b3, 6C-b4, 6C-b5) each drag in their own prerequisites, and none
-- of that is what is under test here. What IS under test is whether the year
-- close writer reads these tables with exactly the rules the product already
-- uses. That parity is guarded from TypeScript, where the canonical constants
-- live: see src/test/year-close-writer.test.ts, which asserts the migration's
-- SQL against PURCHASE_POSTABLE_STATUSES / SALES_POSTABLE_STATUSES and against
-- the marker and date columns that src/hooks/useUnpostedSourceWork.ts reads.
--
-- Columns are therefore only those the writer actually touches, with the real
-- names and the real types.

\set ON_ERROR_STOP on
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS public.purchase_invoices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NULL REFERENCES public.clients (id),
  status       text NOT NULL DEFAULT 'nieuw',
  invoice_date date NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sales_invoices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NULL REFERENCES public.clients (id),
  status       text NOT NULL DEFAULT 'concept',
  btw_verlegd  boolean NOT NULL DEFAULT false,
  invoice_date date NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NULL REFERENCES public.clients (id),
  transaction_date date NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bank_transaction_allocations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NULL REFERENCES public.clients (id),
  bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions (id),
  invoice_id          uuid NOT NULL,
  invoice_type        text NOT NULL CHECK (invoice_type IN ('inkoop', 'verkoop')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Marker tables, shaped exactly as the real writers create them (only the
-- columns the year close writer reads).
CREATE TABLE IF NOT EXISTS public.purchase_invoice_postings (
  purchase_invoice_id uuid PRIMARY KEY,
  client_id           uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sales_invoice_postings (
  sales_invoice_id uuid PRIMARY KEY,
  client_id        uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bank_allocation_postings (
  allocation_id uuid PRIMARY KEY,
  client_id     uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
