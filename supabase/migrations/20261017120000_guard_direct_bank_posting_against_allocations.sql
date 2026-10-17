-- ═════════════════════════════════════════════════════════════════════════════
-- BANK — GEEN DUBBELE BOEKING VIA DIRECTE BOEKING ÉN FACTUURKOPPELING (PR 0)
--
-- WAAROM
--   Een banktransactie kan op twee manieren in het grootboek komen:
--     • rechtstreeks, door public.post_bank_transaction()
--       → marker in public.bank_transaction_postings (één per transactie);
--     • via één of meer factuurkoppelingen, door public.post_bank_allocation()
--       → marker in public.bank_allocation_postings (één per koppeling).
--   Beide schrijvers boeken de bankrekening. Dezelfde transactie langs beide
--   wegen boeken is dus een dubbele bankmutatie.
--
--   De bestaande beveiliging dekt één richting: post_bank_transaction() weigert
--   een transactie met koppelingen. De andere richting was open:
--     • een koppeling INSERTen op een al direct geboekte transactie (RLS laat
--       dat toe vanaf `assistant`; Facturen en Verkoop doen precies dat — eerst
--       de koppeling, dan pas de banktransactie, waarvan de wijziging daarna
--       door de bevriezing wordt geweigerd, zodat de koppeling blijft staan);
--     • een bestaande, nog ongeboekte koppeling met UPDATE naar zo'n transactie
--       verplaatsen;
--     • zo'n koppeling daarna met post_bank_allocation() boeken.
--
-- WAT DEZE MIGRATIE DOET — drie integriteitstriggers, verder niets
--   1. bank_transaction_allocations, AFTER INSERT OR UPDATE OF
--      bank_transaction_id (per rij, aan het eind van dezelfde opdracht):
--      weigert een koppeling op een direct geboekte transactie. De opdracht
--      faalt als geheel, dus dit is de vroegste weigering, vóór enig ander
--      schrijfwerk van de app (bv. het restbedrag van een factuur).
--      AFTER en niet BEFORE: RLS (WITH CHECK) en de foreign key oordelen
--      eerst. Zo krijgt wie niet mag schrijven de RLS-weigering en nooit de
--      melding "al direct geboekt" — anders kon een buitenstaander die een
--      transactie-id kent de boekingsstaat van een andere tenant aflezen.
--   2. bank_allocation_postings, BEFORE INSERT: weigert het boeken van een
--      koppeling op een direct geboekte transactie — ook van een koppeling die
--      vóór deze migratie al bestond. Leidt de transactie af uit de koppeling
--      zelf en weigert een marker die naar een andere transactie wijst.
--   3. bank_transaction_postings, BEFORE INSERT: weigert een directe marker
--      zodra de transactie een koppeling of een geboekte aflettering heeft —
--      dezelfde regel die de schrijver al toetst, nu ook als database-invariant.
--
--   De grootboekinvariant — "geen banktransactie heeft zowel een directe als
--   een afletteringsmarker" — rust op 2 en 3: die draaien binnen de schrijvers,
--   onder hun eigen FOR UPDATE op de banktransactie en in READ COMMITTED (het
--   grootboek weigert elk ander niveau). Guard 1 houdt de rij zelf schoon.
--
-- GELIJKTIJDIGHEID EN ISOLATIE
--   • Guard 1 neemt FOR KEY SHARE op de banktransactie, vóór het lezen van de
--     marker. Dat botst met de FOR UPDATE van beide schrijvers: wie eerst komt,
--     maakt de ander wachten. Na het wachten leest de volgende opdracht in de
--     triggerfunctie (VOLATILE, READ COMMITTED) een verse snapshot en ziet de
--     zojuist gecommitte marker. Het is dezelfde grendel die de foreign key van
--     de koppeling in dezelfde opdracht al neemt, dus geen nieuwe
--     grendelvolgorde. FOR KEY SHARE blokkeert gewone UPDATEs van de
--     banktransactie niet.
--   • Onder REPEATABLE READ of SERIALIZABLE ververst de snapshot NIET na het
--     wachten; dan zou guard 1 een net gecommitte marker missen. Daarom weigert
--     guard 1, net als het grootboek zelf (6C-b2), elk ander niveau dan READ
--     COMMITTED. De app (PostgREST) werkt in READ COMMITTED.
--   • Guards 2 en 3 nemen binnen de schrijvers geen nieuwe grendel: de
--     schrijver houdt de banktransactie al FOR UPDATE (en de koppeling FOR
--     UPDATE), en een zwakkere grendel op een eigen rij wacht nooit.
--   • De weigeringen gebruiken SQLSTATE 23514, nooit 23505: beide schrijvers
--     vangen rond hun marker-INSERT uitsluitend unique_violation op.
--
-- WAT DEZE MIGRATIE NADRUKKELIJK NIET DOET
--   - Geen wijziging aan bestaande data, markers, grootboekregels of
--     koppelingen; geen backfill, geen automatische correctie. Een al bestaande
--     koppeling op een direct geboekte transactie blijft staan — zij kan alleen
--     niet meer worden geboekt (guard 2). De preflight telt zulke gevallen.
--   - Geen herdefinitie van een bestaande functie, schrijver of trigger; geen
--     nieuwe rechten; geen nieuwe tabel of kolom.
--   - Geen autorisatie: de guards toetsen geen rol en geen auth.uid(); zij
--     gelden voor elke rol, ook service_role en de eigenaar.
--   - INSERT-validatietriggers blijven ORIGIN (geen ENABLE ALWAYS), zodat een
--     restore in replica-modus mogelijk blijft — hetzelfde patroon als de
--     INSERT-triggers van het grootboek (20260914120000). Applicatierollen
--     kunnen session_replication_role niet zetten.
--
-- PRODUCTIE
--   Toepassen uitsluitend via de Lovable Cloud SQL editor van project
--   alxlbdhpbwlehbdbfejw, ná review, en pas nadat 20261010120000 aantoonbaar is
--   toegepast. Leescontroles vooraf en achteraf:
--   supabase/rollout/20261017120000_guard_direct_bank_posting_against_allocations/
--   Deze PR past niets toe.
--
-- ROLLBACK (handmatig). Raakt geen data: de guards schrijven niets, dus wat zij
-- weigerden is nooit gebeurd, en wat zij toelieten blijft geldig zonder hen.
-- Wel gaat het gat weer open. Alleen toepassen als een guard zelf aantoonbaar
-- fout weigert, nooit nadat een latere migratie op deze guards steunt, en
-- direct daarna de dubbele-boekingscontrole uit de preflight opnieuw draaien.
-- ROLLBACK-BEGIN
--   DROP TRIGGER IF EXISTS validate_bank_direct_posting_without_allocations_trigger ON public.bank_transaction_postings;
--   DROP TRIGGER IF EXISTS validate_bank_allocation_posting_not_directly_posted_trigger ON public.bank_allocation_postings;
--   DROP TRIGGER IF EXISTS validate_bank_allocation_not_directly_posted_trigger ON public.bank_transaction_allocations;
--   DROP FUNCTION IF EXISTS public.enforce_bank_direct_posting_without_allocations();
--   DROP FUNCTION IF EXISTS public.enforce_bank_allocation_posting_not_directly_posted();
--   DROP FUNCTION IF EXISTS public.enforce_bank_allocation_not_directly_posted();
-- ROLLBACK-END
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten: fail closed ───────────────────────────────────────────────

DO $migratie$
BEGIN
  IF to_regclass('public.bank_transactions') IS NULL
     OR to_regclass('public.bank_transaction_allocations') IS NULL
     OR to_regclass('public.bank_allocation_postings') IS NULL
     OR to_regclass('public.bank_transaction_postings') IS NULL THEN
    RAISE EXCEPTION 'PR 0 vereist bank_transactions, bank_transaction_allocations, bank_allocation_postings (20260917120000) en bank_transaction_postings (20260920195805)';
  END IF;
  IF to_regprocedure('public.post_bank_transaction(uuid)') IS NULL
     OR to_regprocedure('public.post_bank_allocation(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PR 0 vereist de schrijvers public.post_bank_transaction(uuid) en public.post_bank_allocation(uuid)';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'bank_transaction_allocations' AND column_name IN ('id', 'bank_transaction_id'))
          OR (table_name = 'bank_allocation_postings'     AND column_name IN ('allocation_id', 'bank_transaction_id'))
          OR (table_name = 'bank_transaction_postings'    AND column_name = 'bank_transaction_id'))) <> 5 THEN
    RAISE EXCEPTION 'PR 0: een vereiste kolom ontbreekt op de koppelings- of markertabellen';
  END IF;
END
$migratie$;

-- ── 1. Guard 1 — geen koppeling op een direct geboekte banktransactie ───────

CREATE OR REPLACE FUNCTION public.enforce_bank_allocation_not_directly_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- AFTER-trigger: de rij heeft RLS en de foreign key al gepasseerd; een
  -- weigering hier breekt de hele opdracht af. De returnwaarde telt niet.

  -- Een UPDATE die de koppeling niet naar een andere banktransactie verplaatst,
  -- raakt deze invariant niet (bv. een upsert die alleen het bedrag zet).
  IF TG_OP = 'UPDATE' AND NEW.bank_transaction_id IS NOT DISTINCT FROM OLD.bank_transaction_id THEN
    RETURN NULL;
  END IF;

  -- Onder een snapshot-vasthoudend niveau ververst de snapshot niet na het
  -- wachten op de grendel hieronder, en zou een net gecommitte directe boeking
  -- onzichtbaar blijven. Dezelfde regel als voor het grootboek zelf.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een bankkoppeling kan alleen in een READ COMMITTED transactie worden vastgelegd of verplaatst (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  -- Serialiseren met de directe boekingsschrijver (FOR UPDATE op dezelfde rij)
  -- vóórdat de marker wordt gelezen. Vandaag neemt de foreign-keycontrole
  -- (ook een AFTER-trigger, die eerder vuurt) dezelfde grendel al; deze regel
  -- maakt de guard daar onafhankelijk van — van het bestaan van die foreign
  -- key én van de volgorde waarin triggers vuren.
  PERFORM 1 FROM public.bank_transactions bt
  WHERE bt.id = NEW.bank_transaction_id
  FOR KEY SHARE;

  IF EXISTS (
    SELECT 1 FROM public.bank_transaction_postings m
    WHERE m.bank_transaction_id = NEW.bank_transaction_id
  ) THEN
    RAISE EXCEPTION 'Deze banktransactie is al rechtstreeks in het grootboek geboekt; een factuurkoppeling zou haar dubbel boeken. Corrigeer eerst de directe boeking.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_allocation_not_directly_posted() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_allocation_not_directly_posted() IS
'Integriteitsguard (PR 0): weigert een factuurkoppeling op, of het verplaatsen van een koppeling naar, een banktransactie die al rechtstreeks is geboekt (bank_transaction_postings). AFTER-trigger per rij, zodat RLS en de foreign key eerst oordelen; neemt FOR KEY SHARE op de banktransactie; alleen READ COMMITTED. Geen rol- of auth.uid()-toets.';

DROP TRIGGER IF EXISTS validate_bank_allocation_not_directly_posted_trigger ON public.bank_transaction_allocations;
CREATE TRIGGER validate_bank_allocation_not_directly_posted_trigger
  AFTER INSERT OR UPDATE OF bank_transaction_id ON public.bank_transaction_allocations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_allocation_not_directly_posted();

-- ── 2. Guard 2 — geen aflettering boeken op een direct geboekte transactie ──

CREATE OR REPLACE FUNCTION public.enforce_bank_allocation_posting_not_directly_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alloc_tx uuid;
BEGIN
  -- De banktransactie komt uit de koppeling zelf, niet uit de marker: een
  -- marker die naar een andere transactie wijst dan haar koppeling, wordt
  -- geweigerd. FOR SHARE houdt een gelijktijdige verplaatsing van de koppeling
  -- tegen; binnen de schrijver houdt die de koppeling al FOR UPDATE.
  SELECT a.bank_transaction_id INTO v_alloc_tx
  FROM public.bank_transaction_allocations a
  WHERE a.id = NEW.allocation_id
  FOR SHARE;

  IF v_alloc_tx IS DISTINCT FROM NEW.bank_transaction_id THEN
    RAISE EXCEPTION 'Een geboekte aflettering moet bij de banktransactie van haar eigen koppeling horen'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.bank_transactions bt
  WHERE bt.id = NEW.bank_transaction_id
  FOR KEY SHARE;

  IF EXISTS (
    SELECT 1 FROM public.bank_transaction_postings m
    WHERE m.bank_transaction_id = NEW.bank_transaction_id
  ) THEN
    RAISE EXCEPTION 'Deze banktransactie is al rechtstreeks in het grootboek geboekt; deze koppeling kan niet ook als aflettering worden geboekt.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_allocation_posting_not_directly_posted() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_allocation_posting_not_directly_posted() IS
'Integriteitsguard (PR 0): weigert een afletteringsmarker (bank_allocation_postings) voor een banktransactie die al rechtstreeks is geboekt, ook voor een koppeling die al vóór de guard bestond. De transactie wordt uit de koppeling afgeleid. Geen rol- of auth.uid()-toets.';

DROP TRIGGER IF EXISTS validate_bank_allocation_posting_not_directly_posted_trigger ON public.bank_allocation_postings;
CREATE TRIGGER validate_bank_allocation_posting_not_directly_posted_trigger
  BEFORE INSERT ON public.bank_allocation_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_allocation_posting_not_directly_posted();

-- ── 3. Guard 3 — geen directe boeking met een koppeling of aflettering ──────

CREATE OR REPLACE FUNCTION public.enforce_bank_direct_posting_without_allocations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Binnen de schrijver is de rij al FOR UPDATE van deze transactie; buiten de
  -- schrijver serialiseert dit met guard 1 en met de afletteringsschrijver.
  PERFORM 1 FROM public.bank_transactions bt
  WHERE bt.id = NEW.bank_transaction_id
  FOR KEY SHARE;

  IF EXISTS (
    SELECT 1 FROM public.bank_allocation_postings p
    WHERE p.bank_transaction_id = NEW.bank_transaction_id
  ) THEN
    RAISE EXCEPTION 'Deze banktransactie heeft een geboekte aflettering; zij kan niet ook rechtstreeks in het grootboek worden geboekt.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bank_transaction_allocations a
    WHERE a.bank_transaction_id = NEW.bank_transaction_id
  ) THEN
    RAISE EXCEPTION 'Deze banktransactie is aan een factuur gekoppeld; zij kan niet ook rechtstreeks in het grootboek worden geboekt. Boek haar via de aflettering.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_direct_posting_without_allocations() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_direct_posting_without_allocations() IS
'Integriteitsguard (PR 0): weigert een directe bankboekingsmarker (bank_transaction_postings) voor een banktransactie met een factuurkoppeling of een geboekte aflettering. Geen rol- of auth.uid()-toets.';

DROP TRIGGER IF EXISTS validate_bank_direct_posting_without_allocations_trigger ON public.bank_transaction_postings;
CREATE TRIGGER validate_bank_direct_posting_without_allocations_trigger
  BEFORE INSERT ON public.bank_transaction_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_direct_posting_without_allocations();
