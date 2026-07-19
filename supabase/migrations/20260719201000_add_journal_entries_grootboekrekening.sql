-- Add active grootboekrekening reference to journal_entries without removing
-- legacy ledger_account columns yet.
-- rollback: DROP INDEX IF EXISTS public.idx_journal_entries_grootboekrekening_id;
-- rollback: ALTER TABLE public.journal_entries DROP CONSTRAINT IF EXISTS journal_entries_grootboekrekening_id_fkey;
-- rollback: ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS grootboekrekening_id;

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS grootboekrekening_id uuid;

WITH backfill_candidates AS (
  SELECT
    entry.id AS journal_entry_id,
    grootboek.id AS grootboekrekening_id,
    COUNT(*) OVER (PARTITION BY entry.id) AS match_count
  FROM public.journal_entries AS entry
  JOIN public.grootboekrekeningen AS grootboek
    ON grootboek.organization_id = entry.organization_id
   AND lower(trim(entry.ledger_account_text)) = lower(trim(grootboek.nummer::text || ' - ' || grootboek.omschrijving))
  WHERE entry.grootboekrekening_id IS NULL
    AND entry.ledger_account_text IS NOT NULL
    AND btrim(entry.ledger_account_text) <> ''
)
UPDATE public.journal_entries AS entry
SET grootboekrekening_id = candidate.grootboekrekening_id
FROM backfill_candidates AS candidate
WHERE entry.id = candidate.journal_entry_id
  AND entry.grootboekrekening_id IS NULL
  AND candidate.match_count = 1;

CREATE INDEX IF NOT EXISTS idx_journal_entries_grootboekrekening_id
  ON public.journal_entries (grootboekrekening_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t
      ON t.oid = c.conrelid
    JOIN pg_namespace n
      ON n.oid = t.relnamespace
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'journal_entries'
      AND c.conname = 'journal_entries_grootboekrekening_id_fkey'
  ) THEN
    RAISE NOTICE 'Constraint journal_entries_grootboekrekening_id_fkey already exists, skipping';
  ELSIF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t
      ON t.oid = c.conrelid
    JOIN pg_namespace n
      ON n.oid = t.relnamespace
    JOIN pg_class rt
      ON rt.oid = c.confrelid
    JOIN pg_namespace rn
      ON rn.oid = rt.relnamespace
    JOIN pg_attribute a
      ON a.attrelid = t.oid
     AND a.attnum = ANY (c.conkey)
    JOIN pg_attribute ra
      ON ra.attrelid = rt.oid
     AND ra.attnum = ANY (c.confkey)
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'journal_entries'
      AND rn.nspname = 'public'
      AND rt.relname = 'grootboekrekeningen'
      AND array_length(c.conkey, 1) = 1
      AND array_length(c.confkey, 1) = 1
      AND a.attname = 'grootboekrekening_id'
      AND ra.attname = 'id'
  ) THEN
    RAISE NOTICE 'Equivalent FK from journal_entries.grootboekrekening_id to grootboekrekeningen.id already exists, skipping';
  ELSE
    ALTER TABLE public.journal_entries
      ADD CONSTRAINT journal_entries_grootboekrekening_id_fkey
      FOREIGN KEY (grootboekrekening_id)
      REFERENCES public.grootboekrekeningen (id)
      ON DELETE SET NULL;
  END IF;
END
$$;
