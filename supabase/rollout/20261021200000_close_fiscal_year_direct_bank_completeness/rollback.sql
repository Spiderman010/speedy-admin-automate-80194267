-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK van 20261021200000_close_fiscal_year_direct_bank_completeness.
--
-- Alleen met akkoord van de eigenaar, in de Lovable Cloud SQL editor van
-- project alxlbdhpbwlehbdbfejw, na visuele bevestiging van de projectref.
--
-- Zet public.close_fiscal_year(uuid, integer) byte-gelijk terug naar het
-- lichaam van PR E (20261001120000_add_fiscal_year_reopen.sql, sectie 4,
-- regels 262–561), met dezelfde REVOKE/GRANT en het oude commentaar.
-- Data-neutraal: er wordt geen rij gewijzigd. Daarna telt de afsluiting
-- gecodeerde, nog niet geboekte bankregels weer NIET mee en telt zij bronrijen
-- weer zonder organisatiefilter (het gedrag van vóór P7).
--
-- Verwacht na afloop: md5(prosrc) van close_fiscal_year =
-- 14cdfaa498bbbc305e95dbf0faa52e26 (het PR E-lichaam). Het harnas
-- supabase/tests/close-bank-completeness/ voert dit bestand twee keer uit en
-- bewijst dat.
-- ═════════════════════════════════════════════════════════════════════════════

-- Alleen vanuit de beoordeelde toestand: de functie is die van P7 (of al die
-- van PR E, bij een tweede uitvoering). Anders gebeurt er niets.
DO $rollback$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.close_fiscal_year(uuid,integer)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('aea0f0adc7e44613112615365d4eb38a', '14cdfaa498bbbc305e95dbf0faa52e26') THEN
    RAISE EXCEPTION 'Rollback geweigerd: close_fiscal_year is niet de beoordeelde versie (md5 %). Niets is gewijzigd.', v_md5
      USING ERRCODE = '55000';
  END IF;
END
$rollback$;

-- ── Letterlijk 20261001120000_add_fiscal_year_reopen.sql, regels 262–561 ────

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
