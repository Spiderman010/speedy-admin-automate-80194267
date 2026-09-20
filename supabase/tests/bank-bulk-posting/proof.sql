-- REAL POSTGRESQL PROOF for the bank bulk layer — THROWAWAY cluster only.
-- Never run this against any BoekAssist database. See run-proof.sh.
--
-- Wat hier bewezen wordt, is NIET de boekhouding zelf: die is van
-- post_bank_transaction() en is bewezen in ../bank-transaction-posting/ (53
-- bewijzen). Hier gaat het om de laag erboven:
--
--   • dat de bulk de boeking werkelijk aan die schrijver overlaat — letterlijk
--     dezelfde regels als een enkelvoudige boeking;
--   • dat één weigering midden in een partij de rest niet meesleept;
--   • dat een geweigerde regel geen spoor achterlaat en niet stilletjes
--     opnieuw wordt geprobeerd;
--   • dat dubbele id's, herhaalde partijen en gelijktijdigheid nooit twee
--     boekingen opleveren;
--   • dat een vreemde en een niet-bestaande id niet van elkaar te
--     onderscheiden zijn;
--   • en dat de preflight leest en verder niets doet.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ── stamgegevens die dit bewijs zelf nodig heeft ────────────────────────────
-- Een tweede administratie in org A met een AFGESLOTEN boekjaar, zodat de
-- afsluiting van één administratie de andere proeven niet raakt.

INSERT INTO public.clients (id, organization_id, name, afgesloten_boekjaar) VALUES
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'Klant 2 (2027 afgesloten)', 2027);

UPDATE public.clients SET
  bank_rekening_id            = '00000000-0000-0000-0000-00000000f001',
  btw_te_vorderen_rekening_id = '00000000-0000-0000-0000-00000000f003',
  btw_te_betalen_rekening_id  = '00000000-0000-0000-0000-00000000f004'
WHERE id = '00000000-0000-0000-0000-0000000000c2';

-- Een administratie zonder bankrekening, voor de preflightclassificatie.
INSERT INTO public.clients (id, organization_id, name) VALUES
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'Klant 3 (geen bankrekening)');

-- Een aparte administratie voor de kunstmatige mislukking hieronder. Die
-- bankregel is voor de preflight in alle opzichten `ready` — alleen het
-- testdubbel laat hem struikelen — en zou in de administratie van de andere
-- proeven een valse tegenspraak opleveren.
INSERT INTO public.clients (id, organization_id, name) VALUES
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'Klant 4 (kunstmatige mislukking)');

UPDATE public.clients SET
  bank_rekening_id            = '00000000-0000-0000-0000-00000000f001',
  btw_te_vorderen_rekening_id = '00000000-0000-0000-0000-00000000f003',
  btw_te_betalen_rekening_id  = '00000000-0000-0000-0000-00000000f004'
WHERE id = '00000000-0000-0000-0000-0000000000c4';

-- ── de kunstmatige mislukking, voor "geen stille herkansing" ────────────────
-- Een teller die een terugdraaiing OVERLEEFT (nextval is niet
-- transactioneel), plus een trigger die uitsluitend voor één id afgaat. Zo is
-- achteraf te tellen hoe vaak de schrijver werkelijk is aangeroepen.

CREATE SEQUENCE IF NOT EXISTS proof.poison_attempts;
GRANT USAGE, SELECT ON SEQUENCE proof.poison_attempts TO public;

CREATE OR REPLACE FUNCTION proof.poison_marker()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bank_transaction_id = '00000000-0000-0000-0000-000000000399' THEN
    PERFORM nextval('proof.poison_attempts');
    RAISE EXCEPTION 'kunstmatige mislukking ná de claim' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER proof_poison_marker_trigger
  BEFORE INSERT ON public.bank_transaction_postings
  FOR EACH ROW EXECUTE FUNCTION proof.poison_marker();

-- ── de bankregels ───────────────────────────────────────────────────────────

SELECT proof.seed_tx('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-0000000000c1', -121.00, 21);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-0000000000c1',  -30.00, NULL);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-0000000000c1', 1210.00, 21);

-- het ijkpunt: exact dezelfde regel als 301, maar enkelvoudig geboekt
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-0000000000c1', -121.00, 21);

SELECT proof.seed_tx('00000000-0000-0000-0000-000000000311', '00000000-0000-0000-0000-0000000000c1',  -55.00, NULL);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000312', '00000000-0000-0000-0000-0000000000c1',  -66.00, NULL, NULL);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000313', '00000000-0000-0000-0000-0000000000c1',  -77.00, NULL);

SELECT proof.seed_tx('00000000-0000-0000-0000-000000000314', '00000000-0000-0000-0000-0000000000c1',  -88.00, NULL);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000315', '00000000-0000-0000-0000-0000000000c1',  -99.00, NULL);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000316', '00000000-0000-0000-0000-0000000000c1', -100.00, NULL);

SELECT proof.seed_tx('00000000-0000-0000-0000-000000000320', '00000000-0000-0000-0000-0000000000c1', -111.00, NULL);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000321', '00000000-0000-0000-0000-0000000000c1', -222.00, NULL);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000323', '00000000-0000-0000-0000-0000000000c2', -333.00, NULL,
                     '00000000-0000-0000-0000-00000000f002', 'handmatig_geboekt', DATE '2027-03-01');
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000324', '00000000-0000-0000-0000-0000000000c1', -444.00, NULL,
                     '00000000-0000-0000-0000-00000000f002', 'niet_gematcht');

-- van een ANDERE organisatie; de aanroeper mag hier niets van weten
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000330', '00000000-0000-0000-0000-0000000000c9', -121.00, NULL,
                     '00000000-0000-0000-0000-00000000f009');

SELECT proof.seed_tx('00000000-0000-0000-0000-000000000399', '00000000-0000-0000-0000-0000000000c4', -123.00, NULL);

-- voor de preflight; 343 en 344 blijven bewust tot het eind ongeboekt, zodat
-- proef 27 een echte `ready`-voorraad heeft om op af te gaan
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000343', '00000000-0000-0000-0000-0000000000c1', -70.00, 9);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000344', '00000000-0000-0000-0000-0000000000c1', -80.00, NULL);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000341', '00000000-0000-0000-0000-0000000000c3', -50.00, NULL);
SELECT proof.seed_tx('00000000-0000-0000-0000-000000000342', '00000000-0000-0000-0000-0000000000c1', -60.00, NULL,
                     '00000000-0000-0000-0000-00000000f002', 'handmatig_geboekt', DATE '2026-05-05');

-- een aflettering op 321
INSERT INTO public.bank_transaction_allocations
  (bank_transaction_id, organization_id, client_id, invoice_id, invoice_type, amount, user_id)
VALUES
  ('00000000-0000-0000-0000-000000000321', '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-0000000000c1', gen_random_uuid(), 'inkoop', 222.00,
   '00000000-0000-0000-0000-0000000000e1');

-- ═══════════════════════════════════════════════════════════════════════════
--  Vanaf hier spreekt de aanroeper: een assistant van organisatie A.
-- ═══════════════════════════════════════════════════════════════════════════

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
SET ROLE authenticated;

-- ── 1. een partij van drie geldige regels levert drie boekingsgroepen ───────

SELECT proof.expect_true('1a', 'een partij van drie geldige bankregels wordt geheel geboekt', $$
  SELECT proof.bulk_shape(ARRAY[
    '00000000-0000-0000-0000-000000000301',
    '00000000-0000-0000-0000-000000000302',
    '00000000-0000-0000-0000-000000000303']::uuid[])
  = '1|posted|true 2|posted|true 3|posted|true'
$$);

SELECT proof.expect_true('1b', 'en dat zijn drie verschillende boekingsgroepen', $$
  SELECT count(DISTINCT posting_group_id) = 3 AND count(*) = 3
  FROM public.bank_transaction_postings
  WHERE bank_transaction_id IN (
    '00000000-0000-0000-0000-000000000301',
    '00000000-0000-0000-0000-000000000302',
    '00000000-0000-0000-0000-000000000303')
$$);

-- ── 2. de boekhouding komt onveranderd van post_bank_transaction() ──────────

SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000304');

SELECT proof.expect_true('2a', 'de regels uit de bulk zijn letterlijk gelijk aan die van een enkelvoudige boeking', $$
  SELECT (SELECT string_agg(proof.line(proof.group_of('00000000-0000-0000-0000-000000000301'), n), ' ' ORDER BY n)
          FROM generate_series(1, 3) n)
       = (SELECT string_agg(proof.line(proof.group_of('00000000-0000-0000-0000-000000000304'), n), ' ' ORDER BY n)
          FROM generate_series(1, 3) n)
$$);

SELECT proof.expect_true('2b', 'en die regels zijn de bekende drie: 4400 debet 100,00 / 1680 debet 21,00 / 1200 credit 121,00', $$
  SELECT proof.line(proof.group_of('00000000-0000-0000-0000-000000000301'), 1) = '4400|100.00|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000301'), 2) = '1680|21.00|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000301'), 3) = '1200|0.00|121.00'
$$);

SELECT proof.expect_true('2c', 'inkomend geld houdt zijn eigen richting: bank debet, rekening credit', $$
  SELECT proof.line(proof.group_of('00000000-0000-0000-0000-000000000303'), 1) = '1200|1210.00|0.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000303'), 2) = '4400|0.00|1000.00'
     AND proof.line(proof.group_of('00000000-0000-0000-0000-000000000303'), 3) = '1670|0.00|210.00'
$$);

-- ── 3. één ongeldige regel tussen twee geldige ──────────────────────────────

SELECT proof.expect_true('3a', 'geldig - ONGELDIG - geldig: de buren worden geboekt, de middelste geweigerd', $$
  SELECT proof.bulk_shape(ARRAY[
    '00000000-0000-0000-0000-000000000311',
    '00000000-0000-0000-0000-000000000312',
    '00000000-0000-0000-0000-000000000313']::uuid[])
  = '1|posted|true 2|rejected|false 3|posted|true'
$$);

SELECT proof.expect_true('3b', 'de twee geldige regels staan er ná afloop werkelijk', $$
  SELECT proof.marker_count('00000000-0000-0000-0000-000000000311') = 1
     AND proof.marker_count('00000000-0000-0000-0000-000000000313') = 1
$$);

-- ── 4. een geweigerde regel laat geen enkel spoor na ────────────────────────

SELECT proof.expect_true('4a', 'de geweigerde regel heeft geen marker', $$
  SELECT proof.marker_count('00000000-0000-0000-0000-000000000312') = 0
$$);

SELECT proof.expect_true('4b', 'en geen enkele grootboekregel', $$
  SELECT proof.ledger_count('00000000-0000-0000-0000-000000000312') = 0
$$);

SELECT proof.expect_true('4c', 'de weigering noemt de werkelijke reden van de schrijver', $$
  SELECT proof.bulk_identity(ARRAY['00000000-0000-0000-0000-000000000312']::uuid[])
       = 'rejected | 22023 | Deze banktransactie heeft nog geen grootboekrekening'
$$);

-- ── 5. een dubbele id binnen dezelfde partij ────────────────────────────────

SELECT proof.expect_true('5a', 'dezelfde id twee keer in één partij levert één resultaatrij op', $$
  SELECT proof.bulk_shape(ARRAY[
    '00000000-0000-0000-0000-000000000314',
    '00000000-0000-0000-0000-000000000314']::uuid[])
  = '1|posted|true'
$$);

SELECT proof.expect_true('5b', 'en precies één marker en één boekingsgroep', $$
  SELECT proof.marker_count('00000000-0000-0000-0000-000000000314') = 1
     AND (SELECT count(DISTINCT posting_group_id) FROM public.ledger_postings
          WHERE source_id = '00000000-0000-0000-0000-000000000314') = 1
$$);

-- ── 6. een tweede, opeenvolgende partij met dezelfde id's ───────────────────

SELECT proof.expect_true('6a', 'een herhaalde partij meldt al-geboekt in plaats van te mislukken', $$
  SELECT proof.bulk_shape(ARRAY[
    '00000000-0000-0000-0000-000000000301',
    '00000000-0000-0000-0000-000000000302']::uuid[])
  = '1|already_posted|true 2|already_posted|true'
$$);

SELECT proof.expect_true('6b', 'en noemt dezelfde boekingsgroep als de eerste ronde', $$
  SELECT (SELECT r.posting_group_id
          FROM public.post_bank_transactions_bulk(ARRAY['00000000-0000-0000-0000-000000000301']::uuid[]) r)
       = proof.group_of('00000000-0000-0000-0000-000000000301')
$$);

SELECT proof.expect_true('6c', 'er is door al dat herhalen geen tweede boeking ontstaan', $$
  SELECT proof.ledger_count('00000000-0000-0000-0000-000000000301') = 3
     AND proof.marker_count('00000000-0000-0000-0000-000000000301') = 1
$$);

-- ── 9. een regel die vóór de partij al geboekt was ──────────────────────────

SELECT public.post_bank_transaction('00000000-0000-0000-0000-000000000320');

SELECT proof.expect_true('9a', 'een al eerder geboekte regel tussen nieuwe regels stoort de partij niet', $$
  SELECT proof.bulk_shape(ARRAY[
    '00000000-0000-0000-0000-000000000315',
    '00000000-0000-0000-0000-000000000320',
    '00000000-0000-0000-0000-000000000316']::uuid[])
  = '1|posted|true 2|already_posted|true 3|posted|true'
$$);

-- ── 10. een afgeletterde bankregel wordt niet rechtstreeks geboekt ──────────

SELECT proof.expect_true('10a', 'een aan een factuur gekoppelde bankregel wordt geweigerd', $$
  SELECT proof.bulk_identity(ARRAY['00000000-0000-0000-0000-000000000321']::uuid[])
       = 'rejected | 22023 | Deze banktransactie is aan een factuur gekoppeld; boek die via de aflettering'
$$);

SELECT proof.expect_true('10b', 'en blijft ongeboekt', $$
  SELECT proof.marker_count('00000000-0000-0000-0000-000000000321') = 0
     AND proof.ledger_count('00000000-0000-0000-0000-000000000321') = 0
$$);

-- ── 11. ontbrekende grootboekrekening is geen succes ────────────────────────

SELECT proof.expect_true('11a', 'een regel zonder grootboekrekening levert nooit outcome posted', $$
  SELECT (SELECT r.outcome FROM public.post_bank_transactions_bulk(
            ARRAY['00000000-0000-0000-0000-000000000312']::uuid[]) r) = 'rejected'
$$);

-- ── 12. afgesloten boekjaar is geen succes ──────────────────────────────────

SELECT proof.expect_true('12a', 'een regel in een afgesloten boekjaar wordt geweigerd met de reden van de schrijver', $$
  SELECT proof.bulk_identity(ARRAY['00000000-0000-0000-0000-000000000323']::uuid[])
       = 'rejected | 22023 | Boekjaar 2027 is afgesloten voor deze administratie'
$$);

SELECT proof.expect_true('12b', 'en blijft ongeboekt', $$
  SELECT proof.marker_count('00000000-0000-0000-0000-000000000323') = 0
$$);

SELECT proof.expect_true('12c', 'een niet handmatig gecodeerde regel evenmin', $$
  SELECT (SELECT r.outcome FROM public.post_bank_transactions_bulk(
            ARRAY['00000000-0000-0000-0000-000000000324']::uuid[]) r) = 'rejected'
     AND proof.marker_count('00000000-0000-0000-0000-000000000324') = 0
$$);

-- ── 13. een vreemde en een niet-bestaande id zijn niet te onderscheiden ─────

SELECT proof.expect_true('13a', 'vreemde tenant en onbekende id geven een IDENTIEKE resultaatrij', $$
  SELECT (SELECT format('%s|%s|%s', r.outcome, r.error_code, r.message)
          FROM public.post_bank_transactions_bulk(
            ARRAY['00000000-0000-0000-0000-000000000330']::uuid[]) r)
       = (SELECT format('%s|%s|%s', r.outcome, r.error_code, r.message)
          FROM public.post_bank_transactions_bulk(
            ARRAY['00000000-0000-0000-0000-00000000dead']::uuid[]) r)
$$);

SELECT proof.expect_true('13b', 'en die rij is de generieke poortmelding', $$
  SELECT proof.bulk_identity(ARRAY['00000000-0000-0000-0000-000000000330']::uuid[])
       = 'rejected | 42501 | Banktransactie niet beschikbaar'
$$);

SELECT proof.expect_true('13c', 'ook naast een eigen id in dezelfde partij verraadt niets welke bestaat', $$
  SELECT proof.bulk_identity(ARRAY[
           '00000000-0000-0000-0000-000000000330',
           '00000000-0000-0000-0000-00000000dead']::uuid[])
       = E'rejected | 42501 | Banktransactie niet beschikbaar\nrejected | 42501 | Banktransactie niet beschikbaar'
$$);

SELECT proof.expect_true('13d', 'en de bankregel van de andere organisatie is en blijft ongeboekt', $$
  SELECT proof.marker_count('00000000-0000-0000-0000-000000000330') = 0
     AND proof.ledger_count('00000000-0000-0000-0000-000000000330') = 0
$$);

SELECT proof.expect_true('13e', 'de preflight van een administratie van een andere organisatie levert nul rijen', $$
  SELECT count(*) = 0 FROM public.bank_bulk_posting_candidates(
    '00000000-0000-0000-0000-0000000000c9', NULL)
$$);

SELECT proof.expect_true('13f', 'precies zoals een administratie die niet bestaat', $$
  SELECT count(*) = 0 FROM public.bank_bulk_posting_candidates(
    '00000000-0000-0000-0000-00000000beef', NULL)
$$);

-- ── 14/15. de aanroeper schrijft nergens zelf ───────────────────────────────

SELECT proof.expect_error('14a', 'de aanroeper kan zelf geen claim schrijven',
  $$INSERT INTO public.bank_transaction_postings (bank_transaction_id, posting_group_id, organization_id,
      client_id, grootboekrekening_id, posting_date, boekjaar, gross_amount, net_amount, btw_amount, user_id)
    VALUES ('00000000-0000-0000-0000-000000000316', gen_random_uuid(),
      '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-00000000f002', DATE '2027-03-01', 2027, 1, 1, 0,
      '00000000-0000-0000-0000-0000000000e1')$$,
  'permission denied');

SELECT proof.expect_error('14b', 'en geen bestaande claim wijzigen',
  $$UPDATE public.bank_transaction_postings SET posting_group_id = gen_random_uuid()$$,
  'permission denied');

SELECT proof.expect_error('14c', 'en geen bestaande claim verwijderen',
  $$DELETE FROM public.bank_transaction_postings$$,
  'permission denied');

SELECT proof.expect_error('15a', 'de directe schrijfdeur naar het grootboek blijft dicht',
  $$INSERT INTO public.ledger_postings (organization_id, client_id, grootboekrekening_id,
      posting_group_id, line_no, posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, user_id)
    VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-00000000f002', gen_random_uuid(), 1, DATE '2027-03-01', 2027,
      10, 0, 'EUR', 'x', 'bank_transaction', '00000000-0000-0000-0000-000000000316',
      '00000000-0000-0000-0000-0000000000e1')$$,
  'permission denied');

-- ── 16/17/18. wie mag de bulkfunctie uitvoeren ─────────────────────────────

SELECT proof.expect_true('16a', 'anon mag de bulkfunctie niet uitvoeren', $$
  SELECT NOT has_function_privilege('anon', 'public.post_bank_transactions_bulk(uuid[])', 'EXECUTE')
$$);

SELECT proof.expect_true('16b', 'anon mag de preflight evenmin uitvoeren', $$
  SELECT NOT has_function_privilege('anon', 'public.bank_bulk_posting_candidates(uuid,integer)', 'EXECUTE')
$$);

SELECT proof.expect_true('17a', 'service_role mag de bulkfunctie niet uitvoeren', $$
  SELECT NOT has_function_privilege('service_role', 'public.post_bank_transactions_bulk(uuid[])', 'EXECUTE')
     AND NOT has_function_privilege('service_role', 'public.bank_bulk_posting_candidates(uuid,integer)', 'EXECUTE')
$$);

SELECT proof.expect_true('17b', 'en PUBLIC ook niet', $$
  SELECT NOT has_function_privilege('public', 'public.post_bank_transactions_bulk(uuid[])', 'EXECUTE')
$$);

SELECT proof.expect_true('18a', 'authenticated mag beide uitvoeren', $$
  SELECT has_function_privilege('authenticated', 'public.post_bank_transactions_bulk(uuid[])', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.bank_bulk_posting_candidates(uuid,integer)', 'EXECUTE')
$$);

SELECT proof.expect_true('18b', 'beide functies draaien met de rechten van de aanroeper, niet van de eigenaar', $$
  SELECT bool_and(NOT p.prosecdef)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('post_bank_transactions_bulk', 'bank_bulk_posting_candidates')
$$);

-- ── 19. de bovengrens ───────────────────────────────────────────────────────

SELECT proof.expect_error('19a', 'meer dan 500 id''s wordt geweigerd',
  $$SELECT * FROM public.post_bank_transactions_bulk(
      (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 501)))$$,
  'Maximaal 500 banktransacties per keer');

SELECT proof.expect_true('19b', 'precies 500 wordt nog aanvaard en levert 500 resultaatrijen', $$
  SELECT (SELECT count(*) FROM public.post_bank_transactions_bulk(
            (SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 500)))) = 500
$$);

SELECT proof.expect_true('19c', 'de grens geldt op de RUWE lijst, niet op het aantal unieke id''s', $$
  SELECT proof.identity($q$SELECT * FROM public.post_bank_transactions_bulk(
           (SELECT array_agg('00000000-0000-0000-0000-000000000316'::uuid) FROM generate_series(1, 501)))$q$)
       LIKE '54000 | Maximaal 500%'
$$);

-- ── 20. een lege partij ─────────────────────────────────────────────────────

SELECT proof.expect_true('20a', 'een lege lijst wordt netjes geweigerd, niet stilzwijgend genegeerd', $$
  SELECT proof.identity($q$SELECT * FROM public.post_bank_transactions_bulk(ARRAY[]::uuid[])$q$)
       = '22023 | Geen banktransacties opgegeven'
$$);

SELECT proof.expect_true('20b', 'en NULL evenmin', $$
  SELECT proof.identity($q$SELECT * FROM public.post_bank_transactions_bulk(NULL::uuid[])$q$)
       = '22023 | Geen banktransacties opgegeven'
$$);

SELECT proof.expect_true('20c', 'een lege waarde tússen de id''s wordt geweigerd vóór er iets geboekt is', $$
  SELECT proof.identity($q$SELECT * FROM public.post_bank_transactions_bulk(
           ARRAY['00000000-0000-0000-0000-000000000316', NULL]::uuid[])$q$)
       = '22023 | De lijst met banktransacties bevat een lege waarde'
$$);

-- ── 21. volgorde en correlatie ──────────────────────────────────────────────

SELECT proof.expect_true('21a', 'elke resultaatrij draagt de positie van haar EERSTE voorkomen in de invoer', $$
  SELECT (SELECT string_agg(format('%s:%s', r.ordinal, right(r.transaction_id::text, 4)), ' ' ORDER BY r.ordinal)
          FROM public.post_bank_transactions_bulk(ARRAY[
            '00000000-0000-0000-0000-000000000301',
            '00000000-0000-0000-0000-000000000302',
            '00000000-0000-0000-0000-000000000301',
            '00000000-0000-0000-0000-000000000303']::uuid[]) r)
       = '1:0301 2:0302 4:0303'
$$);

SELECT proof.expect_true('21b', 'de rijen komen in de volgorde van de invoer terug, niet in id-volgorde', $$
  SELECT (SELECT string_agg(right(r.transaction_id::text, 4), ' ')
          FROM public.post_bank_transactions_bulk(ARRAY[
            '00000000-0000-0000-0000-000000000303',
            '00000000-0000-0000-0000-000000000301',
            '00000000-0000-0000-0000-000000000302']::uuid[]) r)
       = '0303 0301 0302'
$$);

-- ── 22. geen stille herkansing na een boekhoudkundige mislukking ────────────

SELECT proof.expect_true('22a', 'een mislukking ná de claim levert een weigering op', $$
  SELECT (SELECT r.outcome FROM public.post_bank_transactions_bulk(
            ARRAY['00000000-0000-0000-0000-000000000399']::uuid[]) r) = 'rejected'
$$);

SELECT proof.expect_true('22b', 'de schrijver is daarbij PRECIES ÉÉN keer aangeroepen: geen herkansing', $$
  SELECT last_value = 1 AND is_called FROM proof.poison_attempts
$$);

SELECT proof.expect_true('22c', 'en de claim van die mislukte poging is volledig teruggedraaid', $$
  SELECT proof.marker_count('00000000-0000-0000-0000-000000000399') = 0
     AND proof.ledger_count('00000000-0000-0000-0000-000000000399') = 0
$$);

SELECT proof.expect_true('22d', 'een mislukking ná de claim sleept haar buren niet mee', $$
  SELECT proof.bulk_shape(ARRAY[
    '00000000-0000-0000-0000-000000000342',
    '00000000-0000-0000-0000-000000000399']::uuid[])
  = '1|posted|true 2|rejected|false'
$$);

SELECT proof.expect_true('22e', 'ook in die tweede partij is er geen tweede poging gedaan', $$
  SELECT last_value = 2 FROM proof.poison_attempts
$$);

-- ── 23/24. elk succes hoort bij precies één marker en één sluitende groep ───

SELECT proof.expect_true('23a', 'elke geboekte bankregel heeft precies één marker', $$
  SELECT bool_and(c = 1) FROM (
    SELECT count(*) AS c FROM public.bank_transaction_postings GROUP BY bank_transaction_id
  ) t
$$);

SELECT proof.expect_true('23b', 'en elke marker precies één boekingsgroep, die nergens anders voorkomt', $$
  SELECT (SELECT count(DISTINCT posting_group_id) FROM public.bank_transaction_postings)
       = (SELECT count(*) FROM public.bank_transaction_postings)
$$);

SELECT proof.expect_true('24a', 'bij elke marker horen grootboekregels die sluiten', $$
  SELECT bool_and(d = c AND d > 0) FROM (
    SELECT sum(lp.debit_amount) AS d, sum(lp.credit_amount) AS c
    FROM public.bank_transaction_postings m
    JOIN public.ledger_postings lp ON lp.posting_group_id = m.posting_group_id
    GROUP BY m.bank_transaction_id
  ) t
$$);

SELECT proof.expect_true('24b', 'en het brutobedrag van de marker is precies de debetzijde van haar groep', $$
  SELECT bool_and(m.gross_amount = s.d) FROM public.bank_transaction_postings m
  JOIN LATERAL (
    SELECT sum(lp.debit_amount) AS d FROM public.ledger_postings lp
    WHERE lp.posting_group_id = m.posting_group_id
  ) s ON true
$$);

SELECT proof.expect_true('24c', 'er bestaat geen grootboekregel met bronsoort bank_transaction zonder marker', $$
  SELECT count(*) = 0 FROM public.ledger_postings lp
  WHERE lp.source_type = 'bank_transaction'
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
                    WHERE m.bank_transaction_id = lp.source_id)
$$);

-- ── 26-29. de preflight ─────────────────────────────────────────────────────

SELECT proof.expect_true('26a', 'de preflight noemt een geboekte regel posted, met haar boekingsgroep', $$
  SELECT workflow_state = 'posted' AND posting_group_id = proof.group_of('00000000-0000-0000-0000-000000000301')
     AND is_posted AND reason IS NULL
  FROM public.bank_bulk_posting_candidates('00000000-0000-0000-0000-0000000000c1', NULL)
  WHERE transaction_id = '00000000-0000-0000-0000-000000000301'
$$);

SELECT proof.expect_true('26b', 'een afgeletterde regel is blocked met een leesbare reden', $$
  SELECT workflow_state = 'blocked' AND is_allocated
     AND reason = 'Deze banktransactie is aan een factuur gekoppeld; boek die via de aflettering.'
  FROM public.bank_bulk_posting_candidates('00000000-0000-0000-0000-0000000000c1', NULL)
  WHERE transaction_id = '00000000-0000-0000-0000-000000000321'
$$);

SELECT proof.expect_true('26c', 'een regel zonder grootboekrekening vraagt om beoordeling', $$
  SELECT workflow_state = 'review_needed'
     AND reason = 'Deze banktransactie heeft nog geen grootboekrekening.'
  FROM public.bank_bulk_posting_candidates('00000000-0000-0000-0000-0000000000c1', NULL)
  WHERE transaction_id = '00000000-0000-0000-0000-000000000312'
$$);

SELECT proof.expect_true('26d', 'een niet handmatig gecodeerde regel ook, met de status erin', $$
  SELECT workflow_state = 'review_needed' AND reason LIKE 'Status is niet_gematcht;%'
  FROM public.bank_bulk_posting_candidates('00000000-0000-0000-0000-0000000000c1', NULL)
  WHERE transaction_id = '00000000-0000-0000-0000-000000000324'
$$);

SELECT proof.expect_true('26e', 'een afgesloten boekjaar is blocked', $$
  SELECT workflow_state = 'blocked' AND reason LIKE 'Boekjaar 2027 is afgesloten%'
  FROM public.bank_bulk_posting_candidates('00000000-0000-0000-0000-0000000000c2', NULL)
  WHERE transaction_id = '00000000-0000-0000-0000-000000000323'
$$);

SELECT proof.expect_true('26f', 'een administratie zonder bankrekening is blocked op de configuratie', $$
  SELECT workflow_state = 'blocked'
     AND reason = 'Geen bankrekening (grootboek) ingesteld voor deze administratie.'
  FROM public.bank_bulk_posting_candidates('00000000-0000-0000-0000-0000000000c3', NULL)
  WHERE transaction_id = '00000000-0000-0000-0000-000000000341'
$$);

SELECT proof.expect_true('27a', 'wat de preflight ready noemt, boekt de schrijver ook werkelijk', $$
  SELECT (SELECT bool_and(r.outcome IN ('posted', 'already_posted'))
          FROM public.post_bank_transactions_bulk(
            (SELECT array_agg(transaction_id)
             FROM public.bank_bulk_posting_candidates('00000000-0000-0000-0000-0000000000c1', NULL)
             WHERE workflow_state = 'ready')) r)
$$);

SELECT proof.expect_true('27b', 'en na die ronde is er in deze administratie niets meer ready', $$
  SELECT count(*) = 0 FROM public.bank_bulk_posting_candidates('00000000-0000-0000-0000-0000000000c1', NULL)
  WHERE workflow_state = 'ready'
$$);

SELECT proof.expect_true('28a', 'het boekjaarfilter is halfopen en laat 2026 buiten 2027', $$
  SELECT (SELECT count(*) FROM public.bank_bulk_posting_candidates(
            '00000000-0000-0000-0000-0000000000c1', 2026)) = 1
     AND (SELECT bool_and(transaction_date >= DATE '2026-01-01' AND transaction_date < DATE '2027-01-01')
          FROM public.bank_bulk_posting_candidates('00000000-0000-0000-0000-0000000000c1', 2026))
$$);

SELECT proof.expect_true('28b', 'zonder boekjaar komt alles van de administratie terug', $$
  SELECT (SELECT count(*) FROM public.bank_bulk_posting_candidates(
            '00000000-0000-0000-0000-0000000000c1', NULL))
       = (SELECT count(*) FROM public.bank_transactions
          WHERE client_id = '00000000-0000-0000-0000-0000000000c1')
$$);

CREATE TEMP TABLE preflight_voor AS
  SELECT (SELECT count(*) FROM public.ledger_postings)             AS regels,
         (SELECT count(*) FROM public.bank_transaction_postings)   AS markers;

SELECT count(*) FROM public.bank_bulk_posting_candidates('00000000-0000-0000-0000-0000000000c1', NULL);

SELECT proof.expect_true('29a', 'de preflight verandert niets: geen regel, geen marker', $$
  SELECT (SELECT count(*) FROM public.ledger_postings)           = (SELECT regels  FROM preflight_voor)
     AND (SELECT count(*) FROM public.bank_transaction_postings) = (SELECT markers FROM preflight_voor)
$$);

SELECT proof.expect_true('29b', 'en is als STABLE gemarkeerd, dus zij kan per definitie niet schrijven', $$
  SELECT p.provolatile = 's'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'bank_bulk_posting_candidates'
$$);

-- ── 30. een lezer zonder schrijfrecht komt niet langs de schrijver ──────────

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', false);

SELECT proof.expect_true('30a', 'een read_only-gebruiker krijgt de eerlijke rolmelding, niet de poortmelding', $$
  SELECT proof.bulk_identity(ARRAY['00000000-0000-0000-0000-000000000342']::uuid[])
       = 'rejected | 42501 | Geen rechten om te boeken voor deze organisatie'
$$);

SELECT proof.expect_true('30b', 'maar voor een vreemde organisatie ziet hij hetzelfde als iedereen', $$
  SELECT proof.bulk_identity(ARRAY['00000000-0000-0000-0000-000000000330']::uuid[])
       = 'rejected | 42501 | Banktransactie niet beschikbaar'
$$);

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);
RESET ROLE;

-- De kunstmatige mislukking hoort niet bij het gelijktijdigheidsdeel.
DROP TRIGGER proof_poison_marker_trigger ON public.bank_transaction_postings;
