-- ═════════════════════════════════════════════════════════════════════════════
-- BANKIMPORT — DATABASE-AFGEDWONGEN IDEMPOTENTIE PER AFSCHRIFTREGEL
--
-- WAAROM
--   bank_transactions heeft geen enkele uniciteit. De duplicaatcontrole bij het
--   importeren draait in de browser; twee gebruikers die tegelijk hetzelfde
--   afschrift importeren, lezen allebei dezelfde (nog lege) momentopname en
--   schrijven allebei alle regels. Elke kopie kan daarna opnieuw worden geboekt.
--
--   Deze migratie geeft elke geïmporteerde regel een optionele vingerafdruk en
--   laat de database een tweede regel met dezelfde vingerafdruk binnen dezelfde
--   administratie weigeren (23505). Wie als tweede schrijft, krijgt een nette
--   weigering in plaats van een dubbele transactie.
--
-- WAAROM GEEN UNIEKE INDEX OP DE INHOUD
--   Legitieme, verschillende betalingen kunnen op alles gelijk zijn behalve de
--   bankreferentie: zelfde administratie, datum, bedrag, omschrijving en
--   tegenrekening (twee keer parkeren, twee gelijke abonnementsregels). Een
--   index op (datum, bedrag, omschrijving, tegenrekening) zou de tweede
--   weigeren. De productiesteekproef (alleen lezen, 200 open regels) bevat zo'n
--   groep van drie. Daarom bevat de vingerafdruk wat zo'n regel uniek maakt:
--     • de referentie van de bank zelf, wanneer het afschrift die meegeeft
--       (MT940: het deel na "//" in :61:; CAMT.053: <AcctSvcrRef>), samen met
--       rekening, valutadatum en bedrag (de valutadatum, omdat MT940 en CAMT
--       verschillende "datums" als hoofddatum leveren). De app gebruikt de
--       bankreferentie alleen als zij in het afschrift uniek is en niet al bij
--       een opgeslagen regel met een ander bedrag hoort. In de steekproef heeft 200/200 regels er een, alle
--       verschillend. Zo'n afdruk herkent dezelfde banktransactie ook in een
--       ander of overlappend afschrift;
--     • anders: een sleutel van het afschrift zelf (rekening, saldi en alle
--       regels) plus de positie van de regel daarin. Die herkent alleen
--       hetzelfde afschrift, maar kan twee verschillende regels nooit gelijk
--       maken.
--   De applicatie berekent de afdruk (SHA-256, 64 hex-tekens). Zij is een rem
--   op het per ongeluk dubbel importeren, geen toegangscontrole: RLS en de
--   rollen blijven zoals zij zijn.
--
--   Daarnaast legt `import_source` ('mt940' | 'camt053') vast uit welk
--   bestandsformaat een regel kwam. Een referentie betekent per formaat iets
--   anders (een MT940-typecode vóór de referentie; een CAMT-EndToEndId die
--   precies zo bedoeld is); zonder dit veld moet de app het formaat raden uit
--   optionele CAMT-velden, en een CAMT-regel zonder die velden is niet van een
--   MT940-regel te onderscheiden.
--
-- WAT DEZE MIGRATIE NADRUKKELIJK NIET DOET
--   - Geen backfill en geen UPDATE van bestaande rijen: die houden NULL. Een
--     partiële index (WHERE import_fingerprint IS NOT NULL) kan daarom bij het
--     aanmaken niet op historische gegevens falen, en historische regels worden
--     nooit door deze index geblokkeerd. Historische herimports blijven door de
--     duplicaatcontrole in de app herkend.
--   - Geen wijziging aan RLS, rechten, triggers, functies of andere tabellen.
--   - Geen verplichting: een rij zonder vingerafdruk of bronformaat (handmatig,
--     of een oudere app-versie) blijft gewoon mogelijk.
--
-- VERGRENDELING
--   CREATE UNIQUE INDEX (niet CONCURRENTLY: de editor voert één transactie uit)
--   houdt kort een SHARE-lock op bank_transactions: lezen gaat door, schrijven
--   wacht. Op een rustig moment uitvoeren, met `SET lock_timeout = '5s';`.
--
-- PRODUCTIE
--   Toepassen uitsluitend via de Lovable Cloud SQL editor van project
--   alxlbdhpbwlehbdbfejw, ná review en een expliciete GO van de eigenaar:
--   PRE (supabase/rollout/20261020120000_add_bank_transaction_import_fingerprint/
--   preflight.sql) → deze migratie → POST (postcheck.sql). Daarna `types.ts`
--   regenereren (er komen twee kolommen bij). Deze PR past niets toe. De app werkt
--   vóór en na toepassing: zij stuurt de vingerafdruk pas mee zodra de kolom
--   bestaat.
--
-- ROLLBACK (handmatig; verwijdert alleen de vingerafdrukken, geen transacties):
-- ROLLBACK-BEGIN
--   DROP INDEX IF EXISTS public.bank_transactions_client_import_fingerprint_key;
--   ALTER TABLE public.bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_import_fingerprint_format;
--   ALTER TABLE public.bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_import_source_known;
--   ALTER TABLE public.bank_transactions DROP COLUMN IF EXISTS import_fingerprint;
--   ALTER TABLE public.bank_transactions DROP COLUMN IF EXISTS import_source;
-- ROLLBACK-END
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten: fail closed ───────────────────────────────────────────────

DO $migratie$
BEGIN
  IF to_regclass('public.bank_transactions') IS NULL THEN
    RAISE EXCEPTION 'Vereist: public.bank_transactions';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.bank_transactions'::regclass AND attname = 'client_id' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'Vereist: public.bank_transactions.client_id';
  END IF;
END
$migratie$;

-- ── 1. De kolom (optioneel, geen standaardwaarde, geen backfill) ────────────

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS import_fingerprint text;

COMMENT ON COLUMN public.bank_transactions.import_fingerprint IS
  'SHA-256 (hex) van een afschriftregel bij import: bankreferentie+datum+bedrag, of afschriftsleutel+positie. Uniek per administratie; NULL voor rijen van vóór 20261020120000 en voor niet-geïmporteerde rijen.';

-- ── 2. Vorm: precies 64 kleine hex-tekens, of NULL ──────────────────────────

DO $migratie$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bank_transactions_import_fingerprint_format'
      AND conrelid = 'public.bank_transactions'::regclass
  ) THEN
    ALTER TABLE public.bank_transactions
      ADD CONSTRAINT bank_transactions_import_fingerprint_format
      CHECK (import_fingerprint IS NULL OR import_fingerprint ~ '^[0-9a-f]{64}$');
  END IF;
END
$migratie$;

-- ── 3. Bronformaat (optioneel; alleen de twee formaten die de app inleest) ──

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS import_source text;

COMMENT ON COLUMN public.bank_transactions.import_source IS
  'Bestandsformaat waaruit de regel is geïmporteerd: mt940 of camt053. Bepaalt hoe de referentie wordt gelezen. NULL voor rijen van vóór 20261020120000.';

DO $migratie$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bank_transactions_import_source_known'
      AND conrelid = 'public.bank_transactions'::regclass
  ) THEN
    ALTER TABLE public.bank_transactions
      ADD CONSTRAINT bank_transactions_import_source_known
      CHECK (import_source IS NULL OR import_source IN ('mt940', 'camt053'));
  END IF;
END
$migratie$;

-- ── 4. Uniek per administratie, alleen waar een vingerafdruk is ─────────────

CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_client_import_fingerprint_key
  ON public.bank_transactions (client_id, import_fingerprint)
  WHERE import_fingerprint IS NOT NULL;
