-- ═════════════════════════════════════════════════════════════════════════════
-- B2-08c (vervolg) — DOCUMENTPOINTER RACE-VAST, ALLEEN owner_id, EN GEBONDEN
-- AAN DE ADMINISTRATIE (hertoets REVIEW-P2c: R-02, R-03, R-01)
--
-- Basis: 20261021164000 (guard_invoice_document_pointer). Deze migratie
-- vervangt alleen de triggerfunctie; de triggers zelf blijven staan.
--
-- R-02 — (b) "één factuur per pad" was niet race-vast: twee gelijktijdige
--   transacties zagen elkaars nog niet gecommitte rij niet en slaagden allebei.
--   Nu eerst pg_advisory_xact_lock op het pad (exact zoals (b) het vergelijkt,
--   met een vaste naamruimte). De tweede transactie wacht tot de eerste klaar
--   is; in READ COMMITTED ziet de EXISTS van (b) daarna de gecommitte rij.
--
-- R-03 — (c) leest alleen nog storage.objects.owner_id (wat de Storage-API
--   zet). De verouderde kolom `owner` wordt niet meer gelezen, zodat het
--   wegvallen ervan de verkoop-upload niet stillegt. Een object met alleen
--   `owner` (zonder owner_id) wordt niet meer geclaimd (fail-closed).
--
-- R-01 — een ex-lid kon een eigen, verweesde upload uit zijn oude
--   organisatie aan een factuur in een andere organisatie hangen. De
--   voorgestelde toets "pad-uid is huidig lid van de doelorganisatie" sluit
--   dat niet: door (a) is de uploader de schrijver zelf, en RLS eist al dat
--   die in de doelorganisatie mag schrijven. Wat het wel sluit, en klein en
--   fail-closed is: het pad is gebonden aan de administratie waarvoor het is
--   geüpload. Het pad moet exact de map van de factuur zijn —
--     verkoop:  <uid>/sales/<client_id>/<bestand>   (Verkoop.tsx)
--     inkoop:   <uid>/<client_id>/<bestand>         (process-invoice)
--   — en die administratie moet in de organisatie van de factuur liggen
--   (is organization_id nog NULL, dan leidt set_organization_id_trigger die
--   na deze trigger af uit de klant; zie B-01 in REVIEW-P2d).
--   Een upload voor administratie X van organisatie A kan zo nooit aan een
--   factuur in organisatie B worden gehangen.
--
-- Ongewijzigd: (a) eerste padsegment = auth.uid(); (b) geen andere factuur
--   met dit pad; service role / edge functions (auth.uid() NULL), een
--   ongewijzigd pad en NULL worden niet getoetst; neutrale 42501;
--   SECURITY DEFINER, search_path=public, geen EXECUTE voor app-rollen.
--
-- GEEN DATAWIJZIGING. IDEMPOTENT: CREATE OR REPLACE FUNCTION + REVOKE.
--
-- rollback: de functie uit 20261021164000 opnieuw toepassen (dat blok is
--   zelf CREATE OR REPLACE; de triggers blijven ongewijzigd staan).
-- ═════════════════════════════════════════════════════════════════════════════

DO $migratie$
BEGIN
  IF to_regprocedure('public.guard_invoice_document_pointer()') IS NULL THEN
    RAISE EXCEPTION 'R-01/R-02/R-03 vereisen public.guard_invoice_document_pointer() (20261021164000)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'storage.objects'::regclass AND attname = 'owner_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'R-03 vereist storage.objects.owner_id';
  END IF;
  IF NOT has_table_privilege(current_user, 'storage.objects', 'SELECT')
     OR NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
     OR NOT has_table_privilege(current_user, 'public.clients', 'SELECT') THEN
    RAISE EXCEPTION 'R-01/R-03: rol % kan storage.objects of public.clients niet zonder RLS lezen', current_user;
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
  v_uid    uuid := auth.uid();
  v_path   text;
  v_old    text;
  v_folder text[];
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

  v_folder := storage.foldername(v_path);

  -- R-02: serialiseer claims op hetzelfde pad vóór (b).
  PERFORM pg_advisory_xact_lock(hashtext('boekassist.invoice_document_pointer:' || v_path));

  IF v_folder[1] IS DISTINCT FROM v_uid::text                                           -- (a)
     -- R-01: exact de map van de factuur, en de administratie hoort bij de organisatie
     OR v_folder IS DISTINCT FROM (CASE WHEN TG_TABLE_NAME = 'purchase_invoices'
                                       THEN ARRAY[v_uid::text, NEW.client_id::text]
                                       ELSE ARRAY[v_uid::text, 'sales', NEW.client_id::text] END)
     OR NOT EXISTS (SELECT 1 FROM public.clients c
                    WHERE c.id = NEW.client_id
                      -- B-01: de app stuurt geen organization_id mee; die leidt
                      -- set_organization_id_trigger pas ná deze trigger af uit
                      -- de klant (BEFORE-triggers vuren alfabetisch). NULL
                      -- betekent dus "de organisatie van de klant"; een
                      -- gespoofde organisatie weigert RLS daarna alsnog.
                      AND c.organization_id = COALESCE(NEW.organization_id, c.organization_id))
     OR EXISTS (SELECT 1 FROM public.purchase_invoices p                               -- (b)
                WHERE p.file_path = v_path
                  AND (TG_TABLE_NAME <> 'purchase_invoices' OR p.id IS DISTINCT FROM NEW.id))
     OR EXISTS (SELECT 1 FROM public.sales_invoices s
                WHERE s.pdf_path = v_path
                  AND (TG_TABLE_NAME <> 'sales_invoices' OR s.id IS DISTINCT FROM NEW.id))
     OR NOT EXISTS (SELECT 1 FROM storage.objects o                                    -- (c), R-03
                    WHERE o.bucket_id = 'invoices' AND o.name = v_path
                      AND o.owner_id = v_uid::text) THEN
    RAISE EXCEPTION 'Dit document kan niet aan deze factuur worden gekoppeld.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_invoice_document_pointer() FROM PUBLIC, anon, authenticated, service_role;
