-- TEST FIXTURES — throwaway database only. Never run against any BoekAssist database.
--
-- Herstel P7 (20261021200000): de jaarafsluiting telt ook gecodeerde, nog niet
-- geboekte bankregels (A3-02) en telt alleen werk van de eigen organisatie
-- (B1-04). Draait na de echte migratieketen t/m 20261020120000, VÓÓR de
-- migratie onder test.
--
-- Elke casus krijgt een eigen administratie, zodat de ene casus de afsluiting
-- van de andere niet kan beïnvloeden (controle B kijkt naar oudere jaren met
-- boekingen; controle D telt alle jaren t/m het doeljaar). Boekingen gaan
-- uitsluitend via de ECHTE schrijvers; er wordt nergens rechtstreeks in het
-- grootboek of in een marker geschreven.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE EXTENSION IF NOT EXISTS dblink;

-- ── bewijsadministratie ─────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS proof;
GRANT USAGE ON SCHEMA proof TO public;

CREATE TABLE proof.result (n text, name text, ok boolean, detail text);
GRANT INSERT, SELECT ON proof.result TO public;

CREATE TABLE proof.state (k text PRIMARY KEY, v text);
GRANT INSERT, SELECT, UPDATE ON proof.state TO public;

CREATE FUNCTION proof.put(_k text, _v text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO proof.state VALUES (_k, _v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
$$;

CREATE FUNCTION proof.get(_k text)
RETURNS text LANGUAGE sql STABLE AS $$ SELECT v FROM proof.state WHERE k = _k $$;

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

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

-- ── organisaties, gebruikers, rollen ────────────────────────────────────────
INSERT INTO public.organizations (id, name) VALUES
  ('00000000-0000-0000-0000-00000000a001', 'Agio Finance'),
  ('00000000-0000-0000-0000-00000000a002', 'Andere organisatie');

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'accountant@agio.test'),
  ('00000000-0000-0000-0000-0000000000e2', 'assistent@agio.test'),
  ('00000000-0000-0000-0000-0000000000e3', 'accountant@ander.test'),
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

-- ── organisatiebrede rekeningschema's ───────────────────────────────────────
INSERT INTO public.grootboekrekeningen (id, organization_id, client_id, nummer, omschrijving, categorie, actief) VALUES
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000a001', NULL, 1100, 'Bank',            'activa',  true),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000a001', NULL, 1300, 'Debiteuren',      'activa',  true),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-00000000a001', NULL, 1600, 'Crediteuren',     'passiva', true),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-00000000a001', NULL, 1520, 'BTW te vorderen', 'activa',  true),
  ('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-00000000a001', NULL, 1530, 'BTW te betalen',  'passiva', true),
  ('00000000-0000-0000-0000-00000000f006', '00000000-0000-0000-0000-00000000a001', NULL, 4400, 'Kantoorkosten',   'kosten',  true),
  ('00000000-0000-0000-0000-00000000f007', '00000000-0000-0000-0000-00000000a001', NULL, 8000, 'Omzet',           'omzet',   true),
  ('00000000-0000-0000-0000-00000000fb01', '00000000-0000-0000-0000-00000000a002', NULL, 1100, 'Bank B',          'activa',  true),
  ('00000000-0000-0000-0000-00000000fb06', '00000000-0000-0000-0000-00000000a002', NULL, 4400, 'Kosten B',        'kosten',  true);

-- ── identiteiten ────────────────────────────────────────────────────────────
--    0c = administratie, 1000 = banktransactie, 2000 = inkoopfactuur,
--    3000 = verkoopfactuur, 4000 = koppeling
CREATE FUNCTION proof.uid(_prefix integer, _n integer)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT format('00000000-0000-0000-%s-%s', lpad(_prefix::text, 4, '0'), lpad(_n::text, 12, '0'))::uuid;
$$;

CREATE FUNCTION proof.client(_n integer)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT proof.uid(12, _n) $$;

/** Een geconfigureerde administratie (bank-, debiteuren-, crediteuren- en btw-rekeningen). */
CREATE FUNCTION proof.new_client(_n integer, _name text, _org uuid DEFAULT '00000000-0000-0000-0000-00000000a001')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := proof.client(_n);
BEGIN
  INSERT INTO public.clients (id, organization_id, name) VALUES (v_id, _org, _name);
  IF _org = '00000000-0000-0000-0000-00000000a001' THEN
    UPDATE public.clients SET
      bank_rekening_id            = '00000000-0000-0000-0000-00000000f001',
      debiteuren_rekening_id      = '00000000-0000-0000-0000-00000000f002',
      crediteuren_rekening_id     = '00000000-0000-0000-0000-00000000f003',
      btw_te_vorderen_rekening_id = '00000000-0000-0000-0000-00000000f004',
      btw_te_betalen_rekening_id  = '00000000-0000-0000-0000-00000000f005'
    WHERE id = v_id;
  ELSE
    UPDATE public.clients SET bank_rekening_id = '00000000-0000-0000-0000-00000000fb01' WHERE id = v_id;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION proof.as_user(_user uuid)
RETURNS void LANGUAGE sql AS $$ SELECT set_config('test.user_id', coalesce(_user::text, ''), false) $$;

CREATE FUNCTION proof.accountant() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000e1'::uuid $$;
CREATE FUNCTION proof.assistant()  RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000e2'::uuid $$;
CREATE FUNCTION proof.outsider()   RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000e3'::uuid $$;
CREATE FUNCTION proof.reader()     RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000e4'::uuid $$;

/**
 * Een banktransactie. De organisatie wordt EXPLICIET meegegeven, net als het
 * directe PostgREST-pad dat kan (B1-02): set_organization_id() respecteert een
 * meegegeven waarde. Standaard handmatig gecodeerd op kantoorkosten met 21%.
 */
CREATE FUNCTION proof.tx(
  _n       integer,
  _client  uuid,
  _date    date,
  _amount  numeric,
  _status  text DEFAULT 'handmatig_geboekt',
  _account uuid DEFAULT '00000000-0000-0000-0000-00000000f006',
  _org     uuid DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := proof.uid(1000, _n);
BEGIN
  INSERT INTO public.bank_transactions
    (id, user_id, client_id, organization_id, transaction_date, description, amount,
     match_status, grootboekrekening_id, btw_percentage)
  VALUES
    (v_id, proof.accountant(), _client,
     coalesce(_org, (SELECT organization_id FROM public.clients WHERE id = _client)),
     _date, format('Bankregel %s', _n), _amount, _status, _account,
     CASE WHEN _account IS NULL THEN NULL ELSE 21 END);
  RETURN v_id;
END $$;

/** Een inkoopfactuur met één regel; NIET geboekt. */
CREATE FUNCTION proof.purchase(
  _n      integer,
  _client uuid,
  _date   date,
  _amount numeric,
  _status text DEFAULT 'gecontroleerd',
  _org    uuid DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id  uuid := proof.uid(2000, _n);
  v_org uuid := coalesce(_org, (SELECT organization_id FROM public.clients WHERE id = _client));
BEGIN
  INSERT INTO public.purchase_invoices
    (id, user_id, client_id, organization_id, supplier, invoice_number, invoice_date,
     amount_excl, btw_amount, amount_incl, btw_percentage, remaining_amount, status)
  VALUES
    (v_id, proof.accountant(), _client, v_org, format('Leverancier %s', _n), format('INK-%s', _n),
     _date, _amount, 0, _amount, 0, _amount, _status);
  INSERT INTO public.purchase_invoice_lines
    (purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl, btw_percentage, grootboekrekening_id)
  VALUES
    (v_id, proof.accountant(), v_org, 'Kantoorkosten', _amount, 0, '00000000-0000-0000-0000-00000000f006');
  RETURN v_id;
END $$;

/** Een gecontroleerde verkoopfactuur, geboekt via de echte schrijver. */
CREATE FUNCTION proof.sales_posted(_n integer, _client uuid, _date date, _amount numeric)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := proof.uid(3000, _n);
BEGIN
  INSERT INTO public.sales_invoices
    (id, user_id, client_id, organization_id, customer_name, invoice_number, invoice_date,
     amount_excl, btw_amount, amount_incl, btw_percentage, remaining_amount, status, grootboekrekening_id)
  VALUES
    (v_id, proof.accountant(), _client, (SELECT organization_id FROM public.clients WHERE id = _client),
     format('Debiteur %s', _n), format('VRK-%s', _n), _date, _amount, 0, _amount, 0, _amount,
     'gecontroleerd', '00000000-0000-0000-0000-00000000f007');
  PERFORM proof.as_user(proof.accountant());
  PERFORM public.post_sales_invoice(v_id);
  RETURN v_id;
END $$;

/** Een koppeling van een banktransactie aan een factuur (niet geboekt). */
CREATE FUNCTION proof.alloc(_n integer, _tx uuid, _type text, _inv uuid, _amount numeric)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_client uuid := (SELECT client_id FROM public.bank_transactions WHERE id = _tx);
BEGIN
  INSERT INTO public.bank_transaction_allocations
    (id, bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
  VALUES
    (proof.uid(4000, _n), _tx, _type, _inv, v_client, _amount, proof.accountant());
  RETURN proof.uid(4000, _n);
END $$;

/**
 * Een AFSLUITPOGING die nooit iets achterlaat.
 *
 * Voert close_fiscal_year() uit als de opgegeven gebruiker, onthoudt de
 * uitkomst en draait de subtransactie daarna ALTIJD terug met een vaste
 * sentinel. Zo kan dezelfde casus vóór en ná de migratie, en voor elke
 * variant, opnieuw worden geprobeerd op exact dezelfde toestand.
 * Uitkomst: 'created=true' / 'created=false' of '[SQLSTATE] melding'.
 */
CREATE FUNCTION proof.try_close(_client uuid, _year integer, _user uuid DEFAULT '00000000-0000-0000-0000-0000000000e1')
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
  v_prev text := current_setting('test.user_id', true);
BEGIN
  BEGIN
    PERFORM set_config('test.user_id', coalesce(_user::text, ''), true);
    SELECT format('created=%s', c.created::text) INTO v_out FROM public.close_fiscal_year(_client, _year) c;
    RAISE EXCEPTION USING ERRCODE = 'P7SNT', MESSAGE = 'P7-SENTINEL';
  EXCEPTION
    WHEN SQLSTATE 'P7SNT' THEN NULL;
    WHEN others THEN v_out := format('[%s] %s', SQLSTATE, SQLERRM);
  END;
  PERFORM set_config('test.user_id', coalesce(v_prev, ''), false);
  RETURN v_out;
END $$;

/** Echte afsluiting (blijft staan); geeft de uitkomstrij terug als tekst. */
CREATE FUNCTION proof.close_now(_client uuid, _year integer)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_out text;
BEGIN
  PERFORM proof.as_user(proof.accountant());
  SELECT format('created=%s', c.created::text) INTO v_out FROM public.close_fiscal_year(_client, _year) c;
  RETURN v_out;
END $$;

/** Vingerafdruk van de levenscyclus: afsluitbewijzen, gebeurtenissen, watermerk en blokkade. */
CREATE FUNCTION proof.lifecycle_digest()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(concat_ws('|',
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.client_id, t.fiscal_year), '')) FROM public.year_closures t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.fiscal_year_events t),
    (SELECT md5(coalesce(string_agg(format('%s:%s:%s', t.id, t.afgesloten_boekjaar, t.posting_locked_through), ',' ORDER BY t.id), ''))
       FROM public.clients t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.posting_lock_events t)));
$$;

/** Vingerafdruk van alle boekhoudkundige en bronrijen (een rollback mag hier niets aan veranderen). */
CREATE FUNCTION proof.data_digest()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(concat_ws('|',
    proof.lifecycle_digest(),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.ledger_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.bank_transaction_id), '')) FROM public.bank_transaction_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.bank_transactions t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.bank_transaction_allocations t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.purchase_invoices t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.sales_invoices t)));
$$;

CREATE FUNCTION proof.close_md5()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.close_fiscal_year(uuid,integer)');
$$;

/**
 * Vingerafdruk van de catalogus van public: elke functie (lichaam, rechten,
 * definer, search_path, eigenaar), elke trigger, policy, kolom en index.
 * Van close_fiscal_year telt alleen het LICHAAM niet mee — dat is wat de
 * migratie hoort te veranderen; haar rechten en eigenschappen tellen wél.
 */
CREATE FUNCTION proof.catalog_digest()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(concat_ws('|',
    (SELECT md5(string_agg(format('%s:%s:%s:%s:%s:%s', p.oid::regprocedure,
                                  CASE WHEN p.oid = 'public.close_fiscal_year(uuid,integer)'::regprocedure
                                       THEN 'lichaam-onder-test' ELSE md5(p.prosrc) END,
                                  p.proacl, p.prosecdef, p.proconfig, p.proowner::regrole), ',' ORDER BY p.oid::regprocedure::text))
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
    (SELECT md5(string_agg(format('%s:%s:%s', t.tgrelid::regclass, t.tgenabled, pg_get_triggerdef(t.oid)), ',' ORDER BY t.tgrelid::regclass::text, t.tgname))
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal),
    (SELECT md5(coalesce(string_agg(format('%s:%s:%s:%s:%s', tablename, policyname, cmd, qual, with_check), ',' ORDER BY tablename, policyname), ''))
     FROM pg_policies WHERE schemaname = 'public'),
    (SELECT md5(string_agg(format('%s:%s:%s:%s:%s', table_name, column_name, data_type, is_nullable, column_default), ',' ORDER BY table_name, column_name))
     FROM information_schema.columns WHERE table_schema = 'public'),
    (SELECT md5(coalesce(string_agg(format('%s:%s', tablename, indexdef), ',' ORDER BY tablename, indexname), ''))
     FROM pg_indexes WHERE schemaname = 'public')));
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

-- ── de casussen ─────────────────────────────────────────────────────────────
--
-- K1  A3-02: een gecodeerde, nog niet geboekte bankregel in 2026 (het
--     scenario van de nulmeting, probe Y2/Y4), naast een geboekte verkoop.
-- K2  FD-N3: een bankregel op 'gematcht' zonder koppeling in 2026.
-- K3  gecodeerd maar ZONDER grootboekrekening        (schrijver: review_needed)
-- K4  gecodeerd, bedrag 0                            (schrijver weigert altijd)
-- K5  'suggestie' en 'niet_gematcht' mét rekening    (niet gecodeerd)
-- K6  gecodeerd mét koppeling aan een ongeboekte factuur (aflettering, niet direct)
-- K7  gecodeerd in 2027                               (later jaar)
-- K8  B1-04: een postbare inkoopfactuur van een ANDERE organisatie met het
--     client_id van K8, en een gecodeerde bankregel van die andere organisatie
-- K9  B1-04: een postbare inkoopfactuur ZONDER organisatie (erfenis)
-- K10 B1-04: een gecodeerde bankregel ZONDER organisatie (erfenis)
-- K11 de vrijgave-hold: gecodeerd, geboekt en daarna vrijgegeven (S3); de
--     vrijgave zet de regel terug op niet_gematcht zonder rekening
-- K12 rol, tenant, idempotentie, herafsluiten, gelijktijdigheid
-- K13 de bankregel wordt geboekt terwijl een afsluiting wacht
-- KB  een administratie van de andere organisatie

SELECT proof.new_client(1,  'K1 — A3-02');
SELECT proof.new_client(2,  'K2 — gematcht zonder koppeling');
SELECT proof.new_client(3,  'K3 — gecodeerd zonder rekening');
SELECT proof.new_client(4,  'K4 — gecodeerd, bedrag 0');
SELECT proof.new_client(5,  'K5 — niet gecodeerd');
SELECT proof.new_client(6,  'K6 — gecodeerd met koppeling');
SELECT proof.new_client(7,  'K7 — gecodeerd in 2027');
SELECT proof.new_client(8,  'K8 — bron van een andere organisatie');
SELECT proof.new_client(9,  'K9 — inkoop zonder organisatie');
SELECT proof.new_client(10, 'K10 — bank zonder organisatie');
SELECT proof.new_client(11, 'K11 — vrijgegeven bankregel');
SELECT proof.new_client(12, 'K12 — rol, tenant, levenscyclus');
SELECT proof.new_client(13, 'K13 — gelijktijdig');
SELECT proof.new_client(99, 'KB — andere organisatie', '00000000-0000-0000-0000-00000000a002');

-- K1: gewone activiteit + de gecodeerde, ongeboekte huur van juni.
SELECT proof.sales_posted(101, proof.client(1), DATE '2026-03-01', 1000);
SELECT proof.tx(101, proof.client(1), DATE '2026-06-01', -1210);

-- K2: 'gematcht' zonder koppelingsrij (de halve toestand van D-03).
SELECT proof.tx(201, proof.client(2), DATE '2026-06-01', 605, 'gematcht', NULL);

-- K3..K7: de postbaarheidsregels van de directe bankschrijver, één per administratie.
SELECT proof.tx(301, proof.client(3), DATE '2026-06-01', -121, 'handmatig_geboekt', NULL);
SELECT proof.tx(401, proof.client(4), DATE '2026-06-01', 0);
SELECT proof.tx(501, proof.client(5), DATE '2026-06-01', -121, 'suggestie');
SELECT proof.tx(502, proof.client(5), DATE '2026-06-02', -121, 'niet_gematcht');
SELECT proof.purchase(601, proof.client(6), DATE '2026-05-01', 121, 'te_controleren');
SELECT proof.tx(601, proof.client(6), DATE '2026-06-01', -121);
SELECT proof.alloc(601, proof.uid(1000, 601), 'inkoop', proof.uid(2000, 601), 121);
SELECT proof.tx(701, proof.client(7), DATE '2027-01-15', -121);

-- K8: een rij die uitdrukkelijk bij de ANDERE organisatie hoort, met het
--     client_id van K8 (het directe pad van B1-02).
SELECT proof.purchase(801, proof.client(8), DATE '2026-05-01', 121, 'gecontroleerd', '00000000-0000-0000-0000-00000000a002');
SELECT proof.tx(801, proof.client(8), DATE '2026-06-01', -121, 'handmatig_geboekt',
                '00000000-0000-0000-0000-00000000fb06', '00000000-0000-0000-0000-00000000a002');

-- K9/K10: erfenis van vóór de backfill — organization_id leeg. De rebind-
--     trigger staat dat terecht niet toe; alleen een superuser in replica-modus
--     kan zo'n rij nabootsen.
SELECT proof.purchase(901, proof.client(9), DATE '2026-05-01', 121);
SELECT proof.tx(1001, proof.client(10), DATE '2026-06-01', -121);
SET session_replication_role = replica;
UPDATE public.purchase_invoices SET organization_id = NULL WHERE id = proof.uid(2000, 901);
UPDATE public.purchase_invoice_lines SET organization_id = NULL WHERE purchase_invoice_id = proof.uid(2000, 901);
UPDATE public.bank_transactions SET organization_id = NULL WHERE id = proof.uid(1000, 1001);
RESET session_replication_role;

-- K11: gecodeerd en geboekt; de vrijgave volgt in proof.sql (S1 → S3).
SELECT proof.tx(1101, proof.client(11), DATE '2026-06-01', -121);
SELECT proof.as_user(proof.accountant());
SELECT public.post_bank_transaction(proof.uid(1000, 1101));

-- K12: activiteit in 2025 en 2026; de levenscyclus loopt in proof.sql.
SELECT proof.sales_posted(1201, proof.client(12), DATE '2025-03-01', 500);
SELECT proof.sales_posted(1202, proof.client(12), DATE '2026-03-01', 500);

-- K13: één gecodeerde, ongeboekte bankregel; geboekt in de gelijktijdigheidsproef.
SELECT proof.tx(1301, proof.client(13), DATE '2026-06-01', -121);

-- KB: de andere organisatie (voor de tenantproef).
SELECT proof.tx(9901, proof.client(99), DATE '2026-06-01', -100, 'handmatig_geboekt', '00000000-0000-0000-0000-00000000fb06');

SELECT proof.as_user(NULL);
