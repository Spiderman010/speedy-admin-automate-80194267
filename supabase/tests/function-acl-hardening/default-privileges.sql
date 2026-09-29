-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist
-- database. See run-proof.sh.
--
-- Supabase's standaard-functierechten, nagebootst. Op het platform staat voor
-- de rol die migraties uitvoert een pg_default_acl-regel die bij het AANMAKEN
-- van elke functie in `public` EXECUTE rechtstreeks toekent aan anon,
-- authenticated en service_role. Precies dat maakte `REVOKE ALL … FROM
-- PUBLIC` onvoldoende: die directe toekenningen blijven staan.
--
-- Zonder deze regel zou het harnas de blootstelling uit productie niet kunnen
-- reproduceren, en bewees het "na de migratie is het dicht" over een toestand
-- die nooit open was. Hij staat daarom VÓÓR elke migratie.

\set ON_ERROR_STOP on
SET client_min_messages = warning;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
