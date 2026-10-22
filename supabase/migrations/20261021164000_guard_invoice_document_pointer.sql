-- ═════════════════════════════════════════════════════════════════════════════
-- B2-08c — EEN FACTUUR KAN NIET NAAR ANDERMANS DOCUMENT WIJZEN
--
-- HET PROBLEEM (review Codex op #296, bevestigd)
--   20261021160000 geeft leestoegang tot een object in de bucket `invoices`
--   als er een inkoop- of verkoopfactuur met dat pad bestaat in een
--   organisatie waarvan de lezer NU lid is (en verwijderrecht als het pad
--   bovendien met zijn uid begint). Het pad zelf (purchase_invoices.file_path,
--   sales_invoices.pdf_path) is onder RLS echter vrij te schrijven door wie de
--   factuur mag aanmaken of wijzigen. Een ex-lid van organisatie X dat nog
--   assistent is in Y zet in Y een factuur op de naam van zijn oude object
--   uit X, en kan dat document dan weer lezen en verwijderen. Hetzelfde werkt
--   voor elk objectnaam die iemand kent. Dat ondergraaft de P0-fix B2-08.
--
-- DE FIX
--   Een BEFORE INSERT/UPDATE-trigger op beide tabellen. Is het pad nieuw of
--   gewijzigd, niet NULL, en is er een ingelogde gebruiker (auth.uid() niet
--   NULL), dan wordt geweigerd met een neutrale 42501 als:
--     (a) het eerste padsegment niet de uid van de gebruiker is;
--     (b) het pad al door een ándere inkoop- of verkoopfactuur wordt gebruikt
--         (elke organisatie);
--     (c) er in `invoices` geen object met dat pad is dat de gebruiker zelf
--         heeft geüpload (storage.objects.owner of owner_id = auth.uid()).
--   Een pad leegmaken (NULL) mag: dat geeft geen toegang.
--
-- LEGITIEME STROMEN (in het harnas aangetoond)
--   * Handmatige verkoopfactuur (Verkoop.tsx): de gebruiker uploadt zelf naar
--     `<uid>/sales/<client>/…` (Storage zet owner = uid) en zet daarna pdf_path
--     op dat pad: (a), (b) en (c) kloppen.
--   * Edge functions process-invoice / process-sales-invoice: schrijven met de
--     service role; auth.uid() is daar NULL, dus de trigger laat ze door. Hun
--     uploads hebben owner NULL en kunnen dus nooit door een gebruiker worden
--     "overgenomen" via (c).
--   * Werkbank en bewerkdialogen: wijzigen file_path/pdf_path niet; een UPDATE
--     die het pad ongewijzigd laat, wordt niet getoetst.
--
-- SECURITY DEFINER: (b) en (c) moeten rijen zien buiten de RLS van de
--   aanroeper (andere organisaties, storage.objects). De functie leest alleen
--   en geeft niets terug behalve "ja/nee". Geen EXECUTE voor app-rollen
--   (een trigger heeft dat niet nodig).
--
-- GEEN DATAWIJZIGING: bestaande rijen worden niet aangeraakt; de trigger
--   toetst alleen nieuwe of gewijzigde paden. De preflight telt bestaande
--   paden die door meer dan één factuur worden gebruikt.
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE.
--
-- rollback:
--   DROP TRIGGER IF EXISTS guard_invoice_document_pointer_trigger ON public.purchase_invoices;
--   DROP TRIGGER IF EXISTS guard_invoice_document_pointer_trigger ON public.sales_invoices;
--   DROP FUNCTION IF EXISTS public.guard_invoice_document_pointer();
-- ═════════════════════════════════════════════════════════════════════════════

DO $migratie$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'B2-08c vereist storage.objects';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'storage.objects'::regclass AND attname = 'owner' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'storage.objects'::regclass AND attname = 'owner_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'B2-08c vereist storage.objects.owner en storage.objects.owner_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.purchase_invoices'::regclass AND attname = 'file_path' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.sales_invoices'::regclass AND attname = 'pdf_path' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'B2-08c vereist purchase_invoices.file_path en sales_invoices.pdf_path';
  END IF;
  IF to_regprocedure('storage.foldername(text)') IS NULL THEN
    RAISE EXCEPTION 'B2-08c vereist storage.foldername(text)';
  END IF;
  -- De functie wordt eigendom van de rol die deze migratie draait. Die moet
  -- storage.objects kunnen lezen zonder RLS, anders zou (c) alles weigeren.
  IF NOT has_table_privilege(current_user, 'storage.objects', 'SELECT')
     OR NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'B2-08c: rol % kan storage.objects niet zonder RLS lezen', current_user;
  END IF;
END
$migratie$;

CREATE OR REPLACE FUNCTION public.guard_invoice_document_pointer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_path text;
  v_old  text;
BEGIN
  IF TG_TABLE_NAME = 'purchase_invoices' THEN
    v_path := NEW.file_path;
    IF TG_OP = 'UPDATE' THEN v_old := OLD.file_path; END IF;
  ELSE
    v_path := NEW.pdf_path;
    IF TG_OP = 'UPDATE' THEN v_old := OLD.pdf_path; END IF;
  END IF;

  -- Service role / edge function / migratie (geen gebruiker), geen pad, of
  -- een ongewijzigd pad: niets te toetsen.
  IF v_uid IS NULL OR v_path IS NULL
     OR (TG_OP = 'UPDATE' AND v_path IS NOT DISTINCT FROM v_old) THEN
    RETURN NEW;
  END IF;

  IF (storage.foldername(v_path))[1] IS DISTINCT FROM v_uid::text                       -- (a)
     OR EXISTS (SELECT 1 FROM public.purchase_invoices p                               -- (b)
                WHERE p.file_path = v_path
                  AND (TG_TABLE_NAME <> 'purchase_invoices' OR p.id IS DISTINCT FROM NEW.id))
     OR EXISTS (SELECT 1 FROM public.sales_invoices s
                WHERE s.pdf_path = v_path
                  AND (TG_TABLE_NAME <> 'sales_invoices' OR s.id IS DISTINCT FROM NEW.id))
     OR NOT EXISTS (SELECT 1 FROM storage.objects o                                    -- (c)
                    WHERE o.bucket_id = 'invoices' AND o.name = v_path
                      AND (o.owner = v_uid OR o.owner_id = v_uid::text)) THEN
    RAISE EXCEPTION 'Dit document kan niet aan deze factuur worden gekoppeld.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_invoice_document_pointer() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_invoice_document_pointer_trigger ON public.purchase_invoices;
CREATE TRIGGER guard_invoice_document_pointer_trigger
  BEFORE INSERT OR UPDATE OF file_path ON public.purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_document_pointer();

DROP TRIGGER IF EXISTS guard_invoice_document_pointer_trigger ON public.sales_invoices;
CREATE TRIGGER guard_invoice_document_pointer_trigger
  BEFORE INSERT OR UPDATE OF pdf_path ON public.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_document_pointer();
