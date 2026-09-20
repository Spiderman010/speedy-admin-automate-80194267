-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- Stamgegevens voor het bankboekingsbewijs: twee organisaties (zodat de
-- tenantpoort iets te weigeren heeft), drie gebruikers met verschillende
-- rollen, administraties met en zonder BTW-inrichting, en de rekeningen
-- waarop geboekt wordt.

SET client_min_messages = warning;

INSERT INTO public.organizations (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Org A'),
  ('00000000-0000-0000-0000-0000000000a2', 'Org B');

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'assistant-a@test'),
  ('00000000-0000-0000-0000-0000000000e2', 'readonly-a@test'),
  ('00000000-0000-0000-0000-0000000000e4', 'assistant-b@test');

INSERT INTO public.organization_members (user_id, organization_id) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a2');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'assistant'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'read_only'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a2', 'assistant');

INSERT INTO public.clients (id, organization_id, name, afgesloten_boekjaar) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Klant 1', NULL),
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000a2', 'Klant 9', NULL);

INSERT INTO public.grootboekrekeningen (id, organization_id, client_id, nummer, omschrijving, categorie, actief) VALUES
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000a1', NULL, 1200, 'Bank',            'activa',  true),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000000a1', NULL, 4400, 'Kantoorkosten',   'kosten',  true),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-0000000000a1', NULL, 1680, 'BTW te vorderen', 'activa',  true),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-0000000000a1', NULL, 1670, 'BTW te betalen',  'passiva', true),
  ('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-0000000000a1', NULL, 8000, 'Omzet',           'omzet',   true),
  ('00000000-0000-0000-0000-00000000f009', '00000000-0000-0000-0000-0000000000a2', NULL, 1200, 'Bank org B',      'activa',  true);

UPDATE public.clients SET
  bank_rekening_id            = '00000000-0000-0000-0000-00000000f001',
  btw_te_vorderen_rekening_id = '00000000-0000-0000-0000-00000000f003',
  btw_te_betalen_rekening_id  = '00000000-0000-0000-0000-00000000f004'
WHERE id = '00000000-0000-0000-0000-0000000000c1';

UPDATE public.clients SET
  bank_rekening_id = '00000000-0000-0000-0000-00000000f009'
WHERE id = '00000000-0000-0000-0000-0000000000c9';

-- ── Hulpmiddel: één banktransactie klaarzetten ──────────────────────────────
CREATE SCHEMA IF NOT EXISTS proof;
GRANT USAGE ON SCHEMA proof TO public;

CREATE OR REPLACE FUNCTION proof.seed_tx(
  _id      uuid,
  _client  uuid,
  _amount  numeric,
  _pct     numeric DEFAULT NULL,
  _account uuid DEFAULT '00000000-0000-0000-0000-00000000f002',
  _status  text DEFAULT 'handmatig_geboekt',
  _date    date DEFAULT DATE '2027-03-01',
  _desc    text DEFAULT 'Bankregel'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.bank_transactions (
    id, user_id, client_id, organization_id, transaction_date, description,
    amount, match_status, grootboekrekening_id, btw_percentage
  )
  SELECT _id, '00000000-0000-0000-0000-0000000000e1', _client, c.organization_id, _date, _desc,
         _amount, _status, _account, _pct
  FROM public.clients c WHERE c.id = _client;
  RETURN _id;
END $$;

GRANT EXECUTE ON FUNCTION proof.seed_tx(uuid, uuid, numeric, numeric, uuid, text, date, text) TO public;
