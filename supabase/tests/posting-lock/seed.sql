-- De wereld zoals zij vóór PR C is: administraties met afgesloten boekjaren,
-- een handmatig watermerk, en nergens een boekingsblokkade — want die bestaat
-- nog niet.
--
-- Dit draait BEWUST vóór de migratie onder test. Alleen zo zegt het ontbreken
-- van een backfill iets: er staan dan echte afgesloten jaren klaar waaruit een
-- blokkade afgeleid zou kúnnen worden, en de proef laat zien dat dat niet
-- gebeurt.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS proof.lock_subject (rol text PRIMARY KEY, client_id uuid NOT NULL);

DO $$
DECLARE
  v_dicht    uuid := proof.new_client('Blokkade — jaar afgesloten, geen blokkade');
  v_hand     uuid := proof.new_client('Blokkade — handmatig watermerk');
  v_vrij     uuid := proof.new_client('Blokkade — niets afgesloten');
BEGIN
  -- Een administratie met een NETJES afgesloten boekjaar, via de echte
  -- schrijver. Zij krijgt straks aantoonbaar geen blokkade.
  PERFORM proof.seed_group(v_dicht, 2025);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_dicht, 2025);

  -- Een administratie met een met de hand gezet watermerk, zonder afsluitbewijs
  -- — de erfenis uit productie. Ook die mag niets afleiden.
  PERFORM proof.seed_group(v_hand, 2024);
  ALTER TABLE public.clients DISABLE TRIGGER enforce_year_close_watermark_trigger;
  UPDATE public.clients SET afgesloten_boekjaar = 2024 WHERE id = v_hand;
  ALTER TABLE public.clients ENABLE ALWAYS TRIGGER enforce_year_close_watermark_trigger;

  -- En een administratie zonder enige afsluiting, als controlegroep.
  PERFORM proof.seed_group(v_vrij, 2025);

  INSERT INTO proof.lock_subject VALUES ('dicht', v_dicht), ('handmatig', v_hand), ('vrij', v_vrij);
END $$;
