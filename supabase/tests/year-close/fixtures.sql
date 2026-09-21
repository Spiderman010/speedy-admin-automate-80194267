-- Fixtures for the 6C-b10 year close proof — THROWAWAY cluster only.
--
-- Closing a year is irreversible by design, so almost every scenario gets its
-- OWN administratie. That is not tidiness: reusing one client would make the
-- proofs order-dependent, and an order-dependent proof of an irreversible
-- operation proves nothing.

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

-- ── helpers ─────────────────────────────────────────────────────────────────

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

/** Een verse administratie van Agio Finance, met een eigen grootboekrekening. */
CREATE OR REPLACE FUNCTION proof.new_client(_name text, _org uuid DEFAULT '00000000-0000-0000-0000-00000000a001')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.clients (organization_id, name) VALUES (_org, _name) RETURNING id INTO v_id;
  INSERT INTO public.grootboekrekeningen (client_id, organization_id, nummer, omschrijving)
  VALUES (v_id, _org, 4000, 'Kosten'), (v_id, _org, 1300, 'Debiteuren');
  RETURN v_id;
END $$;

/** Eén gebalanceerde boekingsgroep van twee regels in het opgegeven jaar. */
CREATE OR REPLACE FUNCTION proof.seed_group(_client uuid, _year integer, _amount numeric DEFAULT 100.00)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_org   uuid;
  v_group uuid := gen_random_uuid();
  v_debit uuid;
  v_credit uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.clients WHERE id = _client;
  SELECT id INTO v_debit  FROM public.grootboekrekeningen WHERE client_id = _client AND nummer = 4000;
  SELECT id INTO v_credit FROM public.grootboekrekeningen WHERE client_id = _client AND nummer = 1300;

  INSERT INTO public.ledger_postings
    (organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
     posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, user_id)
  VALUES
    (v_org, _client, v_debit,  v_group, 1, make_date(_year, 6, 1), _year, _amount, 0, 'EUR', 'purchase_invoice',
     '00000000-0000-0000-0000-0000000000e1'),
    (v_org, _client, v_credit, v_group, 2, make_date(_year, 6, 1), _year, 0, _amount, 'EUR', 'purchase_invoice',
     '00000000-0000-0000-0000-0000000000e1');
  RETURN v_group;
END $$;

/** Sluit een jaar af als de accountant en geef terug of er een nieuwe marker kwam. */
CREATE OR REPLACE FUNCTION proof.close_as(_uid uuid, _client uuid, _year integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_created boolean;
BEGIN
  PERFORM set_config('test.user_id', _uid::text, true);
  SELECT c.created INTO v_created FROM public.close_fiscal_year(_client, _year) c;
  RETURN v_created;
END $$;

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
