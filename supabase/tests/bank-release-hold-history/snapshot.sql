-- NULMETING vóór 20261018180000 (na PR 1 en PR 2) — throwaway database only.
--
-- De volledige catalogus en de data, zodat na de migratie precies kan worden
-- getoetst wat er veranderde: één nieuwe functie (de hulpfunctie), het lichaam
-- en commentaar van de hold — en verder niets, geen enkele rij.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE TABLE proof.catalog_before AS SELECT * FROM proof.catalog();
GRANT SELECT ON proof.catalog_before TO public;

SELECT proof.put('catalog_before_fix', proof.catalog_digest());
SELECT proof.put('digest_before_fix', proof.digest());
SELECT proof.put('rest_before_fix', proof.rest_digest());
