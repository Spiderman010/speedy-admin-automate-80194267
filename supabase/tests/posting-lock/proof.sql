-- REAL POSTGRESQL PROOF for 6C-b11 PR C — run against a THROWAWAY local
-- cluster. Never run this against any BoekAssist database. See run-proof.sh.
--
-- Drie vragen. Is de boekingsblokkade werkelijk LEEG begonnen, ook bij
-- administraties met afgesloten boekjaren? Doet de schrijver wat hij belooft —
-- met reden, met audit, met de juiste rolvloer en zonder auditruis? En staat
-- het nieuwe besturingselement aantoonbaar LOS van de jaarafsluiting?

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

/** De blokkade zetten als een bepaalde gebruiker. */
CREATE OR REPLACE FUNCTION proof.lock_as(_uid uuid, _client uuid, _through date, _reason text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_changed boolean;
BEGIN
  PERFORM set_config('test.user_id', _uid::text, true);
  SELECT s.changed INTO v_changed FROM public.set_posting_lock(_client, _through, _reason) s;
  RETURN v_changed;
END $$;

-- ═══ 1-4. GEEN BACKFILL ═════════════════════════════════════════════════════

DO $$
DECLARE
  v_niet_null integer;
  v_dicht     uuid;
  v_hand      uuid;
BEGIN
  SELECT client_id INTO v_dicht FROM proof.lock_subject WHERE rol = 'dicht';
  SELECT client_id INTO v_hand  FROM proof.lock_subject WHERE rol = 'handmatig';

  SELECT count(*) INTO v_niet_null FROM public.clients WHERE posting_locked_through IS NOT NULL;

  PERFORM proof.record('1', 'geen enkele bestaande administratie heeft een blokkade gekregen',
    v_niet_null = 0, format('%s administraties met een blokkade', v_niet_null));

  -- HET KERNBEWIJS VAN DE ONAFHANKELIJKHEID, eerste helft: een boekjaar kan
  -- afgesloten zijn terwijl er géén boekingsblokkade bestaat.
  PERFORM proof.record('2', 'een NETJES afgesloten boekjaar leidde tot geen blokkade',
    (SELECT posting_locked_through FROM public.clients WHERE id = v_dicht) IS NULL
      AND (SELECT afgesloten_boekjaar FROM public.clients WHERE id = v_dicht) = 2025,
    format('watermerk = %s, blokkade = %s',
           (SELECT afgesloten_boekjaar FROM public.clients WHERE id = v_dicht),
           COALESCE((SELECT posting_locked_through FROM public.clients WHERE id = v_dicht)::text, 'geen')));

  PERFORM proof.record('3', 'ook een handmatig watermerk leidde tot geen blokkade',
    (SELECT posting_locked_through FROM public.clients WHERE id = v_hand) IS NULL);

  PERFORM proof.record('4', 'en er is geen enkele blokkadegebeurtenis uit het niets ontstaan',
    (SELECT count(*) FROM public.posting_lock_events) = 0);
END $$;

DO $$
DECLARE
  v_c       uuid := proof.new_client('Blokkade — afsluiten zet niets');
  v_created boolean;
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  INSERT INTO proof.lock_subject VALUES ('nieuw_dicht', v_c);

  v_created := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);

  -- Tweede helft van de onafhankelijkheid: ook een afsluiting die NU gebeurt
  -- zet geen blokkade en schrijft geen blokkadegebeurtenis.
  PERFORM proof.record('5', 'close_fiscal_year() zet de boekingsblokkade NIET',
    v_created = true
      AND (SELECT posting_locked_through FROM public.clients WHERE id = v_c) IS NULL
      AND (SELECT count(*) FROM public.posting_lock_events WHERE client_id = v_c) = 0,
    format('afgesloten = %s, blokkade = %s',
           v_created,
           COALESCE((SELECT posting_locked_through FROM public.clients WHERE id = v_c)::text, 'geen')));
END $$;

-- ═══ 6-9. RECHTEN EN VERPLICHTE REDEN ═══════════════════════════════════════

DO $$
DECLARE v_c uuid := proof.new_client('Blokkade — rechten');
BEGIN
  INSERT INTO proof.lock_subject VALUES ('rechten', v_c);

  PERFORM proof.expect_error('6', 'een assistent kan de blokkade niet zetten',
    format('SELECT proof.lock_as(%L, %L, DATE ''2024-12-31'', %L)',
           '00000000-0000-0000-0000-0000000000e2', v_c, 'poging'),
    'accountant vereist');

  PERFORM proof.expect_error('7', 'een gebruiker van een andere organisatie evenmin',
    format('SELECT proof.lock_as(%L, %L, DATE ''2024-12-31'', %L)',
           '00000000-0000-0000-0000-0000000000e3', v_c, 'poging'),
    'Administratie niet beschikbaar');

  PERFORM proof.expect_error('8', 'zonder reden gaat het niet',
    format('SELECT proof.lock_as(%L, %L, DATE ''2024-12-31'', NULL)',
           '00000000-0000-0000-0000-0000000000e1', v_c),
    'vereist een reden');

  PERFORM proof.expect_error('9', 'een reden van alleen witruimte is geen reden',
    format('SELECT proof.lock_as(%L, %L, DATE ''2024-12-31'', E'' \t\n '')',
           '00000000-0000-0000-0000-0000000000e1', v_c),
    'vereist een reden');

  PERFORM proof.record('9b', 'en geen van die pogingen liet iets achter',
    (SELECT posting_locked_through FROM public.clients WHERE id = v_c) IS NULL
      AND (SELECT count(*) FROM public.posting_lock_events WHERE client_id = v_c) = 0);
END $$;

-- ═══ 10-18. ZETTEN, VERSCHUIVEN, TERUGZETTEN, OPHEFFEN ══════════════════════

/*
 * ELKE WIJZIGING IN EEN EIGEN TRANSACTIE, en dat is geen opmaak.
 *
 * `now()` is transactiegebonden, dus vier wijzigingen in één DO-blok krijgen
 * allemaal hetzelfde `changed_at`. "De laatste gebeurtenis" is dan niet meer
 * aan te wijzen — een ORDER BY changed_at DESC valt terug op de willekeurige
 * uuid en levert een toevallige rij op. Deze test viel daar zelf in; aparte
 * blokken maken de volgorde weer echt.
 */

-- (a) zetten
DO $$
DECLARE
  v_c      uuid := proof.new_client('Blokkade — levensloop');
  v_wijzig boolean;
  v_ev     public.posting_lock_events%ROWTYPE;
BEGIN
  INSERT INTO proof.lock_subject VALUES ('levensloop', v_c);

  v_wijzig := proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2024-12-31',
                            'Aangifte 2024 ingediend');
  SELECT * INTO v_ev FROM public.posting_lock_events WHERE client_id = v_c;

  PERFORM proof.record('10', 'een accountant kan de blokkade zetten',
    v_wijzig = true
      AND (SELECT posting_locked_through FROM public.clients WHERE id = v_c) = DATE '2024-12-31');

  PERFORM proof.record('11', 'de vorige waarde is vastgelegd als leeg, de nieuwe als de gezette datum',
    v_ev.previous_locked_through IS NULL AND v_ev.new_locked_through = DATE '2024-12-31',
    format('%s → %s', COALESCE(v_ev.previous_locked_through::text, 'leeg'), v_ev.new_locked_through));

  PERFORM proof.record('12', 'tijdstip en actor zijn die van de wijziging zelf',
    v_ev.changed_by = '00000000-0000-0000-0000-0000000000e1'
      AND v_ev.changed_at IS NOT NULL
      AND v_ev.reason = 'Aangifte 2024 ingediend');

  PERFORM proof.record('13', 'de gebeurtenis hoort bij de juiste administratie en organisatie',
    v_ev.client_id = v_c
      AND v_ev.organization_id = (SELECT organization_id FROM public.clients WHERE id = v_c));
END $$;

-- (b) vooruit schuiven
DO $$
DECLARE
  v_c  uuid;
  v_ev public.posting_lock_events%ROWTYPE;
BEGIN
  SELECT client_id INTO v_c FROM proof.lock_subject WHERE rol = 'levensloop';
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2025-06-30',
                        'Eerste halfjaar 2025 aangegeven');
  SELECT * INTO v_ev FROM public.posting_lock_events WHERE client_id = v_c
   ORDER BY changed_at DESC LIMIT 1;
  PERFORM proof.record('14', 'de blokkade kan vooruit',
    (SELECT posting_locked_through FROM public.clients WHERE id = v_c) = DATE '2025-06-30'
      AND v_ev.previous_locked_through = DATE '2024-12-31'
      AND v_ev.new_locked_through = DATE '2025-06-30',
    format('%s → %s', v_ev.previous_locked_through, v_ev.new_locked_through));
END $$;

-- (c) terugzetten — de gevoelige richting, en dus juist expliciet getoetst
DO $$
DECLARE
  v_c  uuid;
  v_ev public.posting_lock_events%ROWTYPE;
BEGIN
  SELECT client_id INTO v_c FROM proof.lock_subject WHERE rol = 'levensloop';
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2024-12-31',
                        'Correctie 2025 nodig');
  SELECT * INTO v_ev FROM public.posting_lock_events WHERE client_id = v_c
   ORDER BY changed_at DESC LIMIT 1;
  PERFORM proof.record('15', 'de blokkade kan terug',
    (SELECT posting_locked_through FROM public.clients WHERE id = v_c) = DATE '2024-12-31'
      AND v_ev.previous_locked_through = DATE '2025-06-30'
      AND v_ev.new_locked_through = DATE '2024-12-31',
    format('%s → %s', v_ev.previous_locked_through, v_ev.new_locked_through));
END $$;

-- (d) opheffen
DO $$
DECLARE
  v_c      uuid;
  v_ev     public.posting_lock_events%ROWTYPE;
  v_aantal integer;
BEGIN
  SELECT client_id INTO v_c FROM proof.lock_subject WHERE rol = 'levensloop';
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, NULL, 'Blokkade tijdelijk eraf');
  SELECT * INTO v_ev FROM public.posting_lock_events WHERE client_id = v_c
   ORDER BY changed_at DESC LIMIT 1;
  PERFORM proof.record('16', 'de blokkade kan worden opgeheven met NULL',
    (SELECT posting_locked_through FROM public.clients WHERE id = v_c) IS NULL
      AND v_ev.previous_locked_through = DATE '2024-12-31'
      AND v_ev.new_locked_through IS NULL,
    format('blokkade = %s, %s → %s',
           COALESCE((SELECT posting_locked_through FROM public.clients WHERE id = v_c)::text, 'leeg'),
           COALESCE(v_ev.previous_locked_through::text, 'leeg'),
           COALESCE(v_ev.new_locked_through::text, 'leeg')));

  SELECT count(*) INTO v_aantal FROM public.posting_lock_events WHERE client_id = v_c;
  PERFORM proof.record('17', 'elke echte wijziging schreef precies één gebeurtenis', v_aantal = 4,
    format('%s gebeurtenissen na vier wijzigingen', v_aantal));
END $$;

DO $$
DECLARE
  v_c        uuid;
  v_wijzig   boolean;
  v_voor     integer;
  v_na       integer;
  v_waarde   date;
BEGIN
  SELECT client_id INTO v_c FROM proof.lock_subject WHERE rol = 'levensloop';

  -- Eerst weer een echte blokkade, zodat de idempotentie op een niet-lege
  -- waarde kan worden getoetst.
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2025-12-31', 'Opnieuw dicht');
  SELECT count(*) INTO v_voor FROM public.posting_lock_events WHERE client_id = v_c;

  -- Dezelfde waarde nog twee keer vragen.
  v_wijzig := proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2025-12-31', 'Nogmaals');
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2025-12-31', 'En nog eens');

  SELECT count(*) INTO v_na FROM public.posting_lock_events WHERE client_id = v_c;
  SELECT posting_locked_through INTO v_waarde FROM public.clients WHERE id = v_c;

  PERFORM proof.record('18', 'dezelfde waarde opnieuw vragen wijzigt niets en schrijft geen gebeurtenis',
    v_wijzig = false AND v_na = v_voor AND v_waarde = DATE '2025-12-31',
    format('changed = %s, %s → %s gebeurtenissen', v_wijzig, v_voor, v_na));

  -- En ook "al opgeheven, nog eens opheffen" is een no-op: NULL telt als waarde.
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, NULL, 'Eraf');
  SELECT count(*) INTO v_voor FROM public.posting_lock_events WHERE client_id = v_c;
  v_wijzig := proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, NULL, 'Nog eens eraf');
  SELECT count(*) INTO v_na FROM public.posting_lock_events WHERE client_id = v_c;

  PERFORM proof.record('18b', 'een al opgeheven blokkade nogmaals opheffen doet ook niets',
    v_wijzig = false AND v_na = v_voor);
END $$;

-- ═══ 19. ATOMICITEIT ════════════════════════════════════════════════════════

DO $$
DECLARE
  v_c       uuid := proof.new_client('Blokkade — atomiciteit');
  v_msg     text;
  v_waarde  date;
  v_aantal  integer;
BEGIN
  CREATE OR REPLACE FUNCTION proof.weiger_blokkade() RETURNS trigger
  LANGUAGE plpgsql AS $t$
  BEGIN
    RAISE EXCEPTION 'proefstoring bij het vastleggen van de blokkadewijziging' USING ERRCODE = '22000';
  END $t$;

  CREATE TRIGGER zzz_proef_weiger_blokkade
    BEFORE INSERT ON public.posting_lock_events
    FOR EACH ROW EXECUTE FUNCTION proof.weiger_blokkade();

  BEGIN
    PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2024-12-31', 'Poging');
    v_msg := NULL;
  EXCEPTION WHEN others THEN
    v_msg := SQLERRM;
  END;

  DROP TRIGGER zzz_proef_weiger_blokkade ON public.posting_lock_events;

  SELECT posting_locked_through INTO v_waarde FROM public.clients WHERE id = v_c;
  SELECT count(*) INTO v_aantal FROM public.posting_lock_events WHERE client_id = v_c;

  PERFORM proof.record('19', 'faalt het vastleggen, dan verandert de blokkade ook niet',
    v_msg IS NOT NULL AND v_waarde IS NULL AND v_aantal = 0,
    format('fout = %s, blokkade = %s, gebeurtenissen = %s',
           COALESCE(v_msg, 'geen'), COALESCE(v_waarde::text, 'leeg'), v_aantal));
END $$;

-- ═══ 20-24. DE KOLOM EN DE GESCHIEDENIS ZIJN AFGESCHERMD ════════════════════

DO $$
DECLARE v_c uuid;
BEGIN
  SELECT client_id INTO v_c FROM proof.lock_subject WHERE rol = 'levensloop';

  -- DE BELANGRIJKSTE AFSCHERMING. `authenticated` heeft vanaf de rol ASSISTENT
  -- gewoon UPDATE op clients (role_clients_update, 20260613001452). Zonder de
  -- trigger zou een assistent de blokkade met één update kunnen opheffen.
  PERFORM proof.expect_error('20', 'de blokkade kan niet met een gewone UPDATE worden gezet',
    format('UPDATE public.clients SET posting_locked_through = DATE ''2030-01-01'' WHERE id = %L', v_c),
    'alleen worden gewijzigd via public.set_posting_lock()');

  -- Opheffen is de gevoelige richting, dus die krijgt een eigen bewijs — op een
  -- administratie die op dit moment aantoonbaar WEL op slot staat, anders zou
  -- de trigger de update terecht als "geen wijziging" doorlaten en bewijst de
  -- test niets.
  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2024-12-31',
                        'Even dicht voor het bewijs');
  PERFORM proof.record('20a', 'die administratie staat nu aantoonbaar op slot',
    (SELECT posting_locked_through FROM public.clients WHERE id = v_c) = DATE '2024-12-31');

  PERFORM proof.expect_error('20b', 'en ook niet met een gewone UPDATE worden opgeheven',
    format('UPDATE public.clients SET posting_locked_through = NULL WHERE id = %L', v_c),
    'alleen worden gewijzigd via public.set_posting_lock()');

  PERFORM proof.record('21', 'authenticated mag de geschiedenis alleen lezen',
    has_table_privilege('authenticated', 'public.posting_lock_events', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.posting_lock_events', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'public.posting_lock_events', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.posting_lock_events', 'DELETE')
      AND NOT has_table_privilege('anon', 'public.posting_lock_events', 'SELECT'),
    'SELECT ja; INSERT/UPDATE/DELETE nee; anon niets');

  PERFORM proof.expect_error('22', 'een blokkadegebeurtenis kan niet worden gewijzigd',
    format('UPDATE public.posting_lock_events SET reason = ''anders'' WHERE client_id = %L', v_c),
    'append-only');

  PERFORM proof.expect_error('23', 'een blokkadegebeurtenis kan niet worden verwijderd',
    format('DELETE FROM public.posting_lock_events WHERE client_id = %L', v_c),
    'append-only');

  PERFORM proof.expect_error('24', 'de geschiedenis overleeft ook TRUNCATE',
    'TRUNCATE public.posting_lock_events', 'append-only');
END $$;

DO $$
DECLARE
  v_altijd integer;
  v_c      uuid;
BEGIN
  SELECT count(*) INTO v_altijd
  FROM pg_trigger
  WHERE (tgrelid = 'public.posting_lock_events'::regclass
         AND tgname IN ('prevent_posting_lock_event_mutation_trigger',
                        'prevent_posting_lock_event_truncate_trigger'))
     OR (tgrelid = 'public.clients'::regclass
         AND tgname = 'enforce_posting_lock_change_trigger');
  PERFORM proof.record('24b', 'alle drie de grendels staan op ENABLE ALWAYS',
    (SELECT count(*) FROM pg_trigger
      WHERE ((tgrelid = 'public.posting_lock_events'::regclass
              AND tgname IN ('prevent_posting_lock_event_mutation_trigger',
                             'prevent_posting_lock_event_truncate_trigger'))
          OR (tgrelid = 'public.clients'::regclass
              AND tgname = 'enforce_posting_lock_change_trigger'))
        AND tgenabled = 'A') = 3,
    format('%s grendels gevonden', v_altijd));

  -- Tenantintegriteit van de gebeurtenis zelf.
  SELECT client_id INTO v_c FROM proof.lock_subject WHERE rol = 'levensloop';
  PERFORM proof.expect_error('24c', 'een gebeurtenis kan niet onder de vlag van een andere organisatie',
    format($q$INSERT INTO public.posting_lock_events
               (client_id, organization_id, previous_locked_through, new_locked_through, changed_by, reason)
             VALUES (%L, %L, NULL, DATE '2024-12-31', %L, 'poging')$q$,
           v_c, '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000e1'),
    'buiten de organisatie');
END $$;

-- ═══ 25-28. DE HELPER ═══════════════════════════════════════════════════════

DO $$
DECLARE v_c uuid := proof.new_client('Blokkade — helper');
BEGIN
  INSERT INTO proof.lock_subject VALUES ('helper', v_c);

  PERFORM proof.record('25', 'zonder blokkade mag elke datum',
    public.posting_allowed(v_c, DATE '2020-01-01') = true
      AND public.posting_allowed(v_c, DATE '2099-12-31') = true);

  PERFORM proof.lock_as('00000000-0000-0000-0000-0000000000e1', v_c, DATE '2024-12-31', 'Dicht t/m 2024');

  PERFORM proof.record('26', 'een datum ná de blokkade mag',
    public.posting_allowed(v_c, DATE '2025-01-01') = true);

  -- De grens hoort EROP te liggen: "dicht t/m 31-12-2024" betekent dat die dag
  -- zelf ook dicht is. Dit is de assertie die een off-by-one zou vangen.
  PERFORM proof.record('27', 'de blokkadedatum zelf mag NIET',
    public.posting_allowed(v_c, DATE '2024-12-31') = false);

  PERFORM proof.record('28', 'een datum vóór de blokkade mag niet',
    public.posting_allowed(v_c, DATE '2024-12-30') = false
      AND public.posting_allowed(v_c, DATE '2001-01-01') = false);

  -- Fail closed op alles wat niet te beoordelen is.
  PERFORM proof.record('28b', 'een onbekende administratie, een NULL-id of een NULL-datum: false',
    public.posting_allowed(gen_random_uuid(), DATE '2030-01-01') = false
      AND public.posting_allowed(NULL, DATE '2030-01-01') = false
      AND public.posting_allowed(v_c, NULL) = false);
END $$;

-- ═══ 29-31. ER IS NIETS AAN HET BESTAANDE GEDRAG VERANDERD ══════════════════

DO $$
DECLARE
  v_c       uuid := proof.new_client('Blokkade — afsluiten werkt nog');
  v_created boolean;
  v_bron    text;
BEGIN
  PERFORM proof.seed_group(v_c, 2026);
  v_created := proof.close_as('00000000-0000-0000-0000-0000000000e1', v_c, 2026);

  PERFORM proof.record('29', 'close_fiscal_year() werkt onveranderd, mét gebeurtenis en watermerk',
    v_created = true
      AND (SELECT count(*) FROM public.year_closures WHERE client_id = v_c) = 1
      AND (SELECT count(*) FROM public.fiscal_year_events WHERE client_id = v_c) = 1
      AND (SELECT afgesloten_boekjaar FROM public.clients WHERE id = v_c) = 2026);

  SELECT prosrc INTO v_bron FROM pg_proc WHERE proname = 'close_fiscal_year';
  PERFORM proof.record('29b', 'en kent de boekingsblokkade niet',
    v_bron NOT LIKE '%posting_locked_through%'
      AND v_bron NOT LIKE '%set_posting_lock%'
      AND v_bron NOT LIKE '%posting_lock_events%'
      AND v_bron NOT LIKE '%posting_allowed%');
END $$;

DO $$
DECLARE v_schrijvers integer;
BEGIN
  -- Geen enkele schrijver roept de nieuwe helper aan. In dit harnas draaien
  -- post_manual_journal, post_opening_balance en declare_opening_balance_nil.
  SELECT count(*) INTO v_schrijvers
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('post_manual_journal', 'post_opening_balance', 'declare_opening_balance_nil')
    AND (p.prosrc LIKE '%posting_allowed%' OR p.prosrc LIKE '%posting_locked_through%');

  PERFORM proof.record('30', 'geen enkele boekingsschrijver toetst de nieuwe blokkade',
    v_schrijvers = 0, format('%s schrijvers met een verwijzing', v_schrijvers));

  -- En zij dragen nog wél hun oude afgesloten-jaar-toets.
  PERFORM proof.record('30b', 'zij houden hun bestaande afgesloten-jaar-toets',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosrc LIKE '%afgesloten_boekjaar IS NOT NULL%'
        AND p.prosrc LIKE '%is afgesloten voor deze administratie%') >= 3);
END $$;

DO $$
DECLARE
  v_c    uuid;
  v_jrnl uuid;
  v_org  uuid := '00000000-0000-0000-0000-00000000a001';
BEGIN
  -- Het sluitstuk: het OUDE watermerk blokkeert nog steeds precies zoals
  -- eerst — met de nieuwe blokkade leeg. De twee besturingselementen zijn dus
  -- werkelijk los van elkaar, en PR C heeft het oude niet verzwakt.
  SELECT client_id INTO v_c FROM proof.lock_subject WHERE rol = 'dicht';
  -- set_config(..., true) uit eerdere blokken was transactiegebonden.
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', true);

  INSERT INTO public.manual_journals (client_id, organization_id, posting_date, description, user_id)
  VALUES (v_c, v_org, DATE '2025-06-01', 'Memoriaal in een afgesloten jaar',
          '00000000-0000-0000-0000-0000000000e1')
  RETURNING id INTO v_jrnl;

  PERFORM proof.expect_error('31', 'het oude watermerk blokkeert nog steeds, met een lege boekingsblokkade',
    format('SELECT public.post_manual_journal(%L)', v_jrnl),
    'is afgesloten voor deze administratie');

  PERFORM proof.record('31b', 'en die administratie had inderdaad geen boekingsblokkade',
    (SELECT posting_locked_through FROM public.clients WHERE id = v_c) IS NULL);
END $$;
