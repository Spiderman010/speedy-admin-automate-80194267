-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist
-- database. See run-proof.sh.
--
-- Drie historische regels (zoals productie), bij één administratie van Agio
-- Finance, en een tweede organisatie zonder regels voor de tenantproef.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS proof.ids (k text PRIMARY KEY, id uuid NOT NULL);

DO $$
DECLARE
  v_client uuid := proof.new_client('Journal — historische snelle invoer');
  v_gb     uuid;
BEGIN
  SELECT id INTO v_gb FROM public.grootboekrekeningen WHERE client_id = v_client AND nummer = 4000;
  INSERT INTO proof.ids VALUES ('client', v_client), ('gb', v_gb);

  INSERT INTO public.journal_entries
    (user_id, client_id, organization_id, entry_date, description, amount, btw_percentage, btw_amount,
     ledger_account_text, grootboekrekening_id, invoice_number)
  VALUES
    ('00000000-0000-0000-0000-0000000000e2', v_client, '00000000-0000-0000-0000-00000000a001',
     DATE '2025-02-03', 'Kantoorartikelen', 121.00, 21, 21.00, '4000 - Kosten', v_gb, 'J-001'),
    ('00000000-0000-0000-0000-0000000000e2', v_client, '00000000-0000-0000-0000-00000000a001',
     DATE '2025-03-14', 'Parkeren', 9.99, 21, 1.73, '4000 - Kosten', NULL, NULL),
    ('00000000-0000-0000-0000-0000000000e2', v_client, '00000000-0000-0000-0000-00000000a001',
     DATE '2025-04-01', 'Correctie', -50.00, 0, 0.00, NULL, NULL, 'J-003');
END $$;

GRANT USAGE ON SCHEMA proof TO anon, authenticated, service_role;
GRANT SELECT ON proof.ids TO anon, authenticated, service_role;
