-- ─────────────────────────────────────────────────────────────────────────────
-- Bewijs: de directe schrijfdeur naar ledger_postings is dicht, en de writers
-- werken onverminderd.
--
-- Draait tegen een ECHTE PostgreSQL met de echte fundering, de echte
-- beginbalans-writer en de echte hardeningsmigratie. Zie run-proof.sh.
--
-- De vraag die dit harnas beantwoordt is niet "lijkt dit veilig" maar
-- "gedraagt de database zich zo". Daarom staat er bij elk bewijs een
-- verwachting op de fóút, niet alleen op het slagen.
-- ─────────────────────────────────────────────────────────────────────────────

SET client_min_messages = warning;

DROP SCHEMA IF EXISTS proof CASCADE;
CREATE SCHEMA proof;
GRANT USAGE ON SCHEMA proof TO public;

CREATE TABLE proof.result (
  n      text PRIMARY KEY,
  name   text NOT NULL,
  ok     boolean NOT NULL,
  detail text
);
GRANT INSERT, SELECT ON proof.result TO public;

CREATE OR REPLACE FUNCTION proof.expect_error(_n text, _name text, _sql text, _needle text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE _sql;
    INSERT INTO proof.result VALUES (_n, _name, false, 'GEEN fout, terwijl een fout werd verwacht');
  EXCEPTION WHEN OTHERS THEN
    IF position(lower(_needle) IN lower(SQLERRM)) > 0 THEN
      INSERT INTO proof.result VALUES (_n, _name, true, SQLERRM);
    ELSE
      INSERT INTO proof.result VALUES (_n, _name, false,
        format('andere fout dan verwacht (%s): %s', _needle, SQLERRM));
    END IF;
  END;
END $$;

CREATE OR REPLACE FUNCTION proof.expect_ok(_n text, _name text, _sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE _sql;
    INSERT INTO proof.result VALUES (_n, _name, true, 'uitgevoerd zonder fout');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO proof.result VALUES (_n, _name, false, format('onverwachte fout: %s', SQLERRM));
  END;
END $$;

CREATE OR REPLACE FUNCTION proof.expect_true(_n text, _name text, _sql text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v boolean;
BEGIN
  BEGIN
    EXECUTE _sql INTO v;
    INSERT INTO proof.result VALUES (_n, _name, coalesce(v, false), coalesce(v::text, 'NULL'));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO proof.result VALUES (_n, _name, false, format('onverwachte fout: %s', SQLERRM));
  END;
END $$;

-- Een concept-beginbalans klaarzetten, zodat de ECHTE writer iets te boeken heeft.
CREATE OR REPLACE FUNCTION proof.draft(_id uuid, _client uuid, _d date)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.opening_balances
    (id, organization_id, client_id, boekjaar, opening_date, description, user_id)
  VALUES (_id, '00000000-0000-0000-0000-0000000000a1', _client,
          EXTRACT(YEAR FROM _d)::int, _d, 'Beginbalans 2027',
          '00000000-0000-0000-0000-0000000000e1');
$$;

CREATE OR REPLACE FUNCTION proof.line(_ob uuid, _acc uuid, _d numeric, _c numeric, _n int)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.opening_balance_lines
    (opening_balance_id, organization_id, client_id, grootboekrekening_id,
     debit_amount, credit_amount, sort_order, user_id)
  SELECT _ob, '00000000-0000-0000-0000-0000000000a1', h.client_id, _acc, _d, _c, _n,
         '00000000-0000-0000-0000-0000000000e1'
  FROM public.opening_balances h WHERE h.id = _ob;
$$;

GRANT EXECUTE ON FUNCTION proof.draft(uuid, uuid, date) TO public;
GRANT EXECUTE ON FUNCTION proof.line(uuid, uuid, numeric, numeric, int) TO public;

-- Een SECURITY DEFINER-functie van dezelfde eigenaar als de tabel. Dit is het
-- MECHANISME waar alle vijf de writers op rusten; door het hier apart te
-- bewijzen geldt de uitkomst voor alle vijf, ook zonder hun volledige
-- brondocumentfixtures op te tuigen.
CREATE OR REPLACE FUNCTION proof.writer_insert(_group uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, user_id)
  VALUES
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2',
     '00000000-0000-0000-0000-00000000f001', _group, 1, DATE '2027-06-01', 2027, 5.00, 0, 'EUR',
     'manual_journal', '00000000-0000-0000-0000-0000000000e1'),
    ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2',
     '00000000-0000-0000-0000-00000000f002', _group, 2, DATE '2027-06-01', 2027, 0, 5.00, 'EUR',
     'manual_journal', '00000000-0000-0000-0000-0000000000e1');
$$;
GRANT EXECUTE ON FUNCTION proof.writer_insert(uuid) TO public;

-- ── vanaf hier: de applicatierol ────────────────────────────────────────────
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
SET ROLE authenticated;

-- 1 het privilege zelf ──────────────────────────────────────────────────────
SELECT proof.expect_true('1', 'authenticated heeft GEEN insert-recht meer op ledger_postings', $$
  SELECT NOT has_table_privilege('authenticated', 'public.ledger_postings', 'INSERT')
$$);

SELECT proof.expect_true('1b', 'authenticated houdt wél leesrecht', $$
  SELECT has_table_privilege('authenticated', 'public.ledger_postings', 'SELECT')
$$);

-- 2 de deur die openstond ───────────────────────────────────────────────────
SELECT proof.expect_error('2', 'een gewone directe INSERT wordt geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, user_id)
  VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f001', gen_random_uuid(), 1, DATE '2027-06-01', 2027, 1.00, 0, 'EUR',
    'manual_journal', '00000000-0000-0000-0000-0000000000e1')
$$, 'permission denied');

-- 3 het exacte gat uit de fase 0-inspectie: een verzonnen bronsoort ─────────
SELECT proof.expect_error('3', 'een ONBEKENDE bronsoort komt er evenmin door', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, user_id)
  VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f001', gen_random_uuid(), 1, DATE '2027-06-01', 2027, 1.00, 0, 'EUR',
    'correctie', '00000000-0000-0000-0000-0000000000e1')
$$, 'permission denied');

SELECT proof.expect_error('3b', 'ook een sluitend PAAR met verzonnen bronsoort komt er niet door', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, user_id)
  SELECT '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', g,
         '00000000-0000-0000-0000-0000000077f1'::uuid, n, DATE '2027-06-01', 2027, d, c, 'EUR',
         'reversal', '00000000-0000-0000-0000-0000000000e1'
  FROM (VALUES
    ('00000000-0000-0000-0000-00000000f001'::uuid, 1, 9.00::numeric, 0::numeric),
    ('00000000-0000-0000-0000-00000000f002'::uuid, 2, 0::numeric, 9.00::numeric)
  ) AS v(g, n, d, c)
$$, 'permission denied');

SELECT proof.expect_true('3c', 'en er staat na die pogingen geen enkele grootboekregel', $$
  SELECT count(*) = 0 FROM public.ledger_postings
$$);

-- 4 de vijf writers blijven werken ──────────────────────────────────────────
-- 4a het MECHANISME: een SECURITY DEFINER-functie van de tabel-eigenaar. Alle
--    vijf writers zijn precies dit; slaagt dit, dan slagen zij.
SELECT proof.expect_ok('4a', 'een SECURITY DEFINER-writer mag nog steeds boeken',
  $$SELECT proof.writer_insert('00000000-0000-0000-0000-0000000055f1')$$);

SELECT proof.expect_true('4b', 'die boeking staat er ook echt, in balans', $$
  SELECT count(*) = 2 AND sum(debit_amount) = sum(credit_amount)
  FROM public.ledger_postings WHERE posting_group_id = '00000000-0000-0000-0000-0000000055f1'
$$);

-- 4c de ECHTE beginbalans-writer, end-to-end.
SELECT proof.draft('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000c1', DATE '2027-01-01');
SELECT proof.line('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000f001', 1000.00, 0, 1);
SELECT proof.line('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000f002', 0, 1000.00, 2);
SELECT proof.expect_ok('4c', 'post_opening_balance() boekt onverminderd',
  $$SELECT public.post_opening_balance('00000000-0000-0000-0000-00000000b001')$$);

SELECT proof.expect_true('4d', 'en die beginbalans staat als sluitende groep in het grootboek', $$
  SELECT count(*) = 2 AND sum(debit_amount) = sum(credit_amount)
  FROM public.ledger_postings WHERE source_type = 'opening_balance'
$$);

-- 5 de bestaande append-only-grendels zijn onaangetast ──────────────────────
SELECT proof.expect_error('5a', 'UPDATE blijft geweigerd',
  $$UPDATE public.ledger_postings SET debit_amount = 1 WHERE true$$, 'permission denied');

SELECT proof.expect_error('5b', 'DELETE blijft geweigerd',
  $$DELETE FROM public.ledger_postings WHERE true$$, 'permission denied');

SELECT proof.expect_error('5c', 'TRUNCATE blijft geweigerd',
  $$TRUNCATE public.ledger_postings$$, 'permission denied');

-- 6 lezen blijft werken, en de tenantscheiding is ongemoeid ─────────────────
SELECT proof.expect_ok('6a', 'lezen blijft gewoon mogelijk',
  $$SELECT count(*) FROM public.ledger_postings$$);

SELECT proof.expect_true('6b', 'de leesvloer toont alleen de eigen organisatie', $$
  SELECT count(*) = 0 FROM public.ledger_postings
  WHERE organization_id <> '00000000-0000-0000-0000-0000000000a1'
$$);

RESET ROLE;

-- 7 de tenant-trigger werkt nog, ook voor een bevoorrechte schrijver ────────
SELECT proof.expect_error('7', 'een boeking met een administratie uit een andere organisatie wordt geweigerd', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, user_id)
  VALUES ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f001', gen_random_uuid(), 1, DATE '2027-06-01', 2027, 1.00, 0, 'EUR',
    'manual_journal', '00000000-0000-0000-0000-0000000000e1')
$$, 'organisatie');

-- 8 de rechtenkaart als geheel ──────────────────────────────────────────────
SELECT proof.expect_true('8a', 'anon heeft nergens recht op', $$
  SELECT NOT has_table_privilege('anon', 'public.ledger_postings', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.ledger_postings', 'INSERT')
$$);

SELECT proof.expect_true('8b', 'service_role behoudt INSERT — bewuste keuze, zie de migratie', $$
  SELECT has_table_privilege('service_role', 'public.ledger_postings', 'INSERT')
$$);

SELECT proof.expect_true('8c', 'geen enkele applicatierol mag wijzigen of verwijderen', $$
  SELECT NOT has_table_privilege('authenticated', 'public.ledger_postings', 'UPDATE')
     AND NOT has_table_privilege('authenticated', 'public.ledger_postings', 'DELETE')
     AND NOT has_table_privilege('service_role', 'public.ledger_postings', 'UPDATE')
     AND NOT has_table_privilege('service_role', 'public.ledger_postings', 'DELETE')
$$);

-- 9 het RLS-beleid blijft staan als vangnet onder het privilege ─────────────
SELECT proof.expect_true('9', 'het insert-beleid bestaat nog, als tweede laag', $$
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ledger_postings'
      AND policyname = 'role_ledger_postings_insert'
  )
$$);
