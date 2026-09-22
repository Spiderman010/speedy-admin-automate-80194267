-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist
-- database. Draait na ../year-close/fixtures.sql en leunt op de helpers
-- daaruit (proof.record, proof.expect_error, proof.new_client, proof.close_as).
--
-- Hier staat alleen wat PR D extra nodig heeft: administraties die ÉCHT
-- geboekt kunnen worden door de memoriaal-, beginbalans- en bankschrijver, en
-- korte handvatten om zo'n boeking op een gekozen datum te doen.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS proof.subject (rol text PRIMARY KEY, client_id uuid NOT NULL);

CREATE OR REPLACE FUNCTION proof.expect_ok(_n text, _name text, _sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE _sql;
  INSERT INTO proof.result VALUES (_n, _name, true, 'uitgevoerd zonder fout');
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('onverwachte fout: %s', SQLERRM));
END $$;

/* De VOLLEDIGE identiteit van een fout: SQLSTATE én boodschap. */
CREATE OR REPLACE FUNCTION proof.identity(_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  EXECUTE _sql;
  RETURN 'GEEN FOUT';
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  RETURN v_state || ' | ' || v_msg;
END $$;

/** Een administratie die alle drie de uitvoerbare schrijvers aankan. */
CREATE OR REPLACE FUNCTION proof.pl_client(_name text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id   uuid := proof.new_client(_name);
  v_org  uuid;
  v_bank uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.clients WHERE id = v_id;
  INSERT INTO public.grootboekrekeningen (client_id, organization_id, nummer, omschrijving, categorie)
  VALUES (v_id, v_org, 1200, 'Bank', 'activa')
  RETURNING id INTO v_bank;
  UPDATE public.clients SET bank_rekening_id = v_bank WHERE id = v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION proof.account(_client uuid, _nummer integer)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM public.grootboekrekeningen WHERE client_id = _client AND nummer = _nummer
$$;

/** Een memoriaalboeking klaarzetten op een datum; geeft het id terug. */
CREATE OR REPLACE FUNCTION proof.mj_draft(_client uuid, _date date, _amount numeric DEFAULT 100.00)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid;
  v_id  uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.clients WHERE id = _client;
  INSERT INTO public.manual_journals (client_id, organization_id, posting_date, description, user_id)
  VALUES (_client, v_org, _date, 'Memoriaal ' || _date::text,
          '00000000-0000-0000-0000-0000000000e1')
  RETURNING id INTO v_id;

  INSERT INTO public.manual_journal_lines
    (manual_journal_id, organization_id, user_id, sort_order, grootboekrekening_id,
     omschrijving, debit_amount, credit_amount)
  VALUES
    (v_id, v_org, '00000000-0000-0000-0000-0000000000e1', 1, proof.account(_client, 4000),
     'Kosten', _amount, 0),
    (v_id, v_org, '00000000-0000-0000-0000-0000000000e1', 2, proof.account(_client, 1300),
     'Tegenrekening', 0, _amount);
  RETURN v_id;
END $$;

/** Een beginbalans klaarzetten op een datum; geeft het id terug. */
CREATE OR REPLACE FUNCTION proof.ob_draft(_client uuid, _date date, _amount numeric DEFAULT 250.00)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid;
  v_id  uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.clients WHERE id = _client;
  INSERT INTO public.opening_balances
    (client_id, organization_id, user_id, boekjaar, opening_date, description)
  VALUES (_client, v_org, '00000000-0000-0000-0000-0000000000e1',
          EXTRACT(YEAR FROM _date)::integer, _date, 'Beginbalans ' || _date::text)
  RETURNING id INTO v_id;

  INSERT INTO public.opening_balance_lines
    (opening_balance_id, organization_id, client_id, user_id, grootboekrekening_id,
     debit_amount, credit_amount, description, sort_order)
  VALUES
    (v_id, v_org, _client, '00000000-0000-0000-0000-0000000000e1', proof.account(_client, 1300),
     _amount, 0, 'Debiteuren', 1),
    (v_id, v_org, _client, '00000000-0000-0000-0000-0000000000e1', proof.account(_client, 4000),
     0, _amount, 'Tegenpost', 2);
  RETURN v_id;
END $$;

/** Een banktransactie klaarzetten op een datum; geeft het id terug. */
CREATE OR REPLACE FUNCTION proof.tx_draft(_client uuid, _date date, _amount numeric DEFAULT -121.00)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid;
  v_id  uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.clients WHERE id = _client;
  INSERT INTO public.bank_transactions
    (user_id, client_id, organization_id, transaction_date, description, amount,
     match_status, grootboekrekening_id)
  VALUES ('00000000-0000-0000-0000-0000000000e1', _client, v_org, _date,
          'Bankregel ' || _date::text, _amount, 'handmatig_geboekt', proof.account(_client, 4000))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

/** De blokkade zetten als een bepaalde gebruiker (zoals in het PR C-bewijs). */
CREATE OR REPLACE FUNCTION proof.lock_as(_uid uuid, _client uuid, _through date, _reason text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_changed boolean;
BEGIN
  PERFORM set_config('test.user_id', _uid::text, true);
  SELECT s.changed INTO v_changed FROM public.set_posting_lock(_client, _through, _reason) s;
  RETURN v_changed;
END $$;

/** De broncode van een functie, zonder witruimteverschillen. */
CREATE OR REPLACE FUNCTION proof.src(_name text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT regexp_replace(p.prosrc, '\s+', ' ', 'g')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = _name
  LIMIT 1
$$;

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
