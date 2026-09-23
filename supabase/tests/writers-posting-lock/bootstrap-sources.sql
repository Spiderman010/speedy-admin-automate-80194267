-- Test double for the SOURCE tables that the seven posting writers read.
--
-- Deliberately NOT the marker tables: die maken de echte schrijvermigraties
-- zelf aan, compleet met hun tenantkolommen, claimtriggers en rechten. Een
-- vereenvoudigde dubbelganger ervoor neerzetten zou die migraties laten
-- struikelen — en erger, zou de claim- en idempotentiegaranties uit het bewijs
-- halen terwijl die er juist bij horen.
--
-- Alleen de kolommen die de schrijvers werkelijk lezen, met de echte namen en
-- de echte typen.

\set ON_ERROR_STOP on
SET client_min_messages = warning;

-- De twee rekeningkolommen die 20260904120000 aan `clients` toevoegt. Die
-- migratie zelf wordt hier NIET toegepast: zij doet een eenmalige backfill over
-- erfeniskolommen en botst op de functiehandtekeningen in de gedeelde
-- bootstrap. Wat de schrijvers ervan nodig hebben zijn deze twee kolommen.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS debiteuren_rekening_id  uuid NULL REFERENCES public.grootboekrekeningen (id),
  ADD COLUMN IF NOT EXISTS crediteuren_rekening_id uuid NULL REFERENCES public.grootboekrekeningen (id),
  -- Gebruikt door de bulk-preflight om te bepalen of er een BTW-rekening nodig is.
  ADD COLUMN IF NOT EXISTS btw_vrijgesteld         boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.purchase_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NULL REFERENCES public.clients (id),
  organization_id uuid NULL REFERENCES public.organizations (id),
  status          text NOT NULL DEFAULT 'nieuw',
  invoice_date    date NULL,
  invoice_number  text NULL,
  supplier        text NULL,
  amount_excl     numeric(12,2) NULL,
  amount_incl     numeric(12,2) NULL,
  btw_amount      numeric(12,2) NULL,
  btw_percentage  numeric NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.purchase_invoice_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_invoice_id  uuid NOT NULL REFERENCES public.purchase_invoices (id),
  grootboekrekening_id uuid NULL REFERENCES public.grootboekrekeningen (id),
  omschrijving         text NULL,
  amount_excl          numeric(12,2) NULL,
  sort_order           integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sales_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NULL REFERENCES public.clients (id),
  organization_id      uuid NULL REFERENCES public.organizations (id),
  status               text NOT NULL DEFAULT 'concept',
  btw_verlegd          boolean NOT NULL DEFAULT false,
  invoice_date         date NULL,
  invoice_number       text NULL,
  customer_name        text NULL,
  grootboekrekening_id uuid NULL REFERENCES public.grootboekrekeningen (id),
  amount_excl          numeric(12,2) NULL,
  amount_incl          numeric(12,2) NULL,
  btw_amount           numeric(12,2) NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NULL REFERENCES public.clients (id),
  organization_id      uuid NULL REFERENCES public.organizations (id),
  transaction_date     date NULL,
  amount               numeric(12,2) NULL,
  description          text NULL,
  counter_account      text NULL,
  match_status         text NOT NULL DEFAULT 'ongematcht',
  grootboekrekening_id uuid NULL REFERENCES public.grootboekrekeningen (id),
  btw_percentage       numeric NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bank_transaction_allocations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NULL REFERENCES public.clients (id),
  organization_id     uuid NULL REFERENCES public.organizations (id),
  bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions (id),
  invoice_id          uuid NOT NULL,
  invoice_type        text NOT NULL CHECK (invoice_type IN ('inkoop', 'verkoop')),
  amount              numeric(12,2) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
