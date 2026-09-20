-- ─────────────────────────────────────────────────────────────────────────────
-- Bank-inhaalslag: preflight (alleen lezen) en bulkorkestratie
--
-- WAT DIT IS
-- Een administratie kan honderden historische bankregels hebben die stuk voor
-- stuk handmatig gecodeerd zijn en nog geboekt moeten worden. Eén voor één is
-- dat honderden browserrondes. Dit bestand zet daar twee dingen naast:
--
--   1. public.bank_bulk_posting_candidates(_client_id, _boekjaar)
--      Leest welke bankregels er zijn en in welke WERKSTROOMtoestand ze staan.
--      Schrijft niets en beslist niets.
--
--   2. public.post_bank_transactions_bulk(_transaction_ids)
--      Biedt die regels één voor één aan de BESTAANDE schrijver aan en geeft
--      per regel terug wat ervan geworden is.
--
-- WAT DIT NADRUKKELIJK NIET IS
-- Geen tweede boekhoudmotor. Er staat in dit hele bestand geen enkele
-- INSERT in public.ledger_postings, geen INSERT in public.bank_transaction_postings,
-- geen BTW-formule, geen debet/credit-keuze, geen rekeningkeuze en geen
-- afgesloten-boekjaarbeslissing die iets tegenhoudt. De enige schrijvende
-- handeling in de bulkfunctie is de aanroep
--
--     public.post_bank_transaction(<id>)
--
-- en die blijft, zoals sinds 20260920195805 en de verharding 20260921140000,
-- de enige autoriteit over wat er in het grootboek belandt.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DE PREFLIGHT: WERKSTROOMTOESTANDEN, GEEN ACCEPTATIEMOTOR
--
-- Vier toestanden: posted, ready, review_needed, blocked. Ze beantwoorden de
-- vraag "heeft het zin dit aan te bieden?", niet de vraag "mag dit geboekt
-- worden?" — dat tweede oordeel velt de schrijver, bij élke aanroep opnieuw.
--
-- Er wordt daarom uitsluitend geclassificeerd op wat PERSISTENT en eenduidig
-- vastligt: de marker, de aflettering, de status, de gekozen rekening, het
-- bedrag, en of de administratie de rekeningen heeft ingesteld die de
-- schrijver nodig heeft. Wat een driftrisico zou opleveren — de BTW-splitsing,
-- de afronding, de richting, `posting_account_ok()` — wordt hier NIET
-- nagerekend. Zegt deze laag `ready` en weigert de schrijver alsnog, dan heeft
-- de schrijver gelijk en blijft de regel ongeboekt.
--
-- Er wordt nergens een rekeningNUMMER verondersteld: er wordt alleen gekeken
-- óf de expliciet ingestelde account-id aanwezig is.
--
-- AUTORISATIE = RLS
-- De functie is SECURITY INVOKER en leest `bank_transactions` onder de policy
-- `role_bank_transactions_select` (read_only, organisatiebreed). Een
-- administratie van een andere organisatie levert daarmee precies hetzelfde op
-- als een administratie die niet bestaat: nul rijen. Er is geen aparte poort
-- te schrijven en dus ook geen poort die anders kan gaan antwoorden dan RLS.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DE BULK: GEDEELTELIJKE MISLUKKING IS DE NORMALE UITKOMST
--
-- Een partij van 342 regels mag geen alles-of-niets-transactie zijn: één regel
-- met een ontbrekende BTW-rekening zou dan 341 correcte boekingen terugdraaien.
-- Elke regel draait daarom in een eigen PL/pgSQL-subtransactie (een BEGIN/
-- EXCEPTION-blok). Mislukt er één, dan wordt uitsluitend díe subtransactie
-- teruggedraaid: geen marker, geen grootboekregel, geen half spoor — en de
-- reeds geboekte broers en zussen blijven staan.
--
-- SET CONSTRAINTS ALL IMMEDIATE / ALL DEFERRED
-- Dit is de subtiliteit die anders stilletjes misgaat. De groepsbalanscontrole
-- van de fundering (6C-b2) is een CONSTRAINT TRIGGER met DEFERRABLE INITIALLY
-- DEFERRED: hij vuurt pas bij COMMIT van de BUITENSTE transactie. Zonder
-- ingrijpen zou een groep die niet sluit dus niet die ene regel laten
-- mislukken, maar de hele partij bij COMMIT opblazen — precies het
-- alles-of-niets dat hier vermeden moet worden. Door de wachtrij aan het eind
-- van elke geslaagde regel binnen de subtransactie af te dwingen (IMMEDIATE)
-- en daarna weer uit te stellen (DEFERRED), valt zo'n fout binnen het
-- EXCEPTION-blok van de regel waar hij bij hoort. In de praktijk schrijft
-- post_bank_transaction() altijd een sluitende groep; dit maakt de isolatie
-- echt in plaats van op papier.
--
-- GEEN AUTOMATISCHE HERKANSING
-- Een geweigerde regel wordt niet opnieuw geprobeerd, in geen enkele vorm. Een
-- weigering is een oordeel, geen storing.
--
-- 23505 — 'Deze banktransactie is al geboekt'
-- Dat is een eindtoestand, geen fout: iemand anders (of een eerdere ronde) was
-- eerder. De uitkomst wordt `already_posted`, maar UITSLUITEND wanneer de
-- marker daarna ook werkelijk zichtbaar is voor déze aanroeper — de marker
-- wordt onder RLS gelezen, dus een claim van een andere organisatie levert die
-- bevestiging niet op en de regel blijft `rejected`. Er wordt nooit een andere
-- mislukking als succes verkocht.
--
-- WAT ER TERUGKOMT
-- Eén rij per UNIEKE aangeboden id, in de volgorde van eerste voorkomen, met
-- `ordinal` = die positie in de invoer. Een id dat twee keer in dezelfde
-- partij staat, wordt één keer aangeboden en levert één rij op.
--
-- BOVENGRENS: 500
-- Een inhaalslag over enkele boekjaren van één administratie blijft daar ruim
-- onder (de inhaalpagina van de grootboekvulling werkt met tientallen tot
-- enkele honderden records), terwijl 500 aanroepen van de schrijver in één
-- transactie nog een normale werklast is. Een ongebonden uuid[] is dat niet:
-- die zou een enkele request een transactie van onbepaalde duur laten openen,
-- met even lange grendels op bankregels. Meer dan 500 is geen partij maar een
-- migratie, en die hoort niet via een RPC te lopen.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LEESCONTROLE VOORAF (read-only, vóór toepassen in de Lovable Cloud SQL
-- editor van project alxlbdhpbwlehbdbfejw):
--
--   -- (a) de schrijver waar alles op leunt moet bestaan:
--   SELECT to_regprocedure('public.post_bank_transaction(uuid)') AS writer;
--
--   -- (b) en zijn markertabel:
--   SELECT to_regclass('public.bank_transaction_postings') AS marker;
--
--   -- (c) beide nieuwe namen horen nog niet te bestaan:
--   SELECT to_regprocedure('public.post_bank_transactions_bulk(uuid[])')             AS bulk,
--          to_regprocedure('public.bank_bulk_posting_candidates(uuid,integer)')      AS preflight;
--
-- POSTCHECK (na toepassen):
--
--   SELECT p.proname,
--          p.prosecdef  AS security_definer,
--          array_to_string(p.proacl, ' ') AS acl
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('post_bank_transactions_bulk','bank_bulk_posting_candidates');
--   -- verwacht: beide prosecdef = false, acl uitsluitend postgres + authenticated=X
--
-- rollback:
--   DROP FUNCTION IF EXISTS public.post_bank_transactions_bulk(uuid[]);
--   DROP FUNCTION IF EXISTS public.bank_bulk_posting_candidates(uuid, integer);
--   -- Veilig op elk moment: beide functies schrijven zelf niets en bezitten
--   -- geen gegevens. Wat via de bulk geboekt is, is door
--   -- post_bank_transaction() geboekt en blijft ongemoeid staan.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. Vereisten ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.post_bank_transaction(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Vereiste ontbreekt: public.post_bank_transaction(uuid). Pas eerst 20260920195805 en 20260921140000 toe.';
  END IF;
  IF to_regclass('public.bank_transaction_postings') IS NULL THEN
    RAISE EXCEPTION 'Vereiste ontbreekt: public.bank_transaction_postings.';
  END IF;
  IF to_regclass('public.bank_transaction_allocations') IS NULL THEN
    RAISE EXCEPTION 'Vereiste ontbreekt: public.bank_transaction_allocations.';
  END IF;
  IF to_regclass('public.ledger_postings') IS NULL THEN
    RAISE EXCEPTION 'Vereiste ontbreekt: public.ledger_postings (20260914120000).';
  END IF;
END $$;

-- ── 1. Preflight (alleen lezen) ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bank_bulk_posting_candidates(
  _client_id uuid,
  _boekjaar  integer DEFAULT NULL
)
RETURNS TABLE (
  transaction_id       uuid,
  transaction_date     date,
  amount               numeric,
  description          text,
  counter_account      text,
  match_status         text,
  grootboekrekening_id uuid,
  btw_percentage       numeric,
  is_posted            boolean,
  is_allocated         boolean,
  posting_group_id     uuid,
  workflow_state       text,
  reason               text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    t.id,
    t.transaction_date,
    t.amount,
    t.description,
    t.counter_account,
    t.match_status,
    t.grootboekrekening_id,
    t.btw_percentage,
    (m.bank_transaction_id IS NOT NULL)                      AS is_posted,
    a.allocated                                              AS is_allocated,
    m.posting_group_id,
    CASE
      WHEN m.bank_transaction_id IS NOT NULL            THEN 'posted'
      WHEN a.allocated                                  THEN 'blocked'
      WHEN t.amount = 0                                 THEN 'blocked'
      WHEN t.match_status = 'gematcht'                  THEN 'blocked'
      WHEN t.match_status <> 'handmatig_geboekt'        THEN 'review_needed'
      WHEN t.grootboekrekening_id IS NULL               THEN 'review_needed'
      WHEN c.bank_rekening_id IS NULL                   THEN 'blocked'
      WHEN NOT COALESCE(c.btw_vrijgesteld, false)
       AND COALESCE(t.btw_percentage, 0) > 0
       AND CASE WHEN t.amount < 0
                THEN c.btw_te_vorderen_rekening_id
                ELSE c.btw_te_betalen_rekening_id END IS NULL
                                                        THEN 'blocked'
      WHEN c.afgesloten_boekjaar IS NOT NULL
       AND EXTRACT(YEAR FROM t.transaction_date)::integer <= c.afgesloten_boekjaar
                                                        THEN 'blocked'
      ELSE 'ready'
    END AS workflow_state,
    CASE
      WHEN m.bank_transaction_id IS NOT NULL            THEN NULL
      WHEN a.allocated                                  THEN 'Deze banktransactie is aan een factuur gekoppeld; boek die via de aflettering.'
      WHEN t.amount = 0                                 THEN 'Een banktransactie van nul kan niet geboekt worden.'
      WHEN t.match_status = 'gematcht'                  THEN 'Deze banktransactie is aan een factuur gematcht; boeken loopt via de aflettering.'
      WHEN t.match_status <> 'handmatig_geboekt'        THEN format('Status is %s; alleen handmatig gecodeerde banktransacties kunnen zo geboekt worden.', t.match_status)
      WHEN t.grootboekrekening_id IS NULL               THEN 'Deze banktransactie heeft nog geen grootboekrekening.'
      WHEN c.bank_rekening_id IS NULL                   THEN 'Geen bankrekening (grootboek) ingesteld voor deze administratie.'
      WHEN NOT COALESCE(c.btw_vrijgesteld, false)
       AND COALESCE(t.btw_percentage, 0) > 0
       AND CASE WHEN t.amount < 0
                THEN c.btw_te_vorderen_rekening_id
                ELSE c.btw_te_betalen_rekening_id END IS NULL
                                                        THEN 'Geen BTW-rekening ingesteld voor deze administratie.'
      WHEN c.afgesloten_boekjaar IS NOT NULL
       AND EXTRACT(YEAR FROM t.transaction_date)::integer <= c.afgesloten_boekjaar
                                                        THEN format('Boekjaar %s is afgesloten voor deze administratie.',
                                                                    EXTRACT(YEAR FROM t.transaction_date)::integer)
      ELSE NULL
    END AS reason
  FROM public.bank_transactions t
  LEFT JOIN public.clients c
         ON c.id = t.client_id
  LEFT JOIN public.bank_transaction_postings m
         ON m.bank_transaction_id = t.id
  CROSS JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1 FROM public.bank_transaction_allocations al
      WHERE al.bank_transaction_id = t.id
    ) AS allocated
  ) a
  WHERE t.client_id = _client_id
    AND (_boekjaar IS NULL
         OR (t.transaction_date >= make_date(_boekjaar, 1, 1)
         AND t.transaction_date <  make_date(_boekjaar + 1, 1, 1)))
  ORDER BY t.transaction_date, t.id;
$$;

REVOKE ALL ON FUNCTION public.bank_bulk_posting_candidates(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_bulk_posting_candidates(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.bank_bulk_posting_candidates(uuid, integer) IS
  'Alleen lezen. Werkstroomtoestand per bankregel van één administratie (posted/ready/review_needed/blocked). '
  'Geen acceptatiemotor: post_bank_transaction() blijft de autoriteit. SECURITY INVOKER — RLS is de autorisatie.';

-- ── 2. Bulkorkestratie ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.post_bank_transactions_bulk(_transaction_ids uuid[])
RETURNS TABLE (
  ordinal          integer,
  transaction_id   uuid,
  outcome          text,
  posting_group_id uuid,
  error_code       text,
  message          text
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  -- De bovengrens staat hier één keer; de melding leidt hem eruit af.
  c_max_batch constant integer := 500;
  v_item      record;
  v_group     uuid;
  v_marker    uuid;
  v_state     text;
  v_msg       text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  IF _transaction_ids IS NULL OR cardinality(_transaction_ids) = 0 THEN
    RAISE EXCEPTION 'Geen banktransacties opgegeven' USING ERRCODE = '22023';
  END IF;

  IF array_position(_transaction_ids, NULL::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'De lijst met banktransacties bevat een lege waarde' USING ERRCODE = '22023';
  END IF;

  -- Op de RUWE lengte, niet op het aantal unieke id's: een array van 100.000
  -- keer dezelfde id is evengoed een verzoek dat niet gedaan hoort te worden.
  IF cardinality(_transaction_ids) > c_max_batch THEN
    RAISE EXCEPTION 'Maximaal % banktransacties per keer; er zijn er % aangeboden',
      c_max_batch, cardinality(_transaction_ids) USING ERRCODE = '54000';
  END IF;

  FOR v_item IN
    SELECT d.ord, d.id
    FROM (
      SELECT DISTINCT ON (u.id) u.id, u.ord
      FROM unnest(_transaction_ids) WITH ORDINALITY AS u(id, ord)
      ORDER BY u.id, u.ord
    ) d
    ORDER BY d.ord
  LOOP
    ordinal          := v_item.ord::integer;
    transaction_id   := v_item.id;
    outcome          := NULL;
    posting_group_id := NULL;
    error_code       := NULL;
    message          := NULL;

    BEGIN
      -- DE ENIGE SCHRIJVENDE HANDELING. Alles wat er boekhoudkundig gebeurt,
      -- gebeurt hierbinnen, in de reeds geharde schrijver.
      v_group := public.post_bank_transaction(v_item.id);

      -- Uitgestelde controles (o.a. de groepsbalans van 6C-b2) binnen DEZE
      -- subtransactie afdwingen, zodat een fout bij deze regel hoort en niet
      -- bij COMMIT de hele partij raakt. Daarna weer uitstellen, want de
      -- volgende schrijveraanroep bouwt haar groep opnieuw regel voor regel op.
      SET CONSTRAINTS ALL IMMEDIATE;
      SET CONSTRAINTS ALL DEFERRED;

      -- Succes wordt pas gemeld als de claim ook echt staat en dezelfde groep
      -- noemt. Zo hoort bij elke `posted` precies één vastgelegde marker.
      SELECT m.posting_group_id INTO v_marker
      FROM public.bank_transaction_postings m
      WHERE m.bank_transaction_id = v_item.id;

      IF v_marker IS NULL OR v_marker IS DISTINCT FROM v_group THEN
        RAISE EXCEPTION 'De boeking van deze banktransactie kon niet worden bevestigd' USING ERRCODE = '23514';
      END IF;

      outcome          := 'posted';
      posting_group_id := v_group;
      message          := 'Geboekt in het grootboek.';

    EXCEPTION WHEN others THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;

      IF v_state = '23505' THEN
        -- Al geboekt — maar alleen idempotent te noemen als de marker ook
        -- werkelijk zichtbaar is voor deze aanroeper (RLS).
        SELECT m.posting_group_id INTO v_marker
        FROM public.bank_transaction_postings m
        WHERE m.bank_transaction_id = v_item.id;
      ELSE
        v_marker := NULL;
      END IF;

      IF v_state = '23505' AND v_marker IS NOT NULL THEN
        outcome          := 'already_posted';
        posting_group_id := v_marker;
        message          := 'Deze banktransactie was al geboekt.';
      ELSE
        outcome    := 'rejected';
        error_code := v_state;
        -- Alleen de eigen woordenschat van de schrijver gaat ongeschonden naar
        -- buiten; die is bewust tenantveilig geformuleerd (een onbekende en een
        -- vreemde banktransactie geven allebei exact
        -- '42501 | Banktransactie niet beschikbaar'). Alles daarbuiten kan
        -- interne details bevatten en wordt neutraal gemeld.
        message := CASE
          WHEN v_state IN ('28000', '42501', '22023', '23514', '23505', 'P0002') THEN v_msg
          ELSE 'Boeken is niet gelukt voor deze banktransactie.'
        END;
      END IF;
    END;

    RETURN NEXT;
    -- Geen herkansing: de lus gaat door naar de volgende id, nooit terug.
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.post_bank_transactions_bulk(uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_bank_transactions_bulk(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.post_bank_transactions_bulk(uuid[]) IS
  'Biedt banktransacties één voor één aan public.post_bank_transaction() aan, elk in een eigen subtransactie. '
  'Bevat zelf geen boekhoudkundige logica en schrijft zelf niet in ledger_postings of bank_transaction_postings. '
  'Maximaal 500 id''s per aanroep; één rij terug per unieke id, in volgorde van eerste voorkomen.';
