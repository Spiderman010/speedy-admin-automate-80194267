-- Add referential integrity for purchase_invoice_lines.grootboekrekening_id.
-- Safe to re-run: the index uses IF NOT EXISTS and the FK is added only when
-- an equivalent FK is not already present.
-- rollback: DROP INDEX IF EXISTS public.idx_purchase_invoice_lines_grootboekrekening_id;
-- rollback: ALTER TABLE public.purchase_invoice_lines DROP CONSTRAINT IF EXISTS purchase_invoice_lines_grootboekrekening_id_fkey;

CREATE INDEX IF NOT EXISTS idx_purchase_invoice_lines_grootboekrekening_id
  ON public.purchase_invoice_lines (grootboekrekening_id);

DO $$
BEGIN
  IF EXISTS (
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
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND t.relname = 'purchase_invoice_lines'
      AND c.conname = 'purchase_invoice_lines_grootboekrekening_id_fkey'
  ) THEN
    RAISE NOTICE 'Constraint purchase_invoice_lines_grootboekrekening_id_fkey already exists, skipping';
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
      AND t.relname = 'purchase_invoice_lines'
      AND rn.nspname = 'public'
      AND rt.relname = 'grootboekrekeningen'
      AND array_length(c.conkey, 1) = 1
      AND array_length(c.confkey, 1) = 1
      AND a.attname = 'grootboekrekening_id'
      AND ra.attname = 'id'
  ) THEN
    RAISE NOTICE 'Equivalent FK from purchase_invoice_lines.grootboekrekening_id to grootboekrekeningen.id already exists, skipping';
  ELSE
    ALTER TABLE public.purchase_invoice_lines
      ADD CONSTRAINT purchase_invoice_lines_grootboekrekening_id_fkey
      FOREIGN KEY (grootboekrekening_id)
      REFERENCES public.grootboekrekeningen (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;
