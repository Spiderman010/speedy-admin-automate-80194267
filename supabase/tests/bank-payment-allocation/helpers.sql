-- TEST HELPERS — throwaway database only. Never run against any BoekAssist database.
--
-- Bovenop ../bank-transaction-corrections/fixtures.sql (organisatie A met c1/c2,
-- organisatie B met c3; e1 accountant, e2 assistent, e3 buitenstaander, e4
-- lezer, e5 tweede accountant, e6 eigenaar; proof.call, proof.tx, dblink).
-- Identiteiten: 1000 = banktransactie, 2000 = inkoop, 3000 = verkoop,
-- 9000 = request_id.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

/** Een verkoopfactuur van _client, zoals de app haar aanmaakt (restant = totaal);
    _posted = via de echte schrijver geboekt (vereist status gecontroleerd). */
CREATE FUNCTION proof.sinv(_n integer, _amount numeric, _status text DEFAULT 'gecontroleerd',
                           _posted boolean DEFAULT false,
                           _client uuid DEFAULT '00000000-0000-0000-0000-0000000000c1')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := proof.uid(3000, _n);
BEGIN
  INSERT INTO public.sales_invoices
    (id, user_id, client_id, customer_name, invoice_number, invoice_date,
     amount_excl, btw_amount, amount_incl, btw_percentage, remaining_amount, status, grootboekrekening_id)
  SELECT v_id,
         CASE WHEN c.organization_id = '00000000-0000-0000-0000-00000000a002'
              THEN '00000000-0000-0000-0000-0000000000e3'::uuid
              ELSE '00000000-0000-0000-0000-0000000000e1'::uuid END,
         c.id, format('Klant %s', _n), format('VK-%s', _n), DATE '2027-02-15',
         _amount, 0, _amount, 0, _amount, _status,
         CASE WHEN c.organization_id = '00000000-0000-0000-0000-00000000a001'
              THEN '00000000-0000-0000-0000-00000000f008'::uuid END
  FROM public.clients c WHERE c.id = _client;
  IF _posted THEN
    PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
    PERFORM public.post_sales_invoice(v_id);
  END IF;
  RETURN v_id;
END $$;

/** Een inkoopfactuur van _client (restant = totaal), optioneel geboekt. */
CREATE FUNCTION proof.pinv(_n integer, _amount numeric, _status text DEFAULT 'gecontroleerd',
                           _posted boolean DEFAULT false,
                           _client uuid DEFAULT '00000000-0000-0000-0000-0000000000c1')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := proof.uid(2000, _n);
BEGIN
  INSERT INTO public.purchase_invoices
    (id, user_id, client_id, supplier, invoice_number, invoice_date,
     amount_excl, btw_amount, amount_incl, btw_percentage, remaining_amount, status)
  SELECT v_id,
         CASE WHEN c.organization_id = '00000000-0000-0000-0000-00000000a002'
              THEN '00000000-0000-0000-0000-0000000000e3'::uuid
              ELSE '00000000-0000-0000-0000-0000000000e1'::uuid END,
         c.id, format('Leverancier %s', _n), format('INK-%s', _n), DATE '2027-02-15',
         _amount, 0, _amount, 0, _amount, _status
  FROM public.clients c WHERE c.id = _client;
  IF _posted THEN
    INSERT INTO public.purchase_invoice_lines
      (purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl, btw_percentage, grootboekrekening_id)
    VALUES (v_id, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001',
            'Kantoorkosten', _amount, 0, '00000000-0000-0000-0000-00000000f007');
    PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
    PERFORM public.post_purchase_invoice(v_id);
  END IF;
  RETURN v_id;
END $$;

/** De RPC's als de echte rol `authenticated`. Uitkomst 'ok: allocation|outcome|restant|status|txstatus|replayed'. */
CREATE FUNCTION proof.link(_user uuid, _tx uuid, _type text, _inv uuid, _amount numeric, _req uuid)
RETURNS text LANGUAGE sql AS $$
  SELECT proof.call(_user, format(
    'SELECT format(''%%s|%%s|%%s|%%s|%%s|%%s'', allocation_id, outcome, invoice_remaining, invoice_status, tx_match_status, replayed)
       FROM public.link_bank_payment(%L::uuid, %L::text, %L::uuid, %L::numeric, %L::uuid)',
    _tx, _type, _inv, _amount, _req));
$$;

/** 'ok: outcome|removed|txstatus|replayed' */
CREATE FUNCTION proof.unlink(_user uuid, _tx uuid, _req uuid, _alloc uuid DEFAULT NULL)
RETURNS text LANGUAGE sql AS $$
  SELECT proof.call(_user, format(
    'SELECT format(''%%s|%%s|%%s|%%s'', outcome, removed_count, tx_match_status, replayed)
       FROM public.unlink_bank_payment(%L::uuid, %L::uuid, %L::uuid)',
    _tx, _req, _alloc));
$$;

/** Als proof.call, maar met de uitgestelde controles direct aan het eind van de
    opdracht (SET CONSTRAINTS ALL IMMEDIATE), zodat een weigering bij COMMIT hier
    als uitkomst zichtbaar wordt in plaats van de hele psql-opdracht af te breken.
    Alleen voor directe schrijfacties; de echte COMMIT bewijzen faults.sql en
    concurrency.sql in een tweede sessie. */
CREATE FUNCTION proof.calli(_user uuid, _sql text, _role text DEFAULT 'authenticated')
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text; v_state text; v_msg text; v_out text;
BEGIN
  BEGIN
    SET CONSTRAINTS ALL IMMEDIATE;
    PERFORM set_config('test.user_id', coalesce(_user::text, ''), true);
    EXECUTE format('SET LOCAL ROLE %I', _role);
    EXECUTE _sql INTO v;
    RESET ROLE;
    SET CONSTRAINTS ALL DEFERRED;
    RETURN 'ok: ' || coalesce(v, '');
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  v_out := format('fout [%s] %s', v_state, v_msg);
  INSERT INTO proof.refusal (outcome) VALUES (v_out);
  RETURN v_out;
END $$;

/** Een koppeling zoals de oude app haar schrijft (rechtstreeks, als authenticated),
    met de uitgestelde controles aan het eind van de opdracht. */
CREATE FUNCTION proof.direct_alloc_i(_user uuid, _tx uuid, _type text, _inv uuid, _amount numeric)
RETURNS text LANGUAGE sql AS $$
  SELECT proof.calli(_user, format(
    'INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
     SELECT bt.id, %L, %L::uuid, bt.client_id, %L::numeric, bt.user_id FROM public.bank_transactions bt WHERE bt.id = %L::uuid
     RETURNING id::text', _type, _inv, _amount, _tx));
$$;

/** Een fout met de verwachte SQLSTATE en tekst (uitkomst van proof.call). */
CREATE FUNCTION proof.refused(_out text, _state text, _needle text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT _out LIKE 'fout [' || _state || ']%' AND position(lower(_needle) IN lower(_out)) > 0;
$$;

/** Restant en status van een factuur: 'restant|status'. */
CREATE FUNCTION proof.inv(_type text, _id uuid) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  IF _type = 'inkoop' THEN
    SELECT format('%s|%s', remaining_amount, status) INTO v FROM public.purchase_invoices WHERE id = _id;
  ELSE
    SELECT format('%s|%s', remaining_amount, status) INTO v FROM public.sales_invoices WHERE id = _id;
  END IF;
  RETURN v;
END $$;

/** Matchtoestand van een banktransactie: 'status|primaire factuur|Σ koppelingen|aantal'. */
CREATE FUNCTION proof.txs(_tx uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT format('%s|%s|%s|%s', bt.match_status, bt.matched_invoice_id,
                (SELECT coalesce(sum(a.amount), 0) FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = bt.id),
                (SELECT count(*) FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = bt.id))
  FROM public.bank_transactions bt WHERE bt.id = _tx;
$$;

/** De koppeling van een paar. */
CREATE FUNCTION proof.alloc(_tx uuid, _inv uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM public.bank_transaction_allocations WHERE bank_transaction_id = _tx AND invoice_id = _inv;
$$;

/** Vingerafdruk van alles wat de betaalschrijver raakt (claims en gebeurtenissen zodra ze bestaan). */
CREATE FUNCTION proof.p5digest() RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE v_req text := md5(''); v_ev text := md5('');
BEGIN
  IF to_regclass('public.bank_payment_requests') IS NOT NULL THEN
    EXECUTE $q$SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.actor_id, t.request_id), '')) FROM public.bank_payment_requests t$q$ INTO v_req;
    EXECUTE $q$SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.seq), '')) FROM public.bank_payment_events t$q$ INTO v_ev;
  END IF;
  RETURN md5(concat_ws('|',
    proof.digest(),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.purchase_invoices t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.sales_invoices t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.bank_match_rejections t),
    v_req, v_ev));
END $$;

/** Invarianten van de betaalschrijver: aantal schendingen onder de facturen en
    banktransacties die de schrijver raakte (zij hebben een gebeurtenis). */
CREATE FUNCTION proof.writer_violations() RETURNS integer LANGUAGE plpgsql STABLE AS $$
DECLARE v integer;
BEGIN
  IF to_regclass('public.bank_payment_events') IS NULL THEN RETURN 0; END IF;
  EXECUTE $q$
    WITH inv AS (
      SELECT DISTINCT e.invoice_type, e.invoice_id FROM public.bank_payment_events e),
    st AS (
      SELECT i.invoice_type, i.invoice_id,
             coalesce(p.amount_incl, s.amount_incl) AS incl,
             coalesce(p.remaining_amount, s.remaining_amount) AS rem,
             coalesce(p.status, s.status) AS status,
             (SELECT coalesce(sum(a.amount), 0) FROM public.bank_transaction_allocations a
              WHERE a.invoice_id = i.invoice_id AND a.invoice_type = i.invoice_type) AS som
      FROM inv i
      LEFT JOIN public.purchase_invoices p ON i.invoice_type = 'inkoop' AND p.id = i.invoice_id
      LEFT JOIN public.sales_invoices s ON i.invoice_type = 'verkoop' AND s.id = i.invoice_id),
    tx AS (
      SELECT DISTINCT e.bank_transaction_id AS id FROM public.bank_payment_events e)
    SELECT
      (SELECT count(*) FROM st WHERE rem IS DISTINCT FROM incl - som OR (status = 'betaald' AND rem <> 0) OR som > incl)::integer
      + (SELECT count(*) FROM tx JOIN public.bank_transactions bt ON bt.id = tx.id
         WHERE (EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = bt.id))
               IS DISTINCT FROM (bt.match_status = 'gematcht')
            OR (bt.match_status = 'gematcht' AND NOT EXISTS (
                  SELECT 1 FROM public.bank_transaction_allocations a
                  WHERE a.bank_transaction_id = bt.id AND a.invoice_id = bt.matched_invoice_id))
            OR (SELECT coalesce(sum(a.amount), 0) FROM public.bank_transaction_allocations a
                WHERE a.bank_transaction_id = bt.id) > abs(bt.amount))::integer
  $q$ INTO v;
  RETURN v;
END $$;

/** Tabelrechten als gesorteerde set (de volgorde in relacl telt niet). */
CREATE FUNCTION proof.acl(_rel regclass) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT string_agg(format('%s:%s', a.grantee::regrole, a.privilege_type), ',' ORDER BY a.grantee::regrole::text, a.privilege_type)
  FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = _rel;
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;
