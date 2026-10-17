-- TEST FIXTURES — throwaway database only. Never run against any BoekAssist database.
--
-- Eén geconfigureerde administratie met een volledig rekeningschema, gebruikers
-- met verschillende rollen, en hulpfuncties die facturen en koppelingen
-- uitsluitend via de ECHTE schrijvers boeken (post_purchase_invoice,
-- post_sales_invoice, post_bank_transaction, post_bank_allocation). Er wordt
-- nergens rechtstreeks in het grootboek of in een marker geschreven.
--
-- Draait na de echte migratieketen t/m 20261010120000, vóór PR 0.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

-- ── bewijsadministratie ─────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS proof;
GRANT USAGE ON SCHEMA proof TO public;

CREATE TABLE proof.result (n text, name text, ok boolean, detail text);
GRANT INSERT, SELECT ON proof.result TO public;

CREATE FUNCTION proof.record(_n text, _name text, _ok boolean, _detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO proof.result VALUES (_n, _name, coalesce(_ok, false), _detail);
$$;

CREATE FUNCTION proof.expect_true(_n text, _name text, _expr text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v boolean;
BEGIN
  EXECUTE format('SELECT (%s)::boolean', _expr) INTO v;
  INSERT INTO proof.result VALUES (_n, _name, coalesce(v, false), CASE WHEN v THEN NULL ELSE 'onwaar of NULL' END);
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, 'fout: ' || SQLERRM);
END $$;

-- Een fout wordt alleen geaccepteerd met de verwachte SQLSTATE én tekst.
CREATE FUNCTION proof.expect_error(_n text, _name text, _sql text, _sqlstate text, _needle text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  BEGIN
    EXECUTE _sql;
    INSERT INTO proof.result VALUES (_n, _name, false, 'GEEN fout, terwijl een fout werd verwacht');
    RETURN;
  EXCEPTION WHEN others THEN
    v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  INSERT INTO proof.result VALUES (_n, _name,
    v_state = _sqlstate AND position(lower(_needle) IN lower(v_msg)) > 0,
    format('[%s] %s', v_state, v_msg));
END $$;

CREATE FUNCTION proof.expect_ok(_n text, _name text, _sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE _sql;
  INSERT INTO proof.result VALUES (_n, _name, true, NULL);
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('[%s] %s', SQLSTATE, SQLERRM));
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

-- ── organisaties, gebruikers, rollen ────────────────────────────────────────
INSERT INTO public.organizations (id, name) VALUES
  ('00000000-0000-0000-0000-00000000a001', 'Agio Finance'),
  ('00000000-0000-0000-0000-00000000a002', 'Andere organisatie');

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'accountant@agio.test'),
  ('00000000-0000-0000-0000-0000000000e2', 'assistent@agio.test'),
  ('00000000-0000-0000-0000-0000000000e3', 'buitenstaander@ander.test'),
  ('00000000-0000-0000-0000-0000000000e4', 'lezer@agio.test');

INSERT INTO public.organization_members (user_id, organization_id) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000a002'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-00000000a001');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001', 'accountant'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000a001', 'assistant'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000a002', 'accountant'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-00000000a001', 'read_only');

-- ── administratie met rekeningschema ────────────────────────────────────────
INSERT INTO public.clients (id, organization_id, name) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000a001', 'Klant 1');

INSERT INTO public.grootboekrekeningen (id, organization_id, client_id, nummer, omschrijving, categorie, actief) VALUES
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000a001', NULL, 1100, 'Bank',            'activa',  true),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000a001', NULL, 1300, 'Debiteuren',      'activa',  true),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-00000000a001', NULL, 1600, 'Crediteuren',     'passiva', true),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-00000000a001', NULL, 1520, 'BTW te vorderen', 'activa',  true),
  ('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-00000000a001', NULL, 1530, 'BTW te betalen',  'passiva', true),
  ('00000000-0000-0000-0000-00000000f006', '00000000-0000-0000-0000-00000000a001', NULL, 4400, 'Kantoorkosten',   'kosten',  true),
  ('00000000-0000-0000-0000-00000000f007', '00000000-0000-0000-0000-00000000a001', NULL, 8000, 'Omzet',           'omzet',   true);

UPDATE public.clients SET
  bank_rekening_id            = '00000000-0000-0000-0000-00000000f001',
  debiteuren_rekening_id      = '00000000-0000-0000-0000-00000000f002',
  crediteuren_rekening_id     = '00000000-0000-0000-0000-00000000f003',
  btw_te_vorderen_rekening_id = '00000000-0000-0000-0000-00000000f004',
  btw_te_betalen_rekening_id  = '00000000-0000-0000-0000-00000000f005'
WHERE id = '00000000-0000-0000-0000-0000000000c1';

-- ── identiteiten: prefix per soort, volgnummer per scenario ─────────────────
--    1000 = banktransactie, 2000 = inkoopfactuur, 3000 = verkoopfactuur,
--    4000 = koppeling
CREATE FUNCTION proof.uid(_prefix integer, _n integer)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT format('00000000-0000-0000-%s-%s', lpad(_prefix::text, 4, '0'), lpad(_n::text, 12, '0'))::uuid;
$$;

/** Een banktransactie van Klant 1, standaard handmatig gecodeerd op kosten. */
CREATE FUNCTION proof.tx(_n integer, _amount numeric, _status text DEFAULT 'handmatig_geboekt')
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.bank_transactions
    (id, user_id, client_id, organization_id, transaction_date, description, amount, match_status, grootboekrekening_id)
  VALUES
    (proof.uid(1000, _n), '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000a001', DATE '2027-03-01', format('Bankregel %s', _n), _amount, _status,
     CASE WHEN _status = 'handmatig_geboekt' THEN '00000000-0000-0000-0000-00000000f006'::uuid END);
  RETURN proof.uid(1000, _n);
END $$;

/** Een gecontroleerde inkoopfactuur, geboekt via de echte schrijver. */
CREATE FUNCTION proof.purchase(_n integer, _amount numeric)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := proof.uid(2000, _n);
BEGIN
  INSERT INTO public.purchase_invoices
    (id, user_id, client_id, organization_id, supplier, invoice_number, invoice_date,
     amount_excl, btw_amount, amount_incl, btw_percentage, remaining_amount, status)
  VALUES
    (v_id, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000a001', format('Leverancier %s', _n), format('INK-%s', _n),
     DATE '2027-02-15', _amount, 0, _amount, 0, _amount, 'gecontroleerd');
  INSERT INTO public.purchase_invoice_lines
    (purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl, btw_percentage, grootboekrekening_id)
  VALUES
    (v_id, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001',
     'Kantoorkosten', _amount, 0, '00000000-0000-0000-0000-00000000f006');
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
  PERFORM public.post_purchase_invoice(v_id);
  RETURN v_id;
END $$;

/** Een gecontroleerde verkoopfactuur, geboekt via de echte schrijver. */
CREATE FUNCTION proof.sales(_n integer, _amount numeric)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := proof.uid(3000, _n);
BEGIN
  INSERT INTO public.sales_invoices
    (id, user_id, client_id, organization_id, customer_name, invoice_number, invoice_date,
     amount_excl, btw_amount, amount_incl, btw_percentage, remaining_amount, status, grootboekrekening_id)
  VALUES
    (v_id, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000a001', format('Debiteur %s', _n), format('VRK-%s', _n),
     DATE '2027-02-15', _amount, 0, _amount, 0, _amount, 'gecontroleerd', '00000000-0000-0000-0000-00000000f007');
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
  PERFORM public.post_sales_invoice(v_id);
  RETURN v_id;
END $$;

/** Een koppeling, met de rechten van wie haar aanroept (owner, service_role of authenticated). */
CREATE FUNCTION proof.alloc(_n integer, _tx uuid, _type text, _inv uuid, _amount numeric)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.bank_transaction_allocations
    (id, bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
  VALUES
    (proof.uid(4000, _n), _tx, _type, _inv, '00000000-0000-0000-0000-0000000000c1', _amount,
     '00000000-0000-0000-0000-0000000000e1');
  RETURN proof.uid(4000, _n);
END $$;

CREATE FUNCTION proof.post_direct(_tx uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
  RETURN public.post_bank_transaction(_tx);
END $$;

CREATE FUNCTION proof.post_alloc(_alloc uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
  RETURN public.post_bank_allocation(_alloc);
END $$;

/** Alle boekingsgroepen die deze banktransactie op de bankrekening brachten,
    plus hun tegenboekingen. */
CREATE FUNCTION proof.tx_groups(_tx uuid)
RETURNS TABLE (posting_group_id uuid) LANGUAGE sql STABLE AS $$
  WITH direct AS (
    SELECT lp.posting_group_id FROM public.ledger_postings lp
    WHERE lp.source_type = 'bank_transaction' AND lp.source_id = _tx
  ), via_alloc AS (
    SELECT lp.posting_group_id FROM public.ledger_postings lp
    JOIN public.bank_transaction_allocations a ON a.id = lp.source_id
    WHERE lp.source_type = 'bank_allocation' AND a.bank_transaction_id = _tx
  ), originals AS (SELECT * FROM direct UNION SELECT * FROM via_alloc)
  SELECT posting_group_id FROM originals
  UNION
  SELECT lp.posting_group_id FROM public.ledger_postings lp
  WHERE lp.source_type = 'reversal' AND lp.source_id IN (SELECT posting_group_id FROM originals);
$$;

/** Aantal regels van deze transactie op de bankrekening (zonder tegenboekingen). */
CREATE FUNCTION proof.bank_legs(_tx uuid)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM public.ledger_postings lp
  WHERE lp.posting_group_id IN (SELECT posting_group_id FROM proof.tx_groups(_tx))
    AND lp.source_type <> 'reversal'
    AND lp.grootboekrekening_id = '00000000-0000-0000-0000-00000000f001';
$$;

/** Netto bankmutatie van deze transactie, tegenboekingen meegerekend. */
CREATE FUNCTION proof.bank_net(_tx uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(lp.debit_amount - lp.credit_amount), 0) FROM public.ledger_postings lp
  WHERE lp.posting_group_id IN (SELECT posting_group_id FROM proof.tx_groups(_tx))
    AND lp.grootboekrekening_id = '00000000-0000-0000-0000-00000000f001';
$$;

/** 'none' | 'direct' | 'allocation' | 'both' — welke markers er voor de transactie staan. */
CREATE FUNCTION proof.routes(_tx uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN d AND a THEN 'both' WHEN d THEN 'direct' WHEN a THEN 'allocation' ELSE 'none' END
  FROM (SELECT
          EXISTS (SELECT 1 FROM public.bank_transaction_postings WHERE bank_transaction_id = _tx) AS d,
          EXISTS (SELECT 1 FROM public.bank_allocation_postings  WHERE bank_transaction_id = _tx) AS a) x;
$$;

/** Vingerafdruk van alle boekhoudkundig relevante rijen. */
CREATE FUNCTION proof.digest()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(concat_ws('|',
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.ledger_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.bank_transaction_id), '')) FROM public.bank_transaction_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.allocation_id), '')) FROM public.bank_allocation_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.bank_transaction_allocations t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.bank_transactions t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.purchase_invoices t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.sales_invoices t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.original_posting_group_id), '')) FROM public.ledger_reversal_postings t)));
$$;

-- ── de aanval, steeds dezelfde, vóór en ná PR 0 ─────────────────────────────
-- Voert een complete poging tot dubbele boeking uit en draait haar daarna
-- altijd terug (subtransactie + vaste sentinel), zodat de database na afloop
-- onveranderd is. Uitkomst:
--   'dubbel: …'          → het gat bestaat: de bank is twee keer geboekt
--   'geweigerd [SQLSTATE] …' → een guard hield de poging tegen
--
--   _kind = 'insert'   direct boeken, daarna een koppeling INSERTen en boeken
--   _kind = 'repoint'  ongeboekte koppeling op _other, direct boeken van _tx,
--                      koppeling met UPDATE naar _tx verplaatsen en boeken
--   _kind = 'facturen' de schrijfvolgorde van Facturen.tsx als assistent via
--                      RLS: koppeling (upsert), restbedrag factuur, dan pas de
--                      banktransactie (die de bevriezing weigert), dan boeken
--   _kind = 'verkoop'  idem voor Verkoop.tsx met een verkoopfactuur
CREATE FUNCTION proof.attack(_kind text, _tx uuid, _inv uuid, _other uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_alloc   uuid := gen_random_uuid();
  v_amount  numeric;
  v_type    text := CASE WHEN _kind = 'verkoop' THEN 'verkoop' ELSE 'inkoop' END;
  v_tx_msg  text := '';
  v_out     text;
BEGIN
  BEGIN
    SELECT abs(amount) INTO v_amount FROM public.bank_transactions WHERE id = _tx;
    PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);

    IF _kind = 'repoint' THEN
      INSERT INTO public.bank_transaction_allocations
        (id, bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
      VALUES (v_alloc, _other, v_type, _inv, '00000000-0000-0000-0000-0000000000c1', v_amount,
              '00000000-0000-0000-0000-0000000000e1');
    END IF;

    PERFORM public.post_bank_transaction(_tx);

    IF _kind = 'insert' THEN
      INSERT INTO public.bank_transaction_allocations
        (id, bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
      VALUES (v_alloc, _tx, v_type, _inv, '00000000-0000-0000-0000-0000000000c1', v_amount,
              '00000000-0000-0000-0000-0000000000e1');
    ELSIF _kind = 'repoint' THEN
      UPDATE public.bank_transaction_allocations SET bank_transaction_id = _tx WHERE id = v_alloc;
    ELSE
      -- Als de assistent, via RLS, in de volgorde van de schermen.
      PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', true);
      SET LOCAL ROLE authenticated;
      INSERT INTO public.bank_transaction_allocations AS a
        (id, bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
      VALUES (v_alloc, _tx, v_type, _inv, '00000000-0000-0000-0000-0000000000c1', v_amount,
              '00000000-0000-0000-0000-0000000000e1')
      ON CONFLICT (bank_transaction_id, invoice_id) DO UPDATE SET amount = EXCLUDED.amount;
      IF _kind = 'facturen' THEN
        UPDATE public.purchase_invoices SET remaining_amount = 0 WHERE id = _inv;
      ELSE
        UPDATE public.sales_invoices SET remaining_amount = 0 WHERE id = _inv;
      END IF;
      BEGIN
        UPDATE public.bank_transactions SET match_status = 'gematcht', matched_invoice_id = _inv WHERE id = _tx;
      EXCEPTION WHEN others THEN
        v_tx_msg := format('; banktransactie bijwerken geweigerd [%s]', SQLSTATE);
      END;
    END IF;

    PERFORM public.post_bank_allocation(v_alloc);
    RESET ROLE;

    v_out := format('dubbel: %s bankregels, netto %s op de bankrekening%s',
                    proof.bank_legs(_tx), proof.bank_net(_tx), v_tx_msg);
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'proof-rollback', DETAIL = v_out;
  EXCEPTION WHEN others THEN
    IF SQLERRM = 'proof-rollback' THEN
      GET STACKED DIAGNOSTICS v_out = PG_EXCEPTION_DETAIL;
      RETURN v_out;
    END IF;
    RETURN format('geweigerd [%s] %s', SQLSTATE, SQLERRM);
  END;
END $$;

-- ── twee echte sessies (dblink) ─────────────────────────────────────────────
-- De lokale psql-sessie regisseert alleen; de race speelt zich af tussen twee
-- afzonderlijke backends 'a' en 'b'. Elke fout van een sessie wordt met haar
-- SQLSTATE vastgelegd, zodat ook een deadlock (40P01) of een time-out zichtbaar
-- wordt in plaats van het script te laten hangen of te breken.

CREATE FUNCTION proof.open_session(_name text, _conn text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dblink_connect(_name, _conn);
  PERFORM dblink_exec(_name, 'SET client_min_messages = warning');
  -- Een verborgen deadlock of een vergeten grendel faalt zo binnen 20 s.
  PERFORM dblink_exec(_name, 'SET statement_timeout = ''20s''');
  PERFORM dblink_exec(_name, 'SET lock_timeout = ''20s''');
  PERFORM * FROM dblink(_name, $q$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$q$) AS t(x text);
END $$;

/** Uitkomst van een eerder verstuurde (async) opdracht: 'ok: …' of 'fout [SQLSTATE] …'. */
CREATE FUNCTION proof.remote_outcome(_conn text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text; v_state text; v_msg text;
BEGIN
  BEGIN
    SELECT x INTO v FROM dblink_get_result(_conn) AS t(x text);
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
    RETURN 'ok: ' || coalesce(v, '');
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
  EXCEPTION WHEN others THEN NULL;
  END;
  RETURN format('fout [%s] %s', v_state, v_msg);
END $$;

/** Synchrone opdracht in een sessie, met dezelfde uitkomstvorm. */
CREATE FUNCTION proof.remote_run(_conn text, _sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  SELECT x INTO v FROM dblink(_conn, _sql) AS t(x text);
  RETURN 'ok: ' || coalesce(v, '');
EXCEPTION WHEN others THEN
  RETURN format('fout [%s] %s', SQLSTATE, SQLERRM);
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
