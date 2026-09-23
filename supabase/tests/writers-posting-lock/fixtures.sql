-- Fixtures for the 6C-b11 PR D proof — THROWAWAY cluster only.
--
-- Elke schrijver krijgt zijn eigen administratie. Dat is geen netheid: de
-- beginbalans eist dat zij het eerste grootboekfeit is, de tegenboeking eist
-- een groep uit een eerdere transactie, en een boekingsblokkade geldt per
-- administratie. Eén gedeelde klant zou die scenario's over elkaar heen laten
-- lopen en de uitkomst afhankelijk maken van de volgorde.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE SCHEMA IF NOT EXISTS proof;

-- ── organisaties, gebruikers, rollen ────────────────────────────────────────

INSERT INTO public.organizations (id, name) VALUES
  ('00000000-0000-0000-0000-00000000a001', 'Agio Finance'),
  ('00000000-0000-0000-0000-00000000a002', 'Andere organisatie')
ON CONFLICT DO NOTHING;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'accountant@agio.test'),
  ('00000000-0000-0000-0000-0000000000e2', 'assistent@agio.test'),
  ('00000000-0000-0000-0000-0000000000e3', 'buitenstaander@ander.test')
ON CONFLICT DO NOTHING;

INSERT INTO public.organization_members (user_id, organization_id) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000a002')
ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001', 'accountant'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000a001', 'assistant'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000a002', 'accountant')
ON CONFLICT DO NOTHING;

-- ── proefhulpjes ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proof.result (
  n      text,
  name   text,
  ok     boolean,
  detail text
);
GRANT INSERT, SELECT ON proof.result TO public;

CREATE OR REPLACE FUNCTION proof.record(_n text, _name text, _ok boolean, _detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO proof.result VALUES (_n, _name, _ok, _detail);
$$;

CREATE OR REPLACE FUNCTION proof.expect_error(_n text, _name text, _sql text, _needle text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_msg text;
BEGIN
  BEGIN
    EXECUTE _sql;
    INSERT INTO proof.result VALUES (_n, _name, false, 'GEEN fout, terwijl een fout werd verwacht');
    RETURN;
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;
  IF position(lower(_needle) IN lower(v_msg)) > 0 THEN
    INSERT INTO proof.result VALUES (_n, _name, true, v_msg);
  ELSE
    INSERT INTO proof.result VALUES (_n, _name, false, format('andere fout dan verwacht (%s): %s', _needle, v_msg));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS proof.subject (rol text PRIMARY KEY, client_id uuid NOT NULL);

/** Een volledig ingerichte administratie: rekeningen én de vijf koppelingen. */
CREATE OR REPLACE FUNCTION proof.new_client(_name text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_org   uuid := '00000000-0000-0000-0000-00000000a001';
  v_id    uuid;
  v_kost  uuid; v_deb uuid; v_cred uuid; v_btwv uuid; v_btwb uuid; v_bank uuid; v_omzet uuid;
BEGIN
  INSERT INTO public.clients (organization_id, name) VALUES (v_org, _name) RETURNING id INTO v_id;

  INSERT INTO public.grootboekrekeningen (client_id, organization_id, nummer, omschrijving) VALUES
    (v_id, v_org, 4000, 'Kosten')            RETURNING id INTO v_kost;
  INSERT INTO public.grootboekrekeningen (client_id, organization_id, nummer, omschrijving) VALUES
    (v_id, v_org, 1300, 'Debiteuren')        RETURNING id INTO v_deb;
  INSERT INTO public.grootboekrekeningen (client_id, organization_id, nummer, omschrijving) VALUES
    (v_id, v_org, 1600, 'Crediteuren')       RETURNING id INTO v_cred;
  INSERT INTO public.grootboekrekeningen (client_id, organization_id, nummer, omschrijving) VALUES
    (v_id, v_org, 1520, 'BTW te vorderen')   RETURNING id INTO v_btwv;
  INSERT INTO public.grootboekrekeningen (client_id, organization_id, nummer, omschrijving) VALUES
    (v_id, v_org, 1530, 'BTW te betalen')    RETURNING id INTO v_btwb;
  INSERT INTO public.grootboekrekeningen (client_id, organization_id, nummer, omschrijving) VALUES
    (v_id, v_org, 1100, 'Bank')              RETURNING id INTO v_bank;
  INSERT INTO public.grootboekrekeningen (client_id, organization_id, nummer, omschrijving) VALUES
    (v_id, v_org, 8000, 'Omzet')             RETURNING id INTO v_omzet;

  UPDATE public.clients SET
    debiteuren_rekening_id      = v_deb,
    crediteuren_rekening_id     = v_cred,
    btw_te_vorderen_rekening_id = v_btwv,
    btw_te_betalen_rekening_id  = v_btwb,
    bank_rekening_id            = v_bank
  WHERE id = v_id;

  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION proof.account(_client uuid, _nummer integer)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM public.grootboekrekeningen WHERE client_id = _client AND nummer = _nummer;
$$;

/** Doe iets als een bepaalde gebruiker. */
CREATE OR REPLACE FUNCTION proof.as_user(_uid uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('test.user_id', _uid::text, true);
$$;

CREATE OR REPLACE FUNCTION proof.lock_as(_client uuid, _through date, _reason text DEFAULT 'proef')
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_changed boolean;
BEGIN
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  SELECT s.changed INTO v_changed FROM public.set_posting_lock(_client, _through, _reason) s;
  RETURN v_changed;
END $$;

-- ── brondocumenten ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION proof.new_purchase(_client uuid, _datum date)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.purchase_invoices
    (client_id, organization_id, status, invoice_date, supplier, amount_excl, amount_incl, btw_amount, btw_percentage)
  VALUES (_client, '00000000-0000-0000-0000-00000000a001', 'gecontroleerd', _datum,
          'Leverancier BV', 100.00, 121.00, 21.00, 21)
  RETURNING id INTO v_id;
  INSERT INTO public.purchase_invoice_lines (purchase_invoice_id, grootboekrekening_id, omschrijving, amount_excl)
  VALUES (v_id, proof.account(_client, 4000), 'Kosten', 100.00);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION proof.new_sales(_client uuid, _datum date)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.sales_invoices
    (client_id, organization_id, status, btw_verlegd, invoice_date, invoice_number, customer_name,
     grootboekrekening_id, amount_excl, amount_incl, btw_amount)
  VALUES (_client, '00000000-0000-0000-0000-00000000a001', 'gecontroleerd', false, _datum,
          'F-' || substr(gen_random_uuid()::text, 1, 8), 'Klant BV',
          proof.account(_client, 8000), 100.00, 121.00, 21.00)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION proof.new_bank_tx(_client uuid, _datum date, _bedrag numeric DEFAULT -121.00)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.bank_transactions
    (client_id, organization_id, transaction_date, amount, description, match_status,
     grootboekrekening_id, btw_percentage)
  VALUES (_client, '00000000-0000-0000-0000-00000000a001', _datum, _bedrag, 'Betaling',
          'handmatig_geboekt', proof.account(_client, 4000), 0)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION proof.new_manual(_client uuid, _datum date)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  INSERT INTO public.manual_journals (client_id, organization_id, posting_date, description, user_id)
  VALUES (_client, '00000000-0000-0000-0000-00000000a001', _datum, 'Memoriaal',
          '00000000-0000-0000-0000-0000000000e1')
  RETURNING id INTO v_id;
  INSERT INTO public.manual_journal_lines
    (manual_journal_id, organization_id, user_id, sort_order, grootboekrekening_id, omschrijving, debit_amount, credit_amount)
  VALUES (v_id, '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000e1', 1,
          proof.account(_client, 4000), 'Kosten', 100.00, 0),
         (v_id, '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000e1', 2,
          proof.account(_client, 1600), 'Crediteuren', 0, 100.00);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION proof.new_opening(_client uuid, _datum date)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.opening_balances
    (client_id, organization_id, boekjaar, opening_date, description, user_id)
  VALUES (_client, '00000000-0000-0000-0000-00000000a001', EXTRACT(YEAR FROM _datum)::integer,
          _datum, 'Beginbalans', '00000000-0000-0000-0000-0000000000e1')
  RETURNING id INTO v_id;
  INSERT INTO public.opening_balance_lines
    (opening_balance_id, client_id, organization_id, user_id, sort_order, grootboekrekening_id, description, debit_amount, credit_amount)
  VALUES (v_id, _client, '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000e1', 1,
          proof.account(_client, 1100), 'Bank', 500.00, 0),
         (v_id, _client, '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000e1', 2,
          proof.account(_client, 1600), 'Crediteuren', 0, 500.00);
  RETURN v_id;
END $$;

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

/**
 * Zet het afsluitwatermerk via de ECHTE weg, zodat de proef het oude gedrag
 * toetst en niet een nagebootste toestand. Er moet wél activiteit in dat jaar
 * staan — `close_fiscal_year()` keurt daarop — en er mag geen ongeboekt
 * bronwerk meer open staan, dus roep dit aan VOORDAT je het document maakt dat
 * straks geweigerd moet worden.
 */
CREATE OR REPLACE FUNCTION proof.seed_close(_client uuid, _jaar integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_j uuid;
BEGIN
  -- Via de ECHTE schrijver: dit harnas past alle claimtriggers toe, dus een
  -- met de hand gemaakte grootboekregel wordt terecht geweigerd.
  PERFORM proof.as_user('00000000-0000-0000-0000-0000000000e1');
  v_j := proof.new_manual(_client, make_date(_jaar, 6, 1));
  PERFORM public.post_manual_journal(v_j);
  PERFORM public.close_fiscal_year(_client, _jaar);
END $$;
