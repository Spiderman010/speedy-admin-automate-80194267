-- NA opnieuw toepassen van de migratie ná de rollback. Throwaway database only.
-- Er staan nu (opnieuw) historische exacte duplicaten én rijen die eerder een
-- vingerafdruk hadden; die afdruk is met de rollback verdwenen, dus NULL.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

SELECT proof.record('F1', 'opnieuw vooruit: alle drie kolommen, beide CHECKs en geldige unieke partiële index terug; alle rijen NULL',
  (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.bank_transactions'::regclass
     AND attname IN ('import_fingerprint', 'import_source', 'bank_reference') AND NOT attisdropped) = 3
  AND (SELECT count(*) FROM pg_constraint
       WHERE conname IN ('bank_transactions_import_fingerprint_format', 'bank_transactions_import_source_known')) = 2
  AND (SELECT indisunique AND indisvalid AND indpred IS NOT NULL FROM pg_index
       WHERE indexrelid = to_regclass('public.bank_transactions_client_import_fingerprint_key'))
  AND NOT EXISTS (SELECT 1 FROM public.bank_transactions
                  WHERE import_fingerprint IS NOT NULL OR import_source IS NOT NULL OR bank_reference IS NOT NULL));

SELECT proof.record('F2', 'opnieuw vooruit: X kan in A weer precies één keer',
  proof.attempt(proof.import_sql(proof.fp('X'), 'X na herinvoering')) = 'ok'
  AND proof.attempt(proof.import_sql(proof.fp('X'), 'X na herinvoering, tweede')) LIKE '23505: %');
