-- ═════════════════════════════════════════════════════════════════════════════
-- BETALINGEN — DE BETAALSCHRIJVER AFDWINGEN (P5c)
--
-- WAAROM
--   Na P5a bestaat de atomaire betaalschrijver (link_bank_payment /
--   unlink_bank_payment); na P5b gebruikt de app uitsluitend die schrijver.
--   Zolang de directe schrijfrechten blijven, kan een oude client, een
--   onderhoudspad of een cascade nog langs de schrijver heen een koppeling,
--   een restbedrag of de status `betaald` zetten. Deze migratie sluit die
--   wegen (D1, voorwaarden 1, 4 en 5).
--
-- WAT DEZE MIGRATIE DOET
--   1. bank_transaction_allocations: REVOKE ALL van PUBLIC, anon,
--      authenticated en service_role, daarna alleen SELECT voor authenticated
--      en service_role (het patroon van journal_entries, 20260930120000). De
--      RLS-policies blijven ongewijzigd staan.
--   2. enforce_bank_allocation_writer_trigger (BEFORE INSERT/UPDATE/DELETE per
--      rij): een koppeling ontstaat of verdwijnt alleen met het bewijs van de
--      schrijver (sessievlag + gebeurtenis voor precies deze koppeling in deze
--      transactie); bijwerken nooit. Geldt ook voor de eigenaar, service_role en
--      een cascade bij het verwijderen van een banktransactie (een
--      referentiële actie loopt als tabeleigenaar en omzeilt de REVOKE, niet
--      deze trigger).
--   3. enforce_invoice_payment_state_trigger op purchase_invoices en
--      sales_invoices (BEFORE INSERT/UPDATE/DELETE per rij). Buiten de schrijver:
--      • INSERT: status niet `betaald`; restant leeg of het totaalbedrag
--        (amount_incl, anders amount_excl). Een nieuwe factuur is onbetaald.
--      • status naar `betaald` (beide soorten), of bij verkoop uit `betaald`
--        (ook "goedkeuren" van een betaalde factuur, A2-08): geweigerd.
--        Inkoop uit `betaald` naar bv. `geexporteerd` blijft mogelijk: dat
--        verandert de betaaltoestand niet.
--      • bedrag of administratie wijzigen terwijl er koppelingen zijn:
--        geweigerd ("ontkoppel eerst").
--      • restant wijzigen: alleen "niets betaald blijft niets betaald" — geen
--        koppelingen, het oude restant leeg of het oude totaal, het nieuwe
--        leeg of het nieuwe totaal (exact shouldSyncRemainingAmount van de
--        bewerkdialoog).
--      • bedrag van een onbetaalde factuur (geen koppelingen, restant = oud
--        totaal) wijzigen zonder het restant: het restant volgt het nieuwe
--        totaal, in dezelfde rij en dezelfde opdracht. Een leeg restant blijft
--        leeg; een afwijkend (oud) restant blijft staan — nooit stil heropenen.
--      • DELETE van een factuur met koppelingen: geweigerd.
--
-- WAT DEZE MIGRATIE NADRUKKELIJK NIET DOET
--   - Geen UPDATE, DELETE of backfill van bestaande rijen; de guards weigeren
--     of leiden alleen af binnen een wijziging van díe rij.
--   - Geen trigger op bank_transactions (zie P5a); de matchvelden van een
--     banktransactie blijven voor de app schrijfbaar (ontwerpbesluit).
--   - Geen wijziging aan P5a, aan een schrijver of aan een policy.
--
-- VOORWAARDEN (STOP in de preflight)
--   P5a toegepast; P5b live (sinds de uitrol geen koppeling meer zonder
--   gebeurtenis); de intakefix van P2 live (geen nieuwe factuur met restant 0
--   zonder bedrag). supabase/rollout/20261021183000_enforce_bank_payment_writer/
--
-- PRODUCTIE
--   Uitsluitend via de Lovable Cloud SQL editor van project
--   alxlbdhpbwlehbdbfejw, ná review en ná P5b. Deze PR past niets toe.
--
-- ROLLBACK (handmatig). Raakt geen data. Zet de tabelrechten terug zoals PRE 2
-- ze toonde (standaard in Supabase: alles voor anon, authenticated en
-- service_role).
-- ROLLBACK-BEGIN
--   DROP TRIGGER IF EXISTS enforce_invoice_payment_state_trigger ON public.sales_invoices;
--   DROP TRIGGER IF EXISTS enforce_invoice_payment_state_trigger ON public.purchase_invoices;
--   DROP TRIGGER IF EXISTS enforce_bank_allocation_writer_trigger ON public.bank_transaction_allocations;
--   DROP FUNCTION IF EXISTS public.enforce_invoice_payment_state();
--   DROP FUNCTION IF EXISTS public.enforce_bank_allocation_writer();
--   GRANT ALL ON TABLE public.bank_transaction_allocations TO anon, authenticated, service_role;
-- ROLLBACK-END
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten: fail closed ───────────────────────────────────────────────

DO $migratie$
BEGIN
  IF to_regprocedure('public.link_bank_payment(uuid,text,uuid,numeric,uuid)') IS NULL
     OR to_regprocedure('public.unlink_bank_payment(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.bank_payment_writer_active(text,uuid)') IS NULL
     OR to_regprocedure('public.bank_payment_allocation_writer_active(uuid,text)') IS NULL
     OR to_regclass('public.bank_payment_events') IS NULL THEN
    RAISE EXCEPTION 'P5c vereist P5a (20261021180000): de betaalschrijver en zijn gebeurtenistabel';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.bank_transaction_allocations'::regclass
                   AND tgname = 'guard_bank_allocation_write_trigger') THEN
    RAISE EXCEPTION 'P5c vereist de guard van P5a op bank_transaction_allocations';
  END IF;
END
$migratie$;

-- ── 1. Geen directe schrijfrechten meer op de koppelingen ──────────────────

REVOKE ALL ON TABLE public.bank_transaction_allocations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.bank_transaction_allocations TO authenticated, service_role;

-- ── 2. Een koppeling ontstaat of verdwijnt alleen via de schrijver ──────────

CREATE OR REPLACE FUNCTION public.enforce_bank_allocation_writer()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND public.bank_payment_allocation_writer_active(NEW.id, 'linked') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND public.bank_payment_allocation_writer_active(OLD.id, 'unlinked') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Betalingskoppelingen veranderen alleen via koppelen en ontkoppelen; ververs de pagina en gebruik Koppelen of Ontkoppelen'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_allocation_writer() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_allocation_writer() IS
'P5c, BEFORE INSERT/UPDATE/DELETE per rij op bank_transaction_allocations: alleen INSERT door link_bank_payment en DELETE door unlink_bank_payment (bewijs: sessievlag + gebeurtenis voor deze koppeling in deze transactie); al het andere 42501, ook voor de eigenaar, service_role en een cascade.';

DROP TRIGGER IF EXISTS enforce_bank_allocation_writer_trigger ON public.bank_transaction_allocations;
CREATE TRIGGER enforce_bank_allocation_writer_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.bank_transaction_allocations
FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_allocation_writer();

-- ── 3. Restant en betaald op de facturen volgen de koppelingen ──────────────

CREATE OR REPLACE FUNCTION public.enforce_invoice_payment_state()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type      text := CASE TG_TABLE_NAME WHEN 'purchase_invoices' THEN 'inkoop' ELSE 'verkoop' END;
  v_linked    boolean;
  v_old_total numeric;
  v_new_total numeric;
  v_old_open  boolean;
  v_new_open  boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'betaald' THEN
      RAISE EXCEPTION 'Een nieuwe factuur kan niet als betaald worden aangemaakt; koppel de betaling na het aanmaken'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.remaining_amount IS NOT NULL
       AND NEW.remaining_amount IS DISTINCT FROM coalesce(NEW.amount_incl, NEW.amount_excl) THEN
      RAISE EXCEPTION 'Het openstaande bedrag van een nieuwe factuur is haar totaalbedrag of leeg; betalingen lopen via koppelen'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- De betaalschrijver zelf.
  IF public.bank_payment_writer_active(v_type, OLD.id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  v_linked := EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.invoice_id = OLD.id);

  IF TG_OP = 'DELETE' THEN
    IF v_linked THEN
      RAISE EXCEPTION 'Deze factuur heeft betalingskoppelingen; ontkoppel eerst' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.status = 'betaald' OR (v_type = 'verkoop' AND OLD.status = 'betaald')) THEN
    RAISE EXCEPTION 'De status betaald volgt uit de betalingskoppelingen; koppel of ontkoppel de betaling'
      USING ERRCODE = '23514';
  END IF;

  IF v_linked AND (NEW.amount_incl IS DISTINCT FROM OLD.amount_incl
                   OR NEW.amount_excl IS DISTINCT FROM OLD.amount_excl
                   OR NEW.client_id IS DISTINCT FROM OLD.client_id) THEN
    RAISE EXCEPTION 'Deze factuur heeft betalingskoppelingen; ontkoppel eerst voordat je het bedrag of de administratie wijzigt'
      USING ERRCODE = '23514';
  END IF;

  v_old_total := coalesce(OLD.amount_incl, OLD.amount_excl);
  v_new_total := coalesce(NEW.amount_incl, NEW.amount_excl);
  -- "Niets betaald": leeg, of precies het totaal (een restant zonder bekend
  -- totaal, bv. 0 van een oude OCR-intake, telt NIET als niets betaald).
  v_old_open := OLD.remaining_amount IS NULL
                OR (v_old_total IS NOT NULL AND OLD.remaining_amount = v_old_total);
  v_new_open := NEW.remaining_amount IS NULL
                OR (v_new_total IS NOT NULL AND NEW.remaining_amount = v_new_total);

  IF NEW.remaining_amount IS DISTINCT FROM OLD.remaining_amount THEN
    IF v_linked OR NOT v_old_open OR NOT v_new_open THEN
      RAISE EXCEPTION 'Het openstaande bedrag volgt uit de betalingskoppelingen; koppel of ontkoppel de betaling'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NOT v_linked AND OLD.remaining_amount IS NOT NULL AND v_old_open
        AND v_new_total IS DISTINCT FROM v_old_total THEN
    -- Het bedrag van een onbetaalde factuur verandert: het restant volgt.
    NEW.remaining_amount := v_new_total;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_invoice_payment_state() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_invoice_payment_state() IS
'P5c, BEFORE INSERT/UPDATE/DELETE per rij op purchase_invoices en sales_invoices: buiten de betaalschrijver geen status betaald (erin, en bij verkoop eruit), geen restant dat iets anders zegt dan "niets betaald", geen bedrag- of administratiewissel en geen DELETE met koppelingen. Een bedragwijziging van een onbetaalde factuur laat het restant het nieuwe totaal volgen.';

DROP TRIGGER IF EXISTS enforce_invoice_payment_state_trigger ON public.purchase_invoices;
CREATE TRIGGER enforce_invoice_payment_state_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_invoices
FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_payment_state();

DROP TRIGGER IF EXISTS enforce_invoice_payment_state_trigger ON public.sales_invoices;
CREATE TRIGGER enforce_invoice_payment_state_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.sales_invoices
FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_payment_state();
