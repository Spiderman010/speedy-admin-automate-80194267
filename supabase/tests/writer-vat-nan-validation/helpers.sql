-- TEST HELPERS — throwaway database only. Never run against any BoekAssist database.
--
-- Draait na build-chain.sh (de fixtures van bank-transaction-corrections:
-- proof.call/record/expect_*, gebruikers e1–e6, c1, de vrijgestelde c2 en c3
-- van organisatie B, rekeningen 1100 Bank, 1300 Debiteuren, 1600 Crediteuren,
-- 1520 BTW te vorderen, 1530 BTW te betalen, 4700 Kantoorkosten, 8000 Omzet).
--
-- Id's: 1400 = banktransactie, 2400 = inkoopfactuur, 3400 = verkoopfactuur.
-- Alle bronrijen worden als eigenaar ingevoegd, zoals een import of een
-- opgeslagen formulier ze achterlaat; boeken gebeurt UITSLUITEND via de echte
-- schrijvers, als de echte rol `authenticated` (proof.call).

/** Een gecodeerde banktransactie (handmatig_geboekt + rekening), met een btw-percentage dat ook NULL mag zijn. */
CREATE FUNCTION proof.p4_tx(_n integer, _amount numeric, _pct numeric,
                            _client uuid DEFAULT '00000000-0000-0000-0000-0000000000c1',
                            _date date DEFAULT DATE '2027-03-01',
                            _status text DEFAULT 'handmatig_geboekt',
                            _acct uuid DEFAULT '00000000-0000-0000-0000-00000000f007')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := proof.uid(1400, _n);
BEGIN
  INSERT INTO public.bank_transactions
    (id, user_id, client_id, organization_id, transaction_date, description, amount,
     match_status, grootboekrekening_id, btw_percentage)
  SELECT v_id,
         CASE WHEN c.organization_id = '00000000-0000-0000-0000-00000000a002'
              THEN '00000000-0000-0000-0000-0000000000e3'::uuid
              ELSE '00000000-0000-0000-0000-0000000000e1'::uuid END,
         c.id, c.organization_id, _date, format('P4 bankregel %s', _n), _amount,
         _status, CASE WHEN _status = 'handmatig_geboekt' THEN _acct END, _pct
  FROM public.clients c WHERE c.id = _client;
  RETURN v_id;
END $$;

/** Een inkoopfactuur met regels (rekening 4700), NIET geboekt. */
CREATE FUNCTION proof.p4_purchase(_n integer, _client uuid, _excl numeric, _btw numeric, _incl numeric,
                                  _pct numeric, _lines numeric[],
                                  _status text DEFAULT 'gecontroleerd',
                                  _date date DEFAULT DATE '2027-02-15')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id   uuid := proof.uid(2400, _n);
  v_org  uuid;
  v_user uuid;
  i      integer;
BEGIN
  SELECT organization_id INTO v_org FROM public.clients WHERE id = _client;
  v_user := CASE WHEN v_org = '00000000-0000-0000-0000-00000000a002'
                 THEN '00000000-0000-0000-0000-0000000000e3'::uuid
                 ELSE '00000000-0000-0000-0000-0000000000e1'::uuid END;
  INSERT INTO public.purchase_invoices
    (id, user_id, client_id, organization_id, supplier, invoice_number, invoice_date,
     amount_excl, btw_amount, amount_incl, btw_percentage, status)
  VALUES
    (v_id, v_user, _client, v_org, format('Leverancier P4-%s', _n), format('P4-INK-%s', _n), _date,
     _excl, _btw, _incl, _pct, _status);
  FOR i IN 1 .. coalesce(cardinality(_lines), 0) LOOP
    INSERT INTO public.purchase_invoice_lines
      (purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl, btw_percentage,
       grootboekrekening_id, sort_order)
    VALUES
      (v_id, v_user, v_org, format('Regel %s', i), _lines[i], _pct,
       '00000000-0000-0000-0000-00000000f007', i);
  END LOOP;
  RETURN v_id;
END $$;

/** Een verkoopfactuur (omzet 8000), NIET geboekt. */
CREATE FUNCTION proof.p4_sales(_n integer, _client uuid, _excl numeric, _btw numeric, _incl numeric,
                               _pct numeric, _status text DEFAULT 'gecontroleerd',
                               _verlegd boolean DEFAULT false, _date date DEFAULT DATE '2027-02-20')
RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.sales_invoices
    (id, user_id, client_id, organization_id, customer_name, invoice_number, invoice_date,
     amount_excl, btw_amount, amount_incl, btw_percentage, btw_verlegd, status, grootboekrekening_id)
  SELECT proof.uid(3400, _n), '00000000-0000-0000-0000-0000000000e1', c.id, c.organization_id,
         format('Klant P4-%s', _n), format('P4-VK-%s', _n), _date,
         _excl, _btw, _incl, _pct, _verlegd, _status, '00000000-0000-0000-0000-00000000f008'
  FROM public.clients c WHERE c.id = _client
  RETURNING id;
$$;

/** Een schrijver aanroepen als `authenticated` met auth.uid() = _user: 'ok: <groep>' of 'fout [SQLSTATE] …'. */
CREATE FUNCTION proof.p4_post(_user uuid, _fn text, _id uuid, _role text DEFAULT 'authenticated')
RETURNS text LANGUAGE sql AS $$
  SELECT proof.call(_user, format('SELECT public.%I(%L::uuid)::text', _fn, _id), _role);
$$;

/** De boekingsgroep van een bron, uit haar markertabel. */
CREATE FUNCTION proof.p4_group(_source_type text, _id uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE _source_type
    WHEN 'purchase_invoice' THEN (SELECT posting_group_id FROM public.purchase_invoice_postings WHERE purchase_invoice_id = _id)
    WHEN 'sales_invoice'    THEN (SELECT posting_group_id FROM public.sales_invoice_postings WHERE sales_invoice_id = _id)
    WHEN 'bank_transaction' THEN (SELECT posting_group_id FROM public.bank_transaction_postings WHERE bank_transaction_id = _id)
  END;
$$;

/** De grootboekregels van een bron als "rekening:debet:credit", in regelvolgorde. */
CREATE FUNCTION proof.p4_lines(_source_type text, _id uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT proof.lines(proof.p4_group(_source_type, _id));
$$;

/** Aantal grootboekregels met deze bron (over alle groepen). */
CREATE FUNCTION proof.p4_ledger_rows(_id uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM public.ledger_postings WHERE source_id = _id;
$$;

/** Een uitkomst van proof.call: is het precies deze SQLSTATE, met deze tekst erin? */
CREATE FUNCTION proof.p4_is_error(_out text, _state text, _needle text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT _out LIKE format('fout [%s] %%', _state) AND position(lower(_needle) IN lower(_out)) > 0;
$$;

-- ── de vijf functies ────────────────────────────────────────────────────────

CREATE FUNCTION proof.p4_functions() RETURNS SETOF regprocedure LANGUAGE sql STABLE AS $$
  SELECT f FROM unnest(ARRAY[
    to_regprocedure('public.post_purchase_invoice(uuid)'),
    to_regprocedure('public.post_sales_invoice(uuid)'),
    to_regprocedure('public.post_bank_transaction(uuid)'),
    to_regprocedure('public.bank_bulk_posting_candidates(uuid,integer)'),
    to_regprocedure('public.post_bank_transactions_bulk(uuid[])')]) f;
$$;

/** md5(prosrc) per functie, als "naam=md5" in vaste volgorde. */
CREATE FUNCTION proof.p4_md5s() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT string_agg(format('%s=%s', p.proname, md5(p.prosrc)), ',' ORDER BY p.proname)
  FROM pg_proc p WHERE p.oid IN (SELECT proof.p4_functions());
$$;

/** Alles behalve het lichaam: eigenaar, SECURITY DEFINER/INVOKER, search_path, volatiliteit, taal, uitkomsttype, rechten. */
CREATE FUNCTION proof.p4_attrs() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', p.oid::regprocedure, p.proowner::regrole, p.prosecdef,
                           p.proconfig, p.provolatile, p.prolang, pg_get_function_result(p.oid), p.proacl),
                    E'\n' ORDER BY p.oid::regprocedure::text)
  FROM pg_proc p WHERE p.oid IN (SELECT proof.p4_functions());
$$;

/** De constraints van deze migratie: "tabel.naam:gevalideerd:definitie". */
CREATE FUNCTION proof.p4_constraints() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(format('%s.%s:%s:%s', cl.relname, c.conname, c.convalidated::text, pg_get_constraintdef(c.oid)),
                             E'\n' ORDER BY c.conname), '')
  FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
  WHERE c.conname IN ('ledger_postings_amounts_not_nan', 'purchase_invoices_amounts_not_nan',
                      'sales_invoices_amounts_not_nan', 'purchase_invoice_lines_amount_finite',
                      'bank_transactions_amount_not_nan');
$$;

-- ── de rolloutblokken ───────────────────────────────────────────────────────

/** Een blok uit preflight/postcheck als subquery: elke booleaanse kolom van elke rij is true (en er is minstens één rij). */
CREATE FUNCTION proof.p4_all_true(_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v boolean; n bigint;
BEGIN
  EXECUTE format('SELECT count(*), bool_and(NOT (to_jsonb(r) @? %L)) FROM (%s) r',
                 '$.* ? (@ == false)', regexp_replace(_sql, ';\s*$', ''))
    INTO n, v;
  RETURN n > 0 AND coalesce(v, false);
END $$;

/** Een blok als tekst: één JSON-object per rij, gesorteerd. */
CREATE FUNCTION proof.p4_rows(_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  EXECUTE format('SELECT string_agg(to_jsonb(r)::text, E''\n'' ORDER BY to_jsonb(r)::text) FROM (%s) r',
                 regexp_replace(_sql, ';\s*$', ''))
    INTO v;
  RETURN v;
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;
