-- ═════════════════════════════════════════════════════════════════════════════
-- 6C-b11 (PR A) — FUNDERING VOOR DE BOEKJAARLEVENSCYCLUS
--
-- Zie docs/BOEKASSIST_YEAR_CLOSE_LIFECYCLE.md, secties D, E1 en K.
--
-- WAT DEZE MIGRATIE DOET
--   1. public.fiscal_year_events  — onuitwisbare gebeurtenisgeschiedenis
--   2. public.year_closures.status — de huidige stand, 'closed' voor alles wat er staat
--   3. backfill: precies één 'closed'-gebeurtenis per bestaande afsluitrij
--
-- WAT DEZE MIGRATIE NADRUKKELIJK NIET DOET — EN DAT IS HET BELANGRIJKSTE
--
--   GEEN GEDRAGSWIJZIGING. Na deze migratie doet het product exact hetzelfde als
--   ervoor. `close_fiscal_year()` wordt niet aangeraakt en schrijft dus nog geen
--   gebeurtenis; `clients.afgesloten_boekjaar` blijft het technische watermerk;
--   alle acht schrijvers houden hun eigen afgesloten-jaar-toets; de
--   bulk-preflight blijft zoals zij is. Er kan nog geen boekjaar worden
--   heropend en er bestaat nog geen boekingsblokkade.
--
--   Deze tabel wordt hier dus AANGELEGD EN GEVULD, maar nog door niemand
--   gelezen of geschreven. Dat is met opzet: de fundering kan zo apart worden
--   beoordeeld en apart worden uitgerold, zonder dat er ook maar iets aan de
--   werking verandert dat teruggedraaid zou moeten worden.
--
--   GEEN VERSOEPELING VAN BESTAANDE GARANTIES. `prevent_year_closure_mutation()`
--   blijft ongewijzigd en blijft élke UPDATE op `year_closures` weigeren. Dat
--   betekent dat de nieuwe kolom `status` vandaag feitelijk vastligt op
--   'closed' — en dat is correct, want er bestaat nog geen heropening. PR E
--   versmalt die trigger bewust en expliciet tot "alleen de kolom status mag
--   wijzigen"; dat hoort daar thuis, met een eigen bewijs en een eigen review,
--   en niet hier.
--
-- ROLLBACK (handmatig, in deze volgorde):
--   DROP TRIGGER IF EXISTS prevent_fiscal_year_event_truncate_trigger ON public.fiscal_year_events;
--   DROP TRIGGER IF EXISTS prevent_fiscal_year_event_mutation_trigger ON public.fiscal_year_events;
--   DROP FUNCTION IF EXISTS public.prevent_fiscal_year_event_mutation();
--   DROP TRIGGER IF EXISTS enforce_fiscal_year_event_org_trigger ON public.fiscal_year_events;
--   DROP FUNCTION IF EXISTS public.enforce_fiscal_year_event_org();
--   DROP TABLE IF EXISTS public.fiscal_year_events;
--   ALTER TABLE public.year_closures DROP CONSTRAINT IF EXISTS year_closures_status_check;
--   ALTER TABLE public.year_closures DROP COLUMN IF EXISTS status;
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) Voorwaarden
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.year_closures') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b11 vereist eerst public.year_closures (6C-b10)';
  END IF;
  IF to_regproc('public.has_min_role') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b11 vereist eerst public.has_min_role()';
  END IF;
  IF to_regproc('public.posting_client_org_ok') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b11 vereist eerst public.posting_client_org_ok() (6C-b2)';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) De gebeurtenissen
--
--    WAAROM EEN APARTE TABEL EN NIET year_closures OMBOUWEN. `year_closures`
--    heeft `(client_id, fiscal_year)` als primary key, en juist die sleutel ís
--    de idempotentiegarantie van `close_fiscal_year()`: twee gelijktijdige
--    afsluitingen arbitreren erop. Zou die tabel een gebeurtenislog worden, dan
--    moest die sleutel wijken en zou de garantie verschuiven naar een
--    "laatste rij per jaar"-zoekactie onder de grendel. Dat is een zwakkere
--    garantie voor een probleem dat we niet hebben.
--
--    Dus: `year_closures` blijft de HUIDIGE STAND, `fiscal_year_events` wordt de
--    GESCHIEDENIS. Twee tabellen met elk één taak.
--
--    WAAROM `id` EN NIET (client_id, fiscal_year, …) ALS SLEUTEL. Een boekjaar
--    mag in de toekomst meerdere keren dicht en open gaan — closed → reopened →
--    closed. Elke sleutel die op (administratie, jaar) uniek is, zou dat voor
--    altijd onmogelijk maken. Zie sectie 4 voor de invariant die wél nodig is.
--
--    `reason` IS VERPLICHT BIJ HEROPENEN. Een heropening zonder reden is geen
--    auditspoor maar een gat erin. Bij een afsluiting is een reden optioneel:
--    daar is de gebeurtenis zelf de verklaring.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.fiscal_year_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  client_id       uuid        NOT NULL,
  organization_id uuid        NOT NULL,

  fiscal_year     integer     NOT NULL
                              CONSTRAINT fiscal_year_events_fiscal_year_check
                              -- Exact het bereik van year_closures en van
                              -- ledger_postings.boekjaar; geen nieuw domein.
                              CHECK (fiscal_year BETWEEN 2000 AND 2100),

  event_type      text        NOT NULL
                              CONSTRAINT fiscal_year_events_event_type_check
                              CHECK (event_type IN ('closed', 'reopened')),

  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid        NOT NULL,

  -- Vrije toelichting. Verplicht bij een heropening, optioneel bij een
  -- afsluiting, en in beide gevallen nooit een boekhoudkundig gegeven: er wordt
  -- niets uit afgeleid. Whitespace-only telt niet als reden — btrim() alleen
  -- trimt spaties, dus expliciet ook tab, CR en LF.
  reason          text        NULL,

  /*
   * Deze rij is uit `year_closures` gereconstrueerd in plaats van waargenomen
   * op het moment zelf. Dat verschil hoort zichtbaar te zijn in een auditspoor,
   * en het draagt bovendien de invariant uit sectie 4.
   */
  backfilled      boolean     NOT NULL DEFAULT false,

  CONSTRAINT fiscal_year_events_reason_check CHECK (
    CASE
      WHEN event_type = 'reopened'
        THEN reason IS NOT NULL
             AND btrim(reason, E' \t\r\n') <> ''
             AND length(reason) <= 500
      ELSE reason IS NULL
           OR (btrim(reason, E' \t\r\n') <> '' AND length(reason) <= 500)
    END
  )
);

-- RESTRICT overal: deze rijen verklaren waarom een boekjaar de status heeft die
-- het heeft. Zij mogen er nooit onderuit worden gecascadeerd. Exact het patroon
-- van year_closures (6C-b10) en ledger_reversal_postings (6C-b9).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'fiscal_year_events'
      AND c.conname = 'fiscal_year_events_client_id_fkey'
  ) THEN
    ALTER TABLE public.fiscal_year_events
      ADD CONSTRAINT fiscal_year_events_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'fiscal_year_events'
      AND c.conname = 'fiscal_year_events_organization_id_fkey'
  ) THEN
    ALTER TABLE public.fiscal_year_events
      ADD CONSTRAINT fiscal_year_events_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'fiscal_year_events'
      AND c.conname = 'fiscal_year_events_actor_id_fkey'
  ) THEN
    ALTER TABLE public.fiscal_year_events
      ADD CONSTRAINT fiscal_year_events_actor_id_fkey
      FOREIGN KEY (actor_id) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- De leesweg van straks: de geschiedenis van één administratie en één boekjaar,
-- op volgorde. Ook de sleutel waarop de statusafleiding ("de laatste
-- gebeurtenis wint") straks draait.
CREATE INDEX IF NOT EXISTS idx_fiscal_year_events_client_year
  ON public.fiscal_year_events (client_id, fiscal_year, occurred_at);

CREATE INDEX IF NOT EXISTS idx_fiscal_year_events_organization
  ON public.fiscal_year_events (organization_id);

CREATE INDEX IF NOT EXISTS idx_fiscal_year_events_actor
  ON public.fiscal_year_events (actor_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Tenantintegriteit — dezelfde functie, niet een tweede model
--
--    De twee foreign keys bewijzen dat de administratie bestaat en dat de
--    organisatie bestaat, maar NIET dat die administratie bij díé organisatie
--    hoort. Zonder die derde controle zou een gebeurtenis onder de vlag van
--    organisatie B kunnen worden vastgelegd voor een administratie van A — en
--    omdat de RLS-policy in sectie 5 op `organization_id` leest, zou B dan de
--    geschiedenis van A zien terwijl A de hare mist.
--
--    `posting_client_org_ok()` (6C-b2) doet precies deze controle, is
--    SECURITY DEFINER (en ziet dus ook rijen die RLS voor de aanroeper
--    verbergt), en wordt al gebruikt door `enforce_ledger_posting_org()` en
--    `enforce_year_closure_org()`. Hier hergebruikt, niet nagebouwd.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_fiscal_year_event_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.posting_client_org_ok(NEW.client_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'client_id verwijst naar een administratie buiten de organisatie van deze boekjaargebeurtenis'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_fiscal_year_event_org() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_fiscal_year_event_org_trigger ON public.fiscal_year_events;
CREATE TRIGGER enforce_fiscal_year_event_org_trigger
  BEFORE INSERT ON public.fiscal_year_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_fiscal_year_event_org();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Onuitwisbaarheid
--
--    Hetzelfde patroon als `prevent_ledger_posting_mutation()` (6C-b2) en
--    `prevent_year_closure_mutation()` (6C-b10), en om dezelfde reden: een
--    geschiedenis die kan worden herschreven, bewijst niets. Een heropening die
--    achteraf kan worden weggepoetst, is erger dan geen heropening.
--
--    TRUNCATE vuurt geen ROW-trigger en zou dus langs de eerste trigger
--    glippen; een STATEMENT-trigger ziet hem wel. Beide staan ENABLE ALWAYS,
--    zodat `session_replication_role = replica` ze niet stilzwijgend
--    uitschakelt.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_fiscal_year_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'fiscal_year_events is append-only: % is niet toegestaan. De geschiedenis van een boekjaar wordt aangevuld, nooit herschreven.', TG_OP
    USING ERRCODE = '42501';
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.prevent_fiscal_year_event_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS prevent_fiscal_year_event_mutation_trigger ON public.fiscal_year_events;
CREATE TRIGGER prevent_fiscal_year_event_mutation_trigger
  BEFORE UPDATE OR DELETE ON public.fiscal_year_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_fiscal_year_event_mutation();

DROP TRIGGER IF EXISTS prevent_fiscal_year_event_truncate_trigger ON public.fiscal_year_events;
CREATE TRIGGER prevent_fiscal_year_event_truncate_trigger
  BEFORE TRUNCATE ON public.fiscal_year_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_fiscal_year_event_mutation();

ALTER TABLE public.fiscal_year_events ENABLE ALWAYS TRIGGER prevent_fiscal_year_event_mutation_trigger;
ALTER TABLE public.fiscal_year_events ENABLE ALWAYS TRIGGER prevent_fiscal_year_event_truncate_trigger;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) DE INVARIANT VOOR DE BACKFILL
--
--    Het probleem: de backfill in sectie 7 mag nooit twee gebeurtenissen voor
--    dezelfde afsluiting opleveren — niet bij een herhaalde migratie, niet bij
--    een herstelactie, niet per ongeluk. "De migratie draait maar één keer" is
--    geen invariant maar een hoop.
--
--    Het niet-probleem: een boekjaar MOET in de toekomst meerdere keren dicht
--    en open kunnen. Een unieke sleutel op (administratie, boekjaar) zou
--    closed → reopened → closed voorgoed onmogelijk maken, en dat is precies
--    het gedrag dat deze hele herziening wil toevoegen.
--
--    De oplossing scheidt die twee: de uniciteit geldt ALLEEN voor
--    gereconstrueerde rijen. Er kan hoogstens één backfill-gebeurtenis per
--    administratie en boekjaar bestaan; over gewone, waargenomen gebeurtenissen
--    zegt deze index niets, dus daar mogen er zoveel van zijn als de
--    levenscyclus nodig heeft.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uniq_fiscal_year_events_backfill
  ON public.fiscal_year_events (client_id, fiscal_year)
  WHERE backfilled;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Rechten
--
--    Exact het model van `year_closures` (6C-b10): lezen mag iedereen die de
--    organisatie mag lezen, schrijven doet straks uitsluitend een
--    SECURITY DEFINER-RPC. Kon een ingelogde gebruiker hier zelf schrijven, dan
--    kon hij een heropening verzinnen die nooit heeft plaatsgevonden.
--
--    REVOKE ALL gevolgd door één GRANT SELECT, geen opsomming: geen toekomstig
--    default privilege glipt er dan langs.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.fiscal_year_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_fiscal_year_events_select ON public.fiscal_year_events;
CREATE POLICY role_fiscal_year_events_select ON public.fiscal_year_events
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

REVOKE ALL ON public.fiscal_year_events FROM anon, authenticated, service_role;
GRANT SELECT ON public.fiscal_year_events TO authenticated, service_role;

COMMENT ON TABLE public.fiscal_year_events IS
'Onuitwisbare geschiedenis van de levenscyclus van een boekjaar: afgesloten en (straks) heropend. Aangevuld, nooit herschreven. public.year_closures blijft de HUIDIGE STAND met haar eigen primary key als idempotentiegarantie; deze tabel is de GESCHIEDENIS. Vanaf PR A alleen aangelegd en gevuld — nog geen enkele schrijver of scherm leest of schrijft hier.';

COMMENT ON COLUMN public.fiscal_year_events.reason IS
'Verplicht bij event_type = reopened: een heropening zonder reden is geen auditspoor maar een gat erin. Optioneel bij een afsluiting. Nooit een boekhoudkundig gegeven; er wordt niets uit afgeleid.';

COMMENT ON COLUMN public.fiscal_year_events.backfilled IS
'true = gereconstrueerd uit een bestaande year_closures-rij in plaats van waargenomen op het moment zelf. Draagt de unieke index die dubbele backfill onmogelijk maakt, zonder iets te zeggen over het aantal gewone gebeurtenissen per boekjaar.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) De huidige stand op year_closures
--
--    Eén nullable-vrije kolom met een default, additief en zonder herschrijving.
--    Elke bestaande rij betekent vandaag "dit jaar is afgesloten", dus
--    DEFAULT 'closed' is voor alles wat er staat de juiste waarde — er wordt
--    niets geraden.
--
--    De kolom is vandaag feitelijk onveranderlijk, omdat
--    `prevent_year_closure_mutation()` élke UPDATE weigert. Dat is nu juist:
--    heropenen bestaat nog niet. PR E versmalt die trigger expliciet tot
--    "alleen status mag wijzigen"; dat gebeurt DAAR, niet hier.
--
--    ALTER TABLE vuurt geen rijtriggers, dus deze toevoeging loopt niet tegen
--    de bestaande mutatiegrendel aan.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.year_closures
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'closed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.year_closures'::regclass
      AND conname = 'year_closures_status_check'
  ) THEN
    ALTER TABLE public.year_closures
      ADD CONSTRAINT year_closures_status_check
      CHECK (status IN ('closed', 'reopened'));
  END IF;
END
$$;

COMMENT ON COLUMN public.year_closures.status IS
'De huidige stand van dit boekjaar: closed of reopened. Vandaag altijd closed — heropenen bestaat nog niet en prevent_year_closure_mutation() weigert elke UPDATE. PR E versmalt die trigger tot uitsluitend deze kolom.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) DE BACKFILL
--
--    Precies één 'closed'-gebeurtenis per bestaande afsluitrij, met de gegevens
--    die daar al staan. Er wordt niets verzonnen: `occurred_at` is
--    `closed_at`, `actor_id` is `closed_by`, en `reason` blijft NULL omdat er
--    destijds geen reden is vastgelegd.
--
--    WAT ER NIET WORDT GEBACKFILD, EN WAAROM DAT BELANGRIJK IS
--    `clients.afgesloten_boekjaar` is GEEN bron. Productie kent administraties
--    waarvan dat veld vóór 6C-b10 met de hand is gezet, zonder afsluitrij. Voor
--    die jaren bestaat geen tijdstip en geen actor. Daar een gebeurtenis van
--    maken zou betekenen: een afsluiting fabriceren die nooit is uitgevoerd,
--    met een verzonnen moment en een verzonnen persoon — in precies die tabel
--    die het auditspoor moet zijn. Die administraties blijven dus onaangeroerd,
--    en krijgen in PR E/F een echte herstelweg: bewust heropenen, controleren,
--    en via de nieuwe weg afsluiten. Dán is er wél bewijs.
--
--    IDEMPOTENT OP TWEE MANIEREN, allebei in de database en geen van beide
--    afhankelijk van "hoe vaak deze migratie draait":
--      • de unieke index uit sectie 4 maakt een tweede backfill-rij voor
--        dezelfde administratie en hetzelfde boekjaar onmogelijk;
--      • de NOT EXISTS hieronder zorgt dat een herhaling stil niets doet in
--        plaats van op die index te knallen.
--    DETERMINISTISCH: dezelfde invoer levert dezelfde rijen, op de gegenereerde
--    `id` na — en die is per definitie geen gegeven maar een sleutel.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.fiscal_year_events
  (client_id, organization_id, fiscal_year, event_type, occurred_at, actor_id, reason, backfilled)
SELECT yc.client_id,
       yc.organization_id,
       yc.fiscal_year,
       'closed',
       yc.closed_at,
       yc.closed_by,
       NULL,
       true
FROM public.year_closures yc
WHERE NOT EXISTS (
  SELECT 1
  FROM public.fiscal_year_events fye
  WHERE fye.client_id = yc.client_id
    AND fye.fiscal_year = yc.fiscal_year
    AND fye.backfilled
);
