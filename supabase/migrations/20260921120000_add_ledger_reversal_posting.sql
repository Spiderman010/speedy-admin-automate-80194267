-- ─────────────────────────────────────────────────────────────────────────────
-- Fase 6C-b9 — de tegenboekingsmotor (reversal engine)
--
-- De zesde grootboekschrijver, en de eerste die geen brondocument boekt maar
-- een BESTAANDE boekingsgroep tegenboekt.
--
-- HET BOEKHOUDKUNDIGE UITGANGSPUNT
-- public.ledger_postings is de financiële waarheid en is append-only. Een
-- correctie wijzigt nooit een bestaande regel en verwijdert nooit een
-- boekingsgroep. Een tegenboeking is een NIEUWE boekingsgroep die de
-- oorspronkelijke exact negeert:
--
--     Origineel                      Tegenboeking
--     Debet  4602   100              Debet  1600   121
--     Debet  1680    21              Credit 4602   100
--     Credit 1600   121              Credit 1680    21
--
-- Het origineel blijft ongewijzigd, voor altijd. Samen tellen beide groepen
-- op tot nul, zodat elk rapport dat over beide periodes heen kijkt het
-- oorspronkelijke feit én de correctie ziet — zonder dat er ooit iets is
-- weggepoetst.
--
-- WAAROM DIT EEN SECURITY DEFINER-SCHRIJVER MOET ZIJN
-- Sinds 20260920130000 heeft `authenticated` geen INSERT-recht meer op
-- ledger_postings. Er is dus geen client-side schrijfpad, en dat is precies de
-- bedoeling: een tegenboeking die in de browser wordt samengesteld zou alle
-- controles hieronder kunnen overslaan. De applicatie levert uitsluitend
-- identificatie en expliciete correctiemetadata; bedragen, rekeningen, zijden,
-- valuta, organisatie, administratie en herkomst worden server-side uit de
-- gegrendelde, reeds vastgelegde grootboekregels afgeleid.
--
-- WAT DEZE MIGRATIE TOEVOEGT
--   1. public.ledger_reversal_postings   — de claim/audit-marker
--   2. public.reverse_posting_group(...) — de schrijver
--   3. enforce_reversal_source_claim()   — de claimtrigger op ledger_postings
--   4. één partiële unieke index         — één originele regel ↔ één tegenregel
--   5. één CHECK op ledger_postings      — reversal_of_posting_id hoort bij
--                                          bronsoort 'reversal' en nergens anders
--
-- BRONSOORT
-- `reversal`. Bewust een EIGEN bronsoort: de claimtriggers van memoriaal en
-- beginbalans weigeren al expliciet een regel die hun bronsoort draagt én een
-- reversal_of_posting_id ("Een tegenboeking gebruikt een eigen bronsoort").
-- Deze migratie maakt die afspraak sluitend met een CHECK die voor élke rij
-- geldt, ook voor bronsoorten met een minder strenge claimtrigger.
--
-- LINEAGE, IN TWEE LAGEN
--   • regel → regel: ledger_postings.reversal_of_posting_id wijst naar de
--     EXACTE originele grootboekregel-id. Niet naar "een regel van de groep";
--     elke tegenregel wijst naar precies de regel die zij negeert.
--   • groep → groep: de markertabel. original_posting_group_id is de PRIMARY
--     KEY, dus "één originele groep → hoogstens één tegenboeking" is een
--     database-invariant en geen applicatieafspraak.
--
-- ROLVLOER: accountant
-- Gelijk aan memoriaal (6C-b6) en beginbalans (6C-b8), en strenger dan de
-- documentschrijvers (assistant). Een tegenboeking is met de hand opgestelde
-- correctie van vastgelegde geschiedenis; dat hoort bij dezelfde vloer als een
-- memoriaalboeking, niet bij het routineus boeken van een factuur.
--
-- WAT BEWUST NIET KAN
--   • Een tegenboeking van een tegenboeking. De keten blijft
--     origineel → tegenboeking, één stap diep. Een reeks tegenboekingen op
--     elkaar is boekhoudkundig onleesbaar en er is geen scenario dat het nodig
--     maakt: is de tegenboeking zelf fout, dan is de juiste weg een nieuwe,
--     correcte boeking.
--   • Een tegenboeking van een BEGINBALANS (source_type = 'opening_balance').
--     Niet omdat de boeking zelf onmogelijk zou zijn, maar omdat de
--     administratie daarna klem zou zitten: 6C-b8 legt met
--     uniq_opening_balance_postings_client vast dat er hoogstens één geboekte
--     beginbalans per administratie bestaat, en
--     enforce_no_posting_before_opening_balance() blijft alles vóór de
--     openingsdatum weigeren. Het grootboek zou op nul staan terwijl er nooit
--     een gecorrigeerde beginbalans meer geboekt kan worden. 6C-b8 schrijft in
--     zijn eigen header uit welke indexwissel daarvoor nodig is; dat is een
--     aparte, bewuste fase. Tot die er is, weigert deze functie met een
--     expliciete uitleg in plaats van een val te zetten.
--   • Herstellen van een KAPOTTE groep. Een groep die niet sluit, meerdere
--     administraties/valuta/datums draagt of uit meerdere transacties bestaat,
--     wordt geweigerd. Tegenboeken zou de fout verdubbelen in plaats van hem
--     te herstellen, en zou het bewijs dat er iets mis is uitwissen.
--   • Een automatische hercorrectie. Deze functie boekt tegen, meer niet. De
--     juiste nieuwe boeking is een aparte, bewuste handeling.
--
-- DATUM
-- De boekingsdatum van de tegenboeking is een boekhoudkundige keuze en kan
-- niet uit opgeslagen gegevens worden afgeleid — daarom is zij het enige
-- inhoudelijke argument van de functie. Zij wordt streng gecontroleerd en
-- NOOIT stilzwijgend verschoven: valt zij in een afgesloten boekjaar, dan
-- weigert de functie. Er is geen terugval op vandaag en geen terugval op het
-- eerstvolgende open jaar.
--
-- VOLGORDE VAN TOEPASSEN
-- 6C-b2 → 6C-b2a → 6C-b3 → 6C-b4 → 6C-b5a → 6C-b5b → 6C-b6 → 6C-b8 →
-- 20260920130000 → deze migratie. De prerequisite-guard hieronder weigert te
-- draaien als de fundering ontbreekt.
--
-- LEESCONTROLE VOORAF (read-only, vóór toepassen in de Lovable Cloud SQL
-- editor van project alxlbdhpbwlehbdbfejw):
--
--   -- (a) de CHECK hieronder moet nu al gelden; verwacht: 0
--   SELECT count(*) AS rijen_met_reversal_buiten_bronsoort
--   FROM public.ledger_postings
--   WHERE reversal_of_posting_id IS NOT NULL AND source_type <> 'reversal';
--
--   -- (b) er mag nog geen tegenboeking bestaan; verwacht: 0
--   SELECT count(*) AS bestaande_reversal_regels
--   FROM public.ledger_postings WHERE source_type = 'reversal';
--
--   -- (c) de fundering moet er zijn; verwacht: alle vier gevuld
--   SELECT to_regclass('public.ledger_postings')            AS grootboek,
--          to_regprocedure('public.lock_ledger_client(uuid)')    AS clientgrendel,
--          to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)') AS rekeningcontrole,
--          to_regprocedure('public.has_min_role(uuid,uuid,public.app_role)') AS rolladder;
--
-- CONTROLE ACHTERAF:
--   SELECT to_regclass('public.ledger_reversal_postings') AS marker,
--          (SELECT count(*) FROM pg_proc
--            WHERE proname IN ('reverse_posting_group','enforce_reversal_source_claim')) AS routines,
--          (SELECT count(*) FROM pg_trigger
--            WHERE tgname = 'validate_reversal_source_claim_trigger') AS claimtrigger;
--
-- rollback — UITSLUITEND geldig zolang er nog geen tegenboeking is geboekt.
-- ledger_postings is append-only: na een tegenboeking zouden de
-- grootboekregels naar een marker wijzen die niet meer bestaat. Controleer
-- eerst query (b) hierboven; die moet 0 teruggeven.
--   DROP TRIGGER IF EXISTS validate_reversal_source_claim_trigger ON public.ledger_postings;
--   DROP FUNCTION IF EXISTS public.enforce_reversal_source_claim();
--   DROP FUNCTION IF EXISTS public.reverse_posting_group(uuid, date, text);
--   DROP INDEX IF EXISTS public.idx_ledger_postings_reversal_of_posting;
--   ALTER TABLE public.ledger_postings DROP CONSTRAINT IF EXISTS ledger_postings_reversal_source_type_check;
--   DROP TABLE IF EXISTS public.ledger_reversal_postings;
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) Prerequisite guard
--
--    plpgsql valideert tabelverwijzingen niet bij CREATE FUNCTION, dus zonder
--    deze guard zou dit bestand schoon toepassen op een database zonder
--    fundering en pas bij het eerste gebruik omvallen.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.ledger_postings') IS NULL THEN
    RAISE EXCEPTION 'Vereist: public.ledger_postings (6C-b2, 20260914120000)';
  END IF;
  IF to_regprocedure('public.posting_account_ok(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Vereist: public.posting_account_ok(uuid,uuid,uuid) (6C-b2)';
  END IF;
  IF to_regprocedure('public.posting_client_org_ok(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Vereist: public.posting_client_org_ok(uuid,uuid) (6C-b2)';
  END IF;
  IF to_regprocedure('public.lock_ledger_client(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Vereist: public.lock_ledger_client(uuid) (6C-b8, 20260919120000)';
  END IF;
  IF to_regprocedure('public.has_min_role(uuid,uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'Vereist: public.has_min_role(uuid,uuid,app_role)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients'
      AND column_name = 'afgesloten_boekjaar'
  ) THEN
    RAISE EXCEPTION 'Vereist: public.clients.afgesloten_boekjaar';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) reversal_of_posting_id hoort bij bronsoort 'reversal' — en nergens anders
--
--    De kolom bestaat sinds de fundering en werd door geen enkele schrijver
--    gevuld. Memoriaal en beginbalans weigeren hem al in hun eigen
--    claimtrigger; inkoop, verkoop en bank doen dat niet, omdat die triggers
--    ouder zijn dan die afspraak. Eén CHECK maakt de regel universeel en
--    onafhankelijk van welke trigger er toevallig meekijkt: staat er een
--    tegenboekingsverwijzing op een rij, dan is die rij een tegenboeking.
--
--    Dit verandert niets aan de bestaande schrijvers: geen van hen zet de
--    kolom ooit. De leescontrole (a) in de header bewijst dat er ook geen
--    bestaande rij is die de CHECK zou schenden.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'c' AND n.nspname = 'public'
      AND t.relname = 'ledger_postings'
      AND c.conname = 'ledger_postings_reversal_source_type_check'
  ) THEN
    ALTER TABLE public.ledger_postings
      ADD CONSTRAINT ledger_postings_reversal_source_type_check
      CHECK (reversal_of_posting_id IS NULL OR source_type = 'reversal');
  END IF;
END
$$;

-- Eén originele grootboekregel wordt hoogstens één keer tegengeboekt — ooit,
-- door wie dan ook, in welke groep dan ook. Dit is de regel-op-regel-kant van
-- de idempotentie; de PRIMARY KEY van de marker is de groep-op-groep-kant.
--
-- Waarom een GLOBALE unieke index en niet (posting_group_id, reversal_of_…):
-- de laatste zou twee tegenboekingen van dezelfde regel in twee verschillende
-- groepen toestaan. De markerlaag sluit dat ook af, maar deze index sluit het
-- af zonder van de markerlaag af te hangen — en dat is precies het punt van
-- verdediging in de diepte. Partieel op de bronsoort, zodat hij niets kost
-- voor de vijf bestaande schrijvers, die de kolom altijd op NULL laten.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_postings_reversal_of_posting
  ON public.ledger_postings (reversal_of_posting_id)
  WHERE source_type = 'reversal';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) De claim/audit-marker
--
--    original_posting_group_id is de PRIMARY KEY. Dat ene feit IS de
--    idempotentiegarantie: een tweede tegenboeking van dezelfde groep kan niet
--    bestaan, en twee gelijktijdige aanroepen serialiseren op deze sleutel —
--    geen "SELECT dan INSERT" in de applicatie, geen race.
--
--    reversal_posting_group_id is UNIQUE: één tegenboeking ↔ één groep.
--
--    GEEN FOREIGN KEY naar ledger_postings. Dat is geen nalatigheid: een
--    boekingsgroep heeft daar geen eigen rij en geen unieke sleutel op
--    posting_group_id alleen (de unieke sleutel is (posting_group_id, line_no)),
--    dus er is niets om naar te verwijzen. De claimtrigger in sectie 4 is wat
--    marker en grootboekregels aan elkaar bindt.
--
--    De marker bewaart daarnaast wat er geclaimd is — datum, boekjaar,
--    regelaantal en boekingstotaal van zowel het origineel als de
--    tegenboeking — zodat het auditspoor leesbaar blijft zonder de
--    grootboekregels opnieuw te aggregeren, en zodat de claimtrigger de vorm
--    van de groep kan vastpinnen.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ledger_reversal_postings (
  original_posting_group_id uuid          PRIMARY KEY,
  reversal_posting_group_id uuid          NOT NULL UNIQUE,

  organization_id           uuid          NOT NULL,
  client_id                 uuid          NOT NULL,

  -- Het origineel, zoals het op het moment van tegenboeken vastlag.
  original_posting_date     date          NOT NULL,
  original_boekjaar         integer       NOT NULL
                                          CONSTRAINT ledger_reversal_postings_original_boekjaar_check
                                          CHECK (original_boekjaar BETWEEN 2000 AND 2100),
  original_source_type      text          NOT NULL
                                          CONSTRAINT ledger_reversal_postings_original_source_type_check
                                          -- Vorm zoals ledger_postings.source_type, plus één
                                          -- waarde die hier nooit mag staan: een tegenboeking
                                          -- van een tegenboeking is geen applicatieafspraak
                                          -- maar een database-invariant.
                                          CHECK (btrim(original_source_type) <> ''
                                                 AND original_source_type ~ '^[a-z][a-z0-9_]*$'
                                                 AND original_source_type <> 'reversal'),

  -- De tegenboeking zelf.
  posting_date              date          NOT NULL,
  boekjaar                  integer       NOT NULL
                                          CONSTRAINT ledger_reversal_postings_boekjaar_check
                                          CHECK (boekjaar BETWEEN 2000 AND 2100),
  line_count                integer       NOT NULL
                                          CONSTRAINT ledger_reversal_postings_line_count_check
                                          CHECK (line_count >= 2),
  total_amount              numeric(12,2) NOT NULL
                                          CONSTRAINT ledger_reversal_postings_total_amount_check
                                          CHECK (total_amount > 0 AND total_amount <> 'NaN'::numeric),
  currency                  text          NOT NULL
                                          CONSTRAINT ledger_reversal_postings_currency_check
                                          CHECK (currency ~ '^[A-Z]{3}$'),

  -- Vrije toelichting van de opsteller. Optioneel, begrensd, en nooit een
  -- boekhoudkundig gegeven: er wordt niets uit afgeleid.
  reason                    text          NULL
                                          CONSTRAINT ledger_reversal_postings_reason_check
                                          CHECK (reason IS NULL
                                                 OR (btrim(reason) <> '' AND length(reason) <= 500)),

  user_id                   uuid          NOT NULL,
  created_at                timestamptz   NOT NULL DEFAULT now(),

  -- Een groep kan nooit zichzelf tegenboeken.
  CONSTRAINT ledger_reversal_postings_distinct_groups_check
    CHECK (reversal_posting_group_id <> original_posting_group_id),

  -- De tegenboeking kan niet vóór het origineel liggen.
  CONSTRAINT ledger_reversal_postings_date_order_check
    CHECK (posting_date >= original_posting_date)
);

-- RESTRICT overal: deze rij is het auditspoor dat verklaart waarom er
-- onuitwisbare grootboekregels bestaan. Zij mag er nooit onderuit worden
-- gecascadeerd.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'ledger_reversal_postings'
      AND c.conname = 'ledger_reversal_postings_organization_id_fkey'
  ) THEN
    ALTER TABLE public.ledger_reversal_postings
      ADD CONSTRAINT ledger_reversal_postings_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'ledger_reversal_postings'
      AND c.conname = 'ledger_reversal_postings_client_id_fkey'
  ) THEN
    ALTER TABLE public.ledger_reversal_postings
      ADD CONSTRAINT ledger_reversal_postings_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'ledger_reversal_postings'
      AND c.conname = 'ledger_reversal_postings_user_id_fkey'
  ) THEN
    ALTER TABLE public.ledger_reversal_postings
      ADD CONSTRAINT ledger_reversal_postings_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_ledger_reversal_postings_organization
  ON public.ledger_reversal_postings (organization_id);

CREATE INDEX IF NOT EXISTS idx_ledger_reversal_postings_client
  ON public.ledger_reversal_postings (client_id);

CREATE INDEX IF NOT EXISTS idx_ledger_reversal_postings_user_id
  ON public.ledger_reversal_postings (user_id);

-- Markerrechten: alleen lezen voor de applicatie, schrijven uitsluitend door de
-- RPC. Een client die de marker zelf kon schrijven, kon een claim verzinnen (en
-- daarmee een legitieme tegenboeking voor altijd blokkeren) of er een
-- verwijderen (en daarmee een dubbele tegenboeking mogelijk maken). REVOKE ALL
-- gevolgd door GRANT SELECT, geen opsomming: geen toekomstig default privilege
-- glipt er dan langs.
ALTER TABLE public.ledger_reversal_postings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_ledger_reversal_postings_select ON public.ledger_reversal_postings;
CREATE POLICY role_ledger_reversal_postings_select ON public.ledger_reversal_postings
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

REVOKE ALL ON public.ledger_reversal_postings FROM anon, authenticated, service_role;
GRANT SELECT ON public.ledger_reversal_postings TO authenticated, service_role;

COMMENT ON TABLE public.ledger_reversal_postings IS
'Claim-registratie van tegenboekingen: bewijst dat één boekingsgroep precies één keer is tegengeboekt. De primary key op original_posting_group_id ís die garantie; reversal_posting_group_id is uniek (één tegenboeking ↔ één groep). Alleen public.reverse_posting_group() schrijft hier; applicatierollen mogen uitsluitend lezen.';

COMMENT ON COLUMN public.ledger_reversal_postings.reason IS
'Vrije toelichting van de opsteller, optioneel en hoogstens 500 tekens. Puur documentatie: er wordt geen enkel boekhoudkundig gevolg uit afgeleid.';

COMMENT ON COLUMN public.ledger_reversal_postings.original_source_type IS
'De bronsoort van de tegengeboekte groep, vastgelegd op het moment van tegenboeken, zodat het auditspoor leesbaar blijft zonder de grootboekregels opnieuw te lezen.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) De schrijver
--
--    ARGUMENTEN — en waarom er drie zijn in plaats van één
--    De vijf bestaande schrijvers nemen precies één id, omdat alles wat zij
--    boeken uit opgeslagen brongegevens volgt. Hier volgt bijna alles ook uit
--    opgeslagen gegevens — bedragen, zijden, rekeningen, valuta, organisatie,
--    administratie en herkomst komen allemaal uit de reeds vastgelegde
--    grootboekregels — op één ding na: de boekingsdatum van de tegenboeking.
--    Die is een boekhoudkundige beslissing (in welke periode landt de
--    correctie) en staat nergens opgeslagen. Hem afleiden zou betekenen: raden.
--    Daarom is hij een expliciet argument, en daarom wordt hij streng
--    gecontroleerd in plaats van stilzwijgend bijgesteld.
--
--    _reason is documentatie en beïnvloedt geen enkel bedrag.
--
--    GRENDELVOLGORDE (de volgorde van 6C-b8, ongewijzigd)
--      administratiegrendel (lock_ledger_client)
--        → boekingsgroep-grendel (trigger van 6C-b2, bij de eerste INSERT)
--          → markerclaim
--            → grootboekregels
--    De administratiegrendel wordt hier expliciet als eerste genomen, precies
--    zoals post_opening_balance() dat doet, zodat deze schrijver in dezelfde
--    volgorde grendelt als elke andere schrijfweg naar het grootboek. De
--    trigger op ledger_postings neemt hem straks nog eens; een advisory lock is
--    her-intreedbaar, dus dat kost niets.
--
--    GEEN RIJGRENDEL OP HET ORIGINEEL, EN DAT IS GEEN OMISSIE
--    ledger_postings is append-only en elke groep is verzegeld aan de
--    transactie die haar maakte (created_xact_id, 6C-b2). Een gecommitte groep
--    kan dus niet meer veranderen, niet worden uitgebreid en niet worden
--    verwijderd. Er is geen "mutatie versus boeking"-race om te grendelen. De
--    enige race die bestaat is twee gelijktijdige tegenboekingen van dezelfde
--    groep, en die wordt gearbitreerd door de primary key van de marker.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reverse_posting_group(
  _posting_group_id uuid,
  _posting_date     date,
  _reason           text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_client        public.clients%ROWTYPE;
  v_new_group     uuid := gen_random_uuid();
  v_reason        text;
  v_boekjaar      integer;

  -- Aggregaat over het origineel.
  v_rows          integer;
  v_orgs          integer;
  v_clients       integer;
  v_currencies    integer;
  v_dates         integer;
  v_boekjaren     integer;
  v_sources       integer;
  v_xacts         integer;
  v_bad_sides     integer;
  v_negative      integer;
  v_nan           integer;
  v_own_xact      integer;
  v_sum_debit     numeric;
  v_sum_credit    numeric;

  v_org           uuid;
  v_client_id     uuid;
  v_currency      text;
  v_orig_date     date;
  v_orig_boekjaar integer;
  v_orig_source   text;
  v_scope_bad     integer;

  v_line_no       integer := 0;
  v_row           record;
BEGIN
  -- (1) Authenticatie eerst: voor een anonieme aanroep wordt niets gelezen en
  --     niets gegrendeld.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- (2) Isolatiecontract. 6C-b2 weigert een grootboek-INSERT buiten READ
  --     COMMITTED; hier vroeg gecontroleerd, zodat de aanroeper de echte reden
  --     krijgt in plaats van een triggerfout halverwege.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een tegenboeking kan alleen in een READ COMMITTED transactie (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  IF _posting_group_id IS NULL THEN
    RAISE EXCEPTION 'Geen boekingsgroep opgegeven' USING ERRCODE = '22004';
  END IF;

  IF _posting_date IS NULL THEN
    RAISE EXCEPTION 'Een tegenboeking heeft een boekingsdatum nodig' USING ERRCODE = '22004';
  END IF;

  -- (3) De toelichting normaliseren vóór elke controle: whitespace-only is
  --     geen toelichting. btrim() alleen trimt spaties, dus expliciet ook tab,
  --     CR en LF.
  v_reason := NULLIF(btrim(COALESCE(_reason, ''), E' \t\r\n'), '');
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RAISE EXCEPTION 'De toelichting is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;

  -- (4) Datumbereik, gelijk aan de CHECK op boekjaar in ledger_postings.
  IF _posting_date < DATE '2000-01-01' OR _posting_date > DATE '2100-12-31' THEN
    RAISE EXCEPTION 'Boekingsdatum % valt buiten het ondersteunde bereik 2000-2100', _posting_date
      USING ERRCODE = '22023';
  END IF;
  v_boekjaar := EXTRACT(YEAR FROM _posting_date)::integer;

  -- (5) De administratie van de groep opzoeken, nog zonder grendel — alleen om
  --     te weten wélke administratiegrendel genomen moet worden.
  SELECT DISTINCT lp.client_id INTO v_client_id
  FROM public.ledger_postings lp
  WHERE lp.posting_group_id = _posting_group_id
  LIMIT 1;

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Boekingsgroep niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- (6) GRENDEL 0 — de administratie. Dezelfde grendel die elke grootboekregel
  --     via de trigger van 6C-b8 neemt, en die post_opening_balance() als
  --     eerste neemt. Hiermee grendelt deze schrijver in exact dezelfde
  --     volgorde als elke andere schrijfweg.
  PERFORM public.lock_ledger_client(v_client_id);

  -- (7) Het origineel opnieuw lezen ONDER de grendel, als één aggregaat. Een
  --     gecommitte groep verandert niet meer (append-only + zegel), dus dit is
  --     de volledige, definitieve vorm van het origineel.
  SELECT COUNT(*),
         COUNT(DISTINCT lp.organization_id),
         COUNT(DISTINCT lp.client_id),
         COUNT(DISTINCT lp.currency),
         COUNT(DISTINCT lp.posting_date),
         COUNT(DISTINCT lp.boekjaar),
         COUNT(DISTINCT lp.source_type),
         COUNT(DISTINCT lp.created_xact_id),
         COUNT(*) FILTER (WHERE NOT ((lp.debit_amount  > 0 AND lp.credit_amount = 0)
                                  OR (lp.credit_amount > 0 AND lp.debit_amount  = 0))),
         COUNT(*) FILTER (WHERE lp.debit_amount < 0 OR lp.credit_amount < 0),
         COUNT(*) FILTER (WHERE lp.debit_amount = 'NaN'::numeric OR lp.credit_amount = 'NaN'::numeric),
         -- _if_assigned(): dwingt geen transactie-id af (dat zou in een
         -- read-only transactie een onbegrijpelijke fout geven) en levert NULL
         -- zolang deze transactie nog niets heeft geschreven — dan is de groep
         -- per definitie niet van ons en telt de filter terecht niets.
         COUNT(*) FILTER (WHERE lp.created_xact_id = pg_current_xact_id_if_assigned()),
         COALESCE(SUM(lp.debit_amount), 0),
         COALESCE(SUM(lp.credit_amount), 0),
         -- Via text, want PostgreSQL kent geen min(uuid). De DISTINCT-tellingen
         -- hierboven bewijzen dat er hoogstens één waarde is, dus welke
         -- aggregaat het ook is: hij is de enige.
         MIN(lp.organization_id::text)::uuid,
         MIN(lp.client_id::text)::uuid,
         MIN(lp.currency),
         MIN(lp.posting_date),
         MIN(lp.boekjaar),
         MIN(lp.source_type)
    INTO v_rows, v_orgs, v_clients, v_currencies, v_dates, v_boekjaren, v_sources,
         v_xacts, v_bad_sides, v_negative, v_nan, v_own_xact, v_sum_debit, v_sum_credit,
         v_org, v_client_id, v_currency, v_orig_date, v_orig_boekjaar, v_orig_source
  FROM public.ledger_postings lp
  WHERE lp.posting_group_id = _posting_group_id;

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Boekingsgroep niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- (8) Tenant en rol, allebei uit opgeslagen gegevens. ROLVLOER = accountant.
  --     De rolcontrole komt vóór elk verder inhoudelijk oordeel, zodat een
  --     aanroeper zonder rechten niets leert over de inhoud van de groep.
  IF v_orgs > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat regels van meerdere organisaties en kan niet worden tegengeboekt'
      USING ERRCODE = '23514';
  END IF;

  IF v_org IS NULL OR NOT public.has_min_role(v_uid, v_org, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om een tegenboeking te maken voor deze organisatie (accountant vereist)'
      USING ERRCODE = '42501';
  END IF;

  -- (9) De administratie moet bij de organisatie van de groep horen. Dit is de
  --     tenantcontrole: een groep van een andere organisatie is voor deze
  --     aanroeper onbereikbaar, want (8) heeft de rol al op díe organisatie
  --     getoetst.
  IF v_clients > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat regels van meerdere administraties en kan niet worden tegengeboekt'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_client FROM public.clients WHERE id = v_client_id;
  IF NOT FOUND OR v_client.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Administratie hoort niet bij de organisatie van deze boekingsgroep'
      USING ERRCODE = '42501';
  END IF;

  -- (10) Lineage: één stap diep. Een tegenboeking van een tegenboeking maakt de
  --      geschiedenis onleesbaar en lost niets op — is de tegenboeking zelf
  --      fout, dan is de juiste weg een nieuwe, correcte boeking.
  IF v_sources > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat meerdere bronsoorten en is niet als één feit te lezen'
      USING ERRCODE = '23514';
  END IF;

  IF v_orig_source = 'reversal' THEN
    RAISE EXCEPTION 'Deze boekingsgroep is zelf een tegenboeking; een tegenboeking van een tegenboeking wordt niet ondersteund. Boek in plaats daarvan de juiste boeking opnieuw.'
      USING ERRCODE = '22023';
  END IF;

  -- (11) Beginbalans: bewust geweigerd, met de reden erbij. Zie de header — het
  --      is niet de boeking die onmogelijk is, het is de toestand waarin de
  --      administratie daarna zou achterblijven.
  IF v_orig_source = 'opening_balance' THEN
    RAISE EXCEPTION 'Een geboekte beginbalans kan niet worden tegengeboekt: deze administratie kan daarna geen nieuwe beginbalans vastleggen. Corrigeer met een memoriaalboeking.'
      USING ERRCODE = '22023';
  END IF;

  -- (12) Is deze groep al tegengeboekt? De primary key van de marker is de
  --      echte arbiter (stap 17); deze controle geeft de aanroeper alleen een
  --      begrijpelijke reden in plaats van een constraintnaam.
  IF EXISTS (
    SELECT 1 FROM public.ledger_reversal_postings r
    WHERE r.original_posting_group_id = _posting_group_id
  ) THEN
    RAISE EXCEPTION 'Deze boekingsgroep is al tegengeboekt' USING ERRCODE = '23505';
  END IF;

  -- (13) HET ORIGINEEL ALS BOEKHOUDKUNDIG FEIT. Een kapotte groep wordt NIET
  --      "hersteld" door haar tegen te boeken: dat verdubbelt de fout en wist
  --      het bewijs uit dat er iets mis is. Elke weigering noemt haar eigen
  --      reden.
  IF v_xacts > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat regels uit meerdere transacties en is niet als één boeking vastgelegd'
      USING ERRCODE = '23514';
  END IF;

  -- Een groep die in DEZE transactie is ontstaan is nog niet gecommit. Haar
  -- tegenboeken zou betekenen dat origineel en tegenboeking samen staan of
  -- samen vallen, wat geen correctie is maar een lege operatie — en het zou de
  -- marker laten wijzen naar iets wat na een rollback nooit heeft bestaan.
  IF v_own_xact > 0 THEN
    RAISE EXCEPTION 'Deze boekingsgroep is in dezelfde transactie ontstaan en kan nog niet worden tegengeboekt'
      USING ERRCODE = '22023';
  END IF;

  IF v_rows < 2 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat % regel; een boeking heeft minimaal een debet- en een creditregel', v_rows
      USING ERRCODE = '23514';
  END IF;

  IF v_currencies > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat meerdere valuta en kan niet worden tegengeboekt'
      USING ERRCODE = '23514';
  END IF;

  IF v_dates > 1 OR v_boekjaren > 1 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat meerdere boekingsdatums of boekjaren en kan niet worden tegengeboekt'
      USING ERRCODE = '23514';
  END IF;

  -- Boekjaar moet bij de boekingsdatum horen. Alle vijf de bestaande
  -- schrijvers leiden het zo af; wijkt een groep daarvan af, dan is zij niet
  -- door een schrijver gemaakt en is haar periodetoerekening niet te
  -- vertrouwen.
  IF v_orig_boekjaar <> EXTRACT(YEAR FROM v_orig_date)::integer THEN
    RAISE EXCEPTION 'Boekjaar % hoort niet bij boekingsdatum % van de oorspronkelijke boeking', v_orig_boekjaar, v_orig_date
      USING ERRCODE = '23514';
  END IF;

  -- NaN vóór de balanscontrole: NaN = NaN is TRUE in PostgreSQL, dus een
  -- groep met NaN zou anders als sluitend worden gerapporteerd.
  IF v_nan > 0 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat een bedrag dat geen getal is' USING ERRCODE = '23514';
  END IF;

  IF v_negative > 0 THEN
    RAISE EXCEPTION 'Boekingsgroep bevat een negatief bedrag' USING ERRCODE = '23514';
  END IF;

  IF v_bad_sides > 0 THEN
    RAISE EXCEPTION '% regel(s) in deze boekingsgroep staan niet op precies één zijde', v_bad_sides
      USING ERRCODE = '23514';
  END IF;

  IF v_sum_debit <= 0 OR v_sum_credit <= 0 THEN
    RAISE EXCEPTION 'Boekingsgroep heeft geen debet- én creditbedrag groter dan nul (debet %, credit %)', v_sum_debit, v_sum_credit
      USING ERRCODE = '23514';
  END IF;

  -- Exacte NUMERIC-gelijkheid, geen tolerantie.
  IF v_sum_debit <> v_sum_credit THEN
    RAISE EXCEPTION 'Boekingsgroep is niet in balans: debet % is ongelijk aan credit % (verschil %); een niet-sluitende boeking wordt niet tegengeboekt maar onderzocht',
      v_sum_debit, v_sum_credit, (v_sum_debit - v_sum_credit)
      USING ERRCODE = '23514';
  END IF;

  -- (14) Valuta. De vijf schrijvers boeken uitsluitend 'EUR' en de
  --      rapportagekern weigert elke andere valuta hard. Een tegenboeking
  --      neemt de valuta van het origineel over; is dat geen EUR, dan is het
  --      origineel zelf al onrapporteerbaar en wordt er niets aan toegevoegd.
  IF v_currency IS DISTINCT FROM 'EUR' THEN
    RAISE EXCEPTION 'Valuta % wordt niet ondersteund; alleen EUR', COALESCE(v_currency, '(leeg)')
      USING ERRCODE = '22023';
  END IF;

  -- (15) Rekeningen. Elke rekening van het origineel moet nog steeds bruikbaar
  --      zijn voor DEZE administratie — hetzelfde predicaat dat
  --      ledger_postings per rij afdwingt, hier vooraf gecontroleerd zodat de
  --      weigering een reden heeft in plaats van een rijfout.
  --
  --      BEWUST NIET gecontroleerd: `actief`. De vijf schrijvers weigeren een
  --      inactieve rekening, en terecht — zij beginnen iets nieuws. Een
  --      tegenboeking doet het tegenovergestelde: zij haalt weg wat er al op
  --      die rekening staat. Zou `actief` hier gelden, dan werd het
  --      deactiveren van een rekening een val waaruit een foutieve boeking
  --      nooit meer te corrigeren is.
  SELECT COUNT(*) INTO v_scope_bad
  FROM public.ledger_postings lp
  WHERE lp.posting_group_id = _posting_group_id
    AND NOT public.posting_account_ok(lp.grootboekrekening_id, v_org, v_client_id);
  IF v_scope_bad > 0 THEN
    RAISE EXCEPTION '% regel(s) verwijzen naar een grootboekrekening buiten deze organisatie of van een andere administratie', v_scope_bad
      USING ERRCODE = '23514';
  END IF;

  -- (16) De datum van de tegenboeking. Geen stilzwijgende verschuiving, geen
  --      terugval op vandaag, geen terugval op het eerstvolgende open jaar.
  IF _posting_date < v_orig_date THEN
    RAISE EXCEPTION 'Een tegenboeking van % kan niet op % worden geboekt: dat ligt vóór de oorspronkelijke boeking', v_orig_date, _posting_date
      USING ERRCODE = '22023';
  END IF;

  IF v_client.afgesloten_boekjaar IS NOT NULL AND v_boekjaar <= v_client.afgesloten_boekjaar THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten voor deze administratie', v_boekjaar
      USING ERRCODE = '22023';
  END IF;

  -- (17) De claim. De primary key op original_posting_group_id IS de
  --      idempotentiegarantie en het serialisatiepunt: een tweede
  --      gelijktijdige aanroep blokkeert hier tot wij committen en faalt dan.
  BEGIN
    INSERT INTO public.ledger_reversal_postings (
      original_posting_group_id, reversal_posting_group_id,
      organization_id, client_id,
      original_posting_date, original_boekjaar, original_source_type,
      posting_date, boekjaar, line_count, total_amount, currency,
      reason, user_id
    ) VALUES (
      _posting_group_id, v_new_group,
      v_org, v_client_id,
      v_orig_date, v_orig_boekjaar, v_orig_source,
      _posting_date, v_boekjaar, v_rows, v_sum_debit, v_currency,
      v_reason, v_uid
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Deze boekingsgroep is al tegengeboekt' USING ERRCODE = '23505';
  END;

  -- (18) Eén tegenregel per originele regel, in de vaste volgorde van het
  --      origineel. Debet en credit worden verwisseld; rekening, valuta,
  --      organisatie en administratie blijven exact wat zij waren.
  --
  --      Er wordt NIET gegroepeerd per rekening: een groep mag meerdere regels
  --      op dezelfde rekening dragen, en die blijven ook in de tegenboeking
  --      afzonderlijke regels — anders zou de regel-op-regel-lineage niet meer
  --      kloppen en zou het regelaantal van de marker niet meer overeenkomen.
  FOR v_row IN
    SELECT lp.id, lp.grootboekrekening_id, lp.debit_amount, lp.credit_amount,
           lp.currency, lp.description
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = _posting_group_id
    ORDER BY lp.line_no, lp.id
  LOOP
    v_line_no := v_line_no + 1;
    INSERT INTO public.ledger_postings (
      organization_id, client_id, grootboekrekening_id, posting_group_id, line_no,
      posting_date, boekjaar, debit_amount, credit_amount, currency,
      description, source_type, source_id, source_line_id,
      reversal_of_posting_id, user_id
    ) VALUES (
      v_org, v_client_id, v_row.grootboekrekening_id, v_new_group, v_line_no,
      _posting_date, v_boekjaar,
      -- De hele tegenboeking, in twee waarden.
      v_row.credit_amount, v_row.debit_amount,
      v_row.currency,
      'Tegenboeking: ' || COALESCE(v_reason,
                                   NULLIF(btrim(COALESCE(v_row.description, ''), E' \t\r\n'), ''),
                                   to_char(v_orig_date, 'DD-MM-YYYY')),
      'reversal', _posting_group_id,
      -- source_line_id blijft NULL: de regel-op-regel-verwijzing staat in
      -- reversal_of_posting_id, en twee kolommen met hetzelfde feit zijn twee
      -- kolommen die uit elkaar kunnen lopen.
      NULL,
      v_row.id, v_uid
    );
  END LOOP;

  RETURN v_new_group;
END
$$;

-- Aanroepbaar door de app, nooit door anon, nooit door service_role, nooit door
-- PUBLIC. Elke applicatierol wordt expliciet genoemd: een grant die een
-- platformdefault rechtstreeks aan anon of service_role geeft, overleeft een
-- REVOKE die alleen PUBLIC noemt. service_role krijgt bewust geen EXECUTE —
-- geen enkele edge function boekt tegen, en dat blijft een aparte, apart
-- beoordeelde beslissing.
REVOKE ALL ON FUNCTION public.reverse_posting_group(uuid, date, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverse_posting_group(uuid, date, text) TO authenticated;

COMMENT ON FUNCTION public.reverse_posting_group(uuid, date, text) IS
'Boekt één bestaande boekingsgroep tegen als een NIEUWE, sluitende boekingsgroep in ledger_postings: één tegenregel per originele regel, met debet en credit verwisseld en met rekening, valuta, organisatie en administratie exact overgenomen. Elke tegenregel verwijst via reversal_of_posting_id naar de exacte originele grootboekregel; de groep-op-groep-lineage staat in ledger_reversal_postings, waarvan de primary key garandeert dat één groep hoogstens één keer wordt tegengeboekt. Vereist de rol accountant. Het origineel blijft ongewijzigd. Weigert een onbekende groep, een groep van een andere organisatie of administratie, een groep die zelf een tegenboeking is, een geboekte beginbalans, een reeds tegengeboekte groep, een kapotte of niet-sluitende groep, een andere valuta dan EUR, een datum vóór het origineel en een afgesloten boekjaar — zonder de datum ooit stilzwijgend te verschuiven.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) De claimtrigger — verdediging in de diepte
--
--    De RPC is de enige weg naar een tegenboeking, maar de juistheid van een
--    grootboekregel mag niet van de juistheid van één functie afhangen. Deze
--    trigger controleert elke rij met source_type = 'reversal' tegen de marker
--    én tegen de originele regel waarnaar zij verwijst, en doet dat op elk
--    DML-pad — ook op paden die geen enkele RPC passeren.
--
--    Integriteit, geen autorisatie: geen auth.uid(), geen has_min_role(). Dit
--    moet ook gelden voor onderhouds- en herstelpaden waar auth.uid() terecht
--    NULL is (patterns §5B).
--
--    De naam begint met "validate_", zodat hij ná set_organization_id_trigger
--    vuurt en organization_id al is afgeleid wanneer hij wordt vergeleken.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_reversal_source_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marker public.ledger_reversal_postings%ROWTYPE;
  v_orig   public.ledger_postings%ROWTYPE;
BEGIN
  IF NEW.source_type <> 'reversal' THEN
    RETURN NEW;
  END IF;

  IF NEW.source_id IS NULL THEN
    RAISE EXCEPTION 'Een tegenboekingsregel moet naar de tegengeboekte boekingsgroep verwijzen'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_marker
  FROM public.ledger_reversal_postings
  WHERE original_posting_group_id = NEW.source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deze tegenboeking is niet via reverse_posting_group() gemaakt; losse grootboekregels zijn niet toegestaan'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.posting_group_id <> v_marker.reversal_posting_group_id THEN
    RAISE EXCEPTION 'Een tegenboeking kan maar één boekingsgroep hebben; deze regel hoort niet bij de geclaimde groep'
      USING ERRCODE = '23505';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_marker.organization_id
     OR NEW.client_id IS DISTINCT FROM v_marker.client_id THEN
    RAISE EXCEPTION 'Organisatie of administratie van deze regel wijkt af van de geclaimde tegenboeking'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.posting_date <> v_marker.posting_date OR NEW.boekjaar <> v_marker.boekjaar THEN
    RAISE EXCEPTION 'Boekingsdatum of boekjaar van deze regel wijkt af van de geclaimde tegenboeking'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.currency IS DISTINCT FROM v_marker.currency THEN
    RAISE EXCEPTION 'Valuta van deze regel wijkt af van de geclaimde tegenboeking' USING ERRCODE = '23514';
  END IF;

  IF NEW.line_no < 1 OR NEW.line_no > v_marker.line_count THEN
    RAISE EXCEPTION 'Een tegenboeking van % regels heeft geen regel %', v_marker.line_count, NEW.line_no
      USING ERRCODE = '23514';
  END IF;

  -- user_id: de tegenboeking is één handeling van één persoon. Een regel op
  -- naam van iemand anders binnen dezelfde claim zou het auditspoor breken.
  IF NEW.user_id IS DISTINCT FROM v_marker.user_id THEN
    RAISE EXCEPTION 'Gebruiker van deze regel wijkt af van de geclaimde tegenboeking' USING ERRCODE = '23514';
  END IF;

  -- source_line_id hoort hier NULL te zijn: de regel-op-regel-verwijzing staat
  -- in reversal_of_posting_id en nergens anders.
  IF NEW.source_line_id IS NOT NULL THEN
    RAISE EXCEPTION 'Een tegenboekingsregel gebruikt reversal_of_posting_id, niet source_line_id'
      USING ERRCODE = '23514';
  END IF;

  -- ── De kern: deze regel negeert precies één bestaande regel ────────────────
  IF NEW.reversal_of_posting_id IS NULL THEN
    RAISE EXCEPTION 'Een tegenboekingsregel moet naar de tegengeboekte grootboekregel verwijzen'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_orig
  FROM public.ledger_postings
  WHERE id = NEW.reversal_of_posting_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'De tegengeboekte grootboekregel bestaat niet' USING ERRCODE = '23514';
  END IF;

  IF v_orig.posting_group_id <> v_marker.original_posting_group_id THEN
    RAISE EXCEPTION 'De tegengeboekte grootboekregel hoort niet bij de geclaimde oorspronkelijke boekingsgroep'
      USING ERRCODE = '23514';
  END IF;

  IF v_orig.organization_id IS DISTINCT FROM NEW.organization_id
     OR v_orig.client_id IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'De tegengeboekte grootboekregel hoort bij een andere organisatie of administratie'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.grootboekrekening_id IS DISTINCT FROM v_orig.grootboekrekening_id THEN
    RAISE EXCEPTION 'Een tegenboeking boekt op dezelfde grootboekrekening als het origineel'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.currency IS DISTINCT FROM v_orig.currency THEN
    RAISE EXCEPTION 'Een tegenboeking gebruikt dezelfde valuta als het origineel' USING ERRCODE = '23514';
  END IF;

  -- IS DISTINCT FROM, niet <>: met een NULL aan één kant zou <> NULL opleveren
  -- en de rij doorlaten. Dit is de guard wiens hele taak fail-closed is.
  IF NEW.debit_amount IS DISTINCT FROM v_orig.credit_amount
     OR NEW.credit_amount IS DISTINCT FROM v_orig.debit_amount THEN
    RAISE EXCEPTION 'Een tegenboeking verwisselt debet en credit exact: verwacht debet % en credit %, gekregen debet % en credit %',
      v_orig.credit_amount, v_orig.debit_amount, NEW.debit_amount, NEW.credit_amount
      USING ERRCODE = '23514';
  END IF;

  -- Dezelfde originele regel twee keer tegenboeken wordt geweigerd door
  -- idx_ledger_postings_reversal_of_posting. Die index ziet, anders dan deze
  -- trigger, ook een zusterrij die eerder in DEZELFDE transactie is ingevoegd.

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_reversal_source_claim() FROM PUBLIC;

DROP TRIGGER IF EXISTS validate_reversal_source_claim_trigger ON public.ledger_postings;
CREATE TRIGGER validate_reversal_source_claim_trigger
  BEFORE INSERT ON public.ledger_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_reversal_source_claim();

COMMENT ON FUNCTION public.enforce_reversal_source_claim() IS
'Bewaakt dat elke grootboekregel met source_type=reversal exact overeenkomt met de claim in ledger_reversal_postings én met de originele grootboekregel waarnaar zij verwijst: dezelfde rekening, dezelfde valuta, debet en credit verwisseld, dezelfde organisatie en administratie, en binnen het regelaantal van de claim. Sluit een tweede boekingsgroep, een regel zonder claim, een regel zonder verwijzing en een verwijzing naar een regel van een andere groep uit.';

COMMENT ON INDEX public.idx_ledger_postings_reversal_of_posting IS
'Eén originele grootboekregel wordt hoogstens één keer tegengeboekt. Partieel op source_type=reversal, dus zonder kosten voor de vijf bestaande schrijvers, die reversal_of_posting_id altijd op NULL laten.';
