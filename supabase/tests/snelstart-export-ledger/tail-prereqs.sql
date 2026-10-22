-- TEST DOUBLE — vereisten van latere migraties, alleen voor de wegwerpdatabase
-- van run-proof.sh. De gedeelde bootstraps (../opening-balance/bootstrap.sql,
-- ../bank-direct-allocation-guard/bootstrap-sources.sql) bootsen een deel van
-- het schema na. Latere migraties van andere pakketten (o.a. B2-08/B2-08c,
-- 20261021160000…165000) eisen meer en weigeren fail-closed als het ontbreekt:
--   * Supabase Storage: storage.buckets, storage.objects (met owner en
--     owner_id) en storage.foldername(text);
--   * de kolommen purchase_invoices.file_path en sales_invoices.pdf_path
--     (bestaan in productie; de bootstrap laat ze weg).
-- public.is_organization_member(uuid, uuid) komt NIET hieruit: run-proof.sh
-- neemt het echte lichaam uit 20260530211249 over.
-- Zo blijft de VOLLEDIGE staart van de keten toepasbaar en wordt altijd de
-- effectieve (nieuwste) post_purchase_invoice() bewezen.
-- Vorm overgenomen van supabase/tests/intake-authz-storage/bootstrap.sql
-- (branch feature/herstel-p2-autorisatie-intake). Idempotent: bestaat
-- storage al, dan verandert er niets.

CREATE SCHEMA IF NOT EXISTS storage;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL UNIQUE,
  owner              uuid,
  public             boolean DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id        text REFERENCES storage.buckets (id),
  name             text,
  owner            uuid,
  owner_id         text,
  metadata         jsonb,
  path_tokens      text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;

-- Definitie van Supabase Storage: alle padsegmenten behalve het laatste.
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1:array_length(_parts, 1) - 1];
END $$;
GRANT EXECUTE ON FUNCTION storage.foldername(text) TO anon, authenticated, service_role;

-- ── documentpaden (productiekolommen die de bootstrap weglaat) ──────────────
ALTER TABLE public.purchase_invoices ADD COLUMN IF NOT EXISTS file_path text;
ALTER TABLE public.sales_invoices    ADD COLUMN IF NOT EXISTS pdf_path  text;
