-- ═════════════════════════════════════════════════════════════════════════════
-- 6C-b11 (PR C) — DE BOEKINGSBLOKKADE, LOS VAN DE JAARAFSLUITING
--
-- Zie docs/BOEKASSIST_YEAR_CLOSE_LIFECYCLE.md, secties C, E2 en H.
--
-- WAAROM DIT EEN APART BEGRIP IS
--   Vandaag doet `clients.afgesloten_boekjaar` twee dingen tegelijk: het zegt
--   dat een boekjaar administratief is afgerond, én het is het technische
--   schrijfverbod. Die twee hebben een andere levensduur (een gebeurtenis
--   tegenover een instelling), een andere korrel (een boekjaar tegenover een
--   datum) en een andere foutkost (een slordigheid tegenover geblokkeerd werk).
--
--   Deze migratie legt het tweede begrip aan als eigen besturingselement:
--   `clients.posting_locked_through`, een DATUM, met een eigen auditspoor en
--   een eigen schrijver.
--
-- WAT DEZE MIGRATIE NADRUKKELIJK NIET DOET
--
--   GEEN ENKELE SCHRIJVER GAAT HEM TOETSEN. `posting_allowed()` wordt hier
--   aangemaakt maar door niemand aangeroepen. De acht boekingsschrijvers, de
--   bulk-preflight en de tegenboekingsmotor houden exact hun huidige
--   afgesloten-jaar-toets. Er verandert dus niets aan wat er vandaag wel of
--   niet geboekt kan worden. Dat gebeurt in PR D, apart te beoordelen en apart
--   uit te rollen.
--
--   GEEN KOPPELING MET DE JAARAFSLUITING. `close_fiscal_year()` wordt niet
--   aangeraakt en zet deze blokkade niet. Een boekjaar afsluiten en een periode
--   op slot zetten zijn vanaf nu twee losse handelingen — en dat is precies het
--   punt van deze PR.
--
--   GEEN BACKFILL. Elke bestaande administratie begint op NULL: geen
--   blokkade. Er wordt niets afgeleid uit `afgesloten_boekjaar` en niets uit
--   `year_closures`. Zou dat wel gebeuren, dan zou deze migratie stilzwijgend
--   een beheersmaatregel invoeren die niemand heeft ingesteld — en juist de
--   verwarring bestendigen die we aan het opheffen zijn.
--
-- ROLLBACK (handmatig, in deze volgorde):
--   DROP TRIGGER IF EXISTS enforce_posting_lock_change_trigger ON public.clients;
--   DROP FUNCTION IF EXISTS public.enforce_posting_lock_change();
--   DROP FUNCTION IF EXISTS public.set_posting_lock(uuid, date, text);
--   DROP FUNCTION IF EXISTS public.posting_allowed(uuid, date);
--   DROP TRIGGER IF EXISTS prevent_posting_lock_event_truncate_trigger ON public.posting_lock_events;
--   DROP TRIGGER IF EXISTS prevent_posting_lock_event_mutation_trigger ON public.posting_lock_events;
--   DROP FUNCTION IF EXISTS public.prevent_posting_lock_event_mutation();
--   DROP TRIGGER IF EXISTS enforce_posting_lock_event_org_trigger ON public.posting_lock_events;
--   DROP FUNCTION IF EXISTS public.enforce_posting_lock_event_org();
--   DROP TABLE IF EXISTS public.posting_lock_events;
--   ALTER TABLE public.clients DROP COLUMN IF EXISTS posting_locked_through;
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) Voorwaarden
-- ─────────────────────────────────────────────────────────────────────────────

DO $migratie$
BEGIN
  IF to_regproc('public.has_min_role') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b11 PR C vereist eerst public.has_min_role()';
  END IF;
  IF to_regproc('public.posting_client_org_ok') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b11 PR C vereist eerst public.posting_client_org_ok() (6C-b2)';
  END IF;
  IF to_regproc('public.lock_ledger_client') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b11 PR C vereist eerst public.lock_ledger_client() (6C-b8)';
  END IF;
END
$migratie$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) De kolom
--
--    EEN DATUM, GEEN JAARTAL. "Dicht t/m 31-12-2024" is wat een kantoor
--    werkelijk gebruikt, en na een BTW-aangifte wil men soms "dicht t/m
--    30-06-2025". Een tweede integer naast `afgesloten_boekjaar` zou bovendien
--    twee bijna gelijknamige velden opleveren; een datum is ook aan haar type
--    te onderscheiden.
--
--    NULL = geen blokkade. Geen default, geen backfill, geen massa-update: elke
--    bestaande administratie blijft precies zoals zij is.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS posting_locked_through date NULL;

COMMENT ON COLUMN public.clients.posting_locked_through IS
'Boekingsblokkade: t/m deze boekhoudkundige datum mag er niet worden geboekt. NULL = geen blokkade. STAAT LOS van afgesloten_boekjaar — dat veld is de administratieve jaarstatus. Wordt uitsluitend gezet door public.set_posting_lock(); de trigger enforce_posting_lock_change() weigert elke andere UPDATE. Vanaf PR C nog door geen enkele schrijver getoetst.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Het auditspoor
--
--    EEN EIGEN DOMEIN, NIET fiscal_year_events. Een boekjaargebeurtenis gaat
--    over de administratieve levensloop van één boekjaar; een
--    blokkadewijziging gaat over een technische instelling van de hele
--    administratie, met een datum in plaats van een jaartal en met een oude én
--    een nieuwe waarde. Ze in één tabel persen zou beide verhalen onleesbaar
--    maken.
--
--    REDEN VERPLICHT. Een blokkade verlagen of opheffen is de gevoelige
--    handeling; zonder reden is het auditspoor waardeloos. Ook het ZETTEN van
--    een blokkade vraagt een reden — dat kost niets en houdt de tabel
--    uniform.
--
--    EEN GEBEURTENIS ZONDER WIJZIGING KAN NIET BESTAAN. De CHECK hieronder
--    maakt "auditruis" structureel onmogelijk in plaats van een afspraak in de
--    schrijver.
--
--    created_xact_id IS LOAD-BEARING, geen metadata. Sectie 6 gebruikt hem om
--    te bewijzen dat een wijziging van de kolom uit DEZE transactie komt, en
--    dus van de schrijver. Zonder dat zegel zou een oude gebeurtenis een latere
--    handmatige UPDATE kunnen legitimeren (A → B → A → en dan met de hand weer
--    B, want er bestaat immers al een A→B-gebeurtenis). xid8 en niet xid: de
--    32-bits variant wrapt en zou twee verschillende transacties ooit gelijk
--    laten lijken — precies het patroon van ledger_postings (6C-b2).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.posting_lock_events (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  client_id               uuid        NOT NULL,
  organization_id         uuid        NOT NULL,

  previous_locked_through date        NULL,
  new_locked_through      date        NULL,

  changed_at              timestamptz NOT NULL DEFAULT now(),
  changed_by              uuid        NOT NULL,

  reason                  text        NOT NULL
                                      CONSTRAINT posting_lock_events_reason_check
                                      -- btrim() alleen trimt spaties, dus tab,
                                      -- CR en LF expliciet erbij.
                                      CHECK (btrim(reason, E' \t\r\n') <> ''
                                             AND length(reason) <= 500),

  created_xact_id         xid8        NOT NULL DEFAULT pg_current_xact_id(),

  -- Een gebeurtenis die niets verandert, is geen gebeurtenis.
  CONSTRAINT posting_lock_events_real_change_check
    CHECK (new_locked_through IS DISTINCT FROM previous_locked_through)
);

-- RESTRICT overal: deze rijen verklaren waarom een administratie op slot staat
-- of juist niet. Zij mogen er nooit onderuit worden gecascadeerd.
DO $migratie$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'posting_lock_events'
      AND c.conname = 'posting_lock_events_client_id_fkey'
  ) THEN
    ALTER TABLE public.posting_lock_events
      ADD CONSTRAINT posting_lock_events_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'posting_lock_events'
      AND c.conname = 'posting_lock_events_organization_id_fkey'
  ) THEN
    ALTER TABLE public.posting_lock_events
      ADD CONSTRAINT posting_lock_events_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'posting_lock_events'
      AND c.conname = 'posting_lock_events_changed_by_fkey'
  ) THEN
    ALTER TABLE public.posting_lock_events
      ADD CONSTRAINT posting_lock_events_changed_by_fkey
      FOREIGN KEY (changed_by) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$migratie$;

CREATE INDEX IF NOT EXISTS idx_posting_lock_events_client
  ON public.posting_lock_events (client_id, changed_at);

CREATE INDEX IF NOT EXISTS idx_posting_lock_events_organization
  ON public.posting_lock_events (organization_id);

CREATE INDEX IF NOT EXISTS idx_posting_lock_events_changed_by
  ON public.posting_lock_events (changed_by);

-- Tenantintegriteit via dezelfde bewezen functie als het grootboek, het
-- afsluitbewijs en de boekjaargebeurtenissen. Geen tweede tenantmodel.
CREATE OR REPLACE FUNCTION public.enforce_posting_lock_event_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.posting_client_org_ok(NEW.client_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'client_id verwijst naar een administratie buiten de organisatie van deze blokkadewijziging'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_posting_lock_event_org() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_posting_lock_event_org_trigger ON public.posting_lock_events;
CREATE TRIGGER enforce_posting_lock_event_org_trigger
  BEFORE INSERT ON public.posting_lock_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_posting_lock_event_org();

-- Onuitwisbaar, inclusief TRUNCATE, en ENABLE ALWAYS zodat
-- session_replication_role de grendel niet stilletjes uitschakelt.
CREATE OR REPLACE FUNCTION public.prevent_posting_lock_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'posting_lock_events is append-only: % is niet toegestaan. De geschiedenis van de boekingsblokkade wordt aangevuld, nooit herschreven.', TG_OP
    USING ERRCODE = '42501';
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.prevent_posting_lock_event_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS prevent_posting_lock_event_mutation_trigger ON public.posting_lock_events;
CREATE TRIGGER prevent_posting_lock_event_mutation_trigger
  BEFORE UPDATE OR DELETE ON public.posting_lock_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posting_lock_event_mutation();

DROP TRIGGER IF EXISTS prevent_posting_lock_event_truncate_trigger ON public.posting_lock_events;
CREATE TRIGGER prevent_posting_lock_event_truncate_trigger
  BEFORE TRUNCATE ON public.posting_lock_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_posting_lock_event_mutation();

ALTER TABLE public.posting_lock_events ENABLE ALWAYS TRIGGER prevent_posting_lock_event_mutation_trigger;
ALTER TABLE public.posting_lock_events ENABLE ALWAYS TRIGGER prevent_posting_lock_event_truncate_trigger;

-- Rechten: lezen mag wie de organisatie mag lezen, schrijven doet uitsluitend
-- de RPC. REVOKE ALL gevolgd door één GRANT SELECT, geen opsomming.
ALTER TABLE public.posting_lock_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_posting_lock_events_select ON public.posting_lock_events;
CREATE POLICY role_posting_lock_events_select ON public.posting_lock_events
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

REVOKE ALL ON public.posting_lock_events FROM anon, authenticated, service_role;
GRANT SELECT ON public.posting_lock_events TO authenticated, service_role;

COMMENT ON TABLE public.posting_lock_events IS
'Onuitwisbare geschiedenis van de boekingsblokkade: wie hem wanneer van welke datum naar welke datum heeft gezet, en waarom. Een eigen auditdomein, los van fiscal_year_events — dat gaat over de administratieve levensloop van een boekjaar, dit over een technische instelling van de administratie. Alleen public.set_posting_lock() schrijft hier.';

COMMENT ON COLUMN public.posting_lock_events.created_xact_id IS
'De transactie die deze wijziging vastlegde. Load-bearing: enforce_posting_lock_change() eist een gebeurtenis uit DEZELFDE transactie, zodat een oude gebeurtenis een latere handmatige UPDATE niet kan legitimeren.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) De leeshelper
--
--    Het technische besturingselement in één functie, zodat PR D de acht
--    schrijvers niet elk een eigen variant laat schrijven — de fout die we bij
--    `afgesloten_boekjaar` juist hebben gevonden: acht byte-identieke kopieën
--    zonder gedeelde helper.
--
--    FAIL CLOSED. Een ontbrekende administratie, een ontbrekend id of een
--    ontbrekende datum leveren `false` op, niet `true`. Een boeking die niet
--    kan worden beoordeeld, is geen boeking die mag.
--
--    GEEN TENANTLEK. De functie geeft uitsluitend een boolean terug. Een
--    onbekende administratie en een volledig geblokkeerde administratie geven
--    allebei `false`, dus er valt niets uit af te lezen over welke
--    administratie-id's bestaan.
--
--    NOG DOOR NIEMAND AANGEROEPEN. Dat is geen omissie maar de scope van deze
--    PR.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.posting_allowed(
  _client_id    uuid,
  _posting_date date
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN _client_id IS NULL OR _posting_date IS NULL THEN false
           ELSE COALESCE(
                  (SELECT c.posting_locked_through IS NULL
                          OR _posting_date > c.posting_locked_through
                   FROM public.clients c
                   WHERE c.id = _client_id),
                  false)
         END;
$$;

REVOKE ALL ON FUNCTION public.posting_allowed(uuid, date) FROM PUBLIC;

COMMENT ON FUNCTION public.posting_allowed(uuid, date) IS
'Mag er op deze boekhoudkundige datum worden geboekt, gegeven de boekingsblokkade van deze administratie? NULL-blokkade of een datum ná de blokkade: true. Een datum op of vóór de blokkade: false. Ontbrekende administratie, id of datum: false — fail closed. Zegt NIETS over afgesloten_boekjaar; dat is een ander begrip. Vanaf PR C nog door geen enkele schrijver aangeroepen.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) De schrijver
--
--    GRENDELVOLGORDE, gelijk aan elke andere administratiegebonden schrijver:
--      administratiegrendel (lock_ledger_client)
--        → rijgrendel op de administratie (SELECT … FOR UPDATE)
--          → gebeurtenis
--            → de kolom
--
--    De administratiegrendel is hier geen sier: hij zorgt dat een
--    blokkadewijziging niet kan interleaven met een boeking of een afsluiting
--    van dezelfde administratie. Zodra PR D de schrijvers op `posting_allowed()`
--    laat toetsen, is dat het verschil tussen een sluitende en een halve
--    garantie.
--
--    DE GEBEURTENIS VÓÓR DE KOLOM, want de trigger in sectie 6 eist een
--    gebeurtenis uit deze transactie. Dezelfde vorm als bewijs-vóór-watermerk
--    bij de jaarafsluiting.
--
--    ÉÉN TIJDSTIP EN ÉÉN ACTOR: beide uit `RETURNING * INTO v_event`, dus uit
--    de rij zoals zij IS weggeschreven. Geen tweede now().
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_posting_lock(
  _client_id       uuid,
  _locked_through  date,
  _reason          text
)
RETURNS TABLE (
  client_id               uuid,
  organization_id         uuid,
  previous_locked_through date,
  locked_through          date,
  changed_at              timestamptz,
  changed_by              uuid,
  changed                 boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_org    uuid;
  v_client public.clients%ROWTYPE;
  v_reason text;
  v_event  public.posting_lock_events%ROWTYPE;
  v_laatst public.posting_lock_events%ROWTYPE;
BEGIN
  -- (1) Authenticatie eerst: voor een anonieme aanroep wordt niets gelezen en
  --     niets gegrendeld.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- (2) Isolatiecontract, gelijk aan de overige schrijvers van deze fase.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'De boekingsblokkade kan alleen in een READ COMMITTED transactie worden gewijzigd (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  IF _client_id IS NULL THEN
    RAISE EXCEPTION 'Geen administratie opgegeven' USING ERRCODE = '22004';
  END IF;

  -- NULL is hier een GELDIGE waarde: dat is het opheffen van de blokkade.
  IF _locked_through IS NOT NULL
     AND (_locked_through < DATE '2000-01-01' OR _locked_through > DATE '2100-12-31') THEN
    RAISE EXCEPTION 'Blokkadedatum % valt buiten het ondersteunde bereik 2000-2100', _locked_through
      USING ERRCODE = '22023';
  END IF;

  -- (3) De reden normaliseren vóór elke controle: whitespace-only is geen reden.
  v_reason := NULLIF(btrim(COALESCE(_reason, ''), E' \t\r\n'), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Een wijziging van de boekingsblokkade vereist een reden' USING ERRCODE = '22004';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'De reden is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;

  -- ── (4) DE AUTORISATIEPOORT ───────────────────────────────────────────────
  --
  --     Deze functie is SECURITY DEFINER en ziet dus administraties die RLS
  --     voor de aanroeper verbergt. "Bestaat niet" en "geen rechten" krijgen
  --     daarom exact dezelfde fout — anders is het verschil een orakel waarmee
  --     een ingelogde buitenstaander kan aftasten welke administraties bestaan.
  SELECT c.organization_id INTO v_org FROM public.clients c WHERE c.id = _client_id;

  IF v_org IS NULL OR NOT public.has_min_role(v_uid, v_org, 'read_only') THEN
    RAISE EXCEPTION 'Administratie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  --     ROLVLOER = accountant, voor élke richting: zetten, vooruit schuiven,
  --     terugzetten en opheffen. Bewust géén owner-only voor het opheffen: elke
  --     financiële schrijver in dit product staat op accountant, en een
  --     afwijkende vloer hier zou een tweede, ongedocumenteerde rangorde
  --     introduceren. Wat het opheffen zwaarder maakt is de verplichte reden en
  --     het onuitwisbare spoor, niet een andere rol.
  IF NOT public.has_min_role(v_uid, v_org, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om de boekingsblokkade te wijzigen voor deze organisatie (accountant vereist)'
      USING ERRCODE = '42501';
  END IF;

  -- (5) Grendels: eerst de administratie, dan haar rij.
  PERFORM public.lock_ledger_client(_client_id);
  SELECT * INTO v_client FROM public.clients c WHERE c.id = _client_id FOR UPDATE;

  -- (6) Vraagt de aanroeper om de waarde die er al staat, dan gebeurt er niets.
  --     Geen tweede gebeurtenis, geen nieuw tijdstip, geen auditruis — en de
  --     huidige waarde blijft onaangeroerd. IS NOT DISTINCT FROM, want NULL
  --     moet hier als waarde meetellen: "al opgeheven" is ook ongewijzigd.
  IF _locked_through IS NOT DISTINCT FROM v_client.posting_locked_through THEN
    SELECT * INTO v_laatst
    FROM public.posting_lock_events e
    WHERE e.client_id = _client_id
    ORDER BY e.changed_at DESC, e.id DESC
    LIMIT 1;

    RETURN QUERY SELECT _client_id, v_org,
                        v_client.posting_locked_through, v_client.posting_locked_through,
                        v_laatst.changed_at, v_laatst.changed_by, false;
    RETURN;
  END IF;

  -- (7) De gebeurtenis, dan de kolom. In deze volgorde, want de trigger van
  --     sectie 6 eist een gebeurtenis uit deze transactie.
  INSERT INTO public.posting_lock_events
    (client_id, organization_id, previous_locked_through, new_locked_through, changed_by, reason)
  VALUES (_client_id, v_org, v_client.posting_locked_through, _locked_through, v_uid, v_reason)
  RETURNING * INTO v_event;

  UPDATE public.clients c
     SET posting_locked_through = _locked_through
   WHERE c.id = _client_id;

  RETURN QUERY SELECT v_event.client_id, v_event.organization_id,
                      v_event.previous_locked_through, v_event.new_locked_through,
                      v_event.changed_at, v_event.changed_by, true;
END
$$;

REVOKE ALL ON FUNCTION public.set_posting_lock(uuid, date, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_posting_lock(uuid, date, text) TO authenticated;

COMMENT ON FUNCTION public.set_posting_lock(uuid, date, text) IS
'Zet, verschuift of heft de boekingsblokkade van één administratie op, met een verplichte reden. Rolvloer accountant voor elke richting. Legt de wijziging onuitwisbaar vast in posting_lock_events en zet daarna clients.posting_locked_through — in één transactie, met hetzelfde tijdstip en dezelfde actor. Idempotent: dezelfde waarde opnieuw vragen verandert niets en schrijft geen gebeurtenis (changed = false). Raakt de jaarafsluiting niet aan.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) De kolom kan alleen nog via de schrijver bewegen
--
--    HET PROBLEEM. `authenticated` heeft een gewone UPDATE-policy op `clients`
--    vanaf de rol ASSISTENT (`role_clients_update`, 20260613001452). Zonder
--    grendel zou een assistent de boekingsblokkade dus met één gewone update
--    kunnen opheffen — precies de handeling waarvoor hierboven een
--    accountantsvloer, een verplichte reden en een auditspoor zijn ingericht.
--    Kolomrechten zijn hier geen optie: de policy is rijgebaseerd en het
--    klantformulier schrijft legitiem allerlei andere kolommen.
--
--    DE OPLOSSING, EN WAAROM JUIST DEZE. Dezelfde vorm als bij het
--    afsluitwatermerk: de vastgelegde wijziging is de autoriteit. De kolom mag
--    alleen naar een waarde waarvoor in DEZE transactie een gebeurtenis is
--    vastgelegd die precies deze stap beschrijft (van de oude naar de nieuwe
--    waarde).
--
--    WAAROM "IN DEZE TRANSACTIE" HET VERSCHIL MAAKT. Zonder die eis zou een
--    oude gebeurtenis een latere handmatige update kunnen dekken: na
--    A → B → A bestaat er immers een A→B-gebeurtenis, en dan zou iemand met de
--    hand weer naar B kunnen. Met het transactiezegel kan dat niet: een
--    gebeurtenis uit een eerdere transactie draagt een ander xid8.
--
--    En omdat `authenticated` geen INSERT heeft op `posting_lock_events`, is er
--    maar één weg die zo'n gebeurtenis kan maken: `set_posting_lock()`.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_posting_lock_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.posting_locked_through IS NOT DISTINCT FROM OLD.posting_locked_through THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.posting_lock_events e
    WHERE e.client_id = NEW.id
      AND e.previous_locked_through IS NOT DISTINCT FROM OLD.posting_locked_through
      AND e.new_locked_through IS NOT DISTINCT FROM NEW.posting_locked_through
      AND e.created_xact_id = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'De boekingsblokkade kan alleen worden gewijzigd via public.set_posting_lock(): deze wijziging is nergens vastgelegd.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_posting_lock_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_posting_lock_change_trigger ON public.clients;
CREATE TRIGGER enforce_posting_lock_change_trigger
  BEFORE UPDATE OF posting_locked_through ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.enforce_posting_lock_change();

ALTER TABLE public.clients ENABLE ALWAYS TRIGGER enforce_posting_lock_change_trigger;

COMMENT ON FUNCTION public.enforce_posting_lock_change() IS
'Laat clients.posting_locked_through alleen bewegen wanneer in dezelfde transactie een posting_lock_events-rij is vastgelegd die precies die stap beschrijft. Omdat uitsluitend set_posting_lock() zulke rijen kan maken, is zij daarmee de enige weg naar de boekingsblokkade — ook voor een assistent, die op clients verder wel gewoon UPDATE-rechten heeft.';
