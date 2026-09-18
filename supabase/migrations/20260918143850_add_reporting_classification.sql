-- Migration: reporting classification on grootboekrekeningen
-- (Balans / Winst-en-verliesrekening, PR 1: schema only)
--
-- Purpose: give every grootboekrekening an EXPLICIT, database-validated place
-- in the Balans or the Winst-en-verliesrekening, so that the coming statement
-- engine can classify accounts without guessing. Four nullable columns, five
-- named CHECK constraints, nothing else.
--
-- Why `categorie` is not enough (established by the read-only research that
-- preceded this PR, see PROJECT_MAP.md "Balans/W&V"):
--   • public.grootboekrekeningen.categorie is free TEXT with DEFAULT 'kosten'
--     and no CHECK, enum or FK;
--   • 'passiva' mixes equity, liabilities, VAT, suspense and result accounts;
--   • 'activa' mixes fixed and current assets;
--   • 'kosten' mixes cost of sales, depreciation, financial expense and
--     operating expense.
-- `categorie` therefore stays exactly as it is — it drives today's screens —
-- and is NOT read, NOT rewritten and NOT constrained by this file.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FOUR COLUMNS (all NULL by default, no DEFAULT expression)
--
--   statement_type  text     'balans' | 'winst_verlies'
--   report_group    text     one of the groups of that statement (below)
--   normal_side     text     'debet' | 'credit' — presentation side only
--   report_sort     integer  >= 0 — presentation order inside a group
--
--   balans groups:        vaste_activa, vlottende_activa, eigen_vermogen,
--                         voorzieningen, langlopende_schulden,
--                         kortlopende_schulden, prive
--   winst_verlies groups: netto_omzet, kostprijs_omzet, personeelskosten,
--                         afschrijvingen, overige_bedrijfskosten,
--                         financiele_baten_lasten, belastingen,
--                         overig_resultaat
--
-- CROSS-FIELD RULES (grootboekrekeningen_reporting_pair_check)
--   • statement_type IS NULL  ⇒  report_group IS NULL   (an unclassified account)
--   • report_group IS NOT NULL ⇒ statement_type IS NOT NULL
--   • statement_type = 'balans'        ⇒ report_group is a balans group
--   • statement_type = 'winst_verlies' ⇒ report_group is a winst_verlies group
--   Read strictly: a classified account carries BOTH fields. `balans` with a
--   NULL group is refused, so "classified" is never half a statement.
--   normal_side and report_sort are independent and may stay NULL even when
--   the account is classified; whether the engine requires them is a decision
--   for the UI/engine phase, not for this schema.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--   • no backfill, no UPDATE, no INSERT, no DELETE — every existing row is
--     valid the moment the constraints exist, because all four columns are NULL
--     on every existing row and every constraint accepts NULL;
--   • no account-number ranges, no derivation from categorie / omschrijving /
--     seed position — classification is entered explicitly, later, by the UI;
--   • no change to categorie, no CHECK on categorie, no default change, no
--     change to any existing column;
--   • no trigger, no function, no RLS policy, no grant, no index — the
--     existing role policies (20260613001452) already cover these columns:
--     `accountant` may INSERT/UPDATE, `read_only` may SELECT;
--   • no rgs_code, no annual-accounts taxonomy, no per-client override table:
--     classification belongs to the grootboekrekening row itself; an
--     organisation-wide account (client_id IS NULL) carries one classification
--     for every administratie, a client-specific account carries its own.
--
-- Classification is NOT authoritative until it has been filled in: until then
-- every row is "niet geclassificeerd" and the statement engine (later PR) must
-- treat it as such. Generated types (src/integrations/supabase/types.ts) are
-- regenerated from the production schema AFTER this migration has been applied
-- through the Lovable Cloud SQL editor; they are not edited here.
--
-- LOCKING / REWRITE: ADD COLUMN of a nullable column without DEFAULT is a
-- catalog-only change in PostgreSQL (no table rewrite). ADD CONSTRAINT ... CHECK
-- takes a brief ACCESS EXCLUSIVE lock and scans the table once to validate;
-- the chart of accounts is small. Proved on a throwaway cluster: the table's
-- relfilenode is identical before and after (supabase/tests/reporting-classification/).
--
-- Idempotent by NAME: ADD COLUMN IF NOT EXISTS, and each constraint is added
-- only when a constraint of that name does not yet exist on the table.
-- Re-running the file adds nothing when the names exist; it does NOT verify
-- that an existing constraint of the same name has this definition.
--
-- OWNER DECISION, recorded: the pair check reads rules C/D strictly — a
-- statement_type without a report_group is refused (the requirement relaxes
-- normal_side explicitly and report_group not at all). If a half-classified
-- intermediate state is wanted later, the lenient form is a one-line change
-- per branch: `THEN report_group IS NULL OR report_group IN (...)` (still
-- three-valued-safe: it yields TRUE, not NULL, for a NULL group).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- rollback (manual, documented only — NOT executed by this file):
--   Drops the five constraints first, then the four columns. This LOSES every
--   classification value that has been entered since the migration was
--   applied; there is no UI yet and the columns start empty, so at the time of
--   this PR the loss is nil and the rollback risk is low. DROP COLUMN alone
--   would already drop the CHECKs; the two-step form is deliberate. After a
--   rollback that follows a type regeneration, regenerate
--   src/integrations/supabase/types.ts again from the production schema.
--
--   ALTER TABLE public.grootboekrekeningen
--     DROP CONSTRAINT IF EXISTS grootboekrekeningen_reporting_pair_check,
--     DROP CONSTRAINT IF EXISTS grootboekrekeningen_report_group_check,
--     DROP CONSTRAINT IF EXISTS grootboekrekeningen_statement_type_check,
--     DROP CONSTRAINT IF EXISTS grootboekrekeningen_normal_side_check,
--     DROP CONSTRAINT IF EXISTS grootboekrekeningen_report_sort_check;
--   ALTER TABLE public.grootboekrekeningen
--     DROP COLUMN IF EXISTS statement_type,
--     DROP COLUMN IF EXISTS report_group,
--     DROP COLUMN IF EXISTS normal_side,
--     DROP COLUMN IF EXISTS report_sort;
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. The four nullable columns. No DEFAULT: existing and future rows start NULL.
ALTER TABLE public.grootboekrekeningen
  ADD COLUMN IF NOT EXISTS statement_type text NULL,
  ADD COLUMN IF NOT EXISTS report_group   text NULL,
  ADD COLUMN IF NOT EXISTS normal_side    text NULL,
  ADD COLUMN IF NOT EXISTS report_sort    integer NULL;

-- 2. Named CHECK constraints. Each one accepts NULL, so no existing row can
--    violate any of them. Added only when absent, so the file is idempotent.
DO $$
BEGIN
  -- statement_type ∈ {balans, winst_verlies} or NULL
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.grootboekrekeningen'::regclass
      AND conname  = 'grootboekrekeningen_statement_type_check'
  ) THEN
    ALTER TABLE public.grootboekrekeningen
      ADD CONSTRAINT grootboekrekeningen_statement_type_check
      CHECK (statement_type IS NULL OR statement_type IN ('balans', 'winst_verlies'));
  END IF;

  -- report_group ∈ the fifteen known groups or NULL (the domain, independent
  -- of the statement; the pair check below ties it to the right statement)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.grootboekrekeningen'::regclass
      AND conname  = 'grootboekrekeningen_report_group_check'
  ) THEN
    ALTER TABLE public.grootboekrekeningen
      ADD CONSTRAINT grootboekrekeningen_report_group_check
      CHECK (report_group IS NULL OR report_group IN (
        'vaste_activa', 'vlottende_activa', 'eigen_vermogen', 'voorzieningen',
        'langlopende_schulden', 'kortlopende_schulden', 'prive',
        'netto_omzet', 'kostprijs_omzet', 'personeelskosten', 'afschrijvingen',
        'overige_bedrijfskosten', 'financiele_baten_lasten', 'belastingen',
        'overig_resultaat'
      ));
  END IF;

  -- statement_type and report_group are NULL together, or set together with
  -- the group belonging to the statement.
  --
  -- Written as a CASE on statement_type and with explicit IS NOT NULL guards
  -- on purpose: a CHECK passes when its expression is NULL, and the naive
  -- form `(a IS NULL AND b IS NULL) OR (a = 'balans' AND b IN (...)) OR ...`
  -- evaluates to NULL — and therefore ACCEPTS the row — for NULL + group and
  -- for balans + NULL group. Proved on a real cluster before this rewrite;
  -- the proof now asserts each refused case evaluates to exactly FALSE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.grootboekrekeningen'::regclass
      AND conname  = 'grootboekrekeningen_reporting_pair_check'
  ) THEN
    ALTER TABLE public.grootboekrekeningen
      ADD CONSTRAINT grootboekrekeningen_reporting_pair_check
      CHECK (
        CASE
          WHEN statement_type IS NULL THEN report_group IS NULL
          WHEN statement_type = 'balans' THEN report_group IS NOT NULL AND report_group IN (
            'vaste_activa', 'vlottende_activa', 'eigen_vermogen', 'voorzieningen',
            'langlopende_schulden', 'kortlopende_schulden', 'prive'
          )
          WHEN statement_type = 'winst_verlies' THEN report_group IS NOT NULL AND report_group IN (
            'netto_omzet', 'kostprijs_omzet', 'personeelskosten', 'afschrijvingen',
            'overige_bedrijfskosten', 'financiele_baten_lasten', 'belastingen',
            'overig_resultaat'
          )
          ELSE false
        END
      );
  END IF;

  -- normal_side ∈ {debet, credit} or NULL — never forced, even when classified
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.grootboekrekeningen'::regclass
      AND conname  = 'grootboekrekeningen_normal_side_check'
  ) THEN
    ALTER TABLE public.grootboekrekeningen
      ADD CONSTRAINT grootboekrekeningen_normal_side_check
      CHECK (normal_side IS NULL OR normal_side IN ('debet', 'credit'));
  END IF;

  -- report_sort >= 0 or NULL
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.grootboekrekeningen'::regclass
      AND conname  = 'grootboekrekeningen_report_sort_check'
  ) THEN
    ALTER TABLE public.grootboekrekeningen
      ADD CONSTRAINT grootboekrekeningen_report_sort_check
      CHECK (report_sort IS NULL OR report_sort >= 0);
  END IF;
END
$$;
