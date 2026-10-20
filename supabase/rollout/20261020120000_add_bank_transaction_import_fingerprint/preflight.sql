-- ═════════════════════════════════════════════════════════════════════════════
-- PRE — leescontroles vóór 20261020120000_add_bank_transaction_import_fingerprint.sql
--
-- UITSLUITEND in de Lovable Cloud SQL editor (Lovable → Cloud-icoon, of
-- Cmd/Ctrl+K → "Cloud"), NA visuele bevestiging dat het actieve project exact
-- `alxlbdhpbwlehbdbfejw` is (zie de controlelijst in PROJECT_MAP.md: de
-- projectref in de editor en de `sb-project-ref`-header in het netwerktabblad).
-- Nooit het persoonlijke Supabase-dashboard, nooit de Vercel Marketplace-
-- database, nooit olumcwneiejjefhkzgmz of ycuofllsdssoezwwpqmv.
--
-- Alles hieronder is ALLEEN LEZEN. Voer de blokken één voor één uit en bewaar
-- de uitkomst van PRE 2: de twee aantallen worden in POST letterlijk ingevuld.
--
-- MOMENT: voer PRE, migratie en POST direct na elkaar uit op een rustig moment
-- (geen gebruikers actief in BoekAssist): een import tussendoor verandert het
-- aantal rijen en geeft in POST een afwijking. Zet vóór de migratie in dezelfde
-- editorsessie `SET lock_timeout = '5s';` — CREATE UNIQUE INDEX houdt kort een
-- SHARE-lock (lezen gaat door, schrijven wacht). Bij een time-out is er niets
-- toegepast (alles of niets): STOP en melden.
--
-- STOP (niet uitvoeren, niets herstellen, uitkomst doorgeven) als:
--   • PRE 1 ergens `false` geeft (een vereiste ontbreekt, of een van de twee
--     kolommen, CHECKs of de index bestaat al — een onbekende eerdere poging);
--   • PRE 2 `rls_aan = false` geeft.
-- PRE 3 t/m PRE 5 zijn INFORMATIEF en nooit een STOP: historische regels houden
-- NULL en worden door de partiële index nooit geblokkeerd, ook niet als ze
-- exact dubbel zijn. Zij laten de eigenaar zien hoeveel historische dubbele
-- imports er al liggen; er wordt niets automatisch hersteld.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── PRE 1. Vereisten aanwezig, de nieuwe objecten nog niet ──────────────────
-- Verwacht: één rij, elke kolom `true`.
SELECT
  to_regclass('public.bank_transactions') IS NOT NULL                              AS bank_transactions,
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'bank_transactions'
     AND column_name IN ('client_id', 'transaction_date', 'amount', 'description',
                         'counter_account', 'reference')) = 6                       AS kolommen,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bank_transactions'
                AND column_name = 'import_fingerprint')                            AS kolom_fingerprint_nog_afwezig,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bank_transactions'
                AND column_name = 'import_source')                                 AS kolom_source_nog_afwezig,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bank_transactions'
                AND column_name = 'bank_reference')                                AS kolom_bankreferentie_nog_afwezig,
  NOT EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'bank_transactions_import_fingerprint_format')       AS check_fingerprint_nog_afwezig,
  NOT EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'bank_transactions_import_source_known')             AS check_source_nog_afwezig,
  to_regclass('public.bank_transactions_client_import_fingerprint_key') IS NULL    AS index_nog_afwezig;


-- ── PRE 2. Omvang, RLS en policies (bewaren voor POST) ──────────────────────
-- Vul `banktransacties` en `policies` in POST in. Verwacht: rls_aan = true;
-- policies = 4 (role_bank_transactions_select/_insert/_update/_delete).
SELECT
  (SELECT count(*) FROM public.bank_transactions)                                  AS banktransacties,
  (SELECT count(DISTINCT client_id) FROM public.bank_transactions)                 AS administraties_met_transacties,
  (SELECT count(*) FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'bank_transactions')                AS policies,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bank_transactions'::regclass) AS rls_aan,
  (SELECT relacl::text   FROM pg_class WHERE oid = 'public.bank_transactions'::regclass) AS tabelrechten,
  (SELECT md5(string_agg(format('%s|%s|%s|%s|%s', policyname, roles, cmd, qual, with_check), E'\n' ORDER BY policyname))
   FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_transactions') AS policies_digest;


-- ── PRE 3. Historische regels met identieke inhoud (informatief) ────────────
-- Groepen met dezelfde (administratie, datum, bedrag, omschrijving,
-- tegenrekening, referentie). Dat kan een dubbele import zijn, maar ook twee
-- echt verschillende betalingen (twee keer parkeren). Geen STOP.
WITH g AS (
  SELECT count(*) AS grootte
  FROM public.bank_transactions
  GROUP BY client_id, transaction_date, amount, description, counter_account, reference
)
SELECT
  (SELECT count(*) FROM public.bank_transactions)        AS rijen,
  count(*) FILTER (WHERE grootte > 1)                    AS groepen_met_identieke_inhoud,
  coalesce(sum(grootte) FILTER (WHERE grootte > 1), 0)   AS rijen_in_die_groepen,
  coalesce(max(grootte), 0)                              AS grootste_groep
FROM g;

-- Verdeling van de groepsgrootte (alleen groepen > 1).
SELECT grootte, count(*) AS groepen
FROM (
  SELECT count(*) AS grootte
  FROM public.bank_transactions
  GROUP BY client_id, transaction_date, amount, description, counter_account, reference
) g
WHERE grootte > 1
GROUP BY grootte
ORDER BY grootte;


-- ── PRE 4. De bankreferentie na "//" is uniek per administratie (informatief)
-- Per administratie: rijen, rijen met een "//"-referentie, en het aantal
-- verschillende bankreferenties (het deel na de eerste "//", getrimd — zoals de
-- app het leest). Is `verschillende_bankreferenties` gelijk aan
-- `rijen_met_bankreferentie`, dan is die referentie daar uniek. Een verschil
-- zijn historische dubbele imports (PRE 5). Geen STOP.
WITH r AS (
  SELECT client_id,
         nullif(btrim(substr(reference, strpos(reference, '//') + 2)), '') AS bankref
  FROM public.bank_transactions
  WHERE strpos(reference, '//') > 0
)
SELECT
  (SELECT count(*) FROM public.bank_transactions)                       AS rijen_totaal,
  (SELECT count(*) FROM r)                                              AS rijen_met_dubbele_slash,
  (SELECT count(*) FROM r WHERE bankref IS NOT NULL)                    AS rijen_met_bankreferentie,
  (SELECT count(*) FROM (SELECT DISTINCT client_id, bankref FROM r WHERE bankref IS NOT NULL) d)
                                                                        AS verschillende_bankreferenties_per_administratie;

SELECT bt.client_id,
       count(*)                                                             AS rijen,
       count(*) FILTER (WHERE strpos(bt.reference, '//') > 0)               AS rijen_met_dubbele_slash,
       count(DISTINCT nullif(btrim(substr(bt.reference, strpos(bt.reference, '//') + 2)), ''))
         FILTER (WHERE strpos(bt.reference, '//') > 0)                      AS verschillende_bankreferenties,
       count(*) FILTER (WHERE strpos(bt.reference, '//') > 0
                          AND nullif(btrim(substr(bt.reference, strpos(bt.reference, '//') + 2)), '') IS NOT NULL)
         - count(DISTINCT nullif(btrim(substr(bt.reference, strpos(bt.reference, '//') + 2)), ''))
           FILTER (WHERE strpos(bt.reference, '//') > 0)                    AS rijen_met_herhaalde_bankreferentie
FROM public.bank_transactions bt
GROUP BY bt.client_id
ORDER BY rijen_met_herhaalde_bankreferentie DESC, rijen DESC
LIMIT 200;


-- ── PRE 5. Bankreferenties die binnen een administratie vaker voorkomen ─────
-- Dit zijn vrijwel zeker historische dubbele imports. Informatief, voor de
-- eigenaar; niets automatisch herstellen. Geen STOP.
SELECT bt.client_id,
       nullif(btrim(substr(bt.reference, strpos(bt.reference, '//') + 2)), '') AS bankreferentie,
       count(*)                                         AS rijen,
       min(bt.transaction_date)                         AS eerste_datum,
       max(bt.transaction_date)                         AS laatste_datum,
       array_agg(DISTINCT bt.amount ORDER BY bt.amount) AS bedragen,
       array_agg(bt.match_status ORDER BY bt.created_at) AS match_statussen,
       array_agg(bt.id ORDER BY bt.created_at)          AS transactie_ids
FROM public.bank_transactions bt
WHERE strpos(bt.reference, '//') > 0
  AND nullif(btrim(substr(bt.reference, strpos(bt.reference, '//') + 2)), '') IS NOT NULL
GROUP BY bt.client_id, nullif(btrim(substr(bt.reference, strpos(bt.reference, '//') + 2)), '')
HAVING count(*) > 1
ORDER BY count(*) DESC, eerste_datum
LIMIT 200;
