-- REAL POSTGRESQL PROOF for 6C-b11 PR B — run against a THROWAWAY local
-- cluster. Never run this against any BoekAssist database. See run-proof.sh.
--
-- De vraag is drieledig. Legt een NIEUWE afsluiting werkelijk één gebeurtenis
-- vast, met exact hetzelfde tijdstip en dezelfde actor als het bewijs? Voegt
-- een HERHALING aantoonbaar niets toe? En is alles wat er al was — de
-- herkeuring, de rechten, het watermerk, de gebackfilde geschiedenis —
-- onveranderd gebleven?

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS proof.subject (rol text PRIMARY KEY, client_id uuid NOT NULL);

-- ═══ 1-10. EEN NIEUWE AFSLUITING ════════════════════════════════════════════

DO $$
DECLARE
  v_c        uuid := proof.new_client('PR B — nieuwe afsluiting');
  v_created  boolean;
  v_sluit    public.year_closures%ROWTYPE;
  v_gebeurt  public.fiscal_year_events%ROWTYPE;
  v_aantal_s integer;
  v_aantal_g integer;
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  INSERT INTO proof.subject VALUES ('nieuw', v_c);

  v_created := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);

  SELECT count(*) INTO v_aantal_s FROM public.year_closures WHERE client_id = v_c;
  SELECT count(*) INTO v_aantal_g FROM public.fiscal_year_events WHERE client_id = v_c;
  SELECT * INTO v_sluit FROM public.year_closures WHERE client_id = v_c AND fiscal_year = 2026;
  SELECT * INTO v_gebeurt FROM public.fiscal_year_events WHERE client_id = v_c AND fiscal_year = 2026;

  PERFORM proof.record('1', 'een nieuwe afsluiting levert precies één afsluitbewijs op',
    v_created = true AND v_aantal_s = 1, format('created = %s, %s bewijzen', v_created, v_aantal_s));

  PERFORM proof.record('2', 'en precies één gebeurtenis, niet-gebackfild en van het soort closed',
    v_aantal_g = 1 AND v_gebeurt.backfilled = false AND v_gebeurt.event_type = 'closed',
    format('%s gebeurtenissen, backfilled = %s, soort = %s',
           v_aantal_g, v_gebeurt.backfilled, v_gebeurt.event_type));

  PERFORM proof.record('3', 'de administratie van de gebeurtenis is die van het bewijs',
    v_gebeurt.client_id = v_sluit.client_id);

  PERFORM proof.record('4', 'de organisatie van de gebeurtenis is die van het bewijs',
    v_gebeurt.organization_id = v_sluit.organization_id);

  PERFORM proof.record('5', 'het boekjaar van de gebeurtenis is dat van het bewijs',
    v_gebeurt.fiscal_year = v_sluit.fiscal_year AND v_gebeurt.fiscal_year = 2026);

  -- HET KERNBEWIJS VAN DEZE PR. Niet "ongeveer gelijk" of "binnen een seconde",
  -- maar exact dezelfde waarde — want beide komen uit dezelfde weggeschreven rij.
  PERFORM proof.record('6', 'occurred_at is EXACT gelijk aan closed_at',
    v_gebeurt.occurred_at = v_sluit.closed_at,
    format('gebeurtenis %s / bewijs %s', v_gebeurt.occurred_at, v_sluit.closed_at));

  PERFORM proof.record('7', 'actor_id is EXACT gelijk aan closed_by',
    v_gebeurt.actor_id = v_sluit.closed_by
      AND v_gebeurt.actor_id = '00000000-0000-0000-0000-0000000000e1',
    format('gebeurtenis %s / bewijs %s', v_gebeurt.actor_id, v_sluit.closed_by));

  PERFORM proof.record('8', 'de gebeurtenis draagt geen reden', v_gebeurt.reason IS NULL);

  PERFORM proof.record('9', 'backfilled is false — dit is een waargenomen gebeurtenis',
    v_gebeurt.backfilled = false);

  PERFORM proof.record('10', 'het bewijs krijgt expliciet de status closed',
    v_sluit.status = 'closed', v_sluit.status);

  PERFORM proof.record('11', 'het watermerk is precies zoals voorheen vooruitgezet',
    (SELECT afgesloten_boekjaar FROM public.clients WHERE id = v_c) = 2026);
END $$;

-- ═══ 12-15. EEN HERHALING VOEGT NIETS TOE ═══════════════════════════════════

DO $$
DECLARE
  v_c            uuid;
  v_created      boolean;
  v_tijd_voor    timestamptz;
  v_tijd_na      timestamptz;
  v_sluit_voor   timestamptz;
  v_sluit_na     timestamptz;
  v_aantal       integer;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'nieuw';

  SELECT occurred_at INTO v_tijd_voor  FROM public.fiscal_year_events WHERE client_id = v_c;
  SELECT closed_at   INTO v_sluit_voor FROM public.year_closures      WHERE client_id = v_c;

  -- Twee extra pogingen, precies zoals een herhaling na een time-out.
  v_created := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);
  PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);

  SELECT count(*) INTO v_aantal FROM public.fiscal_year_events WHERE client_id = v_c;
  SELECT occurred_at INTO v_tijd_na  FROM public.fiscal_year_events WHERE client_id = v_c;
  SELECT closed_at   INTO v_sluit_na FROM public.year_closures      WHERE client_id = v_c;

  PERFORM proof.record('12', 'een tweede afsluiting geeft created = false',
    v_created = false, format('created = %s', v_created));

  PERFORM proof.record('13', 'en voegt GEEN tweede gebeurtenis toe', v_aantal = 1,
    format('%s gebeurtenissen na drie pogingen', v_aantal));

  PERFORM proof.record('14', 'het tijdstip van de gebeurtenis is niet verschoven',
    v_tijd_na = v_tijd_voor, format('%s → %s', v_tijd_voor, v_tijd_na));

  PERFORM proof.record('15', 'het tijdstip van het bewijs is niet verschoven',
    v_sluit_na = v_sluit_voor, format('%s → %s', v_sluit_voor, v_sluit_na));
END $$;

-- ═══ 16-19. DE BESTAANDE POORTEN STAAN ER NOG ═══════════════════════════════

DO $$
DECLARE v_c uuid := proof.new_client('PR B — poorten');
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  INSERT INTO proof.subject VALUES ('poorten', v_c);

  PERFORM proof.expect_error('16', 'een assistent kan nog steeds niet afsluiten',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e2', v_c),
    'accountant vereist');

  PERFORM proof.expect_error('17', 'een gebruiker van een andere organisatie wordt nog steeds geweigerd',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e3', v_c),
    'Administratie niet beschikbaar');

  PERFORM proof.record('16b', 'en die geweigerde pogingen lieten geen gebeurtenis achter',
    (SELECT count(*) FROM public.fiscal_year_events WHERE client_id = v_c) = 0);
END $$;

DO $$
DECLARE v_c uuid := proof.new_client('PR B — jaarvolgorde');
BEGIN
  PERFORM proof.seed_group(v_c, 2025);
  PERFORM proof.seed_group(v_c, 2026);
  PERFORM proof.expect_error('18', 'de jaarvolgorde blokkeert nog steeds',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e1', v_c),
    'oudere boekjaren met boekingen');
  PERFORM proof.record('18b', 'ook daar is geen gebeurtenis ontstaan',
    (SELECT count(*) FROM public.fiscal_year_events WHERE client_id = v_c) = 0);
END $$;

DO $$
DECLARE v_c uuid := proof.new_client('PR B — herkeuring bronwerk');
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  INSERT INTO public.purchase_invoices (client_id, status, invoice_date)
  VALUES (v_c, 'gecontroleerd', DATE '2026-03-01');
  PERFORM proof.expect_error('19', 'de herkeuring van openstaand bronwerk werkt onverkort',
    format('SELECT proof.close_as(%L, %L, 2026)', '00000000-0000-0000-0000-0000000000e1', v_c),
    'postbaar brondocument');
  PERFORM proof.record('19b', 'en ook dan blijft de geschiedenis leeg',
    (SELECT count(*) FROM public.fiscal_year_events WHERE client_id = v_c) = 0);
END $$;

-- ═══ 20-21. ATOMICITEIT ═════════════════════════════════════════════════════

DO $$
DECLARE
  v_c        uuid := proof.new_client('PR B — atomiciteit');
  v_msg      text;
  v_bewijzen integer;
  v_watermerk integer;
  v_hersteld boolean;
  v_na_herstel integer;
BEGIN
  PERFORM proof.seed_group(v_c, 2026);

  /*
   * De gebeurtenis laten falen en kijken wat er overblijft. Een trigger die
   * weigert is het scherpste instrument: hij grijpt precies daar in waar PR B
   * iets heeft toegevoegd, en laat de rest van de functie ongemoeid. Alleen de
   * eigenaar van de tabel kan hem plaatsen, dus dit is geen weg die de
   * applicatie ooit zou kunnen bewandelen.
   */
  CREATE OR REPLACE FUNCTION proof.weiger_gebeurtenis() RETURNS trigger
  LANGUAGE plpgsql AS $t$
  BEGIN
    RAISE EXCEPTION 'proefstoring bij het schrijven van de gebeurtenis' USING ERRCODE = '22000';
  END $t$;

  CREATE TRIGGER zzz_proef_weiger_gebeurtenis
    BEFORE INSERT ON public.fiscal_year_events
    FOR EACH ROW EXECUTE FUNCTION proof.weiger_gebeurtenis();

  BEGIN
    PERFORM proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);
    v_msg := NULL;
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;

  DROP TRIGGER zzz_proef_weiger_gebeurtenis ON public.fiscal_year_events;

  SELECT count(*) INTO v_bewijzen FROM public.year_closures WHERE client_id = v_c;
  SELECT afgesloten_boekjaar INTO v_watermerk FROM public.clients WHERE id = v_c;

  PERFORM proof.record('20', 'faalt de gebeurtenis, dan blijft er GEEN afsluitbewijs achter',
    v_msg IS NOT NULL AND v_bewijzen = 0,
    format('fout = %s, bewijzen = %s', COALESCE(v_msg, 'geen'), v_bewijzen));

  PERFORM proof.record('21', 'en is het watermerk NIET vooruitgezet',
    v_watermerk IS NULL, format('watermerk = %s', COALESCE(v_watermerk::text, 'leeg')));

  /*
   * En daarna werkt het gewoon: de administratie is niet beschadigd
   * achtergebleven.
   *
   * De afsluiting en de telling staan bewust in APARTE statements. In één
   * booleaanse expressie (`close_as(...) = true AND (SELECT count(*) …) = 1`)
   * garandeert PostgreSQL geen volgorde van links naar rechts, en dan kan de
   * subquery de stand van vóór de afsluiting zien — waarna de test faalt op
   * zijn eigen evaluatievolgorde in plaats van op het gedrag.
   */
  v_hersteld := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);
  SELECT count(*) INTO v_na_herstel FROM public.fiscal_year_events WHERE client_id = v_c;

  PERFORM proof.record('21b', 'na het opheffen van de storing sluit hetzelfde jaar gewoon af',
    v_hersteld = true AND v_na_herstel = 1,
    format('created = %s, %s gebeurtenis(sen)', v_hersteld, v_na_herstel));
END $$;

-- ═══ 22. BEVEILIGING ════════════════════════════════════════════════════════

DO $$
BEGIN
  PERFORM proof.record('22', 'authenticated kan nog steeds niet zelf een gebeurtenis schrijven',
    NOT has_table_privilege('authenticated', 'public.fiscal_year_events', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.fiscal_year_events', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.fiscal_year_events', 'DELETE')
      AND has_table_privilege('authenticated', 'public.fiscal_year_events', 'SELECT')
      AND NOT has_table_privilege('anon', 'public.fiscal_year_events', 'SELECT'),
    'alleen SELECT voor authenticated; anon niets');

  PERFORM proof.record('22b', 'de rechten op de RPC zijn niet verbreed',
    has_function_privilege('authenticated', 'public.close_fiscal_year(uuid, integer)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.close_fiscal_year(uuid, integer)', 'EXECUTE')
      AND NOT has_function_privilege('service_role', 'public.close_fiscal_year(uuid, integer)', 'EXECUTE'));

  PERFORM proof.record('22c', 'de functie is nog steeds SECURITY DEFINER met vast zoekpad',
    (SELECT prosecdef FROM pg_proc WHERE proname = 'close_fiscal_year')
      AND (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE proname = 'close_fiscal_year')
          = 'search_path=public');
END $$;

-- ═══ 23-24. DE TOEKOMST EN HET VERLEDEN ═════════════════════════════════════

DO $$
DECLARE
  v_c     uuid;
  v_aantal integer;
BEGIN
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'nieuw';
  -- De levenscyclus moet open blijven: closed → reopened → closed. De
  -- gebeurtenis van PR B mag daar niets aan in de weg leggen.
  INSERT INTO public.fiscal_year_events
    (client_id, organization_id, fiscal_year, event_type, actor_id, reason)
  VALUES (v_c, '00000000-0000-0000-0000-00000000a001', 2026, 'reopened',
          '00000000-0000-0000-0000-0000000000e1', 'Correctie na controle'),
         (v_c, '00000000-0000-0000-0000-00000000a001', 2026, 'closed',
          '00000000-0000-0000-0000-0000000000e1', NULL);

  SELECT count(*) INTO v_aantal FROM public.fiscal_year_events WHERE client_id = v_c AND fiscal_year = 2026;
  PERFORM proof.record('23', 'meerdere latere gebeurtenissen per boekjaar blijven mogelijk',
    v_aantal = 3, format('%s gebeurtenissen (1 van de afsluiting + 2 latere)', v_aantal));
END $$;

DO $$
DECLARE
  v_a        uuid;
  v_gebackfild integer;
  v_afwijkend  integer;
BEGIN
  SELECT client_id INTO v_a FROM proof.seeded WHERE rol = 'a';

  SELECT count(*) INTO v_gebackfild FROM public.fiscal_year_events WHERE backfilled;

  -- De gebackfilde geschiedenis uit PR A moet ongemoeid zijn gebleven: geen
  -- extra rijen, en elk veld nog gelijk aan het bewijs waaruit zij komt.
  SELECT count(*) INTO v_afwijkend
  FROM public.fiscal_year_events fye
  JOIN public.year_closures yc
    ON yc.client_id = fye.client_id AND yc.fiscal_year = fye.fiscal_year
  WHERE fye.backfilled
    AND (fye.occurred_at IS DISTINCT FROM yc.closed_at
      OR fye.actor_id IS DISTINCT FROM yc.closed_by
      OR fye.reason IS NOT NULL);

  PERFORM proof.record('24', 'de gebackfilde gebeurtenissen van PR A zijn onaangeroerd',
    v_gebackfild = 3 AND v_afwijkend = 0,
    format('%s gebackfilde rijen, %s afwijkend', v_gebackfild, v_afwijkend));

  -- En administratie C uit PR A — handmatig watermerk zonder bewijs — heeft nog
  -- steeds niets, ook niet na deze migratie.
  PERFORM proof.record('24b', 'het handmatige watermerk zonder bewijs heeft nog steeds geen geschiedenis',
    (SELECT count(*) FROM public.fiscal_year_events
      WHERE client_id = (SELECT client_id FROM proof.seeded WHERE rol = 'c')) = 0);
END $$;

-- ═══ 25. DE HANDTEKENING EN DE RETOURVORM ═══════════════════════════════════

DO $$
DECLARE v_retour text;
BEGIN
  PERFORM proof.record('25', 'de handtekening van de RPC is ongewijzigd',
    (SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'close_fiscal_year')
      = '_client_id uuid, _fiscal_year integer');

  SELECT pg_get_function_result(oid) INTO v_retour FROM pg_proc WHERE proname = 'close_fiscal_year';
  PERFORM proof.record('26', 'de retourvorm is ongewijzigd — zes kolommen, dezelfde namen en typen',
    v_retour = 'TABLE(client_id uuid, organization_id uuid, fiscal_year integer, closed_at timestamp with time zone, closed_by uuid, created boolean)',
    v_retour);

  -- Geen heropening en geen boekingsblokkade: PR B voegt géén nieuw gedrag toe.
  PERFORM proof.record('27', 'er is nog steeds geen heropen-RPC en geen boekingsblokkade',
    NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname ~ 'posting_allowed|posting_lock|reopen|heropen'
    )
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'clients'
        AND column_name ~ 'posting_lock|locked_through'
    ));
END $$;

DO $$
DECLARE v_c uuid;
BEGIN
  -- Het watermerk kan nog steeds niet omlaag: de grendel van 6C-b10 is niet
  -- aangeraakt, en heropenen bestaat niet.
  SELECT client_id INTO v_c FROM proof.subject WHERE rol = 'nieuw';
  PERFORM proof.expect_error('28', 'het watermerk kan nog steeds niet omlaag',
    format('UPDATE public.clients SET afgesloten_boekjaar = 2025 WHERE id = %L', v_c),
    'kan niet omlaag');

  PERFORM proof.expect_error('29', 'een afsluitbewijs is nog steeds onwijzigbaar',
    format($q$UPDATE public.year_closures SET status = 'reopened' WHERE client_id = %L$q$, v_c),
    'append-only');
END $$;
