-- ═════════════════════════════════════════════════════════════════════════════
-- 6C-b11 (PR B) — EEN ECHTE AFSLUITING SCHRIJFT VOORTAAN HAAR GEBEURTENIS
--
-- Zie docs/BOEKASSIST_YEAR_CLOSE_LIFECYCLE.md, sectie F, en PR A
-- (20260925120000) die `fiscal_year_events` heeft aangelegd en gevuld.
--
-- WAT ER VERANDERT — ÉÉN DING
--   Een NIEUWE afsluiting legt naast het bestaande bewijs in `year_closures`
--   ook één `closed`-gebeurtenis vast. In dezelfde transactie, met exact
--   hetzelfde tijdstip en exact dezelfde actor.
--
-- WAT ER NIET VERANDERT
--   De handtekening, de retourvorm, de gereedheidsregels, de jaarvolgorde, de
--   herkeuring van het grootboek en het bronwerk, de rolvloer, de tenantregels,
--   `lock_ledger_client()`, de rijgrendel, het watermerkgedrag en de
--   idempotentie. De acht schrijvers houden hun eigen afgesloten-jaar-toets, de
--   bulk-preflight is ongemoeid, en er is nog steeds geen heropening en geen
--   boekingsblokkade.
--
--   `prevent_year_closure_mutation()` wordt NIET versoepeld. De statuskolom
--   wordt bij het aanmaken expliciet op 'closed' gezet en daarna nooit meer
--   aangeraakt — PR E versmalt die trigger, niet deze migratie.
--
-- WAAROM ÉÉN TIJDSTIP EN ÉÉN ACTOR
--   Beide komen uit `RETURNING * INTO v_row`, dus uit de rij zoals zij zojuist
--   IS weggeschreven. Een tweede `now()` zou bewijs en gebeurtenis op
--   microseconden uit elkaar kunnen laten lopen, en dan geeft het auditspoor
--   twee antwoorden op dezelfde vraag.
--
-- WAAROM ER BIJ EEN HERHALING NIETS BIJKOMT
--   De idempotente weg keert terug vóór het schrijfblok. Dat is geen vergeetbare
--   `IF` maar de vorm van de functie: `created = false` kan die INSERT niet
--   bereiken.
--
-- ROLLBACK (handmatig): pas 20260924120000 opnieuw toe; die definieert
-- close_fiscal_year() zonder het gebeurtenisblok. De reeds geschreven
-- gebeurtenissen blijven dan staan — zij zijn onuitwisbaar, en dat is juist.
-- ═════════════════════════════════════════════════════════════════════════════

DO $migratie$
BEGIN
  IF to_regclass('public.fiscal_year_events') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b11 PR B vereist eerst public.fiscal_year_events (PR A)';
  END IF;
  IF to_regproc('public.close_fiscal_year') IS NULL THEN
    RAISE EXCEPTION 'Migratie 6C-b11 PR B vereist eerst public.close_fiscal_year() (6C-b10)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'year_closures' AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION 'Migratie 6C-b11 PR B vereist eerst year_closures.status (PR A)';
  END IF;
END
$migratie$;

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
  INSERT INTO public.year_closures (client_id, fiscal_year, organization_id, closed_by, status)
  VALUES (_client_id, _fiscal_year, v_org, v_uid, 'closed')
  RETURNING * INTO v_row;

  --     (11b) DE GEBEURTENIS — PR B, en het enige wat er in deze fase bijkomt.
  --
  --     ÉÉN TIJDSTIP EN ÉÉN ACTOR, want beide komen uit `v_row`: de rij zoals
  --     zij zojuist IS weggeschreven. Er wordt hier bewust geen tweede `now()`
  --     aangeroepen en geen tweede keer `auth.uid()` gelezen. Deden we dat wel,
  --     dan konden bewijs en gebeurtenis op een paar microseconden uit elkaar
  --     gaan lopen — en dan zou een auditspoor twee verschillende antwoorden
  --     geven op de vraag wanneer dit boekjaar is afgesloten. Nu is de
  --     gelijkheid structureel in plaats van afgesproken.
  --
  --     ALLEEN OP DEZE TAK. De idempotente weg hierboven keert terug vóór dit
  --     punt, dus een herhaalde afsluiting van een al afgesloten jaar komt hier
  --     per constructie niet langs en voegt niets toe. Dat is geen `IF` die
  --     vergeten kan worden maar de vorm van de functie zelf.
  --
  --     `backfilled = false`: dit is een waargenomen gebeurtenis, geen uit
  --     `year_closures` gereconstrueerde. Daarmee raakt deze rij ook de
  --     partiële unieke index van PR A niet, en blijft
  --     closed → reopened → closed mogelijk.
  INSERT INTO public.fiscal_year_events
    (client_id, organization_id, fiscal_year, event_type, occurred_at, actor_id, reason, backfilled)
  VALUES (v_row.client_id, v_row.organization_id, v_row.fiscal_year, 'closed',
          v_row.closed_at, v_row.closed_by, NULL, false);

  UPDATE public.clients c
     SET afgesloten_boekjaar = _fiscal_year
   WHERE c.id = _client_id;

  RETURN QUERY SELECT v_row.client_id, v_row.organization_id, v_row.fiscal_year,
                      v_row.closed_at, v_row.closed_by, true;
END
$$;

-- De rechten blijven exact wat 6C-b10 heeft gezet. CREATE OR REPLACE behoudt de
-- bestaande ACL, maar hier nog eens expliciet, zodat deze migratie ook op zichzelf
-- leesbaar is èn er geen twijfel bestaat dat er niets is verbreed.
REVOKE ALL ON FUNCTION public.close_fiscal_year(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_fiscal_year(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.close_fiscal_year(uuid, integer) IS
'Sluit één boekjaar van één administratie af: herkeurt de financieel noodzakelijke invarianten onder de administratiegrendel, schrijft het onuitwisbare bewijs in year_closures, legt daarnaast één closed-gebeurtenis vast in fiscal_year_events met exact hetzelfde tijdstip en dezelfde actor, en zet daarna clients.afgesloten_boekjaar — alles in één transactie. Maakt GEEN grootboekboeking: geen resultaatbestemming en geen doorrol. Idempotent: een herhaling van een al afgesloten jaar geeft hetzelfde bewijs terug met created = false en voegt géén gebeurtenis toe. Rolvloer: accountant.';
