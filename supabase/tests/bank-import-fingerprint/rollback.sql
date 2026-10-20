-- NA de gedocumenteerde ROLLBACK (letterlijk uit de kop van de migratie, TWEE
-- keer toegepast). Throwaway database only.
--   R1  alle drie kolommen, beide CHECKs en de index zijn weg
--   R2  de historische rijen zijn byte-gelijk aan vóór de migratie, en hun
--       fysieke identiteit ook (geen UPDATE); alle later geïmporteerde rijen
--       bestaan nog (de rollback verwijdert geen transacties)
--   R3  policies, relacl en de rest van de catalogus zijn als vóór de migratie

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

SELECT proof.record('R1', 'rollback (2x): alle drie kolommen, beide CHECKs en de index zijn weg',
  NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.bank_transactions'::regclass
              AND attname IN ('import_fingerprint', 'import_source', 'bank_reference') AND NOT attisdropped)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname IN ('bank_transactions_import_fingerprint_format', 'bank_transactions_import_source_known'))
  AND to_regclass('public.bank_transactions_client_import_fingerprint_key') IS NULL);

SELECT proof.record('R2a', 'rollback: historische rijen inhoudelijk gelijk aan vóór de migratie (zelfde digest, zelfde ids)',
  proof.digest(proof.historical()) = (SELECT v FROM proof.state WHERE k = 'digest_before')
  AND (SELECT count(*) FROM public.bank_transactions WHERE id = ANY (proof.historical()))::text
      = (SELECT v FROM proof.state WHERE k = 'rows_before'));

SELECT proof.record('R2b', 'rollback: historische rijen fysiek onaangeroerd (ctid, xmin)',
  proof.physical(proof.historical()) = (SELECT v FROM proof.state WHERE k = 'physical_before'));

SELECT proof.record('R2c', 'rollback: geen enkele transactie verwijderd (aantal gelijk aan vlak vóór de rollback)',
  (SELECT count(*)::text FROM public.bank_transactions) = (SELECT v FROM proof.state WHERE k = 'rows_before_rollback'),
  format('%s rijen', (SELECT count(*) FROM public.bank_transactions)));

SELECT proof.record('R3', 'rollback: policies, relacl en overige catalogus als vóór de migratie',
  proof.policies() = (SELECT v FROM proof.state WHERE k = 'policies_before')
  AND proof.acl() = (SELECT v FROM proof.state WHERE k = 'acl_before')
  AND proof.catalog_rest() = (SELECT v FROM proof.state WHERE k = 'catalog_before'));
