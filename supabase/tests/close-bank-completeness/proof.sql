-- PROOFS — throwaway database only.
--
-- Draait NA de migratie onder test (twee keer toegepast). Elke casus staat
-- naast haar uitkomst onder PR E (pre.sql), zodat zichtbaar is wat de migratie
-- verandert en wat bewust gelijk blijft.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- ── 1. A3-02 — de gecodeerde, nog niet geboekte bankregel ───────────────────
SELECT proof.put('post_k1_2026', proof.try_close(proof.client(1), 2026));
SELECT proof.record('1', 'A3-02: een gecodeerde, nog niet geboekte bankregel van 2026 laat de afsluiting van 2026 weigeren (23514)',
  proof.get('post_k1_2026') LIKE '[23514]%1 postbaar brondocument(en) open met boekjaar t/m 2026%', proof.get('post_k1_2026'));
SELECT proof.record('1b', 'de weigering zegt niet langer "voorgoed onboekbaar" maar dat de afsluiting het jaar volledig verklaart',
  proof.get('post_k1_2026') NOT LIKE '%voorgoed onboekbaar%'
  AND proof.get('post_k1_2026') LIKE '%een afsluiting verklaart het boekjaar volledig, dus boek dat document eerst%',
  proof.get('post_k1_2026'));

SELECT proof.put('k1_lifecycle_voor', proof.lifecycle_digest());
SELECT proof.as_user(proof.accountant());
SELECT proof.expect_error('1c', 'een rechtstreekse aanroep wordt met dezelfde SQLSTATE en tekst geweigerd',
  format('SELECT * FROM public.close_fiscal_year(%L, 2026)', proof.client(1)),
  '23514', 'postbaar brondocument(en) open met boekjaar t/m 2026');
SELECT proof.as_user(NULL);
SELECT proof.record('1d', 'een weigering laat niets achter: afsluitbewijs, gebeurtenissen, watermerk en blokkade onveranderd',
  proof.lifecycle_digest() = proof.get('k1_lifecycle_voor')
  AND NOT EXISTS (SELECT 1 FROM public.year_closures WHERE client_id = proof.client(1)), NULL);

-- De bankregel wordt geboekt door de echte schrijver, als ASSISTENT (de
-- boekvloer van post_bank_transaction). Daarna sluit 2026 gewoon af.
SELECT proof.as_user(proof.assistant());
SELECT proof.put('k1_group', public.post_bank_transaction(proof.uid(1000, 101))::text);
SELECT proof.as_user(NULL);
SELECT proof.record('2', 'na het boeken van die bankregel (assistent, echte schrijver) sluit 2026 af: created = true',
  proof.close_now(proof.client(1), 2026) = 'created=true', NULL);
SELECT proof.as_user(NULL);
SELECT proof.expect_true('2b', 'precies één closed-gebeurtenis, met het moment en de actor van het afsluitbewijs',
  format($q$(SELECT count(*) = 1 AND bool_and(e.occurred_at = yc.closed_at AND e.actor_id = yc.closed_by AND e.event_type = 'closed' AND NOT e.backfilled)
             FROM public.fiscal_year_events e JOIN public.year_closures yc
               ON yc.client_id = e.client_id AND yc.fiscal_year = e.fiscal_year
             WHERE e.client_id = %L AND e.fiscal_year = 2026)$q$, proof.client(1)));
SELECT proof.expect_true('2c', 'het watermerk staat op 2026 en de boekingsblokkade is NIET gezet (PR H ongewijzigd)',
  format($q$(SELECT afgesloten_boekjaar = 2026 AND posting_locked_through IS NULL FROM public.clients WHERE id = %L)$q$, proof.client(1)));
SELECT proof.expect_true('2d', 'de bankboeking staat in het grootboek: bank credit 1.210, kosten 1.000 en btw 210 debet, in 2026',
  format($q$(SELECT count(*) = 3 AND sum(debit_amount) = 1210 AND sum(credit_amount) = 1210 AND bool_and(boekjaar = 2026)
             FROM public.ledger_postings WHERE posting_group_id = %L::uuid)$q$, proof.get('k1_group')));

-- ── 2. FD-N3 — gematcht zonder koppeling: BEWUST ONGEWIJZIGD ────────────────
SELECT proof.put('post_k2_2026', proof.try_close(proof.client(2), 2026));
SELECT proof.record('3', 'VASTGELEGD, ontwerpvraag D7 (FD-N3): ''gematcht''-bankregels zonder koppeling — ook één MET rekening — tellen, net als onder PR E, niet mee',
  proof.get('post_k2_2026') = 'created=true' AND proof.get('pre_k2_2026') = proof.get('post_k2_2026'),
  proof.get('pre_k2_2026') || ' → ' || proof.get('post_k2_2026'));

-- ── 3. de postbaarheidsregels van de directe bankschrijver ──────────────────
SELECT proof.record('4', 'gecodeerd zonder grootboekrekening telt niet (de schrijver kan haar niet boeken)',
  proof.try_close(proof.client(3), 2026) = 'created=true', NULL);
SELECT proof.record('5', 'gecodeerd met bedrag 0 telt niet (de schrijver weigert een nulbedrag altijd)',
  proof.try_close(proof.client(4), 2026) = 'created=true', NULL);
SELECT proof.record('6', 'een niet-gecodeerde regel (suggestie, niet_gematcht) telt niet, ook met een rekening',
  proof.try_close(proof.client(5), 2026) = 'created=true', NULL);
SELECT proof.record('7', 'een gecodeerde regel MET koppeling telt niet dubbel: zij hoort bij de afletteringstak (factuur hier niet postbaar)',
  proof.try_close(proof.client(6), 2026) = 'created=true', NULL);
SELECT proof.record('8', 'een gecodeerde regel van 2027 blokkeert 2026 niet ...',
  proof.try_close(proof.client(7), 2026) = 'created=true', NULL);
SELECT proof.put('post_k7_2027', proof.try_close(proof.client(7), 2027));
SELECT proof.record('8b', '... maar wel 2027 (onder PR E sloot 2027 gewoon af)',
  proof.get('post_k7_2027') LIKE '[23514]%postbaar brondocument(en) open met boekjaar t/m 2027%'
  AND proof.get('pre_k7_2027') = 'created=true',
  proof.get('pre_k7_2027') || ' → ' || proof.get('post_k7_2027'));
SELECT proof.put('post_k11_2026', proof.try_close(proof.client(11), 2026));
SELECT proof.record('9', 'een vrijgegeven bankregel (S3: storno, geen marker) telt NIET: de vrijgave zet haar terug op niet_gematcht zonder rekening',
  proof.get('post_k11_2026') = 'created=true' AND proof.get('pre_k11_2026') = 'created=true',
  proof.get('pre_k11_2026') || ' → ' || proof.get('post_k11_2026'));
SELECT proof.expect_true('9b', 'de bulk-preflight noemt diezelfde regel ''review_needed'' (niet gecodeerd): schrijver, preflight en afsluiting zeggen hetzelfde',
  format($q$(SELECT workflow_state = 'review_needed' AND match_status = 'niet_gematcht' AND grootboekrekening_id IS NULL
             FROM public.bank_bulk_posting_candidates(%L, 2026)
             WHERE transaction_id = %L)$q$, proof.client(11), proof.uid(1000, 1101)));

-- ── 4. B1-04 — alleen werk van de eigen organisatie ─────────────────────────
SELECT proof.put('post_k8_2026', proof.try_close(proof.client(8), 2026));
SELECT proof.record('10', 'B1-04: een postbare inkoopfactuur én een gecodeerde bankregel van een ANDERE organisatie met dit client_id tellen niet meer',
  proof.get('post_k8_2026') = 'created=true' AND proof.get('pre_k8_2026') LIKE '[23514]%',
  proof.get('pre_k8_2026') || ' → ' || proof.get('post_k8_2026'));
SELECT proof.put('post_k9_2026', proof.try_close(proof.client(9), 2026));
SELECT proof.record('11', 'B1-04 verzwakt niets: een postbare inkoopfactuur ZONDER organisatie (erfenis) telt nog steeds mee',
  proof.get('post_k9_2026') LIKE '[23514]%postbaar brondocument(en) open met boekjaar t/m 2026%', proof.get('post_k9_2026'));
SELECT proof.put('post_k10_2026', proof.try_close(proof.client(10), 2026));
SELECT proof.record('12', 'review H-1: een gecodeerde bankregel ZONDER organisatie telt NIET — de schrijver kan haar niet boeken, dus zij is niet postbaar (gelijk aan schrijver en app)',
  proof.get('post_k10_2026') = 'created=true' AND proof.get('pre_k10_2026') = 'created=true',
  proof.get('pre_k10_2026') || ' → ' || proof.get('post_k10_2026'));
SELECT proof.as_user(proof.accountant());
SELECT proof.expect_error('12b', '... want post_bank_transaction weigert die regel altijd (42501 "Banktransactie niet beschikbaar")',
  format('SELECT public.post_bank_transaction(%L)', proof.uid(1000, 1001)), '42501', 'Banktransactie niet beschikbaar');
SELECT proof.as_user(NULL);
SELECT proof.put('post_k14_2025', proof.try_close(proof.client(14), 2025));
SELECT proof.record('12c', 'review N-1: een gecodeerde bankregel van vóór de beginbalans (2025, beginbalans per 1-1-2026) telt NIET — de afsluiting van 2025 slaagt',
  proof.get('post_k14_2025') = 'created=true', proof.get('post_k14_2025'));
SELECT proof.as_user(proof.accountant());
SELECT proof.expect_error('12d', '... want die regel is niet te boeken: de beginbalanstrigger weigert elke grootboekregel daarvóór (22023)',
  format('SELECT public.post_bank_transaction(%L)', proof.uid(1000, 1401)), '22023', 'beginbalans');
SELECT proof.as_user(NULL);
SELECT proof.record('12e', '... terwijl een gecodeerde regel NA de beginbalans (2026) wél telt: de grens is exact de openingsdatum',
  proof.try_close(proof.client(14), 2026) LIKE '[23514]%postbaar brondocument(en) open met boekjaar t/m 2026%', proof.try_close(proof.client(14), 2026));
SELECT proof.expect_true('13', 'de rijen van de andere organisatie zijn onaangeroerd en nog steeds ongeboekt',
  format($q$(SELECT count(*) = 2 FROM (
               SELECT id FROM public.purchase_invoices WHERE id = %L AND organization_id = '00000000-0000-0000-0000-00000000a002'
                 AND NOT EXISTS (SELECT 1 FROM public.purchase_invoice_postings m WHERE m.purchase_invoice_id = %L)
               UNION ALL
               SELECT id FROM public.bank_transactions WHERE id = %L AND organization_id = '00000000-0000-0000-0000-00000000a002'
                 AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = %L)) x)$q$,
         proof.uid(2000, 801), proof.uid(2000, 801), proof.uid(1000, 801), proof.uid(1000, 801)));

-- ── 5. de guards van PR E, ongewijzigd ──────────────────────────────────────
SELECT proof.as_user(NULL);
SELECT proof.expect_error('14', 'niet ingelogd → 28000',
  format('SELECT * FROM public.close_fiscal_year(%L, 2025)', proof.client(12)), '28000', 'Niet ingelogd');
SELECT proof.as_user(proof.accountant());
SELECT proof.expect_error('15', 'onbekende administratie → 42501 "Administratie niet beschikbaar"',
  $q$SELECT * FROM public.close_fiscal_year('00000000-0000-0000-dead-000000000000', 2025)$q$, '42501', 'Administratie niet beschikbaar');
SELECT proof.as_user(proof.outsider());
SELECT proof.expect_error('16', 'tenant: een accountant van een andere organisatie krijgt exact hetzelfde antwoord als bij een onbekende administratie',
  format('SELECT * FROM public.close_fiscal_year(%L, 2025)', proof.client(12)), '42501', 'Administratie niet beschikbaar');
SELECT proof.as_user(proof.reader());
SELECT proof.expect_error('17', 'rol: read_only → 42501, accountant vereist',
  format('SELECT * FROM public.close_fiscal_year(%L, 2025)', proof.client(12)), '42501', 'accountant vereist');
SELECT proof.as_user(proof.assistant());
SELECT proof.expect_error('18', 'rol: assistent → 42501, accountant vereist',
  format('SELECT * FROM public.close_fiscal_year(%L, 2025)', proof.client(12)), '42501', 'accountant vereist');
SELECT proof.as_user(proof.accountant());
SELECT proof.expect_error('19', 'geen administratie → 22004',
  'SELECT * FROM public.close_fiscal_year(NULL, 2025)', '22004', 'Geen administratie opgegeven');
SELECT proof.expect_error('19b', 'geen boekjaar → 22004',
  format('SELECT * FROM public.close_fiscal_year(%L, NULL)', proof.client(12)), '22004', 'Geen boekjaar opgegeven');
SELECT proof.expect_error('19c', 'boekjaar buiten 2000-2100 → 22023',
  format('SELECT * FROM public.close_fiscal_year(%L, 1999)', proof.client(12)), '22023', 'buiten het ondersteunde bereik');
SELECT proof.expect_error('19d', 'tenant: de andere organisatie kan haar EIGEN administratie niet via deze accountant laten afsluiten',
  format('SELECT * FROM public.close_fiscal_year(%L, 2026)', proof.client(99)), '42501', 'Administratie niet beschikbaar');

-- Levenscyclus van K12: sluiten, idempotent, volgorde, heropenen, opnieuw sluiten.
SELECT proof.record('20', 'K12: 2026 afsluiten vóór 2025 weigert nog steeds (afsluitvolgorde, controle B)',
  proof.try_close(proof.client(12), 2026) LIKE '[23514]%oudere boekjaren met boekingen nog open (2025)%', NULL);
SELECT proof.record('21', 'K12: 2025 sluit af (created = true)', proof.close_now(proof.client(12), 2025) = 'created=true', NULL);
SELECT proof.put('k12_2025_bewijs', (SELECT format('%s|%s', closed_at, closed_by) FROM public.year_closures
                                     WHERE client_id = proof.client(12) AND fiscal_year = 2025));
SELECT proof.record('21b', 'K12: 2025 nogmaals afsluiten is idempotent: created = false',
  proof.close_now(proof.client(12), 2025) = 'created=false', NULL);
SELECT proof.expect_true('21c', 'K12: na de herhaling precies één afsluitbewijs en één gebeurtenis voor 2025, tijdstip en actor onverschoven',
  format($q$(SELECT (SELECT count(*) FROM public.year_closures WHERE client_id = %1$L AND fiscal_year = 2025) = 1
              AND (SELECT count(*) FROM public.fiscal_year_events WHERE client_id = %1$L AND fiscal_year = 2025) = 1
              AND (SELECT format('%%s|%%s', closed_at, closed_by) FROM public.year_closures
                   WHERE client_id = %1$L AND fiscal_year = 2025) = %2$L)$q$, proof.client(12), proof.get('k12_2025_bewijs')));
SELECT proof.record('22', 'K12: 2026 sluit nu af (created = true)', proof.close_now(proof.client(12), 2026) = 'created=true', NULL);

SELECT proof.as_user(proof.accountant());
SELECT proof.put('k12_reopen', (SELECT format('%s/%s', r.reopened::text, r.afgesloten_boekjaar)
                                FROM public.reopen_fiscal_year(proof.client(12), 2026, 'P7-harnas: correctie bank') r));
SELECT proof.record('23', 'K12: 2026 heropenen (PR E) zet het watermerk terug naar 2025',
  proof.get('k12_reopen') = 'true/2025', proof.get('k12_reopen'));
-- Na de heropening komt er een gecodeerde, nog niet geboekte bankregel in 2026 bij.
SELECT proof.tx(1201, proof.client(12), DATE '2026-11-30', -242);
SELECT proof.put('k12_reclose_1', proof.try_close(proof.client(12), 2026));
SELECT proof.record('23b', 'K12: opnieuw afsluiten herkeurt volledig, dus ook de bankregel: geweigerd (23514)',
  proof.get('k12_reclose_1') LIKE '[23514]%1 postbaar brondocument(en) open met boekjaar t/m 2026%', proof.get('k12_reclose_1'));
SELECT proof.as_user(proof.assistant());
SELECT public.post_bank_transaction(proof.uid(1000, 1201));
SELECT proof.as_user(NULL);
SELECT proof.record('24', 'K12: na het boeken sluit 2026 opnieuw af (created = true)',
  proof.close_now(proof.client(12), 2026) = 'created=true', NULL);
SELECT proof.expect_true('24b', 'K12: de geschiedenis van 2026 is closed → reopened → closed; het originele bewijs blijft, het watermerk is 2026',
  format($q$(SELECT string_agg(event_type, ',' ORDER BY occurred_at, created_xact_id, id) = 'closed,reopened,closed'
             FROM public.fiscal_year_events WHERE client_id = %1$L AND fiscal_year = 2026)
            AND (SELECT status = 'closed' AND closed_at < (SELECT max(occurred_at) FROM public.fiscal_year_events
                                                           WHERE client_id = %1$L AND fiscal_year = 2026)
                 FROM public.year_closures WHERE client_id = %1$L AND fiscal_year = 2026)
            AND (SELECT afgesloten_boekjaar = 2026 AND posting_locked_through IS NULL FROM public.clients WHERE id = %1$L)$q$,
         proof.client(12)));

-- Controle A2 (een ouder jaar heropend) blijft werken.
SELECT proof.as_user(proof.accountant());
SELECT public.reopen_fiscal_year(proof.client(12), 2026, 'P7-harnas: volgorde');
SELECT public.reopen_fiscal_year(proof.client(12), 2025, 'P7-harnas: volgorde');
SELECT proof.record('25', 'K12: met 2025 heropend weigert het afsluiten van 2026 (controle A2, ongewijzigd)',
  proof.try_close(proof.client(12), 2026) LIKE '[23514]%Boekjaar 2025 staat heropend%', NULL);
SELECT proof.record('25b', 'K12: eerst 2025 en dan 2026 opnieuw afsluiten lukt',
  proof.close_now(proof.client(12), 2025) = 'created=true' AND proof.close_now(proof.client(12), 2026) = 'created=true', NULL);

-- Afsluiten blokkeert boeken nog steeds NIET (PR H): zonder blokkade boekt de
-- schrijver in het afgesloten jaar. Deze migratie verandert daar niets aan.
SELECT proof.tx(1202, proof.client(12), DATE '2026-12-15', -121);
SELECT proof.as_user(proof.assistant());
SELECT proof.expect_true('26', 'PR H ongewijzigd: een assistent boekt in het afgesloten jaar 2026 zolang er geen boekingsblokkade is',
  format('(SELECT public.post_bank_transaction(%L) IS NOT NULL)', proof.uid(1000, 1202)));
SELECT proof.as_user(NULL);

-- ── 6. functiedefinitie, rechten en wat er verder NIET veranderde ───────────
SELECT proof.expect_true('27', 'het lichaam is exact het beoordeelde P7-lichaam (md5 37c8935a…)',
  $q$proof.close_md5() = '37c8935ad10923ca6ed5d1d58473e4f7'$q$);
SELECT proof.expect_true('27b', 'SECURITY DEFINER, search_path = public, dezelfde eigenaar en exact de ACL van PR E',
  $q$(SELECT prosecdef AND proconfig = ARRAY['search_path=public'] AND proacl::text = proof.get('acl_pr_e')
             AND proowner::regrole::text = proof.get('owner_pr_e')
      FROM pg_proc WHERE oid = 'public.close_fiscal_year(uuid,integer)'::regprocedure)$q$);
SELECT proof.expect_true('27c', 'EXECUTE: authenticated ja; anon, service_role en PUBLIC nee',
  $q$has_function_privilege('authenticated', 'public.close_fiscal_year(uuid,integer)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.close_fiscal_year(uuid,integer)', 'EXECUTE')
     AND NOT has_function_privilege('service_role', 'public.close_fiscal_year(uuid,integer)', 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                     WHERE p.oid = 'public.close_fiscal_year(uuid,integer)'::regprocedure AND a.grantee = 0)$q$);
SELECT proof.expect_true('27d', 'handtekening en retourvorm ongewijzigd',
  $q$(SELECT pg_get_function_arguments(oid) = '_client_id uuid, _fiscal_year integer'
         AND pg_get_function_result(oid) = 'TABLE(client_id uuid, organization_id uuid, fiscal_year integer, closed_at timestamp with time zone, closed_by uuid, created boolean)'
      FROM pg_proc WHERE oid = 'public.close_fiscal_year(uuid,integer)'::regprocedure)$q$);
SELECT proof.expect_true('27e', 'het commentaar noemt de bankregels en de eigen organisatie',
  $q$obj_description('public.close_fiscal_year(uuid,integer)'::regprocedure, 'pg_proc') LIKE '%gecodeerde bankregels voor de directe bankboeking%uitsluitend van de eigen organisatie%'$q$);
SELECT proof.expect_true('27f', 'reopen_fiscal_year is onaangeroerd (zelfde lichaam als vóór de migratie)',
  $q$(SELECT md5(prosrc) = proof.get('md5_reopen_pr_e') FROM pg_proc WHERE oid = 'public.reopen_fiscal_year(uuid,integer,text)'::regprocedure)$q$);

SET ROLE anon;
SELECT proof.expect_error('28', 'anon mag de functie niet aanroepen (42501)',
  format('SELECT * FROM public.close_fiscal_year(%L, 2025)', proof.client(12)), '42501', 'permission denied');
RESET ROLE;
SET ROLE service_role;
SELECT proof.expect_error('28b', 'service_role mag de functie niet aanroepen (42501)',
  format('SELECT * FROM public.close_fiscal_year(%L, 2025)', proof.client(12)), '42501', 'permission denied');
RESET ROLE;
SET ROLE authenticated;
SELECT proof.as_user(proof.accountant());
SELECT proof.expect_true('28c', 'authenticated (accountant) mag hem aanroepen: het al afgesloten 2025 geeft created = false',
  format('(SELECT NOT created FROM public.close_fiscal_year(%L, 2025))', proof.client(12)));
RESET ROLE;
SELECT proof.as_user(NULL);
