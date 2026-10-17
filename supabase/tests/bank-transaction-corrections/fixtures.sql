-- TEST FIXTURES — throwaway database only. Never run against any BoekAssist database.
--
-- Organisatie A met twee administraties (c1 volledig geconfigureerd, c2
-- btw-vrijgesteld), organisatie B met c3. Gebruikers met elke rol. Hulpfuncties
-- die uitsluitend via de ECHTE schrijvers en RPC's werken, als de echte rol
-- `authenticated` (EXECUTE-rechten en RLS gelden dus echt).
--
-- Draait na de echte migratieketen t/m 20261017120000 (PR 0), vóór PR 1.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

-- ── bewijsadministratie ─────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS proof;
GRANT USAGE ON SCHEMA proof TO public;

CREATE TABLE proof.result   (n text, name text, ok boolean, detail text);
CREATE TABLE proof.expected (n text PRIMARY KEY);
CREATE TABLE proof.state    (key text PRIMARY KEY, value text);
CREATE TABLE proof.refusal  (n bigserial, outcome text);
GRANT ALL ON proof.result, proof.expected, proof.state, proof.refusal TO public;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA proof TO public;

/** Elk bestand kondigt zijn bewijzen aan; een bewijs dat stil wegvalt is een FAIL. */
CREATE FUNCTION proof.plan(_ids text[]) RETURNS void LANGUAGE sql AS $$
  INSERT INTO proof.expected SELECT unnest(_ids) ON CONFLICT DO NOTHING;
$$;

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

/** Een fout wordt alleen geaccepteerd met de verwachte SQLSTATE én tekst. */
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

CREATE FUNCTION proof.put(_key text, _value text) RETURNS text LANGUAGE sql AS $$
  INSERT INTO proof.state VALUES (_key, _value)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  RETURNING value;
$$;

CREATE FUNCTION proof.get(_key text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT value FROM proof.state WHERE key = _key;
$$;

-- ── organisaties, gebruikers, rollen ────────────────────────────────────────
INSERT INTO public.organizations (id, name) VALUES
  ('00000000-0000-0000-0000-00000000a001', 'Agio Finance'),
  ('00000000-0000-0000-0000-00000000a002', 'Andere organisatie');

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'accountant@agio.test'),
  ('00000000-0000-0000-0000-0000000000e2', 'assistent@agio.test'),
  ('00000000-0000-0000-0000-0000000000e3', 'buitenstaander@ander.test'),
  ('00000000-0000-0000-0000-0000000000e4', 'lezer@agio.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'tweede-accountant@agio.test'),
  ('00000000-0000-0000-0000-0000000000e6', 'eigenaar@agio.test');

INSERT INTO public.organization_members (user_id, organization_id) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000a002'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-0000000000e6', '00000000-0000-0000-0000-00000000a001');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001', 'accountant'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000a001', 'assistant'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000a002', 'accountant'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-00000000a001', 'read_only'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-00000000a001', 'accountant'),
  ('00000000-0000-0000-0000-0000000000e6', '00000000-0000-0000-0000-00000000a001', 'owner');

-- ── administraties en rekeningschema ────────────────────────────────────────
INSERT INTO public.clients (id, organization_id, name) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000a001', 'Klant 1'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000a001', 'Klant 2 (btw-vrijgesteld)'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000a002', 'Klant van B');

INSERT INTO public.grootboekrekeningen (id, organization_id, client_id, nummer, omschrijving, categorie, actief) VALUES
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000a001', NULL, 1100, 'Bank',               'activa',  true),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000a001', NULL, 1300, 'Debiteuren',         'activa',  true),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-00000000a001', NULL, 1600, 'Crediteuren',        'passiva', true),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-00000000a001', NULL, 1520, 'BTW te vorderen',    'activa',  true),
  ('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-00000000a001', NULL, 1530, 'BTW te betalen',     'passiva', true),
  ('00000000-0000-0000-0000-00000000f006', '00000000-0000-0000-0000-00000000a001', NULL, 8250, 'Verkeerde rekening', 'kosten',  true),
  ('00000000-0000-0000-0000-00000000f007', '00000000-0000-0000-0000-00000000a001', NULL, 4700, 'Kantoorkosten',      'kosten',  true),
  ('00000000-0000-0000-0000-00000000f008', '00000000-0000-0000-0000-00000000a001', NULL, 8000, 'Omzet',              'omzet',   true),
  ('00000000-0000-0000-0000-00000000f009', '00000000-0000-0000-0000-00000000a001', NULL, 4999, 'Inactief',           'kosten',  false),
  ('00000000-0000-0000-0000-00000000f010', '00000000-0000-0000-0000-00000000a001', NULL, 1110, 'Tweede bank',        'activa',  true),
  ('00000000-0000-0000-0000-00000000f011', '00000000-0000-0000-0000-00000000a001', NULL, 1521, 'BTW te vorderen 2',  'activa',  true),
  ('00000000-0000-0000-0000-00000000f012', '00000000-0000-0000-0000-00000000a001', NULL, 1531, 'BTW te betalen 2',   'passiva', true),
  ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000a002', NULL, 1100, 'Bank B',             'activa',  true),
  ('00000000-0000-0000-0000-00000000f104', '00000000-0000-0000-0000-00000000a002', NULL, 1520, 'BTW te vorderen B',  'activa',  true),
  ('00000000-0000-0000-0000-00000000f105', '00000000-0000-0000-0000-00000000a002', NULL, 1530, 'BTW te betalen B',   'passiva', true),
  ('00000000-0000-0000-0000-00000000f106', '00000000-0000-0000-0000-00000000a002', NULL, 4700, 'Kosten B',           'kosten',  true);

UPDATE public.clients SET
  bank_rekening_id            = '00000000-0000-0000-0000-00000000f001',
  debiteuren_rekening_id      = '00000000-0000-0000-0000-00000000f002',
  crediteuren_rekening_id     = '00000000-0000-0000-0000-00000000f003',
  btw_te_vorderen_rekening_id = '00000000-0000-0000-0000-00000000f004',
  btw_te_betalen_rekening_id  = '00000000-0000-0000-0000-00000000f005'
WHERE id IN ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2');

UPDATE public.clients SET btw_vrijgesteld = true WHERE id = '00000000-0000-0000-0000-0000000000c2';

UPDATE public.clients SET
  bank_rekening_id            = '00000000-0000-0000-0000-00000000f101',
  btw_te_vorderen_rekening_id = '00000000-0000-0000-0000-00000000f104',
  btw_te_betalen_rekening_id  = '00000000-0000-0000-0000-00000000f105'
WHERE id = '00000000-0000-0000-0000-0000000000c3';

-- ── identiteiten ────────────────────────────────────────────────────────────
--    1000 = banktransactie, 2000 = inkoopfactuur, 4000 = koppeling, 9000 = request
CREATE FUNCTION proof.uid(_prefix integer, _n integer)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT format('00000000-0000-0000-%s-%s', lpad(_prefix::text, 4, '0'), lpad(_n::text, 12, '0'))::uuid;
$$;

CREATE FUNCTION proof.u(_n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT format('00000000-0000-0000-0000-0000000000e%s', _n)::uuid;
$$;

CREATE FUNCTION proof.acct(_n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT format('00000000-0000-0000-0000-00000000f%s', lpad(_n::text, 3, '0'))::uuid;
$$;

CREATE FUNCTION proof.req(_n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT proof.uid(9000, _n);
$$;

/** Een banktransactie, ingevoegd zoals een import dat doet (eigenaar e1, of e3 voor c3). */
CREATE FUNCTION proof.tx(_n integer, _amount numeric,
                         _client uuid DEFAULT '00000000-0000-0000-0000-0000000000c1',
                         _date date DEFAULT DATE '2027-03-01',
                         _description text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.bank_transactions
    (id, user_id, client_id, organization_id, transaction_date, description, amount, match_status)
  SELECT proof.uid(1000, _n),
         CASE WHEN c.organization_id = '00000000-0000-0000-0000-00000000a002'
              THEN '00000000-0000-0000-0000-0000000000e3'::uuid
              ELSE '00000000-0000-0000-0000-0000000000e1'::uuid END,
         c.id, c.organization_id, _date, coalesce(_description, format('Bankregel %s', _n)), _amount, 'niet_gematcht'
  FROM public.clients c WHERE c.id = _client;
  RETURN proof.uid(1000, _n);
END $$;

/** Een gecontroleerde inkoopfactuur van c1, geboekt via de echte schrijver. */
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
     'Kantoorkosten', _amount, 0, '00000000-0000-0000-0000-00000000f007');
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
  PERFORM public.post_purchase_invoice(v_id);
  RETURN v_id;
END $$;

-- ── als de echte applicatierol ──────────────────────────────────────────────

/** Voert _sql uit als `authenticated` met auth.uid() = _user. Uitkomst: 'ok: …'
    of 'fout [SQLSTATE] bericht | detail | hint'. Elke weigering wordt ook
    bewaard, zodat aan het eind kan worden getoetst dat er nergens een uuid in
    een melding lekt. */
CREATE FUNCTION proof.call(_user uuid, _sql text, _role text DEFAULT 'authenticated')
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text; v_state text; v_msg text; v_detail text; v_hint text; v_out text;
BEGIN
  BEGIN
    PERFORM set_config('test.user_id', coalesce(_user::text, ''), true);
    EXECUTE format('SET LOCAL ROLE %I', _role);
    EXECUTE _sql INTO v;
    RESET ROLE;
    RETURN 'ok: ' || coalesce(v, '');
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                            v_detail = PG_EXCEPTION_DETAIL, v_hint = PG_EXCEPTION_HINT;
  END;
  v_out := format('fout [%s] %s | %s | %s', v_state, v_msg, coalesce(v_detail, ''), coalesce(v_hint, ''));
  INSERT INTO proof.refusal (outcome) VALUES (v_out);
  RETURN v_out;
END $$;

CREATE FUNCTION proof.fmt() RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'format(''%s|%s|%s|%s|%s|%s'', outcome, replayed, posting_group_id, superseded_posting_group_id, reversal_posting_group_id, event_id)';
$$;

CREATE FUNCTION proof.rc(_user uuid, _tx uuid, _expected uuid, _acct uuid, _pct numeric, _req uuid,
                         _reason text DEFAULT NULL, _desc text DEFAULT NULL)
RETURNS text LANGUAGE sql AS $$
  SELECT proof.call(_user, format(
    'SELECT %s FROM public.reclassify_bank_transaction(%L::uuid, %L::uuid, %L::uuid, %L::numeric, %L::uuid, %L::text, %L::text)',
    proof.fmt(), _tx, _expected, _acct, _pct, _req, _reason, _desc));
$$;

CREATE FUNCTION proof.rel(_user uuid, _tx uuid, _expected uuid, _req uuid, _reason text DEFAULT 'Vrijgeven')
RETURNS text LANGUAGE sql AS $$
  SELECT proof.call(_user, format(
    'SELECT %s FROM public.release_bank_transaction_posting(%L::uuid, %L::uuid, %L::uuid, %L::text)',
    proof.fmt(), _tx, _expected, _req, _reason));
$$;

CREATE FUNCTION proof.ret(_user uuid, _tx uuid, _req uuid, _reason text DEFAULT 'Terug naar werkstroom')
RETURNS text LANGUAGE sql AS $$
  SELECT proof.call(_user, format(
    'SELECT %s FROM public.return_bank_transaction_to_workflow(%L::uuid, %L::uuid, %L::text)',
    proof.fmt(), _tx, _req, _reason));
$$;

/** Veld n (1 = outcome … 6 = event_id) uit een 'ok: …'-uitkomst. */
CREATE FUNCTION proof.f(_out text, _n integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(split_part(substr(_out, 5), '|', _n), '');
$$;

-- ── lezen ───────────────────────────────────────────────────────────────────

CREATE FUNCTION proof.marker(_tx uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT posting_group_id FROM public.bank_transaction_postings WHERE bank_transaction_id = _tx;
$$;

/** Alle groepen van deze transactie: haar directe bankboekingen en hun tegenboekingen. */
CREATE FUNCTION proof.tx_groups(_tx uuid)
RETURNS TABLE (posting_group_id uuid) LANGUAGE sql STABLE AS $$
  WITH direct AS (
    SELECT DISTINCT lp.posting_group_id FROM public.ledger_postings lp
    WHERE lp.source_type = 'bank_transaction' AND lp.source_id = _tx
  )
  SELECT posting_group_id FROM direct
  UNION
  SELECT r.reversal_posting_group_id FROM public.ledger_reversal_postings r
  WHERE r.original_posting_group_id IN (SELECT posting_group_id FROM direct);
$$;

/** Netto (debet − credit) op één rekening, over alle groepen van deze transactie. */
CREATE FUNCTION proof.net(_tx uuid, _acct uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(lp.debit_amount - lp.credit_amount), 0) FROM public.ledger_postings lp
  WHERE lp.posting_group_id IN (SELECT posting_group_id FROM proof.tx_groups(_tx))
    AND lp.grootboekrekening_id = _acct;
$$;

/** De regels van één groep als tekst: "rekening:debet:credit" in regelvolgorde. */
CREATE FUNCTION proof.lines(_group uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT string_agg(format('%s:%s:%s', g.nummer, lp.debit_amount, lp.credit_amount), ',' ORDER BY lp.line_no, lp.id)
  FROM public.ledger_postings lp JOIN public.grootboekrekeningen g ON g.id = lp.grootboekrekening_id
  WHERE lp.posting_group_id = _group;
$$;

/** Aantal groepen in de hele database dat niet in balans is. */
CREATE FUNCTION proof.unbalanced() RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM (
    SELECT posting_group_id FROM public.ledger_postings GROUP BY posting_group_id
    HAVING sum(debit_amount) <> sum(credit_amount) OR sum(debit_amount) <= 0) x;
$$;

/** Vingerafdruk van alle boekhoudkundig relevante rijen (gebeurtenissen zodra die bestaan). */
CREATE FUNCTION proof.digest() RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE v_events text := md5('');  -- een ontbrekende en een lege tabel tellen gelijk
BEGIN
  IF to_regclass('public.bank_transaction_posting_events') IS NOT NULL THEN
    EXECUTE $q$SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.seq), '')) FROM public.bank_transaction_posting_events t$q$
      INTO v_events;
  END IF;
  RETURN md5(concat_ws('|',
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.ledger_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.original_posting_group_id), '')) FROM public.ledger_reversal_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.bank_transaction_id), '')) FROM public.bank_transaction_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.allocation_id), '')) FROM public.bank_allocation_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.bank_transaction_allocations t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.bank_transactions t),
    v_events));
END $$;

/** De lineage-invariant over de hele database (0 = in orde):
    - elke directe bankgroep is de actieve markergroep, of staat precies één
      keer als vervangen in een gebeurtenis;
    - per transactie hoogstens één niet-tegengeboekte directe groep, en die is
      de markergroep;
    - elke vervangen groep is tegengeboekt door de tegenboeking die de
      gebeurtenis noemt. */
CREATE FUNCTION proof.lineage_violations() RETURNS integer LANGUAGE plpgsql STABLE AS $$
DECLARE v integer := 0; v_n integer;
BEGIN
  IF to_regclass('public.bank_transaction_posting_events') IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE $q$
    WITH g AS (
      SELECT DISTINCT lp.source_id AS tx, lp.posting_group_id AS grp
      FROM public.ledger_postings lp WHERE lp.source_type = 'bank_transaction')
    SELECT count(*) FROM g
    WHERE NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = g.tx AND m.posting_group_id = g.grp)
      AND (SELECT count(*) FROM public.bank_transaction_posting_events e
           WHERE e.bank_transaction_id = g.tx AND e.superseded_posting_group_id = g.grp) <> 1 $q$ INTO v_n;
  v := v + v_n;
  EXECUTE $q$
    WITH g AS (
      SELECT DISTINCT lp.source_id AS tx, lp.posting_group_id AS grp
      FROM public.ledger_postings lp WHERE lp.source_type = 'bank_transaction'),
    open AS (
      SELECT g.* FROM g WHERE NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r WHERE r.original_posting_group_id = g.grp))
    SELECT count(*) FROM (
      SELECT tx FROM open GROUP BY tx HAVING count(*) > 1
      UNION ALL
      SELECT o.tx FROM open o
      WHERE NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = o.tx AND m.posting_group_id = o.grp)) x $q$ INTO v_n;
  v := v + v_n;
  EXECUTE $q$
    SELECT count(*) FROM public.bank_transaction_posting_events e
    WHERE e.superseded_posting_group_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r
                      WHERE r.original_posting_group_id = e.superseded_posting_group_id
                        AND r.reversal_posting_group_id = e.reversal_posting_group_id) $q$ INTO v_n;
  RETURN v + v_n;
END $$;

-- ── twee echte sessies (dblink) ─────────────────────────────────────────────

CREATE FUNCTION proof.open_session(_name text, _conn text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dblink_connect(_name, _conn);
  PERFORM dblink_exec(_name, 'SET client_min_messages = warning');
  PERFORM dblink_exec(_name, 'SET statement_timeout = ''20s''');
  PERFORM dblink_exec(_name, 'SET lock_timeout = ''20s''');
  PERFORM * FROM dblink(_name, $q$SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false)$q$) AS t(x text);
  PERFORM proof.put('pid_' || _name, x) FROM dblink(_name, 'SELECT pg_backend_pid()::text') AS t(x text);
END $$;

CREATE FUNCTION proof.remote_outcome(_conn text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text; v_state text; v_msg text;
BEGIN
  BEGIN
    SELECT x INTO v FROM dblink_get_result(_conn) AS t(x text);
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
    RETURN 'ok: ' || coalesce(v, '');
  EXCEPTION WHEN query_canceled OR others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM * FROM dblink_get_result(_conn) AS t(x text);
  EXCEPTION WHEN query_canceled OR others THEN NULL;
  END;
  RETURN format('fout [%s] %s', v_state, v_msg);
END $$;

CREATE FUNCTION proof.remote_run(_conn text, _sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  SELECT x INTO v FROM dblink(_conn, _sql) AS t(x text);
  RETURN 'ok: ' || coalesce(v, '');
EXCEPTION WHEN query_canceled OR others THEN
  RETURN format('fout [%s] %s', SQLSTATE, SQLERRM);
END $$;

CREATE FUNCTION proof.remote_exec(_conn text, _sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dblink_exec(_conn, _sql);
  RETURN 'ok';
EXCEPTION WHEN query_canceled OR others THEN
  RETURN format('fout [%s] %s', SQLSTATE, SQLERRM);
END $$;

/** Waar wacht deze sessie op? 'none', of het grendeltype (transactionid, tuple, advisory, relation …). */
CREATE FUNCTION proof.waiting_on(_name text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT string_agg(DISTINCT l.locktype, ',') FROM pg_locks l
                   WHERE l.pid = proof.get('pid_' || _name)::integer AND NOT l.granted), 'none');
$$;

/** Wacht (hooguit ~5 s) tot sessie _name op een grendel wacht. */
CREATE FUNCTION proof.until_waiting(_name text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE i integer;
BEGIN
  FOR i IN 1..100 LOOP
    IF proof.waiting_on(_name) <> 'none' THEN
      RETURN proof.waiting_on(_name);
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
  RETURN 'none';
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

-- Zoals Supabase: nieuwe objecten in public krijgen standaard ALLE rechten voor
-- de API-rollen. Zo zijn de REVOKE's in de migratie hier dragend, net als in productie.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
