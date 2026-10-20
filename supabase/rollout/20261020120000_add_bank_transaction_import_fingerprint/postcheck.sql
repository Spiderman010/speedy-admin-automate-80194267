-- ═════════════════════════════════════════════════════════════════════════════
-- POST — leescontrole ná 20261020120000_add_bank_transaction_import_fingerprint.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor van `alxlbdhpbwlehbdbfejw`, in
-- dezelfde sessie-context als de PRE (zelfde project, visueel bevestigd).
-- Nooit olumcwneiejjefhkzgmz of ycuofllsdssoezwwpqmv.
-- Alles hieronder is ALLEEN LEZEN; er wordt niets getest door te schrijven —
-- geen testdata in productie. Dat de index dubbele imports weigert, ook onder
-- echte gelijktijdigheid, is bewezen in supabase/tests/bank-import-fingerprint/;
-- hier wordt bewezen dat productie exact die objecten draagt en verder niets
-- veranderde.
--
-- VOOR HET UITVOEREN: vervang in het blok `pre` de twee `NULL`'s door de
-- uitkomst van PRE 2 (`banktransacties` en `policies`). Niet ingevuld ⇒ de
-- bijbehorende kolom is `false`.
--
-- Verwacht: één rij, ELKE kolom `true`. Bij ELKE `false`: STOP, niets
-- herstellen, uitkomst doorgeven. De rollback staat in de kop van de migratie.
-- Draai dit direct na de migratie: zodra de app de kolom ziet, schrijft een
-- nieuwe import vingerafdrukken en bronformaten, en zijn `bestaande_rijen_null`
-- en `bestaande_rijen_bron_null` niet meer waar.
-- ═════════════════════════════════════════════════════════════════════════════

WITH pre AS (
  SELECT NULL::bigint AS pre_banktransacties,   -- ← PRE 2 `banktransacties`
         NULL::bigint AS pre_policies           -- ← PRE 2 `policies`
),
kolom AS (
  SELECT a.attnum, a.attnotnull, a.atthasdef, format_type(a.atttypid, a.atttypmod) AS type
  FROM pg_attribute a
  WHERE a.attrelid = 'public.bank_transactions'::regclass
    AND a.attname = 'import_fingerprint' AND NOT a.attisdropped
),
bron AS (
  SELECT a.attnum, a.attnotnull, a.atthasdef, format_type(a.atttypid, a.atttypmod) AS type
  FROM pg_attribute a
  WHERE a.attrelid = 'public.bank_transactions'::regclass
    AND a.attname = 'import_source' AND NOT a.attisdropped
),
chk AS (
  SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.bank_transactions'::regclass
    AND c.conname = 'bank_transactions_import_fingerprint_format'
),
chk_bron AS (
  SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.bank_transactions'::regclass
    AND c.conname = 'bank_transactions_import_source_known'
),
idx AS (
  SELECT i.indisunique, i.indisvalid, i.indpred IS NOT NULL AS partieel, pg_get_indexdef(i.indexrelid) AS def
  FROM pg_index i
  WHERE i.indexrelid = to_regclass('public.bank_transactions_client_import_fingerprint_key')
    AND i.indrelid = 'public.bank_transactions'::regclass
)
SELECT
  (SELECT count(*) = 1 AND bool_and(type = 'text') FROM kolom)                     AS kolom_bestaat_als_text,
  coalesce((SELECT NOT attnotnull FROM kolom), false)                              AS kolom_nullable,
  coalesce((SELECT NOT atthasdef FROM kolom), false)                               AS geen_standaardwaarde,
  coalesce((SELECT contype = 'c' AND convalidated
              AND def = $e$CHECK (((import_fingerprint IS NULL) OR (import_fingerprint ~ '^[0-9a-f]{64}$'::text)))$e$
            FROM chk), false)                                                      AS check_exact,
  (SELECT count(*) = 1 AND bool_and(type = 'text') FROM bron)                      AS bron_kolom_bestaat_als_text,
  coalesce((SELECT NOT attnotnull FROM bron), false)                               AS bron_kolom_nullable,
  coalesce((SELECT NOT atthasdef FROM bron), false)                                AS bron_geen_standaardwaarde,
  coalesce((SELECT contype = 'c' AND convalidated
              AND def = $e$CHECK (((import_source IS NULL) OR (import_source = ANY (ARRAY['mt940'::text, 'camt053'::text]))))$e$
            FROM chk_bron), false)                                                 AS bron_check_exact,
  coalesce((SELECT indisunique AND indisvalid AND partieel
              AND def = 'CREATE UNIQUE INDEX bank_transactions_client_import_fingerprint_key ON public.bank_transactions USING btree (client_id, import_fingerprint) WHERE (import_fingerprint IS NOT NULL)'
            FROM idx), false)                                                      AS index_uniek_partieel_exact,
  NOT EXISTS (SELECT 1 FROM public.bank_transactions WHERE import_fingerprint IS NOT NULL)
                                                                                   AS bestaande_rijen_null,
  NOT EXISTS (SELECT 1 FROM public.bank_transactions WHERE import_source IS NOT NULL)
                                                                                   AS bestaande_rijen_bron_null,
  coalesce((SELECT count(*) FROM public.bank_transactions) = (SELECT pre_banktransacties FROM pre), false)
                                                                                   AS aantal_rijen_gelijk_aan_pre,
  coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bank_transactions'::regclass), false)
                                                                                   AS rls_aan,
  coalesce((SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_transactions')
             = (SELECT pre_policies FROM pre), false)                              AS policies_aantal_gelijk_aan_pre;
