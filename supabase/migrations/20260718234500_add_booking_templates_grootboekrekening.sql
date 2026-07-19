-- Add active grootboekrekening reference to booking_templates without removing
-- legacy ledger_account columns yet.
-- rollback: DROP INDEX IF EXISTS public.idx_booking_templates_grootboekrekening_id;
-- rollback: ALTER TABLE public.booking_templates DROP CONSTRAINT IF EXISTS booking_templates_grootboekrekening_id_fkey;
-- rollback: ALTER TABLE public.booking_templates DROP COLUMN IF EXISTS grootboekrekening_id;

ALTER TABLE public.booking_templates
  ADD COLUMN IF NOT EXISTS grootboekrekening_id uuid;

WITH backfill_candidates AS (
  SELECT
    template.id AS template_id,
    grootboek.id AS grootboekrekening_id,
    COUNT(*) OVER (PARTITION BY template.id) AS match_count
  FROM public.booking_templates AS template
  JOIN public.grootboekrekeningen AS grootboek
    ON grootboek.organization_id = template.organization_id
   AND lower(trim(template.ledger_account_text)) = lower(trim(grootboek.nummer::text || ' - ' || grootboek.omschrijving))
  WHERE template.grootboekrekening_id IS NULL
    AND template.ledger_account_text IS NOT NULL
    AND btrim(template.ledger_account_text) <> ''
)
UPDATE public.booking_templates AS template
SET grootboekrekening_id = candidate.grootboekrekening_id
FROM backfill_candidates AS candidate
WHERE template.id = candidate.template_id
  AND template.grootboekrekening_id IS NULL
  AND candidate.match_count = 1;

CREATE INDEX IF NOT EXISTS idx_booking_templates_grootboekrekening_id
  ON public.booking_templates (grootboekrekening_id);

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
      AND t.relname = 'booking_templates'
      AND c.conname = 'booking_templates_grootboekrekening_id_fkey'
  ) THEN
    RAISE NOTICE 'Constraint booking_templates_grootboekrekening_id_fkey already exists, skipping';
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
      AND t.relname = 'booking_templates'
      AND rn.nspname = 'public'
      AND rt.relname = 'grootboekrekeningen'
      AND array_length(c.conkey, 1) = 1
      AND array_length(c.confkey, 1) = 1
      AND a.attname = 'grootboekrekening_id'
      AND ra.attname = 'id'
  ) THEN
    RAISE NOTICE 'Equivalent FK from booking_templates.grootboekrekening_id to grootboekrekeningen.id already exists, skipping';
  ELSE
    ALTER TABLE public.booking_templates
      ADD CONSTRAINT booking_templates_grootboekrekening_id_fkey
      FOREIGN KEY (grootboekrekening_id)
      REFERENCES public.grootboekrekeningen (id)
      ON DELETE SET NULL;
  END IF;
END
$$;
