-- ═════════════════════════════════════════════════════════════════════════════
-- A2-17 = B1-02 — EEN INKOOPREGEL HOORT BIJ DE ORGANISATIE VAN ZIJN FACTUUR
--
-- HET PROBLEEM
--   purchase_invoice_lines.purchase_invoice_id is een kale uuid: geen FK
--   (20260511193208) en geen controle dat de regel bij dezelfde organisatie
--   hoort als de factuur. De INSERT-policy toetst alleen de eigen
--   organization_id van de regel (20260613001452 r. 125-126). Een lid van
--   organisatie B kan zo met een bekende factuur-uuid een regel aan een
--   inkoopfactuur van A hangen. A ziet die regel niet en kan hem niet
--   verwijderen, maar post_purchase_invoice telt hem wel mee: A kan de factuur
--   blijvend niet boeken (nulmeting A2-17; F2-A op de echte keten).
--
-- WAT DEZE MIGRATIE DOET
--   1. Trigger enforce_purchase_invoice_line_parent_trigger (BEFORE INSERT, en
--      BEFORE UPDATE OF purchase_invoice_id, organization_id):
--      - leest de organisatie van de bovenliggende factuur (SECURITY DEFINER,
--        dus los van wat de aanroeper onder RLS mag zien);
--      - weigert een regel bij een niet-bestaande factuur, bij een factuur
--        zonder organisatie, en bij een factuur van een andere organisatie,
--        alle drie met dezelfde neutrale melding en SQLSTATE 42501, zodat het
--        antwoord niet verraadt of een factuur-uuid bestaat;
--      - vult bij INSERT een ontbrekende organization_id in met die van de
--        factuur. De trigger heet "enforce_…" zodat hij vóór
--        set_organization_id_trigger draait: zonder deze volgorde zou die
--        functie de standaardorganisatie van de gebruiker invullen in plaats
--        van die van de factuur. Bij UPDATE wordt nooit iets ingevuld of
--        herschreven, alleen getoetst; een wijziging van andere kolommen laat
--        de trigger ongemoeid (geen stille herschrijving van bestaande rijen).
--   2. FK purchase_invoice_lines_purchase_invoice_id_fkey → purchase_invoices(id)
--      ON DELETE CASCADE, NOT VALID:
--      - NOT VALID: bestaande rijen worden niet getoetst en niet gewijzigd;
--        nieuwe en gewijzigde verwijzingen wel. VALIDATE pas na een
--        productietelling (zie het rapport, Q11 en de weescontrole).
--      - ON DELETE CASCADE houdt het huidige verwijdergedrag van de app gelijk:
--        useDeletePurchaseInvoice verwijdert eerst de regels en dan de factuur,
--        en een klant of gebruiker verwijderen cascadeert al naar
--        purchase_invoices (20260411182021). Met NO ACTION/RESTRICT zou elk
--        van die paden gaan falen zodra er nog een (voor de verwijderaar
--        onzichtbare) regel bestaat; met CASCADE slagen ze zoals nu en blijft
--        er geen weesregel achter. Geboekte facturen blijven beschermd: de
--        marker-FK (RESTRICT) en prevent_posted_purchase_line_mutation weigeren
--        het verwijderen van een geboekte factuur en haar regels ook via een
--        cascade.
--
-- WAT DEZE MIGRATIE NIET DOET
--   Geen datawijziging: bestaande regels met een afwijkende organisatie of
--   zonder factuur blijven staan (tellen met Q11 en de weescontrole). Geen
--   wijziging van RLS, van post_purchase_invoice of van de opslag-RPC's.
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION, DROP/CREATE TRIGGER, en de FK alleen
--   als hij nog niet bestaat.
--
-- ROLLBACK:
--   ALTER TABLE public.purchase_invoice_lines
--     DROP CONSTRAINT IF EXISTS purchase_invoice_lines_purchase_invoice_id_fkey;
--   DROP TRIGGER IF EXISTS enforce_purchase_invoice_line_parent_trigger ON public.purchase_invoice_lines;
--   DROP FUNCTION IF EXISTS public.enforce_purchase_invoice_line_parent();
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten: fail closed als iets ontbreekt ────────────────────────────

DO $migratie$
BEGIN
  IF to_regclass('public.purchase_invoice_lines') IS NULL OR to_regclass('public.purchase_invoices') IS NULL THEN
    RAISE EXCEPTION 'A2-17 vereist public.purchase_invoices en public.purchase_invoice_lines';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'purchase_invoice_lines'
                   AND column_name = 'organization_id') THEN
    RAISE EXCEPTION 'A2-17 vereist purchase_invoice_lines.organization_id (20260531223619)';
  END IF;
  -- Bestaat er al een andere FK op deze kolom, dan is de uitgangssituatie
  -- anders dan beoordeeld: stoppen in plaats van een tweede FK toe te voegen.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.purchase_invoice_lines'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.purchase_invoices'::regclass
      AND c.conname <> 'purchase_invoice_lines_purchase_invoice_id_fkey'
  ) THEN
    RAISE EXCEPTION 'A2-17: er bestaat al een andere FK van purchase_invoice_lines naar purchase_invoices';
  END IF;
END
$migratie$;

-- ── 1. De trigger ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_purchase_invoice_line_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  -- Integriteit, geen autorisatie (patterns §5B): geen auth.uid(), geen rol.
  -- RLS bepaalt wie mag schrijven; deze trigger bepaalt bij welke factuur een
  -- regel mag horen.
  SELECT pi.organization_id INTO v_org
  FROM public.purchase_invoices pi
  WHERE pi.id = NEW.purchase_invoice_id;

  -- Niet gevonden, geen organisatie of een andere organisatie: één neutrale
  -- weigering, zodat het antwoord geen bestaansorakel is.
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'inkoopfactuur niet gevonden of geen toegang' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.organization_id IS NULL THEN
    NEW.organization_id := v_org;
  ELSIF NEW.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'inkoopfactuur niet gevonden of geen toegang' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_purchase_invoice_line_parent()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_purchase_invoice_line_parent() IS
'Een inkoopregel hoort bij de organisatie van zijn factuur: weigert (42501, neutraal) een regel bij een niet-bestaande factuur, een factuur zonder organisatie of een factuur van een andere organisatie, en vult bij INSERT een ontbrekende organization_id in met die van de factuur.';

DROP TRIGGER IF EXISTS enforce_purchase_invoice_line_parent_trigger ON public.purchase_invoice_lines;
CREATE TRIGGER enforce_purchase_invoice_line_parent_trigger
  BEFORE INSERT OR UPDATE OF purchase_invoice_id, organization_id ON public.purchase_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_purchase_invoice_line_parent();

-- ── 2. De FK, NOT VALID ──────────────────────────────────────────────────────

DO $migratie$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.purchase_invoice_lines'::regclass
      AND conname = 'purchase_invoice_lines_purchase_invoice_id_fkey'
  ) THEN
    ALTER TABLE public.purchase_invoice_lines
      ADD CONSTRAINT purchase_invoice_lines_purchase_invoice_id_fkey
      FOREIGN KEY (purchase_invoice_id) REFERENCES public.purchase_invoices (id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$migratie$;

-- Pas na een productietelling met nul wezen (rapport P2, "VALIDATE-voorwaarde"):
--   ALTER TABLE public.purchase_invoice_lines
--     VALIDATE CONSTRAINT purchase_invoice_lines_purchase_invoice_id_fkey;
