-- ═════════════════════════════════════════════════════════════════════════════
-- GECOMBINEERDE UITROL — PR 1 + PR 2 + 20261018180000 in ÉÉN opdracht
--
-- UITSLUITEND in de Lovable Cloud SQL editor van `alxlbdhpbwlehbdbfejw`
-- (projectref visueel bevestigd; nooit het persoonlijke Supabase-dashboard,
-- nooit olumcwneiejjefhkzgmz of ycuofllsdssoezwwpqmv), volgens uitvoerplan.md
-- in deze map: ná PRE (PR 1) en PRE B.
--
-- Plak dit HELE bestand, ongewijzigd, en voer het één keer uit. Het bestaat uit
-- twee opdrachten:
--   1. één DO-opdracht die de drie migraties letterlijk uitvoert (EXECUTE),
--      met bewaking vooraf en achteraf. Eén opdracht is altijd één
--      transactie, hoe de editor haar ook verstuurt: lukt één onderdeel niet
--      (ook de lock_timeout van 5 s), dan wordt NIETS toegepast. Een afgekapte
--      plak is een syntaxfout en doet ook niets. Niemand ziet ooit PR 1 zonder
--      de fix.
--   2. een SELECT die de eindtoestand leest: 'gecombineerde uitrol voltooid'
--      alleen als alle drie er exact staan, anders 'NIET VOLTOOID — STOP'.
--
-- Inhoud, letterlijk en in deze volgorde (sha256 van de bestanden in
-- supabase/migrations/; de contracttest bewaakt dat de tekst tussen elk paar
-- dollar-aanhalingstekens byte-gelijk dat bestand is):
--   20261018120000_add_bank_transaction_corrections.sql  6117f64382e7951af650f3a09d74c675e7ad1070b7e298ce46e9d5faa490f2fc
--   20261018150000_keep_bank_description_on_correction.sql  1cc32885a3d095ec2fa0bb36e16d4337cb5fdf8f95f59440175ee9b6ff3fe54d
--   20261018180000_refine_release_hold_for_settled_history.sql  1d7f0aa272a66ad4a67138eddfb561fc13cd5b469030185ceae2986ffda18ba8
--
-- Verwacht als (laatste) uitkomst: één rij met `uitkomst` =
-- 'gecombineerde uitrol voltooid'. Elke foutmelding, of 'NIET VOLTOOID — STOP':
-- STOP, niets herstellen, uitkomst doorgeven.
-- ═════════════════════════════════════════════════════════════════════════════

DO $uitrol_20261018180000$
BEGIN
  -- Grendels hooguit 5 s, alleen binnen deze transactie.
  PERFORM set_config('lock_timeout', '5s', true);

  -- Vooraf: nog niets van PR 1, PR 2 of de fix.
  IF to_regclass('public.bank_transaction_posting_events') IS NOT NULL
     OR to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') IS NOT NULL
     OR to_regprocedure('public.enforce_bank_transaction_release_hold()') IS NOT NULL
     OR to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Uitrol geweigerd: PR 1, PR 2 of 20261018180000 is al (deels) aanwezig; er is niets veranderd' USING ERRCODE = '55000';
  END IF;

  -- ═══ 20261018120000_add_bank_transaction_corrections.sql ═══
  EXECUTE $pr1_20261018120000$
-- ═════════════════════════════════════════════════════════════════════════════
-- BANKCORRECTIES v1.1 — PR 1: DE BACKENDFUNDERING
--
-- WAAROM
--   Een direct geboekte banktransactie (post_bank_transaction → marker in
--   bank_transaction_postings) kon tot nu toe niet gecorrigeerd worden: de
--   bevriezing weigert elke wijziging van rekening, BTW en status, en de marker
--   laat maar één boekingsgroep per transactie toe. Een handmatige tegenboeking
--   via het grootboek liet de transactie daarna voorgoed "geboekt" achter.
--
-- WAT DEZE MIGRATIE DOET
--   Het grootboek blijft append-only en de bestaande schrijvers blijven de
--   enige die grootboekregels maken: reverse_posting_group() voor de storno,
--   post_bank_transaction() voor de (her)boeking. Hier komt bij:
--
--   1. public.bank_transaction_posting_events — append-only gebeurtenissen per
--      banktransactie: posted, reclassified, reposted, released, returned, en
--      unchanged (een herclassificatie die niets hoefde te doen). Elke
--      correctie legt vast welke groep zij verving, welke tegenboeking daarbij
--      hoort, welke groep ervoor in de plaats kwam, wie, waarom, en een
--      momentopname van de vervangen boeking. UNIQUE (actor_id, request_id,
--      event_type) is de idempotentiesleutel; seq geeft de volgorde.
--   2. Markerbewaking op bank_transaction_postings:
--      • UPDATE en TRUNCATE altijd geweigerd;
--      • DELETE alleen als de groep van de marker al is tegengeboekt;
--      • bij COMMIT (uitgesteld): voor elke verwijderde marker bestaat in DEZE
--        transactie een gebeurtenis die haar groep als vervangen noemt.
--      Zo is elke bankgroep óf de actieve markergroep, óf staat zij met haar
--      tegenboeking en opvolger in precies één gebeurtenis.
--   3. D12 — de vrijgave-hold, afgeleid uit de gebeurtenissen:
--      • bank_transactions: na een vrijgave (laatste gebeurtenis `released`,
--        geen marker) zijn status, rekening, BTW en factuurmatch bevroren voor
--        elke rol en elk pad (app, sjablonen, bulk, service_role); zodra er
--        historie is, zijn ook bedrag, datum, administratie, organisatie en
--        eigenaar bevroren en is verwijderen onmogelijk;
--      • bank_transaction_allocations: geen nieuwe of verplaatste koppeling
--        naar een vrijgegeven transactie.
--   4. Drie RPC's (SECURITY DEFINER, alleen voor authenticated):
--      • reclassify_bank_transaction()  — eerste boeking, correctie (storno +
--        herboeking in één transactie), herboeking na een handmatige
--        tegenboeking, of herboeking na vrijgave;
--      • release_bank_transaction_posting() — tegenboeken zonder herboeking;
--      • return_bank_transaction_to_workflow() — D12-b: een vrijgegeven
--        transactie expliciet terug naar de gewone werkstroom.
--
-- TOESTANDEN (afgeleid onder de rijgrendel, geen statuskolom)
--   S0  geen marker, laatste gebeurtenis geen `released` (nooit geboekt, of
--       teruggezet)                                    → gewone werkstroom
--   S1  marker met groep G, G niet tegengeboekt        → geboekt
--   S2  marker met groep G, G al tegengeboekt (R)      → handmatig tegengeboekt
--   S3  geen marker, laatste gebeurtenis `released`    → vrijgegeven (hold)
--
--   reclassify  S0 → S1  posted                 (assistant)
--               S1 → S1  unchanged              (accountant; zelfde codering — vastgelegd,
--                                                zodat een herhaling exact dit antwoord geeft)
--               S1 → S1  reclassified           (accountant; storno + herboeking)
--               S2 → S1  reposted               (accountant; bestaande storno *)
--               S3 → S1  reposted_after_release (accountant; returned + posted *)
--   release     S1 → S3  released               (accountant; storno, geen herboeking)
--               S2 → S3  released               (accountant; bestaande storno *)
--   return      S3 → S0  returned               (accountant *)
--   * alleen als de bestaande storno op de transactiedatum staat (zie hieronder).
--   Elke andere combinatie: 55000 "De boekingstoestand is gewijzigd".
--
-- BOEKHOUDKUNDIG
--   • Storno en herboeking op de oorspronkelijke transactiedatum (besluit 1).
--   • Bedragen, rekeningen en BTW komen uitsluitend uit post_bank_transaction;
--     alleen 0, 9 en 21 procent (D11); een btw-vrijgestelde administratie
--     alleen 0.
--   • Geen correctie die bedragen stil naar een andere bank- of BTW-rekening
--     verplaatst (D7): als de actieve groep op een andere bank- of BTW-rekening
--     staat dan de huidige configuratie, weigert de correctie (23514). Vrijgeven
--     spiegelt de historische rekeningen en mag wel; een latere boeking gebruikt
--     de dan geldende configuratie.
--   • De boekingsblokkade geldt voor elke handeling (assert_posting_allowed op
--     de transactiedatum); een afgesloten jaar zonder blokkade mag (D8, PR H).
--   • Factuurkoppelingen vallen buiten v1: elke koppeling → 22023, ook een
--     gematchte regel zonder koppelingsrij (een oudere koppeling via de match).
--     De RPC herrekent geen facturen en laat een factuurmatch op een handmatig
--     geboekte regel (een achtergebleven suggestie) ongemoeid; alleen een
--     onbevestigde suggestie vervalt bij boeken. Vrijgeven zou de match moeten
--     wissen en weigert daarom zolang de regel er nog een draagt.
--   • Een bestaande storno (handmatig via het grootboek) op een LATERE datum dan
--     de transactie: opnieuw boeken op de transactiedatum zou bank, kosten en
--     BTW in de periode daartussen dubbel boeken (de totalen kloppen, de
--     perioden niet). Daarom weigeren herboeken (S2, S3), vrijgeven (S2) en
--     terugzetten (S3) dan met 22023 en een verwijzing naar een memoriaalboeking.
--     Een storno op de transactiedatum — zoals deze RPC's er zelf een maken —
--     laat alles toe.
--   • De omschrijving van de herboeking is de omschrijving van de bankregel,
--     zoals bij elke boeking door de schrijver; _description zet die vooraf,
--     net als de dialoog "handmatig boeken". De oude tekst blijft in de
--     oorspronkelijke regels en in de gebeurtenis staan.
--
-- GELIJKTIJDIGHEID
--   Grendelvolgorde van elke RPC: banktransactie (FOR UPDATE) →
--   administratiegrendel (assert_posting_allowed) → administratie (FOR SHARE)
--   → bij herclassificeren de gekozen grootboekrekening (FOR SHARE). Dat volgt
--   de bestaande volgorde A → T → I → L → C → Y; een rekening wordt door geen
--   enkel pad vóór T, L of C gegrendeld. Een tweede verzoek op
--   dezelfde transactie wacht op de rijgrendel en ziet daarna de nieuwe
--   toestand: verwachte groep wijkt af → 55000, of dezelfde request_id →
--   dezelfde uitkomst met replayed = true. Alle RPC's en triggers weigeren
--   buiten READ COMMITTED of lezen alleen wat al vastligt.
--   Een RPC is één transactie: elke fout — ook na de storno, na het losmaken
--   van de marker of bij COMMIT — draait alles terug. Er is geen EXCEPTION-blok.
--
-- WAT DEZE MIGRATIE NADRUKKELIJK NIET DOET
--   - Geen bestaande functie, schrijver of trigger opnieuw gedefinieerd; geen
--     grootboekregel geschreven buiten de bestaande schrijvers; geen bestaande
--     data gewijzigd; geen nieuwe kolom op een bestaande tabel.
--   - Geen rolcontrole in een trigger: de triggers bewaken integriteit, de RPC's
--     autorisatie.
--   - Geen app-wijziging, geen gegenereerde types (PR 2), geen UI (PR 3).
--
-- PRODUCTIE
--   Alleen via de Lovable Cloud SQL editor van alxlbdhpbwlehbdbfejw, na review,
--   na 20261017120000, met de leescontroles in
--   supabase/rollout/20261018120000_add_bank_transaction_corrections/.
--   Deze PR past niets toe.
--
-- ROLLBACK (handmatig, alleen met akkoord van de eigenaar).
--   Functioneel terugdraaien haalt de RPC's, de markerbewaking en de hold weg
--   en laat de gebeurtenistabel STAAN, mét haar eigen append-only-bewaking:
--   daarin staat de enige momentopname van vervangen boekingen. De
--   grootboekregels en tegenboekingen zelf blijven onaangeroerd.
--   Na het terugdraaien kan een vrijgegeven transactie weer via de gewone
--   werkstroom worden geboekt (de hold is weg) — dat is geen dubbele boeking,
--   want haar oude groep is tegengeboekt. De tabel weggooien alleen als zij leeg
--   is, en alleen met uitdrukkelijk akkoord.
-- ROLLBACK-BEGIN
--   DROP FUNCTION IF EXISTS public.return_bank_transaction_to_workflow(uuid, uuid, text);
--   DROP FUNCTION IF EXISTS public.release_bank_transaction_posting(uuid, uuid, uuid, text);
--   DROP FUNCTION IF EXISTS public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text);
--   DROP TRIGGER IF EXISTS validate_bank_allocation_not_released_trigger ON public.bank_transaction_allocations;
--   DROP TRIGGER IF EXISTS enforce_bank_transaction_release_hold_trigger ON public.bank_transactions;
--   DROP TRIGGER IF EXISTS enforce_bank_transaction_posting_marker_lineage_trigger ON public.bank_transaction_postings;
--   DROP TRIGGER IF EXISTS enforce_bank_transaction_posting_marker_delete_trigger ON public.bank_transaction_postings;
--   DROP TRIGGER IF EXISTS prevent_bank_transaction_posting_marker_truncate_trigger ON public.bank_transaction_postings;
--   DROP TRIGGER IF EXISTS prevent_bank_transaction_posting_marker_update_trigger ON public.bank_transaction_postings;
--   DROP FUNCTION IF EXISTS public.enforce_bank_allocation_not_released();
--   DROP FUNCTION IF EXISTS public.enforce_bank_transaction_release_hold();
--   DROP FUNCTION IF EXISTS public.enforce_bank_transaction_posting_marker_lineage();
--   DROP FUNCTION IF EXISTS public.enforce_bank_transaction_posting_marker_delete();
--   DROP FUNCTION IF EXISTS public.prevent_bank_transaction_posting_marker_mutation();
-- ROLLBACK-END
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten: fail closed ───────────────────────────────────────────────

DO $migratie$
BEGIN
  IF to_regclass('public.bank_transactions') IS NULL
     OR to_regclass('public.bank_transaction_postings') IS NULL
     OR to_regclass('public.bank_transaction_allocations') IS NULL
     OR to_regclass('public.ledger_postings') IS NULL
     OR to_regclass('public.ledger_reversal_postings') IS NULL THEN
    RAISE EXCEPTION 'Bankcorrecties vereisen bank_transactions, bank_transaction_postings, bank_transaction_allocations, ledger_postings en ledger_reversal_postings';
  END IF;
  IF to_regprocedure('public.post_bank_transaction(uuid)') IS NULL
     OR to_regprocedure('public.reverse_posting_group(uuid,date,text)') IS NULL
     OR to_regprocedure('public.assert_posting_allowed(uuid,date)') IS NULL
     OR to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.has_min_role(uuid,uuid,app_role)') IS NULL THEN
    RAISE EXCEPTION 'Bankcorrecties vereisen post_bank_transaction, reverse_posting_group, assert_posting_allowed, posting_account_ok en has_min_role';
  END IF;
  -- PR 0 (20261017120000): zonder die guards kan een correctie samenvallen met
  -- een factuurkoppeling.
  IF to_regprocedure('public.enforce_bank_direct_posting_without_allocations()') IS NULL
     OR to_regprocedure('public.enforce_bank_allocation_not_directly_posted()') IS NULL THEN
    RAISE EXCEPTION 'Bankcorrecties vereisen eerst 20261017120000 (guard tegen dubbele bankboeking)';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'bank_transaction_postings'
              AND column_name IN ('bank_transaction_id', 'posting_group_id', 'grootboekrekening_id', 'posting_date',
                                  'boekjaar', 'gross_amount', 'net_amount', 'btw_amount', 'btw_percentage',
                                  'user_id', 'created_at'))
          OR (table_name = 'ledger_postings' AND column_name = 'created_xact_id')
          OR (table_name = 'ledger_reversal_postings'
              AND column_name IN ('original_posting_group_id', 'reversal_posting_group_id')))) <> 14 THEN
    RAISE EXCEPTION 'Bankcorrecties: een vereiste kolom ontbreekt op de marker-, grootboek- of tegenboekingstabel';
  END IF;
END
$migratie$;

-- ── 1. De gebeurtenistabel ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.bank_transaction_posting_events (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                             bigint GENERATED ALWAYS AS IDENTITY,
  request_id                      uuid NOT NULL,
  actor_id                        uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  request_kind                    text NOT NULL,
  event_type                      text NOT NULL,
  bank_transaction_id             uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE RESTRICT,
  organization_id                 uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  client_id                       uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  expected_posting_group_id       uuid,
  superseded_posting_group_id     uuid,
  reversal_posting_group_id       uuid,
  replacement_posting_group_id    uuid,
  requested_grootboekrekening_id  uuid REFERENCES public.grootboekrekeningen(id) ON DELETE RESTRICT,
  requested_btw_percentage        numeric,
  requested_description           text,
  replacement_description         text,
  superseded_grootboekrekening_id uuid REFERENCES public.grootboekrekeningen(id) ON DELETE RESTRICT,
  superseded_btw_percentage       numeric,
  superseded_gross_amount         numeric(12,2),
  superseded_net_amount           numeric(12,2),
  superseded_btw_amount           numeric(12,2),
  superseded_posting_date         date,
  superseded_boekjaar             integer,
  superseded_posted_by            uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  superseded_posted_at            timestamptz,
  superseded_description          text,
  reason                          text,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_xact_id                 xid8 NOT NULL,

  CONSTRAINT bank_transaction_posting_events_seq_key UNIQUE (seq),
  CONSTRAINT bank_transaction_posting_events_request_key UNIQUE (actor_id, request_id, event_type),
  CONSTRAINT bank_transaction_posting_events_superseded_key UNIQUE (superseded_posting_group_id),
  CONSTRAINT bank_transaction_posting_events_reversal_key UNIQUE (reversal_posting_group_id),
  CONSTRAINT bank_transaction_posting_events_replacement_key UNIQUE (replacement_posting_group_id),

  CONSTRAINT bank_transaction_posting_events_kind_check
    CHECK (request_kind IN ('reclassify', 'release', 'return')),
  CONSTRAINT bank_transaction_posting_events_type_check
    CHECK (event_type IN ('posted', 'reclassified', 'reposted', 'released', 'returned', 'unchanged')),
  CONSTRAINT bank_transaction_posting_events_percentage_check
    CHECK (requested_btw_percentage IS NULL OR requested_btw_percentage IN (0, 9, 21)),
  CONSTRAINT bank_transaction_posting_events_description_check
    CHECK (requested_description IS NULL
           OR (btrim(requested_description, E' \t\r\n') <> '' AND length(requested_description) <= 500)),
  CONSTRAINT bank_transaction_posting_events_reason_check
    CHECK (reason IS NULL OR (btrim(reason, E' \t\r\n') <> '' AND length(reason) <= 500)),
  CONSTRAINT bank_transaction_posting_events_groups_distinct_check
    CHECK ((superseded_posting_group_id IS NULL
            OR (superseded_posting_group_id IS DISTINCT FROM replacement_posting_group_id
                AND superseded_posting_group_id IS DISTINCT FROM reversal_posting_group_id))
           AND (reversal_posting_group_id IS NULL
                OR reversal_posting_group_id IS DISTINCT FROM replacement_posting_group_id)),

  -- De momentopname is er volledig, of er is niets vervangen.
  CONSTRAINT bank_transaction_posting_events_snapshot_check CHECK (
    (superseded_posting_group_id IS NULL
      AND superseded_grootboekrekening_id IS NULL AND superseded_btw_percentage IS NULL
      AND superseded_gross_amount IS NULL AND superseded_net_amount IS NULL AND superseded_btw_amount IS NULL
      AND superseded_posting_date IS NULL AND superseded_boekjaar IS NULL
      AND superseded_posted_by IS NULL AND superseded_posted_at IS NULL AND superseded_description IS NULL)
    OR
    (superseded_posting_group_id IS NOT NULL
      AND superseded_grootboekrekening_id IS NOT NULL
      AND superseded_gross_amount IS NOT NULL AND superseded_net_amount IS NOT NULL AND superseded_btw_amount IS NOT NULL
      AND superseded_posting_date IS NOT NULL AND superseded_boekjaar IS NOT NULL
      AND superseded_posted_by IS NOT NULL AND superseded_posted_at IS NOT NULL AND superseded_description IS NOT NULL)),

  -- De vorm per gebeurtenis.
  CONSTRAINT bank_transaction_posting_events_shape_check CHECK (
    (event_type = 'posted' AND request_kind = 'reclassify'
      AND superseded_posting_group_id IS NULL AND reversal_posting_group_id IS NULL
      AND replacement_posting_group_id IS NOT NULL
      AND requested_grootboekrekening_id IS NOT NULL AND requested_btw_percentage IS NOT NULL
      AND replacement_description IS NOT NULL)
    OR
    (event_type IN ('reclassified', 'reposted') AND request_kind = 'reclassify'
      AND superseded_posting_group_id IS NOT NULL AND reversal_posting_group_id IS NOT NULL
      AND replacement_posting_group_id IS NOT NULL
      AND requested_grootboekrekening_id IS NOT NULL AND requested_btw_percentage IS NOT NULL
      AND replacement_description IS NOT NULL AND reason IS NOT NULL)
    OR
    (event_type = 'released' AND request_kind = 'release'
      AND superseded_posting_group_id IS NOT NULL AND reversal_posting_group_id IS NOT NULL
      AND replacement_posting_group_id IS NULL
      AND requested_grootboekrekening_id IS NULL AND requested_btw_percentage IS NULL
      AND requested_description IS NULL AND replacement_description IS NULL AND reason IS NOT NULL)
    OR
    (event_type = 'returned' AND request_kind IN ('reclassify', 'return')
      AND superseded_posting_group_id IS NULL AND reversal_posting_group_id IS NULL
      AND replacement_posting_group_id IS NULL
      AND requested_grootboekrekening_id IS NULL AND requested_btw_percentage IS NULL
      AND requested_description IS NULL AND replacement_description IS NULL AND reason IS NOT NULL)
    OR
    -- Een herclassificatie die niets hoefde te doen: alleen de aanvraag, zodat
    -- haar request_id verbruikt is en een herhaling exact dit antwoord geeft.
    (event_type = 'unchanged' AND request_kind = 'reclassify'
      AND superseded_posting_group_id IS NULL AND reversal_posting_group_id IS NULL
      AND replacement_posting_group_id IS NULL AND expected_posting_group_id IS NOT NULL
      AND requested_grootboekrekening_id IS NOT NULL AND requested_btw_percentage IS NOT NULL
      AND replacement_description IS NULL AND reason IS NOT NULL))
);

-- Eén request_id is één handeling. Alleen het `returned` dat een herboeking na
-- vrijgave voorafgaat, deelt zijn request_id met de `posted` die erop volgt;
-- verder heeft elke (actor, request_id) precies één gebeurtenis. Zo kan één
-- request_id nooit twee handelingen dekken, ook niet bij gelijktijdig gebruik op
-- twee transacties (de tweede faalt dan als geheel).
CREATE UNIQUE INDEX IF NOT EXISTS bank_transaction_posting_events_request_once
  ON public.bank_transaction_posting_events (actor_id, request_id)
  WHERE NOT (event_type = 'returned' AND request_kind = 'reclassify');

CREATE INDEX IF NOT EXISTS idx_bank_transaction_posting_events_tx_seq
  ON public.bank_transaction_posting_events (bank_transaction_id, seq);
CREATE INDEX IF NOT EXISTS idx_bank_transaction_posting_events_org
  ON public.bank_transaction_posting_events (organization_id);
CREATE INDEX IF NOT EXISTS idx_bank_transaction_posting_events_client
  ON public.bank_transaction_posting_events (client_id);

-- Alleen lezen voor applicatierollen; schrijven gebeurt uitsluitend door de
-- RPC's hieronder, via het eigenaarschap van de tabel.
REVOKE ALL ON TABLE public.bank_transaction_posting_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.bank_transaction_posting_events TO authenticated, service_role;
REVOKE ALL ON SEQUENCE public.bank_transaction_posting_events_seq_seq FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.bank_transaction_posting_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_bank_transaction_posting_events_select ON public.bank_transaction_posting_events;
CREATE POLICY role_bank_transaction_posting_events_select
  ON public.bank_transaction_posting_events FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

COMMENT ON TABLE public.bank_transaction_posting_events IS
'Append-only geschiedenis van directe bankboekingen per banktransactie (Bankcorrecties v1.1): posted, reclassified, reposted, released, returned en unchanged. Elke vervangen boekingsgroep staat hier precies één keer, met haar tegenboeking, haar opvolger (NULL bij vrijgeven) en een momentopname. De marker in bank_transaction_postings is de ene actieve directe boeking. Alleen de correctie-RPC''s schrijven; UNIQUE (actor_id, request_id, event_type) is de idempotentiesleutel, seq de volgorde.';

-- ── 2. Bewaking van de gebeurtenissen ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_bank_transaction_posting_event()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org          uuid;
  v_client       uuid;
  v_last         text;
  v_marker_group uuid;
  v_rows         integer;
  v_bad          integer;
  v_own          integer;
  v_date         date;
  v_boekjaar     integer;
  v_debit        numeric;
  v_desc         text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een boekingsgebeurtenis kan alleen in een READ COMMITTED transactie worden vastgelegd (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  -- Stempel: de transactie en het moment zijn die van deze INSERT, niet van
  -- wie de rij aanlevert.
  NEW.created_xact_id := pg_current_xact_id();
  NEW.created_at := now();

  -- Elke gebeurtenis van een transactie wordt onder haar rijgrendel
  -- vastgelegd; zo volgt seq per transactie de commitvolgorde.
  SELECT bt.organization_id, bt.client_id INTO v_org, v_client
  FROM public.bank_transactions bt
  WHERE bt.id = NEW.bank_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Een boekingsgebeurtenis moet naar een bestaande banktransactie verwijzen' USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM v_org OR NEW.client_id IS DISTINCT FROM v_client THEN
    RAISE EXCEPTION 'Organisatie of administratie van deze boekingsgebeurtenis wijkt af van haar banktransactie' USING ERRCODE = '23514';
  END IF;

  SELECT e.event_type INTO v_last
  FROM public.bank_transaction_posting_events e
  WHERE e.bank_transaction_id = NEW.bank_transaction_id
  ORDER BY e.seq DESC
  LIMIT 1;

  SELECT m.posting_group_id INTO v_marker_group
  FROM public.bank_transaction_postings m
  WHERE m.bank_transaction_id = NEW.bank_transaction_id;

  -- De vervangen groep: een directe bankboeking van déze transactie, met
  -- exact deze tegenboeking, en niet meer de actieve marker.
  IF NEW.superseded_posting_group_id IS NOT NULL THEN
    SELECT count(*),
           count(*) FILTER (WHERE lp.source_type <> 'bank_transaction'
                               OR lp.source_id IS DISTINCT FROM NEW.bank_transaction_id),
           min(lp.posting_date), min(lp.boekjaar), sum(lp.debit_amount)
      INTO v_rows, v_bad, v_date, v_boekjaar, v_debit
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = NEW.superseded_posting_group_id;

    IF v_rows = 0 OR v_bad > 0 THEN
      RAISE EXCEPTION 'De vervangen boekingsgroep is geen directe bankboeking van deze banktransactie' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.ledger_reversal_postings r
      WHERE r.original_posting_group_id = NEW.superseded_posting_group_id
        AND r.reversal_posting_group_id = NEW.reversal_posting_group_id
    ) THEN
      RAISE EXCEPTION 'De opgegeven tegenboeking hoort niet bij de vervangen boekingsgroep' USING ERRCODE = '23514';
    END IF;

    IF v_marker_group IS NOT DISTINCT FROM NEW.superseded_posting_group_id THEN
      RAISE EXCEPTION 'De vervangen boekingsgroep is nog de actieve boeking van deze banktransactie' USING ERRCODE = '23514';
    END IF;

    SELECT lp.description INTO v_desc
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = NEW.superseded_posting_group_id
    ORDER BY lp.line_no, lp.id
    LIMIT 1;

    IF NEW.superseded_posting_date IS DISTINCT FROM v_date
       OR NEW.superseded_boekjaar IS DISTINCT FROM v_boekjaar
       OR NEW.superseded_gross_amount IS DISTINCT FROM v_debit
       OR NEW.superseded_description IS DISTINCT FROM v_desc THEN
      RAISE EXCEPTION 'De momentopname van de vervangen boeking wijkt af van haar grootboekregels' USING ERRCODE = '23514';
    END IF;

    -- reclassified = de storno is hier gemaakt; reposted = zij bestond al.
    SELECT count(*) INTO v_own
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = NEW.reversal_posting_group_id
      AND lp.created_xact_id = pg_current_xact_id();

    IF NEW.event_type = 'reclassified' AND v_own = 0 THEN
      RAISE EXCEPTION 'Bij een herclassificatie hoort een tegenboeking uit dezelfde transactie' USING ERRCODE = '23514';
    END IF;
    IF NEW.event_type = 'reposted' AND v_own > 0 THEN
      RAISE EXCEPTION 'Een herboeking na tegenboeking hoort bij een eerder vastgelegde tegenboeking' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- De opvolger: de actieve marker, en in déze transactie geboekt.
  IF NEW.replacement_posting_group_id IS NOT NULL THEN
    IF v_marker_group IS DISTINCT FROM NEW.replacement_posting_group_id THEN
      RAISE EXCEPTION 'De vervangende boekingsgroep is niet de actieve boeking van deze banktransactie' USING ERRCODE = '23514';
    END IF;

    SELECT count(*), count(*) FILTER (WHERE lp.created_xact_id IS DISTINCT FROM pg_current_xact_id())
      INTO v_rows, v_bad
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = NEW.replacement_posting_group_id;

    IF v_rows = 0 OR v_bad > 0 THEN
      RAISE EXCEPTION 'De vervangende boekingsgroep moet in dezelfde transactie zijn geboekt' USING ERRCODE = '23514';
    END IF;

    SELECT lp.description INTO v_desc
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = NEW.replacement_posting_group_id
    ORDER BY lp.line_no, lp.id
    LIMIT 1;

    IF NEW.replacement_description IS DISTINCT FROM v_desc THEN
      RAISE EXCEPTION 'De omschrijving van de vervangende boeking wijkt af van haar grootboekregels' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_type = 'unchanged' THEN
    -- Niets vervangen: de verwachte groep is de actieve, niet tegengeboekte marker.
    IF v_marker_group IS DISTINCT FROM NEW.expected_posting_group_id
       OR EXISTS (SELECT 1 FROM public.ledger_reversal_postings r WHERE r.original_posting_group_id = v_marker_group) THEN
      RAISE EXCEPTION 'Een ongewijzigde herclassificatie hoort bij de actieve, niet tegengeboekte boeking' USING ERRCODE = '23514';
    END IF;
  ELSIF v_marker_group IS NOT NULL THEN
    RAISE EXCEPTION 'Na vrijgeven of terugzetten heeft een banktransactie geen actieve directe boeking' USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type = 'returned' AND v_last IS DISTINCT FROM 'released' THEN
    RAISE EXCEPTION 'Alleen een vrijgegeven banktransactie kan terug naar de werkstroom' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'posted' AND v_last = 'released' THEN
    RAISE EXCEPTION 'Een vrijgegeven banktransactie gaat eerst terug naar de werkstroom' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_transaction_posting_event() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_transaction_posting_event() IS
'BEFORE INSERT op bank_transaction_posting_events: stempelt transactie en moment, grendelt de banktransactie, en toetst de lineage — de vervangen groep is een directe bankboeking van deze transactie met exact deze tegenboeking en niet meer actief; de opvolger is de actieve marker en in deze transactie geboekt; unchanged hoort bij de actieve, niet tegengeboekte marker; returned alleen na released; posted niet direct na released.';

DROP TRIGGER IF EXISTS enforce_bank_transaction_posting_event_trigger ON public.bank_transaction_posting_events;
CREATE TRIGGER enforce_bank_transaction_posting_event_trigger
BEFORE INSERT ON public.bank_transaction_posting_events
FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_transaction_posting_event();

CREATE OR REPLACE FUNCTION public.prevent_bank_transaction_posting_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'bank_transaction_posting_events is append-only: % is niet toegestaan. De geschiedenis van een bankboeking wordt aangevuld, nooit herschreven.', TG_OP
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_bank_transaction_posting_event_mutation() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.prevent_bank_transaction_posting_event_mutation() IS
'Weigert UPDATE, DELETE en TRUNCATE op bank_transaction_posting_events, voor elke rol (ENABLE ALWAYS).';

DROP TRIGGER IF EXISTS prevent_bank_transaction_posting_event_mutation_trigger ON public.bank_transaction_posting_events;
CREATE TRIGGER prevent_bank_transaction_posting_event_mutation_trigger
BEFORE UPDATE OR DELETE ON public.bank_transaction_posting_events
FOR EACH ROW EXECUTE FUNCTION public.prevent_bank_transaction_posting_event_mutation();
ALTER TABLE public.bank_transaction_posting_events ENABLE ALWAYS TRIGGER prevent_bank_transaction_posting_event_mutation_trigger;

DROP TRIGGER IF EXISTS prevent_bank_transaction_posting_event_truncate_trigger ON public.bank_transaction_posting_events;
CREATE TRIGGER prevent_bank_transaction_posting_event_truncate_trigger
BEFORE TRUNCATE ON public.bank_transaction_posting_events
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_bank_transaction_posting_event_mutation();
ALTER TABLE public.bank_transaction_posting_events ENABLE ALWAYS TRIGGER prevent_bank_transaction_posting_event_truncate_trigger;

-- ── 3. Bewaking van de marker ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_bank_transaction_posting_marker_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Een directe bankboeking is onveranderlijk: % is niet toegestaan. Een correctie verloopt via tegenboeking en herboeking.', TG_OP
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_bank_transaction_posting_marker_mutation() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.prevent_bank_transaction_posting_marker_mutation() IS
'Weigert UPDATE en TRUNCATE op bank_transaction_postings, voor elke rol (ENABLE ALWAYS).';

DROP TRIGGER IF EXISTS prevent_bank_transaction_posting_marker_update_trigger ON public.bank_transaction_postings;
CREATE TRIGGER prevent_bank_transaction_posting_marker_update_trigger
BEFORE UPDATE ON public.bank_transaction_postings
FOR EACH ROW EXECUTE FUNCTION public.prevent_bank_transaction_posting_marker_mutation();
ALTER TABLE public.bank_transaction_postings ENABLE ALWAYS TRIGGER prevent_bank_transaction_posting_marker_update_trigger;

DROP TRIGGER IF EXISTS prevent_bank_transaction_posting_marker_truncate_trigger ON public.bank_transaction_postings;
CREATE TRIGGER prevent_bank_transaction_posting_marker_truncate_trigger
BEFORE TRUNCATE ON public.bank_transaction_postings
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_bank_transaction_posting_marker_mutation();
ALTER TABLE public.bank_transaction_postings ENABLE ALWAYS TRIGGER prevent_bank_transaction_posting_marker_truncate_trigger;

CREATE OR REPLACE FUNCTION public.enforce_bank_transaction_posting_marker_delete()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ledger_reversal_postings r
    WHERE r.original_posting_group_id = OLD.posting_group_id
  ) THEN
    RAISE EXCEPTION 'Een directe bankboeking kan alleen worden losgemaakt nadat zij is tegengeboekt'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_transaction_posting_marker_delete() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_transaction_posting_marker_delete() IS
'BEFORE DELETE op bank_transaction_postings (ENABLE ALWAYS): een marker mag alleen weg als haar boekingsgroep al is tegengeboekt.';

DROP TRIGGER IF EXISTS enforce_bank_transaction_posting_marker_delete_trigger ON public.bank_transaction_postings;
CREATE TRIGGER enforce_bank_transaction_posting_marker_delete_trigger
BEFORE DELETE ON public.bank_transaction_postings
FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_transaction_posting_marker_delete();
ALTER TABLE public.bank_transaction_postings ENABLE ALWAYS TRIGGER enforce_bank_transaction_posting_marker_delete_trigger;

CREATE OR REPLACE FUNCTION public.enforce_bank_transaction_posting_marker_lineage()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.bank_transaction_posting_events e
    WHERE e.bank_transaction_id = OLD.bank_transaction_id
      AND e.superseded_posting_group_id = OLD.posting_group_id
      AND e.created_xact_id = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'Een losgemaakte directe bankboeking moet in dezelfde transactie als correctie of vrijgave zijn vastgelegd'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_transaction_posting_marker_lineage() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_transaction_posting_marker_lineage() IS
'Uitgestelde constraint-trigger na DELETE op bank_transaction_postings (ENABLE ALWAYS): bij COMMIT bestaat een gebeurtenis uit dezelfde transactie die de groep van de verwijderde marker als vervangen noemt.';

DROP TRIGGER IF EXISTS enforce_bank_transaction_posting_marker_lineage_trigger ON public.bank_transaction_postings;
CREATE CONSTRAINT TRIGGER enforce_bank_transaction_posting_marker_lineage_trigger
AFTER DELETE ON public.bank_transaction_postings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_transaction_posting_marker_lineage();
ALTER TABLE public.bank_transaction_postings ENABLE ALWAYS TRIGGER enforce_bank_transaction_posting_marker_lineage_trigger;

-- ── 4. D12 — de vrijgave-hold ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_bank_transaction_release_hold()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last             text;
  v_identity_changed boolean := false;
  v_coding_changed   boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_identity_changed :=
         NEW.id               IS DISTINCT FROM OLD.id
      OR NEW.amount           IS DISTINCT FROM OLD.amount
      OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
      OR NEW.client_id        IS DISTINCT FROM OLD.client_id
      OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
      OR NEW.user_id          IS DISTINCT FROM OLD.user_id;
    v_coding_changed :=
         NEW.match_status         IS DISTINCT FROM OLD.match_status
      OR NEW.grootboekrekening_id IS DISTINCT FROM OLD.grootboekrekening_id
      OR NEW.btw_percentage       IS DISTINCT FROM OLD.btw_percentage
      OR NEW.matched_invoice_id   IS DISTINCT FROM OLD.matched_invoice_id
      OR NEW.match_confidence     IS DISTINCT FROM OLD.match_confidence;

    -- Snel pad: geen bewaakt veld verandert.
    IF NOT v_identity_changed AND NOT v_coding_changed THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Een actieve marker: de bestaande bevriezing beslist.
  IF EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = OLD.id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- VOLATILE: deze query krijgt een verse snapshot en ziet dus een vrijgave
  -- die net is gecommit terwijl deze opdracht op de rijgrendel wachtte.
  SELECT e.event_type INTO v_last
  FROM public.bank_transaction_posting_events e
  WHERE e.bank_transaction_id = OLD.id
  ORDER BY e.seq DESC
  LIMIT 1;

  -- Geen geschiedenis: gedrag gelijk aan vóór deze migratie.
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deze banktransactie heeft een boekingsgeschiedenis in het grootboek; verwijderen is niet mogelijk.'
      USING ERRCODE = '42501';
  END IF;

  IF v_identity_changed THEN
    RAISE EXCEPTION 'Deze banktransactie heeft een boekingsgeschiedenis in het grootboek; bedrag, datum, administratie, organisatie en eigenaar kunnen niet meer worden gewijzigd.'
      USING ERRCODE = '42501';
  END IF;

  -- Vrijgegeven = de laatste gebeurtenis is `released` én elke directe
  -- bankgroep van deze transactie staat al als vervangen vast. Een groep die
  -- (nog) niet vervangen is, hoort bij een correctie die nu in dezelfde
  -- transactie loopt: haar marker is net losgemaakt en haar gebeurtenis volgt
  -- — de uitgestelde lineage-controle dwingt dat bij COMMIT af. Zo'n groep
  -- bestaat na een vrijgave alleen als zij buiten de RPC's om is geboekt,
  -- bijvoorbeeld tijdens een functionele rollback van deze migratie.
  IF v_last = 'released' AND v_coding_changed
     AND NOT EXISTS (
       SELECT 1 FROM public.ledger_postings lp
       WHERE lp.source_type = 'bank_transaction' AND lp.source_id = OLD.id
         AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                         WHERE e.superseded_posting_group_id = lp.posting_group_id)) THEN
    RAISE EXCEPTION 'Deze banktransactie is vrijgegeven na een geboekte correctie; status, rekening, BTW en factuurmatch wijzigen alleen via "Opnieuw boeken" of "Terug naar werkstroom" door een accountant.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_transaction_release_hold() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_transaction_release_hold() IS
'D12 — BEFORE UPDATE OR DELETE op bank_transactions (ENABLE ALWAYS). Zonder marker en met boekingsgeschiedenis: verwijderen en identiteitswijzigingen geweigerd; na een vrijgave (laatste gebeurtenis released) ook status, rekening, BTW en factuurmatch, voor elke rol en elk pad. Kijkt niet naar rollen.';

DROP TRIGGER IF EXISTS enforce_bank_transaction_release_hold_trigger ON public.bank_transactions;
CREATE TRIGGER enforce_bank_transaction_release_hold_trigger
BEFORE UPDATE OR DELETE ON public.bank_transactions
FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_transaction_release_hold();
ALTER TABLE public.bank_transactions ENABLE ALWAYS TRIGGER enforce_bank_transaction_release_hold_trigger;

CREATE OR REPLACE FUNCTION public.enforce_bank_allocation_not_released()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx_org    uuid;
  v_tx_client uuid;
  v_last      text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.bank_transaction_id IS NOT DISTINCT FROM OLD.bank_transaction_id THEN
    RETURN NULL;
  END IF;

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een bankkoppeling kan alleen in een READ COMMITTED transactie worden vastgelegd of verplaatst (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  -- Dezelfde grendel als de foreign key en PR 0: botst met de FOR UPDATE van
  -- een vrijgave, dus na het wachten is de gebeurtenis zichtbaar.
  SELECT bt.organization_id, bt.client_id INTO v_tx_org, v_tx_client
  FROM public.bank_transactions bt
  WHERE bt.id = NEW.bank_transaction_id
  FOR KEY SHARE;

  IF NOT FOUND
     OR NEW.organization_id IS DISTINCT FROM v_tx_org
     OR NEW.client_id IS DISTINCT FROM v_tx_client THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = NEW.bank_transaction_id) THEN
    RETURN NULL;
  END IF;

  SELECT e.event_type INTO v_last
  FROM public.bank_transaction_posting_events e
  WHERE e.bank_transaction_id = NEW.bank_transaction_id
  ORDER BY e.seq DESC
  LIMIT 1;

  IF v_last = 'released' THEN
    RAISE EXCEPTION 'Deze banktransactie is vrijgegeven na een geboekte correctie; koppel haar pas aan een factuur nadat een accountant haar terug naar de werkstroom heeft gezet.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_allocation_not_released() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_allocation_not_released() IS
'D12 — AFTER INSERT OR UPDATE OF bank_transaction_id op bank_transaction_allocations: geen koppeling naar een vrijgegeven banktransactie. Eerst READ COMMITTED en tenantconsistentie (neutrale 42501), dan de hold (23514).';

DROP TRIGGER IF EXISTS validate_bank_allocation_not_released_trigger ON public.bank_transaction_allocations;
CREATE TRIGGER validate_bank_allocation_not_released_trigger
AFTER INSERT OR UPDATE OF bank_transaction_id ON public.bank_transaction_allocations
FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_allocation_not_released();

-- ── 5. De correctie-RPC's ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reclassify_bank_transaction(
  _transaction_id            uuid,
  _expected_posting_group_id uuid,
  _grootboekrekening_id      uuid,
  _btw_percentage            numeric,
  _request_id                uuid,
  _reason                    text DEFAULT NULL,
  _description               text DEFAULT NULL
)
RETURNS TABLE (
  outcome                     text,
  replayed                    boolean,
  posting_group_id            uuid,
  superseded_posting_group_id uuid,
  reversal_posting_group_id   uuid,
  event_id                    uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid         uuid := auth.uid();
  v_reason      text;
  v_desc_arg    text;
  v_new_desc    text;
  v_old_desc    text;
  v_tx          public.bank_transactions%ROWTYPE;
  v_client      public.clients%ROWTYPE;
  v_account     public.grootboekrekeningen%ROWTYPE;
  v_prev        public.bank_transaction_posting_events%ROWTYPE;
  v_marker      public.bank_transaction_postings%ROWTYPE;
  v_has_marker  boolean;
  v_last        text;
  v_state       text;
  v_reversal    uuid;
  v_lines       integer;
  v_line_acct   uuid;
  v_line_amount numeric;
  v_vat_acct    uuid;
  v_new_group   uuid;
  v_event       uuid;
  v_last_rev    uuid;
  v_rev_date    date;
BEGIN
  -- (0) Alleen de argumenten: niets over opgeslagen gegevens.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een bankcorrectie kan alleen in een READ COMMITTED transactie (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  IF _transaction_id IS NULL OR _grootboekrekening_id IS NULL OR _btw_percentage IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'Banktransactie, grootboekrekening, BTW-percentage en request_id zijn verplicht' USING ERRCODE = '22004';
  END IF;
  IF _btw_percentage NOT IN (0, 9, 21) THEN
    RAISE EXCEPTION 'Alleen 0, 9 of 21 procent BTW is toegestaan' USING ERRCODE = '22023';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(_reason, ''), E' \t\r\n'), '');
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'De toelichting is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;
  v_desc_arg := NULLIF(btrim(COALESCE(_description, ''), E' \t\r\n'), '');
  IF length(v_desc_arg) > 500 THEN
    RAISE EXCEPTION 'De omschrijving is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;

  -- (1) De rijgrendel: elk verzoek op deze transactie wacht hier op het vorige.
  SELECT * INTO v_tx
  FROM public.bank_transactions bt
  WHERE bt.id = _transaction_id
  FOR UPDATE;

  -- (2) Leesdrempel: "bestaat niet" en "niet van jou" zijn niet te onderscheiden.
  IF NOT FOUND
     OR v_tx.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_tx.organization_id, 'read_only') THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  -- (3) Schrijfdrempel.
  IF NOT public.has_min_role(v_uid, v_tx.organization_id, 'assistant') THEN
    RAISE EXCEPTION 'Geen rechten om te boeken voor deze organisatie' USING ERRCODE = '42501';
  END IF;

  -- (4) Herhaling: alleen eigen request_id's, en pas na de drempels.
  SELECT e.* INTO v_prev
  FROM public.bank_transaction_posting_events e
  WHERE e.actor_id = v_uid AND e.request_id = _request_id
  ORDER BY e.seq DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_prev.bank_transaction_id IS DISTINCT FROM v_tx.id
       OR v_prev.request_kind <> 'reclassify'
       OR v_prev.event_type NOT IN ('posted', 'reclassified', 'reposted', 'unchanged')
       OR v_prev.expected_posting_group_id IS DISTINCT FROM _expected_posting_group_id
       OR v_prev.requested_grootboekrekening_id IS DISTINCT FROM _grootboekrekening_id
       OR v_prev.requested_btw_percentage IS DISTINCT FROM _btw_percentage
       OR v_prev.requested_description IS DISTINCT FROM v_desc_arg
       OR v_prev.reason IS DISTINCT FROM v_reason THEN
      RAISE EXCEPTION 'Deze request_id is al gebruikt voor een andere aanvraag; gebruik een nieuwe' USING ERRCODE = '22023';
    END IF;

    IF (v_prev.event_type <> 'posted'
        OR EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                   WHERE e.actor_id = v_uid AND e.request_id = _request_id AND e.event_type = 'returned'))
       AND NOT public.has_min_role(v_uid, v_tx.organization_id, 'accountant') THEN
      RAISE EXCEPTION 'Geen rechten om een geboekte banktransactie te corrigeren (accountant vereist)' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY SELECT
      CASE WHEN EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                        WHERE e.actor_id = v_uid AND e.request_id = _request_id AND e.event_type = 'returned')
           THEN 'reposted_after_release' ELSE v_prev.event_type END,
      true,
      COALESCE(v_prev.replacement_posting_group_id,
               CASE WHEN v_prev.event_type = 'unchanged' THEN v_prev.expected_posting_group_id END),
      v_prev.superseded_posting_group_id,
      v_prev.reversal_posting_group_id,
      v_prev.id;
    RETURN;
  END IF;

  -- De administratie moet bij de organisatie van de transactie horen — vóór de
  -- boekingsblokkade, zodat die nooit iets over een andere tenant zegt of
  -- grendelt (RLS toetst alleen de organisatie op de bankregel zelf).
  IF NOT EXISTS (SELECT 1 FROM public.clients c
                 WHERE c.id = v_tx.client_id AND c.organization_id = v_tx.organization_id) THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  -- (5) De boekingsblokkade op de transactiedatum; neemt eerst de
  --     administratiegrendel, zodat een blokkade niet tussendoor kan wijzigen.
  PERFORM public.assert_posting_allowed(v_tx.client_id, v_tx.transaction_date);

  -- De configuratie ligt vast tot COMMIT: een gelijktijdige wijziging van de
  -- bank- of BTW-rekening kan niet tussen toets en boeking vallen.
  SELECT * INTO v_client
  FROM public.clients c
  WHERE c.id = v_tx.client_id
  FOR SHARE;

  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_tx.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  -- (6) De toestand, onder de grendels gelezen.
  SELECT m.* INTO v_marker
  FROM public.bank_transaction_postings m
  WHERE m.bank_transaction_id = v_tx.id;
  v_has_marker := FOUND;

  IF v_has_marker THEN
    SELECT r.reversal_posting_group_id INTO v_reversal
    FROM public.ledger_reversal_postings r
    WHERE r.original_posting_group_id = v_marker.posting_group_id;
    v_state := CASE WHEN v_reversal IS NULL THEN 'S1' ELSE 'S2' END;
  ELSE
    SELECT e.event_type, e.reversal_posting_group_id INTO v_last, v_last_rev
    FROM public.bank_transaction_posting_events e
    WHERE e.bank_transaction_id = v_tx.id
    ORDER BY e.seq DESC
    LIMIT 1;
    IF v_last IN ('posted', 'reclassified', 'reposted') THEN
      RAISE EXCEPTION 'De boekingsgeschiedenis van deze banktransactie is niet consistent; corrigeer niet automatisch' USING ERRCODE = '23514';
    END IF;
    v_state := CASE WHEN v_last = 'released' THEN 'S3' ELSE 'S0' END;
  END IF;

  -- (7a) Verwachte toestand.
  IF (v_state IN ('S0', 'S3') AND _expected_posting_group_id IS NOT NULL)
     OR (v_state IN ('S1', 'S2') AND _expected_posting_group_id IS DISTINCT FROM v_marker.posting_group_id) THEN
    RAISE EXCEPTION 'De boekingstoestand is gewijzigd; ververs en probeer opnieuw' USING ERRCODE = '55000';
  END IF;

  -- (7b) Factuurkoppelingen vallen buiten v1.
  IF EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = v_tx.id) THEN
    RAISE EXCEPTION 'Deze banktransactie is aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie' USING ERRCODE = '22023';
  END IF;

  -- (7b') Ook een gematchte transactie zonder koppelingsrij (een oudere koppeling
  --       via de match) is een factuurkoppeling. Dat kan alleen in S0: een
  --       directe boeking staat altijd op handmatig_geboekt. Een factuurmatch op
  --       een handmatig geboekte regel (een achtergebleven suggestie) laat de RPC
  --       ongemoeid; alleen een onbevestigde suggestie wordt gewist (zie de UPDATE).
  IF v_tx.match_status = 'gematcht' THEN
    RAISE EXCEPTION 'Deze banktransactie is via de match aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie' USING ERRCODE = '22023';
  END IF;

  -- (7c) Een geboekte of vrijgegeven transactie: accountant en een toelichting.
  IF v_state <> 'S0' THEN
    IF NOT public.has_min_role(v_uid, v_tx.organization_id, 'accountant') THEN
      RAISE EXCEPTION 'Geen rechten om een geboekte banktransactie te corrigeren (accountant vereist)' USING ERRCODE = '42501';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'Een toelichting (1 tot 500 tekens) is verplicht bij het corrigeren van een geboekte banktransactie' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- (7c') Een bestaande storno op een latere datum dan de transactie: opnieuw
  --       boeken op de transactiedatum zou bank, kosten en BTW in de periode
  --       daartussen dubbel boeken. Alleen een storno op de transactiedatum
  --       (zoals deze RPC er zelf een maakt) laat herboeken toe.
  IF v_state IN ('S2', 'S3') THEN
    SELECT r.posting_date INTO v_rev_date
    FROM public.ledger_reversal_postings r
    WHERE r.reversal_posting_group_id = CASE WHEN v_state = 'S2' THEN v_reversal ELSE v_last_rev END;
    IF v_rev_date IS DISTINCT FROM v_tx.transaction_date THEN
      RAISE EXCEPTION 'De tegenboeking staat op %, niet op de transactiedatum %: opnieuw boeken op de transactiedatum zou de periode daartussen dubbel boeken. Corrigeer dit met een memoriaalboeking.',
        v_rev_date, v_tx.transaction_date
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- (7d) De nieuwe codering. Eerst de reikwijdte (zonder grendel: een rekening
  --      van een andere tenant wordt nooit gegrendeld), dan de rekening FOR
  --      SHARE tot COMMIT: een gelijktijdige deactivering kan niet tussen deze
  --      toets en de boeking vallen — de schrijver toetst `actief` zelf niet.
  IF NOT public.posting_account_ok(_grootboekrekening_id, v_tx.organization_id, v_tx.client_id) THEN
    RAISE EXCEPTION 'De gekozen grootboekrekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';
  END IF;
  SELECT g.* INTO v_account
  FROM public.grootboekrekeningen g
  WHERE g.id = _grootboekrekening_id
  FOR SHARE;
  IF NOT FOUND OR NOT COALESCE(v_account.actief, false) THEN
    RAISE EXCEPTION 'De gekozen grootboekrekening is niet actief' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_client.btw_vrijgesteld, false) AND _btw_percentage <> 0 THEN
    RAISE EXCEPTION 'Deze administratie is btw-vrijgesteld; alleen 0 procent BTW is toegestaan' USING ERRCODE = '22023';
  END IF;
  IF _btw_percentage > 0
     AND (CASE WHEN v_tx.amount < 0 THEN v_client.btw_te_vorderen_rekening_id
               ELSE v_client.btw_te_betalen_rekening_id END) IS NULL THEN
    RAISE EXCEPTION 'Geen BTW-rekening ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  -- De omschrijving die de schrijver straks gebruikt, met zijn eigen regel.
  v_new_desc := COALESCE(NULLIF(btrim(COALESCE(v_desc_arg, v_tx.description)), ''), 'Bankboeking');

  IF v_state IN ('S1', 'S2') THEN
    SELECT lp.description INTO v_old_desc
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = v_marker.posting_group_id
    ORDER BY lp.line_no, lp.id
    LIMIT 1;
  END IF;

  -- (7e) D7: een correctie verplaatst geen bedragen naar een andere bank- of
  --      BTW-rekening. Alleen voor een actieve (niet tegengeboekte) groep.
  IF v_state = 'S1' THEN
    -- De bankzijde: credit bij geld eraf, debet bij geld erbij — precies één regel.
    SELECT count(*), min(lp.grootboekrekening_id::text)::uuid INTO v_lines, v_line_acct
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = v_marker.posting_group_id
      AND ((v_tx.amount < 0 AND lp.credit_amount > 0) OR (v_tx.amount > 0 AND lp.debit_amount > 0));
    IF v_lines <> 1 THEN
      RAISE EXCEPTION 'De bestaande boeking heeft niet de vorm van een directe bankboeking; corrigeer haar via het grootboek' USING ERRCODE = '23514';
    END IF;
    IF v_line_acct IS DISTINCT FROM v_client.bank_rekening_id THEN
      RAISE EXCEPTION 'De bankrekening van deze administratie is gewijzigd sinds de boeking; een correctie zou het bedrag naar een andere bankrekening verplaatsen. Geef de boeking vrij en boek haar daarna opnieuw.'
        USING ERRCODE = '23514';
    END IF;

    -- De tegenzijde: de kostenregel, plus de BTW-regel als er BTW is geboekt.
    SELECT count(*) INTO v_lines
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = v_marker.posting_group_id
      AND ((v_tx.amount < 0 AND lp.debit_amount > 0) OR (v_tx.amount > 0 AND lp.credit_amount > 0));
    IF v_lines <> (CASE WHEN v_marker.btw_amount > 0 THEN 2 ELSE 1 END) THEN
      RAISE EXCEPTION 'De bestaande boeking heeft niet de vorm van een directe bankboeking; corrigeer haar via het grootboek' USING ERRCODE = '23514';
    END IF;

    IF v_marker.btw_amount > 0 THEN
      SELECT lp.grootboekrekening_id, lp.debit_amount + lp.credit_amount INTO v_line_acct, v_line_amount
      FROM public.ledger_postings lp
      WHERE lp.posting_group_id = v_marker.posting_group_id
        AND ((v_tx.amount < 0 AND lp.debit_amount > 0) OR (v_tx.amount > 0 AND lp.credit_amount > 0))
      ORDER BY lp.line_no DESC, lp.id DESC
      LIMIT 1;
      IF v_line_amount IS DISTINCT FROM v_marker.btw_amount THEN
        RAISE EXCEPTION 'De bestaande boeking heeft niet de vorm van een directe bankboeking; corrigeer haar via het grootboek' USING ERRCODE = '23514';
      END IF;
      v_vat_acct := CASE WHEN v_tx.amount < 0 THEN v_client.btw_te_vorderen_rekening_id
                         ELSE v_client.btw_te_betalen_rekening_id END;
      IF v_line_acct IS DISTINCT FROM v_vat_acct THEN
        RAISE EXCEPTION 'De BTW-rekening van deze administratie is gewijzigd sinds de boeking; een correctie zou BTW naar een andere rekening verplaatsen. Geef de boeking vrij en boek haar daarna opnieuw.'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    -- (7f) Effectief dezelfde codering en omschrijving: niets te boeken. De
    --      aanvraag wordt wel vastgelegd, zodat haar request_id verbruikt is:
    --      een herhaling (bv. na een verloren antwoord) geeft exact dit antwoord,
    --      ook als de boeking inmiddels handmatig is tegengeboekt.
    IF v_marker.grootboekrekening_id = _grootboekrekening_id
       AND COALESCE(v_marker.btw_percentage, 0) = _btw_percentage
       AND v_old_desc IS NOT DISTINCT FROM v_new_desc THEN
      INSERT INTO public.bank_transaction_posting_events (
        request_id, actor_id, request_kind, event_type,
        bank_transaction_id, organization_id, client_id,
        expected_posting_group_id,
        requested_grootboekrekening_id, requested_btw_percentage, requested_description,
        reason, created_xact_id
      ) VALUES (
        _request_id, v_uid, 'reclassify', 'unchanged',
        v_tx.id, v_tx.organization_id, v_tx.client_id,
        _expected_posting_group_id,
        _grootboekrekening_id, _btw_percentage, v_desc_arg,
        v_reason, pg_current_xact_id()
      )
      RETURNING id INTO v_event;
      RETURN QUERY SELECT 'unchanged'::text, false, v_marker.posting_group_id, NULL::uuid, NULL::uuid, v_event;
      RETURN;
    END IF;
  END IF;

  -- (8) De mutaties, in vaste volgorde. Grootboekregels komen uitsluitend van
  --     reverse_posting_group() en post_bank_transaction().
  IF v_state = 'S1' THEN
    v_reversal := public.reverse_posting_group(v_marker.posting_group_id, v_tx.transaction_date, v_reason);
  END IF;

  IF v_state IN ('S1', 'S2') THEN
    DELETE FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = v_tx.id;
  ELSIF v_state = 'S3' THEN
    INSERT INTO public.bank_transaction_posting_events (
      request_id, actor_id, request_kind, event_type,
      bank_transaction_id, organization_id, client_id,
      expected_posting_group_id, reason, created_xact_id
    ) VALUES (
      _request_id, v_uid, 'reclassify', 'returned',
      v_tx.id, v_tx.organization_id, v_tx.client_id,
      _expected_posting_group_id, v_reason, pg_current_xact_id()
    );
  END IF;

  -- De factuurmatch blijft zoals hij is (de RPC herrekent geen facturen), behalve
  -- een onbevestigde suggestie: die vervalt, zoals bij bulk boeken.
  UPDATE public.bank_transactions bt SET
    match_status         = 'handmatig_geboekt',
    grootboekrekening_id = _grootboekrekening_id,
    btw_percentage       = _btw_percentage,
    matched_invoice_id   = CASE WHEN v_tx.match_status = 'suggestie' THEN NULL ELSE bt.matched_invoice_id END,
    match_confidence     = CASE WHEN v_tx.match_status = 'suggestie' THEN NULL ELSE bt.match_confidence END,
    description          = COALESCE(v_desc_arg, bt.description)
  WHERE bt.id = v_tx.id;

  v_new_group := public.post_bank_transaction(v_tx.id);

  INSERT INTO public.bank_transaction_posting_events (
    request_id, actor_id, request_kind, event_type,
    bank_transaction_id, organization_id, client_id,
    expected_posting_group_id,
    superseded_posting_group_id, reversal_posting_group_id, replacement_posting_group_id,
    requested_grootboekrekening_id, requested_btw_percentage, requested_description, replacement_description,
    superseded_grootboekrekening_id, superseded_btw_percentage,
    superseded_gross_amount, superseded_net_amount, superseded_btw_amount,
    superseded_posting_date, superseded_boekjaar, superseded_posted_by, superseded_posted_at,
    superseded_description, reason, created_xact_id
  ) VALUES (
    _request_id, v_uid, 'reclassify',
    CASE v_state WHEN 'S1' THEN 'reclassified' WHEN 'S2' THEN 'reposted' ELSE 'posted' END,
    v_tx.id, v_tx.organization_id, v_tx.client_id,
    _expected_posting_group_id,
    CASE WHEN v_has_marker THEN v_marker.posting_group_id END,
    CASE WHEN v_has_marker THEN v_reversal END,
    v_new_group,
    _grootboekrekening_id, _btw_percentage, v_desc_arg, v_new_desc,
    CASE WHEN v_has_marker THEN v_marker.grootboekrekening_id END,
    CASE WHEN v_has_marker THEN v_marker.btw_percentage END,
    CASE WHEN v_has_marker THEN v_marker.gross_amount END,
    CASE WHEN v_has_marker THEN v_marker.net_amount END,
    CASE WHEN v_has_marker THEN v_marker.btw_amount END,
    CASE WHEN v_has_marker THEN v_marker.posting_date END,
    CASE WHEN v_has_marker THEN v_marker.boekjaar END,
    CASE WHEN v_has_marker THEN v_marker.user_id END,
    CASE WHEN v_has_marker THEN v_marker.created_at END,
    v_old_desc, v_reason, pg_current_xact_id()
  )
  RETURNING id INTO v_event;

  RETURN QUERY SELECT
    CASE v_state WHEN 'S0' THEN 'posted' WHEN 'S1' THEN 'reclassified'
                 WHEN 'S2' THEN 'reposted' ELSE 'reposted_after_release' END,
    false,
    v_new_group,
    CASE WHEN v_has_marker THEN v_marker.posting_group_id END,
    CASE WHEN v_has_marker THEN v_reversal END,
    v_event;
END;
$$;

REVOKE ALL ON FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text) IS
'Boekt een directe banktransactie met de opgegeven grootboekrekening, BTW (0/9/21) en optioneel een nieuwe omschrijving. Niet geboekt (S0): eerste boeking (assistant). Geboekt (S1): storno + herboeking op de transactiedatum, of unchanged bij dezelfde codering (vastgelegd, zodat een herhaling exact dat antwoord geeft). Handmatig tegengeboekt (S2): herboeking zonder tweede storno. Vrijgegeven (S3): returned + herboeking. S2 en S3 alleen als de bestaande storno op de transactiedatum staat (anders 22023: memoriaal). S1–S3 vereisen accountant en een toelichting. _expected_posting_group_id = de actieve groep (NULL = niet geboekt), anders 55000. Idempotent per (auth.uid(), _request_id). Grootboekregels alleen via reverse_posting_group en post_bank_transaction.';

CREATE OR REPLACE FUNCTION public.release_bank_transaction_posting(
  _transaction_id            uuid,
  _expected_posting_group_id uuid,
  _request_id                uuid,
  _reason                    text
)
RETURNS TABLE (
  outcome                     text,
  replayed                    boolean,
  posting_group_id            uuid,
  superseded_posting_group_id uuid,
  reversal_posting_group_id   uuid,
  event_id                    uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid      uuid := auth.uid();
  v_reason   text;
  v_old_desc text;
  v_tx       public.bank_transactions%ROWTYPE;
  v_client   public.clients%ROWTYPE;
  v_prev     public.bank_transaction_posting_events%ROWTYPE;
  v_marker   public.bank_transaction_postings%ROWTYPE;
  v_reversal uuid;
  v_state    text;
  v_event    uuid;
  v_rev_date date;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een bankcorrectie kan alleen in een READ COMMITTED transactie (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  IF _transaction_id IS NULL OR _expected_posting_group_id IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'Banktransactie, verwachte boekingsgroep en request_id zijn verplicht' USING ERRCODE = '22004';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(_reason, ''), E' \t\r\n'), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Een toelichting (1 tot 500 tekens) is verplicht bij het vrijgeven van een geboekte banktransactie' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'De toelichting is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_tx
  FROM public.bank_transactions bt
  WHERE bt.id = _transaction_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_tx.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_tx.organization_id, 'read_only') THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_min_role(v_uid, v_tx.organization_id, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om een geboekte banktransactie vrij te geven (accountant vereist)' USING ERRCODE = '42501';
  END IF;

  SELECT e.* INTO v_prev
  FROM public.bank_transaction_posting_events e
  WHERE e.actor_id = v_uid AND e.request_id = _request_id
  ORDER BY e.seq DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_prev.bank_transaction_id IS DISTINCT FROM v_tx.id
       OR v_prev.request_kind <> 'release'
       OR v_prev.expected_posting_group_id IS DISTINCT FROM _expected_posting_group_id
       OR v_prev.reason IS DISTINCT FROM v_reason THEN
      RAISE EXCEPTION 'Deze request_id is al gebruikt voor een andere aanvraag; gebruik een nieuwe' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_prev.event_type, true, NULL::uuid,
      v_prev.superseded_posting_group_id, v_prev.reversal_posting_group_id, v_prev.id;
    RETURN;
  END IF;

  -- De administratie moet bij de organisatie van de transactie horen — vóór de
  -- boekingsblokkade, zodat die nooit iets over een andere tenant zegt of
  -- grendelt (RLS toetst alleen de organisatie op de bankregel zelf).
  IF NOT EXISTS (SELECT 1 FROM public.clients c
                 WHERE c.id = v_tx.client_id AND c.organization_id = v_tx.organization_id) THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_posting_allowed(v_tx.client_id, v_tx.transaction_date);

  SELECT * INTO v_client
  FROM public.clients c
  WHERE c.id = v_tx.client_id
  FOR SHARE;

  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_tx.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  SELECT m.* INTO v_marker
  FROM public.bank_transaction_postings m
  WHERE m.bank_transaction_id = v_tx.id;

  IF NOT FOUND OR v_marker.posting_group_id IS DISTINCT FROM _expected_posting_group_id THEN
    RAISE EXCEPTION 'De boekingstoestand is gewijzigd; ververs en probeer opnieuw' USING ERRCODE = '55000';
  END IF;

  SELECT r.reversal_posting_group_id INTO v_reversal
  FROM public.ledger_reversal_postings r
  WHERE r.original_posting_group_id = v_marker.posting_group_id;
  v_state := CASE WHEN v_reversal IS NULL THEN 'S1' ELSE 'S2' END;

  IF EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = v_tx.id) THEN
    RAISE EXCEPTION 'Deze banktransactie is aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie' USING ERRCODE = '22023';
  END IF;

  -- Vrijgeven zet de regel terug op niet_gematcht en moet daarom de factuurmatch
  -- wissen (handleConfirm zou hem anders bevestigen). Of die match een oude
  -- suggestie of een oudere koppeling is, ziet de RPC niet, en een factuur
  -- herrekent hij niet: dan weigert vrijgeven.
  IF v_tx.matched_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'Deze banktransactie draagt nog een factuurmatch (mogelijk een oude suggestie); vrijgeven zou die wissen zonder de factuur te herrekenen en valt daarom buiten deze functie' USING ERRCODE = '22023';
  END IF;

  -- Een bestaande storno op een latere datum: na vrijgeven zou opnieuw boeken
  -- (op de transactiedatum) de periode daartussen dubbel boeken; dan heeft
  -- vrijgeven geen uitweg en weigert het.
  IF v_state = 'S2' THEN
    SELECT r.posting_date INTO v_rev_date
    FROM public.ledger_reversal_postings r
    WHERE r.reversal_posting_group_id = v_reversal;
    IF v_rev_date IS DISTINCT FROM v_tx.transaction_date THEN
      RAISE EXCEPTION 'De tegenboeking staat op %, niet op de transactiedatum %: na vrijgeven zou opnieuw boeken de periode daartussen dubbel boeken. Corrigeer dit met een memoriaalboeking.',
        v_rev_date, v_tx.transaction_date
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT lp.description INTO v_old_desc
  FROM public.ledger_postings lp
  WHERE lp.posting_group_id = v_marker.posting_group_id
  ORDER BY lp.line_no, lp.id
  LIMIT 1;

  IF v_state = 'S1' THEN
    v_reversal := public.reverse_posting_group(v_marker.posting_group_id, v_tx.transaction_date, v_reason);
  END IF;

  DELETE FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = v_tx.id;

  UPDATE public.bank_transactions bt SET
    match_status         = 'niet_gematcht',
    grootboekrekening_id = NULL,
    btw_percentage       = NULL,
    matched_invoice_id   = NULL,
    match_confidence     = NULL
  WHERE bt.id = v_tx.id;

  -- De gebeurtenis als allerlaatste: pas vanaf hier geldt de hold.
  INSERT INTO public.bank_transaction_posting_events (
    request_id, actor_id, request_kind, event_type,
    bank_transaction_id, organization_id, client_id,
    expected_posting_group_id,
    superseded_posting_group_id, reversal_posting_group_id, replacement_posting_group_id,
    superseded_grootboekrekening_id, superseded_btw_percentage,
    superseded_gross_amount, superseded_net_amount, superseded_btw_amount,
    superseded_posting_date, superseded_boekjaar, superseded_posted_by, superseded_posted_at,
    superseded_description, reason, created_xact_id
  ) VALUES (
    _request_id, v_uid, 'release', 'released',
    v_tx.id, v_tx.organization_id, v_tx.client_id,
    _expected_posting_group_id,
    v_marker.posting_group_id, v_reversal, NULL,
    v_marker.grootboekrekening_id, v_marker.btw_percentage,
    v_marker.gross_amount, v_marker.net_amount, v_marker.btw_amount,
    v_marker.posting_date, v_marker.boekjaar, v_marker.user_id, v_marker.created_at,
    v_old_desc, v_reason, pg_current_xact_id()
  )
  RETURNING id INTO v_event;

  RETURN QUERY SELECT 'released'::text, false, NULL::uuid, v_marker.posting_group_id, v_reversal, v_event;
END;
$$;

REVOKE ALL ON FUNCTION public.release_bank_transaction_posting(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_bank_transaction_posting(uuid, uuid, uuid, text)
  TO authenticated;

COMMENT ON FUNCTION public.release_bank_transaction_posting(uuid, uuid, uuid, text) IS
'Tegenboeken zonder herboeking (accountant, toelichting verplicht). Geboekt (S1): storno op de transactiedatum; handmatig tegengeboekt (S2): de bestaande storno. Daarna geen actieve boeking, de bankregel terug op niet_gematcht zonder rekening of BTW, en de vrijgave-hold (D12) actief. _expected_posting_group_id = de actieve groep, anders 55000. Idempotent per (auth.uid(), _request_id).';

CREATE OR REPLACE FUNCTION public.return_bank_transaction_to_workflow(
  _transaction_id uuid,
  _request_id     uuid,
  _reason         text
)
RETURNS TABLE (
  outcome                     text,
  replayed                    boolean,
  posting_group_id            uuid,
  superseded_posting_group_id uuid,
  reversal_posting_group_id   uuid,
  event_id                    uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text;
  v_tx     public.bank_transactions%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_prev     public.bank_transaction_posting_events%ROWTYPE;
  v_last     text;
  v_last_rev uuid;
  v_rev_date date;
  v_event    uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een bankcorrectie kan alleen in een READ COMMITTED transactie (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  IF _transaction_id IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'Banktransactie en request_id zijn verplicht' USING ERRCODE = '22004';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(_reason, ''), E' \t\r\n'), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Een toelichting (1 tot 500 tekens) is verplicht bij het terugzetten van een vrijgegeven banktransactie' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'De toelichting is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_tx
  FROM public.bank_transactions bt
  WHERE bt.id = _transaction_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_tx.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_tx.organization_id, 'read_only') THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_min_role(v_uid, v_tx.organization_id, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om een vrijgegeven banktransactie terug te zetten (accountant vereist)' USING ERRCODE = '42501';
  END IF;

  SELECT e.* INTO v_prev
  FROM public.bank_transaction_posting_events e
  WHERE e.actor_id = v_uid AND e.request_id = _request_id
  ORDER BY e.seq DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_prev.bank_transaction_id IS DISTINCT FROM v_tx.id
       OR v_prev.request_kind <> 'return'
       OR v_prev.reason IS DISTINCT FROM v_reason THEN
      RAISE EXCEPTION 'Deze request_id is al gebruikt voor een andere aanvraag; gebruik een nieuwe' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_prev.event_type, true, NULL::uuid, NULL::uuid, NULL::uuid, v_prev.id;
    RETURN;
  END IF;

  -- De administratie moet bij de organisatie van de transactie horen — vóór de
  -- boekingsblokkade, zodat die nooit iets over een andere tenant zegt of
  -- grendelt (RLS toetst alleen de organisatie op de bankregel zelf).
  IF NOT EXISTS (SELECT 1 FROM public.clients c
                 WHERE c.id = v_tx.client_id AND c.organization_id = v_tx.organization_id) THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  -- Ook terugzetten valt onder de boekingsblokkade: een vrijgegeven regel gaat
  -- pas terug naar de werkstroom als zij daar ook geboekt kan worden, zodat er
  -- geen herboeking klaarligt die vanzelf verloopt zodra een blokkade wordt
  -- opgeheven.
  PERFORM public.assert_posting_allowed(v_tx.client_id, v_tx.transaction_date);

  SELECT * INTO v_client
  FROM public.clients c
  WHERE c.id = v_tx.client_id
  FOR SHARE;

  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_tx.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  SELECT e.event_type, e.reversal_posting_group_id INTO v_last, v_last_rev
  FROM public.bank_transaction_posting_events e
  WHERE e.bank_transaction_id = v_tx.id
  ORDER BY e.seq DESC
  LIMIT 1;

  IF EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = v_tx.id)
     OR v_last IS DISTINCT FROM 'released' THEN
    RAISE EXCEPTION 'De boekingstoestand is gewijzigd; ververs en probeer opnieuw' USING ERRCODE = '55000';
  END IF;

  -- Terug in de werkstroom boekt de schrijver op de transactiedatum; met een
  -- storno op een latere datum zou dat de periode daartussen dubbel boeken.
  SELECT r.posting_date INTO v_rev_date
  FROM public.ledger_reversal_postings r
  WHERE r.reversal_posting_group_id = v_last_rev;
  IF v_rev_date IS DISTINCT FROM v_tx.transaction_date THEN
    RAISE EXCEPTION 'De tegenboeking staat op %, niet op de transactiedatum %: opnieuw boeken op de transactiedatum zou de periode daartussen dubbel boeken. Corrigeer dit met een memoriaalboeking.',
      v_rev_date, v_tx.transaction_date
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = v_tx.id) THEN
    RAISE EXCEPTION 'Deze banktransactie is aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.bank_transaction_posting_events (
    request_id, actor_id, request_kind, event_type,
    bank_transaction_id, organization_id, client_id,
    reason, created_xact_id
  ) VALUES (
    _request_id, v_uid, 'return', 'returned',
    v_tx.id, v_tx.organization_id, v_tx.client_id,
    v_reason, pg_current_xact_id()
  )
  RETURNING id INTO v_event;

  RETURN QUERY SELECT 'returned'::text, false, NULL::uuid, NULL::uuid, NULL::uuid, v_event;
END;
$$;

REVOKE ALL ON FUNCTION public.return_bank_transaction_to_workflow(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.return_bank_transaction_to_workflow(uuid, uuid, text)
  TO authenticated;

COMMENT ON FUNCTION public.return_bank_transaction_to_workflow(uuid, uuid, text) IS
'D12-b: zet een vrijgegeven banktransactie (S3) expliciet terug naar de gewone werkstroom (accountant, toelichting verplicht, binnen een open boekingsperiode). Schrijft alleen gebeurtenis returned; daarna mogen matchen, sjablonen en de inhaalslag haar weer behandelen. Idempotent per (auth.uid(), _request_id).';
$pr1_20261018120000$;

  -- ═══ 20261018150000_keep_bank_description_on_correction.sql ═══
  EXECUTE $pr2_20261018150000$
-- ═════════════════════════════════════════════════════════════════════════════
-- Bankcorrecties v1.1 — PR 2: de bankomschrijving blijft de geïmporteerde tekst
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WAAROM
--   reclassify_bank_transaction (PR 1, 20261018120000) schreef een opgegeven
--   omschrijving in bank_transactions.description, omdat de schrijver
--   post_bank_transaction de tekst van zijn grootboekregels daaruit leest. Zo
--   ging de oorspronkelijke bankomschrijving verloren — en daarmee een deel van
--   de duplicaatherkenning bij import, die zonder TransactionID op datum,
--   bedrag, tegenrekening en de eerste 50 tekens van de omschrijving vergelijkt.
--
-- WAT (alleen reclassify_bank_transaction; zelfde signatuur, uitkomsttype,
-- eigenaar, rechten, SECURITY DEFINER en search_path)
--   1. De boekingsomschrijving van de grootboekregels: _description; zonder
--      blijft de bestaande boekingsomschrijving uit het grootboek staan —
--      die van de actieve of tegengeboekte groep (S1, S2), of na vrijgeven of
--      terugzetten (S3, S4) die van de laatst vervangen groep, via de
--      gebeurtenis die haar vervangt. Er wordt niet teruggevallen op de
--      bankomschrijving zolang er een boekingsomschrijving bestaat. Alleen een
--      transactie die nog nooit direct geboekt is, krijgt bij haar eerste
--      boeking de bankomschrijving (zonder tekst: 'Bankboeking'), zoals elke
--      eerste boeking door de schrijver.
--   2. De boekingsomschrijving staat alleen tijdens de aanroep van de schrijver
--      in bank_transactions.description. Direct daarna krijgt de bankregel haar
--      oorspronkelijke omschrijving byte-gelijk terug (ook NULL); de RPC toetst
--      dat (anders 23514, niets geboekt). Pas daarna de gebeurtenis.
--   3. Verder niets: elke toets, grendel, volgorde, foutcode en uitkomst van
--      PR 1 is letterlijk gelijk. De gebeurtenis legt de gevraagde
--      (requested_description) en de geboekte omschrijving
--      (replacement_description, door de trigger tegen het grootboek getoetst)
--      vast, zoals in PR 1.
--
-- WAAROM DE TIJDELIJKE OMSCHRIJVING VEILIG IS
--   • Geen andere sessie ziet haar: de rij staat vanaf het begin van de RPC
--     onder FOR UPDATE van deze transactie, en een niet-gecommitte versie is in
--     PostgreSQL voor geen enkele andere transactie zichtbaar (MVCC; READ
--     UNCOMMITTED gedraagt zich als READ COMMITTED).
--   • Een fout op elk punt — ook bij COMMIT — draait de hele transactie terug.
--   • updated_at: de RPC werkte de rij al bij (PR 1, de codering); now() is
--     binnen één transactie constant, dus twee extra keren zetten geeft exact
--     dezelfde waarde als één keer. Een "unchanged"-uitkomst raakt de rij niet.
--   • De triggers op bank_transactions weigeren alleen, of zetten updated_at;
--     geen enkele schrijft elders iets weg. Er is geen RULE, geen audittrigger
--     en geen publicatie op de tabel (logische replicatie of realtime zou óók
--     de tussenversie uitzenden). De voorwaardencontrole hieronder pint precies
--     dat — triggers, hun functies, RULE's, publicaties — en weigert anders,
--     net als bij een andere eigenaar dan die van de schrijver (CREATE OR
--     REPLACE behoudt de eigenaar; SECURITY DEFINER draait met diens rechten).
--
-- NIET
--   post_bank_transaction en elke andere schrijver blijven byte-gelijk, net als
--   release_bank_transaction_posting en return_bank_transaction_to_workflow.
--   Geen nieuwe kolom, geen gegenereerde types, geen UI. De SnelStart-export
--   blijft de bankomschrijving gebruiken. De bestaande paden die de
--   bankomschrijving zelf overschrijven (de dialoog "handmatig boeken", een
--   gewone UPDATE) vallen buiten deze migratie.
--
-- PRODUCTIE (Lovable Cloud SQL editor, project alxlbdhpbwlehbdbfejw)
--   Ná 20261018120000 en diens POST:
--   supabase/rollout/20261018150000_keep_bank_description_on_correction/preflight.sql
--   → SET lock_timeout = '5s'; + deze migratie in één uitvoering → postcheck.sql.
--
-- ROLLBACK (handmatig, met akkoord van de eigenaar; data-neutraal)
--   -- rollback: voer supabase/rollout/20261018150000_keep_bank_description_on_correction/rollback.sql
--   --           uit; dat zet reclassify_bank_transaction byte-gelijk terug naar
--   --           de versie uit 20261018120000 (met haar rechten en commentaar).
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1. Voorwaarden: precies de beoordeelde toestand, anders niets ───────────
DO $migratie$
DECLARE
  v_md5  text;
  v_diff text;
BEGIN
  IF to_regclass('public.bank_transactions') IS NULL
     OR to_regclass('public.bank_transaction_posting_events') IS NULL
     OR to_regclass('public.ledger_postings') IS NULL THEN
    RAISE EXCEPTION 'Voorwaarde: de tabellen van PR 1 en het grootboek ontbreken' USING ERRCODE = '55000';
  END IF;

  -- PR 1 is toegepast, en de te vervangen functie is exact de beoordeelde
  -- versie (of deze, bij een tweede toepassing).
  IF to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Voorwaarde: PR 1 (20261018120000) is niet toegepast' USING ERRCODE = '55000';
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p
  WHERE p.oid = 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure;
  IF v_md5 NOT IN ('a931207c1a4e97f06e7797ed105c0264', '067939e0c44a672c26ec8883717ef6d2') THEN
    RAISE EXCEPTION 'Voorwaarde: reclassify_bank_transaction is niet de beoordeelde versie (md5 %)', v_md5 USING ERRCODE = '55000';
  END IF;

  -- De schrijver waarvan de omschrijvingsregel hier wordt gebruikt: byte-gelijk.
  IF to_regprocedure('public.post_bank_transaction(uuid)') IS NULL
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.post_bank_transaction(uuid)'::regprocedure)
        IS DISTINCT FROM '2369978c713ac78a0c039dd5c3e5eb4c' THEN
    RAISE EXCEPTION 'Voorwaarde: post_bank_transaction is niet de beoordeelde schrijver' USING ERRCODE = '55000';
  END IF;

  -- En met dezelfde eigenaar als de schrijver: CREATE OR REPLACE behoudt de
  -- eigenaar, en als SECURITY DEFINER draait de RPC met diens rechten.
  IF (SELECT p.proowner FROM pg_proc p
      WHERE p.oid = 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure)
     IS DISTINCT FROM
     (SELECT p.proowner FROM pg_proc p WHERE p.oid = 'public.post_bank_transaction(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'Voorwaarde: reclassify_bank_transaction heeft een andere eigenaar dan de schrijver post_bank_transaction' USING ERRCODE = '55000';
  END IF;

  -- Precies deze triggers op bank_transactions, met precies deze functies:
  -- geen enkele schrijft de tijdelijke omschrijving ergens anders weg.
  WITH bekend(tgname, functie, md5, ingeschakeld) AS (VALUES
    ('enforce_bank_transaction_release_hold_trigger',    'enforce_bank_transaction_release_hold',    '812d151a7041cdd48b7a784cd193a159', 'A'),
    ('prevent_org_user_rebind_trg',                      'prevent_org_user_rebind',                  '9d75d3c98a66f0fc0299b795ee40461e', 'O'),
    ('prevent_posted_bank_transaction_mutation_trigger', 'prevent_posted_bank_transaction_mutation', 'a6437536b1942e78d5b072f22fe6a842', 'O'),
    ('set_organization_id_trigger',                      'set_organization_id',                      'e56450399d8f95c5ed42fd2df04bed06', 'O'),
    ('update_bank_transactions_updated_at',              'update_updated_at_column',                 '301a884953d37769916294bb60562e05', 'O')),
  actueel(tgname, functie, md5, ingeschakeld) AS (
    SELECT t.tgname::text, p.proname::text, md5(p.prosrc), t.tgenabled::text
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.bank_transactions'::regclass AND NOT t.tgisinternal)
  SELECT string_agg(DISTINCT x.tgname, ', ' ORDER BY x.tgname) INTO v_diff
  FROM ((SELECT * FROM bekend EXCEPT SELECT * FROM actueel)
        UNION ALL
        (SELECT * FROM actueel EXCEPT SELECT * FROM bekend)) x;
  IF v_diff IS NOT NULL THEN
    RAISE EXCEPTION 'Voorwaarde: de triggers op bank_transactions wijken af van de beoordeelde set (%)', v_diff USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_rules r WHERE r.schemaname = 'public' AND r.tablename = 'bank_transactions') THEN
    RAISE EXCEPTION 'Voorwaarde: er staat een RULE op bank_transactions' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_publication p WHERE p.puballtables)
     OR EXISTS (SELECT 1 FROM pg_publication_tables pt WHERE pt.schemaname = 'public' AND pt.tablename = 'bank_transactions') THEN
    RAISE EXCEPTION 'Voorwaarde: bank_transactions wordt gepubliceerd (logische replicatie of realtime); de tijdelijke omschrijving zou worden uitgezonden' USING ERRCODE = '55000';
  END IF;
END
$migratie$;

-- ── 2. De correctie-RPC, met de bankomschrijving ongemoeid ──────────────────

CREATE OR REPLACE FUNCTION public.reclassify_bank_transaction(
  _transaction_id            uuid,
  _expected_posting_group_id uuid,
  _grootboekrekening_id      uuid,
  _btw_percentage            numeric,
  _request_id                uuid,
  _reason                    text DEFAULT NULL,
  _description               text DEFAULT NULL
)
RETURNS TABLE (
  outcome                     text,
  replayed                    boolean,
  posting_group_id            uuid,
  superseded_posting_group_id uuid,
  reversal_posting_group_id   uuid,
  event_id                    uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid         uuid := auth.uid();
  v_reason      text;
  v_desc_arg    text;
  v_new_desc    text;
  v_old_desc    text;
  v_hist_desc   text;
  v_tx          public.bank_transactions%ROWTYPE;
  v_client      public.clients%ROWTYPE;
  v_account     public.grootboekrekeningen%ROWTYPE;
  v_prev        public.bank_transaction_posting_events%ROWTYPE;
  v_marker      public.bank_transaction_postings%ROWTYPE;
  v_has_marker  boolean;
  v_last        text;
  v_state       text;
  v_reversal    uuid;
  v_lines       integer;
  v_line_acct   uuid;
  v_line_amount numeric;
  v_vat_acct    uuid;
  v_new_group   uuid;
  v_event       uuid;
  v_last_rev    uuid;
  v_rev_date    date;
BEGIN
  -- (0) Alleen de argumenten: niets over opgeslagen gegevens.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een bankcorrectie kan alleen in een READ COMMITTED transactie (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  IF _transaction_id IS NULL OR _grootboekrekening_id IS NULL OR _btw_percentage IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'Banktransactie, grootboekrekening, BTW-percentage en request_id zijn verplicht' USING ERRCODE = '22004';
  END IF;
  IF _btw_percentage NOT IN (0, 9, 21) THEN
    RAISE EXCEPTION 'Alleen 0, 9 of 21 procent BTW is toegestaan' USING ERRCODE = '22023';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(_reason, ''), E' \t\r\n'), '');
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'De toelichting is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;
  v_desc_arg := NULLIF(btrim(COALESCE(_description, ''), E' \t\r\n'), '');
  IF length(v_desc_arg) > 500 THEN
    RAISE EXCEPTION 'De omschrijving is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;

  -- (1) De rijgrendel: elk verzoek op deze transactie wacht hier op het vorige.
  SELECT * INTO v_tx
  FROM public.bank_transactions bt
  WHERE bt.id = _transaction_id
  FOR UPDATE;

  -- (2) Leesdrempel: "bestaat niet" en "niet van jou" zijn niet te onderscheiden.
  IF NOT FOUND
     OR v_tx.organization_id IS NULL
     OR NOT public.has_min_role(v_uid, v_tx.organization_id, 'read_only') THEN
    RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  -- (3) Schrijfdrempel.
  IF NOT public.has_min_role(v_uid, v_tx.organization_id, 'assistant') THEN
    RAISE EXCEPTION 'Geen rechten om te boeken voor deze organisatie' USING ERRCODE = '42501';
  END IF;

  -- (4) Herhaling: alleen eigen request_id's, en pas na de drempels.
  SELECT e.* INTO v_prev
  FROM public.bank_transaction_posting_events e
  WHERE e.actor_id = v_uid AND e.request_id = _request_id
  ORDER BY e.seq DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_prev.bank_transaction_id IS DISTINCT FROM v_tx.id
       OR v_prev.request_kind <> 'reclassify'
       OR v_prev.event_type NOT IN ('posted', 'reclassified', 'reposted', 'unchanged')
       OR v_prev.expected_posting_group_id IS DISTINCT FROM _expected_posting_group_id
       OR v_prev.requested_grootboekrekening_id IS DISTINCT FROM _grootboekrekening_id
       OR v_prev.requested_btw_percentage IS DISTINCT FROM _btw_percentage
       OR v_prev.requested_description IS DISTINCT FROM v_desc_arg
       OR v_prev.reason IS DISTINCT FROM v_reason THEN
      RAISE EXCEPTION 'Deze request_id is al gebruikt voor een andere aanvraag; gebruik een nieuwe' USING ERRCODE = '22023';
    END IF;

    IF (v_prev.event_type <> 'posted'
        OR EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                   WHERE e.actor_id = v_uid AND e.request_id = _request_id AND e.event_type = 'returned'))
       AND NOT public.has_min_role(v_uid, v_tx.organization_id, 'accountant') THEN
      RAISE EXCEPTION 'Geen rechten om een geboekte banktransactie te corrigeren (accountant vereist)' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY SELECT
      CASE WHEN EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                        WHERE e.actor_id = v_uid AND e.request_id = _request_id AND e.event_type = 'returned')
           THEN 'reposted_after_release' ELSE v_prev.event_type END,
      true,
      COALESCE(v_prev.replacement_posting_group_id,
               CASE WHEN v_prev.event_type = 'unchanged' THEN v_prev.expected_posting_group_id END),
      v_prev.superseded_posting_group_id,
      v_prev.reversal_posting_group_id,
      v_prev.id;
    RETURN;
  END IF;

  -- De administratie moet bij de organisatie van de transactie horen — vóór de
  -- boekingsblokkade, zodat die nooit iets over een andere tenant zegt of
  -- grendelt (RLS toetst alleen de organisatie op de bankregel zelf).
  IF NOT EXISTS (SELECT 1 FROM public.clients c
                 WHERE c.id = v_tx.client_id AND c.organization_id = v_tx.organization_id) THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  -- (5) De boekingsblokkade op de transactiedatum; neemt eerst de
  --     administratiegrendel, zodat een blokkade niet tussendoor kan wijzigen.
  PERFORM public.assert_posting_allowed(v_tx.client_id, v_tx.transaction_date);

  -- De configuratie ligt vast tot COMMIT: een gelijktijdige wijziging van de
  -- bank- of BTW-rekening kan niet tussen toets en boeking vallen.
  SELECT * INTO v_client
  FROM public.clients c
  WHERE c.id = v_tx.client_id
  FOR SHARE;

  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_tx.organization_id THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze banktransactie' USING ERRCODE = '42501';
  END IF;

  -- (6) De toestand, onder de grendels gelezen.
  SELECT m.* INTO v_marker
  FROM public.bank_transaction_postings m
  WHERE m.bank_transaction_id = v_tx.id;
  v_has_marker := FOUND;

  IF v_has_marker THEN
    SELECT r.reversal_posting_group_id INTO v_reversal
    FROM public.ledger_reversal_postings r
    WHERE r.original_posting_group_id = v_marker.posting_group_id;
    v_state := CASE WHEN v_reversal IS NULL THEN 'S1' ELSE 'S2' END;
  ELSE
    SELECT e.event_type, e.reversal_posting_group_id INTO v_last, v_last_rev
    FROM public.bank_transaction_posting_events e
    WHERE e.bank_transaction_id = v_tx.id
    ORDER BY e.seq DESC
    LIMIT 1;
    IF v_last IN ('posted', 'reclassified', 'reposted') THEN
      RAISE EXCEPTION 'De boekingsgeschiedenis van deze banktransactie is niet consistent; corrigeer niet automatisch' USING ERRCODE = '23514';
    END IF;
    v_state := CASE WHEN v_last = 'released' THEN 'S3' ELSE 'S0' END;
  END IF;

  -- (7a) Verwachte toestand.
  IF (v_state IN ('S0', 'S3') AND _expected_posting_group_id IS NOT NULL)
     OR (v_state IN ('S1', 'S2') AND _expected_posting_group_id IS DISTINCT FROM v_marker.posting_group_id) THEN
    RAISE EXCEPTION 'De boekingstoestand is gewijzigd; ververs en probeer opnieuw' USING ERRCODE = '55000';
  END IF;

  -- (7b) Factuurkoppelingen vallen buiten v1.
  IF EXISTS (SELECT 1 FROM public.bank_transaction_allocations a WHERE a.bank_transaction_id = v_tx.id) THEN
    RAISE EXCEPTION 'Deze banktransactie is aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie' USING ERRCODE = '22023';
  END IF;

  -- (7b') Ook een gematchte transactie zonder koppelingsrij (een oudere koppeling
  --       via de match) is een factuurkoppeling. Dat kan alleen in S0: een
  --       directe boeking staat altijd op handmatig_geboekt. Een factuurmatch op
  --       een handmatig geboekte regel (een achtergebleven suggestie) laat de RPC
  --       ongemoeid; alleen een onbevestigde suggestie wordt gewist (zie de UPDATE).
  IF v_tx.match_status = 'gematcht' THEN
    RAISE EXCEPTION 'Deze banktransactie is via de match aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie' USING ERRCODE = '22023';
  END IF;

  -- (7c) Een geboekte of vrijgegeven transactie: accountant en een toelichting.
  IF v_state <> 'S0' THEN
    IF NOT public.has_min_role(v_uid, v_tx.organization_id, 'accountant') THEN
      RAISE EXCEPTION 'Geen rechten om een geboekte banktransactie te corrigeren (accountant vereist)' USING ERRCODE = '42501';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'Een toelichting (1 tot 500 tekens) is verplicht bij het corrigeren van een geboekte banktransactie' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- (7c') Een bestaande storno op een latere datum dan de transactie: opnieuw
  --       boeken op de transactiedatum zou bank, kosten en BTW in de periode
  --       daartussen dubbel boeken. Alleen een storno op de transactiedatum
  --       (zoals deze RPC er zelf een maakt) laat herboeken toe.
  IF v_state IN ('S2', 'S3') THEN
    SELECT r.posting_date INTO v_rev_date
    FROM public.ledger_reversal_postings r
    WHERE r.reversal_posting_group_id = CASE WHEN v_state = 'S2' THEN v_reversal ELSE v_last_rev END;
    IF v_rev_date IS DISTINCT FROM v_tx.transaction_date THEN
      RAISE EXCEPTION 'De tegenboeking staat op %, niet op de transactiedatum %: opnieuw boeken op de transactiedatum zou de periode daartussen dubbel boeken. Corrigeer dit met een memoriaalboeking.',
        v_rev_date, v_tx.transaction_date
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- (7d) De nieuwe codering. Eerst de reikwijdte (zonder grendel: een rekening
  --      van een andere tenant wordt nooit gegrendeld), dan de rekening FOR
  --      SHARE tot COMMIT: een gelijktijdige deactivering kan niet tussen deze
  --      toets en de boeking vallen — de schrijver toetst `actief` zelf niet.
  IF NOT public.posting_account_ok(_grootboekrekening_id, v_tx.organization_id, v_tx.client_id) THEN
    RAISE EXCEPTION 'De gekozen grootboekrekening hoort niet bij deze organisatie of administratie' USING ERRCODE = '23514';
  END IF;
  SELECT g.* INTO v_account
  FROM public.grootboekrekeningen g
  WHERE g.id = _grootboekrekening_id
  FOR SHARE;
  IF NOT FOUND OR NOT COALESCE(v_account.actief, false) THEN
    RAISE EXCEPTION 'De gekozen grootboekrekening is niet actief' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_client.btw_vrijgesteld, false) AND _btw_percentage <> 0 THEN
    RAISE EXCEPTION 'Deze administratie is btw-vrijgesteld; alleen 0 procent BTW is toegestaan' USING ERRCODE = '22023';
  END IF;
  IF _btw_percentage > 0
     AND (CASE WHEN v_tx.amount < 0 THEN v_client.btw_te_vorderen_rekening_id
               ELSE v_client.btw_te_betalen_rekening_id END) IS NULL THEN
    RAISE EXCEPTION 'Geen BTW-rekening ingesteld voor deze administratie' USING ERRCODE = '22023';
  END IF;

  -- De boekingsomschrijving voor de grootboekregels. De bankomschrijving
  -- (bank_transactions.description) is de geïmporteerde tekst en blijft dat.
  -- Zonder nieuwe omschrijving blijft de bestaande boekingsomschrijving staan:
  -- die van de actieve of tegengeboekte groep (S1, S2), of — na vrijgeven of
  -- terugzetten — die van de laatst vervangen groep, uit het grootboek via de
  -- gebeurtenis die haar vervangt. Alleen een transactie die nog nooit direct
  -- geboekt is, krijgt bij haar eerste boeking de bankomschrijving, zoals elke
  -- eerste boeking door de schrijver.
  IF v_state IN ('S1', 'S2') THEN
    SELECT lp.description INTO v_old_desc
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = v_marker.posting_group_id
    ORDER BY lp.line_no, lp.id
    LIMIT 1;
  ELSE
    SELECT lp.description INTO v_hist_desc
    FROM public.bank_transaction_posting_events e
    JOIN public.ledger_postings lp ON lp.posting_group_id = e.superseded_posting_group_id
    WHERE e.bank_transaction_id = v_tx.id
    ORDER BY e.seq DESC, lp.line_no, lp.id
    LIMIT 1;
  END IF;

  v_new_desc := COALESCE(v_desc_arg, v_old_desc, v_hist_desc,
                         NULLIF(btrim(v_tx.description), ''), 'Bankboeking');

  -- (7e) D7: een correctie verplaatst geen bedragen naar een andere bank- of
  --      BTW-rekening. Alleen voor een actieve (niet tegengeboekte) groep.
  IF v_state = 'S1' THEN
    -- De bankzijde: credit bij geld eraf, debet bij geld erbij — precies één regel.
    SELECT count(*), min(lp.grootboekrekening_id::text)::uuid INTO v_lines, v_line_acct
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = v_marker.posting_group_id
      AND ((v_tx.amount < 0 AND lp.credit_amount > 0) OR (v_tx.amount > 0 AND lp.debit_amount > 0));
    IF v_lines <> 1 THEN
      RAISE EXCEPTION 'De bestaande boeking heeft niet de vorm van een directe bankboeking; corrigeer haar via het grootboek' USING ERRCODE = '23514';
    END IF;
    IF v_line_acct IS DISTINCT FROM v_client.bank_rekening_id THEN
      RAISE EXCEPTION 'De bankrekening van deze administratie is gewijzigd sinds de boeking; een correctie zou het bedrag naar een andere bankrekening verplaatsen. Geef de boeking vrij en boek haar daarna opnieuw.'
        USING ERRCODE = '23514';
    END IF;

    -- De tegenzijde: de kostenregel, plus de BTW-regel als er BTW is geboekt.
    SELECT count(*) INTO v_lines
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = v_marker.posting_group_id
      AND ((v_tx.amount < 0 AND lp.debit_amount > 0) OR (v_tx.amount > 0 AND lp.credit_amount > 0));
    IF v_lines <> (CASE WHEN v_marker.btw_amount > 0 THEN 2 ELSE 1 END) THEN
      RAISE EXCEPTION 'De bestaande boeking heeft niet de vorm van een directe bankboeking; corrigeer haar via het grootboek' USING ERRCODE = '23514';
    END IF;

    IF v_marker.btw_amount > 0 THEN
      SELECT lp.grootboekrekening_id, lp.debit_amount + lp.credit_amount INTO v_line_acct, v_line_amount
      FROM public.ledger_postings lp
      WHERE lp.posting_group_id = v_marker.posting_group_id
        AND ((v_tx.amount < 0 AND lp.debit_amount > 0) OR (v_tx.amount > 0 AND lp.credit_amount > 0))
      ORDER BY lp.line_no DESC, lp.id DESC
      LIMIT 1;
      IF v_line_amount IS DISTINCT FROM v_marker.btw_amount THEN
        RAISE EXCEPTION 'De bestaande boeking heeft niet de vorm van een directe bankboeking; corrigeer haar via het grootboek' USING ERRCODE = '23514';
      END IF;
      v_vat_acct := CASE WHEN v_tx.amount < 0 THEN v_client.btw_te_vorderen_rekening_id
                         ELSE v_client.btw_te_betalen_rekening_id END;
      IF v_line_acct IS DISTINCT FROM v_vat_acct THEN
        RAISE EXCEPTION 'De BTW-rekening van deze administratie is gewijzigd sinds de boeking; een correctie zou BTW naar een andere rekening verplaatsen. Geef de boeking vrij en boek haar daarna opnieuw.'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    -- (7f) Effectief dezelfde codering en omschrijving: niets te boeken. De
    --      aanvraag wordt wel vastgelegd, zodat haar request_id verbruikt is:
    --      een herhaling (bv. na een verloren antwoord) geeft exact dit antwoord,
    --      ook als de boeking inmiddels handmatig is tegengeboekt.
    IF v_marker.grootboekrekening_id = _grootboekrekening_id
       AND COALESCE(v_marker.btw_percentage, 0) = _btw_percentage
       AND v_old_desc IS NOT DISTINCT FROM v_new_desc THEN
      INSERT INTO public.bank_transaction_posting_events (
        request_id, actor_id, request_kind, event_type,
        bank_transaction_id, organization_id, client_id,
        expected_posting_group_id,
        requested_grootboekrekening_id, requested_btw_percentage, requested_description,
        reason, created_xact_id
      ) VALUES (
        _request_id, v_uid, 'reclassify', 'unchanged',
        v_tx.id, v_tx.organization_id, v_tx.client_id,
        _expected_posting_group_id,
        _grootboekrekening_id, _btw_percentage, v_desc_arg,
        v_reason, pg_current_xact_id()
      )
      RETURNING id INTO v_event;
      RETURN QUERY SELECT 'unchanged'::text, false, v_marker.posting_group_id, NULL::uuid, NULL::uuid, v_event;
      RETURN;
    END IF;
  END IF;

  -- (8) De mutaties, in vaste volgorde. Grootboekregels komen uitsluitend van
  --     reverse_posting_group() en post_bank_transaction().
  IF v_state = 'S1' THEN
    v_reversal := public.reverse_posting_group(v_marker.posting_group_id, v_tx.transaction_date, v_reason);
  END IF;

  IF v_state IN ('S1', 'S2') THEN
    DELETE FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = v_tx.id;
  ELSIF v_state = 'S3' THEN
    INSERT INTO public.bank_transaction_posting_events (
      request_id, actor_id, request_kind, event_type,
      bank_transaction_id, organization_id, client_id,
      expected_posting_group_id, reason, created_xact_id
    ) VALUES (
      _request_id, v_uid, 'reclassify', 'returned',
      v_tx.id, v_tx.organization_id, v_tx.client_id,
      _expected_posting_group_id, v_reason, pg_current_xact_id()
    );
  END IF;

  -- De factuurmatch blijft zoals hij is (de RPC herrekent geen facturen), behalve
  -- een onbevestigde suggestie: die vervalt, zoals bij bulk boeken.
  --
  -- De schrijver leest de omschrijving van zijn grootboekregels uit
  -- bank_transactions.description. Daarom staat de boekingsomschrijving daar
  -- alleen tijdens de boeking, binnen deze transactie en onder de rijgrendel:
  -- geen andere sessie ziet haar (MVCC). Direct na de boeking krijgt de
  -- bankregel haar oorspronkelijke omschrijving byte-gelijk terug, ook NULL.
  -- Een fout op welk punt ook draait alles terug.
  UPDATE public.bank_transactions bt SET
    match_status         = 'handmatig_geboekt',
    grootboekrekening_id = _grootboekrekening_id,
    btw_percentage       = _btw_percentage,
    matched_invoice_id   = CASE WHEN v_tx.match_status = 'suggestie' THEN NULL ELSE bt.matched_invoice_id END,
    match_confidence     = CASE WHEN v_tx.match_status = 'suggestie' THEN NULL ELSE bt.match_confidence END,
    description          = v_new_desc
  WHERE bt.id = v_tx.id;

  v_new_group := public.post_bank_transaction(v_tx.id);

  UPDATE public.bank_transactions bt SET
    description = v_tx.description
  WHERE bt.id = v_tx.id;

  IF NOT EXISTS (SELECT 1 FROM public.bank_transactions bt
                 WHERE bt.id = v_tx.id
                   AND bt.description COLLATE "C" IS NOT DISTINCT FROM v_tx.description COLLATE "C") THEN
    RAISE EXCEPTION 'De oorspronkelijke bankomschrijving bleef niet behouden; er is niets geboekt' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.bank_transaction_posting_events (
    request_id, actor_id, request_kind, event_type,
    bank_transaction_id, organization_id, client_id,
    expected_posting_group_id,
    superseded_posting_group_id, reversal_posting_group_id, replacement_posting_group_id,
    requested_grootboekrekening_id, requested_btw_percentage, requested_description, replacement_description,
    superseded_grootboekrekening_id, superseded_btw_percentage,
    superseded_gross_amount, superseded_net_amount, superseded_btw_amount,
    superseded_posting_date, superseded_boekjaar, superseded_posted_by, superseded_posted_at,
    superseded_description, reason, created_xact_id
  ) VALUES (
    _request_id, v_uid, 'reclassify',
    CASE v_state WHEN 'S1' THEN 'reclassified' WHEN 'S2' THEN 'reposted' ELSE 'posted' END,
    v_tx.id, v_tx.organization_id, v_tx.client_id,
    _expected_posting_group_id,
    CASE WHEN v_has_marker THEN v_marker.posting_group_id END,
    CASE WHEN v_has_marker THEN v_reversal END,
    v_new_group,
    _grootboekrekening_id, _btw_percentage, v_desc_arg, v_new_desc,
    CASE WHEN v_has_marker THEN v_marker.grootboekrekening_id END,
    CASE WHEN v_has_marker THEN v_marker.btw_percentage END,
    CASE WHEN v_has_marker THEN v_marker.gross_amount END,
    CASE WHEN v_has_marker THEN v_marker.net_amount END,
    CASE WHEN v_has_marker THEN v_marker.btw_amount END,
    CASE WHEN v_has_marker THEN v_marker.posting_date END,
    CASE WHEN v_has_marker THEN v_marker.boekjaar END,
    CASE WHEN v_has_marker THEN v_marker.user_id END,
    CASE WHEN v_has_marker THEN v_marker.created_at END,
    v_old_desc, v_reason, pg_current_xact_id()
  )
  RETURNING id INTO v_event;

  RETURN QUERY SELECT
    CASE v_state WHEN 'S0' THEN 'posted' WHEN 'S1' THEN 'reclassified'
                 WHEN 'S2' THEN 'reposted' ELSE 'reposted_after_release' END,
    false,
    v_new_group,
    CASE WHEN v_has_marker THEN v_marker.posting_group_id END,
    CASE WHEN v_has_marker THEN v_reversal END,
    v_event;
END;
$$;

REVOKE ALL ON FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text) IS
'Boekt een directe banktransactie met de opgegeven grootboekrekening, BTW (0/9/21) en optioneel een boekingsomschrijving voor de grootboekregels; zonder blijft de bestaande boekingsomschrijving uit het grootboek staan (een nooit geboekte transactie: de bankomschrijving). bank_transactions.description blijft na elke correctie byte-gelijk. Niet geboekt (S0): eerste boeking (assistant). Geboekt (S1): storno + herboeking op de transactiedatum, of unchanged bij dezelfde codering (vastgelegd, zodat een herhaling exact dat antwoord geeft). Handmatig tegengeboekt (S2): herboeking zonder tweede storno. Vrijgegeven (S3): returned + herboeking. S2 en S3 alleen als de bestaande storno op de transactiedatum staat (anders 22023: memoriaal). S1–S3 vereisen accountant en een toelichting. _expected_posting_group_id = de actieve groep (NULL = niet geboekt), anders 55000. Idempotent per (auth.uid(), _request_id). Grootboekregels alleen via reverse_posting_group en post_bank_transaction.';
$pr2_20261018150000$;

  -- ═══ 20261018180000_refine_release_hold_for_settled_history.sql ═══
  EXECUTE $fix_20261018180000$
-- ═════════════════════════════════════════════════════════════════════════════
-- Bankcorrecties v1.1 — de vrijgave-hold (D12) en historische storno's van vóór PR 1
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WAAROM
--   De hold van PR 1 (20261018120000) noemt een regel pas "vrijgegeven" als de
--   laatste gebeurtenis `released` is én elke directe bankgroep van die regel
--   al als vervangen in een gebeurtenis staat. Dat laatste is er voor een
--   correctie die op dat moment loopt: haar marker is net losgemaakt en haar
--   gebeurtenis volgt nog. Een directe bankgroep van vóór PR 1 die toen
--   handmatig is gestorneerd en daarna opnieuw is geboekt, staat echter nooit
--   als vervangen vast. Voor zo'n regel ging de hold na een vrijgave dus nooit
--   meer aan: de app (handmatig boeken, sjablonen, de scan, bulk) kon haar stil
--   opnieuw boeken (bewezen in supabase/tests/bank-release-hold-history/).
--   In productie gaat het om één regel van 25-11-2025.
--
-- WAT
--   1. Een interne hulpfunctie, alleen lezen:
--      bank_transaction_group_is_settled_history(transactie, groep) is waar
--      uitsluitend als ALLES bewezen is:
--        (1) de groep bestaat alleen uit directe bankregels van deze transactie;
--        (2) zij is gestorneerd via de bestaande reversalketen: precies één
--            claim, en elke regel van de storno keert precies één regel om;
--        (3) origineel, storno en claim staan op de transactiedatum;
--        (4) origineel en storno zijn per grootboekrekening volledig neutraal;
--        (5) de storno is niet zelf tegengeboekt;
--        (6) de groep is niet de actieve marker en staat in geen gebeurtenis;
--        (7) na de storno volgde een nieuwe directe boeking van de transactie;
--        (8) origineel, storno en claim zijn alle strikt ouder dan elke
--            correctiegebeurtenis van deze transactie (created_at).
--      Alleen een eerdere datum, of alleen het ontbreken van een marker, is
--      dus nooit genoeg.
--   2. enforce_bank_transaction_release_hold = het lichaam van PR 1 met één
--      wijziging: zo'n bewezen historische storno telt niet meer als lopende
--      correctie. Snel pad, markerpad, geschiedenispad, verwijder- en
--      identiteitsbeveiliging, meldingen en foutcodes: letterlijk gelijk.
--
-- WAAROM DIT DE HOLD NIET VERZWAKT
--   • De wijziging voegt alleen een uitzondering toe op de groepen die de hold
--     UITSCHAKELEN. De hold geldt dus in elke situatie waarin hij onder PR 1
--     gold, en daarnaast voor een vrijgegeven regel met bewezen geschiedenis.
--   • Een lopende correctie kan nooit als historische storno gelden. Haar groep
--     was tot in deze transactie de actieve boeking, dus na haar storno bestaat
--     nog geen nieuwe boeking: (7) is onwaar — altijd. Heeft de transactie al
--     gebeurtenissen (zoals in F2, een groep geboekt tijdens een functionele
--     rollback), dan is bovendien (8) onwaar: die correctie begon pas nadat de
--     vrijgave was gecommit.
--   • Een groep die niet aan alles voldoet, gedraagt zich als onder PR 1; de
--     uitrolcontroles geven daarop STOP (PRE 4, POST 8).
--   • Omgekeerd kan een ten onrechte "historisch" oordeel de hold alleen
--     strenger maken. Daarom steunt (8) bewust op de tijd: die blijft kloppen
--     na een logische restore (een xid-volgorde niet — dan zou de hold de regel
--     stil loslaten). created_at is wel now(), de START van een transactie: een
--     groep die in een functionele rollback-tussentijd wordt geboekt door een
--     transactie die al vóór een gebeurtenis begon, kan hier als historisch
--     gelden. Gevolg: de hold geldt vaker, nooit minder vaak. POST 8 toetst
--     strenger — ook op transactievolgorde (created_xact_id) — en geeft op zo'n
--     groep STOP, behalve als die transactie ook haar xid al vóór de gebeurtenis
--     had (gedocumenteerd restgeval; alleen in een rollback-tussentijd).
--
-- NIET
--   Geen schrijver, geen grootboekregel, marker, gebeurtenis, trigger(definitie),
--   tabel, RLS of recht verandert — behalve de rechten van de nieuwe hulp-
--   functie zelf (alleen de eigenaar). Geen data.
--
-- VOLGORDE
--   Ná 20261018120000 (PR 1) en 20261018150000 (PR 2). De voorwaardencontrole
--   van PR 2 pint het lichaam van de PR 1-hold; deze migratie eerst toepassen
--   zou PR 2 laten weigeren. Daarom eist de controle hieronder dat PR 2 er al is.
--
-- PRODUCTIE (Lovable Cloud SQL editor, project alxlbdhpbwlehbdbfejw)
--   Zie supabase/rollout/20261018180000_refine_release_hold_for_settled_history/:
--   PR 1, PR 2 en deze migratie in ÉÉN uitvoering, zodat de tussentoestand
--   (PR 1 zonder deze fix) nooit zichtbaar wordt.
--
-- ROLLBACK (handmatig, met akkoord van de eigenaar; data-neutraal)
--   -- rollback: voer supabase/rollout/20261018180000_refine_release_hold_for_settled_history/rollback.sql
--   --           uit; dat zet de hold byte-gelijk terug naar PR 1 en verwijdert de
--   --           hulpfunctie. Een rollback van PR 2 of PR 1 daarna, nooit ervoor.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1. Voorwaarden: precies de beoordeelde toestand, anders niets ───────────
DO $migratie$
DECLARE
  v_md5 text;
BEGIN
  IF to_regclass('public.bank_transactions') IS NULL
     OR to_regclass('public.ledger_postings') IS NULL
     OR to_regclass('public.ledger_reversal_postings') IS NULL
     OR to_regclass('public.bank_transaction_postings') IS NULL
     OR to_regclass('public.bank_transaction_posting_events') IS NULL THEN
    RAISE EXCEPTION 'Voorwaarde: de tabellen van het grootboek en van PR 1 ontbreken' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.ledger_postings'::regclass AND a.attname = 'created_at' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.ledger_postings'::regclass AND a.attname = 'reversal_of_posting_id' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.ledger_reversal_postings'::regclass AND a.attname = 'created_at' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.bank_transaction_posting_events'::regclass AND a.attname = 'created_at' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'Voorwaarde: de kolommen waarop het bewijs van geschiedenis steunt ontbreken' USING ERRCODE = '55000';
  END IF;

  -- PR 2 is toegepast (en dus PR 1): eerst PR 2, dan deze migratie.
  IF to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') IS NULL
     OR (SELECT md5(p.prosrc) FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'))
        IS DISTINCT FROM '067939e0c44a672c26ec8883717ef6d2' THEN
    RAISE EXCEPTION 'Voorwaarde: PR 2 (20261018150000) is niet toegepast' USING ERRCODE = '55000';
  END IF;

  -- De te vervangen hold is exact die van PR 1 (of deze, bij een tweede toepassing).
  IF to_regprocedure('public.enforce_bank_transaction_release_hold()') IS NULL THEN
    RAISE EXCEPTION 'Voorwaarde: enforce_bank_transaction_release_hold ontbreekt' USING ERRCODE = '55000';
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()');
  IF v_md5 NOT IN ('812d151a7041cdd48b7a784cd193a159', '43347fb9f48ed4c161e291fa769577c2') THEN
    RAISE EXCEPTION 'Voorwaarde: enforce_bank_transaction_release_hold is niet de beoordeelde versie (md5 %)', v_md5 USING ERRCODE = '55000';
  END IF;

  -- Met de eigenaar van de schrijvers: CREATE OR REPLACE behoudt de eigenaar,
  -- en als SECURITY DEFINER draait de hold met diens rechten.
  IF (SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()'))
     IS DISTINCT FROM
     (SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_bank_transaction(uuid)')) THEN
    RAISE EXCEPTION 'Voorwaarde: enforce_bank_transaction_release_hold heeft een andere eigenaar dan de schrijver post_bank_transaction' USING ERRCODE = '55000';
  END IF;

  -- En de trigger die haar aanroept: ENABLE ALWAYS op bank_transactions.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                 WHERE t.tgrelid = 'public.bank_transactions'::regclass
                   AND t.tgname = 'enforce_bank_transaction_release_hold_trigger'
                   AND t.tgfoid = to_regprocedure('public.enforce_bank_transaction_release_hold()')
                   AND t.tgenabled = 'A' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'Voorwaarde: de hold-trigger op bank_transactions ontbreekt of is niet ENABLE ALWAYS' USING ERRCODE = '55000';
  END IF;

  -- Een nieuwe hulpfunctie krijgt de uitvoerende rol als eigenaar, en de hold
  -- (SECURITY DEFINER, eigenaar = die van de schrijver) moet haar kunnen aanroepen
  -- terwijl iedereen anders het uitvoerrecht mist (Codex).
  IF to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)') IS NULL
     AND (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user)
         IS DISTINCT FROM
         (SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_bank_transaction(uuid)')) THEN
    RAISE EXCEPTION 'Voorwaarde: voer deze migratie uit als de eigenaar van post_bank_transaction (de nieuwe hulpfunctie krijgt de uitvoerende rol als eigenaar)' USING ERRCODE = '55000';
  END IF;

  -- De hulpfunctie bestaat nog niet, of is exact deze (tweede toepassing), met dezelfde eigenaar.
  IF to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)') IS NOT NULL
     AND ((SELECT md5(p.prosrc) FROM pg_proc p
           WHERE p.oid = to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)'))
          IS DISTINCT FROM '697f9413067e9c5b73323b792c51cda9'
          OR (SELECT p.proowner FROM pg_proc p
              WHERE p.oid = to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)'))
          IS DISTINCT FROM
          (SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_bank_transaction(uuid)'))) THEN
    RAISE EXCEPTION 'Voorwaarde: bank_transaction_group_is_settled_history bestaat al in een andere vorm' USING ERRCODE = '55000';
  END IF;
END
$migratie$;

-- ── 2. Het bewijs van een historische storno (intern, alleen lezen) ─────────


CREATE OR REPLACE FUNCTION public.bank_transaction_group_is_settled_history(
  _transaction_id   uuid,
  _posting_group_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH tx AS (
    SELECT bt.id, bt.transaction_date
    FROM public.bank_transactions bt
    WHERE bt.id = _transaction_id
  ), orig AS (
    SELECT lp.id, lp.source_type, lp.source_id, lp.grootboekrekening_id, lp.posting_date,
           lp.debit_amount, lp.credit_amount, lp.created_at
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = _posting_group_id
  ), claim AS (
    SELECT r.reversal_posting_group_id, r.original_source_type, r.original_posting_date, r.posting_date, r.created_at
    FROM public.ledger_reversal_postings r
    WHERE r.original_posting_group_id = _posting_group_id
  ), rev AS (
    SELECT lp.id, lp.source_type, lp.source_id, lp.reversal_of_posting_id, lp.grootboekrekening_id, lp.posting_date,
           lp.debit_amount, lp.credit_amount, lp.created_at
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = (SELECT c.reversal_posting_group_id FROM claim c)
  ), event AS (
    SELECT e.created_at
    FROM public.bank_transaction_posting_events e
    WHERE e.bank_transaction_id = _transaction_id
  )
  SELECT
    -- (1) Dezelfde banktransactie: de groep bestaat uitsluitend uit haar directe bankregels.
    EXISTS (SELECT 1 FROM tx)
    AND EXISTS (SELECT 1 FROM orig)
    AND NOT EXISTS (SELECT 1 FROM orig o
                    WHERE o.source_type <> 'bank_transaction' OR o.source_id IS DISTINCT FROM _transaction_id)
    -- (2) Gestorneerd via de bestaande reversalketen: precies één claim, en elke
    --     regel van de storno keert precies één regel van deze groep om.
    AND (SELECT count(*) FROM claim) = 1
    AND (SELECT c.original_source_type FROM claim c) = 'bank_transaction'
    AND EXISTS (SELECT 1 FROM rev)
    AND (SELECT count(*) FROM rev) = (SELECT count(*) FROM orig)
    AND NOT EXISTS (SELECT 1 FROM rev v
                    WHERE v.source_type <> 'reversal'
                       OR v.source_id IS DISTINCT FROM _posting_group_id
                       OR v.reversal_of_posting_id IS NULL
                       OR NOT EXISTS (SELECT 1 FROM orig o WHERE o.id = v.reversal_of_posting_id))
    AND (SELECT count(DISTINCT v.reversal_of_posting_id) FROM rev v) = (SELECT count(*) FROM orig)
    -- (3) De juiste datum: origineel én storno op de transactiedatum (anders
    --     zou de periode daartussen dubbel staan).
    AND NOT EXISTS (SELECT 1 FROM orig o, tx t WHERE o.posting_date <> t.transaction_date)
    AND NOT EXISTS (SELECT 1 FROM rev v, tx t WHERE v.posting_date <> t.transaction_date)
    AND NOT EXISTS (SELECT 1 FROM claim c, tx t
                    WHERE c.posting_date <> t.transaction_date OR c.original_posting_date <> t.transaction_date)
    -- (4) Volledig neutraal per grootboekrekening.
    AND NOT EXISTS (SELECT x.grootboekrekening_id
                    FROM (SELECT o.grootboekrekening_id, o.debit_amount - o.credit_amount AS saldo FROM orig o
                          UNION ALL
                          SELECT v.grootboekrekening_id, v.debit_amount - v.credit_amount FROM rev v) x
                    GROUP BY x.grootboekrekening_id
                    HAVING sum(x.saldo) <> 0)
    -- (5) De storno is niet zelf ongeldig gemaakt (niet zelf tegengeboekt).
    AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r2
                    WHERE r2.original_posting_group_id = (SELECT c.reversal_posting_group_id FROM claim c))
    -- (6) Niet de actieve marker, en in geen enkele correctiegebeurtenis genoemd.
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.posting_group_id = _posting_group_id)
    AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                    WHERE e.superseded_posting_group_id = _posting_group_id
                       OR e.replacement_posting_group_id = _posting_group_id)
    -- (7) Consistente historie: na de storno volgde een nieuwe directe boeking
    --     van dezelfde banktransactie.
    AND EXISTS (SELECT 1 FROM public.ledger_postings g
                WHERE g.source_type = 'bank_transaction' AND g.source_id = _transaction_id
                  AND g.posting_group_id <> _posting_group_id
                  AND g.created_at >= (SELECT max(v.created_at) FROM rev v))
    -- (8) Geschiedenis van vóór de correctiegebeurtenissen van deze transactie:
    --     origineel, storno en claim zijn alle strikt ouder dan elke gebeurtenis.
    --     Bewust op tijd (created_at): een vergissing hier kan de hold alleen
    --     strenger maken — deze functie staat binnen de NOT EXISTS die haar
    --     uitschakelt — en de tijd blijft kloppen na een logische restore, een
    --     xid-volgorde niet. De strengere diagnose, ook op transactievolgorde,
    --     zit in de uitrolcontrole (POST 8): wat niet in beide volgordes ouder
    --     is, geeft daar STOP.
    AND NOT EXISTS (SELECT 1
                    FROM event f,
                         (SELECT o.created_at FROM orig o
                          UNION ALL SELECT v.created_at FROM rev v
                          UNION ALL SELECT c.created_at FROM claim c) x
                    WHERE x.created_at >= f.created_at);
$$;

REVOKE ALL ON FUNCTION public.bank_transaction_group_is_settled_history(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.bank_transaction_group_is_settled_history(uuid, uuid) IS
'Intern, alleen lezen (STABLE). Waar uitsluitend als de directe bankgroep een bewezen historische storno is van vóór de correctiegebeurtenissen van deze banktransactie: dezelfde transactie, precies één storno via de reversalketen die elke regel omkeert, origineel en storno op de transactiedatum, per grootboekrekening neutraal, de storno niet zelf tegengeboekt, geen marker en in geen gebeurtenis genoemd, gevolgd door een nieuwe directe boeking, en alles strikt ouder dan de eerste gebeurtenis. Gebruikt door enforce_bank_transaction_release_hold.';

-- ── 3. De vrijgave-hold, met de historische storno ───────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_bank_transaction_release_hold()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last             text;
  v_identity_changed boolean := false;
  v_coding_changed   boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_identity_changed :=
         NEW.id               IS DISTINCT FROM OLD.id
      OR NEW.amount           IS DISTINCT FROM OLD.amount
      OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
      OR NEW.client_id        IS DISTINCT FROM OLD.client_id
      OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
      OR NEW.user_id          IS DISTINCT FROM OLD.user_id;
    v_coding_changed :=
         NEW.match_status         IS DISTINCT FROM OLD.match_status
      OR NEW.grootboekrekening_id IS DISTINCT FROM OLD.grootboekrekening_id
      OR NEW.btw_percentage       IS DISTINCT FROM OLD.btw_percentage
      OR NEW.matched_invoice_id   IS DISTINCT FROM OLD.matched_invoice_id
      OR NEW.match_confidence     IS DISTINCT FROM OLD.match_confidence;

    -- Snel pad: geen bewaakt veld verandert.
    IF NOT v_identity_changed AND NOT v_coding_changed THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Een actieve marker: de bestaande bevriezing beslist.
  IF EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = OLD.id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- VOLATILE: deze query krijgt een verse snapshot en ziet dus een vrijgave
  -- die net is gecommit terwijl deze opdracht op de rijgrendel wachtte.
  SELECT e.event_type INTO v_last
  FROM public.bank_transaction_posting_events e
  WHERE e.bank_transaction_id = OLD.id
  ORDER BY e.seq DESC
  LIMIT 1;

  -- Geen geschiedenis: gedrag gelijk aan vóór deze migratie.
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deze banktransactie heeft een boekingsgeschiedenis in het grootboek; verwijderen is niet mogelijk.'
      USING ERRCODE = '42501';
  END IF;

  IF v_identity_changed THEN
    RAISE EXCEPTION 'Deze banktransactie heeft een boekingsgeschiedenis in het grootboek; bedrag, datum, administratie, organisatie en eigenaar kunnen niet meer worden gewijzigd.'
      USING ERRCODE = '42501';
  END IF;

  -- Vrijgegeven = de laatste gebeurtenis is `released` én elke directe
  -- bankgroep van deze transactie staat al als vervangen vast. Een groep die
  -- (nog) niet vervangen is, hoort bij een correctie die nu in dezelfde
  -- transactie loopt: haar marker is net losgemaakt en haar gebeurtenis volgt
  -- — de uitgestelde lineage-controle dwingt dat bij COMMIT af. Zo'n groep
  -- bestaat na een vrijgave alleen als zij buiten de RPC's om is geboekt,
  -- bijvoorbeeld tijdens een functionele rollback van deze migratie.
  -- Een bewezen historische storno van vóór de correctiegebeurtenissen van
  -- deze transactie (bank_transaction_group_is_settled_history) is zo'n groep
  -- niet: zij hoort bij geen lopende correctie en schakelt de hold niet uit.
  IF v_last = 'released' AND v_coding_changed
     AND NOT EXISTS (
       SELECT 1 FROM public.ledger_postings lp
       WHERE lp.source_type = 'bank_transaction' AND lp.source_id = OLD.id
         AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                         WHERE e.superseded_posting_group_id = lp.posting_group_id)
         AND NOT public.bank_transaction_group_is_settled_history(OLD.id, lp.posting_group_id)) THEN
    RAISE EXCEPTION 'Deze banktransactie is vrijgegeven na een geboekte correctie; status, rekening, BTW en factuurmatch wijzigen alleen via "Opnieuw boeken" of "Terug naar werkstroom" door een accountant.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_bank_transaction_release_hold() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_bank_transaction_release_hold() IS
'D12 — BEFORE UPDATE OR DELETE op bank_transactions (ENABLE ALWAYS). Zonder marker en met boekingsgeschiedenis: verwijderen en identiteitswijzigingen geweigerd; na een vrijgave (laatste gebeurtenis released) ook status, rekening, BTW en factuurmatch, voor elke rol en elk pad. Een bewezen historische storno van vóór de correctiegebeurtenissen (bank_transaction_group_is_settled_history) schakelt die hold niet uit. Kijkt niet naar rollen.';
$fix_20261018180000$;

  -- Achteraf: exact de beoordeelde eindtoestand, anders draait alles terug.
  IF NOT ((SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'))
      IS NOT DISTINCT FROM '067939e0c44a672c26ec8883717ef6d2'
  AND (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()'))
      IS NOT DISTINCT FROM '43347fb9f48ed4c161e291fa769577c2'
  AND (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)'))
      IS NOT DISTINCT FROM '697f9413067e9c5b73323b792c51cda9'
  AND EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = 'public.bank_transactions'::regclass
                AND t.tgname = 'enforce_bank_transaction_release_hold_trigger'
                AND t.tgfoid = to_regprocedure('public.enforce_bank_transaction_release_hold()')
                AND t.tgenabled = 'A')) THEN
    RAISE EXCEPTION 'Uitrol geweigerd: na de drie migraties is de eindtoestand niet de beoordeelde; er is niets veranderd' USING ERRCODE = '55000';
  END IF;
END
$uitrol_20261018180000$;

SELECT CASE WHEN (SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'))
      IS NOT DISTINCT FROM '067939e0c44a672c26ec8883717ef6d2'
  AND (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.enforce_bank_transaction_release_hold()'))
      IS NOT DISTINCT FROM '43347fb9f48ed4c161e291fa769577c2'
  AND (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)'))
      IS NOT DISTINCT FROM '697f9413067e9c5b73323b792c51cda9'
  AND EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = 'public.bank_transactions'::regclass
                AND t.tgname = 'enforce_bank_transaction_release_hold_trigger'
                AND t.tgfoid = to_regprocedure('public.enforce_bank_transaction_release_hold()')
                AND t.tgenabled = 'A')
            THEN 'gecombineerde uitrol voltooid' ELSE 'NIET VOLTOOID — STOP' END AS uitkomst,
       (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
          AND proname = 'bank_transaction_group_is_settled_history') AS hulpfunctie,
       (SELECT count(*) FROM pg_class WHERE oid = to_regclass('public.bank_transaction_posting_events')) AS gebeurtenistabel;
