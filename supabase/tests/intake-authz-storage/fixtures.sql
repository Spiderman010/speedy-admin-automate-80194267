-- TEST DOUBLE — fixtures en bewijshulpen voor intake-authz-storage. Alleen voor
-- een wegwerpdatabase. Draait NA de echte keten tot het P2-venster en VÓÓR de
-- P2-migraties, als superuser (RLS speelt hier geen rol; triggers wel).
--
-- uuid-schema (alleen hex):
--   organisaties  aaaaaaaa…0a (A), bbbbbbbb…0b (B)
--   gebruikers    a0…01 owner A, a0…02 accountant A, a0…03 assistant A (uploader),
--                 a0…04 read_only A, a0…05 ex-assistant A (uploader, na de fixtures
--                 uit de organisatie verwijderd), b0…01 owner B, b0…02 assistant B,
--                 c0…01 geregistreerd zonder organisatie
--   klanten       ca…01 (A), ca…02 (A, om te verwijderen), cb…01 (B)
--   grootboek     9a…01-03 (A), 9b…01 (B)
--   inkoop        2a…, 2b…   verkoop 3a…   regels 8a…, 8b…
\set ON_ERROR_STOP on
SET client_min_messages = warning;

-- ── bewijshulpen ─────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS proof;
GRANT USAGE ON SCHEMA proof TO anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS proof.result (
  n      text PRIMARY KEY,
  name   text NOT NULL,
  ok     boolean NOT NULL,
  detail text
);
CREATE TABLE IF NOT EXISTS proof.snapshot (
  k text PRIMARY KEY,
  v text
);
GRANT INSERT, SELECT ON proof.result, proof.snapshot TO anon, authenticated, service_role;

-- Voert _sql uit als de HUIDIGE rol, in een subtransactie die daarna wordt
-- teruggedraaid: het effect telt (rijen), maar blijft niet staan.
CREATE OR REPLACE FUNCTION proof.try_rollback(_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE rc bigint; st text; msg text;
BEGIN
  BEGIN
    EXECUTE _sql;
    GET DIAGNOSTICS rc = ROW_COUNT;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = rc::text;
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
      RETURN 'OK rows=' || msg;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
      RETURN 'ERR ' || st || ': ' || msg;
  END;
END $$;

-- B2-08c: voert de stappen uit als de HUIDIGE rol en meet daarna of het
-- object _path leesbaar en verwijderbaar is; alles wordt teruggedraaid.
-- Uitkomst 'OK leest n|verwijdert m' of 'ERR <sqlstate>: <melding>'.
CREATE OR REPLACE FUNCTION proof.reeks(_sqls text[], _path text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE q text; n bigint := -1; m bigint := -1; st text; msg text;
BEGIN
  BEGIN
    FOREACH q IN ARRAY _sqls LOOP EXECUTE q; END LOOP;
    IF _path IS NOT NULL THEN
      SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'invoices' AND name = _path;
      DELETE FROM storage.objects WHERE bucket_id = 'invoices' AND name = _path;
      GET DIAGNOSTICS m = ROW_COUNT;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = CASE WHEN _path IS NULL THEN 'OK' ELSE format('OK leest %s|verwijdert %s', n, m) END;
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
      RETURN msg;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
      RETURN 'ERR ' || st || ': ' || msg;
  END;
END $$;

-- Idem, maar het effect blijft staan.
CREATE OR REPLACE FUNCTION proof.try_keep(_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE rc bigint; st text; msg text;
BEGIN
  BEGIN
    EXECUTE _sql;
    GET DIAGNOSTICS rc = ROW_COUNT;
    RETURN 'OK rows=' || rc;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    RETURN 'ERR ' || st || ': ' || msg;
  END;
END $$;

-- De eerste kolom van de eerste rij, als tekst (fout = 'ERR …').
CREATE OR REPLACE FUNCTION proof.val(_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v text; st text; msg text;
BEGIN
  BEGIN
    EXECUTE _sql INTO v;
    RETURN coalesce(v, 'NULL');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    RETURN 'ERR ' || st || ': ' || msg;
  END;
END $$;

-- Idem, maar de waarde wordt bepaald en het effect teruggedraaid.
CREATE OR REPLACE FUNCTION proof.val_rollback(_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v text; st text; msg text;
BEGIN
  BEGIN
    EXECUTE _sql INTO v;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = coalesce(v, 'NULL');
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
      RETURN msg;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
      RETURN 'ERR ' || st || ': ' || msg;
  END;
END $$;

-- Legt één bewijs vast: geslaagd als _actual LIKE _expected.
CREATE OR REPLACE FUNCTION proof.expect(_n text, _name text, _actual text, _expected text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO proof.result (n, name, ok, detail)
  VALUES (_n, _name, coalesce(_actual LIKE _expected, false),
          'verwacht ' || _expected || ' · kreeg ' || coalesce(_actual, 'NULL'));
END $$;

-- Wie is de aanroeper (zoals PostgREST request.jwt.claims zet); NULL = geen JWT.
CREATE OR REPLACE FUNCTION proof.als(_uid text) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    CASE WHEN _uid IS NULL THEN '' ELSE json_build_object('sub', _uid, 'role', 'authenticated')::text END,
    true);
$$;

-- De opslagobjecten van het matrixbewijs, op korte naam.
CREATE TABLE IF NOT EXISTS proof.obj (k text PRIMARY KEY, name text NOT NULL);
INSERT INTO proof.obj (k, name) VALUES
  ('doc1',    'a0000000-0000-4000-8000-000000000003/ca000000-0000-4000-8000-000000000001/doc1.pdf'),
  ('doc2',    'a0000000-0000-4000-8000-000000000005/ca000000-0000-4000-8000-000000000001/doc2.pdf'),
  ('s1',      'a0000000-0000-4000-8000-000000000003/sales/ca000000-0000-4000-8000-000000000001/s1.pdf'),
  ('doc3',    'b0000000-0000-4000-8000-000000000002/cb000000-0000-4000-8000-000000000001/doc3.pdf'),
  ('wees',    'a0000000-0000-4000-8000-000000000003/ca000000-0000-4000-8000-000000000001/wees.pdf'),
  ('wees-ex', 'a0000000-0000-4000-8000-000000000005/ca000000-0000-4000-8000-000000000001/wees-ex.pdf')
ON CONFLICT (k) DO NOTHING;
GRANT SELECT ON proof.obj TO anon, authenticated, service_role;

-- Lezen / bijwerken / verwijderen / uploaden als de HUIDIGE rol (RLS geldt).
-- Alles behalve lezen wordt teruggedraaid, zodat het matrix de fixtures niet wijzigt.
CREATE OR REPLACE FUNCTION proof.lees(_k text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN proof.val(format(
    'SELECT count(*) FROM storage.objects WHERE bucket_id = %L AND name = (SELECT name FROM proof.obj WHERE k = %L)',
    'invoices', _k));
END $$;
CREATE OR REPLACE FUNCTION proof.verwijder(_k text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN proof.try_rollback(format(
    'DELETE FROM storage.objects WHERE bucket_id = %L AND name = (SELECT name FROM proof.obj WHERE k = %L)',
    'invoices', _k));
END $$;
CREATE OR REPLACE FUNCTION proof.werkbij(_k text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN proof.try_rollback(format(
    'UPDATE storage.objects SET metadata = %L::jsonb WHERE bucket_id = %L AND name = (SELECT name FROM proof.obj WHERE k = %L)',
    '{"bijgewerkt": true}', 'invoices', _k));
END $$;
CREATE OR REPLACE FUNCTION proof.upload(_name text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN proof.try_rollback(format(
    'INSERT INTO storage.objects (bucket_id, name, owner) VALUES (%L, %L, auth.uid())', 'invoices', _name));
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO anon, authenticated, service_role;

-- ── organisaties, gebruikers, rollen ─────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'eigenaar@a.test'),
  ('a0000000-0000-4000-8000-000000000002', 'accountant@a.test'),
  ('a0000000-0000-4000-8000-000000000003', 'assistent@a.test'),
  ('a0000000-0000-4000-8000-000000000004', 'lezer@a.test'),
  ('a0000000-0000-4000-8000-000000000005', 'ex-medewerker@a.test'),
  ('a0000000-0000-4000-8000-000000000006', 'ex-medewerker-nu-b@a.test'),
  ('b0000000-0000-4000-8000-000000000001', 'eigenaar@b.test'),
  ('b0000000-0000-4000-8000-000000000002', 'assistent@b.test'),
  ('c0000000-0000-4000-8000-000000000001', 'vreemde@extern.test');

INSERT INTO public.organizations (id, name) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'Kantoor A'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'Kantoor B');

INSERT INTO public.organization_members (organization_id, user_id) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000002'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000003'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000004'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000005'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000006'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000006'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000002');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'owner'),
  ('a0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-00000000000a', 'accountant'),
  ('a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'assistant'),
  ('a0000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-00000000000a', 'read_only'),
  ('a0000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-00000000000a', 'assistant'),
  -- B2-08c: ex-medewerker van A die assistent blijft in B (pointer-aanval)
  ('a0000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-00000000000a', 'owner'),
  ('a0000000-0000-4000-8000-000000000006', 'bbbbbbbb-0000-4000-8000-00000000000b', 'assistant'),
  ('b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'owner'),
  ('b0000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-00000000000b', 'assistant');

-- ── administraties en grootboek ─────────────────────────────────────────────
INSERT INTO public.clients (id, user_id, organization_id, name) VALUES
  ('ca000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Klant A'),
  ('ca000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Klant A2 (wordt verwijderd)'),
  ('cb000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'Klant B');

INSERT INTO public.grootboekrekeningen (id, user_id, organization_id, client_id, nummer, omschrijving, categorie) VALUES
  ('9a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', NULL, 64401, 'Kosten A', 'kosten'),
  ('9a000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', NULL, 61601, 'Crediteuren A', 'passiva'),
  ('9a000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', NULL, 61521, 'Btw te vorderen A', 'activa'),
  ('9b000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', NULL, 64402, 'Kosten B', 'kosten');

UPDATE public.clients
SET crediteuren_rekening_id = '9a000000-0000-4000-8000-000000000002',
    btw_te_vorderen_rekening_id = '9a000000-0000-4000-8000-000000000003'
WHERE id = 'ca000000-0000-4000-8000-000000000001';

-- ── inkoopfacturen ───────────────────────────────────────────────────────────
INSERT INTO public.purchase_invoices
  (id, user_id, client_id, organization_id, supplier, invoice_number, invoice_date, amount_excl, btw_amount, amount_incl, btw_percentage, status, file_path, notes)
VALUES
  -- A1: document van de huidige assistent (uploader)
  ('2a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Leverancier 1', 'F-1', '2026-03-01', 100, 21, 121, 21, 'te_controleren', 'a0000000-0000-4000-8000-000000000003/ca000000-0000-4000-8000-000000000001/doc1.pdf', NULL),
  -- A2: document van de ex-medewerker
  ('2a000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000005', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Leverancier 2', 'F-2', '2026-03-02', 100, 21, 121, 21, 'te_controleren', 'a0000000-0000-4000-8000-000000000005/ca000000-0000-4000-8000-000000000001/doc2.pdf', NULL),
  -- A3: zonder regels (verhangen binnen A)
  ('2a000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Leverancier 3', 'F-3', '2026-03-03', 100, 21, 121, 21, 'te_controleren', NULL, NULL),
  -- A4/A5: om te verwijderen (na resp. vóór de migratie), elk met een vreemde regel
  ('2a000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Leverancier 4', 'F-4', '2026-03-04', 100, 21, 121, 21, 'te_controleren', NULL, NULL),
  ('2a000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Leverancier 5', 'F-5', '2026-03-05', 100, 21, 121, 21, 'te_controleren', NULL, NULL),
  -- W0/W1/W2: werkbank (A2-07)
  ('2a000000-0000-4000-8000-0000000000e0', 'a0000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Werkbank 0', 'W-0', '2026-04-01', 100, 21, 121, 21, 'te_controleren', NULL, 'oud'),
  ('2a000000-0000-4000-8000-0000000000e1', 'a0000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Werkbank 1', 'W-1', '2026-04-02', 100, 21, 121, 21, 'te_controleren', NULL, 'oud'),
  ('2a000000-0000-4000-8000-0000000000e2', 'a0000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Werkbank 2', 'W-2', '2026-04-03', 100, 21, 121, 21, 'te_controleren', NULL, 'oud'),
  -- X: bij de klant die verwijderd wordt
  ('2a000000-0000-4000-8000-0000000000c2', 'a0000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Leverancier X', 'F-X', '2026-03-06', 100, 21, 121, 21, 'te_controleren', NULL, NULL),
  -- P: boekbaar (B1-05: de schrijver moet na het intrekken blijven werken)
  ('2a000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Leverancier P', 'F-P', '2026-05-01', 100, 21, 121, 21, 'gecontroleerd', NULL, NULL),
  -- B1: document van organisatie B
  ('2b000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', 'cb000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b',
   'Leverancier B', 'B-1', '2026-03-01', 100, 21, 121, 21, 'te_controleren', 'b0000000-0000-4000-8000-000000000002/cb000000-0000-4000-8000-000000000001/doc3.pdf', NULL),
  -- A6: OCR-document (service role, owner NULL) van de ex-medewerker die nu in B zit (B2-08c)
  ('2a000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000006', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Leverancier 6', 'F-6', '2026-03-07', 100, 21, 121, 21, 'te_controleren', 'a0000000-0000-4000-8000-000000000006/ca000000-0000-4000-8000-000000000001/doc-ex.pdf', NULL),
  -- B2: een tweede factuur in B, voor de UPDATE-variant van de aanval
  ('2b000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'cb000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b',
   'Leverancier B2', 'B-2', '2026-03-02', 100, 21, 121, 21, 'te_controleren', NULL, NULL);

-- ── regels (vóór de migratie: geen trigger, geen FK) ─────────────────────────
INSERT INTO public.purchase_invoice_lines
  (id, purchase_invoice_id, user_id, organization_id, omschrijving, amount_excl, btw_percentage, grootboekrekening_id, sort_order)
VALUES
  ('8a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Regel A1', 100, 21, NULL, 0),
  ('8a000000-0000-4000-8000-000000000004', '2a000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Regel A4', 100, 21, NULL, 0),
  ('8a000000-0000-4000-8000-000000000005', '2a000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Regel A5', 100, 21, NULL, 0),
  ('8a000000-0000-4000-8000-0000000000e0', '2a000000-0000-4000-8000-0000000000e0', 'a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Regel W0', 100, 21, NULL, 0),
  ('8a000000-0000-4000-8000-0000000000e1', '2a000000-0000-4000-8000-0000000000e1', 'a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Regel W1', 100, 21, NULL, 0),
  ('8a000000-0000-4000-8000-0000000000c2', '2a000000-0000-4000-8000-0000000000c2', 'a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Regel X', 100, 21, NULL, 0),
  ('8a000000-0000-4000-8000-0000000000f1', '2a000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Regel P', 100, 21, '9a000000-0000-4000-8000-000000000001', 0),
  -- Een vreemde regel (organisatie B) die vóór de fix aan A4 en A5 is gehangen (A2-17).
  ('8b000000-0000-4000-8000-000000000004', '2a000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'Vreemd op A4', 1, 0, NULL, 99),
  ('8b000000-0000-4000-8000-000000000005', '2a000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'Vreemd op A5', 1, 0, NULL, 99),
  -- Een historische weesregel: de factuur bestaat niet (meer).
  ('8a000000-0000-4000-8000-0000000000dd', '2a000000-0000-4000-8000-0000000000dd', 'a0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Wees', 5, 21, NULL, 0);

-- ── verkoop ──────────────────────────────────────────────────────────────────
INSERT INTO public.sales_invoices
  (id, user_id, client_id, organization_id, customer_name, invoice_number, invoice_date, amount_excl, btw_amount, amount_incl, btw_percentage, status, pdf_path)
VALUES
  ('3a000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Afnemer A', 'V-1', '2026-03-01', 1000, 210, 1210, 21, 'concept', 'a0000000-0000-4000-8000-000000000003/sales/ca000000-0000-4000-8000-000000000001/s1.pdf'),
  -- handmatige verkoopupload van de latere ex-medewerker (owner = uid) (B2-08c)
  ('3a000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000006', 'ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'Afnemer A6', 'V-6', '2026-03-07', 1000, 210, 1210, 21, 'concept', 'a0000000-0000-4000-8000-000000000006/sales/ca000000-0000-4000-8000-000000000001/s-ex.pdf');

-- ── opslagobjecten zoals de app ze schrijft ──────────────────────────────────
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('invoices', 'a0000000-0000-4000-8000-000000000003/ca000000-0000-4000-8000-000000000001/doc1.pdf', NULL, NULL),
  ('invoices', 'a0000000-0000-4000-8000-000000000005/ca000000-0000-4000-8000-000000000001/doc2.pdf', NULL, NULL),
  ('invoices', 'a0000000-0000-4000-8000-000000000003/sales/ca000000-0000-4000-8000-000000000001/s1.pdf', 'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003'),
  ('invoices', 'b0000000-0000-4000-8000-000000000002/cb000000-0000-4000-8000-000000000001/doc3.pdf', NULL, NULL),
  -- wees-objecten: geen factuur verwijst ernaar
  ('invoices', 'a0000000-0000-4000-8000-000000000003/ca000000-0000-4000-8000-000000000001/wees.pdf', NULL, NULL),
  ('invoices', 'a0000000-0000-4000-8000-000000000005/ca000000-0000-4000-8000-000000000001/wees-ex.pdf', NULL, NULL),
  -- B2-08c: documenten van kantoor A van de ex-medewerker die nu in B zit
  ('invoices', 'a0000000-0000-4000-8000-000000000006/ca000000-0000-4000-8000-000000000001/doc-ex.pdf', NULL, NULL),
  ('invoices', 'a0000000-0000-4000-8000-000000000006/sales/ca000000-0000-4000-8000-000000000001/s-ex.pdf', 'a0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000006');

-- ── offboarding: de ex-medewerker verlaat kantoor A ─────────────────────────
DELETE FROM public.user_roles           WHERE user_id = 'a0000000-0000-4000-8000-000000000005';
DELETE FROM public.organization_members WHERE user_id = 'a0000000-0000-4000-8000-000000000005';
-- … en de tweede ex-medewerker verlaat alleen kantoor A (blijft assistent in B)
DELETE FROM public.user_roles           WHERE user_id = 'a0000000-0000-4000-8000-000000000006' AND organization_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
DELETE FROM public.organization_members WHERE user_id = 'a0000000-0000-4000-8000-000000000006' AND organization_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
