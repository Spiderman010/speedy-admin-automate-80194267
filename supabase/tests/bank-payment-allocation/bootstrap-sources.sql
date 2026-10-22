-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- De applicatietabellen zoals ze in productie bestaan VÓÓR de grootboekketen
-- (20260904120000 en later). Draait direct na ../opening-balance/bootstrap.sql.
--
-- VERSCHIL MET ../bank-direct-allocation-guard/bootstrap-sources.sql (F1a-N2)
--   Dat dubbel geeft elke tabel dezelfde vereenvoudigde RLS (ook verkoop vanaf
--   assistant), mist de status-CHECK's en legt een extra foreign key van
--   purchase_invoice_lines naar purchase_invoices. De betaalschrijver hangt juist
--   van die drie af. Hier daarom:
--     • GEEN policies en geen prevent_org_user_rebind_trg: run-proof.sh voert
--       de ECHTE blokken 3A.4–3A.7 en 3A.12 van 20260613001452 letterlijk uit
--       (via sed), dus verkoop vanaf owner, koppelingen verwijderen vanaf
--       accountant;
--     • de echte status-CHECK's: verkoop 20260411231231, inkoop 20260416091500;
--     • purchase_invoice_lines zonder foreign key naar purchase_invoices
--       (20260511193208);
--     • rechten zoals Supabase ze standaard geeft: ALLES voor anon,
--       authenticated en service_role (RLS beslist; service_role omzeilt RLS).
--       Zo zijn de REVOKE's van P5c hier dragend, net als in productie.
--   De echte lichamen van update_updated_at_column() en set_organization_id()
--   installeert run-proof.sh na de keten (zoals ../bank-release-hold-history).

\set ON_ERROR_STOP on
SET client_min_messages = warning;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS btw_vrijgesteld boolean NOT NULL DEFAULT false;

CREATE TABLE public.bank_transactions (
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
  ledger_account_id    uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_transactions_match_status_check
    CHECK (match_status = ANY (ARRAY['niet_gematcht', 'suggestie', 'gematcht', 'handmatig_geboekt'])),
  CONSTRAINT bank_transactions_id_user_client_unique UNIQUE (id, user_id, client_id)
);

CREATE TABLE public.purchase_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users (id),
  client_id            uuid NOT NULL REFERENCES public.clients (id),
  organization_id      uuid REFERENCES public.organizations (id),
  supplier             text NOT NULL,
  supplier_btw_number  text,
  invoice_number       text,
  invoice_date         date,
  amount_excl          numeric(12,2),
  btw_amount           numeric(12,2),
  amount_incl          numeric(12,2),
  btw_percentage       numeric(5,2) DEFAULT 21,
  remaining_amount     numeric(12,2),
  ledger_account_id    uuid,
  ledger_account_text  text,
  grootboekrekening_id uuid REFERENCES public.grootboekrekeningen (id),
  leverancier_id       uuid,
  status               text NOT NULL DEFAULT 'te_controleren',
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- 20260416091500
  CONSTRAINT purchase_invoices_status_check
    CHECK (status = ANY (ARRAY['te_controleren'::text, 'gecontroleerd'::text, 'geexporteerd'::text, 'betaald'::text]))
);

-- 20260511193208: geen foreign key naar purchase_invoices.
CREATE TABLE public.purchase_invoice_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_invoice_id  uuid NOT NULL,
  user_id              uuid NOT NULL,
  organization_id      uuid REFERENCES public.organizations (id),
  omschrijving         text NOT NULL,
  amount_excl          numeric NOT NULL,
  btw_percentage       numeric,
  grootboekrekening_id uuid,
  sort_order           integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pil_invoice ON public.purchase_invoice_lines (purchase_invoice_id);

CREATE TABLE public.sales_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users (id),
  client_id            uuid NOT NULL REFERENCES public.clients (id),
  organization_id      uuid REFERENCES public.organizations (id),
  customer_name        text NOT NULL,
  invoice_number       text NOT NULL,
  invoice_date         date NOT NULL,
  due_date             date,
  amount_excl          numeric(12,2),
  btw_amount           numeric(12,2),
  amount_incl          numeric(12,2),
  btw_percentage       numeric(5,2) DEFAULT 21,
  btw_verlegd          boolean NOT NULL DEFAULT false,
  remaining_amount     numeric(12,2),
  ledger_account_text  text,
  status               text NOT NULL DEFAULT 'concept',
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- 20260411231231
  CONSTRAINT sales_invoices_status_check
    CHECK (status = ANY (ARRAY['concept'::text, 'gecontroleerd'::text, 'verzonden'::text, 'betaald'::text]))
);

-- 20260515120000 (met organization_id uit 20260531223619)
CREATE TABLE public.bank_transaction_allocations (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid          NOT NULL,
  invoice_type        text          NOT NULL CHECK (invoice_type IN ('inkoop', 'verkoop')),
  invoice_id          uuid          NOT NULL,
  client_id           uuid          NOT NULL REFERENCES public.clients (id),
  organization_id     uuid          REFERENCES public.organizations (id),
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  user_id             uuid          NOT NULL REFERENCES auth.users (id),
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT bta_tx_user_client_fk
    FOREIGN KEY (bank_transaction_id, user_id, client_id)
    REFERENCES public.bank_transactions (id, user_id, client_id)
    ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_bta_tx_invoice ON public.bank_transaction_allocations (bank_transaction_id, invoice_id);
CREATE INDEX idx_bta_bank_transaction ON public.bank_transaction_allocations (bank_transaction_id);

-- set_organization_id_trigger (20260603230656) en de updated_at-triggers
-- (20260411182021, 20260515120000). prevent_org_user_rebind_trg komt uit de
-- echte RLS-blokken.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_transactions', 'purchase_invoices', 'purchase_invoice_lines',
                           'sales_invoices', 'bank_transaction_allocations'] LOOP
    EXECUTE format('CREATE TRIGGER set_organization_id_trigger BEFORE INSERT ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.set_organization_id()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['bank_transactions', 'purchase_invoices', 'sales_invoices',
                           'bank_transaction_allocations'] LOOP
    EXECUTE format('CREATE TRIGGER update_%s_updated_at BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['bank_transactions', 'purchase_invoices', 'purchase_invoice_lines',
                           'sales_invoices', 'bank_transaction_allocations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT ALL ON public.%I TO anon, authenticated, service_role', t);
  END LOOP;
END
$$;

-- Zie ../bank-direct-allocation-guard/bootstrap-sources.sql: het testdubbel van
-- ledger_link_org_ok() moet weg, zodat de echte 20260904120000 hem aanmaakt.
DROP FUNCTION IF EXISTS public.ledger_link_org_ok(uuid, uuid);
