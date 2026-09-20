-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- Aanvulling op ../opening-balance/bootstrap.sql met precies dat wat de
-- directe bankboeking aanraakt en dat daar nog niet in stond: de
-- configuratiekolommen op clients, de banktransacties zelf, de
-- afletteringstabellen waar de writer op controleert, en de leespolicy die
-- bepaalt wie een banktransactie überhaupt mag zien.
--
-- De kolommen en policies zijn overgenomen uit de echte migraties
-- (20260411182021 bank_transactions, 20260411210100 btw_vrijgesteld,
-- 20260515120000 bank_transaction_allocations, 20260613001452 de rolpolicies,
-- 20260915120000 de BTW-rekeningen, 20260916120000 bank_rekening_id), zodat
-- het bewijs de echte vorm toetst en niet een vereenvoudiging.
--
-- btw_percentage op bank_transactions staat hier BEWUST NIET: die kolom wordt
-- door de toegepaste migratie 20260920195805 zelf toegevoegd, en dat hoort het
-- bewijs ook zo te ervaren.

SET client_min_messages = warning;

-- ── clients: de vier configuratiekolommen ───────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS btw_vrijgesteld              boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bank_rekening_id             uuid REFERENCES public.grootboekrekeningen (id),
  ADD COLUMN IF NOT EXISTS btw_te_vorderen_rekening_id  uuid REFERENCES public.grootboekrekeningen (id),
  ADD COLUMN IF NOT EXISTS btw_te_betalen_rekening_id   uuid REFERENCES public.grootboekrekeningen (id);

-- ── bank_transactions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users (id),
  client_id            uuid NOT NULL REFERENCES public.clients (id),
  organization_id      uuid REFERENCES public.organizations (id),
  transaction_date     date NOT NULL,
  description          text,
  amount               numeric(12,2) NOT NULL,
  counter_account      text,
  reference            text,
  matched_invoice_id   uuid,
  match_confidence     numeric(5,2),
  match_status         text NOT NULL DEFAULT 'niet_gematcht',
  grootboekrekening_id uuid REFERENCES public.grootboekrekeningen (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;

-- De leesvloer die de nieuwe tenantpoort weerspiegelt: read_only,
-- organisatiebreed (20260613001452).
DROP POLICY IF EXISTS role_bank_transactions_select ON public.bank_transactions;
CREATE POLICY role_bank_transactions_select ON public.bank_transactions
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

GRANT SELECT ON public.bank_transactions TO authenticated, service_role;

-- ── afletteringen: alleen wat de writer erover vraagt ───────────────────────
CREATE TABLE IF NOT EXISTS public.bank_transaction_allocations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions (id),
  organization_id     uuid REFERENCES public.organizations (id),
  client_id           uuid REFERENCES public.clients (id),
  invoice_id          uuid,
  invoice_type        text,
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  user_id             uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- prevent_posted_bank_transaction_mutation() leest deze tabel. In dit harnas
-- draait de bijbehorende trigger niet (die hoort bij 20260917120000, dat hier
-- niet wordt toegepast); de tabel moet wel bestaan zodat de functie compileert
-- en de writer haar EXISTS-controle kan doen.
CREATE TABLE IF NOT EXISTS public.bank_allocation_postings (
  allocation_id       uuid PRIMARY KEY,
  bank_transaction_id uuid NOT NULL,
  posting_group_id    uuid NOT NULL,
  organization_id     uuid NOT NULL,
  client_id           uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.bank_transaction_allocations, public.bank_allocation_postings
  TO authenticated, service_role;
