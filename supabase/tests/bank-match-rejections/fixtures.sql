-- Fixtures voor het bewijs van 20261010120000 — THROWAWAY cluster only.
-- Gebruikers e1 (accountant A), e2 (assistent A) en e3 (accountant B) komen uit
-- ../year-close/fixtures.sql; hier komt e4 (read_only A) bij.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

GRANT USAGE ON SCHEMA proof TO public;

INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000e4', 'meekijker@agio.test')
ON CONFLICT DO NOTHING;
INSERT INTO public.organization_members (user_id, organization_id)
VALUES ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-00000000a001') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, organization_id, role)
VALUES ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-00000000a001', 'read_only') ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION proof.expect_ok(_n text, _name text, _sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE _sql;
  INSERT INTO proof.result VALUES (_n, _name, true, 'uitgevoerd zonder fout');
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('onverwachte fout: %s', SQLERRM));
END $$;

CREATE OR REPLACE FUNCTION proof.expect_true(_n text, _name text, _expr text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  EXECUTE format('SELECT (%s)', _expr) INTO v_ok;
  INSERT INTO proof.result VALUES (_n, _name, COALESCE(v_ok, false), COALESCE(v_ok::text, 'NULL'));
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('fout bij evaluatie: %s', SQLERRM));
END $$;

-- Vaste id's, zodat de bewijzen ze bij naam kunnen noemen.
CREATE TABLE IF NOT EXISTS proof.ids (k text PRIMARY KEY, id uuid NOT NULL);
GRANT SELECT ON proof.ids TO public;
CREATE OR REPLACE FUNCTION proof.id(_k text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM proof.ids WHERE k = _k $$;

DO $$
DECLARE
  a1 uuid := proof.new_client('Bakkerij A1');
  a2 uuid := proof.new_client('Installatie A2');
  b1 uuid := proof.new_client('Ander kantoor B1', '00000000-0000-0000-0000-00000000a002');
  u  uuid := '00000000-0000-0000-0000-0000000000e1';
BEGIN
  INSERT INTO proof.ids VALUES ('a1', a1), ('a2', a2), ('b1', b1);

  INSERT INTO public.bank_transactions (id, user_id, client_id, organization_id, transaction_date, amount, description, match_status, matched_invoice_id, match_confidence)
  VALUES
    ('10000000-0000-0000-0000-000000000001', u, a1, '00000000-0000-0000-0000-00000000a001', '2026-09-02', -1210.00, 'Meelhandel Noord', 'suggestie', '20000000-0000-0000-0000-000000000001', 80),
    ('10000000-0000-0000-0000-000000000002', u, a1, '00000000-0000-0000-0000-00000000a001', '2026-09-05',   450.41, 'Hotel De Linde', 'gematcht', '20000000-0000-0000-0000-000000000011', 100),
    ('10000000-0000-0000-0000-000000000003', u, a2, '00000000-0000-0000-0000-00000000a001', '2026-09-07',  -75.50, 'KPN', 'suggestie', '20000000-0000-0000-0000-000000000021', 60),
    ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000e3', b1, '00000000-0000-0000-0000-00000000a002', '2026-09-08', -99.00, 'Ander kantoor', 'suggestie', '20000000-0000-0000-0000-000000000031', 60),
    ('10000000-0000-0000-0000-000000000005', u, a1, NULL,                                    '2026-09-09',  -10.00, 'Zonder organisatie', 'suggestie', NULL, NULL);

  INSERT INTO public.purchase_invoices (id, client_id, status, amount_incl) VALUES
    ('20000000-0000-0000-0000-000000000001', a1, 'gecontroleerd', 1210.00),
    ('20000000-0000-0000-0000-000000000002', a1, 'gecontroleerd', 1210.00),
    ('20000000-0000-0000-0000-000000000021', a2, 'gecontroleerd',   75.50),
    ('20000000-0000-0000-0000-000000000031', b1, 'gecontroleerd',   99.00);
  INSERT INTO public.sales_invoices (id, client_id, status, amount_incl) VALUES
    ('20000000-0000-0000-0000-000000000011', a1, 'gecontroleerd', 450.41);

  -- Een bevestigde koppeling: transactie 2 ↔ verkoopfactuur 11.
  INSERT INTO public.bank_transaction_allocations (id, bank_transaction_id, organization_id, client_id, invoice_id, invoice_type, amount, user_id)
  VALUES ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000a001', a1,
          '20000000-0000-0000-0000-000000000011', 'verkoop', 450.41, u);

  -- Eén echte grootboekgroep, om te laten zien dat er niets bij komt of verandert.
  PERFORM proof.seed_group(a1, 2026, 450.41);
END $$;

-- Momentopname van alles wat een afwijzing NIET mag raken.
CREATE TABLE IF NOT EXISTS proof.snap (k text PRIMARY KEY, digest text NOT NULL);
CREATE OR REPLACE FUNCTION proof.digest_of(_table text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  EXECUTE format('SELECT md5(coalesce(string_agg(t::text, %L ORDER BY t::text), %L)) FROM %s t', '|', '', _table) INTO v;
  RETURN v;
END $$;
INSERT INTO proof.snap
SELECT t, proof.digest_of(t) FROM unnest(ARRAY[
  'public.bank_transactions', 'public.bank_transaction_allocations', 'public.ledger_postings',
  'public.purchase_invoices', 'public.sales_invoices', 'public.bank_allocation_postings'
]) AS t
ON CONFLICT (k) DO UPDATE SET digest = EXCLUDED.digest;
