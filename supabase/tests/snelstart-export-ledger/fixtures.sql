-- TEST FIXTURES — throwaway database only. Never run against any BoekAssist database.
--
-- Herstelpakket P6 (A2-04): inkoopfacturen die via de ECHTE schrijver
-- post_purchase_invoice() (laatste definitie: 20261002120000) worden geboekt,
-- zodat hun journaalregels naast de SnelStart-export per boekingsregel kunnen
-- worden gelegd. Er wordt nergens rechtstreeks in het grootboek geschreven.
--
-- Draait na ../opening-balance/bootstrap.sql, ../bank-direct-allocation-guard/
-- bootstrap-sources.sql en de echte migratieketen t/m 20261010120000.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ── bewijsadministratie (zelfde vorm als de bestaande harnassen) ────────────
CREATE SCHEMA IF NOT EXISTS proof;
GRANT USAGE ON SCHEMA proof TO public;

CREATE TABLE proof.result (n text, name text, ok boolean, detail text);
GRANT INSERT, SELECT ON proof.result TO public;

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
  ('00000000-0000-0000-0000-0000000000e1', 'assistent@agio.test'),
  ('00000000-0000-0000-0000-0000000000e3', 'buitenstaander@ander.test'),
  ('00000000-0000-0000-0000-0000000000e4', 'lezer@agio.test');

INSERT INTO public.organization_members (user_id, organization_id) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000a002'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-00000000a001');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001', 'assistant'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000a002', 'accountant'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-00000000a001', 'read_only');

-- ── administratie met rekeningschema ────────────────────────────────────────
INSERT INTO public.clients (id, organization_id, name) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000a001', 'Bakkerij Een BV');

INSERT INTO public.grootboekrekeningen (id, organization_id, client_id, nummer, omschrijving, categorie, actief) VALUES
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-00000000a001', NULL, 1600, 'Crediteuren',     'passiva', true),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-00000000a001', NULL, 1520, 'BTW te vorderen', 'activa',  true),
  ('00000000-0000-0000-0000-00000000f006', '00000000-0000-0000-0000-00000000a001', NULL, 4400, 'Kantoorkosten',   'kosten',  true),
  ('00000000-0000-0000-0000-00000000f008', '00000000-0000-0000-0000-00000000a001', NULL, 4600, 'Vakliteratuur',   'kosten',  true),
  ('00000000-0000-0000-0000-00000000f009', '00000000-0000-0000-0000-00000000a001', NULL, 7000, 'Verzekeringen',   'kosten',  true);

UPDATE public.clients SET
  crediteuren_rekening_id     = '00000000-0000-0000-0000-00000000f003',
  btw_te_vorderen_rekening_id = '00000000-0000-0000-0000-00000000f004'
WHERE id = '00000000-0000-0000-0000-0000000000c1';

-- ── facturen ────────────────────────────────────────────────────────────────
CREATE FUNCTION proof.uid(_prefix integer, _n integer)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT format('00000000-0000-0000-%s-%s', lpad(_prefix::text, 4, '0'), lpad(_n::text, 12, '0'))::uuid;
$$;

/** Een gecontroleerde inkoopfactuur (kop), nog niet geboekt. */
CREATE FUNCTION proof.invoice(_n integer, _supplier text, _number text, _excl numeric, _btw numeric, _incl numeric, _pct numeric)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := proof.uid(2000, _n);
BEGIN
  INSERT INTO public.purchase_invoices
    (id, user_id, client_id, organization_id, supplier, invoice_number, invoice_date,
     amount_excl, btw_amount, amount_incl, btw_percentage, remaining_amount, status)
  VALUES
    (v_id, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1',
     '00000000-0000-0000-0000-00000000a001', _supplier, _number, DATE '2026-10-20',
     _excl, _btw, _incl, _pct, _incl, 'gecontroleerd');
  RETURN v_id;
END $$;

/** Een boekingsregel; `_account` is het rekeningnummer (NULL = zonder rekening). */
CREATE FUNCTION proof.line(_inv uuid, _n integer, _sort integer, _oms text, _excl numeric, _pct numeric, _account integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.purchase_invoice_lines
    (id, purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl, btw_percentage, grootboekrekening_id, sort_order)
  VALUES
    (proof.uid(3000, _n), _inv, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000a001',
     _oms, _excl, _pct,
     (SELECT g.id FROM public.grootboekrekeningen g WHERE g.nummer = _account
        AND g.organization_id = '00000000-0000-0000-0000-00000000a001'),
     _sort);
END $$;

CREATE FUNCTION proof.post_as(_user uuid, _inv uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('test.user_id', _user::text, true);
  RETURN public.post_purchase_invoice(_inv);
END $$;

-- S1  A2-04: UBL-factuur 100 @ 21% (4400) + 100 @ 9% (4600); kop 200 / 30 / 230.
SELECT proof.invoice(1, 'Leverancier BV', '000123', 200.00, 30.00, 230.00, 21);
SELECT proof.line(proof.uid(2000, 1), 11, 0, 'Kantoorartikelen', 100.00, 21, 4400);
SELECT proof.line(proof.uid(2000, 1), 12, 1, 'Vakliteratuur',    100.00,  9, 4600);

-- S2  0%: verzekeringspremie 50 @ 0% (7000); kop 50 / 0 / 50.
SELECT proof.invoice(2, 'Verzekeraar NV', 'V-0', 50.00, 0.00, 50.00, 0);
SELECT proof.line(proof.uid(2000, 2), 21, 0, 'Premie', 50.00, 0, 7000);

-- S3  drie tarieven en drie rekeningen; kop-btw = som van de regel-btw.
--     250 @ 21% = 52,50; 80 @ 9% = 7,20; 40 @ 0% = 0; kop 370 / 59,70 / 429,70.
SELECT proof.invoice(3, 'Groothandel BV', 'G-77', 370.00, 59.70, 429.70, NULL);
SELECT proof.line(proof.uid(2000, 3), 31, 0, 'Papier',   250.00, 21, 4400);
SELECT proof.line(proof.uid(2000, 3), 32, 1, 'Boeken',    80.00,  9, 4600);
SELECT proof.line(proof.uid(2000, 3), 33, 2, 'Premie',    40.00,  0, 7000);

-- S4  afronding per regel: 10,00 + 20,50 + 33,33 @ 21%; per regel 2,10 + 4,31 +
--     7,00 = 13,41 en de leverancier rondt ook per regel af: kop 63,83 / 13,41 / 77,24.
SELECT proof.invoice(4, 'Drukkerij BV', 'D-4', 63.83, 13.41, 77.24, 21);
SELECT proof.line(proof.uid(2000, 4), 41, 0, 'Flyers',     10.00, 21, 4400);
SELECT proof.line(proof.uid(2000, 4), 42, 1, 'Posters',    20.50, 21, 4400);
SELECT proof.line(proof.uid(2000, 4), 43, 2, 'Visitekaart', 33.33, 21, 4400);

-- S5  de kop rondt de btw over het totaal af (2 × 1,50 @ 9% = 0,27), zoals de
--     werkbank; per regel afgerond zou het 0,28 zijn. De export verdeelt de kop-btw
--     (0,14 + 0,13, H6-01) en dat rekent SnelStart toevallig ook terug
--     (1,64 → 0,14; 1,63 → 0,13). Dat geldt NIET algemeen: zie S9.
SELECT proof.invoice(5, 'Boekhandel VOF', 'B-5', 3.00, 0.27, 3.27, 9);
SELECT proof.line(proof.uid(2000, 5), 51, 0, 'Tijdschrift A', 1.50, 9, 4600);
SELECT proof.line(proof.uid(2000, 5), 52, 1, 'Tijdschrift B', 1.50, 9, 4600);

-- S6  VERSCHIL: een regel zonder btw-percentage (NULL). De schrijver kijkt niet
--     naar het regeltarief en boekt de kop-btw; de export weigert (onbekende btw).
SELECT proof.invoice(6, 'Onbekend Tarief BV', 'N-6', 100.00, 21.00, 121.00, 21);
SELECT proof.line(proof.uid(2000, 6), 61, 0, 'Dienst', 100.00, NULL, 4400);

-- S7  geen boekingsregels: de schrijver weigert, de export weigert ook.
SELECT proof.invoice(7, 'Zonder Regels BV', 'Z-1', 100.00, 21.00, 121.00, 21);

-- S8  een regel zonder grootboekrekening: de schrijver weigert, de export ook.
SELECT proof.invoice(8, 'Geen Rekening BV', 'R-1', 100.00, 21.00, 121.00, 21);
SELECT proof.line(proof.uid(2000, 8), 81, 0, 'Diversen', 100.00, 21, NULL);

-- S9  VERSCHIL (H6-01b): 2 × 1,30 @ 21%, kop-btw over het totaal 0,55. Elke
--     verdeling geeft een regel 1,58, en daaruit rekent SnelStart 0,27 terug, niet
--     0,28. Het grootboek boekt 0,55; de export weigert de factuur.
SELECT proof.invoice(9, 'Kantoorshop BV', 'K-9', 2.60, 0.55, 3.15, 21);
SELECT proof.line(proof.uid(2000, 9), 91, 0, 'Pennen',  1.30, 21, 4400);
SELECT proof.line(proof.uid(2000, 9), 92, 1, 'Mappen',  1.30, 21, 4400);
