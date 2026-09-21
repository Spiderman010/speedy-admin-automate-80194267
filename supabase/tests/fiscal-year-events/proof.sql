-- REAL POSTGRESQL PROOF for 6C-b11 PR A — run against a THROWAWAY local
-- cluster. Never run this against any BoekAssist database. See run-proof.sh.
--
-- Twee vragen worden hier beantwoord, en de tweede is de belangrijkste.
--   1. Doet de nieuwe fundering wat zij belooft — onuitwisbaar, tenantveilig,
--      alleen-lezen voor de app, en een backfill die klopt?
--   2. Is er werkelijk NIETS veranderd aan het bestaande gedrag?
--
-- De migratie is op dit punt TWEE KEER toegepast (zie run-proof.sh), dus elke
-- telling hieronder is ook meteen een uitspraak over idempotentie.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ═══ 1-3. De tabel en haar vorm ═════════════════════════════════════════════

DO $$
DECLARE v_kolommen text;
BEGIN
  SELECT string_agg(column_name, ',' ORDER BY column_name)
    INTO v_kolommen
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'fiscal_year_events';

  PERFORM proof.record('1', 'de tabel bestaat', to_regclass('public.fiscal_year_events') IS NOT NULL);
  PERFORM proof.record('2', 'alle gevraagde kolommen staan erin',
    v_kolommen = 'actor_id,backfilled,client_id,event_type,fiscal_year,id,occurred_at,organization_id,reason',
    v_kolommen);
  PERFORM proof.record('3', 'year_closures heeft een statuskolom met de juiste standaard',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'year_closures'
        AND column_name = 'status' AND is_nullable = 'NO' AND column_default LIKE '%closed%'
    ));
END $$;

-- ═══ 4-6. De constraints ════════════════════════════════════════════════════

DO $$
DECLARE v_a uuid;
BEGIN
  SELECT client_id INTO v_a FROM proof.seeded WHERE rol = 'a';

  PERFORM proof.expect_error('4', 'een onbekend soort gebeurtenis wordt geweigerd',
    format($q$INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id)
             VALUES (%L, %L, 2026, 'archived', %L)$q$,
           v_a, '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000e1'),
    'event_type_check');

  PERFORM proof.expect_error('5', 'heropenen zonder reden wordt geweigerd',
    format($q$INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id)
             VALUES (%L, %L, 2026, 'reopened', %L)$q$,
           v_a, '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000e1'),
    'reason_check');

  PERFORM proof.expect_error('5b', 'een reden van alleen witruimte is geen reden',
    format($q$INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id, reason)
             VALUES (%L, %L, 2026, 'reopened', %L, E' \t\n ')$q$,
           v_a, '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000e1'),
    'reason_check');

  PERFORM proof.expect_error('6', 'een boekjaar buiten het bereik wordt geweigerd',
    format($q$INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id)
             VALUES (%L, %L, 1999, 'closed', %L)$q$,
           v_a, '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000e1'),
    'fiscal_year_check');
END $$;

DO $$
DECLARE
  v_a uuid;
  v_ok boolean;
BEGIN
  SELECT client_id INTO v_a FROM proof.seeded WHERE rol = 'a';
  -- Een afsluiting MAG zonder reden. Dat is het spiegelbeeld van bewijs 5 en
  -- voorkomt dat de constraint per ongeluk te streng is geschreven.
  INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id)
  VALUES (v_a, '00000000-0000-0000-0000-00000000a001', 2099, 'closed',
          '00000000-0000-0000-0000-0000000000e1');
  v_ok := true;
  PERFORM proof.record('7', 'een afsluiting mag WEL zonder reden', v_ok);
  -- En een heropening MET reden mag ook gewoon.
  INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id, reason)
  VALUES (v_a, '00000000-0000-0000-0000-00000000a001', 2099, 'reopened',
          '00000000-0000-0000-0000-0000000000e1', 'Correctie op verzoek van de klant');
  PERFORM proof.record('8', 'een heropening met reden wordt aanvaard', true);
END $$;

-- ═══ 9. Tenantintegriteit ═══════════════════════════════════════════════════

DO $$
DECLARE v_a uuid;
BEGIN
  SELECT client_id INTO v_a FROM proof.seeded WHERE rol = 'a';
  PERFORM proof.expect_error('9', 'een gebeurtenis kan niet onder de vlag van een andere organisatie',
    format($q$INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id)
             VALUES (%L, %L, 2026, 'closed', %L)$q$,
           v_a, '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000e1'),
    'buiten de organisatie');
END $$;

-- ═══ 10-12. Onuitwisbaarheid ════════════════════════════════════════════════

DO $$
BEGIN
  PERFORM proof.expect_error('10', 'een gebeurtenis kan niet worden gewijzigd',
    $q$UPDATE public.fiscal_year_events SET event_type = 'reopened' WHERE fiscal_year = 2024$q$,
    'append-only');

  PERFORM proof.expect_error('11', 'een gebeurtenis kan niet worden verwijderd',
    $q$DELETE FROM public.fiscal_year_events WHERE fiscal_year = 2024$q$,
    'append-only');

  PERFORM proof.expect_error('12', 'de geschiedenis overleeft ook TRUNCATE',
    'TRUNCATE public.fiscal_year_events', 'append-only');
END $$;

DO $$
DECLARE v_altijd integer;
BEGIN
  -- ENABLE ALWAYS, niet ENABLE: anders schakelt session_replication_role de
  -- grendel stilletjes uit. tgenabled = 'A' is ALWAYS.
  SELECT count(*) INTO v_altijd
  FROM pg_trigger
  WHERE tgrelid = 'public.fiscal_year_events'::regclass
    AND tgname IN ('prevent_fiscal_year_event_mutation_trigger',
                   'prevent_fiscal_year_event_truncate_trigger')
    AND tgenabled = 'A';
  PERFORM proof.record('13', 'beide mutatiegrendels staan op ENABLE ALWAYS', v_altijd = 2,
                       format('%s van 2', v_altijd));
END $$;

-- ═══ 14-15. Rechten en RLS ══════════════════════════════════════════════════

DO $$
BEGIN
  PERFORM proof.record('14', 'applicatierollen mogen de geschiedenis alleen lezen',
    has_table_privilege('authenticated', 'public.fiscal_year_events', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.fiscal_year_events', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.fiscal_year_events', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.fiscal_year_events', 'DELETE')
      AND NOT has_table_privilege('anon', 'public.fiscal_year_events', 'SELECT'),
    'SELECT ja; INSERT/UPDATE/DELETE nee; anon niets');

  PERFORM proof.record('15', 'de leespolicy volgt hetzelfde rolmodel als year_closures',
    (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy
      WHERE polrelid = 'public.fiscal_year_events'::regclass
        AND polname = 'role_fiscal_year_events_select')
    = (SELECT replace(pg_get_expr(polqual, polrelid), 'year_closures', 'fiscal_year_events')
       FROM pg_policy
       WHERE polrelid = 'public.year_closures'::regclass
         AND polname = 'role_year_closures_select'),
    (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy
      WHERE polrelid = 'public.fiscal_year_events'::regclass
        AND polname = 'role_fiscal_year_events_select'));

  PERFORM proof.record('15b', 'RLS staat aan',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fiscal_year_events'::regclass));
END $$;

-- ═══ 16-20. DE BACKFILL ═════════════════════════════════════════════════════

DO $$
DECLARE
  v_a uuid;
  v_b uuid;
  v_c uuid;
  v_aantal_a integer;
  v_aantal_b integer;
  v_aantal_c integer;
  v_afwijkend integer;
  v_redenen integer;
  v_soorten integer;
BEGIN
  SELECT client_id INTO v_a FROM proof.seeded WHERE rol = 'a';
  SELECT client_id INTO v_b FROM proof.seeded WHERE rol = 'b';
  SELECT client_id INTO v_c FROM proof.seeded WHERE rol = 'c';

  SELECT count(*) INTO v_aantal_a FROM public.fiscal_year_events WHERE client_id = v_a AND backfilled;
  SELECT count(*) INTO v_aantal_b FROM public.fiscal_year_events WHERE client_id = v_b AND backfilled;
  SELECT count(*) INTO v_aantal_c FROM public.fiscal_year_events WHERE client_id = v_c AND backfilled;

  PERFORM proof.record('16', 'elke afsluitrij heeft precies één gebeurtenis gekregen',
    v_aantal_a = 2 AND v_aantal_b = 1,
    format('A = %s (verwacht 2), B = %s (verwacht 1)', v_aantal_a, v_aantal_b));

  -- HET BELANGRIJKSTE BEWIJS VAN DEZE MIGRATIE.
  PERFORM proof.record('17', 'een HANDMATIG watermerk zonder afsluitbewijs is NIET gebackfild',
    v_aantal_c = 0,
    format('C heeft %s gebeurtenissen; afgesloten_boekjaar = %s',
           v_aantal_c,
           (SELECT afgesloten_boekjaar FROM public.clients WHERE id = v_c)));

  -- Elk veld moet uit de afsluitrij komen, niet uit een aanname. Eén query die
  -- élke afwijking telt, in plaats van een steekproef op één rij.
  SELECT count(*) INTO v_afwijkend
  FROM public.year_closures yc
  LEFT JOIN public.fiscal_year_events fye
    ON fye.client_id = yc.client_id AND fye.fiscal_year = yc.fiscal_year AND fye.backfilled
  WHERE fye.id IS NULL
     OR fye.occurred_at IS DISTINCT FROM yc.closed_at
     OR fye.actor_id IS DISTINCT FROM yc.closed_by
     OR fye.organization_id IS DISTINCT FROM yc.organization_id
     OR fye.event_type <> 'closed'
     OR fye.reason IS NOT NULL;

  PERFORM proof.record('18', 'closed_at → occurred_at, closed_by → actor_id, reden blijft leeg',
    v_afwijkend = 0, format('%s afwijkende rijen', v_afwijkend));

  -- De migratie is twee keer toegepast. Zonder de invariant uit sectie 4 zou
  -- elk aantal hierboven nu verdubbeld zijn.
  PERFORM proof.record('19', 'een tweede migratieronde verdubbelt niets',
    (SELECT count(*) FROM public.fiscal_year_events WHERE backfilled)
      = (SELECT count(*) FROM public.year_closures),
    format('%s gebeurtenissen tegenover %s afsluitrijen',
           (SELECT count(*) FROM public.fiscal_year_events WHERE backfilled),
           (SELECT count(*) FROM public.year_closures)));

  SELECT count(*) INTO v_soorten FROM public.fiscal_year_events WHERE backfilled AND event_type <> 'closed';
  SELECT count(*) INTO v_redenen FROM public.fiscal_year_events WHERE backfilled AND reason IS NOT NULL;
  PERFORM proof.record('20', 'de backfill verzint geen soort en geen reden',
    v_soorten = 0 AND v_redenen = 0);
END $$;

-- ═══ 21-22. De invariant zelf ═══════════════════════════════════════════════

DO $$
DECLARE v_a uuid;
BEGIN
  SELECT client_id INTO v_a FROM proof.seeded WHERE rol = 'a';

  PERFORM proof.expect_error('21', 'een tweede backfill-gebeurtenis voor hetzelfde jaar is onmogelijk',
    format($q$INSERT INTO public.fiscal_year_events
               (client_id, organization_id, fiscal_year, event_type, actor_id, backfilled)
             VALUES (%L, %L, 2024, 'closed', %L, true)$q$,
           v_a, '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000e1'),
    'uniq_fiscal_year_events_backfill');
END $$;

DO $$
DECLARE
  v_a uuid;
  v_aantal integer;
BEGIN
  SELECT client_id INTO v_a FROM proof.seeded WHERE rol = 'a';
  -- DE ANDERE KANT VAN DIE INVARIANT, en minstens zo belangrijk: de hele
  -- herziening bestaat om closed → reopened → closed mogelijk te maken. Een
  -- uniciteitsregel op (administratie, boekjaar) zou dat voorgoed blokkeren.
  INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id, reason)
  VALUES (v_a, '00000000-0000-0000-0000-00000000a001', 2024, 'reopened',
          '00000000-0000-0000-0000-0000000000e1', 'Correctie loonjournaalpost'),
         (v_a, '00000000-0000-0000-0000-00000000a001', 2024, 'closed',
          '00000000-0000-0000-0000-0000000000e1', NULL),
         (v_a, '00000000-0000-0000-0000-00000000a001', 2024, 'reopened',
          '00000000-0000-0000-0000-0000000000e1', 'Nog een correctie');

  SELECT count(*) INTO v_aantal
  FROM public.fiscal_year_events WHERE client_id = v_a AND fiscal_year = 2024;

  PERFORM proof.record('22', 'meerdere latere gebeurtenissen per boekjaar blijven mogelijk',
    v_aantal = 4, format('%s gebeurtenissen voor 2024 (1 backfill + 3 nieuwe)', v_aantal));
END $$;

-- ═══ 23-27. GEEN GEDRAGSWIJZIGING ═══════════════════════════════════════════

DO $$
DECLARE
  v_c uuid;
  v_pk text;
  v_bron text;
BEGIN
  -- De primary key van year_closures is de idempotentiegarantie van de
  -- afsluitschrijver. Zij mag niet zijn aangeraakt.
  SELECT pg_get_constraintdef(oid) INTO v_pk
  FROM pg_constraint WHERE conrelid = 'public.year_closures'::regclass AND contype = 'p';
  PERFORM proof.record('23', 'de primary key van year_closures is ongewijzigd',
    v_pk = 'PRIMARY KEY (client_id, fiscal_year)', v_pk);

  -- De afsluitschrijver zelf: zelfde handtekening, en nog steeds geen weet van
  -- de nieuwe tabel. PR B voegt dat toe, niet PR A.
  SELECT prosrc INTO v_bron FROM pg_proc WHERE proname = 'close_fiscal_year';
  /*
   * Gericht op wat de schrijver DOET, niet op een woord: `status` komt in deze
   * functie al voor als de status van een inkoop- of verkoopfactuur
   * (`pi.status IN (…)`), en dat heeft niets met de nieuwe kolom te maken. Een
   * kale zoektocht naar "status" zou hier dus altijd afgaan.
   */
  PERFORM proof.record('24', 'close_fiscal_year() schrijft (nog) geen gebeurtenis en geen status',
    v_bron NOT LIKE '%fiscal_year_events%'
      AND v_bron !~ 'INSERT INTO public\.year_closures[^;]*status'
      AND v_bron !~ 'SET\s+status',
    'geen verwijzing naar fiscal_year_events, geen status in de INSERT');

  PERFORM proof.record('25', 'de handtekening van close_fiscal_year() is ongewijzigd',
    (SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'close_fiscal_year')
      = '_client_id uuid, _fiscal_year integer');

  -- Het watermerk staat nog waar het stond, ook bij de erfenisadministratie.
  SELECT client_id INTO v_c FROM proof.seeded WHERE rol = 'c';
  PERFORM proof.record('26', 'clients.afgesloten_boekjaar is door de migratie niet aangeraakt',
    (SELECT afgesloten_boekjaar FROM public.clients WHERE id = v_c) = 2023);

  -- Geen boekingsblokkade, geen heropen-RPC, geen posting_allowed(): PR A voegt
  -- geen enkel gedrag toe.
  PERFORM proof.record('27', 'er is geen boekingsblokkade en geen heropen-RPC bijgekomen',
    NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND (p.proname ~ 'posting_allowed|posting_lock|reopen|heropen')
    )
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'clients'
        AND column_name ~ 'posting_lock|locked_through'
    ));
END $$;

DO $$
DECLARE v_ongewijzigd integer;
BEGIN
  -- De acht schrijvers dragen nog exact hun eigen afgesloten-jaar-toets. Dit is
  -- de SQL-kant van src/test/year-close-coupling.test.ts.
  SELECT count(*) INTO v_ongewijzigd
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosrc LIKE '%afgesloten_boekjaar IS NOT NULL%'
    AND p.prosrc LIKE '%is afgesloten voor deze administratie%';

  -- In dit harnas draaien er vier van de acht (inkoop, verkoop, bank en de
  -- tegenboeking hebben hun eigen migraties die hier niet worden toegepast):
  -- post_manual_journal, post_opening_balance en declare_opening_balance_nil.
  PERFORM proof.record('28', 'de toegepaste schrijvers houden hun afgesloten-jaar-toets',
    v_ongewijzigd >= 3, format('%s schrijvers met de oorspronkelijke toets', v_ongewijzigd));
END $$;

DO $$
DECLARE
  v_b uuid;
  v_fout text;
BEGIN
  -- En het sluitstuk: boeken in een afgesloten jaar wordt nog steeds geweigerd,
  -- met dezelfde melding als voor de migratie. Heropenen bestaat niet.
  SELECT client_id INTO v_b FROM proof.seeded WHERE rol = 'b';
  BEGIN
    PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);
    UPDATE public.clients SET afgesloten_boekjaar = 2023 WHERE id = v_b;
    v_fout := NULL;
  EXCEPTION WHEN others THEN
    v_fout := SQLERRM;
  END;
  PERFORM proof.record('29', 'het watermerk kan nog steeds niet omlaag — heropenen bestaat niet',
    v_fout IS NOT NULL AND position('kan niet omlaag' IN v_fout) > 0,
    COALESCE(v_fout, 'GEEN fout, terwijl een weigering werd verwacht'));
END $$;
