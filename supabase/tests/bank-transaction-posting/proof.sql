-- REAL POSTGRESQL PROOF for post_bank_transaction() — THROWAWAY cluster only.
-- Never run this against any BoekAssist database. See run-proof.sh.
--
-- Twee soorten beweringen staan hier naast elkaar:
--   • de BOEKING: welke regels ontstaan er precies, met welke bedragen, op
--     welke rekening en aan welke zijde — nagerekend, niet aangenomen;
--   • de POORT: wie mag wat, en welke fout krijgt iemand die niets mag. Voor
--     de tenantpoort wordt de VOLLEDIGE foutidentiteit vergeleken (SQLSTATE
--     én boodschap), want de hele claim is dat twee situaties
--     ononderscheidbaar zijn.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ── resultaatverzameling ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proof.result (
  n      text,
  name   text,
  ok     boolean,
  detail text
);
GRANT INSERT, SELECT ON proof.result TO public;

CREATE OR REPLACE FUNCTION proof.expect_error(_n text, _name text, _sql text, _needle text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_msg text;
BEGIN
  BEGIN
    EXECUTE _sql;
    INSERT INTO proof.result VALUES (_n, _name, false, 'GEEN fout, terwijl een fout werd verwacht');
    RETURN;
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;
  IF position(lower(_needle) IN lower(v_msg)) > 0 THEN
    INSERT INTO proof.result VALUES (_n, _name, true, v_msg);
  ELSE
    INSERT INTO proof.result VALUES (_n, _name, false, format('andere fout dan verwacht (%s): %s', _needle, v_msg));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION proof.expect_ok(_n text, _name text, _sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE _sql;
  INSERT INTO proof.result VALUES (_n, _name, true, 'uitgevoerd zonder fout');
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('onverwachte fout: %s', SQLERRM));
END $$;

CREATE OR REPLACE FUNCTION proof.expect_true(_n text, _name text, _expr text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  EXECUTE format('SELECT (%s)', _expr) INTO v_ok;
  INSERT INTO proof.result VALUES (_n, _name, COALESCE(v_ok, false), COALESCE(v_ok::text, 'NULL'));
EXCEPTION WHEN others THEN
  INSERT INTO proof.result VALUES (_n, _name, false, format('fout bij evaluatie: %s', SQLERRM));
END $$;

/*
 * De VOLLEDIGE identiteit van een fout: SQLSTATE én de hele boodschap.
 * Voor de tenantpoort is een substringvergelijking niet genoeg — de claim is
 * dat twee antwoorden letterlijk hetzelfde zijn.
 */
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

GRANT EXECUTE ON FUNCTION proof.expect_error(text, text, text, text) TO public;
GRANT EXECUTE ON FUNCTION proof.expect_ok(text, text, text) TO public;
GRANT EXECUTE ON FUNCTION proof.expect_true(text, text, text) TO public;
GRANT EXECUTE ON FUNCTION proof.identity(text) TO public;

/* Eén regel van een boeking uitlezen: rekeningnummer, debet en credit. */
CREATE OR REPLACE FUNCTION proof.line(_group uuid, _line_no integer)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT format('%s|%s|%s', g.nummer, lp.debit_amount, lp.credit_amount)
  FROM public.ledger_postings lp
  JOIN public.grootboekrekeningen g ON g.id = lp.grootboekrekening_id
  WHERE lp.posting_group_id = _group AND lp.line_no = _line_no;
$$;
GRANT EXECUTE ON FUNCTION proof.line(uuid, integer) TO public;

/* De boekingsgroep van een banktransactie, uit de marker. */
CREATE OR REPLACE FUNCTION proof.group_of(_tx uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT posting_group_id FROM public.bank_transaction_postings WHERE bank_transaction_id = _tx;
$$;
GRANT EXECUTE ON FUNCTION proof.group_of(uuid) TO public;

/*
 * Het werkelijke aantal bankregels in het grootboek, langs RLS heen.
 * Nodig omdat "het grootboek is niet gegroeid" een uitspraak is over de TABEL,
 * niet over wat één rol toevallig mag zien: een momentopname als eigenaar en
 * een telling als `authenticated` zouden anders verschillen zodra er een rij
 * van een andere organisatie in staat.
 */
CREATE OR REPLACE FUNCTION proof.bank_row_count()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*) FROM public.ledger_postings WHERE source_type = 'bank_transaction';
$$;
GRANT EXECUTE ON FUNCTION proof.bank_row_count() TO public;

-- ── banktransacties klaarzetten (als eigenaar, dus gecommit) ────────────────
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-0000000000c1', -100.00, NULL);   -- uitgaand, geen BTW
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-0000000000c1',  250.00, NULL,
                     '00000000-0000-0000-0000-00000000f005');                                                          -- inkomend, geen BTW
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-0000000000c1', -109.00, 9);      -- uitgaand 9%
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-0000000000c1', -121.00, 21);     -- uitgaand 21%
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000105', '00000000-0000-0000-0000-0000000000c1',  218.00, 9,
                     '00000000-0000-0000-0000-00000000f005');                                                          -- inkomend 9%
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000106', '00000000-0000-0000-0000-0000000000c1',  242.00, 21,
                     '00000000-0000-0000-0000-00000000f005');                                                          -- inkomend 21%
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000107', '00000000-0000-0000-0000-0000000000c1', -100.00, 21);     -- afronding
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000108', '00000000-0000-0000-0000-0000000000c1', -50.00, NULL);    -- dubbel boeken
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000109', '00000000-0000-0000-0000-0000000000c1', -75.00, NULL);    -- atomiciteit
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000110', '00000000-0000-0000-0000-0000000000c9', -60.00, NULL,
                     '00000000-0000-0000-0000-00000000f009');                                                          -- andere organisatie
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000111', '00000000-0000-0000-0000-0000000000c1', -40.00, NULL);    -- rolvloer

-- ══ vanaf hier: de applicatierol ═══════════════════════════════════════════
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
SET ROLE authenticated;

-- ── 1/2  zonder BTW: precies twee regels, exact de juiste zijden ────────────

SELECT proof.expect_ok('1', 'uitgaand zonder BTW wordt geboekt',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000101')$$);

SELECT proof.expect_true('1a', 'uitgaand zonder BTW: 4400 debet 100,00 en 1200 credit 100,00, meer niet', $$
  SELECT proof.line(proof.group_of('00000000-0000-0000-0000-000000000101'), 1) = '4400|100.00|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000101'), 2) = '1200|0.00|100.00'
     AND (SELECT count(*) FROM public.ledger_postings
          WHERE posting_group_id = proof.group_of('00000000-0000-0000-0000-000000000101')) = 2
$$);

SELECT proof.expect_ok('2', 'inkomend zonder BTW wordt geboekt',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000102')$$);

SELECT proof.expect_true('2a', 'inkomend zonder BTW: 1200 debet 250,00 en 8000 credit 250,00, meer niet', $$
  SELECT proof.line(proof.group_of('00000000-0000-0000-0000-000000000102'), 1) = '1200|250.00|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000102'), 2) = '8000|0.00|250.00'
     AND (SELECT count(*) FROM public.ledger_postings
          WHERE posting_group_id = proof.group_of('00000000-0000-0000-0000-000000000102')) = 2
$$);

-- ── 3/4  uitgaand met BTW: netto debet, BTW te vorderen debet, bank credit ──

SELECT proof.expect_ok('3', 'uitgaand 9% wordt geboekt',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000103')$$);

SELECT proof.expect_true('3a', 'uitgaand 9%: 4400 debet 100,00 · 1680 debet 9,00 · 1200 credit 109,00', $$
  SELECT proof.line(proof.group_of('00000000-0000-0000-0000-000000000103'), 1) = '4400|100.00|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000103'), 2) = '1680|9.00|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000103'), 3) = '1200|0.00|109.00'
$$);

SELECT proof.expect_ok('4', 'uitgaand 21% wordt geboekt',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000104')$$);

SELECT proof.expect_true('4a', 'uitgaand 21%: 4400 debet 100,00 · 1680 debet 21,00 · 1200 credit 121,00', $$
  SELECT proof.line(proof.group_of('00000000-0000-0000-0000-000000000104'), 1) = '4400|100.00|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000104'), 2) = '1680|21.00|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000104'), 3) = '1200|0.00|121.00'
$$);

-- ── 5/6  inkomend met BTW: bank debet, netto credit, BTW te betalen credit ──

SELECT proof.expect_ok('5', 'inkomend 9% wordt geboekt',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000105')$$);

SELECT proof.expect_true('5a', 'inkomend 9%: 1200 debet 218,00 · 8000 credit 200,00 · 1670 credit 18,00', $$
  SELECT proof.line(proof.group_of('00000000-0000-0000-0000-000000000105'), 1) = '1200|218.00|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000105'), 2) = '8000|0.00|200.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000105'), 3) = '1670|0.00|18.00'
$$);

SELECT proof.expect_ok('6', 'inkomend 21% wordt geboekt',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000106')$$);

SELECT proof.expect_true('6a', 'inkomend 21%: 1200 debet 242,00 · 8000 credit 200,00 · 1670 credit 42,00', $$
  SELECT proof.line(proof.group_of('00000000-0000-0000-0000-000000000106'), 1) = '1200|242.00|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000106'), 2) = '8000|0.00|200.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000106'), 3) = '1670|0.00|42.00'
$$);

-- ── 7  afronding op de cent ─────────────────────────────────────────────────
-- 100,00 bruto bij 21%: netto = round(100 / 1,21; 2) = 82,64 en BTW = 17,36.
-- Netto + BTW moet exact het brutobedrag zijn, anders sluit de groep niet.

SELECT proof.expect_ok('7', 'een bedrag dat niet rond deelt wordt geboekt',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000107')$$);

SELECT proof.expect_true('7a', 'afronding: 82,64 netto + 17,36 BTW = 100,00 bruto, tot op de cent', $$
  SELECT proof.line(proof.group_of('00000000-0000-0000-0000-000000000107'), 1) = '4400|82.64|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000107'), 2) = '1680|17.36|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000107'), 3) = '1200|0.00|100.00'
$$);

SELECT proof.expect_true('7b', 'elke geboekte groep sluit: debet gelijk aan credit', $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.ledger_postings
    WHERE source_type = 'bank_transaction'
    GROUP BY posting_group_id
    HAVING sum(debit_amount) <> sum(credit_amount) OR sum(debit_amount) <= 0
  )
$$);

SELECT proof.expect_true('7c', 'de marker legt bruto, netto en BTW vast zoals geboekt', $$
  SELECT (SELECT gross_amount = 100.00 AND net_amount = 82.64 AND btw_amount = 17.36 AND btw_percentage = 21
          FROM public.bank_transaction_postings
          WHERE bank_transaction_id = '00000000-0000-0000-0000-000000000107')
$$);

-- ── 8  de banktransactie zelf is niet aangeraakt ────────────────────────────

SELECT proof.expect_true('8', 'de oorspronkelijke banktransactie is onveranderd', $$
  SELECT (SELECT amount = -100.00 AND transaction_date = DATE '2027-03-01'
              AND match_status = 'handmatig_geboekt'
              AND grootboekrekening_id = '00000000-0000-0000-0000-00000000f002'
              AND btw_percentage IS NULL
          FROM public.bank_transactions WHERE id = '00000000-0000-0000-0000-000000000101')
$$);

-- ── 9  marker en grootboekregels horen bij elkaar ───────────────────────────

SELECT proof.expect_true('9', 'elke marker heeft grootboekregels en elke bankregel heeft een marker', $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.bank_transaction_postings m
    WHERE NOT EXISTS (SELECT 1 FROM public.ledger_postings lp
                      WHERE lp.posting_group_id = m.posting_group_id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.ledger_postings lp
    WHERE lp.source_type = 'bank_transaction'
      AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                      WHERE m.posting_group_id = lp.posting_group_id)
  )
$$);

-- ── 11  twee keer boeken kan niet ───────────────────────────────────────────

SELECT proof.expect_ok('11a', 'de eerste boeking slaagt',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000108')$$);

SELECT proof.expect_error('11b', 'een tweede boeking van dezelfde bankregel wordt geweigerd',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000108')$$,
  'al geboekt');

SELECT proof.expect_true('11c', 'er staat precies één marker en één boekingsgroep', $$
  SELECT (SELECT count(*) FROM public.bank_transaction_postings
          WHERE bank_transaction_id = '00000000-0000-0000-0000-000000000108') = 1
     AND (SELECT count(*) FROM public.ledger_postings
          WHERE posting_group_id = proof.group_of('00000000-0000-0000-0000-000000000108')) = 2
$$);

-- ── 13/14  DE TENANTPOORT ───────────────────────────────────────────────────
-- De kern van deze correctie. Niet op substring maar op de volledige
-- foutidentiteit: dezelfde SQLSTATE én dezelfde boodschap.

SELECT proof.expect_true('13', 'een onbekende banktransactie geeft exact 42501 | Banktransactie niet beschikbaar', $$
  SELECT proof.identity($q$SELECT public.post_bank_transaction('00000000-0000-0000-0000-0000000009ff')$q$)
       = '42501 | Banktransactie niet beschikbaar'
$$);

SELECT proof.expect_true('14', 'een banktransactie van een andere organisatie geeft exact dezelfde fout', $$
  SELECT proof.identity($q$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000110')$q$)
       = '42501 | Banktransactie niet beschikbaar'
$$);

SELECT proof.expect_true('14a', 'en die twee antwoorden zijn letterlijk niet van elkaar te onderscheiden', $$
  SELECT proof.identity($q$SELECT public.post_bank_transaction('00000000-0000-0000-0000-0000000009ff')$q$)
       = proof.identity($q$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000110')$q$)
$$);

SELECT proof.expect_true('14b', 'de boodschap noemt geen organisatie, administratie, bedrag of datum', $$
  SELECT proof.identity($q$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000110')$q$)
         !~* '(organisatie|administratie|rekening|bedrag|[0-9]{4}-[0-9]{2}-[0-9]{2})'
$$);

SELECT proof.expect_true('14c', 'er is niets van die andere organisatie geboekt', $$
  SELECT NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings
                     WHERE bank_transaction_id = '00000000-0000-0000-0000-000000000110')
$$);

-- De rolvloer zelf is ongewijzigd: wie de leesdrempel haalt maar geen
-- assistant is, krijgt een eerlijk antwoord — die mag de rij onder RLS toch al
-- zien, dus dat verraadt niets nieuws.
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);

SELECT proof.expect_true('14d', 'een read_only-gebruiker in de eigen organisatie krijgt het rolantwoord', $$
  SELECT proof.identity($q$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000111')$q$)
       = '42501 | Geen rechten om te boeken voor deze organisatie'
$$);

SELECT proof.expect_true('14e', 'maar over een vreemde organisatie hoort ook hij niets', $$
  SELECT proof.identity($q$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000110')$q$)
       = '42501 | Banktransactie niet beschikbaar'
$$);

-- Een assistant van de ANDERE organisatie mag zijn eigen bankregel wél boeken:
-- zonder dit bewijs zou de generieke fout ook kunnen betekenen dat de poort
-- iedereen buitensluit.
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e4', false);
SELECT proof.expect_ok('14f', 'de assistant van organisatie B boekt zijn eigen bankregel gewoon',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000110')$$);

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT set_config('test.user_id', '', false);
SELECT proof.expect_true('14h', 'zonder ingelogde gebruiker: 28000 Niet ingelogd, vóór elke andere controle', $$
  SELECT proof.identity($q$SELECT public.post_bank_transaction('00000000-0000-0000-0000-0000000009ff')$q$)
       = '28000 | Niet ingelogd'
$$);
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- ── 15/16  de markertabel is niet schrijfbaar ───────────────────────────────

SELECT proof.expect_error('15a', 'authenticated kan geen marker invoegen', $$
  INSERT INTO public.bank_transaction_postings (
    bank_transaction_id, posting_group_id, organization_id, client_id,
    grootboekrekening_id, posting_date, boekjaar, gross_amount, net_amount, btw_amount, user_id)
  VALUES ('00000000-0000-0000-0000-000000000109', gen_random_uuid(),
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f002', DATE '2027-03-01', 2027, 1, 1, 0,
    '00000000-0000-0000-0000-0000000000e1')
$$, 'permission denied');

SELECT proof.expect_error('15b', 'authenticated kan geen marker verwijderen',
  $$DELETE FROM public.bank_transaction_postings WHERE true$$, 'permission denied');

SELECT proof.expect_error('15c', 'authenticated kan geen marker wijzigen',
  $$UPDATE public.bank_transaction_postings SET gross_amount = 1 WHERE true$$, 'permission denied');

SELECT proof.expect_true('15d', 'authenticated mag de marker wél lezen', $$
  SELECT has_table_privilege('authenticated', 'public.bank_transaction_postings', 'SELECT')
$$);

SELECT proof.expect_true('16', 'service_role mag de marker lezen en verder niets; anon niets', $$
  SELECT     has_table_privilege('service_role', 'public.bank_transaction_postings', 'SELECT')
     AND NOT has_table_privilege('service_role', 'public.bank_transaction_postings', 'INSERT')
     AND NOT has_table_privilege('service_role', 'public.bank_transaction_postings', 'UPDATE')
     AND NOT has_table_privilege('service_role', 'public.bank_transaction_postings', 'DELETE')
     AND NOT has_table_privilege('authenticated', 'public.bank_transaction_postings', 'INSERT')
     AND NOT has_table_privilege('authenticated', 'public.bank_transaction_postings', 'UPDATE')
     AND NOT has_table_privilege('authenticated', 'public.bank_transaction_postings', 'DELETE')
     AND NOT has_table_privilege('anon', 'public.bank_transaction_postings', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.bank_transaction_postings', 'INSERT')
$$);

-- ── 17/18/19  de rechten op de schrijver ────────────────────────────────────

SELECT proof.expect_true('17', 'anon mag de schrijver niet aanroepen', $$
  SELECT NOT has_function_privilege('anon', 'public.post_bank_transaction(uuid)', 'EXECUTE')
$$);

SELECT proof.expect_true('18', 'service_role mag de schrijver niet aanroepen', $$
  SELECT NOT has_function_privilege('service_role', 'public.post_bank_transaction(uuid)', 'EXECUTE')
$$);

SELECT proof.expect_true('19', 'authenticated mag de schrijver wél aanroepen', $$
  SELECT has_function_privilege('authenticated', 'public.post_bank_transaction(uuid)', 'EXECUTE')
$$);

SELECT proof.expect_true('19a', 'PUBLIC heeft geen enkel recht op de schrijver', $$
  SELECT NOT has_function_privilege('public', 'public.post_bank_transaction(uuid)', 'EXECUTE')
$$);

-- ── 20  de directe schrijfdeur naar het grootboek blijft dicht ──────────────

-- Het aantal grootboekregels vastleggen, zodat "niet gegroeid" een echte
-- vergelijking is en geen hardgecodeerd getal dat bij elke nieuwe proef
-- opnieuw moet worden bijgesteld.
RESET ROLE;
CREATE TABLE IF NOT EXISTS proof.ledger_count_before AS SELECT proof.bank_row_count() AS n;
GRANT SELECT ON proof.ledger_count_before TO public;
SET ROLE authenticated;

SELECT proof.expect_error('20a', 'authenticated kan niet rechtstreeks in ledger_postings schrijven', $$
  INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id, posting_group_id,
    line_no, posting_date, boekjaar, debit_amount, credit_amount, currency, source_type, source_id, user_id)
  VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-00000000f002', gen_random_uuid(), 1, DATE '2027-03-01', 2027, 1.00, 0, 'EUR',
    'bank_transaction', '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-0000000000e1')
$$, 'permission denied');

SELECT proof.expect_true('20b', 'en het grootboek is daardoor niet gegroeid', $$
  SELECT proof.bank_row_count() = (SELECT n FROM proof.ledger_count_before)
$$);

-- ── 10  atomiciteit: een geforceerde mislukking ná de marker ────────────────
-- Een echte fout midden in de functie, na de marker-INSERT en na de eerste
-- grootboekregel. Een trigger die op de tweede regel afgaat is de enige manier
-- om dat af te dwingen; hij wordt meteen daarna weer verwijderd.

RESET ROLE;

CREATE OR REPLACE FUNCTION proof.fail_on_second_bank_row()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type = 'bank_transaction'
     AND EXISTS (SELECT 1 FROM public.ledger_postings
                 WHERE posting_group_id = NEW.posting_group_id) THEN
    RAISE EXCEPTION 'proof: geforceerde mislukking op de tweede bankregel';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER zz_proof_fail_bank_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION proof.fail_on_second_bank_row();

SET ROLE authenticated;
SELECT proof.expect_error('10a', 'een mislukking na de marker laat de hele boeking mislukken',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000109')$$,
  'geforceerde mislukking');
RESET ROLE;

DROP TRIGGER zz_proof_fail_bank_trigger ON public.ledger_postings;

SELECT proof.expect_true('10b', 'er is GEEN marker achtergebleven', $$
  SELECT NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings
                     WHERE bank_transaction_id = '00000000-0000-0000-0000-000000000109')
$$);

SELECT proof.expect_true('10c', 'en er is GEEN halve boeking achtergebleven', $$
  SELECT (SELECT count(*) FROM public.ledger_postings WHERE source_id = '00000000-0000-0000-0000-000000000109') = 0
$$);

SET ROLE authenticated;
SELECT proof.expect_ok('10d', 'en na het opheffen van de storing slaagt de boeking alsnog',
  $$SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000109')$$);

SELECT proof.expect_true('10e', 'precies één marker en twee grootboekregels', $$
  SELECT (SELECT count(*) FROM public.bank_transaction_postings
          WHERE bank_transaction_id = '00000000-0000-0000-0000-000000000109') = 1
     AND (SELECT count(*) FROM public.ledger_postings
          WHERE source_id = '00000000-0000-0000-0000-000000000109') = 2
$$);

RESET ROLE;
