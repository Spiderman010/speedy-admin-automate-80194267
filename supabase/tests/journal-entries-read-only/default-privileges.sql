-- TEST DOUBLE — NOT A MIGRATION. Never run this against any BoekAssist
-- database. See run-proof.sh.
--
-- Supabase's standaardrechten, nagebootst: bij het AANMAKEN van een tabel of
-- functie in `public` krijgen anon, authenticated en service_role rechtstreeks
-- ALL. Zo stond `journal_entries` in productie open; zonder deze regel zou het
-- harnas die blootstelling niet kunnen reproduceren. Staat vóór alles.

\set ON_ERROR_STOP on
SET client_min_messages = warning;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
