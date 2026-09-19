-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist database.
--
-- Stamgegevens en hulpmiddelen voor het tegenboekingsbewijs (6C-b9). Het schema
-- zelf komt uit ../opening-balance/bootstrap.sql; hier staat wie er is, wat er
-- is, en hoe het bewijs een ORIGINEEL in het grootboek zet.

SET client_min_messages = warning;

INSERT INTO public.organizations (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Org A'),
  ('00000000-0000-0000-0000-0000000000a2', 'Org B');

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'acc1@test'),
  ('00000000-0000-0000-0000-0000000000e2', 'asst1@test'),
  ('00000000-0000-0000-0000-0000000000e4', 'acc2@test'),
  -- Accountant in BEIDE organisaties: de enige die een kapotte, organisatie-
  -- overschrijdende groep inhoudelijk te zien mag krijgen.
  ('00000000-0000-0000-0000-0000000000e5', 'acc-both@test');

INSERT INTO public.organization_members (user_id, organization_id) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000a2');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'accountant'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'assistant'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a2', 'accountant'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000a1', 'accountant'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000a2', 'accountant');

-- c5 heeft boekjaar 2027 afgesloten; c9 hoort bij de andere organisatie.
INSERT INTO public.clients (id, organization_id, name, afgesloten_boekjaar) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Klant 1', NULL),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'Klant 2', NULL),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'Klant 3', NULL),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'Klant 4', NULL),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000a1', 'Klant 5', 2027),
  ('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000a1', 'Klant 6', NULL),
  ('00000000-0000-0000-0000-0000000000c7', '00000000-0000-0000-0000-0000000000a1', 'Klant 7', NULL),
  ('00000000-0000-0000-0000-0000000000c8', '00000000-0000-0000-0000-0000000000a1', 'Klant 8', NULL),
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000a2', 'Klant 9', NULL),
  ('00000000-0000-0000-0000-0000000000ca', '00000000-0000-0000-0000-0000000000a1', 'Klant 10', NULL),
  ('00000000-0000-0000-0000-0000000000cb', '00000000-0000-0000-0000-0000000000a1', 'Klant 11', NULL),
  ('00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-0000000000a1', 'Klant 12', NULL),
  ('00000000-0000-0000-0000-0000000000cd', '00000000-0000-0000-0000-0000000000a1', 'Klant 13', NULL),
  ('00000000-0000-0000-0000-0000000000ce', '00000000-0000-0000-0000-0000000000a1', 'Klant 14', NULL),
  ('00000000-0000-0000-0000-0000000000cf', '00000000-0000-0000-0000-0000000000a1', 'Klant 15', NULL),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Klant 16', NULL),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', 'Klant 17', NULL);

-- f007 is inactief: een tegenboeking mag daar wél op boeken (zie de migratie).
-- f009 hoort bij de andere organisatie.
INSERT INTO public.grootboekrekeningen (id, organization_id, client_id, nummer, omschrijving, categorie, actief) VALUES
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000a1', NULL, 1600, 'Crediteuren',  'passiva', true),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-0000000000a1', NULL, 4602, 'Kosten',       'kosten',  true),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-0000000000a1', NULL, 1680, 'BTW',          'activa',  true),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-0000000000a1', NULL, 1200, 'Bank',         'activa',  true),
  ('00000000-0000-0000-0000-00000000f007', '00000000-0000-0000-0000-0000000000a1', NULL, 9100, 'Inactief',     'kosten',  false),
  ('00000000-0000-0000-0000-00000000f009', '00000000-0000-0000-0000-0000000000a2', NULL, 1600, 'Crediteuren B','passiva', true);

-- ── Hulpmiddelen ────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS proof;
GRANT USAGE ON SCHEMA proof TO public;

/*
 * Een NORMALE boekingsgroep neerzetten: langs alle triggers heen, precies zoals
 * een echte schrijver dat zou doen. SECURITY DEFINER van de tabel-eigenaar —
 * hetzelfde mechanisme waar alle vijf de schrijvers op rusten, en sinds
 * 20260920130000 de enige manier om in het grootboek te schrijven.
 */
CREATE OR REPLACE FUNCTION proof.seed_group(
  _group    uuid,
  _client   uuid,
  _date     date,
  _source   text,
  _accounts uuid[],
  _debits   numeric[],
  _credits  numeric[],
  _currency text DEFAULT 'EUR'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i integer;
BEGIN
  FOR i IN 1 .. array_length(_accounts, 1) LOOP
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, user_id
    )
    SELECT c.organization_id, _client, _accounts[i], _group, i,
           _date, EXTRACT(YEAR FROM _date)::integer, _debits[i], _credits[i], _currency,
           format('Regel %s', i), _source, _group,
           '00000000-0000-0000-0000-0000000000e1'
    FROM public.clients c WHERE c.id = _client;
  END LOOP;
END $$;

/*
 * Een KAPOTTE boekingsgroep neerzetten. Alleen zo te maken: elke controle die
 * het bewijs wil toetsen, wordt door de fundering al bij het invoegen
 * geweigerd. session_replication_role = replica schakelt de ORIGIN-triggers uit
 * (de append-only-grendels blijven ALWAYS en dus actief), waardoor
 * created_xact_id en organization_id hier met de hand moeten worden gezet.
 *
 * Dit is uitsluitend een middel om het bewijs een kapotte toestand te laten
 * onderzoeken; geen enkele applicatierol kan dit, want de rol is superuser-only.
 */
CREATE OR REPLACE FUNCTION proof.seed_raw(
  _group     uuid,
  _org       uuid,
  _client    uuid,
  _account   uuid,
  _line_no   integer,
  _date      date,
  _boekjaar  integer,
  _debit     numeric,
  _credit    numeric,
  _currency  text DEFAULT 'EUR',
  _source    text DEFAULT 'manual_journal',
  _xact      text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO public.ledger_postings (
    organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
    posting_date, boekjaar, debit_amount, credit_amount, currency,
    description, source_type, source_id, user_id, created_xact_id
  ) VALUES (
    _org, _client, _account, _group, _line_no,
    _date, _boekjaar, _debit, _credit, _currency,
    'Ruwe regel', _source, _group, '00000000-0000-0000-0000-0000000000e1',
    COALESCE(_xact::xid8, pg_current_xact_id())
  );
  PERFORM set_config('session_replication_role', 'origin', true);
END $$;

GRANT EXECUTE ON FUNCTION proof.seed_group(uuid, uuid, date, text, uuid[], numeric[], numeric[], text) TO public;
GRANT EXECUTE ON FUNCTION proof.seed_raw(uuid, uuid, uuid, uuid, integer, date, integer, numeric, numeric, text, text, text) TO public;

/*
 * Twee ECHTE schrijvers end-to-end, zodat "de bestaande schrijvers werken nog"
 * geen bewering blijft maar een uitkomst is. Het concept wordt hier als
 * eigenaar klaargezet (dat is fixtuurwerk); het BOEKEN gebeurt door de echte
 * RPC, die haar eigen rol- en tenantcontroles onverkort uitvoert.
 */
CREATE OR REPLACE FUNCTION proof.post_memoriaal()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid := '00000000-0000-0000-0000-0000000000aa';
BEGIN
  INSERT INTO public.manual_journals (id, organization_id, client_id, user_id, posting_date, description)
  VALUES (v_id, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000cc',
          '00000000-0000-0000-0000-0000000000e1', DATE '2027-05-01', 'Memoriaal uit het bewijs')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.manual_journal_lines
    (manual_journal_id, organization_id, user_id, sort_order, grootboekrekening_id, debit_amount, credit_amount)
  VALUES
    (v_id, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', 1,
     '00000000-0000-0000-0000-00000000f002', 12.00, 0),
    (v_id, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', 2,
     '00000000-0000-0000-0000-00000000f001', 0, 12.00);

  RETURN public.post_manual_journal(v_id);
END $$;

CREATE OR REPLACE FUNCTION proof.post_beginbalans()
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid := '00000000-0000-0000-0000-0000000000bb';
BEGIN
  INSERT INTO public.opening_balances
    (id, organization_id, client_id, user_id, boekjaar, opening_date, description)
  VALUES (v_id, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000cf',
          '00000000-0000-0000-0000-0000000000e1', 2027, DATE '2027-01-01', 'Beginbalans uit het bewijs')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.opening_balance_lines
    (opening_balance_id, organization_id, client_id, user_id, grootboekrekening_id,
     debit_amount, credit_amount, sort_order)
  VALUES
    (v_id, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000cf',
     '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000f004', 500.00, 0, 1),
    (v_id, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000cf',
     '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000f001', 0, 500.00, 2);

  RETURN public.post_opening_balance(v_id);
END $$;

GRANT EXECUTE ON FUNCTION proof.post_memoriaal() TO public;
GRANT EXECUTE ON FUNCTION proof.post_beginbalans() TO public;
