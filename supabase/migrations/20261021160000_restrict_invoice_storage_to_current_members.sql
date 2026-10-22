-- ═════════════════════════════════════════════════════════════════════════════
-- B2-08 — OPSLAG 'invoices': LEZEN EN VERWIJDEREN ALLEEN NOG DOOR HUIDIGE LEDEN
--
-- HET PROBLEEM
--   Alle documenten staan onder `<uid van de uploader>/…` (process-invoice:
--   `<uid>/<client_id>/<uuid>.<ext>`, process-sales-invoice en de handmatige
--   verkoopupload: `<uid>/sales/<client_id>/…`). De policies uit
--   20260802201226 (r. 50-89) geven de eigenaar van die map onvoorwaardelijk
--   leesrecht (r. 57) en verwijderrecht (r. 82-89), los van lidmaatschap. Een
--   medewerker die uit de organisatie is verwijderd ziet nul facturen, maar kan
--   al zijn eigen uploads nog lezen en verwijderen, terwijl de facturen ernaar
--   blijven verwijzen (nulmeting B2-08, bevestigd door F2 op de echte policies).
--
-- DE ORGANISATIE VAN EEN OBJECT
--   Een object hoort bij de organisatie van de factuur die ernaar verwijst:
--   purchase_invoices.file_path of sales_invoices.pdf_path = storage.objects.name
--   (dat is ook de koppeling die de bestaande org-leestak al gebruikt). Het
--   padsegment met de klant is niet gezaghebbend: de uploader kiest het zelf
--   (de INSERT-policy toetst alleen het eerste segment) en oude paden kunnen
--   een ander schema volgen.
--
-- WAT DEZE MIGRATIE DOET (alleen bestaande rechten inperken)
--   SELECT  Alleen nog via een factuur in een organisatie waarvan de lezer NU
--           lid is (is_organization_member, zoals de bestaande org-tak). De
--           onvoorwaardelijke eigen-map-tak vervalt: "eigen map én huidig lid
--           van de organisatie van de verwijzende factuur" is een deelverzameling
--           van de org-tak, die ongewijzigd blijft. Collega's krijgen dus niets
--           wat ze nu niet al hebben.
--   DELETE  Eigen map (zoals nu) ÉN huidig lid van de organisatie van een
--           factuur die naar het object verwijst.
--   INSERT  Ongewijzigd (alleen in de eigen map). Een upload geeft geen toegang
--           tot gegevens; het inperken tot leden vraagt een besluit over het
--           padschema en staat als open punt in het rapport.
--   UPDATE  Er is geen UPDATE-policy en er komt er geen: bijwerken blijft voor
--           iedereen behalve de service role geweigerd.
--
-- WEES-OBJECTEN (geen factuur verwijst ernaar): FAIL-CLOSED
--   Zonder verwijzende factuur is er geen gezaghebbende organisatie; elke
--   andere bron (het padsegment) is door de uploader zelf gekozen. Zulke
--   objecten zijn daarom voor `authenticated` niet meer leesbaar of
--   verwijderbaar; de service role (edge functions, beheer) houdt toegang. De
--   app leest en verwijdert nooit een object zonder factuur: de voorvertoning
--   en de download gaan via file_path/pdf_path, en er bestaat geen
--   verwijderpad in src/ of in de edge functions.
--
-- WAT DEZE MIGRATIE NIET DOET
--   Geen object verplaatst of gewijzigd, geen factuurrij gewijzigd, geen nieuwe
--   rechten, geen bucketinstelling, geen wijziging van de INSERT-policy.
--
-- IDEMPOTENT: DROP POLICY IF EXISTS + CREATE POLICY; een tweede toepassing
--   levert exact dezelfde policies op.
--
-- ROLLBACK (herstelt de blootstelling van B2-08; alleen bij nood):
--   DROP POLICY IF EXISTS "invoices_read_current_org_member" ON storage.objects;
--   DROP POLICY IF EXISTS "invoices_delete_own_folder_current_member" ON storage.objects;
--   CREATE POLICY "invoices_read_own_folder_or_org_member" ON storage.objects
--     FOR SELECT TO authenticated USING (
--       bucket_id = 'invoices' AND (
--         (auth.uid())::text = (storage.foldername(name))[1]
--         OR EXISTS (SELECT 1 FROM public.purchase_invoices pi
--                    WHERE pi.file_path = storage.objects.name AND pi.organization_id IS NOT NULL
--                      AND public.is_organization_member(auth.uid(), pi.organization_id))
--         OR EXISTS (SELECT 1 FROM public.sales_invoices si
--                    WHERE si.pdf_path = storage.objects.name AND si.organization_id IS NOT NULL
--                      AND public.is_organization_member(auth.uid(), si.organization_id))));
--   CREATE POLICY "invoices_delete_own_folder" ON storage.objects
--     FOR DELETE TO authenticated USING (
--       bucket_id = 'invoices' AND (auth.uid())::text = (storage.foldername(name))[1]);
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten: fail closed als iets ontbreekt ────────────────────────────

DO $migratie$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'B2-08 vereist storage.objects';
  END IF;
  IF to_regprocedure('storage.foldername(text)') IS NULL THEN
    RAISE EXCEPTION 'B2-08 vereist storage.foldername(text)';
  END IF;
  IF to_regprocedure('public.is_organization_member(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'B2-08 vereist public.is_organization_member(uuid, uuid) (20260530211249)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'purchase_invoices' AND column_name = 'file_path')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sales_invoices' AND column_name = 'pdf_path') THEN
    RAISE EXCEPTION 'B2-08 vereist purchase_invoices.file_path en sales_invoices.pdf_path';
  END IF;
END
$migratie$;

-- ── 1. Lezen: alleen via een factuur in een organisatie waarvan je nu lid bent ─

DROP POLICY IF EXISTS "invoices_read_own_folder_or_org_member" ON storage.objects;
DROP POLICY IF EXISTS "invoices_read_current_org_member" ON storage.objects;

CREATE POLICY "invoices_read_current_org_member"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'invoices'
  AND (
    EXISTS (
      SELECT 1 FROM public.purchase_invoices pi
      WHERE pi.file_path = storage.objects.name
        AND pi.organization_id IS NOT NULL
        AND public.is_organization_member(auth.uid(), pi.organization_id)
    )
    OR EXISTS (
      SELECT 1 FROM public.sales_invoices si
      WHERE si.pdf_path = storage.objects.name
        AND si.organization_id IS NOT NULL
        AND public.is_organization_member(auth.uid(), si.organization_id)
    )
  )
);

-- ── 2. Verwijderen: eigen map én huidig lid van de organisatie van de factuur ─

DROP POLICY IF EXISTS "invoices_delete_own_folder" ON storage.objects;
DROP POLICY IF EXISTS "invoices_delete_own_folder_current_member" ON storage.objects;

CREATE POLICY "invoices_delete_own_folder_current_member"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'invoices'
  AND (auth.uid())::text = (storage.foldername(name))[1]
  AND (
    EXISTS (
      SELECT 1 FROM public.purchase_invoices pi
      WHERE pi.file_path = storage.objects.name
        AND pi.organization_id IS NOT NULL
        AND public.is_organization_member(auth.uid(), pi.organization_id)
    )
    OR EXISTS (
      SELECT 1 FROM public.sales_invoices si
      WHERE si.pdf_path = storage.objects.name
        AND si.organization_id IS NOT NULL
        AND public.is_organization_member(auth.uid(), si.organization_id)
    )
  )
);

-- ── 3. Uploaden: ongewijzigd ("invoices_upload_own_folder", 20260802201226). ──
--    Bijwerken: geen policy, dus geweigerd. Beide bewust niet aangeraakt.
