-- Step 1: Make client_id nullable
ALTER TABLE public.grootboekrekeningen 
  ALTER COLUMN client_id DROP NOT NULL;

-- Step 2: Deduplicate - keep only one entry per nummer (the first one created)
WITH duplicates AS (
  SELECT id, nummer, ROW_NUMBER() OVER (PARTITION BY nummer ORDER BY created_at ASC) as rn
  FROM public.grootboekrekeningen
)
DELETE FROM public.grootboekrekeningen 
WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

-- Step 3: Drop existing unique constraint if it involves client_id
ALTER TABLE public.grootboekrekeningen 
  DROP CONSTRAINT IF EXISTS grootboekrekeningen_nummer_client_id_key;

-- Step 4: Add global unique constraint on nummer
ALTER TABLE public.grootboekrekeningen 
  ADD CONSTRAINT grootboekrekeningen_nummer_key UNIQUE (nummer);