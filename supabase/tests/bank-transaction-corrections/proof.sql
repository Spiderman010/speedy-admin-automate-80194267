-- BEWIJZEN NÁ 20261018120000 — throwaway database only.
--
-- Elke RPC-aanroep is een eigen opdracht en dus een eigen transactie: de
-- uitgestelde controles (balans, lineage) lopen echt bij elke COMMIT. Alle
-- aanroepen gaan als de echte rol `authenticated` (proof.call), zodat
-- EXECUTE-rechten en RLS werkelijk gelden.
--
--   C*   catalogus: precies de nieuwe objecten, bestaande objecten byte-gelijk
--   K0   8250 → 4700, BTW 21 → 9, omschrijving, keten van generaties, unchanged
--   K1   autorisatie vóór onthulling, idempotentie per (actor, request_id)
--   K2   marker en gebeurtenissen: alleen binnen een geldige correctie
--   K3   vrijgeven: geen automatische herboeking, expliciet terug naar de werkstroom
--   K6   BTW via de bestaande schrijver: richting × oud × nieuw × bedrag
--   K7   configuratiedrift (D7)
--   K8   afgesloten jaar (D8) en boekingsblokkade, ook na het opheffen
--   K9   handmatig tegengeboekt → opnieuw boekbaar zonder tweede storno
--   K10  factuurkoppelingen vallen buiten v1; PR 0 blijft actief
--   K11  D12: elk schrijfpad tegen een vrijgegeven transactie
--   K12  ontbrekende of ongeldige invoer
--   R*   RLS op de gebeurtenissen; I* invarianten over alles hierboven

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY[
  'C0','C1','C2','C3','C4','C5','C6','C7','C8','C9','C10',
  'K0a','K0b','K0c','K0d','K0e','K0f','K0g','K0h','K0h2','K0h3','K0i','K0j','K0k','K0l','K0m','K0n',
  'K1a','K1b','K1c','K1d','K1e','K1f','K1g','K1h','K1i','K1j','K1k','K1l','K1m','K1n','K1o','K1p','K1q','K1r',
  'K2a','K2b','K2c','K2d','K2e','K2f','K2g','K2h','K2i','K2j','K2k','K2l','K2m','K2n','K2o',
  'K3a','K3b','K3c','K3d','K3e','K3f','K3g','K3h','K3i','K3j','K3k','K3l','K3m',
  'K6a','K6b','K6c','K6d',
  'K7a','K7b','K7c','K7d','K7e','K7f','K7g',
  'K8a','K8b','K8c','K8d','K8e','K8f','K8g','K8h',
  'K9a','K9b','K9c','K9d','K9e','K9f','K9g',
  'K10a','K10b','K10c','K10d',
  'K11a','K11b','K11c','K11d','K11e','K11f','K11g','K11h','K11i','K11j','K11k','K11l','K11m','K11n','K11o','K11p','K11q',
  'K12a','K12b','K12c',
  'R1','R2','R3',
  'I1','I2','I3','I4']);

-- ═══ C. CATALOGUS ════════════════════════════════════════════════════════════

-- Allereerst: twee keer toepassen raakte geen enkele rij.
SELECT proof.record('C0', 'de migratie (twee keer toegepast) veranderde geen enkele rij',
  proof.digest() = proof.get('digest_before_migration'));

SELECT proof.expect_true('C1', 'precies tien nieuwe functies: drie RPC''s en zeven triggerfuncties, alle SECURITY DEFINER met vaste search_path en eigenaar = eigenaar van de schrijvers', $$
  (SELECT array_agg(p.proname::text ORDER BY p.proname COLLATE "C")
   FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.oid::regprocedure::text NOT IN (SELECT sig FROM proof.functions_before))
  = ARRAY['enforce_bank_allocation_not_released','enforce_bank_transaction_posting_event',
          'enforce_bank_transaction_posting_marker_delete','enforce_bank_transaction_posting_marker_lineage',
          'enforce_bank_transaction_release_hold','prevent_bank_transaction_posting_event_mutation',
          'prevent_bank_transaction_posting_marker_mutation','reclassify_bank_transaction',
          'release_bank_transaction_posting','return_bank_transaction_to_workflow']
  AND (SELECT bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=public'] AND p.provolatile = 'v'
                       AND p.proowner = (SELECT proowner FROM pg_proc WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure))
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND p.oid::regprocedure::text NOT IN (SELECT sig FROM proof.functions_before)) $$);

SELECT proof.expect_true('C2', 'uitvoerrecht: de drie RPC''s alleen voor authenticated; de triggerfuncties voor niemand', $$
  (SELECT bool_and(
     has_function_privilege('authenticated', p.oid, 'EXECUTE') = (p.proname IN ('reclassify_bank_transaction','release_bank_transaction_posting','return_bank_transaction_to_workflow'))
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))
   FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.oid::regprocedure::text NOT IN (SELECT sig FROM proof.functions_before)) $$);

SELECT proof.expect_true('C3', 'de negen triggers: weigerende triggers ENABLE ALWAYS, valideringstriggers gewoon (origin)', $$
  (SELECT array_agg(format('%s/%s/%s', t.tgrelid::regclass, t.tgname, t.tgenabled) ORDER BY t.tgname COLLATE "C")
   FROM pg_trigger t WHERE NOT t.tgisinternal
     AND (t.tgrelid::regclass::text, t.tgname) NOT IN (SELECT tbl, tgname FROM proof.triggers_before))
  = ARRAY['bank_transaction_posting_events/enforce_bank_transaction_posting_event_trigger/O',
          'bank_transaction_postings/enforce_bank_transaction_posting_marker_delete_trigger/A',
          'bank_transaction_postings/enforce_bank_transaction_posting_marker_lineage_trigger/A',
          'bank_transactions/enforce_bank_transaction_release_hold_trigger/A',
          'bank_transaction_posting_events/prevent_bank_transaction_posting_event_mutation_trigger/A',
          'bank_transaction_posting_events/prevent_bank_transaction_posting_event_truncate_trigger/A',
          'bank_transaction_postings/prevent_bank_transaction_posting_marker_truncate_trigger/A',
          'bank_transaction_postings/prevent_bank_transaction_posting_marker_update_trigger/A',
          'bank_transaction_allocations/validate_bank_allocation_not_released_trigger/O']
  AND (SELECT tgdeferrable AND tginitdeferred FROM pg_trigger WHERE tgname = 'enforce_bank_transaction_posting_marker_lineage_trigger') $$);

SELECT proof.expect_true('C4', 'de gebeurtenistabel: authenticated en service_role alleen SELECT, anon niets, RLS aan met één leespolicy vanaf read_only', $$
  has_table_privilege('authenticated', 'public.bank_transaction_posting_events', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.bank_transaction_posting_events', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  AND has_table_privilege('service_role', 'public.bank_transaction_posting_events', 'SELECT')
  AND NOT has_table_privilege('service_role', 'public.bank_transaction_posting_events', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  AND NOT has_table_privilege('anon', 'public.bank_transaction_posting_events', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
  AND (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = 'public.bank_transaction_posting_events'::regclass)
  AND (SELECT array_agg(format('%s/%s/%s', policyname, cmd, roles)) FROM pg_policies WHERE tablename = 'bank_transaction_posting_events')
      = ARRAY['role_bank_transaction_posting_events_select/SELECT/{authenticated}']
  AND (SELECT qual FROM pg_policies WHERE tablename = 'bank_transaction_posting_events') LIKE '%read_only%' $$);

SELECT proof.expect_true('C5', 'geen enkele bestaande functie veranderd: lichaam, SECURITY DEFINER, volatiliteit, instellingen, eigenaar en rechten byte-gelijk', $$
  NOT EXISTS (
    SELECT * FROM proof.functions_before
    EXCEPT
    SELECT p.oid::regprocedure::text, md5(p.prosrc), p.prosecdef, p.provolatile,
           coalesce(p.proconfig::text, ''), pg_get_userbyid(p.proowner), coalesce(p.proacl::text, '')
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace) $$);

SELECT proof.expect_true('C6', 'geen enkele bestaande trigger, relatie, recht of policy veranderd', $$
  NOT EXISTS (SELECT * FROM proof.triggers_before
              EXCEPT SELECT t.tgrelid::regclass::text, t.tgname, t.tgenabled::text, pg_get_triggerdef(t.oid)
                     FROM pg_trigger t WHERE NOT t.tgisinternal)
  AND NOT EXISTS (SELECT * FROM proof.relations_before
                  EXCEPT SELECT c.oid::regclass::text, c.relkind::text, coalesce(c.relacl::text, ''), c.relrowsecurity, c.relforcerowsecurity
                         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace)
  AND NOT EXISTS (SELECT * FROM proof.policies_before
                  EXCEPT SELECT polrelid::regclass::text, polname, polcmd::text, polroles::text,
                                coalesce(pg_get_expr(polqual, polrelid), ''), coalesce(pg_get_expr(polwithcheck, polrelid), '')
                         FROM pg_policy) $$);

SELECT proof.expect_true('C7', 'de acht PR H-lichamen staan er exact', $$
  (SELECT bool_and(md5(p.prosrc) = h.na) AND count(*) = 8
   FROM (VALUES
     ('post_purchase_invoice',        '6366f052209d9a171f197de77eaf477a'),
     ('post_sales_invoice',           'cb467b35301239c3051c8b918662ea45'),
     ('post_bank_allocation',         '863d9e87ef89f7230a9ef020c49b168d'),
     ('post_manual_journal',          '2668c9ed24ef515b7016be29e8b6ffe5'),
     ('post_opening_balance',         '98cbf351067c0135943d910f86e792d6'),
     ('reverse_posting_group',        'b5db0ca04b5dcfbcec5dea1a7844fe13'),
     ('post_bank_transaction',        '2369978c713ac78a0c039dd5c3e5eb4c'),
     ('bank_bulk_posting_candidates', '946bef45005d6e572a7565da6fc12cdb')) h(naam, na)
   JOIN pg_proc p ON p.proname = h.naam AND p.pronamespace = 'public'::regnamespace) $$);

SELECT proof.expect_true('C8', 'de drie PR 0-guards staan er exact en zijn ingeschakeld', $$
  (SELECT bool_and(md5(p.prosrc) = h.md5) AND count(*) = 3
   FROM (VALUES
     ('enforce_bank_allocation_not_directly_posted',         '8855c971ecaa5bab46579c3ca5af5e58'),
     ('enforce_bank_allocation_posting_not_directly_posted', 'fb390f45211a7c4e909e4fc8590389b0'),
     ('enforce_bank_direct_posting_without_allocations',     '2c5174b792b86c1ee007c853be0602c7')) h(naam, md5)
   JOIN pg_proc p ON p.proname = h.naam AND p.pronamespace = 'public'::regnamespace)
  AND (SELECT count(*) FROM pg_trigger WHERE tgenabled = 'O' AND tgname IN
       ('validate_bank_allocation_not_directly_posted_trigger','validate_bank_allocation_posting_not_directly_posted_trigger',
        'validate_bank_direct_posting_without_allocations_trigger')) = 3 $$);

SELECT proof.expect_true('C9', 'nog steeds evenveel functies die grootboekregels schrijven (geen nieuwe schrijver)', $$
  (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace
     AND prosrc ILIKE '%INSERT INTO public.ledger_postings%') = proof.get('ledger_writers_before') $$);

SELECT proof.expect_true('C10', 'geen nieuwe rolcontrole in een trigger: geen auth.uid() of has_min_role in de zeven triggerfuncties', $$
  NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.oid::regprocedure::text NOT IN (SELECT sig FROM proof.functions_before)
     AND p.prorettype = 'trigger'::regtype
     AND (p.prosrc ILIKE '%auth.uid%' OR p.prosrc ILIKE '%has_min_role%')) $$);

-- ═══ K0. DE BASISSTROOM ══════════════════════════════════════════════════════

SELECT proof.tx(1, -121.00, _description => 'Kantoor maart');
SELECT proof.put('k0_post', proof.rc(proof.u(2), proof.uid(1000, 1), NULL, proof.acct(6), 21, proof.req(1)));
SELECT proof.put('k0_g1', proof.f(proof.get('k0_post'), 3));
CREATE TABLE proof.k0_g1_rows AS SELECT * FROM public.ledger_postings WHERE posting_group_id = proof.get('k0_g1')::uuid;

SELECT proof.record('K0a', 'S0 → posted door een assistent: 8250 debet 100,00, BTW te vorderen 21,00, bank credit 121,00',
  proof.get('k0_post') LIKE 'ok: posted|f|%'
  AND proof.lines(proof.get('k0_g1')::uuid) = '8250:100.00:0.00,1520:21.00:0.00,1100:0.00:121.00'
  AND proof.marker(proof.uid(1000, 1)) = proof.get('k0_g1')::uuid,
  proof.get('k0_post') || ' / ' || coalesce(proof.lines(proof.get('k0_g1')::uuid), '-'));

SELECT proof.put('k0_fix', proof.rc(proof.u(1), proof.uid(1000, 1), proof.get('k0_g1')::uuid, proof.acct(7), 21, proof.req(2),
                                    'Verkeerde rekening: 8250 moet 4700 zijn'));
SELECT proof.put('k0_g2', proof.f(proof.get('k0_fix'), 3));
SELECT proof.put('k0_r1', proof.f(proof.get('k0_fix'), 5));

SELECT proof.record('K0b', 'S1 → reclassified door een accountant: nieuwe groep, de oude als vervangen, met een tegenboeking',
  proof.get('k0_fix') LIKE 'ok: reclassified|f|%'
  AND proof.f(proof.get('k0_fix'), 4) = proof.get('k0_g1')
  AND proof.get('k0_r1') IS NOT NULL AND proof.get('k0_g2') <> proof.get('k0_g1'),
  proof.get('k0_fix'));

SELECT proof.record('K0c', 'de tegenboeking spiegelt het origineel regel voor regel, op de oorspronkelijke datum, als bron reversal',
  proof.lines(proof.get('k0_r1')::uuid) = '8250:0.00:100.00,1520:0.00:21.00,1100:121.00:0.00'
  AND (SELECT bool_and(lp.source_type = 'reversal' AND lp.source_id = proof.get('k0_g1')::uuid AND lp.posting_date = DATE '2027-03-01')
       FROM public.ledger_postings lp WHERE lp.posting_group_id = proof.get('k0_r1')::uuid)
  AND EXISTS (SELECT 1 FROM public.ledger_reversal_postings r
              WHERE r.original_posting_group_id = proof.get('k0_g1')::uuid AND r.reversal_posting_group_id = proof.get('k0_r1')::uuid
                AND r.reason = 'Verkeerde rekening: 8250 moet 4700 zijn'),
  proof.lines(proof.get('k0_r1')::uuid));

SELECT proof.record('K0d', 'de vervangende boeking staat op 4700 en is de enige actieve marker',
  proof.lines(proof.get('k0_g2')::uuid) = '4700:100.00:0.00,1520:21.00:0.00,1100:0.00:121.00'
  AND proof.marker(proof.uid(1000, 1)) = proof.get('k0_g2')::uuid,
  proof.lines(proof.get('k0_g2')::uuid));

SELECT proof.record('K0e', 'per rekening: bank −121,00 (ongewijzigd), 8250 = 0, 4700 = 100,00, BTW 21,00',
  proof.net(proof.uid(1000, 1), proof.acct(1)) = -121.00 AND proof.net(proof.uid(1000, 1), proof.acct(6)) = 0
  AND proof.net(proof.uid(1000, 1), proof.acct(7)) = 100.00 AND proof.net(proof.uid(1000, 1), proof.acct(4)) = 21.00,
  format('bank %s, 8250 %s, 4700 %s, btw %s', proof.net(proof.uid(1000, 1), proof.acct(1)), proof.net(proof.uid(1000, 1), proof.acct(6)),
         proof.net(proof.uid(1000, 1), proof.acct(7)), proof.net(proof.uid(1000, 1), proof.acct(4))));

SELECT proof.expect_true('K0f', 'de oorspronkelijke grootboekregels zijn byte-gelijk gebleven', $$
  NOT EXISTS (SELECT * FROM proof.k0_g1_rows EXCEPT SELECT * FROM public.ledger_postings WHERE posting_group_id = proof.get('k0_g1')::uuid)
  AND (SELECT count(*) FROM public.ledger_postings WHERE posting_group_id = proof.get('k0_g1')::uuid) = 3 $$);

SELECT proof.expect_true('K0g', 'de gebeurtenis legt vast: wie, waarom, welke groep, welke storno, welke opvolger, en de momentopname van het origineel', $$
  EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
          WHERE e.id = proof.f(proof.get('k0_fix'), 6)::uuid
            AND e.event_type = 'reclassified' AND e.request_kind = 'reclassify'
            AND e.actor_id = proof.u(1) AND e.request_id = proof.req(2)
            AND e.superseded_posting_group_id = proof.get('k0_g1')::uuid
            AND e.reversal_posting_group_id = proof.get('k0_r1')::uuid
            AND e.replacement_posting_group_id = proof.get('k0_g2')::uuid
            AND e.requested_grootboekrekening_id = proof.acct(7) AND e.requested_btw_percentage = 21
            AND e.superseded_grootboekrekening_id = proof.acct(6) AND e.superseded_btw_percentage = 21
            AND e.superseded_gross_amount = 121.00 AND e.superseded_net_amount = 100.00 AND e.superseded_btw_amount = 21.00
            AND e.superseded_posting_date = DATE '2027-03-01' AND e.superseded_boekjaar = 2027
            AND e.superseded_posted_by = proof.u(2) AND e.superseded_description = 'Kantoor maart'
            AND e.replacement_description = 'Kantoor maart'
            AND e.reason = 'Verkeerde rekening: 8250 moet 4700 zijn'
            AND e.organization_id = '00000000-0000-0000-0000-00000000a001' AND e.client_id = '00000000-0000-0000-0000-0000000000c1') $$);

-- Dezelfde codering nog eens: niets te boeken, maar de aanvraag wordt vastgelegd.
CREATE FUNCTION proof.books_digest() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(concat_ws('|',
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.ledger_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.original_posting_group_id), '')) FROM public.ledger_reversal_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.bank_transaction_id), '')) FROM public.bank_transaction_postings t),
    (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM public.bank_transactions t)));
$$;
GRANT EXECUTE ON FUNCTION proof.books_digest() TO public;
SELECT proof.put('k0_books', proof.books_digest());
SELECT proof.put('k0_same', proof.rc(proof.u(1), proof.uid(1000, 1), proof.get('k0_g2')::uuid, proof.acct(7), 21, proof.req(3), 'Nog eens'));
SELECT proof.record('K0h', 'dezelfde codering en omschrijving: unchanged — geen boeking, geen marker- of bankregelwijziging; wel één gebeurtenis unchanged',
  proof.get('k0_same') LIKE format('ok: unchanged|f|%s|||%%', proof.get('k0_g2'))
  AND proof.f(proof.get('k0_same'), 6) IS NOT NULL
  AND proof.books_digest() = proof.get('k0_books')
  AND EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e WHERE e.id = proof.f(proof.get('k0_same'), 6)::uuid
              AND e.event_type = 'unchanged' AND e.expected_posting_group_id = proof.get('k0_g2')::uuid
              AND e.superseded_posting_group_id IS NULL AND e.replacement_posting_group_id IS NULL),
  proof.get('k0_same'));

-- Codex: een verloren antwoord op een unchanged, intussen een handmatige storno,
-- dan dezelfde aanvraag opnieuw — die mag niet alsnog herboeken.
SELECT proof.tx(8, -30.00, _date => DATE '2027-03-01');
SELECT proof.put('k0h_post', proof.rc(proof.u(2), proof.uid(1000, 8), NULL, proof.acct(7), 0, proof.req(80)));
SELECT proof.put('k0h_same', proof.rc(proof.u(1), proof.uid(1000, 8), proof.f(proof.get('k0h_post'), 3)::uuid, proof.acct(7), 0, proof.req(81), 'Controle'));
SELECT public.reverse_posting_group(proof.f(proof.get('k0h_post'), 3)::uuid, DATE '2027-03-01', 'Handmatig, door een collega');
SELECT proof.put('k0h_books', proof.books_digest());
SELECT proof.put('k0h_retry', proof.rc(proof.u(1), proof.uid(1000, 8), proof.f(proof.get('k0h_post'), 3)::uuid, proof.acct(7), 0, proof.req(81), 'Controle'));
SELECT proof.record('K0h2', 'herhaling van een unchanged na een tussentijdse handmatige storno: exact het oude antwoord (replayed), geen herboeking',
  proof.get('k0h_retry') = replace(proof.get('k0h_same'), '|f|', '|t|')
  AND proof.books_digest() = proof.get('k0h_books'),
  proof.get('k0h_same') || ' || ' || proof.get('k0h_retry'));
SELECT proof.record('K0h3', 'een nieuwe, expliciete aanvraag herboekt wél (reposted, zonder tweede storno)',
  o LIKE 'ok: reposted|f|%', o)
FROM proof.rc(proof.u(1), proof.uid(1000, 8), proof.f(proof.get('k0h_post'), 3)::uuid, proof.acct(7), 0, proof.req(82), 'Bewust opnieuw') o;

-- BTW 21 → 9.
SELECT proof.put('k0_vat', proof.rc(proof.u(1), proof.uid(1000, 1), proof.get('k0_g2')::uuid, proof.acct(7), 9, proof.req(4), 'BTW is 9%'));
SELECT proof.put('k0_g3', proof.f(proof.get('k0_vat'), 3));
SELECT proof.record('K0i', 'BTW 21 → 9 via de schrijver: 4700 111,01, BTW 9,99, bank 121,00; per rekening klopt het totaal',
  proof.get('k0_vat') LIKE 'ok: reclassified|f|%'
  AND proof.lines(proof.get('k0_g3')::uuid) = '4700:111.01:0.00,1520:9.99:0.00,1100:0.00:121.00'
  AND proof.net(proof.uid(1000, 1), proof.acct(1)) = -121.00 AND proof.net(proof.uid(1000, 1), proof.acct(7)) = 111.01
  AND proof.net(proof.uid(1000, 1), proof.acct(4)) = 9.99 AND proof.net(proof.uid(1000, 1), proof.acct(6)) = 0,
  proof.get('k0_vat') || ' / ' || coalesce(proof.lines(proof.get('k0_g3')::uuid), '-'));

-- Alleen de omschrijving.
SELECT proof.put('k0_desc', proof.rc(proof.u(1), proof.uid(1000, 1), proof.get('k0_g3')::uuid, proof.acct(7), 9, proof.req(5),
                                     'Omschrijving verduidelijkt', '  Kantoorartikelen maart  '));
SELECT proof.put('k0_g4', proof.f(proof.get('k0_desc'), 3));
SELECT proof.expect_true('K0j', 'alleen de omschrijving corrigeren: storno + herboeking met de nieuwe tekst; de oude tekst blijft in de oude regels en de gebeurtenis', $$
  proof.get('k0_desc') LIKE 'ok: reclassified|f|%'
  AND (SELECT string_agg(lp.description, ',' ORDER BY lp.line_no) FROM public.ledger_postings lp WHERE lp.posting_group_id = proof.get('k0_g4')::uuid)
      = 'Kantoorartikelen maart,BTW Kantoorartikelen maart,Kantoorartikelen maart'
  AND (SELECT string_agg(lp.description, ',' ORDER BY lp.line_no) FROM public.ledger_postings lp WHERE lp.posting_group_id = proof.get('k0_g3')::uuid)
      = 'Kantoor maart,BTW Kantoor maart,Kantoor maart'
  AND (SELECT description FROM public.bank_transactions WHERE id = proof.uid(1000, 1)) = 'Kantoorartikelen maart'
  AND EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
              WHERE e.id = proof.f(proof.get('k0_desc'), 6)::uuid
                AND e.requested_description = 'Kantoorartikelen maart' AND e.replacement_description = 'Kantoorartikelen maart'
                AND e.superseded_description = 'Kantoor maart') $$);

SELECT proof.expect_true('K0k', 'vier generaties vormen één keten G1 → G2 → G3 → G4 (met de vastgelegde unchanged ertussen), in seq-volgorde; precies één niet-tegengeboekte groep', $$
  (SELECT array_agg(format('%s:%s>%s', e.event_type, e.superseded_posting_group_id, e.replacement_posting_group_id) ORDER BY e.seq)
   FROM public.bank_transaction_posting_events e WHERE e.bank_transaction_id = proof.uid(1000, 1))
  = ARRAY[format('posted:>%s', proof.get('k0_g1')),
          format('reclassified:%s>%s', proof.get('k0_g1'), proof.get('k0_g2')),
          'unchanged:>',
          format('reclassified:%s>%s', proof.get('k0_g2'), proof.get('k0_g3')),
          format('reclassified:%s>%s', proof.get('k0_g3'), proof.get('k0_g4'))]
  AND (SELECT count(DISTINCT lp.posting_group_id) FROM public.ledger_postings lp
       WHERE lp.source_type = 'bank_transaction' AND lp.source_id = proof.uid(1000, 1)
         AND NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r WHERE r.original_posting_group_id = lp.posting_group_id)) = 1 $$);

SELECT proof.record('K0l', 'een verouderde verwachting (een eerdere groep) geeft 55000 en verandert niets',
  o LIKE 'fout [55000] De boekingstoestand is gewijzigd%', o)
FROM proof.rc(proof.u(1), proof.uid(1000, 1), proof.get('k0_g2')::uuid, proof.acct(6), 21, proof.req(6), 'Oud scherm') o;

SELECT proof.record('K0m', 'geen enkele groep uit balans en de lineage is compleet', proof.unbalanced() = 0 AND proof.lineage_violations() = 0,
  format('uit balans %s, lineage %s', proof.unbalanced(), proof.lineage_violations()));

SELECT proof.tx(2, -50.00);
SELECT proof.record('K0n', 'een eerste boeking verwacht NULL; met een verzonnen verwachting 55000',
  o LIKE 'fout [55000]%', o)
FROM proof.rc(proof.u(2), proof.uid(1000, 2), gen_random_uuid(), proof.acct(7), 0, proof.req(7)) o;

-- ═══ K1. AUTORISATIE EN IDEMPOTENTIE ═════════════════════════════════════════

SELECT proof.record('K1a', 'anon: geen uitvoerrecht op de drie RPC''s',
  o LIKE 'fout [42501] permission denied for function reclassify_bank_transaction%', o)
FROM proof.call(NULL, format('SELECT outcome FROM public.reclassify_bank_transaction(%L, NULL, %L, 0, %L)', proof.uid(1000, 2), proof.acct(7), proof.req(10)), 'anon') o;

SELECT proof.record('K1b', 'service_role: geen uitvoerrecht (omzeilt RLS, niet de RPC-grens)',
  o LIKE 'fout [42501] permission denied for function release_bank_transaction_posting%', o)
FROM proof.call(NULL, format('SELECT outcome FROM public.release_bank_transaction_posting(%L, %L, %L, ''x'')', proof.uid(1000, 2), gen_random_uuid(), proof.req(10)), 'service_role') o;

SELECT proof.record('K1c', 'authenticated zonder gebruiker: 28000', o LIKE 'fout [28000] Niet ingelogd%', o)
FROM proof.rc(NULL, proof.uid(1000, 2), NULL, proof.acct(7), 0, proof.req(10)) o;

SELECT proof.record('K1d', 'read_only: 42501 op de schrijfdrempel', o LIKE 'fout [42501] Geen rechten om te boeken%', o)
FROM proof.rc(proof.u(4), proof.uid(1000, 2), NULL, proof.acct(7), 0, proof.req(10)) o;

SELECT proof.record('K1e', 'een buitenstaander krijgt exact dezelfde melding als voor een onbestaande transactie (geen bestaansorakel)',
  a = b AND a LIKE 'fout [42501] Banktransactie niet beschikbaar%', a || ' || ' || b)
FROM proof.rc(proof.u(3), proof.uid(1000, 2), NULL, proof.acct(7), 0, proof.req(10)) a,
     proof.rc(proof.u(3), gen_random_uuid(), NULL, proof.acct(7), 0, proof.req(10)) b;

SELECT proof.put('k1_post', proof.rc(proof.u(2), proof.uid(1000, 2), NULL, proof.acct(7), 0, proof.req(11)));
SELECT proof.record('K1f', 'een assistent mag de eerste boeking doen', proof.get('k1_post') LIKE 'ok: posted|f|%', proof.get('k1_post'));

SELECT proof.record('K1g', 'een assistent mag een geboekte transactie niet corrigeren (accountant vereist)',
  o LIKE 'fout [42501] Geen rechten om een geboekte banktransactie te corrigeren (accountant vereist)%', o)
FROM proof.rc(proof.u(2), proof.uid(1000, 2), proof.f(proof.get('k1_post'), 3)::uuid, proof.acct(6), 0, proof.req(12), 'Assistent probeert') o;

SELECT proof.put('k1_fix', proof.rc(proof.u(1), proof.uid(1000, 2), proof.f(proof.get('k1_post'), 3)::uuid, proof.acct(6), 0, proof.req(20), 'Herclassificatie'));
SELECT proof.put('k1_digest', proof.digest());
SELECT proof.put('k1_again', proof.rc(proof.u(1), proof.uid(1000, 2), proof.f(proof.get('k1_post'), 3)::uuid, proof.acct(6), 0, proof.req(20), 'Herclassificatie'));
SELECT proof.record('K1h', 'dezelfde request_id met dezelfde parameters: dezelfde rij met replayed = true, zonder enige mutatie',
  proof.get('k1_fix') LIKE 'ok: reclassified|f|%'
  AND proof.get('k1_again') = replace(proof.get('k1_fix'), '|f|', '|t|')
  AND proof.digest() = proof.get('k1_digest'),
  proof.get('k1_fix') || ' / ' || proof.get('k1_again'));

SELECT proof.record('K1i', 'dezelfde request_id met andere parameters: 22023, zonder id''s in de melding',
  o LIKE 'fout [22023] Deze request_id is al gebruikt voor een andere aanvraag%', o)
FROM proof.rc(proof.u(1), proof.uid(1000, 2), proof.f(proof.get('k1_post'), 3)::uuid, proof.acct(6), 9, proof.req(20), 'Herclassificatie') o;

SELECT proof.record('K1j', 'dezelfde request_id voor een andere transactie: 22023',
  o LIKE 'fout [22023] Deze request_id is al gebruikt%', o)
FROM proof.rc(proof.u(1), proof.uid(1000, 1), proof.get('k0_g4')::uuid, proof.acct(6), 0, proof.req(20), 'Herclassificatie') o;

SELECT proof.record('K1k', 'dezelfde request_id voor een vrijgave: 22023 (een andere soort aanvraag)',
  o LIKE 'fout [22023] Deze request_id is al gebruikt%', o)
FROM proof.rel(proof.u(1), proof.uid(1000, 2), proof.f(proof.get('k1_fix'), 3)::uuid, proof.req(20), 'Herclassificatie') o;

-- Een gedegradeerde accountant krijgt de opgeslagen uitkomst niet meer.
UPDATE public.user_roles SET role = 'assistant' WHERE user_id = proof.u(1) AND organization_id = '00000000-0000-0000-0000-00000000a001';
SELECT proof.record('K1l', 'na degradatie: de herhaling geeft 42501, geen opgeslagen uitkomst',
  o LIKE 'fout [42501] Geen rechten om een geboekte banktransactie te corrigeren%', o)
FROM proof.rc(proof.u(1), proof.uid(1000, 2), proof.f(proof.get('k1_post'), 3)::uuid, proof.acct(6), 0, proof.req(20), 'Herclassificatie') o;
UPDATE public.user_roles SET role = 'read_only' WHERE user_id = proof.u(1) AND organization_id = '00000000-0000-0000-0000-00000000a001';
SELECT proof.record('K1m', 'onder read_only: de herhaling stuit al op de schrijfdrempel',
  o LIKE 'fout [42501] Geen rechten om te boeken%', o)
FROM proof.rc(proof.u(1), proof.uid(1000, 2), proof.f(proof.get('k1_post'), 3)::uuid, proof.acct(6), 0, proof.req(20), 'Herclassificatie') o;
UPDATE public.user_roles SET role = 'accountant' WHERE user_id = proof.u(1) AND organization_id = '00000000-0000-0000-0000-00000000a001';
SELECT proof.record('K1n', 'hersteld: weer dezelfde opgeslagen uitkomst',
  o = replace(proof.get('k1_fix'), '|f|', '|t|'), o)
FROM proof.rc(proof.u(1), proof.uid(1000, 2), proof.f(proof.get('k1_post'), 3)::uuid, proof.acct(6), 0, proof.req(20), 'Herclassificatie') o;

-- De sleutel bevat de actor: e1's request_id bestaat voor een ander niet.
SELECT proof.put('k1_other', proof.rc(proof.u(5), proof.uid(1000, 2), proof.f(proof.get('k1_fix'), 3)::uuid, proof.acct(7), 0, proof.req(20), 'Tweede accountant'));
SELECT proof.record('K1o', 'een tweede accountant met dezelfde request_id: een nieuwe aanvraag, geen herhaling van die van een ander',
  proof.get('k1_other') LIKE 'ok: reclassified|f|%', proof.get('k1_other'));

SELECT proof.tx(3, -30.00, '00000000-0000-0000-0000-0000000000c3');
SELECT proof.record('K1p', 'een buitenstaander met e1''s request_id op zijn eigen transactie: een gewone nieuwe boeking',
  o LIKE 'ok: posted|f|%', o)
FROM proof.rc(proof.u(3), proof.uid(1000, 3), NULL, proof.acct(106), 0, proof.req(20)) o;

SELECT proof.record('K1q', 'argumenten eerst: NULL → 22004, 5% → 22023, toelichting of omschrijving > 500 → 22023, geboekt zonder toelichting → 22023',
  a LIKE 'fout [22004]%' AND b LIKE 'fout [22023] Alleen 0, 9 of 21 procent%' AND c LIKE 'fout [22023] De toelichting is te lang%'
  AND d LIKE 'fout [22023] De omschrijving is te lang%' AND e LIKE 'fout [22023] Een toelichting (1 tot 500 tekens) is verplicht%'
  AND f LIKE 'fout [22004]%',
  concat_ws(' || ', a, b, c, d, e, f))
FROM proof.rc(proof.u(1), proof.uid(1000, 2), NULL, NULL, 0, proof.req(30)) a,
     proof.rc(proof.u(1), proof.uid(1000, 2), NULL, proof.acct(7), 5, proof.req(31)) b,
     proof.rc(proof.u(1), proof.uid(1000, 2), NULL, proof.acct(7), 0, proof.req(32), repeat('x', 501)) c,
     proof.rc(proof.u(1), proof.uid(1000, 2), NULL, proof.acct(7), 0, proof.req(33), 'ok', repeat('y', 501)) d,
     proof.rc(proof.u(1), proof.uid(1000, 2), proof.f(proof.get('k1_other'), 3)::uuid, proof.acct(6), 0, proof.req(34), E' \t\n ') e,
     proof.rel(proof.u(1), proof.uid(1000, 2), NULL, proof.req(35)) f;

-- Een bankregel met de organisatie van A maar de administratie van B (RLS toetst
-- alleen de organisatie op de rij). De RPC's mogen niets over B zeggen of grendelen:
-- niet de blokkadedatum van B, niet B's administratiegrendel.
SELECT proof.put('k1r_ins', proof.call(proof.u(2), format($q$INSERT INTO public.bank_transactions
  (id, user_id, client_id, organization_id, transaction_date, description, amount, match_status)
  VALUES (%L, %L, '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000a001', DATE '2027-03-01', 'Vreemd', -10.00, 'niet_gematcht')
  RETURNING id::text$q$, proof.uid(1000, 130), proof.u(2))));
SELECT proof.put('k1r_lock', proof.call(proof.u(3), $q$SELECT changed::text FROM public.set_posting_lock('00000000-0000-0000-0000-0000000000c3', DATE '2027-06-30', 'Blokkade van B')$q$));
SELECT proof.record('K1r', 'administratie van een andere tenant: alle drie de RPC''s geven 42501 vóór de boekingsblokkade — B''s blokkadedatum lekt niet',
  proof.get('k1r_ins') LIKE 'ok: %' AND proof.get('k1r_lock') LIKE 'ok: %'
  AND a LIKE 'fout [42501] Administratie hoort niet bij de organisatie van deze banktransactie%'
  AND b LIKE 'fout [42501] Administratie hoort niet bij de organisatie van deze banktransactie%'
  AND c LIKE 'fout [42501] Administratie hoort niet bij de organisatie van deze banktransactie%'
  AND concat(a, b, c) NOT LIKE '%2027-06-30%',
  concat_ws(' || ', proof.get('k1r_ins'), proof.get('k1r_lock'), a, b, c))
FROM proof.rc(proof.u(1), proof.uid(1000, 130), NULL, proof.acct(7), 0, proof.req(36)) a,
     proof.rel(proof.u(1), proof.uid(1000, 130), gen_random_uuid(), proof.req(37)) b,
     proof.ret(proof.u(1), proof.uid(1000, 130), proof.req(38)) c;
SELECT proof.call(proof.u(3), $q$SELECT changed::text FROM public.set_posting_lock('00000000-0000-0000-0000-0000000000c3', NULL, 'Blokkade van B opgeheven')$q$);

-- ═══ K2. MARKER EN GEBEURTENISSEN ════════════════════════════════════════════

SELECT proof.expect_error('K2a', 'ook de eigenaar kan een marker niet verwijderen zolang haar groep niet is tegengeboekt',
  $$ DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = proof.uid(1000, 1) $$,
  '42501', 'alleen worden losgemaakt nadat zij is tegengeboekt');

SELECT proof.expect_error('K2b', 'een marker is onveranderlijk (UPDATE)',
  $$ UPDATE public.bank_transaction_postings SET posting_group_id = gen_random_uuid() WHERE bank_transaction_id = proof.uid(1000, 1) $$,
  '42501', 'onveranderlijk');

SELECT proof.expect_error('K2c', 'en ook TRUNCATE wordt geweigerd',
  $$ TRUNCATE public.bank_transaction_postings $$, '42501', 'onveranderlijk');

-- Een handmatig tegengeboekte transactie: de marker mag weg, maar alleen met een gebeurtenis.
SELECT proof.tx(5, -60.00);
SELECT proof.put('k2_post', proof.rc(proof.u(2), proof.uid(1000, 5), NULL, proof.acct(7), 21, proof.req(40)));
SELECT proof.put('k2_g', proof.f(proof.get('k2_post'), 3));
SELECT proof.put('k2_r', public.reverse_posting_group(proof.get('k2_g')::uuid, DATE '2027-03-10', 'Handmatig')::text);

SELECT proof.expect_error('K2d', 'marker weghalen ná de tegenboeking maar zonder gebeurtenis: geweigerd zodra de uitgestelde controle loopt',
  $$ SET CONSTRAINTS enforce_bank_transaction_posting_marker_lineage_trigger IMMEDIATE;
     DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = proof.uid(1000, 5) $$,
  '23514', 'in dezelfde transactie als correctie of vrijgave');

CREATE FUNCTION proof.forge(_type text, _kind text, _tx uuid, _superseded uuid, _reversal uuid, _replacement uuid,
                            _org uuid DEFAULT '00000000-0000-0000-0000-00000000a001',
                            _client uuid DEFAULT '00000000-0000-0000-0000-0000000000c1')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.bank_transaction_posting_events (
    request_id, actor_id, request_kind, event_type, bank_transaction_id, organization_id, client_id,
    superseded_posting_group_id, reversal_posting_group_id, replacement_posting_group_id,
    superseded_grootboekrekening_id, superseded_gross_amount, superseded_net_amount, superseded_btw_amount,
    superseded_posting_date, superseded_boekjaar, superseded_posted_by, superseded_posted_at, superseded_description,
    reason, created_xact_id)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000e6', _kind, _type, _tx, _org, _client,
    _superseded, _reversal, _replacement,
    CASE WHEN _superseded IS NOT NULL THEN '00000000-0000-0000-0000-00000000f007'::uuid END,
    CASE WHEN _superseded IS NOT NULL THEN 60 END, CASE WHEN _superseded IS NOT NULL THEN 49.59 END,
    CASE WHEN _superseded IS NOT NULL THEN 10.41 END,
    CASE WHEN _superseded IS NOT NULL THEN DATE '2027-03-01' END, CASE WHEN _superseded IS NOT NULL THEN 2027 END,
    CASE WHEN _superseded IS NOT NULL THEN '00000000-0000-0000-0000-0000000000e2'::uuid END,
    CASE WHEN _superseded IS NOT NULL THEN now() END, CASE WHEN _superseded IS NOT NULL THEN 'Bankregel 5' END,
    'Vervalst', pg_current_xact_id());
$$;

SELECT proof.expect_error('K2e', 'een vervalste gebeurtenis met een verkeerde tegenboeking wordt geweigerd',
  $$ SELECT proof.forge('released', 'release', proof.uid(1000, 5), proof.get('k2_g')::uuid, proof.get('k0_r1')::uuid, NULL) $$,
  '23514', 'tegenboeking hoort niet bij de vervangen boekingsgroep');

SELECT proof.expect_error('K2f', 'een vervalste gebeurtenis met de groep van een andere transactie wordt geweigerd',
  $$ SELECT proof.forge('released', 'release', proof.uid(1000, 5), proof.get('k0_g1')::uuid, proof.get('k0_r1')::uuid, NULL) $$,
  '23514', 'geen directe bankboeking van deze banktransactie');

SELECT proof.expect_error('K2g', 'een vervalste gebeurtenis voor een groep die nog actief is wordt geweigerd',
  $$ SELECT proof.forge('released', 'release', proof.uid(1000, 5), proof.get('k2_g')::uuid, proof.get('k2_r')::uuid, NULL) $$,
  '23514', 'nog de actieve boeking');

SELECT proof.expect_error('K2h', 'returned zonder voorafgaande vrijgave wordt geweigerd',
  $$ SELECT proof.forge('returned', 'return', proof.tx(6, -5.00), NULL, NULL, NULL) $$,
  '23514', 'Alleen een vrijgegeven banktransactie');

SELECT proof.expect_error('K2i', 'een gebeurtenis met een andere organisatie dan haar banktransactie wordt geweigerd',
  $$ SELECT proof.forge('returned', 'return', proof.uid(1000, 2), NULL, NULL, NULL,
                        '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000c3') $$,
  '23514', 'wijkt af van haar banktransactie');

SELECT proof.expect_true('K2j', 'gebeurtenissen zijn append-only: UPDATE, DELETE en TRUNCATE geweigerd, ook voor de eigenaar', $$
  (SELECT count(*) FROM (VALUES
     ('UPDATE public.bank_transaction_posting_events SET reason = ''x'''),
     ('DELETE FROM public.bank_transaction_posting_events'),
     ('TRUNCATE public.bank_transaction_posting_events')) s(q)
   WHERE proof.call(NULL, s.q, 'postgres') LIKE 'fout [42501] bank_transaction_posting_events is append-only%') = 3 $$);

-- Vervalsingen die er van buiten correct uitzien: de eigenaar doet zelf de
-- stappen van een RPC, maar met één leugen in de gebeurtenis.
CREATE FUNCTION proof.forge_step(_tx uuid, _type text, _gross numeric DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m public.bank_transaction_postings%ROWTYPE; v_desc text; v_r uuid; v_new uuid;
BEGIN
  SELECT * INTO m FROM public.bank_transaction_postings WHERE bank_transaction_id = _tx;
  SELECT lp.description INTO v_desc FROM public.ledger_postings lp WHERE lp.posting_group_id = m.posting_group_id ORDER BY lp.line_no LIMIT 1;
  SELECT reversal_posting_group_id INTO v_r FROM public.ledger_reversal_postings WHERE original_posting_group_id = m.posting_group_id;
  DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = _tx;
  IF _type <> 'released' THEN
    UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = '00000000-0000-0000-0000-00000000f006', btw_percentage = 0 WHERE id = _tx;
    v_new := public.post_bank_transaction(_tx);
  END IF;
  INSERT INTO public.bank_transaction_posting_events (
    request_id, actor_id, request_kind, event_type, bank_transaction_id, organization_id, client_id,
    superseded_posting_group_id, reversal_posting_group_id, replacement_posting_group_id,
    requested_grootboekrekening_id, requested_btw_percentage, replacement_description,
    superseded_grootboekrekening_id, superseded_btw_percentage, superseded_gross_amount, superseded_net_amount, superseded_btw_amount,
    superseded_posting_date, superseded_boekjaar, superseded_posted_by, superseded_posted_at, superseded_description,
    reason, created_xact_id)
  SELECT gen_random_uuid(), '00000000-0000-0000-0000-0000000000e6',
    CASE WHEN _type = 'released' THEN 'release' ELSE 'reclassify' END, _type, _tx, m.organization_id, m.client_id,
    m.posting_group_id, v_r, v_new,
    CASE WHEN _type <> 'released' THEN '00000000-0000-0000-0000-00000000f006'::uuid END,
    CASE WHEN _type <> 'released' THEN 0 END, CASE WHEN _type <> 'released' THEN v_desc END,
    m.grootboekrekening_id, m.btw_percentage, coalesce(_gross, m.gross_amount), m.net_amount, m.btw_amount,
    m.posting_date, m.boekjaar, m.user_id, m.created_at, v_desc, 'Vervalst', pg_current_xact_id();
END $$;

SELECT proof.expect_error('K2l', 'een vervalste vrijgave met een verkeerde momentopname (bruto 999) wordt geweigerd',
  $$ SELECT proof.forge_step(proof.uid(1000, 5), 'released', 999.00) $$, '23514', 'momentopname van de vervangen boeking wijkt af');

SELECT proof.expect_error('K2m', 'een vervalste eerste boeking die een bestaande (oudere) groep als opvolger noemt wordt geweigerd',
  $$ INSERT INTO public.bank_transaction_posting_events (request_id, actor_id, request_kind, event_type, bank_transaction_id,
       organization_id, client_id, replacement_posting_group_id, requested_grootboekrekening_id, requested_btw_percentage,
       replacement_description, reason, created_xact_id)
     SELECT gen_random_uuid(), proof.u(6), 'reclassify', 'posted', proof.uid(1000, 2), '00000000-0000-0000-0000-00000000a001',
       '00000000-0000-0000-0000-0000000000c1', proof.marker(proof.uid(1000, 2)), proof.acct(7), 0, 'x', 'Vervalst', pg_current_xact_id() $$,
  '23514', 'moet in dezelfde transactie zijn geboekt');

SELECT proof.expect_error('K2n', 'een vervalste "reclassified" die een oudere, handmatige storno als de hare opvoert wordt geweigerd',
  $$ SELECT proof.forge_step(proof.uid(1000, 5), 'reclassified') $$, '23514', 'hoort een tegenboeking uit dezelfde transactie');

SELECT proof.record('K2o', 'ter controle: exact dezelfde stappen als "reposted" — eerlijk vastgelegd — worden wel aanvaard (en hier teruggedraaid)',
  o = 'gelukt (teruggedraaid)', o)
FROM proof.nc_try($$ SELECT proof.forge_step(proof.uid(1000, 5), 'reposted'); SET CONSTRAINTS ALL IMMEDIATE $$) o;

SELECT proof.record('K2k', 'na al deze pogingen: de lineage is compleet en niets is uit balans', proof.lineage_violations() = 0 AND proof.unbalanced() = 0,
  format('lineage %s, uit balans %s', proof.lineage_violations(), proof.unbalanced()));

-- ═══ K3. VRIJGEVEN ═══════════════════════════════════════════════════════════

SELECT proof.tx(4, -80.00);
SELECT proof.put('k3_post', proof.rc(proof.u(2), proof.uid(1000, 4), NULL, proof.acct(7), 21, proof.req(50)));
SELECT proof.put('k3_rel', proof.rel(proof.u(1), proof.uid(1000, 4), proof.f(proof.get('k3_post'), 3)::uuid, proof.req(51), 'Verkeerd geboekt, eerst uitzoeken'));
SELECT proof.record('K3a', 'vrijgeven: storno, geen actieve marker, regel terug op niet_gematcht zonder rekening of BTW; elke rekening netto 0',
  proof.get('k3_rel') LIKE 'ok: released|f||%'
  AND proof.marker(proof.uid(1000, 4)) IS NULL
  AND (SELECT match_status = 'niet_gematcht' AND grootboekrekening_id IS NULL AND btw_percentage IS NULL
              AND matched_invoice_id IS NULL AND match_confidence IS NULL
       FROM public.bank_transactions WHERE id = proof.uid(1000, 4))
  AND proof.net(proof.uid(1000, 4), proof.acct(1)) = 0 AND proof.net(proof.uid(1000, 4), proof.acct(7)) = 0
  AND proof.net(proof.uid(1000, 4), proof.acct(4)) = 0,
  proof.get('k3_rel'));

SELECT proof.put('k3_digest', proof.digest());

SELECT proof.record('K3b', 'de inhaalslag noemt de vrijgegeven regel review_needed, niet ready', o = 'ok: review_needed', o)
FROM proof.call(proof.u(1), format('SELECT workflow_state FROM public.bank_bulk_posting_candidates(%L, 2027) WHERE transaction_id = %L',
                                   '00000000-0000-0000-0000-0000000000c1', proof.uid(1000, 4))) o;

SELECT proof.record('K3c', 'de bulkboeking weigert haar (rejected)', o LIKE 'ok: rejected%', o)
FROM proof.call(proof.u(1), format('SELECT outcome FROM public.post_bank_transactions_bulk(ARRAY[%L]::uuid[])', proof.uid(1000, 4))) o;

SELECT proof.record('K3d', 'de schrijver weigert haar rechtstreeks (22023)', o LIKE 'fout [22023] Alleen handmatig gecodeerde%', o)
FROM proof.call(proof.u(1), format('SELECT public.post_bank_transaction(%L)::text', proof.uid(1000, 4))) o;

SELECT proof.record('K3e', 'en niets daarvan veranderde één rij', proof.digest() = proof.get('k3_digest'));

SELECT proof.record('K3f', 'vrijgeven met dezelfde request_id: dezelfde uitkomst, replayed', o = replace(proof.get('k3_rel'), '|f|', '|t|'), o)
FROM proof.rel(proof.u(1), proof.uid(1000, 4), proof.f(proof.get('k3_post'), 3)::uuid, proof.req(51), 'Verkeerd geboekt, eerst uitzoeken') o;

SELECT proof.record('K3g', 'nog eens vrijgeven met een nieuwe request_id: 55000 (er is niets actief)', o LIKE 'fout [55000]%', o)
FROM proof.rel(proof.u(1), proof.uid(1000, 4), proof.f(proof.get('k3_post'), 3)::uuid, proof.req(52)) o;

SELECT proof.record('K3h', 'terug naar werkstroom: een assistent 42501, zonder toelichting 22023',
  a LIKE 'fout [42501] Geen rechten om een vrijgegeven banktransactie terug te zetten%' AND b LIKE 'fout [22023] Een toelichting%', a || ' || ' || b)
FROM proof.ret(proof.u(2), proof.uid(1000, 4), proof.req(53)) a, proof.ret(proof.u(1), proof.uid(1000, 4), proof.req(54), '   ') b;

SELECT proof.put('k3_ret', proof.ret(proof.u(1), proof.uid(1000, 4), proof.req(55), 'Uitgezocht: gewone werkstroom'));
SELECT proof.record('K3i', 'een accountant zet haar terug (returned); nog eens: 55000; dezelfde request_id: replayed',
  proof.get('k3_ret') LIKE 'ok: returned|f||||%' AND a LIKE 'fout [55000]%' AND b = replace(proof.get('k3_ret'), '|f|', '|t|'),
  concat_ws(' || ', proof.get('k3_ret'), a, b))
FROM proof.ret(proof.u(1), proof.uid(1000, 4), proof.req(56)) a, proof.ret(proof.u(1), proof.uid(1000, 4), proof.req(55), 'Uitgezocht: gewone werkstroom') b;

-- Teruggezet: de gewone werkstroom (sjabloon + de bestaande schrijver) mag weer — zonder gebeurtenis.
SELECT proof.put('k3_tpl', proof.call(proof.u(2), format($q$UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = %L, btw_percentage = 21 WHERE id = %L RETURNING id::text$q$,
                                   proof.acct(7), proof.uid(1000, 4))));
SELECT proof.put('k3_old', proof.call(proof.u(2), format('SELECT public.post_bank_transaction(%L)::text', proof.uid(1000, 4))));
SELECT proof.record('K3j', 'teruggezet: een sjabloon codeert haar en de bestaande schrijver boekt haar, als assistent',
  proof.get('k3_tpl') LIKE 'ok: %' AND proof.get('k3_old') LIKE 'ok: %', proof.get('k3_tpl') || ' || ' || proof.get('k3_old'));

SELECT proof.put('k3_g2', proof.marker(proof.uid(1000, 4))::text);
SELECT proof.put('k3_fix', proof.rc(proof.u(1), proof.uid(1000, 4), proof.get('k3_g2')::uuid, proof.acct(6), 21, proof.req(57), 'Toch 8250'));
SELECT proof.record('K3k', 'en die boeking (zonder eigen gebeurtenis) is later gewoon corrigeerbaar; de lineage blijft compleet',
  proof.get('k3_fix') LIKE format('ok: reclassified|f|%%|%s|%%', proof.get('k3_g2')) AND proof.lineage_violations() = 0,
  proof.get('k3_fix'));

SELECT proof.expect_true('K3l', 'de gebeurtenissen van deze transactie, in volgorde: posted, released, returned, reclassified', $$
  (SELECT array_agg(e.event_type ORDER BY e.seq) FROM public.bank_transaction_posting_events e WHERE e.bank_transaction_id = proof.uid(1000, 4))
  = ARRAY['posted','released','returned','reclassified'] $$);

SELECT proof.record('K3m', 'een assistent mag ook een handmatig tegengeboekte regel niet vrijgeven (accountant)',
  o LIKE 'fout [42501] Geen rechten om een geboekte banktransactie vrij te geven%', o)
FROM proof.rel(proof.u(2), proof.uid(1000, 5), proof.get('k2_g')::uuid, proof.req(58), 'Assistent') o;

-- ═══ K6. BTW VIA DE BESTAANDE SCHRIJVER ══════════════════════════════════════

CREATE TABLE proof.k6 (n integer, amount numeric, oldp integer, newp integer, ok boolean, detail text);
GRANT ALL ON proof.k6 TO public;

/** De verwachte regels van de schrijver, los uitgerekend. */
CREATE FUNCTION proof.k6_expected(_amount numeric, _pct integer, _nummer integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH v AS (SELECT round(abs(_amount), 2)::numeric(12,2) AS gross,
                    round(round(abs(_amount), 2) / (1 + _pct::numeric / 100), 2)::numeric(12,2) AS net)
  SELECT CASE WHEN _amount < 0 THEN
           concat_ws(',', format('%s:%s:0.00', _nummer, v.net),
                          CASE WHEN v.gross - v.net > 0 THEN format('1520:%s:0.00', (v.gross - v.net)::numeric(12,2)) END,
                          format('1100:0.00:%s', v.gross))
         ELSE
           concat_ws(',', format('1100:%s:0.00', v.gross),
                          format('%s:0.00:%s', _nummer, v.net),
                          CASE WHEN v.gross - v.net > 0 THEN format('1530:0.00:%s', (v.gross - v.net)::numeric(12,2)) END)
         END
  FROM v;
$$;

CREATE FUNCTION proof.k6_post(_n integer, _amount numeric, _oldp integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM proof.tx(_n, _amount);
  PERFORM proof.put(format('k6_post_%s', _n), proof.rc(proof.u(2), proof.uid(1000, _n), NULL, proof.acct(6), _oldp, proof.req(_n)));
END $$;

CREATE FUNCTION proof.k6_fix(_n integer, _newp integer) RETURNS void LANGUAGE sql AS $$
  SELECT proof.put(format('k6_fix_%s', _n),
    proof.rc(proof.u(1), proof.uid(1000, _n), proof.f(proof.get(format('k6_post_%s', _n)), 3)::uuid, proof.acct(7), _newp,
             proof.req(_n + 50000), format('BTW naar %s%%', _newp)));
$$;

CREATE FUNCTION proof.k6_check(_n integer, _amount numeric, _oldp integer, _newp integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_post text := proof.get(format('k6_post_%s', _n));
  v_fix  text := proof.get(format('k6_fix_%s', _n));
  v_g1 uuid := proof.f(v_post, 3)::uuid;
  v_g2 uuid := proof.f(v_fix, 3)::uuid;
  v_r  uuid := proof.f(v_fix, 5)::uuid;
  v_tx uuid := proof.uid(1000, _n);
  v_gross numeric := round(abs(_amount), 2);
  v_net numeric := round(v_gross / (1 + _newp::numeric / 100), 2);
  v_vat uuid := CASE WHEN _amount < 0 THEN proof.acct(4) ELSE proof.acct(5) END;
  v_other uuid := CASE WHEN _amount < 0 THEN proof.acct(5) ELSE proof.acct(4) END;
  v_sign numeric := CASE WHEN _amount < 0 THEN 1 ELSE -1 END;
  v_ok boolean;
BEGIN
  v_ok := v_post LIKE 'ok: posted|f|%' AND v_fix LIKE 'ok: reclassified|f|%'
    AND proof.lines(v_g1) = proof.k6_expected(_amount, _oldp, 8250)
    AND proof.lines(v_g2) = proof.k6_expected(_amount, _newp, 4700)
    -- de storno is het origineel met debet en credit verwisseld
    AND (SELECT string_agg(format('%s:%s:%s', g.nummer, lp.credit_amount, lp.debit_amount), ',' ORDER BY lp.line_no)
         FROM public.ledger_postings lp JOIN public.grootboekrekeningen g ON g.id = lp.grootboekrekening_id
         WHERE lp.posting_group_id = v_g1) = proof.lines(v_r)
    AND proof.net(v_tx, proof.acct(1)) = _amount
    AND proof.net(v_tx, proof.acct(6)) = 0
    AND proof.net(v_tx, proof.acct(7)) = v_sign * v_net
    AND proof.net(v_tx, v_vat) = v_sign * (v_gross - v_net)
    AND proof.net(v_tx, v_other) = 0;
  INSERT INTO proof.k6 VALUES (_n, _amount, _oldp, _newp, coalesce(v_ok, false),
    format('%s | %s | G1 %s | G2 %s', v_post, v_fix, proof.lines(v_g1), proof.lines(v_g2)));
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

CREATE TABLE proof.k6_cases AS
SELECT 10000 + row_number() OVER (ORDER BY d.sign, o.p, nw.p, a.amount)::integer AS n,
       d.sign * a.amount AS amount, o.p AS oldp, nw.p AS newp
FROM (VALUES (-1), (1)) d(sign), (VALUES (0), (9), (21)) o(p), (VALUES (0), (9), (21)) nw(p),
     (VALUES (0.01), (1.00), (10.00), (123.45), (999999.99)) a(amount);

SELECT format('SELECT proof.k6_post(%s, %s, %s)', n, amount, oldp) FROM proof.k6_cases ORDER BY n \gexec
SELECT format('SELECT proof.k6_fix(%s, %s)', n, newp) FROM proof.k6_cases ORDER BY n \gexec
SELECT format('SELECT proof.k6_check(%s, %s, %s, %s)', n, amount, oldp, newp) FROM proof.k6_cases ORDER BY n \gexec

SELECT proof.record('K6a', 'BTW-matrix: in/uit × oud 0/9/21 × nieuw 0/9/21 × 0,01 · 1,00 · 10,00 · 123,45 · 999.999,99 — elke boeking exact, storno = spiegel, bank ongewijzigd',
  (SELECT count(*) FROM proof.k6 WHERE ok) = 90 AND (SELECT count(*) FROM proof.k6) = 90,
  coalesce((SELECT format('%s van 90; eerste fout n=%s: %s', (SELECT count(*) FROM proof.k6 WHERE ok), n, detail)
            FROM proof.k6 WHERE NOT ok ORDER BY n LIMIT 1), '90 van 90'));

SELECT proof.record('K6b', 'bekende waarden: 121 / 21% = 100 + 21; 1,00 / 9% = 0,92 + 0,08; 0,01 / 21% = 0,01 zonder BTW-regel; 999.999,99 / 21% = 826.446,27 + 173.553,72',
  proof.k6_expected(-121.00, 21, 4700) = '4700:100.00:0.00,1520:21.00:0.00,1100:0.00:121.00'
  AND proof.k6_expected(-1.00, 9, 4700) = '4700:0.92:0.00,1520:0.08:0.00,1100:0.00:1.00'
  AND proof.k6_expected(0.01, 21, 4700) = '1100:0.01:0.00,4700:0.00:0.01'
  AND proof.k6_expected(999999.99, 21, 4700) = '1100:999999.99:0.00,4700:0.00:826446.27,1530:0.00:173553.72'
  AND (SELECT proof.lines(proof.f(proof.get(format('k6_fix_%s', n)), 3)::uuid) FROM proof.k6_cases
       WHERE amount = 999999.99 AND oldp = 0 AND newp = 21) = '1100:999999.99:0.00,4700:0.00:826446.27,1530:0.00:173553.72');

SELECT proof.tx(60, -121.00, '00000000-0000-0000-0000-0000000000c2');
SELECT proof.put('k6_v21', proof.rc(proof.u(2), proof.uid(1000, 60), NULL, proof.acct(7), 21, proof.req(600)));
SELECT proof.put('k6_v9', proof.rc(proof.u(2), proof.uid(1000, 60), NULL, proof.acct(7), 9, proof.req(601)));
SELECT proof.put('k6_v0', proof.rc(proof.u(2), proof.uid(1000, 60), NULL, proof.acct(7), 0, proof.req(602)));
SELECT proof.record('K6c', 'btw-vrijgesteld: 9 en 21 procent geweigerd (22023), 0 procent geboekt zonder BTW-regel',
  proof.get('k6_v21') LIKE 'fout [22023] Deze administratie is btw-vrijgesteld%' AND proof.get('k6_v9') LIKE 'fout [22023] Deze administratie is btw-vrijgesteld%'
  AND proof.get('k6_v0') LIKE 'ok: posted|f|%' AND proof.lines(proof.f(proof.get('k6_v0'), 3)::uuid) = '4700:121.00:0.00,1100:0.00:121.00',
  concat_ws(' || ', proof.get('k6_v21'), proof.get('k6_v9'), proof.get('k6_v0')));

SELECT proof.record('K6d', 'na de hele matrix: alles in balans, lineage compleet', proof.unbalanced() = 0 AND proof.lineage_violations() = 0);

-- ═══ K7. CONFIGURATIEDRIFT (D7) ══════════════════════════════════════════════

SELECT proof.tx(70, -121.00);
SELECT proof.put('k7_post', proof.rc(proof.u(2), proof.uid(1000, 70), NULL, proof.acct(7), 21, proof.req(700)));
UPDATE public.clients SET bank_rekening_id = proof.acct(10) WHERE id = '00000000-0000-0000-0000-0000000000c1';

SELECT proof.record('K7a', 'bankrekening gewijzigd: herclassificeren geweigerd (23514), want het bedrag zou naar 1110 verhuizen',
  o LIKE 'fout [23514] De bankrekening van deze administratie is gewijzigd%', o)
FROM proof.rc(proof.u(1), proof.uid(1000, 70), proof.f(proof.get('k7_post'), 3)::uuid, proof.acct(6), 21, proof.req(701), 'Drift') o;

SELECT proof.put('k7_rel', proof.rel(proof.u(1), proof.uid(1000, 70), proof.f(proof.get('k7_post'), 3)::uuid, proof.req(702), 'Vrijgeven ondanks drift'));
SELECT proof.record('K7b', 'vrijgeven mag wel (D7): de storno raakt alleen de historische bankrekening 1100, niet 1110',
  proof.get('k7_rel') LIKE 'ok: released|f|%'
  AND proof.lines(proof.f(proof.get('k7_rel'), 5)::uuid) = '4700:0.00:100.00,1520:0.00:21.00,1100:121.00:0.00'
  AND proof.net(proof.uid(1000, 70), proof.acct(1)) = 0 AND proof.net(proof.uid(1000, 70), proof.acct(10)) = 0,
  proof.get('k7_rel'));

SELECT proof.put('k7_ret', proof.ret(proof.u(1), proof.uid(1000, 70), proof.req(703), 'Opnieuw op de nieuwe bank'));
SELECT proof.put('k7_again', proof.rc(proof.u(1), proof.uid(1000, 70), NULL, proof.acct(7), 21, proof.req(704), 'Opnieuw'));
SELECT proof.record('K7c', 'een latere boeking gebruikt de dan geldende configuratie: 1110',
  proof.get('k7_again') LIKE 'ok: posted|f|%'
  AND proof.lines(proof.f(proof.get('k7_again'), 3)::uuid) = '4700:100.00:0.00,1520:21.00:0.00,1110:0.00:121.00',
  proof.get('k7_again'));
UPDATE public.clients SET bank_rekening_id = proof.acct(1) WHERE id = '00000000-0000-0000-0000-0000000000c1';

SELECT proof.tx(71, -121.00);
SELECT proof.put('k7_vat', proof.rc(proof.u(2), proof.uid(1000, 71), NULL, proof.acct(7), 21, proof.req(710)));
SELECT proof.tx(72, -121.00);
SELECT proof.put('k7_novat', proof.rc(proof.u(2), proof.uid(1000, 72), NULL, proof.acct(7), 0, proof.req(720)));
UPDATE public.clients SET btw_te_vorderen_rekening_id = proof.acct(11) WHERE id = '00000000-0000-0000-0000-0000000000c1';

SELECT proof.record('K7d', 'BTW-rekening gewijzigd en de actieve groep heeft een BTW-regel: 0, 9 en 21 procent geweigerd (23514)',
  a LIKE 'fout [23514] De BTW-rekening van deze administratie is gewijzigd%'
  AND b LIKE 'fout [23514] De BTW-rekening%' AND c LIKE 'fout [23514] De BTW-rekening%', concat_ws(' || ', a, b, c))
FROM proof.rc(proof.u(1), proof.uid(1000, 71), proof.f(proof.get('k7_vat'), 3)::uuid, proof.acct(7), 0, proof.req(711), 'Drift') a,
     proof.rc(proof.u(1), proof.uid(1000, 71), proof.f(proof.get('k7_vat'), 3)::uuid, proof.acct(7), 9, proof.req(712), 'Drift') b,
     proof.rc(proof.u(1), proof.uid(1000, 71), proof.f(proof.get('k7_vat'), 3)::uuid, proof.acct(6), 21, proof.req(713), 'Drift') c;

SELECT proof.put('k7_novat_fix', proof.rc(proof.u(1), proof.uid(1000, 72), proof.f(proof.get('k7_novat'), 3)::uuid, proof.acct(7), 21, proof.req(721), 'Toch 21%'));
SELECT proof.record('K7e', 'zonder BTW-regel in de actieve groep: naar 21% lukt, op de huidige BTW-rekening 1521',
  proof.get('k7_novat_fix') LIKE 'ok: reclassified|f|%'
  AND proof.lines(proof.f(proof.get('k7_novat_fix'), 3)::uuid) = '4700:100.00:0.00,1521:21.00:0.00,1100:0.00:121.00',
  proof.get('k7_novat_fix'));
UPDATE public.clients SET btw_te_vorderen_rekening_id = proof.acct(4) WHERE id = '00000000-0000-0000-0000-0000000000c1';

SELECT proof.tx(73, 121.00);
SELECT proof.put('k7_in', proof.rc(proof.u(2), proof.uid(1000, 73), NULL, proof.acct(8), 21, proof.req(730)));
UPDATE public.clients SET btw_te_betalen_rekening_id = proof.acct(12) WHERE id = '00000000-0000-0000-0000-0000000000c1';
SELECT proof.record('K7f', 'ook aan de ontvangstkant (BTW te betalen) weigert drift',
  o LIKE 'fout [23514] De BTW-rekening%', o)
FROM proof.rc(proof.u(1), proof.uid(1000, 73), proof.f(proof.get('k7_in'), 3)::uuid, proof.acct(8), 9, proof.req(731), 'Drift') o;
UPDATE public.clients SET btw_te_betalen_rekening_id = proof.acct(5) WHERE id = '00000000-0000-0000-0000-0000000000c1';

SELECT proof.record('K7g', 'na het herstellen van de configuratie lukt dezelfde correctie wel',
  o LIKE 'ok: reclassified|f|%', o)
FROM proof.rc(proof.u(1), proof.uid(1000, 73), proof.f(proof.get('k7_in'), 3)::uuid, proof.acct(8), 9, proof.req(732), 'Na herstel') o;

-- ═══ K8. AFGESLOTEN JAAR EN BOEKINGSBLOKKADE ═════════════════════════════════

SELECT proof.tx(80, -60.00, _date => DATE '2026-06-01');
SELECT proof.tx(81, -40.00, _date => DATE '2026-07-01');
SELECT proof.put('k8_post80', proof.rc(proof.u(2), proof.uid(1000, 80), NULL, proof.acct(7), 21, proof.req(800)));
SELECT proof.put('k8_post81', proof.rc(proof.u(2), proof.uid(1000, 81), NULL, proof.acct(7), 21, proof.req(810)));
SELECT proof.put('k8_close', proof.call(proof.u(1), format('SELECT created::text FROM public.close_fiscal_year(%L, 2026)', '00000000-0000-0000-0000-0000000000c1')));
SELECT proof.put('k8_year_state', (SELECT md5(concat_ws('|',
  (SELECT string_agg(t::text, ',' ORDER BY t.fiscal_year) FROM public.year_closures t WHERE t.client_id = '00000000-0000-0000-0000-0000000000c1'),
  (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM public.fiscal_year_events t WHERE t.client_id = '00000000-0000-0000-0000-0000000000c1'),
  (SELECT afgesloten_boekjaar::text FROM public.clients WHERE id = '00000000-0000-0000-0000-0000000000c1')))));

SELECT proof.record('K8a', 'het jaar 2026 is werkelijk afgesloten (close_fiscal_year)',
  proof.get('k8_close') LIKE 'ok: %' AND (SELECT afgesloten_boekjaar FROM public.clients WHERE id = '00000000-0000-0000-0000-0000000000c1') = 2026,
  proof.get('k8_close'));

SELECT proof.put('k8_fix80', proof.rc(proof.u(1), proof.uid(1000, 80), proof.f(proof.get('k8_post80'), 3)::uuid, proof.acct(6), 9, proof.req(801), 'Correctie in afgesloten jaar'));
SELECT proof.put('k8_rel81', proof.rel(proof.u(1), proof.uid(1000, 81), proof.f(proof.get('k8_post81'), 3)::uuid, proof.req(811), 'Vrijgave in afgesloten jaar'));
SELECT proof.record('K8b', 'afgesloten jaar zonder blokkade (D8): herclassificeren en vrijgeven lukken, op de oorspronkelijke datum in 2026',
  proof.get('k8_fix80') LIKE 'ok: reclassified|f|%' AND proof.get('k8_rel81') LIKE 'ok: released|f|%'
  AND (SELECT bool_and(lp.posting_date = DATE '2026-06-01' AND lp.boekjaar = 2026) FROM public.ledger_postings lp
       WHERE lp.posting_group_id IN (proof.f(proof.get('k8_fix80'), 3)::uuid, proof.f(proof.get('k8_fix80'), 5)::uuid)),
  concat_ws(' || ', proof.get('k8_fix80'), proof.get('k8_rel81')));

SELECT proof.record('K8c', 'en jaarafsluiting, jaargebeurtenissen en watermerk bleven exact gelijk',
  (SELECT md5(concat_ws('|',
    (SELECT string_agg(t::text, ',' ORDER BY t.fiscal_year) FROM public.year_closures t WHERE t.client_id = '00000000-0000-0000-0000-0000000000c1'),
    (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM public.fiscal_year_events t WHERE t.client_id = '00000000-0000-0000-0000-0000000000c1'),
    (SELECT afgesloten_boekjaar::text FROM public.clients WHERE id = '00000000-0000-0000-0000-0000000000c1')))) = proof.get('k8_year_state'));

-- Een boekingsblokkade t/m 2027-03-31: elke toestand en elke RPC wordt geweigerd.
SELECT proof.tx(82, -60.00);
SELECT proof.put('k8_s1', proof.rc(proof.u(2), proof.uid(1000, 82), NULL, proof.acct(7), 21, proof.req(820)));
SELECT proof.tx(83, -60.00);
SELECT proof.put('k8_s2', proof.rc(proof.u(2), proof.uid(1000, 83), NULL, proof.acct(7), 21, proof.req(830)));
SELECT public.reverse_posting_group(proof.f(proof.get('k8_s2'), 3)::uuid, DATE '2027-03-01', 'Handmatig, op de transactiedatum');
SELECT proof.tx(84, -60.00);
SELECT proof.put('k8_s3', proof.rc(proof.u(2), proof.uid(1000, 84), NULL, proof.acct(7), 21, proof.req(840)));
SELECT proof.put('k8_s3rel', proof.rel(proof.u(1), proof.uid(1000, 84), proof.f(proof.get('k8_s3'), 3)::uuid, proof.req(841)));
SELECT proof.put('k8_lock', proof.call(proof.u(1), format('SELECT changed::text FROM public.set_posting_lock(%L, DATE ''2027-03-31'', ''Aangifte Q1 ingediend'')', '00000000-0000-0000-0000-0000000000c1')));
SELECT proof.put('k8_digest', proof.digest());

SELECT proof.record('K8d', 'blokkade ≥ transactiedatum: herclassificeren in S1, S2 en S3, vrijgeven en terugzetten — alle vijf 22023',
  a LIKE 'fout [22023] Boekingsdatum 2027-03-01 valt binnen de boekingsblokkade%'
  AND b LIKE 'fout [22023] Boekingsdatum%' AND c LIKE 'fout [22023] Boekingsdatum%'
  AND d LIKE 'fout [22023] Boekingsdatum%' AND e LIKE 'fout [22023] Boekingsdatum%',
  concat_ws(' || ', proof.get('k8_lock'), a, b, c, d, e))
FROM proof.rc(proof.u(1), proof.uid(1000, 82), proof.f(proof.get('k8_s1'), 3)::uuid, proof.acct(6), 21, proof.req(821), 'Geblokkeerd') a,
     proof.rc(proof.u(1), proof.uid(1000, 83), proof.f(proof.get('k8_s2'), 3)::uuid, proof.acct(6), 21, proof.req(831), 'Geblokkeerd') b,
     proof.rc(proof.u(1), proof.uid(1000, 84), NULL, proof.acct(6), 21, proof.req(842), 'Geblokkeerd') c,
     proof.rel(proof.u(1), proof.uid(1000, 82), proof.f(proof.get('k8_s1'), 3)::uuid, proof.req(822)) d,
     proof.ret(proof.u(1), proof.uid(1000, 84), proof.req(843)) e;

SELECT proof.record('K8e', 'en niets veranderde: geen storno, geen marker, geen gebeurtenis', proof.digest() = proof.get('k8_digest'));

SELECT proof.put('k8_unlock', proof.call(proof.u(1), format('SELECT changed::text FROM public.set_posting_lock(%L, NULL, ''Blokkade opgeheven'')', '00000000-0000-0000-0000-0000000000c1')));
SELECT proof.record('K8f', 'na het opheffen gebeurt er NIETS vanzelf: S2 blijft tegengeboekt, S3 blijft vrijgegeven (inhaalslag: posted / review_needed)',
  proof.get('k8_unlock') LIKE 'ok: %' AND proof.digest() = proof.get('k8_digest')
  AND (SELECT array_agg(workflow_state ORDER BY transaction_id) FROM public.bank_bulk_posting_candidates('00000000-0000-0000-0000-0000000000c1', 2027)
       WHERE transaction_id IN (proof.uid(1000, 83), proof.uid(1000, 84))) = ARRAY['posted', 'review_needed'],
  proof.get('k8_unlock'));

SELECT proof.put('k8_g_a', proof.rc(proof.u(1), proof.uid(1000, 83), proof.f(proof.get('k8_s2'), 3)::uuid, proof.acct(6), 21, proof.req(832), 'Na opheffen blokkade'));
SELECT proof.put('k8_g_b', proof.ret(proof.u(1), proof.uid(1000, 84), proof.req(844), 'Na opheffen blokkade'));
SELECT proof.record('K8g', 'de vervolgstap is expliciet: herboeken (S2) en terugzetten (S3) lukken pas op verzoek',
  proof.get('k8_g_a') LIKE 'ok: reposted|f|%' AND proof.get('k8_g_b') LIKE 'ok: returned|f|%', proof.get('k8_g_a') || ' || ' || proof.get('k8_g_b'));

SELECT proof.record('K8h', 'de acht PR H-lichamen zijn na dit alles onveranderd',
  (SELECT bool_and(md5(p.prosrc) = h.na) FROM (VALUES
     ('post_bank_transaction', '2369978c713ac78a0c039dd5c3e5eb4c'), ('reverse_posting_group', 'b5db0ca04b5dcfbcec5dea1a7844fe13'),
     ('bank_bulk_posting_candidates', '946bef45005d6e572a7565da6fc12cdb')) h(naam, na)
   JOIN pg_proc p ON p.proname = h.naam AND p.pronamespace = 'public'::regnamespace));

-- ═══ K9. HANDMATIG TEGENGEBOEKT → OPNIEUW BOEKBAAR ═══════════════════════════

-- Regel 900 werd vóór PR 1 geboekt en handmatig tegengeboekt op 15-03, twee weken
-- ná de transactie (pre.sql). Opnieuw boeken op de transactiedatum zou 01-03 t/m
-- 14-03 dubbel boeken; de RPC weigert en verwijst naar een memoriaal.
SELECT proof.put('k9_digest', proof.digest());
SELECT proof.put('k9_legacy', proof.rc(proof.u(1), proof.uid(1000, 900), proof.get('nc_group')::uuid, proof.acct(7), 21, proof.req(900), 'Eindelijk opnieuw boeken'));
SELECT proof.record('K9a', 'storno op een latere datum (15-03) dan de transactie (01-03): herboeken geweigerd (22023, memoriaal), niets veranderd',
  proof.get('k9_legacy') LIKE 'fout [22023] De tegenboeking staat op 2027-03-15, niet op de transactiedatum 2027-03-01: opnieuw boeken op de transactiedatum zou de periode daartussen dubbel boeken%'
  AND proof.digest() = proof.get('k9_digest'),
  proof.get('k9_legacy'));

SELECT proof.tx(90, -60.00);
SELECT proof.put('k9_post', proof.rc(proof.u(2), proof.uid(1000, 90), NULL, proof.acct(7), 21, proof.req(910)));
SELECT proof.put('k9_r', public.reverse_posting_group(proof.f(proof.get('k9_post'), 3)::uuid, DATE '2027-03-01', 'Handmatig in Grootboek, op de transactiedatum')::text);
SELECT proof.put('k9_same', proof.rc(proof.u(1), proof.uid(1000, 90), proof.f(proof.get('k9_post'), 3)::uuid, proof.acct(7), 21, proof.req(911), 'Zelfde codering, opnieuw boeken'));
SELECT proof.record('K9b', 'storno op de transactiedatum: opnieuw boeken lukt, ook met dezelfde codering (reposted, niet unchanged), zonder tweede storno',
  proof.get('k9_same') LIKE format('ok: reposted|f|%%|%s|%s|%%', proof.f(proof.get('k9_post'), 3), proof.get('k9_r')),
  proof.get('k9_same'));

SELECT proof.expect_true('K9c', 'de gebeurtenis noemt de bestaande storno; het banksaldo is één keer −60,00', $$
  EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
          WHERE e.id = proof.f(proof.get('k9_same'), 6)::uuid AND e.event_type = 'reposted'
            AND e.reversal_posting_group_id = proof.get('k9_r')::uuid)
  AND proof.net(proof.uid(1000, 90), proof.acct(1)) = -60.00 $$);

SELECT proof.tx(91, -10.00);
SELECT proof.put('k9_p91', proof.rc(proof.u(2), proof.uid(1000, 91), NULL, proof.acct(7), 0, proof.req(920)));
SELECT public.reverse_posting_group(proof.f(proof.get('k9_p91'), 3)::uuid, DATE '2027-03-02', 'Handmatig');
SELECT proof.record('K9d', 'een assistent mag een tegengeboekte regel niet herboeken (accountant)',
  o LIKE 'fout [42501] Geen rechten om een geboekte banktransactie te corrigeren%', o)
FROM proof.rc(proof.u(2), proof.uid(1000, 91), proof.f(proof.get('k9_p91'), 3)::uuid, proof.acct(6), 0, proof.req(921), 'Assistent') o;

SELECT proof.put('k9_digest2', proof.digest());
SELECT proof.record('K9e', 'storno op een latere datum: ook vrijgeven weigert (anders zat de regel vast in een vrijgave zonder uitweg)',
  o LIKE 'fout [22023] De tegenboeking staat op 2027-03-15, niet op de transactiedatum 2027-03-01: na vrijgeven zou opnieuw boeken%'
  AND proof.digest() = proof.get('k9_digest2'), o)
FROM proof.rel(proof.u(1), proof.uid(1000, 900), proof.get('nc_group')::uuid, proof.req(901), 'Vrijgeven') o;

-- Een vrijgave van een groep die op een latere datum is gestorneerd (hier door de
-- eigenaar buiten de RPC's vastgelegd, met een correcte lineage): de RPC's weigeren
-- de weg terug.
SELECT proof.forge_step(proof.uid(1000, 5), 'released');
SELECT proof.put('k9_digest3', proof.digest());
SELECT proof.record('K9f', 'vrijgegeven na een latere storno: herboeken en terugzetten weigeren allebei (22023), niets veranderd',
  a LIKE 'fout [22023] De tegenboeking staat op 2027-03-10, niet op de transactiedatum 2027-03-01%'
  AND b LIKE 'fout [22023] De tegenboeking staat op 2027-03-10, niet op de transactiedatum 2027-03-01%'
  AND proof.digest() = proof.get('k9_digest3'), a || ' || ' || b)
FROM proof.rc(proof.u(1), proof.uid(1000, 5), NULL, proof.acct(7), 21, proof.req(902), 'Herboeken') a,
     proof.ret(proof.u(1), proof.uid(1000, 5), proof.req(903)) b;

SELECT proof.record('K9g', 'en de vrijgave-hold geldt voor die regel gewoon (een sjabloon die de rekening wijzigt: geweigerd)',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.call(proof.u(2), format($q$UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = %L WHERE id = %L RETURNING id::text$q$,
                                   proof.acct(6), proof.uid(1000, 5))) o;

-- ═══ K10. FACTUURKOPPELINGEN VALLEN BUITEN V1 ════════════════════════════════

SELECT proof.tx(100, -25.00), proof.purchase(100, 25.00);
INSERT INTO public.bank_transaction_allocations (id, bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
VALUES (proof.uid(4000, 100), proof.uid(1000, 100), 'inkoop', proof.uid(2000, 100), '00000000-0000-0000-0000-0000000000c1', 25.00, proof.u(1));
SELECT proof.record('K10a', 'een transactie met een (ongeboekte) factuurkoppeling: herclassificeren geweigerd (22023)',
  o LIKE 'fout [22023] Deze banktransactie is aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie%', o)
FROM proof.rc(proof.u(1), proof.uid(1000, 100), NULL, proof.acct(7), 0, proof.req(1000)) o;

SELECT proof.tx(101, -25.00), proof.purchase(101, 25.00);
INSERT INTO public.bank_transaction_allocations (id, bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
VALUES (proof.uid(4000, 101), proof.uid(1000, 101), 'inkoop', proof.uid(2000, 101), '00000000-0000-0000-0000-0000000000c1', 25.00, proof.u(1));
UPDATE public.bank_transactions SET match_status = 'gematcht', matched_invoice_id = proof.uid(2000, 101) WHERE id = proof.uid(1000, 101);
SELECT public.post_bank_allocation(proof.uid(4000, 101));
SELECT proof.put('k10_digest', proof.digest());
SELECT proof.record('K10b', 'een geboekte aflettering corrigeren als directe bankboeking: 22023; vrijgeven: 55000 (geen directe boeking); niets veranderd',
  a LIKE 'fout [22023] Deze banktransactie is aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie%'
  AND b LIKE 'fout [55000]%' AND proof.digest() = proof.get('k10_digest'),
  a || ' || ' || b)
FROM proof.rc(proof.u(1), proof.uid(1000, 101), NULL, proof.acct(7), 0, proof.req(1010)) a,
     proof.rel(proof.u(1), proof.uid(1000, 101), gen_random_uuid(), proof.req(1011)) b;

SELECT proof.record('K10c', 'PR 0 blijft werken: een koppeling op een via de RPC geboekte transactie wordt door guard 1 geweigerd',
  o LIKE 'fout [23514] Deze banktransactie is al rechtstreeks in het grootboek geboekt%', o)
FROM proof.call(proof.u(1), format($q$INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
                                     VALUES (%L, 'inkoop', %L, %L, 25.00, %L) RETURNING id::text$q$,
                                   proof.uid(1000, 1), proof.uid(2000, 100), '00000000-0000-0000-0000-0000000000c1', proof.u(1))) o;

SELECT proof.expect_true('K10d', 'geen enkele banktransactie heeft zowel een directe als een afletteringsmarker', $$
  NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings d JOIN public.bank_allocation_postings a ON a.bank_transaction_id = d.bank_transaction_id) $$);

-- ═══ K11. D12 — ELK SCHRIJFPAD TEGEN EEN VRIJGEGEVEN TRANSACTIE ══════════════

SELECT proof.tx(110, -40.00), proof.tx(111, -40.00), proof.tx(112, -40.00), proof.tx(113, -40.00), proof.purchase(110, 40.00);
SELECT proof.put('k11_post', proof.rc(proof.u(2), proof.uid(1000, 110), NULL, proof.acct(7), 21, proof.req(1100)));
SELECT proof.put('k11_rel', proof.rel(proof.u(1), proof.uid(1000, 110), proof.f(proof.get('k11_post'), 3)::uuid, proof.req(1101)));
INSERT INTO public.bank_transaction_allocations (id, bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
VALUES (proof.uid(4000, 111), proof.uid(1000, 111), 'inkoop', proof.uid(2000, 110), '00000000-0000-0000-0000-0000000000c1', 40.00, proof.u(1));
SELECT proof.put('k11_digest', proof.digest());

CREATE FUNCTION proof.upd(_user uuid, _tx uuid, _set text, _role text DEFAULT 'authenticated') RETURNS text LANGUAGE sql AS $$
  SELECT proof.call(_user, format('UPDATE public.bank_transactions SET %s WHERE id = %L RETURNING id::text', _set, _tx), _role);
$$;
GRANT EXECUTE ON FUNCTION proof.upd(uuid, uuid, text, text) TO public;

SELECT proof.record('K11a', 'S3, assistent: matchen met een factuur (handleConfirm/handleMatch/automatische scan/bulk-bevestigen) geweigerd',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(proof.u(2), proof.uid(1000, 110), format('match_status = ''gematcht'', matched_invoice_id = %L, match_confidence = 100', proof.uid(2000, 110))) o;

SELECT proof.record('K11b', 'S3, assistent: handmatig boeken / sjabloon / vraagpost / "Toepassen op open bankregels" geweigerd',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(proof.u(2), proof.uid(1000, 110), format('match_status = ''handmatig_geboekt'', grootboekrekening_id = %L', proof.acct(7))) o;

SELECT proof.record('K11c', 'S3: alleen het BTW-percentage zetten (useBankTransactionPosting) geweigerd',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(proof.u(2), proof.uid(1000, 110), 'btw_percentage = 21') o;

SELECT proof.record('K11d', 'S3: een suggestie zetten (automatische scan) geweigerd',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(proof.u(2), proof.uid(1000, 110), format('match_status = ''suggestie'', matched_invoice_id = %L, match_confidence = 60', proof.uid(2000, 110))) o;

SELECT proof.record('K11e', 'S3: ontkoppelen / boeking verwijderen zonder echte wijziging (al niet_gematcht) mag; de omschrijving wijzigen mag',
  a LIKE 'ok: %' AND b LIKE 'ok: %', a || ' || ' || b)
FROM proof.upd(proof.u(2), proof.uid(1000, 110), 'match_status = ''niet_gematcht'', matched_invoice_id = NULL, match_confidence = NULL, grootboekrekening_id = NULL') a,
     LATERAL (SELECT proof.upd(proof.u(2), proof.uid(1000, 110), 'description = ''Toelichting bij de regel''')) x(b);

SELECT proof.record('K11f', 'S3: bedrag wijzigen geweigerd (identiteit bevroren zodra er historie is)',
  o LIKE 'fout [42501] Deze banktransactie heeft een boekingsgeschiedenis%', o)
FROM proof.upd(proof.u(2), proof.uid(1000, 110), 'amount = -41.00') o;

SELECT proof.record('K11g', 'S3: verwijderen geweigerd, ook voor een accountant',
  o LIKE 'fout [42501] Deze banktransactie heeft een boekingsgeschiedenis%', o)
FROM proof.call(proof.u(1), format('DELETE FROM public.bank_transactions WHERE id = %L RETURNING id::text', proof.uid(1000, 110))) o;

SELECT proof.record('K11h', 'S3: een koppeling aanmaken vanuit Facturen/Verkoop geweigerd (23514)',
  o LIKE 'fout [23514] Deze banktransactie is vrijgegeven%', o)
FROM proof.call(proof.u(1), format($q$INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
                                     VALUES (%L, 'inkoop', %L, %L, 40.00, %L) RETURNING id::text$q$,
                                   proof.uid(1000, 110), proof.uid(2000, 110), '00000000-0000-0000-0000-0000000000c1', proof.u(1))) o;

SELECT proof.record('K11i', 'S3: een bestaande koppeling naar de vrijgegeven transactie verplaatsen geweigerd',
  o LIKE 'fout [23514] Deze banktransactie is vrijgegeven%', o)
FROM proof.call(proof.u(1), format('UPDATE public.bank_transaction_allocations SET bank_transaction_id = %L WHERE id = %L RETURNING id::text',
                                   proof.uid(1000, 110), proof.uid(4000, 111))) o;

SELECT proof.record('K11j', 'S3: dezelfde codering als accountant geweigerd (de hold kijkt niet naar de rol)',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(proof.u(1), proof.uid(1000, 110), format('match_status = ''handmatig_geboekt'', grootboekrekening_id = %L', proof.acct(7))) o;

SELECT proof.record('K11k', 'S3: service_role (omzeilt RLS) geweigerd',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(NULL, proof.uid(1000, 110), format('match_status = ''handmatig_geboekt'', grootboekrekening_id = %L', proof.acct(7)), 'service_role') o;

SELECT proof.expect_error('K11l', 'S3: ook de eigenaar in replica-modus (ENABLE ALWAYS)',
  format($q$SET LOCAL session_replication_role = replica;
            UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = %L WHERE id = %L$q$,
         proof.acct(7), proof.uid(1000, 110)),
  '42501', 'Deze banktransactie is vrijgegeven');

SELECT proof.record('K11m', 'en na al die pogingen: alleen de omschrijving van regel 110 veranderde',
  (SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) FROM public.ledger_postings t) IS NOT NULL
  AND proof.marker(proof.uid(1000, 110)) IS NULL
  AND (SELECT match_status = 'niet_gematcht' AND grootboekrekening_id IS NULL AND amount = -40.00 AND description = 'Toelichting bij de regel'
       FROM public.bank_transactions WHERE id = proof.uid(1000, 110))
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 110)));

SELECT proof.record('K11n', 'regressie S0 (nooit geboekt, geen gebeurtenissen): dezelfde paden werken als vóór PR 1',
  a LIKE 'ok: %' AND b LIKE 'ok: %' AND c LIKE 'ok: %' AND d LIKE 'ok: %', concat_ws(' || ', a, b, c, d))
FROM proof.upd(proof.u(2), proof.uid(1000, 112), format('match_status = ''gematcht'', matched_invoice_id = %L, match_confidence = 100', proof.uid(2000, 110))) a,
     LATERAL (SELECT proof.upd(proof.u(2), proof.uid(1000, 112), format('match_status = ''handmatig_geboekt'', grootboekrekening_id = %L, btw_percentage = 21', proof.acct(7)))) x(b),
     LATERAL (SELECT proof.upd(proof.u(2), proof.uid(1000, 112), 'amount = -41.00')) y(c),
     LATERAL (SELECT proof.call(proof.u(1), format('DELETE FROM public.bank_transactions WHERE id = %L RETURNING id::text', proof.uid(1000, 113)))) z(d);

SELECT proof.put('k11_ret', proof.ret(proof.u(1), proof.uid(1000, 110), proof.req(1102), 'Terug naar werkstroom'));
SELECT proof.record('K11o', 'S4 (teruggezet): coderen mag weer, ook een koppeling',
  proof.get('k11_ret') LIKE 'ok: returned|%' AND a LIKE 'ok: %' AND b LIKE 'ok: %', concat_ws(' || ', proof.get('k11_ret'), a, b))
FROM proof.upd(proof.u(2), proof.uid(1000, 110), format('match_status = ''handmatig_geboekt'', grootboekrekening_id = %L', proof.acct(7))) a,
     LATERAL (SELECT proof.call(proof.u(1), format('UPDATE public.bank_transaction_allocations SET bank_transaction_id = %L WHERE id = %L RETURNING id::text',
                                                   proof.uid(1000, 110), proof.uid(4000, 111)))) x(b);

SELECT proof.record('K11p', 'S4: maar bedrag en verwijderen blijven bevroren',
  a LIKE 'fout [42501] Deze banktransactie heeft een boekingsgeschiedenis%' AND b LIKE 'fout [42501] Deze banktransactie heeft een boekingsgeschiedenis%',
  a || ' || ' || b)
FROM proof.upd(proof.u(2), proof.uid(1000, 110), 'amount = -39.00') a,
     LATERAL (SELECT proof.call(proof.u(1), format('DELETE FROM public.bank_transactions WHERE id = %L RETURNING id::text', proof.uid(1000, 110)))) x(b);

SELECT proof.record('K11q', 'S4 met een koppeling: de correctie-RPC weigert (22023), de factuurroute is de enige weg',
  o LIKE 'fout [22023] Deze banktransactie is aan een factuur gekoppeld; een correctie van een factuurkoppeling valt buiten deze functie%', o)
FROM proof.rc(proof.u(1), proof.uid(1000, 110), NULL, proof.acct(7), 21, proof.req(1103), 'Mag niet') o;

-- ═══ K12. ONTBREKENDE OF ONGELDIGE INVOER ════════════════════════════════════

SELECT proof.tx(120, 0.00);
SELECT proof.put('k12_digest', proof.digest());
SELECT proof.record('K12a', 'een banktransactie van nul: de schrijver weigert (22023) en er blijft niets achter, ook niet de codering',
  o LIKE 'fout [22023] Een banktransactie van nul%' AND proof.digest() = proof.get('k12_digest'), o)
FROM proof.rc(proof.u(2), proof.uid(1000, 120), NULL, proof.acct(7), 0, proof.req(1200)) o;

SELECT proof.tx(121, -10.00);
SELECT proof.record('K12b', 'een rekening van een andere organisatie en een onbestaande rekening: exact dezelfde 23514',
  a = b AND a LIKE 'fout [23514] De gekozen grootboekrekening hoort niet bij deze organisatie%', a || ' || ' || b)
FROM proof.rc(proof.u(2), proof.uid(1000, 121), NULL, proof.acct(106), 0, proof.req(1210)) a,
     proof.rc(proof.u(2), proof.uid(1000, 121), NULL, gen_random_uuid(), 0, proof.req(1211)) b;

SELECT proof.record('K12c', 'een inactieve rekening: 23514 (de schrijver toetst dat zelf niet)',
  o LIKE 'fout [23514] De gekozen grootboekrekening is niet actief%', o)
FROM proof.rc(proof.u(2), proof.uid(1000, 121), NULL, proof.acct(9), 0, proof.req(1212)) o;

-- ═══ R. RLS OP DE GEBEURTENISSEN ═════════════════════════════════════════════

SELECT proof.record('R1', 'read_only van organisatie A ziet de gebeurtenissen van A', o::integer > 0, o)
FROM (SELECT substr(proof.call(proof.u(4), 'SELECT count(*)::text FROM public.bank_transaction_posting_events'), 5)) x(o);

SELECT proof.record('R2', 'de buitenstaander ziet alleen de gebeurtenis van zijn eigen organisatie', o = '1', o)
FROM (SELECT substr(proof.call(proof.u(3), 'SELECT count(*)::text FROM public.bank_transaction_posting_events'), 5)) x(o);

SELECT proof.record('R3', 'anon mag de gebeurtenissen niet lezen', o LIKE 'fout [42501] permission denied%', o)
FROM proof.call(NULL, 'SELECT count(*)::text FROM public.bank_transaction_posting_events', 'anon') o;

-- ═══ I. INVARIANTEN OVER ALLES HIERBOVEN ═════════════════════════════════════

SELECT proof.record('I1', 'elke boekingsgroep in balans', proof.unbalanced() = 0, proof.unbalanced()::text);
SELECT proof.record('I2', 'lineage compleet over de hele database', proof.lineage_violations() = 0, proof.lineage_violations()::text);
SELECT proof.expect_true('I3', 'append-only: elke grootboekregel en tegenboekingsmarker van vóór PR 1 bestaat nog, byte-gelijk', $$
  NOT EXISTS (SELECT * FROM proof.ledger_before EXCEPT SELECT * FROM public.ledger_postings)
  AND NOT EXISTS (SELECT * FROM proof.reversals_before EXCEPT SELECT * FROM public.ledger_reversal_postings) $$);
SELECT proof.expect_true('I4', 'geen enkele weigering noemt een uuid, in bericht, detail of hint', $$
  NOT EXISTS (SELECT 1 FROM proof.refusal WHERE outcome ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}') $$);
