-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- De applicatietabellen zoals ze in productie bestaan VÓÓR de grootboekketen
-- (20260904120000 en later). Draait direct na ../opening-balance/bootstrap.sql
-- (rollen, auth.uid(), organisaties, clients, grootboekrekeningen,
-- has_min_role(), set_organization_id(), prevent_org_user_rebind()).
--
-- WAT HIER BEWUST NIET STAAT
--   Alles wat de echte migratieketen zelf aanmaakt, zodat die keten het ook
--   echt aanmaakt en het bewijs de echte vorm toetst:
--     • clients.debiteuren_/crediteuren_rekening_id      (20260904120000)
--     • sales_invoices.grootboekrekening_id              (20260904120000)
--     • clients.btw_te_vorderen_/btw_te_betalen_…        (20260915120000)
--     • clients.bank_rekening_id                         (20260916120000)
--     • bank_transactions.btw_percentage                 (20260920195805)
--     • clients.posting_locked_through                   (20260927120000)
--     • elke markertabel, schrijver, claim- en bevriezingstrigger.
--   Dat is het verschil met ../bank-transaction-posting/bootstrap-extra.sql en
--   ../year-close/bootstrap-sources.sql: die zetten stubtabellen voor de
--   markers neer omdat zij 20260915*–20260917120000 niet toepassen. Dit harnas
--   past die echte migraties wél toe — de integriteitsvraag zit precies daar.
--
-- BRONNEN (kolommen, typen, policies, triggers)
--   20260411182021 (facturen, bank_transactions), 20260411210100
--   (btw_vrijgesteld), 20260412230710/20260523035449 (match_status-check),
--   20260511193208 (purchase_invoice_lines), 20260515120000 (koppelingen),
--   20260603230656 (set_organization_id_trigger), 20260613001452
--   (rolpolicies, prevent_org_user_rebind_trg) en de gegenereerde types voor de
--   kolommen die latere app-migraties toevoegden (remaining_amount,
--   leverancier_id, btw_verlegd, …).

\set ON_ERROR_STOP on
SET client_min_messages = warning;

-- ── clients: de pre-ledgerkolom die de bankschrijver leest ──────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS btw_vrijgesteld boolean NOT NULL DEFAULT false;

-- ── bank_transactions ───────────────────────────────────────────────────────
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

-- ── facturen ────────────────────────────────────────────────────────────────
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
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.purchase_invoice_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_invoice_id  uuid NOT NULL REFERENCES public.purchase_invoices (id) ON DELETE CASCADE,
  user_id              uuid NOT NULL,
  organization_id      uuid REFERENCES public.organizations (id),
  omschrijving         text NOT NULL,
  amount_excl          numeric NOT NULL,
  btw_percentage       numeric,
  grootboekrekening_id uuid,
  sort_order           integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now()
);

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
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ── bank_transaction_allocations (20260515120000, met organization_id) ──────
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

-- ── triggers zoals in productie ─────────────────────────────────────────────
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
    EXECUTE format('CREATE TRIGGER prevent_org_user_rebind_trg BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.prevent_org_user_rebind()', t);
    EXECUTE format('CREATE TRIGGER update_%s_updated_at BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t, t);
  END LOOP;
END
$$;

-- ── RLS en rechten zoals in productie (20260613001452) ──────────────────────
-- Lezen vanaf read_only, invoegen en wijzigen vanaf assistant, verwijderen
-- vanaf accountant. Supabase geeft authenticated en service_role tabelrechten;
-- service_role omzeilt RLS (BYPASSRLS), niet de triggers.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_transactions', 'purchase_invoices', 'purchase_invoice_lines',
                           'sales_invoices', 'bank_transaction_allocations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY role_%s_select ON public.%I FOR SELECT TO authenticated
                    USING (public.has_min_role(auth.uid(), organization_id, ''read_only''))', t, t);
    EXECUTE format('CREATE POLICY role_%s_insert ON public.%I FOR INSERT TO authenticated
                    WITH CHECK (public.has_min_role(auth.uid(), organization_id, ''assistant''))', t, t);
    EXECUTE format('CREATE POLICY role_%s_update ON public.%I FOR UPDATE TO authenticated
                    USING (public.has_min_role(auth.uid(), organization_id, ''assistant''))
                    WITH CHECK (public.has_min_role(auth.uid(), organization_id, ''assistant''))', t, t);
    EXECUTE format('CREATE POLICY role_%s_delete ON public.%I FOR DELETE TO authenticated
                    USING (public.has_min_role(auth.uid(), organization_id, ''accountant''))', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END
$$;

-- De opening-balance-bootstrap levert een testdubbel van ledger_link_org_ok()
-- met andere parameternamen; de echte 20260904120000 definieert deze functie
-- zelf en kan haar niet over het dubbel heen leggen. Weg met het dubbel, zodat
-- de echte functie ontstaat.
DROP FUNCTION IF EXISTS public.ledger_link_org_ok(uuid, uuid);
