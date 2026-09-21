-- ═════════════════════════════════════════════════════════════════════════════
-- 6C-b10 — DE JAARAFSLUITING (v1)
--
-- WAT DEZE MIGRATIE WEL DOET
--   1. public.year_closures            — het onuitwisbare afsluitbewijs
--   2. public.close_fiscal_year()      — de enige schrijver van het watermerk
--   3. een grendel op clients.afgesloten_boekjaar, zodat het watermerk niet
--      meer buiten die schrijver om kan bewegen
--
-- WAT DEZE MIGRATIE NADRUKKELIJK NIET DOET — EN WAAROM
--
--   GEEN RESULTAATBOEKING. De balans draagt het resultaat vandaag al, en niet
--   als boeking maar als PRESENTATIEREGEL: src/lib/financial-statements.ts
--   bouwt twee synthetische regels, `prior_years_result` (= de cumulatieve
--   W&V-stand vóór de periode) en `current_year_result` (= de W&V-mutatie ín de
--   periode), en de balansidentiteit sluit juist dankzij die twee. Een echte
--   resultaatboeking zou dat kapotmaken, en wel aantoonbaar:
--
--     • gedateerd ÍN jaar N valt zij zelf in de W&V-mutatie van jaar N — de
--       rapportagekern filtert op datum en `boekjaar` filtert nooit — en maakt
--       het gerapporteerde resultaat van het afgesloten jaar dus nul;
--     • gedateerd in N+1 tussen twee balansrekeningen telt zij dubbel: de
--       W&V-rekeningen houden hun saldo, `prior_years_result` blijft ze
--       presenteren, en het eigen vermogen draagt het resultaat nu óók.
--
--   GEEN DOORROL. De kern leidt `openingCents` af als Σ(debet − credit) vóór
--   de periodegrens. De openingspositie van N+1 ís per definitie het
--   cumulatieve grootboek; er valt niets door te rollen wat er niet al staat.
--   Een doorrolboeking zou bestaande feiten verdubbelen.
--
--   GEEN result_cents IN DE MARKER. Zie sectie 1.
--
--   GEEN HEROPENING. Er is in v1 geen weg terug: geen reopen-RPC, geen
--   markermutatie, geen watermerkverlaging. Een correctie hoort in een later,
--   nog open boekjaar.
--
-- ROLLBACK (handmatig, in deze volgorde):
--   DROP TRIGGER IF EXISTS enforce_year_close_watermark_trigger ON public.clients;
--   DROP FUNCTION IF EXISTS public.enforce_year_close_watermark();
--   DROP FUNCTION IF EXISTS public.close_fiscal_year(uuid, integer);
--   DROP TRIGGER IF EXISTS prevent_year_closure_truncate_trigger ON public.year_closures;
--   DROP TRIGGER IF EXISTS prevent_year_closure_mutation_trigger ON public.year_closures;
--   DROP FUNCTION IF EXISTS public.prevent_year_closure_mutation();
--   DROP TRIGGER IF EXISTS enforce_year_closure_org_trigger ON public.year_closures;
--   DROP FUNCTION IF EXISTS public.enforce_year_closure_org();
--   DROP TABLE IF EXISTS public.year_closures;
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) Voorwaarden
--
--    Deze migratie leunt op 6C-b2 (grootboekfundering), 6C-b8 (de
--    administratiegrendel) en de rolladder. Ontbreekt er één, dan hoort dat een
--    duidelijke fout te zijn in plaats van een halfaangelegd afsluitmechanisme.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.ledger_postings') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b10 vereist eerst public.ledger_postings (6C-b2)';
  END IF;
  IF to_regproc('public.has_min_role') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b10 vereist eerst public.has_min_role()';
  END IF;
  IF to_regproc('public.posting_client_org_ok') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b10 vereist eerst public.posting_client_org_ok() (6C-b2)';
  END IF;
  IF to_regproc('public.lock_ledger_client') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b10 vereist eerst public.lock_ledger_client() (6C-b8)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'afgesloten_boekjaar'
  ) THEN
    RAISE EXCEPTION 'Migratie 6C-b10 vereist eerst clients.afgesloten_boekjaar (ontbreekt)';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Het afsluitbewijs
--
--    IDENTITEIT. (client_id, fiscal_year) is de PRIMARY KEY, en die ene sleutel
--    ís de idempotentiegarantie: een tweede afsluiting van hetzelfde jaar kan
--    niet bestaan, en twee gelijktijdige aanroepen serialiseren erop. Geen
--    "SELECT dan INSERT" in de applicatie, geen race.
--
--    GEEN result_cents — EEN BEWUSTE WEGLATING, GEEN VERGETELHEID
--    Het ontwerp vroeg om result_cents "uitsluitend als het af te leiden valt
--    uit bestaande databasewaarheid zonder een tweede boekhoudmotor te
--    bouwen". Dat kan hier niet, en wel om één aanwijsbare reden:
--    `grootboekrekeningen.statement_type` is NULLABLE (20260920120000). Een
--    rekening mag ongeclassificeerd zijn, en de rapportagemotor behandelt dat
--    geval expliciet — `unclassifiedClosingCents`, de dekkingstoets en de
--    uitkomst `coverage_mismatch`. Een simpele SQL-som over
--    `statement_type = 'winst_verlies'` zou die hele laag negeren en stilzwijgend
--    een ANDER getal opleveren dan de motor toont zodra één rekening niet
--    geclassificeerd is. Twee getallen die allebei "het resultaat" heten en van
--    elkaar afwijken, is precies de tweede boekhoudmotor die niet mocht ontstaan.
--
--    En zij is ook niet nodig. Het grootboek van een afgesloten jaar ligt vast:
--    elke schrijver weigert `boekjaar <= afgesloten_boekjaar` en de
--    tegenboekingsmotor weigert elke datum in een afgesloten jaar. Het resultaat
--    van een afgesloten jaar is dus op elk later moment exact reproduceerbaar
--    uit het grootboek zelf. Een opgeslagen momentopname zou daarentegen wél
--    verouderen zodra de classificatie later wordt gecorrigeerd — die is geen
--    grootboekgegeven en mag ook na afsluiten nog worden bijgewerkt. Weglaten
--    maakt de marker hier dus controleerbaarder, niet minder controleerbaar.
--
--    WAT ER WEL IN STAAT is precies genoeg om de afsluiting te verantwoorden:
--    welke administratie, van welke organisatie, welk jaar, wanneer en door wie.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.year_closures (
  client_id       uuid        NOT NULL,
  fiscal_year     integer     NOT NULL
                              CONSTRAINT year_closures_fiscal_year_check
                              CHECK (fiscal_year BETWEEN 2000 AND 2100),

  organization_id uuid        NOT NULL,

  closed_at       timestamptz NOT NULL DEFAULT now(),
  closed_by       uuid        NOT NULL,

  CONSTRAINT year_closures_pkey PRIMARY KEY (client_id, fiscal_year)
);

-- RESTRICT overal: deze rij verklaart waarom een boekjaar onherroepelijk dicht
-- staat. Zij mag er nooit onderuit worden gecascadeerd.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'year_closures'
      AND c.conname = 'year_closures_client_id_fkey'
  ) THEN
    ALTER TABLE public.year_closures
      ADD CONSTRAINT year_closures_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'year_closures'
      AND c.conname = 'year_closures_organization_id_fkey'
  ) THEN
    ALTER TABLE public.year_closures
      ADD CONSTRAINT year_closures_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations (id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
      AND t.relname = 'year_closures'
      AND c.conname = 'year_closures_closed_by_fkey'
  ) THEN
    ALTER TABLE public.year_closures
      ADD CONSTRAINT year_closures_closed_by_fkey
      FOREIGN KEY (closed_by) REFERENCES auth.users (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_year_closures_organization
  ON public.year_closures (organization_id);

CREATE INDEX IF NOT EXISTS idx_year_closures_closed_by
  ON public.year_closures (closed_by);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Tenantintegriteit — en waarom een FK hier niet volstaat
--
--    De twee foreign keys hierboven bewijzen dat de administratie bestaat en
--    dat de organisatie bestaat. Zij bewijzen NIET dat die administratie bij
--    díe organisatie hoort. Zonder dat zou een afsluitbewijs onder de vlag van
--    organisatie B kunnen worden weggeschreven voor een administratie van
--    organisatie A — en omdat de RLS-policy in sectie 4 op organization_id
--    leest, zou B dan een afsluiting van A kunnen zien én zou A de hare niet
--    kunnen zien. Een samengestelde FK zou hier wel kunnen maar vereist een
--    nieuwe UNIQUE (id, organization_id) op clients, en dat is geen additieve
--    wijziging aan een tabel waar de rest van het product op leunt.
--
--    De bestaande, bewezen conventie is de trigger: `enforce_ledger_posting_org`
--    (6C-b2) doet exact dit voor elke grootboekregel, via
--    `posting_client_org_ok()`. Die functie is SECURITY DEFINER en ziet dus ook
--    rijen die RLS voor de aanroeper verbergt — zonder dat zou een administratie
--    van een andere organisatie simpelweg als "bestaat niet" lezen en zou de
--    cross-tenant schrijfactie worden geaccepteerd in plaats van geweigerd.
--    Hier wordt dezelfde functie hergebruikt, niet nagebouwd.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_year_closure_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.posting_client_org_ok(NEW.client_id, NEW.organization_id) THEN
    RAISE EXCEPTION 'client_id verwijst naar een administratie buiten de organisatie van dit afsluitbewijs'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_year_closure_org() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_year_closure_org_trigger ON public.year_closures;
CREATE TRIGGER enforce_year_closure_org_trigger
  BEFORE INSERT ON public.year_closures
  FOR EACH ROW EXECUTE FUNCTION public.enforce_year_closure_org();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Onuitwisbaarheid
--
--    Hetzelfde patroon als `prevent_ledger_posting_mutation` (6C-b2), en om
--    dezelfde reden: een afsluitbewijs dat gewijzigd of verwijderd kan worden,
--    bewijst niets. Verwijderen zou bovendien direct een gat slaan in de
--    invariant van sectie 5 — watermerk vooruit, marker weg — en precies de
--    "al afgesloten maar geen bewijs"-toestand scheppen die de schrijver juist
--    fail-closed moet afhandelen.
--
--    TRUNCATE vuurt geen ROW-trigger en zou dus langs de eerste trigger glippen;
--    een STATEMENT-trigger ziet hem wel. Beide staan ENABLE ALWAYS, zodat
--    `session_replication_role = replica` ze niet stilzwijgend uitschakelt.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_year_closure_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'year_closures is append-only: % is niet toegestaan. Een afgesloten boekjaar wordt niet heropend; corrigeer in een later, nog open boekjaar.', TG_OP
    USING ERRCODE = '42501';
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.prevent_year_closure_mutation() FROM PUBLIC;

DROP TRIGGER IF EXISTS prevent_year_closure_mutation_trigger ON public.year_closures;
CREATE TRIGGER prevent_year_closure_mutation_trigger
  BEFORE UPDATE OR DELETE ON public.year_closures
  FOR EACH ROW EXECUTE FUNCTION public.prevent_year_closure_mutation();

DROP TRIGGER IF EXISTS prevent_year_closure_truncate_trigger ON public.year_closures;
CREATE TRIGGER prevent_year_closure_truncate_trigger
  BEFORE TRUNCATE ON public.year_closures
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_year_closure_mutation();

ALTER TABLE public.year_closures ENABLE ALWAYS TRIGGER prevent_year_closure_mutation_trigger;
ALTER TABLE public.year_closures ENABLE ALWAYS TRIGGER prevent_year_closure_truncate_trigger;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Rechten
--
--    Lezen mag iedereen die de organisatie mag lezen; schrijven doet uitsluitend
--    close_fiscal_year(). Kon een ingelogde gebruiker de marker zelf schrijven,
--    dan kon hij een afsluiting verzinnen — en via de watermerkgrendel van
--    sectie 5 daarmee ook het watermerk vooruitzetten zonder ooit de controles
--    te doorlopen.
--
--    REVOKE ALL gevolgd door één GRANT SELECT, geen opsomming: geen toekomstig
--    default privilege glipt er dan langs.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.year_closures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_year_closures_select ON public.year_closures;
CREATE POLICY role_year_closures_select ON public.year_closures
  FOR SELECT TO authenticated
  USING (public.has_min_role(auth.uid(), organization_id, 'read_only'));

REVOKE ALL ON public.year_closures FROM anon, authenticated, service_role;
GRANT SELECT ON public.year_closures TO authenticated, service_role;

COMMENT ON TABLE public.year_closures IS
'Onuitwisbaar afsluitbewijs van één boekjaar van één administratie. De primary key (client_id, fiscal_year) ís de idempotentiegarantie. Er hoort GEEN boeking bij: de jaarafsluiting v1 maakt geen resultaatboeking en geen doorrol, omdat de rapportagemotor het resultaat al als presentatieregel afleidt en de openingspositie al cumulatief uit het grootboek volgt. Alleen public.close_fiscal_year() schrijft hier; applicatierollen mogen uitsluitend lezen.';

COMMENT ON COLUMN public.year_closures.fiscal_year IS
'Het afgesloten boekjaar. Boekjaar = kalenderjaar: elke schrijver leidt boekjaar af als EXTRACT(YEAR FROM <brondatum>) en clients kent geen afwijkend boekjaarbegin.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Het watermerk mag alleen nog met bewijs bewegen
--
--    HET PROBLEEM. `clients.afgesloten_boekjaar` werd tot nu toe met de hand
--    gezet via het klantformulier — een gewoon kolomveld in een gewone UPDATE.
--    Daarmee kon elk jaar worden afgesloten zonder één controle, en kon het
--    watermerk ook weer omlaag, waarmee een append-only grootboek achteraf weer
--    beschrijfbaar werd in een jaar dat al als afgesloten was gepresenteerd.
--
--    DE OPLOSSING, EN WAAROM JUIST DEZE. Niet een sessievariabele die de RPC
--    zet (dan is de grendel een afspraak, en elke andere schrijver kan hem
--    nadoen), maar de MARKER ZELF als autoriteit: het watermerk mag alleen naar
--    een jaar waarvoor een afsluitbewijs bestaat. Omdat alleen close_fiscal_year()
--    markers kan maken, is zij daarmee de enige weg — zonder dat deze trigger
--    iets over aanroepers hoeft te weten.
--
--    Daarmee wordt invariant 4 van het ontwerp STRUCTUREEL in plaats van
--    procedureel: "watermerk vooruit terwijl de marker ontbreekt" is geen
--    toestand die de database nog kan aannemen.
--
--    VERLAGEN KAN NOOIT. Niet door de RPC (die komt er niet langs), niet met de
--    hand, en ook niet naar NULL. Heropenen bestaat niet in v1.
--
--    BESTAANDE GEGEVENS BLIJVEN ONGEMOEID. De trigger vuurt alleen wanneer de
--    kolom daadwerkelijk verandert. Een administratie die vandaag al een
--    handmatig gezet watermerk heeft en géén marker, blijft gewoon werken en
--    kan een LATER jaar normaal afsluiten. Alleen het opnieuw afsluiten van dat
--    ene handmatige jaar loopt fail-closed vast in sectie 6 — terecht, want er
--    is geen bewijs, en een marker verzinnen mag niet.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_year_close_watermark()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.afgesloten_boekjaar IS NOT DISTINCT FROM OLD.afgesloten_boekjaar THEN
    RETURN NEW;
  END IF;

  IF OLD.afgesloten_boekjaar IS NOT NULL
     AND (NEW.afgesloten_boekjaar IS NULL OR NEW.afgesloten_boekjaar < OLD.afgesloten_boekjaar) THEN
    RAISE EXCEPTION 'Het afsluitwatermerk kan niet omlaag (van % naar %): een afgesloten boekjaar wordt niet heropend.',
      OLD.afgesloten_boekjaar, COALESCE(NEW.afgesloten_boekjaar::text, 'leeg')
      USING ERRCODE = '42501';
  END IF;

  IF NEW.afgesloten_boekjaar IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.year_closures yc
       WHERE yc.client_id = NEW.id AND yc.fiscal_year = NEW.afgesloten_boekjaar
     ) THEN
    RAISE EXCEPTION 'Boekjaar % kan alleen worden afgesloten via public.close_fiscal_year(): er is geen afsluitbewijs.',
      NEW.afgesloten_boekjaar
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_year_close_watermark() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_year_close_watermark_trigger ON public.clients;
CREATE TRIGGER enforce_year_close_watermark_trigger
  BEFORE UPDATE OF afgesloten_boekjaar ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.enforce_year_close_watermark();

ALTER TABLE public.clients ENABLE ALWAYS TRIGGER enforce_year_close_watermark_trigger;

COMMENT ON FUNCTION public.enforce_year_close_watermark() IS
'Laat clients.afgesloten_boekjaar alleen vooruit bewegen naar een boekjaar waarvoor een year_closures-bewijs bestaat, en nooit omlaag of naar NULL. Omdat uitsluitend close_fiscal_year() markers kan maken, is zij daarmee de enige weg naar het watermerk.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) De schrijver
--
--    GRENDELVOLGORDE, gelijk aan post_opening_balance() en reverse_posting_group():
--      administratiegrendel (lock_ledger_client)
--        → rijgrendel op de administratie (SELECT … FOR UPDATE)
--          → afsluitbewijs lezen
--            → herkeuren
--              → marker schrijven
--                → watermerk bijwerken
--
--    De administratiegrendel wordt genomen VÓÓR er iets veranderlijks wordt
--    gelezen, want alles daarna — watermerk, marker, openstaand bronwerk — kan
--    door een gelijktijdige schrijver bewegen. De rijgrendel erbovenop maakt de
--    UPDATE aan het eind conflictvrij.
--
--    WAAROM ER OPNIEUW WORDT GEKEURD. De gereedheidscontrole in de UI leest via
--    react-query en kan minuten oud zijn; tussen "gereed" en "afsluiten" kan een
--    collega een inkoopfactuur goedkeuren. Afsluiten is onomkeerbaar, dus de
--    database keurt zelf, onder de grendel, met de gegevens van dit moment.
--
--    WAT ER WORDT HERKEURD — en niets meer:
--      A  watermerkconsistentie (al afgesloten / marker ontbreekt / marker zonder watermerk)
--      B  afsluitvolgorde: geen ouder open boekjaar MET boekingen overslaan
--      C  ongebalanceerde boekingsgroepen t/m het doeljaar
--      D  postbaar maar nog niet geboekt bronwerk t/m het doeljaar
--      E  postbaar bronwerk zonder boekhoudkundige datum
--
--    WAT ER BEWUST NIET WORDT HERKEURD staat bij sectie 7.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.close_fiscal_year(
  _client_id   uuid,
  _fiscal_year integer
)
RETURNS TABLE (
  client_id       uuid,
  organization_id uuid,
  fiscal_year     integer,
  closed_at       timestamptz,
  closed_by       uuid,
  created         boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_org          uuid;
  v_client       public.clients%ROWTYPE;
  v_watermark    integer;
  v_existing     public.year_closures%ROWTYPE;
  v_found        boolean;

  v_open_years   integer[];
  v_broken       integer;
  v_through      integer;
  v_dateless     integer;

  v_row          public.year_closures%ROWTYPE;
BEGIN
  -- (1) Authenticatie eerst: voor een anonieme aanroep wordt niets gelezen en
  --     niets gegrendeld.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- (2) Isolatiecontract, gelijk aan de overige schrijvers. Onder REPEATABLE
  --     READ zou de herkeuring op een bevroren momentopname draaien terwijl de
  --     grendel juist bedoeld is om de HUIDIGE stand te zien.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een jaarafsluiting kan alleen in een READ COMMITTED transactie (huidig niveau: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  IF _client_id IS NULL THEN
    RAISE EXCEPTION 'Geen administratie opgegeven' USING ERRCODE = '22004';
  END IF;
  IF _fiscal_year IS NULL THEN
    RAISE EXCEPTION 'Geen boekjaar opgegeven' USING ERRCODE = '22004';
  END IF;
  IF _fiscal_year < 2000 OR _fiscal_year > 2100 THEN
    RAISE EXCEPTION 'Boekjaar % valt buiten het ondersteunde bereik 2000-2100', _fiscal_year
      USING ERRCODE = '22023';
  END IF;

  -- ── (3) DE AUTORISATIEPOORT ───────────────────────────────────────────────
  --
  --     Deze functie is SECURITY DEFINER en ziet dus administraties die RLS
  --     voor de aanroeper verbergt. Zou zij eerst "bestaat niet" zeggen en pas
  --     daarna "geen rechten", dan is het verschil tussen die twee antwoorden
  --     een orakel waarmee een ingelogde buitenstaander kan aftasten wélke
  --     administratie-id's bestaan. Beide gevallen krijgen daarom exact dezelfde
  --     fout: dezelfde SQLSTATE én dezelfde tekst.
  SELECT c.organization_id INTO v_org FROM public.clients c WHERE c.id = _client_id;

  IF v_org IS NULL OR NOT public.has_min_role(v_uid, v_org, 'read_only') THEN
    RAISE EXCEPTION 'Administratie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  --     SCHRIJFDREMPEL. Vanaf hier is bekend dat de aanroeper deze administratie
  --     onder RLS gewoon mag lezen, dus een eerlijk antwoord over zijn eigen rol
  --     verraadt niets. ROLVLOER = accountant, dezelfde vloer als het memoriaal
  --     (6C-b6), de beginbalans (6C-b8) en de tegenboeking (6C-b9). Afsluiten is
  --     onomkeerbaar en hoort daar niet onder te zitten.
  IF NOT public.has_min_role(v_uid, v_org, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om een boekjaar af te sluiten voor deze organisatie (accountant vereist)'
      USING ERRCODE = '42501';
  END IF;

  -- (4) GRENDEL 0 — de administratie. Dezelfde grendel die elke grootboekregel
  --     via de trigger van 6C-b8 neemt. Genomen VÓÓR er iets veranderlijks
  --     wordt gelezen.
  PERFORM public.lock_ledger_client(_client_id);

  -- (5) GRENDEL 1 — de administratierij zelf, zodat de UPDATE aan het eind niet
  --     met een gelijktijdige klantmutatie kan botsen.
  SELECT * INTO v_client FROM public.clients c WHERE c.id = _client_id FOR UPDATE;
  v_watermark := v_client.afgesloten_boekjaar;

  -- (6) Het bestaande afsluitbewijs, gelezen ONDER de grendel.
  SELECT * INTO v_existing
  FROM public.year_closures yc
  WHERE yc.client_id = _client_id AND yc.fiscal_year = _fiscal_year;
  v_found := FOUND;

  -- ── (7) CONTROLE A — WATERMERKCONSISTENTIE ────────────────────────────────
  --
  --     `afgesloten_boekjaar` is een WATERMERK, geen los jaar: elke schrijver
  --     toetst met `boekjaar <= afgesloten_boekjaar`. "Dit jaar is al dicht"
  --     betekent hier dus `_fiscal_year <= watermerk`.
  IF v_watermark IS NOT NULL AND _fiscal_year <= v_watermark THEN
    IF v_found AND v_existing.organization_id = v_org THEN
      --   IDEMPOTENT. Een herhaling na een time-out of een onbekende uitkomst
      --   krijgt hetzelfde, onveranderde bewijs terug. Geen tweede rij, geen
      --   ondoorzichtige uniqueness-fout, geen enkele mutatie.
      RETURN QUERY SELECT v_existing.client_id, v_existing.organization_id, v_existing.fiscal_year,
                          v_existing.closed_at, v_existing.closed_by, false;
      RETURN;
    END IF;

    --   FAIL CLOSED. Het watermerk zegt dat dit jaar dicht is, maar er is geen
    --   bijpassend bewijs. Een marker verzinnen zou een afsluiting fabriceren
    --   die nooit is gekeurd; automatisch repareren zou hetzelfde zijn met een
    --   vriendelijker woord. Dit hoort een mens te onderzoeken.
    RAISE EXCEPTION 'Boekjaar % staat al als afgesloten (watermerk %) maar er is geen bijbehorend afsluitbewijs; dit moet handmatig worden onderzocht.',
      _fiscal_year, v_watermark
      USING ERRCODE = '23514';
  END IF;

  --   Spiegelbeeld: er ligt wél een bewijs, maar het watermerk staat er niet op.
  --   Ook dat is een gebroken toestand en geen reden om stilletjes bij te werken.
  IF v_found THEN
    RAISE EXCEPTION 'Er bestaat al een afsluitbewijs voor boekjaar %, maar het watermerk staat op %; dit moet handmatig worden onderzocht.',
      _fiscal_year, COALESCE(v_watermark::text, 'leeg')
      USING ERRCODE = '23514';
  END IF;

  -- ── (8) CONTROLE B — AFSLUITVOLGORDE ──────────────────────────────────────
  --
  --     Het watermerk op 2026 zetten sluit ook 2024 en 2025 — stilzwijgend, en
  --     onomkeerbaar voor een append-only grootboek. Liggen er vóór dit jaar nog
  --     niet-afgesloten boekjaren MET boekingen, dan is dat geen nette
  --     afsluiting maar een sprong.
  --
  --     Een LEEG tussenliggend jaar is uitdrukkelijk geen bezwaar: daar valt
  --     niets af te sluiten. Dezelfde regel als `yearOrder()` in
  --     src/lib/year-close-readiness.ts.
  SELECT array_agg(DISTINCT lp.boekjaar ORDER BY lp.boekjaar)
    INTO v_open_years
  FROM public.ledger_postings lp
  WHERE lp.client_id = _client_id
    AND lp.boekjaar < _fiscal_year
    AND (v_watermark IS NULL OR lp.boekjaar > v_watermark);

  IF v_open_years IS NOT NULL THEN
    RAISE EXCEPTION 'Er liggen oudere boekjaren met boekingen nog open (%); boekjaar % afsluiten zou die ongemerkt meenemen.',
      array_to_string(v_open_years, ', '), _fiscal_year
      USING ERRCODE = '23514';
  END IF;

  -- ── (9) CONTROLE C — ONGEBALANCEERDE BOEKINGSGROEPEN T/M HET DOELJAAR ─────
  --
  --     De uitgestelde constraint-trigger van 6C-b2 houdt elke groep in balans,
  --     dus dit hoort nul op te leveren. Het staat er als slotcontrole, niet als
  --     vervanging: zou zo'n groep ondanks alles toch bestaan, dan zou afsluiten
  --     haar voorgoed onherstelbaar maken, want het grootboek is append-only en
  --     elke correctie moet in een open jaar landen. De controle is één
  --     aggregaat en kan per constructie niet vals-positief zijn.
  SELECT count(*) INTO v_broken
  FROM (
    SELECT lp.posting_group_id
    FROM public.ledger_postings lp
    WHERE lp.client_id = _client_id
      AND lp.boekjaar <= _fiscal_year
    GROUP BY lp.posting_group_id
    HAVING count(*) < 2
        OR SUM(lp.debit_amount) <> SUM(lp.credit_amount)
        OR SUM(lp.debit_amount) <= 0
  ) g;

  IF v_broken > 0 THEN
    RAISE EXCEPTION 'Er % t/m boekjaar % % ongebalanceerde boekingsgroep(en) in het grootboek; afsluiten zou die onherstelbaar maken.',
      CASE WHEN v_broken = 1 THEN 'staat' ELSE 'staan' END, _fiscal_year, v_broken
      USING ERRCODE = '23514';
  END IF;

  -- ── (10) CONTROLE D en E — POSTBAAR BRONWERK ──────────────────────────────
  --
  --     DIT IS GEEN NIEUWE BOEKHOUDREGEL maar het gevolg van een bestaande:
  --     elke schrijver weigert `boekjaar <= afgesloten_boekjaar`. Zet het
  --     watermerk op het doeljaar, dan is elk postbaar-maar-nog-niet-geboekt
  --     document t/m dat jaar VOORGOED onboekbaar. Dat is precies het soort
  --     onomkeerbaarheid dat een afsluitcontrole hoort te voorkomen.
  --
  --     Werk NÁ het doeljaar blokkeert niets: het blijft gewoon boekbaar.
  --
  --     HET BOEKJAAR KOMT UIT DE BOEKHOUDKUNDIGE DATUM, NOOIT UIT created_at.
  --     Wanneer een rij is aangemaakt zegt niets over het jaar waarin zij
  --     boekhoudkundig hoort; elke schrijver leidt boekjaar af uit de brondatum.
  --       inkoop     invoice_date
  --       verkoop    invoice_date
  --       bank       de banktransactie: transaction_date
  --       memoriaal  posting_date
  --
  --     Ontbreekt die datum, dan wordt er NIET geraden: het document kan niet
  --     aan een boekjaar worden toegewezen en de afsluiting loopt fail-closed
  --     vast (controle E). Raden zou betekenen dat een afsluiting werk kan
  --     meenemen of overslaan op grond van een gok.
  --
  --     De postbaarheidsregels zijn één-op-één die van de bestaande schrijvers,
  --     zoals src/lib/ledger-completeness.ts ze vastlegt en
  --     src/hooks/useUnpostedSourceWork.ts ze leest:
  --       inkoop     status ∈ (gecontroleerd, betaald, geexporteerd), geen marker
  --       verkoop    status ∈ (gecontroleerd, betaald), btw_verlegd = false, geen marker
  --       bank       aflettering zonder marker waarvan de FACTUUR al geboekt is
  --       memoriaal  memoriaalboeking zonder marker
  WITH postbaar AS (
    SELECT EXTRACT(YEAR FROM pi.invoice_date)::integer AS boekjaar
    FROM public.purchase_invoices pi
    WHERE pi.client_id = _client_id
      AND pi.status IN ('gecontroleerd', 'betaald', 'geexporteerd')
      AND NOT EXISTS (
        SELECT 1 FROM public.purchase_invoice_postings m
        WHERE m.purchase_invoice_id = pi.id
      )

    UNION ALL

    SELECT EXTRACT(YEAR FROM si.invoice_date)::integer
    FROM public.sales_invoices si
    WHERE si.client_id = _client_id
      AND si.status IN ('gecontroleerd', 'betaald')
      AND si.btw_verlegd = false
      AND NOT EXISTS (
        SELECT 1 FROM public.sales_invoice_postings m
        WHERE m.sales_invoice_id = si.id
      )

    UNION ALL

    -- Een aflettering is pas postbaar zodra de factuur zelf geboekt is; zonder
    -- geboekte factuur is er nog geen openstaande post om af te letteren.
    SELECT EXTRACT(YEAR FROM bt.transaction_date)::integer
    FROM public.bank_transaction_allocations a
    LEFT JOIN public.bank_transactions bt ON bt.id = a.bank_transaction_id
    WHERE a.client_id = _client_id
      AND NOT EXISTS (
        SELECT 1 FROM public.bank_allocation_postings m
        WHERE m.allocation_id = a.id
      )
      AND (
        CASE
          WHEN a.invoice_type = 'inkoop'
            THEN EXISTS (SELECT 1 FROM public.purchase_invoice_postings p
                         WHERE p.purchase_invoice_id = a.invoice_id)
          ELSE EXISTS (SELECT 1 FROM public.sales_invoice_postings s
                       WHERE s.sales_invoice_id = a.invoice_id)
        END
      )

    UNION ALL

    SELECT EXTRACT(YEAR FROM mj.posting_date)::integer
    FROM public.manual_journals mj
    WHERE mj.client_id = _client_id
      AND NOT EXISTS (
        SELECT 1 FROM public.manual_journal_postings m
        WHERE m.manual_journal_id = mj.id
      )
  )
  SELECT count(*) FILTER (WHERE p.boekjaar IS NOT NULL AND p.boekjaar <= _fiscal_year),
         count(*) FILTER (WHERE p.boekjaar IS NULL)
    INTO v_through, v_dateless
  FROM postbaar p;

  IF v_dateless > 0 THEN
    RAISE EXCEPTION 'Van % postbaar brondocument(en) is de boekhoudkundige datum onbekend; het boekjaar kan niet worden vastgesteld en afsluiten is daarom niet veilig.',
      v_dateless
      USING ERRCODE = '23514';
  END IF;

  IF v_through > 0 THEN
    RAISE EXCEPTION 'Er % nog % postbaar brondocument(en) open met boekjaar t/m %; afsluiten zou % voorgoed onboekbaar maken.',
      CASE WHEN v_through = 1 THEN 'staat' ELSE 'staan' END, v_through, _fiscal_year,
      CASE WHEN v_through = 1 THEN 'dat document' ELSE 'die documenten' END
      USING ERRCODE = '23514';
  END IF;

  -- ── (11) HET BEWIJS, DAN HET WATERMERK ────────────────────────────────────
  --
  --     In deze volgorde en in ÉÉN transactie. De marker is het serialisatiepunt:
  --     botst hij op de primary key, dan faalt de afsluiting vóór er ook maar
  --     iets aan de administratie is veranderd. En omdat de trigger van sectie 5
  --     het watermerk alleen naar een jaar mét bewijs laat bewegen, kan de
  --     omgekeerde halve toestand — watermerk vooruit, bewijs weg — niet bestaan.
  --
  --     result_cents wordt hier NIET berekend en niet opgeslagen; zie sectie 1.
  --     Een nulresultaat is daarmee vanzelf gewoon afsluitbaar: er is geen bedrag
  --     dat nul zou kunnen zijn, en er wordt geen boeking gemaakt die volgens de
  --     groepsinvariant van 6C-b2 (beide totalen strikt > 0) toch niet had
  --     kunnen bestaan.
  INSERT INTO public.year_closures (client_id, fiscal_year, organization_id, closed_by)
  VALUES (_client_id, _fiscal_year, v_org, v_uid)
  RETURNING * INTO v_row;

  UPDATE public.clients c
     SET afgesloten_boekjaar = _fiscal_year
   WHERE c.id = _client_id;

  RETURN QUERY SELECT v_row.client_id, v_row.organization_id, v_row.fiscal_year,
                      v_row.closed_at, v_row.closed_by, true;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) Wat de database BEWUST niet herkeurt
--
--    De gereedheidspagina toont meer dan dit, en terecht — maar niet elke
--    waarschuwing is een boekhoudkundige onmogelijkheid. In de database staan
--    alleen de controles waarvan aantoonbaar is dat afsluiten zonder die
--    controle financiële waarheid vernietigt. De rest blijft waarschuwing, want
--    er in de database een blokkade van maken zou een norm verzinnen die dit
--    product niet kent.
--
--      • rapportageclassificatie en subgroepen — presentatie, geen grootboek.
--        Een ongeclassificeerde rekening maakt een rapport onvolledig, niet het
--        grootboek onjuist, en classificatie mag ook ná afsluiten nog worden
--        gecorrigeerd.
--      • administratiebrede integriteits- en tegenboekingsbevindingen die niet
--        aan het doeljaar zijn toe te wijzen — zie CHECK_SCOPE in
--        src/lib/year-close-readiness.ts. Een bevinding in een later jaar maakt
--        een eerder jaar niet onafsluitbaar; die regel bestaat niet.
--      • openstaand bronwerk NA het doeljaar — dat blijft gewoon boekbaar.
--      • technische laadtoestanden — die bestaan alleen in de browser.
--
--      • DE BEGINBALANS, en dat verdient uitleg. Afsluiten van jaar N maakt het
--        voorgoed onmogelijk om nog een beginbalans te posten of nil te
--        verklaren met een boekjaar t/m N: post_opening_balance() én
--        declare_opening_balance_nil() weigeren beide `boekjaar <=
--        afgesloten_boekjaar` (6C-b8). Dat is een echt gevolg en het hoort op
--        het scherm te staan — het staat daar ook, als waarschuwing
--        `opening_balance_status`.
--        Het is alleen GEEN databaseblokkade, omdat er geen invariant bestaat
--        die zegt dat een administratie een beginbalans MOET hebben. Een
--        administratie die werkelijk in jaar N begint heeft er terecht geen, en
--        een blokkade zou juist die administratie haar eerste jaar nooit laten
--        afsluiten. Of er een openingspositie bestáát die nog niet is
--        vastgelegd, weet de database niet en kan zij niet weten; dat is een
--        oordeel van de accountant. Daarom waarschuwen en niet weigeren.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.close_fiscal_year(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_fiscal_year(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.close_fiscal_year(uuid, integer) IS
'Sluit één boekjaar van één administratie af: herkeurt de financieel noodzakelijke invarianten onder de administratiegrendel, schrijft het onuitwisbare bewijs in year_closures en zet daarna clients.afgesloten_boekjaar — alles in één transactie. Maakt GEEN grootboekboeking: geen resultaatbestemming en geen doorrol, omdat de rapportagemotor het resultaat al als presentatieregel afleidt en de openingspositie al cumulatief uit het grootboek volgt. Idempotent: een herhaling van een al afgesloten jaar geeft hetzelfde bewijs terug met created = false. Rolvloer: accountant.';
