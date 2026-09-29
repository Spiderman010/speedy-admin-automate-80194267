-- REAL POSTGRESQL PROOF for 6C-b11 PR E — heropenen en opnieuw afsluiten
-- (20261001120000_add_fiscal_year_reopen.sql). Throwaway cluster only; never
-- run this against any BoekAssist database. See run-proof.sh.
--
-- Elke levenscyclusstap staat in een EIGEN top-level statement: psql draait
-- die elk in een eigen transactie, net als één RPC-aanroep in de app.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

-- ═══ OPZET — administratie A: 2023 en 2024 afgesloten, blokkade t/m 30-06-2024 ═

DO $$
DECLARE v_a uuid := proof.pl_client('PR E — A');
BEGIN
  INSERT INTO proof.subject VALUES ('A', v_a);
  PERFORM proof.seed_group(v_a, 2023);
  PERFORM proof.seed_group(v_a, 2024);
END $$;

SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'A'), 2023);
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'A'), 2024);
SELECT proof.lock_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'A'),
                     DATE '2024-06-30', 'Aangifte H1 2024 ingediend');

INSERT INTO proof.snap
SELECT 'A.bewijs2024', closed_at::text || '|' || closed_by::text FROM public.year_closures
WHERE client_id = (SELECT client_id FROM proof.subject WHERE rol = 'A') AND fiscal_year = 2024;
INSERT INTO proof.snap
SELECT 'A.closedevent2024', string_agg(e::text, '|') FROM public.fiscal_year_events e
WHERE client_id = (SELECT client_id FROM proof.subject WHERE rol = 'A') AND fiscal_year = 2024;
INSERT INTO proof.snap VALUES ('A.ledger', proof.ledger_digest((SELECT client_id FROM proof.subject WHERE rol = 'A')));
INSERT INTO proof.snap
SELECT 'A.lockevents', count(*)::text FROM public.posting_lock_events
WHERE client_id = (SELECT client_id FROM proof.subject WHERE rol = 'A');

SELECT proof.record('0', 'opzet: A heeft 2023 en 2024 afgesloten, watermerk 2024, blokkade t/m 2024-06-30',
  proof.watermark((SELECT client_id FROM proof.subject WHERE rol = 'A')) = 2024
    AND proof.status((SELECT client_id FROM proof.subject WHERE rol = 'A'), 2023) = 'closed'
    AND proof.status((SELECT client_id FROM proof.subject WHERE rol = 'A'), 2024) = 'closed'
    AND (SELECT posting_locked_through FROM public.clients WHERE id = (SELECT client_id FROM proof.subject WHERE rol = 'A')) = DATE '2024-06-30');

-- ═══ 1-6. WEIGERINGEN VÓÓR ER IETS GEBEURT ═════════════════════════════════

SELECT proof.expect_error('1', 'een niet-hoogste afgesloten jaar (2023) heropenen wordt geweigerd',
  format('SELECT * FROM public.reopen_fiscal_year(%L, 2023, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'A'), 'Correctie'),
  'Alleen het laatst afgesloten boekjaar (2024)');

SELECT proof.expect_error('2', 'een reden van alleen spaties, tabs en regeleinden wordt geweigerd (22004)',
  format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'A'), E'  \t\r\n '),
  'vereist een reden');
SELECT proof.record('2b', 'een lege of ontbrekende reden ook, met SQLSTATE 22004',
  proof.identity(format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, NULL)', (SELECT client_id FROM proof.subject WHERE rol = 'A'))) LIKE '22004 | %'
    AND proof.identity(format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'A'), '')) LIKE '22004 | %');

SELECT proof.record('3', 'een reden van 501 tekens wordt geweigerd (22023)',
  proof.identity(format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'A'), repeat('x', 501)))
    = '22023 | De reden is te lang (maximaal 500 tekens)');

DO $$
BEGIN
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e3', true);  -- accountant, andere organisatie
  PERFORM proof.record('4', 'een accountant van een andere organisatie krijgt "Administratie niet beschikbaar" (42501)',
    proof.identity(format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'A'), 'Poging'))
      = '42501 | Administratie niet beschikbaar');
  PERFORM proof.record('4b', 'en een niet-bestaande administratie precies hetzelfde antwoord (geen orakel)',
    proof.identity(format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, %L)', gen_random_uuid(), 'Poging'))
      = '42501 | Administratie niet beschikbaar');
END $$;

DO $$
BEGIN
  PERFORM set_config('test.user_id', '00000000-0000-0000-0000-0000000000e2', true);  -- assistent, eigen organisatie
  PERFORM proof.record('5', 'een assistent mag niet heropenen (rolvloer accountant)',
    proof.identity(format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'A'), 'Poging'))
      LIKE '42501 | Geen rechten om een boekjaar te heropenen%');
  PERFORM set_config('test.user_id', '', true);
  PERFORM proof.record('5b', 'zonder ingelogde gebruiker: 28000',
    proof.identity(format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'A'), 'Poging'))
      = '28000 | Niet ingelogd');
END $$;

SELECT proof.record('6', 'na al die weigeringen is er niets veranderd: stand, watermerk, geschiedenis',
  proof.watermark((SELECT client_id FROM proof.subject WHERE rol = 'A')) = 2024
    AND proof.status((SELECT client_id FROM proof.subject WHERE rol = 'A'), 2024) = 'closed'
    AND proof.events((SELECT client_id FROM proof.subject WHERE rol = 'A'), 2024) = 'closed');

-- ═══ 7-14. closed → reopened ════════════════════════════════════════════════

DO $$
DECLARE
  v_a  uuid := (SELECT client_id FROM proof.subject WHERE rol = 'A');
  v_x  xid8 := pg_current_xact_id();
  r    record;
  e    public.fiscal_year_events%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.reopen_fiscal_year(v_a, 2024, E'  Correctie BTW-code Q4\t\n');
  SELECT * INTO e FROM public.fiscal_year_events WHERE id = r.event_id;
  INSERT INTO proof.snap VALUES ('A.reopenevent', r.event_id::text);

  PERFORM proof.record('7', 'heropenen van 2024: reopened = true, status reopened',
    r.reopened AND r.status = 'reopened' AND proof.status(v_a, 2024) = 'reopened');
  PERFORM proof.record('8', 'het watermerk wordt het hoogste jaar dat nog afgesloten is (2023), niet blind 2024 - 1',
    r.afgesloten_boekjaar = 2023 AND proof.watermark(v_a) = 2023);
  PERFORM proof.record('9', 'een reopened-gebeurtenis met de getrimde reden, de actor en de transactie van déze aanroep',
    e.event_type = 'reopened' AND e.reason = 'Correctie BTW-code Q4' AND e.actor_id = '00000000-0000-0000-0000-0000000000e1'
      AND e.created_xact_id = v_x AND NOT e.backfilled,
    format('reden=%L xact=%s verwacht=%s', e.reason, e.created_xact_id, v_x));
END $$;

SELECT proof.record('10', 'de boekingsblokkade is onaangeroerd (datum én geen nieuwe blokkadegebeurtenis)',
  (SELECT posting_locked_through FROM public.clients WHERE id = (SELECT client_id FROM proof.subject WHERE rol = 'A')) = DATE '2024-06-30'
    AND (SELECT count(*)::text FROM public.posting_lock_events WHERE client_id = (SELECT client_id FROM proof.subject WHERE rol = 'A'))
        = (SELECT v FROM proof.snap WHERE k = 'A.lockevents'));

SELECT proof.record('11', 'het grootboek is onaangeroerd: geen boeking, geen tegenboeking, geen resultaatregel',
  proof.ledger_digest((SELECT client_id FROM proof.subject WHERE rol = 'A')) = (SELECT v FROM proof.snap WHERE k = 'A.ledger'));

SELECT proof.record('12', 'het originele afsluitbewijs en de originele closed-gebeurtenis staan er nog, ongewijzigd',
  (SELECT closed_at::text || '|' || closed_by::text FROM public.year_closures
   WHERE client_id = (SELECT client_id FROM proof.subject WHERE rol = 'A') AND fiscal_year = 2024) = (SELECT v FROM proof.snap WHERE k = 'A.bewijs2024')
    AND EXISTS (SELECT 1 FROM public.fiscal_year_events e
                WHERE e.client_id = (SELECT client_id FROM proof.subject WHERE rol = 'A') AND e.fiscal_year = 2024
                  AND e::text = (SELECT v FROM proof.snap WHERE k = 'A.closedevent2024')));

SELECT proof.record('13', 'herhaald heropenen is een deterministische no-op: reopened = false, dezelfde gebeurtenis, niets erbij',
  (SELECT NOT r.reopened AND r.event_id::text = (SELECT v FROM proof.snap WHERE k = 'A.reopenevent') AND r.afgesloten_boekjaar = 2023
   FROM public.reopen_fiscal_year((SELECT client_id FROM proof.subject WHERE rol = 'A'), 2024, 'Nog eens') r)
    AND proof.events((SELECT client_id FROM proof.subject WHERE rol = 'A'), 2024) = 'closed,reopened'
    AND proof.watermark((SELECT client_id FROM proof.subject WHERE rol = 'A')) = 2023);

-- Boeken na heropenen: het watermerk laat het toe, de blokkade blijft gelden.
SELECT proof.expect_ok('14', 'na heropenen kan er weer in 2024 worden geboekt (na de blokkadedatum)',
  format('SELECT public.post_manual_journal(%L)', proof.mj_draft((SELECT client_id FROM proof.subject WHERE rol = 'A'), DATE '2024-07-15')));
SELECT proof.expect_error('14b', 'maar vóór de blokkadedatum nog steeds niet: de blokkade staat los van de jaarstatus',
  format('SELECT public.post_manual_journal(%L)', proof.mj_draft((SELECT client_id FROM proof.subject WHERE rol = 'A'), DATE '2024-03-01')),
  'valt binnen de boekingsblokkade t/m 2024-06-30');

-- ═══ 15-21. reopened → closed ═══════════════════════════════════════════════

-- 14b liet een ongeboekte memoriaalboeking in 2024 achter: de herafsluiting
-- moet dat zien — de gereedheidscontrole draait opnieuw.
SELECT proof.expect_error('15', 'opnieuw afsluiten draait de volledige gereedheidscontrole opnieuw (ongeboekt werk in 2024)',
  format('SELECT * FROM public.close_fiscal_year(%L, 2024)', (SELECT client_id FROM proof.subject WHERE rol = 'A')),
  'postbaar brondocument');

-- Het ongeboekte werk opruimen (de draft valt binnen de blokkade en kan dus niet geboekt worden).
DELETE FROM public.manual_journal_lines l USING public.manual_journals j
WHERE l.manual_journal_id = j.id AND j.client_id = (SELECT client_id FROM proof.subject WHERE rol = 'A')
  AND NOT EXISTS (SELECT 1 FROM public.manual_journal_postings m WHERE m.manual_journal_id = j.id);
DELETE FROM public.manual_journals j
WHERE j.client_id = (SELECT client_id FROM proof.subject WHERE rol = 'A')
  AND NOT EXISTS (SELECT 1 FROM public.manual_journal_postings m WHERE m.manual_journal_id = j.id);

INSERT INTO proof.snap VALUES ('A.ledger2', proof.ledger_digest((SELECT client_id FROM proof.subject WHERE rol = 'A')));

DO $$
DECLARE
  v_a uuid := (SELECT client_id FROM proof.subject WHERE rol = 'A');
  v_x xid8 := pg_current_xact_id();
  r   record;
BEGIN
  SELECT * INTO r FROM public.close_fiscal_year(v_a, 2024);
  PERFORM proof.record('16', 'opnieuw afsluiten lukt: created = true, status closed, watermerk weer 2024',
    r.created AND proof.status(v_a, 2024) = 'closed' AND proof.watermark(v_a) = 2024);
  PERFORM proof.record('17', 'het geeft het NIEUWE afsluitmoment terug (uit de gebeurtenis), niet het originele',
    r.closed_at::text || '|' || r.closed_by::text <> (SELECT v FROM proof.snap WHERE k = 'A.bewijs2024')
      AND r.closed_at = (SELECT occurred_at FROM public.fiscal_year_events
                         WHERE client_id = v_a AND fiscal_year = 2024 AND created_xact_id = v_x));
  PERFORM proof.record('18', 'een NIEUWE closed-gebeurtenis in deze transactie; de geschiedenis is closed,reopened,closed',
    proof.events(v_a, 2024) = 'closed,reopened,closed'
      AND (SELECT count(*) FROM public.fiscal_year_events
           WHERE client_id = v_a AND fiscal_year = 2024 AND event_type = 'closed' AND created_xact_id = v_x) = 1,
    proof.events(v_a, 2024));
END $$;

SELECT proof.record('19', 'het originele bewijs is na herafsluiten nog steeds het origineel (closed_at/closed_by)',
  (SELECT closed_at::text || '|' || closed_by::text FROM public.year_closures
   WHERE client_id = (SELECT client_id FROM proof.subject WHERE rol = 'A') AND fiscal_year = 2024) = (SELECT v FROM proof.snap WHERE k = 'A.bewijs2024'));

SELECT proof.record('20', 'herafsluiten raakt de blokkade en het grootboek niet',
  (SELECT posting_locked_through FROM public.clients WHERE id = (SELECT client_id FROM proof.subject WHERE rol = 'A')) = DATE '2024-06-30'
    AND proof.ledger_digest((SELECT client_id FROM proof.subject WHERE rol = 'A')) = (SELECT v FROM proof.snap WHERE k = 'A.ledger2'));

SELECT proof.record('21', 'nog eens afsluiten is idempotent en geeft het LAATSTE afsluitmoment terug',
  (SELECT NOT r.created AND r.closed_at = (SELECT max(occurred_at) FROM public.fiscal_year_events
                                            WHERE client_id = (SELECT client_id FROM proof.subject WHERE rol = 'A')
                                              AND fiscal_year = 2024 AND event_type = 'closed')
   FROM public.close_fiscal_year((SELECT client_id FROM proof.subject WHERE rol = 'A'), 2024) r)
    AND proof.events((SELECT client_id FROM proof.subject WHERE rol = 'A'), 2024) = 'closed,reopened,closed');

SELECT proof.expect_error('21b', 'en na herafsluiten weigert de oude jaargrendel weer een boeking in 2024',
  format('SELECT public.post_manual_journal(%L)', proof.mj_draft((SELECT client_id FROM proof.subject WHERE rol = 'A'), DATE '2024-09-01')),
  'is afgesloten voor deze administratie');

-- ═══ 22-26. HET WATERMERK OVER MEERDERE JAREN ═══════════════════════════════

DO $$
DECLARE v_b uuid := proof.pl_client('PR E — B, drie jaren');
BEGIN
  INSERT INTO proof.subject VALUES ('B', v_b);
  PERFORM proof.seed_group(v_b, 2022);
  PERFORM proof.seed_group(v_b, 2023);
  PERFORM proof.seed_group(v_b, 2024);
END $$;
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'B'), 2022);
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'B'), 2023);
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'B'), 2024);

-- Elke stap en zijn controle in een DO-blok: pas het VOLGENDE statement ziet
-- het nieuwe watermerk (een STABLE-helper in hetzelfde statement leest de
-- momentopname van vóór de aanroep).
DO $$
DECLARE v_b uuid := (SELECT client_id FROM proof.subject WHERE rol = 'B'); r record;
BEGIN
  SELECT * INTO r FROM public.reopen_fiscal_year(v_b, 2024, 'Correctie 2024');
  PERFORM proof.record('22', 'B: 2024 heropenen → watermerk 2023',
    r.reopened AND r.afgesloten_boekjaar = 2023 AND proof.watermark(v_b) = 2023);
END $$;
DO $$
DECLARE v_b uuid := (SELECT client_id FROM proof.subject WHERE rol = 'B'); r record;
BEGIN
  SELECT * INTO r FROM public.reopen_fiscal_year(v_b, 2023, 'Correctie 2023');
  PERFORM proof.record('23', 'B: daarna 2023 heropenen (genest) → watermerk 2022',
    r.reopened AND r.afgesloten_boekjaar = 2022 AND proof.watermark(v_b) = 2022);
END $$;
SELECT proof.expect_error('24', 'B: 2024 afsluiten terwijl 2023 heropend is, wordt geweigerd',
  format('SELECT * FROM public.close_fiscal_year(%L, 2024)', (SELECT client_id FROM proof.subject WHERE rol = 'B')),
  'Boekjaar 2023 staat heropend');
DO $$
DECLARE v_b uuid := (SELECT client_id FROM proof.subject WHERE rol = 'B'); r record;
BEGIN
  SELECT * INTO r FROM public.close_fiscal_year(v_b, 2023);
  PERFORM proof.record('25', 'B: eerst 2023 opnieuw afsluiten → watermerk 2023',
    r.created AND proof.watermark(v_b) = 2023 AND proof.status(v_b, 2023) = 'closed');
END $$;
DO $$
DECLARE v_b uuid := (SELECT client_id FROM proof.subject WHERE rol = 'B'); r record;
BEGIN
  SELECT * INTO r FROM public.close_fiscal_year(v_b, 2024);
  PERFORM proof.record('25b', 'B: … dan 2024 → watermerk 2024',
    r.created AND proof.watermark(v_b) = 2024 AND proof.status(v_b, 2024) = 'closed');
END $$;

DO $$
DECLARE v_c uuid := proof.pl_client('PR E — C, één jaar');
BEGIN
  INSERT INTO proof.subject VALUES ('C', v_c);
  PERFORM proof.seed_group(v_c, 2024);
END $$;
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'C'), 2024);
DO $$
DECLARE v_c uuid := (SELECT client_id FROM proof.subject WHERE rol = 'C'); r record;
BEGIN
  SELECT * INTO r FROM public.reopen_fiscal_year(v_c, 2024, 'Alles opnieuw');
  PERFORM proof.record('26', 'C: het enige afgesloten jaar heropenen → watermerk NULL',
    r.reopened AND r.afgesloten_boekjaar IS NULL AND proof.watermark(v_c) IS NULL);
END $$;

-- ═══ 27-33. DE BEWAKERS: ALLEEN MET EEN GEBEURTENIS UIT DEZELFDE TRANSACTIE ═

SELECT proof.expect_error('27', 'status direct wijzigen (zelfs als superuser) zonder gebeurtenis → geweigerd',
  format('UPDATE public.year_closures SET status = ''reopened'' WHERE client_id = %L AND fiscal_year = 2024',
         (SELECT client_id FROM proof.subject WHERE rol = 'A')),
  'kan alleen veranderen via close_fiscal_year() of reopen_fiscal_year()');

-- Een reopened-gebeurtenis in een EERDERE transactie telt niet.
INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id, reason)
SELECT id, organization_id, 2022, 'reopened', '00000000-0000-0000-0000-0000000000e1', 'Vervalste voorbereiding'
FROM public.clients WHERE id = (SELECT client_id FROM proof.subject WHERE rol = 'B');

SELECT proof.expect_error('28', 'een gebeurtenis uit een eerdere transactie is geen bewijs: status blijft geweigerd',
  format('UPDATE public.year_closures SET status = ''reopened'' WHERE client_id = %L AND fiscal_year = 2022',
         (SELECT client_id FROM proof.subject WHERE rol = 'B')),
  'geen reopened-gebeurtenis');

SELECT proof.expect_error('29', 'het watermerk direct verlagen → geweigerd',
  format('UPDATE public.clients SET afgesloten_boekjaar = 2023 WHERE id = %L', (SELECT client_id FROM proof.subject WHERE rol = 'A')),
  'kan alleen omlaag');
SELECT proof.expect_error('29b', 'het watermerk direct wissen → geweigerd',
  format('UPDATE public.clients SET afgesloten_boekjaar = NULL WHERE id = %L', (SELECT client_id FROM proof.subject WHERE rol = 'A')),
  'kan alleen omlaag');
-- Een afsluitbewijs op closed boven het watermerk, via een gebeurtenis in
-- dezelfde transactie (de statusbewaker laat dat toe) — daarna, in een LATERE
-- transactie, het watermerk er direct naartoe zetten: geweigerd, want de
-- closed-gebeurtenis komt niet uit déze transactie.
DO $$
BEGIN
  INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id, reason)
  SELECT id, organization_id, 2024, 'closed', '00000000-0000-0000-0000-0000000000e1', NULL
  FROM public.clients WHERE id = (SELECT client_id FROM proof.subject WHERE rol = 'C');
  UPDATE public.year_closures SET status = 'closed'
  WHERE client_id = (SELECT client_id FROM proof.subject WHERE rol = 'C') AND fiscal_year = 2024;
END $$;
SELECT proof.expect_error('30', 'het watermerk direct verhogen, met een closed-gebeurtenis uit een EERDERE transactie → geweigerd',
  format('UPDATE public.clients SET afgesloten_boekjaar = 2024 WHERE id = %L', (SELECT client_id FROM proof.subject WHERE rol = 'C')),
  'geen afsluitgebeurtenis vastgelegd');
SELECT proof.expect_error('30b', 'het watermerk direct verhogen naar een jaar zonder bewijs → geweigerd',
  format('UPDATE public.clients SET afgesloten_boekjaar = 2030 WHERE id = %L', (SELECT client_id FROM proof.subject WHERE rol = 'C')),
  'er is geen afsluitbewijs');

SELECT proof.expect_error('31', 'het originele bewijs (closed_at) wijzigen → geweigerd',
  format('UPDATE public.year_closures SET closed_at = now() WHERE client_id = %L AND fiscal_year = 2024',
         (SELECT client_id FROM proof.subject WHERE rol = 'A')),
  'append-only');
SELECT proof.expect_error('31b', 'het bewijs verwijderen → geweigerd',
  format('DELETE FROM public.year_closures WHERE client_id = %L AND fiscal_year = 2024',
         (SELECT client_id FROM proof.subject WHERE rol = 'A')),
  'append-only');

-- Positieve controle: de bewaker is precies de regel — mét een gebeurtenis van
-- het juiste type in dezelfde transactie mag de status wél (teruggedraaid).
DO $$
DECLARE v_ok boolean := false; v_wrong text;
BEGIN
  BEGIN
    INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id, reason)
    SELECT id, organization_id, 2024, 'closed', '00000000-0000-0000-0000-0000000000e1', NULL
    FROM public.clients WHERE id = (SELECT client_id FROM proof.subject WHERE rol = 'A');
    v_wrong := proof.identity(format('UPDATE public.year_closures SET status = ''reopened'' WHERE client_id = %L AND fiscal_year = 2024',
                                     (SELECT client_id FROM proof.subject WHERE rol = 'A')));
    INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id, reason)
    SELECT id, organization_id, 2024, 'reopened', '00000000-0000-0000-0000-0000000000e1', 'Positieve controle'
    FROM public.clients WHERE id = (SELECT client_id FROM proof.subject WHERE rol = 'A');
    UPDATE public.year_closures SET status = 'reopened'
    WHERE client_id = (SELECT client_id FROM proof.subject WHERE rol = 'A') AND fiscal_year = 2024;
    v_ok := true;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '__rollback__';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> '__rollback__' THEN RAISE; END IF;
  END;
  PERFORM proof.record('32', 'een gebeurtenis van het VERKEERDE type in dezelfde transactie volstaat niet',
    v_wrong LIKE '42501 | %geen reopened-gebeurtenis%', v_wrong);
  PERFORM proof.record('33', 'mét de juiste gebeurtenis in dezelfde transactie staat de bewaker de statuswissel wél toe',
    v_ok);
END $$;

SELECT proof.record('33b', 'en die positieve controle heeft niets achtergelaten',
  proof.status((SELECT client_id FROM proof.subject WHERE rol = 'A'), 2024) = 'closed'
    AND proof.events((SELECT client_id FROM proof.subject WHERE rol = 'A'), 2024) = 'closed,reopened,closed');

-- ═══ 34-37. created_xact_id ═════════════════════════════════════════════════

DO $$
DECLARE v_id uuid; v_x xid8 := pg_current_xact_id();
BEGIN
  INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id, reason, created_xact_id)
  SELECT id, organization_id, 2021, 'closed', '00000000-0000-0000-0000-0000000000e1', NULL, '1'::xid8
  FROM public.clients WHERE id = (SELECT client_id FROM proof.subject WHERE rol = 'C')
  RETURNING id INTO v_id;
  PERFORM proof.record('34', 'een meegegeven created_xact_id wordt overschreven door de echte transactie (niet te vervalsen)',
    (SELECT created_xact_id FROM public.fiscal_year_events WHERE id = v_id) = v_x);
END $$;

SELECT proof.record('35', 'elke gebeurtenis van ná PR E heeft een stempel',
  NOT EXISTS (SELECT 1 FROM public.fiscal_year_events e
              WHERE e.created_xact_id IS NULL
                AND e.client_id NOT IN (SELECT client_id FROM proof.subject WHERE rol IN ('L', 'M2', 'M3'))));

SELECT proof.record('36', 'historische gebeurtenissen (vóór PR E) blijven NULL — geen verzonnen herkomst',
  (SELECT count(*) FROM public.fiscal_year_events
   WHERE client_id IN (SELECT client_id FROM proof.subject WHERE rol IN ('L', 'M2', 'M3')) AND created_xact_id IS NULL) = 3);

DO $$
DECLARE v_l uuid := (SELECT client_id FROM proof.subject WHERE rol = 'L'); r record;
BEGIN
  SELECT * INTO r FROM public.reopen_fiscal_year(v_l, 2024, 'Erfenis heropend');
  PERFORM proof.record('37', 'een jaar met alleen een historische (NULL-)gebeurtenis kan normaal worden heropend',
    r.reopened AND r.afgesloten_boekjaar IS NULL AND proof.watermark(v_l) IS NULL
      AND proof.events(v_l, 2024) = 'closed,reopened');
END $$;

-- ═══ 38-43. INCONSISTENTE ERFENIS: FAIL CLOSED, NIETS VERANDERD ═════════════

SELECT proof.expect_error('38', 'M1: watermerk zonder afsluitbewijs → deterministisch geweigerd',
  format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'M1'), 'Herstel'),
  'geen afsluitbewijs; de afsluitstand is inconsistent');

SELECT proof.expect_error('39', 'M2: watermerk (2025) boven het hoogste bewijs (2024) → deterministisch geweigerd',
  format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'M2'), 'Herstel'),
  'Het watermerk (2025) is niet het hoogste afgesloten boekjaar met bewijs (2024)');

SELECT proof.expect_error('40', 'M3: heropenen zou een bewijsloos jaar met boekingen (2023) meenemen → geweigerd',
  format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'M3'), 'Herstel'),
  'zou ook boekjaar 2023 openen');

-- M4: afgesloten, maar de geschiedenis zegt "reopened" (vervalst, in een eigen transactie).
DO $$
DECLARE v_m4 uuid := proof.pl_client('PR E — M4: geschiedenis spreekt de stand tegen');
BEGIN
  INSERT INTO proof.subject VALUES ('M4', v_m4);
  PERFORM proof.seed_group(v_m4, 2024);
END $$;
SELECT proof.close_as('00000000-0000-0000-0000-0000000000e1', (SELECT client_id FROM proof.subject WHERE rol = 'M4'), 2024);
INSERT INTO public.fiscal_year_events (client_id, organization_id, fiscal_year, event_type, actor_id, reason)
SELECT id, organization_id, 2024, 'reopened', '00000000-0000-0000-0000-0000000000e1', 'Vervalst'
FROM public.clients WHERE id = (SELECT client_id FROM proof.subject WHERE rol = 'M4');
SELECT proof.expect_error('41', 'M4: stand closed maar laatste gebeurtenis reopened → deterministisch geweigerd',
  format('SELECT * FROM public.reopen_fiscal_year(%L, 2024, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'M4'), 'Herstel'),
  'de gebeurtenisgeschiedenis draagt dat niet');

SELECT proof.record('42', 'na elke inconsistente weigering is er niets veranderd (watermerk, stand, gebeurtenissen)',
  proof.watermark((SELECT client_id FROM proof.subject WHERE rol = 'M1')) = 2024
    AND proof.watermark((SELECT client_id FROM proof.subject WHERE rol = 'M2')) = 2025
    AND proof.watermark((SELECT client_id FROM proof.subject WHERE rol = 'M3')) = 2024
    AND proof.status((SELECT client_id FROM proof.subject WHERE rol = 'M3'), 2024) = 'closed'
    AND proof.events((SELECT client_id FROM proof.subject WHERE rol = 'M3'), 2024) = 'closed'
    AND proof.status((SELECT client_id FROM proof.subject WHERE rol = 'M4'), 2024) = 'closed'
    AND proof.events((SELECT client_id FROM proof.subject WHERE rol = 'M4'), 2024) = 'closed,reopened');

SELECT proof.expect_error('43', 'een jaar dat nooit is afgesloten, valt niet te heropenen',
  format('SELECT * FROM public.reopen_fiscal_year(%L, 2025, %L)', (SELECT client_id FROM proof.subject WHERE rol = 'A'), 'Niets'),
  'is niet afgesloten');

-- ═══ 44-46. ÉÉN STAP PER TRANSACTIE, EERSTE AFSLUITING, RECHTEN ════════════

DO $$
DECLARE v_err text;
BEGIN
  BEGIN
    PERFORM * FROM public.reopen_fiscal_year((SELECT client_id FROM proof.subject WHERE rol = 'B'), 2024, 'Stap 1');
    v_err := proof.identity(format('SELECT * FROM public.close_fiscal_year(%L, 2024)', (SELECT client_id FROM proof.subject WHERE rol = 'B')));
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '__rollback__';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> '__rollback__' THEN RAISE; END IF;
  END;
  PERFORM proof.record('44', 'heropenen en herafsluiten in één transactie wordt geweigerd (55000): de geschiedenis blijft eenduidig',
    v_err LIKE '55000 | %één stap per transactie%', v_err);
END $$;

DO $$
DECLARE v_d uuid := proof.pl_client('PR E — D, eerste afsluiting');
BEGIN
  INSERT INTO proof.subject VALUES ('D', v_d);
  PERFORM proof.seed_group(v_d, 2024);
END $$;
DO $$
DECLARE v_d uuid := (SELECT client_id FROM proof.subject WHERE rol = 'D'); r record; v_x xid8 := pg_current_xact_id();
BEGIN
  SELECT * INTO r FROM public.close_fiscal_year(v_d, 2024);
  PERFORM proof.record('45', 'een eerste afsluiting werkt als voorheen: bewijs, één gebeurtenis met stempel, gelijk tijdstip en actor',
    r.created AND proof.watermark(v_d) = 2024 AND proof.events(v_d, 2024) = 'closed'
      AND (SELECT e.created_xact_id = v_x AND e.occurred_at = yc.closed_at AND e.actor_id = yc.closed_by
           FROM public.fiscal_year_events e JOIN public.year_closures yc
             ON yc.client_id = e.client_id AND yc.fiscal_year = e.fiscal_year
           WHERE e.client_id = v_d AND e.fiscal_year = 2024));
END $$;

SELECT proof.record('46', 'rechten: reopen_fiscal_year alleen voor authenticated; de stempeltrigger voor niemand',
  has_function_privilege('authenticated', 'public.reopen_fiscal_year(uuid,integer,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.reopen_fiscal_year(uuid,integer,text)', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.reopen_fiscal_year(uuid,integer,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.stamp_fiscal_year_event_xact()', 'EXECUTE')
    AND (SELECT prosecdef AND array_to_string(proconfig, ',') = 'search_path=public'
         FROM pg_proc WHERE oid = 'public.reopen_fiscal_year(uuid,integer,text)'::regprocedure));

SELECT proof.record('47', 'geen functie in PR E schrijft de boekingsblokkade of het grootboek',
  (SELECT bool_and(position('posting_locked_through' IN regexp_replace(prosrc, '--[^\n]*', '', 'g')) = 0
                    AND position('INSERT INTO public.ledger_postings' IN regexp_replace(prosrc, '--[^\n]*', '', 'g')) = 0)
   FROM pg_proc WHERE oid IN ('public.reopen_fiscal_year(uuid,integer,text)'::regprocedure,
                              'public.close_fiscal_year(uuid,integer)'::regprocedure,
                              'public.enforce_year_close_watermark()'::regprocedure,
                              'public.prevent_year_closure_mutation()'::regprocedure)));
