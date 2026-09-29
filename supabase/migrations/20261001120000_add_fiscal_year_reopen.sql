-- ═════════════════════════════════════════════════════════════════════════════
-- 6C-b11 (PR E) — EEN BOEKJAAR HEROPENEN, CORRIGEREN EN OPNIEUW AFSLUITEN
--
-- Zie docs/BOEKASSIST_YEAR_CLOSE_LIFECYCLE.md, secties E1, F, G, J, L en M, en
-- PR A (20260925120000), PR B (20260926120000), PR C/D (20260927/28120000).
--
-- WAT ER BIJKOMT
--   1. reopen_fiscal_year(client, jaar, reden)  — closed → reopened
--   2. close_fiscal_year() kan een HEROPEND jaar opnieuw afsluiten
--      (reopened → closed), met de volledige gereedheidscontrole opnieuw
--   3. fiscal_year_events.created_xact_id       — elke nieuwe gebeurtenis
--      draagt de transactie die haar schreef; historische rijen blijven NULL
--   4. twee bewakers die ELKE status- of watermerkwijziging alleen toelaten als
--      de bijpassende gebeurtenis in DEZELFDE transactie is vastgelegd
--
-- DE STAND EN DE GESCHIEDENIS
--   `year_closures` blijft de huidige stand per (administratie, boekjaar), met
--   haar primary key als idempotentiegarantie. Alleen `status` mag nog
--   bewegen, en alleen samen met een gebeurtenis. `closed_at`/`closed_by`
--   blijven het ORIGINELE afsluitbewijs en worden nooit overschreven.
--   `fiscal_year_events` is de geschiedenis: closed → reopened → closed → …,
--   elke stap een nieuwe, onuitwisbare rij.
--
-- HET WATERMERK (clients.afgesloten_boekjaar)
--   Blijft de oude, harde schrijfgrendel (PR H ontkoppelt pas). Het betekent:
--   "alles t/m dit jaar is dicht". Daarom:
--     • alleen het HOOGSTE afgesloten jaar kan worden heropend;
--     • na heropenen wordt het watermerk het hoogste jaar dat nog `closed` is,
--       of NULL als er geen meer is — nooit blind `jaar - 1`;
--     • een jaar afsluiten kan niet zolang een ouder jaar heropend is.
--   Klopt de stand niet met het watermerk of met de gebeurtenissen — ook de
--   erfenis van een handmatig gezet watermerk zonder bewijs — dan faalt het
--   heropenen deterministisch in plaats van te raden.
--
-- WAT NIET VERANDERT
--   `posting_locked_through` en de boekingsblokkade: afsluiten en heropenen
--   zetten of wissen haar nooit. Geen grootboekboeking, geen resultaat-
--   bestemming, geen doorrol. De acht schrijvers, hun watermerktoets en de
--   bulk-preflight zijn ongewijzigd. Geen UI.
--
-- ROLLBACK (handmatig; alleen zolang er nog geen heropening heeft
-- plaatsgevonden — daarna is de status-/gebeurtenisgeschiedenis betekenisvol):
--   DROP FUNCTION IF EXISTS public.reopen_fiscal_year(uuid, integer, text);
--   herdefinieer close_fiscal_year() uit 20260926120000,
--   prevent_year_closure_mutation() en enforce_year_close_watermark() uit
--   20260924120000;
--   DROP TRIGGER IF EXISTS stamp_fiscal_year_event_xact_trigger ON public.fiscal_year_events;
--   DROP FUNCTION IF EXISTS public.stamp_fiscal_year_event_xact();
--   ALTER TABLE public.fiscal_year_events DROP COLUMN IF EXISTS created_xact_id;
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 0. Vereisten ────────────────────────────────────────────────────────────

DO $migratie$
BEGIN
  IF to_regclass('public.fiscal_year_events') IS NULL THEN
    RAISE EXCEPTION 'PR E vereist eerst public.fiscal_year_events (PR A, 20260925120000)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'year_closures' AND column_name = 'status') THEN
    RAISE EXCEPTION 'PR E vereist eerst year_closures.status (PR A, 20260925120000)';
  END IF;
  IF to_regprocedure('public.close_fiscal_year(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'PR E vereist eerst public.close_fiscal_year(uuid,integer)';
  END IF;
  IF position('INSERT INTO public.fiscal_year_events' IN
       (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.close_fiscal_year(uuid,integer)'))) = 0 THEN
    RAISE EXCEPTION 'PR E vereist eerst de afsluiting die haar gebeurtenis schrijft (PR B, 20260926120000)';
  END IF;
  IF to_regprocedure('public.posting_allowed(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'PR E vereist eerst de boekingsblokkade (PR C, 20260927120000): heropenen zonder blokkade laat een onbeschermd venster';
  END IF;
  IF to_regprocedure('public.lock_ledger_client(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PR E vereist public.lock_ledger_client(uuid) (6C-b8)';
  END IF;
END
$migratie$;

-- ── 1. De transactie die een gebeurtenis schreef ────────────────────────────
--
--    Nullable en ZONDER default: een volatiele default bij ADD COLUMN zou elke
--    bestaande rij stempelen met de transactie van deze migratie — een
--    verzonnen herkomst. Historische rijen blijven dus NULL. Nieuwe rijen krijgen
--    hun stempel van een trigger, niet van de schrijver: een aanroeper kan hem
--    daardoor niet vervalsen, en een NULL-stempel telt nergens als bewijs.

ALTER TABLE public.fiscal_year_events
  ADD COLUMN IF NOT EXISTS created_xact_id xid8 NULL;

COMMENT ON COLUMN public.fiscal_year_events.created_xact_id IS
'De transactie die deze gebeurtenis vastlegde (pg_current_xact_id()), gezet door stamp_fiscal_year_event_xact(). NULL voor gebeurtenissen van vóór PR E. De bewakers op year_closures.status en clients.afgesloten_boekjaar aanvaarden uitsluitend een gebeurtenis uit dezelfde transactie; een NULL-stempel is nooit bewijs.';

CREATE OR REPLACE FUNCTION public.stamp_fiscal_year_event_xact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.created_xact_id := pg_current_xact_id();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.stamp_fiscal_year_event_xact() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS stamp_fiscal_year_event_xact_trigger ON public.fiscal_year_events;
CREATE TRIGGER stamp_fiscal_year_event_xact_trigger
  BEFORE INSERT ON public.fiscal_year_events
  FOR EACH ROW EXECUTE FUNCTION public.stamp_fiscal_year_event_xact();

ALTER TABLE public.fiscal_year_events ENABLE ALWAYS TRIGGER stamp_fiscal_year_event_xact_trigger;

-- ── 2. De stand: alleen `status` mag bewegen, en alleen met een gebeurtenis ──
--
--    Was: élke UPDATE geweigerd. Nu één smalle uitzondering: `status` wisselt
--    tussen closed en reopened, ALLE andere kolommen blijven gelijk (het
--    originele bewijs), en in DEZELFDE transactie ligt een gebeurtenis van
--    precies dat type voor precies dit jaar. DELETE en TRUNCATE blijven
--    geweigerd. De bestaande triggers (ENABLE ALWAYS) blijven staan.

CREATE OR REPLACE FUNCTION public.prevent_year_closure_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.client_id, NEW.fiscal_year, NEW.organization_id, NEW.closed_at, NEW.closed_by)
         IS NOT DISTINCT FROM (OLD.client_id, OLD.fiscal_year, OLD.organization_id, OLD.closed_at, OLD.closed_by)
     AND NEW.status IS DISTINCT FROM OLD.status
  THEN
    IF EXISTS (
      SELECT 1 FROM public.fiscal_year_events e
      WHERE e.client_id = NEW.client_id
        AND e.fiscal_year = NEW.fiscal_year
        AND e.event_type = NEW.status
        AND e.created_xact_id = pg_current_xact_id()
    ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'De status van boekjaar % kan alleen veranderen via close_fiscal_year() of reopen_fiscal_year(): er is in deze transactie geen %-gebeurtenis vastgelegd.',
      NEW.fiscal_year, NEW.status
      USING ERRCODE = '42501';
  END IF;

  RAISE EXCEPTION 'year_closures is append-only: % is niet toegestaan. Alleen de status mag wijzigen, samen met een boekjaargebeurtenis; het afsluitbewijs zelf blijft staan.', TG_OP
    USING ERRCODE = '42501';
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.prevent_year_closure_mutation() FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Het watermerk: omhoog via afsluiten, omlaag via heropenen ────────────
--
--    OMHOOG naar jaar N vereist, allemaal in deze transactie of onder deze stand:
--      • een afsluitbewijs voor N met status closed;
--      • een closed-gebeurtenis voor N uit DEZELFDE transactie;
--      • geen enkel jaar t/m N dat heropend is (anders zou het watermerk een
--        open jaar stilzwijgend weer dichtzetten).
--    OMLAAG vanaf jaar W vereist:
--      • een reopened-gebeurtenis voor W uit DEZELFDE transactie, en status
--        reopened op het bewijs van W;
--      • de nieuwe waarde is EXACT het hoogste jaar dat nog closed is, of NULL.

CREATE OR REPLACE FUNCTION public.enforce_year_close_watermark()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_highest integer;
BEGIN
  IF NEW.afgesloten_boekjaar IS NOT DISTINCT FROM OLD.afgesloten_boekjaar THEN
    RETURN NEW;
  END IF;

  -- Omlaag (of leeg): uitsluitend een heropening.
  IF OLD.afgesloten_boekjaar IS NOT NULL
     AND (NEW.afgesloten_boekjaar IS NULL OR NEW.afgesloten_boekjaar < OLD.afgesloten_boekjaar) THEN

    IF NOT EXISTS (
         SELECT 1 FROM public.fiscal_year_events e
         WHERE e.client_id = NEW.id AND e.fiscal_year = OLD.afgesloten_boekjaar
           AND e.event_type = 'reopened' AND e.created_xact_id = pg_current_xact_id())
       OR NOT EXISTS (
         SELECT 1 FROM public.year_closures yc
         WHERE yc.client_id = NEW.id AND yc.fiscal_year = OLD.afgesloten_boekjaar AND yc.status = 'reopened')
    THEN
      RAISE EXCEPTION 'Het afsluitwatermerk kan alleen omlaag (van % naar %) via public.reopen_fiscal_year(): er is in deze transactie geen heropening vastgelegd.',
        OLD.afgesloten_boekjaar, COALESCE(NEW.afgesloten_boekjaar::text, 'leeg')
        USING ERRCODE = '42501';
    END IF;

    SELECT max(yc.fiscal_year) INTO v_highest
    FROM public.year_closures yc
    WHERE yc.client_id = NEW.id AND yc.status = 'closed';

    IF NEW.afgesloten_boekjaar IS DISTINCT FROM v_highest THEN
      RAISE EXCEPTION 'Na een heropening moet het afsluitwatermerk het hoogste nog afgesloten boekjaar zijn (%), niet %.',
        COALESCE(v_highest::text, 'leeg'), COALESCE(NEW.afgesloten_boekjaar::text, 'leeg')
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  -- Omhoog: uitsluitend een afsluiting.
  IF NOT EXISTS (
    SELECT 1 FROM public.year_closures yc
    WHERE yc.client_id = NEW.id AND yc.fiscal_year = NEW.afgesloten_boekjaar AND yc.status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Boekjaar % kan alleen worden afgesloten via public.close_fiscal_year(): er is geen afsluitbewijs.',
      NEW.afgesloten_boekjaar
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.fiscal_year_events e
    WHERE e.client_id = NEW.id AND e.fiscal_year = NEW.afgesloten_boekjaar
      AND e.event_type = 'closed' AND e.created_xact_id = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'Boekjaar % kan alleen worden afgesloten via public.close_fiscal_year(): er is in deze transactie geen afsluitgebeurtenis vastgelegd.',
      NEW.afgesloten_boekjaar
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.year_closures yc
    WHERE yc.client_id = NEW.id AND yc.fiscal_year <= NEW.afgesloten_boekjaar AND yc.status = 'reopened'
  ) THEN
    RAISE EXCEPTION 'Het afsluitwatermerk kan niet naar % zolang een ouder boekjaar heropend is.',
      NEW.afgesloten_boekjaar
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_year_close_watermark() FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. Afsluiten — nu ook opnieuw afsluiten ─────────────────────────────────
--
--    Letterlijk de schrijver van PR B, met drie wijzigingen:
--      (a) controle A kijkt naar de STATUS van het bestaande bewijs: closed
--          onder het watermerk = idempotent; heropend = opnieuw afsluiten;
--      (b) nieuwe controle A2: geen ouder boekjaar mag heropend zijn;
--      (c) bij opnieuw afsluiten: eerst de closed-gebeurtenis, dan de status
--          terug naar closed, dan het watermerk. Het originele closed_at /
--          closed_by blijft staan; het nieuwe moment en de nieuwe actor staan
--          in de gebeurtenis.
--    De volledige gereedheidscontrole (B t/m E) draait ook bij opnieuw afsluiten.
--    De teruggegeven closed_at/closed_by zijn die van de LAATSTE
--    afsluitgebeurtenis — voor een nooit heropend jaar exact het originele
--    bewijs (PR A/B leggen die gelijk).

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
  v_reclose      boolean := false;

  v_open_years   integer[];
  v_reopened     integer[];
  v_broken       integer;
  v_through      integer;
  v_dateless     integer;

  v_row          public.year_closures%ROWTYPE;
  v_event        public.fiscal_year_events%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

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

  -- (3) Autorisatiepoort: "bestaat niet" en "geen rechten" zijn één antwoord.
  SELECT c.organization_id INTO v_org FROM public.clients c WHERE c.id = _client_id;

  IF v_org IS NULL OR NOT public.has_min_role(v_uid, v_org, 'read_only') THEN
    RAISE EXCEPTION 'Administratie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_min_role(v_uid, v_org, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om een boekjaar af te sluiten voor deze organisatie (accountant vereist)'
      USING ERRCODE = '42501';
  END IF;

  -- (4)-(6) Grendels, dan de stand onder de grendel.
  PERFORM public.lock_ledger_client(_client_id);

  SELECT * INTO v_client FROM public.clients c WHERE c.id = _client_id FOR UPDATE;
  v_watermark := v_client.afgesloten_boekjaar;

  SELECT * INTO v_existing
  FROM public.year_closures yc
  WHERE yc.client_id = _client_id AND yc.fiscal_year = _fiscal_year
  FOR UPDATE;
  v_found := FOUND;

  IF v_found AND v_existing.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Het afsluitbewijs voor boekjaar % hoort bij een andere organisatie dan de administratie; dit moet handmatig worden onderzocht.',
      _fiscal_year
      USING ERRCODE = '23514';
  END IF;

  -- ── (7) CONTROLE A — STAND EN WATERMERK ──────────────────────────────────
  IF v_watermark IS NOT NULL AND _fiscal_year <= v_watermark THEN
    IF v_found AND v_existing.status = 'closed' THEN
      -- IDEMPOTENT: hetzelfde bewijs terug, niets erbij. Het moment en de actor
      -- zijn die van de laatste afsluitgebeurtenis (voor een nooit heropend
      -- jaar exact closed_at/closed_by).
      SELECT * INTO v_event
      FROM public.fiscal_year_events e
      WHERE e.client_id = _client_id AND e.fiscal_year = _fiscal_year AND e.event_type = 'closed'
      ORDER BY e.occurred_at DESC, e.created_xact_id DESC NULLS LAST, e.id DESC
      LIMIT 1;

      RETURN QUERY SELECT v_existing.client_id, v_existing.organization_id, v_existing.fiscal_year,
                          COALESCE(v_event.occurred_at, v_existing.closed_at),
                          COALESCE(v_event.actor_id, v_existing.closed_by), false;
      RETURN;
    END IF;

    IF v_found THEN
      RAISE EXCEPTION 'Boekjaar % staat heropend maar valt onder het watermerk %; dit moet handmatig worden onderzocht.',
        _fiscal_year, v_watermark
        USING ERRCODE = '23514';
    END IF;

    RAISE EXCEPTION 'Boekjaar % staat al als afgesloten (watermerk %) maar er is geen bijbehorend afsluitbewijs; dit moet handmatig worden onderzocht.',
      _fiscal_year, v_watermark
      USING ERRCODE = '23514';
  END IF;

  IF v_found THEN
    IF v_existing.status = 'reopened' THEN
      -- OPNIEUW AFSLUITEN: dezelfde volledige herkeuring hieronder.
      v_reclose := true;
    ELSE
      RAISE EXCEPTION 'Er bestaat al een afsluitbewijs voor boekjaar %, maar het watermerk staat op %; dit moet handmatig worden onderzocht.',
        _fiscal_year, COALESCE(v_watermark::text, 'leeg')
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- ── (7b) CONTROLE A2 — GEEN OUDER BOEKJAAR HEROPEND ──────────────────────
  --     Het watermerk betekent "alles t/m dit jaar is dicht". Een jonger jaar
  --     afsluiten terwijl een ouder jaar heropend is, zou dat oudere jaar
  --     stilzwijgend weer dichtzetten — zonder gebeurtenis.
  SELECT array_agg(yc.fiscal_year ORDER BY yc.fiscal_year) INTO v_reopened
  FROM public.year_closures yc
  WHERE yc.client_id = _client_id AND yc.fiscal_year < _fiscal_year AND yc.status = 'reopened';

  IF v_reopened IS NOT NULL THEN
    RAISE EXCEPTION 'Boekjaar % staat heropend; sluit dat eerst opnieuw af voordat boekjaar % wordt afgesloten.',
      array_to_string(v_reopened, ', '), _fiscal_year
      USING ERRCODE = '23514';
  END IF;

  -- ── (8) CONTROLE B — AFSLUITVOLGORDE ──────────────────────────────────────
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

  -- ── (11) HET BEWIJS, DE GEBEURTENIS, DAN HET WATERMERK ───────────────────
  IF v_reclose THEN
    IF EXISTS (SELECT 1 FROM public.fiscal_year_events e
               WHERE e.client_id = _client_id AND e.fiscal_year = _fiscal_year
                 AND e.created_xact_id = pg_current_xact_id()) THEN
      RAISE EXCEPTION 'Boekjaar % heeft in deze transactie al een levenscyclusstap gezet; één stap per transactie houdt de geschiedenis eenduidig.',
        _fiscal_year
        USING ERRCODE = '55000';
    END IF;

    --   OPNIEUW AFSLUITEN. Eerst de gebeurtenis — de statusbewaker eist haar in
    --   deze transactie — dan de status, dan het watermerk. closed_at en
    --   closed_by van het bewijs blijven het ORIGINEEL.
    INSERT INTO public.fiscal_year_events
      (client_id, organization_id, fiscal_year, event_type, actor_id, reason, backfilled)
    VALUES (_client_id, v_org, _fiscal_year, 'closed', v_uid, NULL, false)
    RETURNING * INTO v_event;

    UPDATE public.year_closures yc
       SET status = 'closed'
     WHERE yc.client_id = _client_id AND yc.fiscal_year = _fiscal_year
    RETURNING * INTO v_row;

    UPDATE public.clients c
       SET afgesloten_boekjaar = _fiscal_year
     WHERE c.id = _client_id;

    RETURN QUERY SELECT v_row.client_id, v_row.organization_id, v_row.fiscal_year,
                        v_event.occurred_at, v_event.actor_id, true;
    RETURN;
  END IF;

  --   EERSTE AFSLUITING — ongewijzigd ten opzichte van PR B: één tijdstip en
  --   één actor, beide uit de zojuist weggeschreven bewijsrij.
  INSERT INTO public.year_closures (client_id, fiscal_year, organization_id, closed_by, status)
  VALUES (_client_id, _fiscal_year, v_org, v_uid, 'closed')
  RETURNING * INTO v_row;

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

REVOKE ALL ON FUNCTION public.close_fiscal_year(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_fiscal_year(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.close_fiscal_year(uuid, integer) IS
'Sluit één boekjaar af, of sluit een heropend boekjaar opnieuw af. Herkeurt in beide gevallen de volledige gereedheid onder de administratiegrendel, legt een closed-gebeurtenis vast en zet clients.afgesloten_boekjaar — in één transactie. Het originele afsluitbewijs (closed_at/closed_by) blijft staan; een herafsluiting staat als nieuwe gebeurtenis in fiscal_year_events. Weigert zolang een ouder boekjaar heropend is. Maakt GEEN grootboekboeking en raakt de boekingsblokkade niet. Idempotent: een al afgesloten jaar geeft het bewijs terug met created = false. Rolvloer: accountant.';

-- ── 5. Heropenen ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reopen_fiscal_year(
  _client_id   uuid,
  _fiscal_year integer,
  _reason      text
)
RETURNS TABLE (
  client_id           uuid,
  organization_id     uuid,
  fiscal_year         integer,
  status              text,
  event_id            uuid,
  occurred_at         timestamptz,
  actor_id            uuid,
  reason              text,
  afgesloten_boekjaar integer,
  reopened            boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_org        uuid;
  v_reason     text;
  v_client     public.clients%ROWTYPE;
  v_existing   public.year_closures%ROWTYPE;
  v_found      boolean;
  v_highest    integer;
  v_new_mark   integer;
  v_last_type  text;
  v_gap_years  integer[];
  v_event      public.fiscal_year_events%ROWTYPE;
BEGIN
  -- (1) Authenticatie eerst: niets lezen, niets grendelen.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Een heropening kan alleen in een READ COMMITTED transactie (huidig niveau: %)',
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

  -- (2) De reden: getrimd (ook tab, CR, LF), verplicht, hooguit 500 tekens —
  --     dezelfde regel als de CHECK op fiscal_year_events.
  v_reason := NULLIF(btrim(COALESCE(_reason, ''), E' \t\r\n'), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Een heropening vereist een reden' USING ERRCODE = '22004';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'De reden is te lang (maximaal 500 tekens)' USING ERRCODE = '22023';
  END IF;

  -- (3) Autorisatiepoort: "bestaat niet" en "geen rechten" zijn één antwoord.
  SELECT c.organization_id INTO v_org FROM public.clients c WHERE c.id = _client_id;

  IF v_org IS NULL OR NOT public.has_min_role(v_uid, v_org, 'read_only') THEN
    RAISE EXCEPTION 'Administratie niet beschikbaar' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_min_role(v_uid, v_org, 'accountant') THEN
    RAISE EXCEPTION 'Geen rechten om een boekjaar te heropenen voor deze organisatie (accountant vereist)'
      USING ERRCODE = '42501';
  END IF;

  -- (4) Grendels: de administratie, haar rij, dan het afsluitbewijs.
  PERFORM public.lock_ledger_client(_client_id);

  SELECT * INTO v_client FROM public.clients c WHERE c.id = _client_id FOR UPDATE;

  SELECT * INTO v_existing
  FROM public.year_closures yc
  WHERE yc.client_id = _client_id AND yc.fiscal_year = _fiscal_year
  FOR UPDATE;
  v_found := FOUND;

  -- (5) Geen bewijs: niets te heropenen — of een erfenis die niet klopt.
  IF NOT v_found THEN
    IF v_client.afgesloten_boekjaar IS NOT NULL AND _fiscal_year <= v_client.afgesloten_boekjaar THEN
      RAISE EXCEPTION 'Boekjaar % valt onder het watermerk % maar heeft geen afsluitbewijs; de afsluitstand is inconsistent en moet handmatig worden onderzocht.',
        _fiscal_year, v_client.afgesloten_boekjaar
        USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'Boekjaar % is niet afgesloten; er valt niets te heropenen.', _fiscal_year
      USING ERRCODE = '23514';
  END IF;

  IF v_existing.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'Het afsluitbewijs voor boekjaar % hoort bij een andere organisatie dan de administratie; dit moet handmatig worden onderzocht.',
      _fiscal_year
      USING ERRCODE = '23514';
  END IF;

  -- (6) IDEMPOTENT: al heropend is geen fout maar een mededeling, met de
  --     bestaande gebeurtenis erbij. Geen tweede gebeurtenis.
  IF v_existing.status = 'reopened' THEN
    SELECT * INTO v_event
    FROM public.fiscal_year_events e
    WHERE e.client_id = _client_id AND e.fiscal_year = _fiscal_year AND e.event_type = 'reopened'
    ORDER BY e.occurred_at DESC, e.created_xact_id DESC NULLS LAST, e.id DESC
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Boekjaar % staat heropend maar er is geen heropeningsgebeurtenis; de afsluitstand is inconsistent en moet handmatig worden onderzocht.',
        _fiscal_year
        USING ERRCODE = '23514';
    END IF;

    RETURN QUERY SELECT _client_id, v_org, _fiscal_year, v_existing.status, v_event.id,
                        v_event.occurred_at, v_event.actor_id, v_event.reason,
                        v_client.afgesloten_boekjaar, false;
    RETURN;
  END IF;

  -- (7) CONSISTENTIE — vóór er iets verandert. Elk van deze gevallen is een
  --     gebroken stand die een mens moet onderzoeken; niets wordt geraden.

  --   (a) Het watermerk moet exact het hoogste afgesloten jaar zijn.
  SELECT max(yc.fiscal_year) INTO v_highest
  FROM public.year_closures yc
  WHERE yc.client_id = _client_id AND yc.status = 'closed';

  IF v_client.afgesloten_boekjaar IS DISTINCT FROM v_highest THEN
    RAISE EXCEPTION 'Het watermerk (%) is niet het hoogste afgesloten boekjaar met bewijs (%); de afsluitstand is inconsistent en moet handmatig worden onderzocht.',
      COALESCE(v_client.afgesloten_boekjaar::text, 'leeg'), COALESCE(v_highest::text, 'geen')
      USING ERRCODE = '23514';
  END IF;

  --   (b) Alleen het hoogste afgesloten jaar kan worden heropend.
  IF _fiscal_year <> v_highest THEN
    RAISE EXCEPTION 'Alleen het laatst afgesloten boekjaar (%) kan worden heropend; heropen eerst de jongere jaren.',
      v_highest
      USING ERRCODE = '23514';
  END IF;

  --   (c) Geen OUDER jaar mag heropend zijn: een heropend jaar onder een
  --       afgesloten jaar kan via de schrijvers niet ontstaan. Een JONGER
  --       heropend jaar is juist normaal: eerst 2024 heropenen, dan 2023.
  IF EXISTS (SELECT 1 FROM public.year_closures yc
             WHERE yc.client_id = _client_id AND yc.fiscal_year < _fiscal_year AND yc.status = 'reopened') THEN
    RAISE EXCEPTION 'Er staat een ouder boekjaar heropend onder afgesloten boekjaar %; de afsluitstand is inconsistent en moet handmatig worden onderzocht.',
      _fiscal_year
      USING ERRCODE = '23514';
  END IF;

  --   (d) De geschiedenis moet de stand dragen: de laatste gebeurtenis van dit
  --       jaar is een afsluiting.
  SELECT e.event_type INTO v_last_type
  FROM public.fiscal_year_events e
  WHERE e.client_id = _client_id AND e.fiscal_year = _fiscal_year
  ORDER BY e.occurred_at DESC, e.created_xact_id DESC NULLS LAST, e.id DESC
  LIMIT 1;

  IF v_last_type IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'Boekjaar % staat afgesloten maar de gebeurtenisgeschiedenis draagt dat niet (laatste: %); de afsluitstand is inconsistent en moet handmatig worden onderzocht.',
      _fiscal_year, COALESCE(v_last_type, 'geen')
      USING ERRCODE = '23514';
  END IF;

  --   (e) Het nieuwe watermerk is het hoogste jaar dat NA de heropening nog
  --       afgesloten is. Jaren daartussen verliezen de watermerkbescherming.
  --       Hebben zulke jaren boekingen maar geen eigen afsluitbewijs, dan werden
  --       zij alleen beschermd door een watermerk zonder bewijs (de erfenis van
  --       een handmatig gezet watermerk): heropenen zou ze stilzwijgend
  --       meenemen. Fail closed.
  SELECT max(yc.fiscal_year) INTO v_new_mark
  FROM public.year_closures yc
  WHERE yc.client_id = _client_id AND yc.status = 'closed' AND yc.fiscal_year <> _fiscal_year;

  SELECT array_agg(DISTINCT lp.boekjaar ORDER BY lp.boekjaar) INTO v_gap_years
  FROM public.ledger_postings lp
  WHERE lp.client_id = _client_id
    AND lp.boekjaar < _fiscal_year
    AND (v_new_mark IS NULL OR lp.boekjaar > v_new_mark);

  IF v_gap_years IS NOT NULL THEN
    RAISE EXCEPTION 'Heropenen van boekjaar % zou ook boekjaar % openen, dat boekingen heeft maar geen eigen afsluitbewijs; de afsluitstand is inconsistent en moet handmatig worden onderzocht.',
      _fiscal_year, array_to_string(v_gap_years, ', ')
      USING ERRCODE = '23514';
  END IF;

  --   (f) Eén levenscyclusstap per boekjaar per transactie: twee stappen in
  --       één transactie delen tijdstip en transactie en maken "de laatste
  --       gebeurtenis" dubbelzinnig. Via de app gebeurt dat nooit (één RPC =
  --       één transactie); in de SQL-editor wordt het geweigerd.
  IF EXISTS (SELECT 1 FROM public.fiscal_year_events e
             WHERE e.client_id = _client_id AND e.fiscal_year = _fiscal_year
               AND e.created_xact_id = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Boekjaar % heeft in deze transactie al een levenscyclusstap gezet; één stap per transactie houdt de geschiedenis eenduidig.',
      _fiscal_year
      USING ERRCODE = '55000';
  END IF;

  -- (8) DE GEBEURTENIS, DE STAND, HET WATERMERK — in deze volgorde, in één
  --     transactie. Elke bewaker eist de gebeurtenis uit déze transactie.
  --     posting_locked_through wordt NIET aangeraakt.
  INSERT INTO public.fiscal_year_events
    (client_id, organization_id, fiscal_year, event_type, actor_id, reason, backfilled)
  VALUES (_client_id, v_org, _fiscal_year, 'reopened', v_uid, v_reason, false)
  RETURNING * INTO v_event;

  UPDATE public.year_closures yc
     SET status = 'reopened'
   WHERE yc.client_id = _client_id AND yc.fiscal_year = _fiscal_year;

  UPDATE public.clients c
     SET afgesloten_boekjaar = v_new_mark
   WHERE c.id = _client_id;

  RETURN QUERY SELECT _client_id, v_org, _fiscal_year, 'reopened'::text, v_event.id,
                      v_event.occurred_at, v_event.actor_id, v_event.reason,
                      v_new_mark, true;
END
$$;

REVOKE ALL ON FUNCTION public.reopen_fiscal_year(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reopen_fiscal_year(uuid, integer, text) TO authenticated;

COMMENT ON FUNCTION public.reopen_fiscal_year(uuid, integer, text) IS
'Heropent het laatst afgesloten boekjaar van één administratie met een verplichte reden (getrimd, 1-500 tekens). Legt een onuitwisbare reopened-gebeurtenis vast, zet de stand op reopened en verlaagt clients.afgesloten_boekjaar naar het hoogste jaar dat nog afgesloten is (of NULL) — in één transactie, onder de administratiegrendel. Het originele afsluitbewijs blijft staan. Raakt de boekingsblokkade (posting_locked_through) niet en maakt geen grootboekboeking. Idempotent: een al heropend jaar geeft de bestaande gebeurtenis terug met reopened = false. Faalt deterministisch bij een inconsistente stand. Rolvloer: accountant.';
