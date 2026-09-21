-- De wereld zoals productie hem vandaag heeft — vóór de migratie onder test.
--
-- Drie administraties, elk met een andere uitgangssituatie, zodat de backfill
-- kan worden beoordeeld op wat hij WEL en wat hij NIET meeneemt:
--
--   A  twee jaren netjes afgesloten via close_fiscal_year()  → twee gebeurtenissen
--   B  één jaar netjes afgesloten                            → één gebeurtenis
--   C  een HANDMATIG gezet watermerk zonder afsluitbewijs    → GEEN gebeurtenis
--
-- Administratie C is de erfenis uit productie en het belangrijkste geval van
-- deze hele test: voor dat jaar bestaat geen tijdstip en geen actor, dus er valt
-- niets te backfillen zonder iets te verzinnen.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS proof.seeded (rol text PRIMARY KEY, client_id uuid NOT NULL);

DO $$
DECLARE
  v_a uuid := proof.new_client('Administratie A — twee jaren afgesloten');
  v_b uuid := proof.new_client('Administratie B — één jaar afgesloten');
  v_c uuid := proof.new_client('Administratie C — handmatig watermerk');
BEGIN
  -- A: 2024 en 2025, in volgorde, allebei via de echte schrijver.
  PERFORM proof.seed_group(v_a, 2024);
  PERFORM proof.seed_group(v_a, 2025);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_a, 2024);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_a, 2025);

  -- B: alleen 2024, door een andere gebruiker, zodat actor_id aantoonbaar
  -- meekomt uit de rij en niet uit een aanname.
  PERFORM proof.seed_group(v_b, 2024);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_b, 2024);

  -- C: het watermerk met de hand gezet, precies zoals dat vóór 6C-b10 kon.
  -- Buiten de schrijver om kan alleen de eigenaar van de tabel dat, en dat is
  -- hier ook de bedoeling: deze toestand is niet meer te MAKEN, alleen nog te
  -- vinden.
  PERFORM proof.seed_group(v_c, 2023);
  ALTER TABLE public.clients DISABLE TRIGGER enforce_year_close_watermark_trigger;
  UPDATE public.clients SET afgesloten_boekjaar = 2023 WHERE id = v_c;
  ALTER TABLE public.clients ENABLE ALWAYS TRIGGER enforce_year_close_watermark_trigger;

  INSERT INTO proof.seeded VALUES ('a', v_a), ('b', v_b), ('c', v_c);
END $$;
