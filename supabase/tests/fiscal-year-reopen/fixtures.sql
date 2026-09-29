-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist
-- database. See run-proof.sh.
--
-- Draait VÓÓR de migratie onder test (na ../year-close/fixtures.sql en
-- ../posting-lock-enforced/fixtures.sql). Twee soorten inhoud:
--   1. hulpfuncties voor het bewijs;
--   2. ERFENIS: toestanden die vóór PR E al konden bestaan — een gewone
--      afsluiting zonder transactiestempel, en drie inconsistente standen die
--      alleen via een handmatig watermerk (of het vroegere handmatige veld)
--      konden ontstaan. Het watermerk "met de hand zetten" gebeurt hier door de
--      bewakende trigger even uit te zetten: precies de toestand die productie
--      van vóór 6C-b10 kan kennen.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

/* Het watermerk buiten elke bewaker om zetten — alleen voor erfenisfixtures. */
CREATE OR REPLACE FUNCTION proof.force_watermark(_client uuid, _year integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  ALTER TABLE public.clients DISABLE TRIGGER enforce_year_close_watermark_trigger;
  UPDATE public.clients SET afgesloten_boekjaar = _year WHERE id = _client;
  ALTER TABLE public.clients ENABLE ALWAYS TRIGGER enforce_year_close_watermark_trigger;
END $$;

CREATE OR REPLACE FUNCTION proof.watermark(_client uuid) RETURNS integer
LANGUAGE sql STABLE AS $$ SELECT afgesloten_boekjaar FROM public.clients WHERE id = _client $$;

CREATE OR REPLACE FUNCTION proof.status(_client uuid, _year integer) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT status FROM public.year_closures WHERE client_id = _client AND fiscal_year = _year
$$;

/* De geschiedenis van één boekjaar, oudste eerst. */
-- plpgsql, niet sql: created_xact_id bestaat pas NA de migratie, en een
-- sql-functie wordt bij het aanmaken al gevalideerd.
CREATE OR REPLACE FUNCTION proof.events(_client uuid, _year integer) RETURNS text
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN (SELECT COALESCE(string_agg(event_type, ',' ORDER BY occurred_at, created_xact_id NULLS FIRST, id), '')
          FROM public.fiscal_year_events WHERE client_id = _client AND fiscal_year = _year);
END $$;

CREATE OR REPLACE FUNCTION proof.ledger_digest(_client uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(md5(string_agg(lp::text, '|' ORDER BY lp.id)), 'leeg')
  FROM public.ledger_postings lp WHERE lp.client_id = _client
$$;

CREATE TABLE IF NOT EXISTS proof.snap (k text PRIMARY KEY, v text);

-- ── Erfenis ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_l  uuid := proof.pl_client('PR E — erfenis: gewone afsluiting vóór PR E');
  v_m1 uuid := proof.pl_client('PR E — erfenis: watermerk zonder bewijs');
  v_m2 uuid := proof.pl_client('PR E — erfenis: watermerk boven het bewijs');
  v_m3 uuid := proof.pl_client('PR E — erfenis: bewijsloos jaar met boekingen eronder');
BEGIN
  INSERT INTO proof.subject VALUES ('L', v_l), ('M1', v_m1), ('M2', v_m2), ('M3', v_m3);

  -- L: een gewone afsluiting, vastgelegd vóór er een transactiestempel bestond.
  PERFORM proof.seed_group(v_l, 2024);

  -- M1: watermerk 2024, maar geen enkel afsluitbewijs.
  PERFORM proof.force_watermark(v_m1, 2024);

  -- M3: 2023 heeft boekingen en is "dicht" via een handmatig watermerk.
  PERFORM proof.seed_group(v_m3, 2023);
  PERFORM proof.force_watermark(v_m3, 2023);
END $$;

-- De afsluitingen in eigen transacties, als de accountant.
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'L'), 2024);
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'M2'), 2024);
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'M3'), 2024);

-- M2: daarna het watermerk met de hand boven het bewijs uit.
SELECT proof.force_watermark((SELECT client_id FROM proof.subject WHERE rol = 'M2'), 2025);
