-- P5a — de bewijzen tegen de echte keten, ná P5a (twee keer toegepast).
-- Throwaway database only. Elke RPC-aanroep loopt als de echte rol
-- `authenticated` met auth.uid() = de genoemde gebruiker:
--   e1 accountant, e2 assistent, e3 buitenstaander (organisatie B), e4 lezer,
--   e5 tweede accountant, e6 eigenaar.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY[
  'A1','A2','A3','A4','A5','A6','A7','A8','A9',
  'B1','B2','B3','B4','B5','B6','B7','B8',
  'C1','C2','C3','C4','C5','C6','C7','C8','C9','C10','C11','C12','C13','C14','C15',
  'D1',
  'E1','E2','E3','E4','E5','E6',
  'F1','F2','F3',
  'G1','G2','G3','G4','G5','G6','G7','G8',
  'H1','H2','H3','H4','H5','H6','H7','H8','H9','H10',
  'I1','I2','I3','I4','I5','I6','I7','I8','I9','I10','I11','I12',
  'J1','J2','J3',
  'Z1']);

-- ═══ A. Catalogus, rechten, geen datawijziging ══════════════════════════════

SELECT proof.expect_true('A1', 'link/unlink: plpgsql, VOLATILE, SECURITY DEFINER, search_path=public',
  $$(SELECT bool_and(p.prosecdef AND p.provolatile = 'v' AND l.lanname = 'plpgsql'
                     AND p.proconfig = ARRAY['search_path=public'])
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid IN ('public.link_bank_payment(uuid,text,uuid,numeric,uuid)'::regprocedure,
                     'public.unlink_bank_payment(uuid,uuid,uuid)'::regprocedure))$$);

SELECT proof.expect_true('A2', 'EXECUTE op de RPC''s alleen voor authenticated (niet anon, service_role of PUBLIC)',
  $$has_function_privilege('authenticated', 'public.link_bank_payment(uuid,text,uuid,numeric,uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.unlink_bank_payment(uuid,uuid,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.link_bank_payment(uuid,text,uuid,numeric,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.unlink_bank_payment(uuid,uuid,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.link_bank_payment(uuid,text,uuid,numeric,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.unlink_bank_payment(uuid,uuid,uuid)', 'EXECUTE')
    AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                    WHERE p.proname IN ('link_bank_payment', 'unlink_bank_payment') AND a.grantee = 0)$$);

SELECT proof.expect_true('A3', 'interne hulp- en triggerfuncties: geen EXECUTE voor anon, authenticated of service_role',
  $$NOT EXISTS (
      SELECT 1 FROM pg_proc p
      CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) r(role)
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('bank_payment_min_role', 'bank_payment_writer_active', 'bank_payment_allocation_writer_active',
                          'bank_payment_tx_released', 'bank_payment_assert_consistent', 'stamp_bank_payment_record',
                          'prevent_bank_payment_record_mutation', 'guard_bank_allocation_write',
                          'enforce_bank_allocation_integrity', 'enforce_bank_match_rejection_not_linked',
                          'verify_bank_payment_event')
        AND has_function_privilege(r.role, p.oid, 'EXECUTE'))
    AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('bank_payment_min_role', 'bank_payment_writer_active', 'bank_payment_allocation_writer_active',
                           'bank_payment_tx_released', 'bank_payment_assert_consistent', 'stamp_bank_payment_record',
                           'prevent_bank_payment_record_mutation', 'guard_bank_allocation_write',
                           'enforce_bank_allocation_integrity', 'enforce_bank_match_rejection_not_linked',
                           'verify_bank_payment_event')) = 11$$);

SELECT proof.expect_true('A4', 'claims en gebeurtenissen: RLS aan, alleen SELECT voor authenticated/service_role, niets voor anon',
  $$(SELECT bool_and(c.relrowsecurity) FROM pg_class c
     WHERE c.oid IN ('public.bank_payment_requests'::regclass, 'public.bank_payment_events'::regclass))
    AND has_table_privilege('authenticated', 'public.bank_payment_events', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.bank_payment_events', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('authenticated', 'public.bank_payment_requests', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('service_role', 'public.bank_payment_requests', 'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT has_table_privilege('anon', 'public.bank_payment_requests', 'SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('anon', 'public.bank_payment_events', 'SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_sequence_privilege('authenticated', 'public.bank_payment_events_seq_seq', 'USAGE')
    AND (SELECT count(*) FROM pg_policies WHERE tablename IN ('bank_payment_requests', 'bank_payment_events')) = 2$$);

SELECT proof.expect_true('A5', 'created_by: nullable, standaard auth.uid(), en GEEN waarde voor de koppelingen van vóór P5a',
  $$(SELECT is_nullable = 'YES' AND column_default = 'auth.uid()' FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'bank_transaction_allocations' AND column_name = 'created_by')
    AND (SELECT count(*) FROM public.bank_transaction_allocations WHERE created_by IS NOT NULL) = 0
    AND (SELECT count(*)::text FROM public.bank_transaction_allocations) = proof.get('snap_alloc_count')$$);

SELECT proof.expect_true('A6', 'triggers: guard (BEFORE I/U/D), integriteit en postconditie uitgesteld, afwijzingsguard, append-only ALTIJD',
  $$(SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.bank_transaction_allocations'::regclass
       AND t.tgname = 'guard_bank_allocation_write_trigger' AND t.tgenabled = 'O') = 1
    AND (SELECT count(*) FROM pg_trigger t JOIN pg_constraint c ON c.oid = t.tgconstraint
         WHERE t.tgname IN ('validate_bank_allocation_integrity_trigger', 'verify_bank_payment_event_trigger')
           AND c.condeferrable AND c.condeferred) = 2
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.bank_match_rejections'::regclass
                AND tgname = 'validate_bank_match_rejection_not_linked_trigger')
    AND (SELECT count(*) FROM pg_trigger WHERE tgname IN (
           'prevent_bank_payment_request_mutation_trigger', 'prevent_bank_payment_request_truncate_trigger',
           'prevent_bank_payment_event_mutation_trigger', 'prevent_bank_payment_event_truncate_trigger')
         AND tgenabled = 'A') = 4$$);

SELECT proof.expect_true('A7', 'catalogus die P5a niet mag raken is gelijk: triggers op bank_transactions, policies en rechten van de brontabellen, schrijvers en guards',
  $$proof.p5catalog() = proof.get('snap_catalog')$$);

SELECT proof.expect_true('A8', 'prevent_posted_sales_invoice_mutation: de P5a-versie, trigger nog actief',
  $$(SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.prevent_posted_sales_invoice_mutation()'::regprocedure)
      = 'd7fa08d5356e5f0152928aa7f03438ad'
    AND proof.get('snap_sales_md5') = 'aad983904aba6df9519d332389427b4e'
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'prevent_posted_sales_invoice_mutation_trigger' AND tgenabled = 'O')$$);

SELECT proof.expect_true('A9', 'P5a (twee keer toegepast) wijzigt geen enkele bestaande rij; claims en gebeurtenissen leeg',
  $$proof.p5data() = proof.get('snap_data')
    AND (SELECT count(*) FROM public.bank_payment_requests) = 0
    AND (SELECT count(*) FROM public.bank_payment_events) = 0$$);

-- ═══ B. Koppelen ═══════════════════════════════════════════════════════════

-- B1: deelbetaling 30 op 100 → restant 70, geen betaald.
SELECT proof.tx(100, 30.00), proof.sinv(100, 100.00);
SELECT proof.put('b1', proof.link(proof.u(6), proof.uid(1000, 100), 'verkoop', proof.uid(3000, 100), 30, proof.req(100)));
SELECT proof.record('B1', 'deelbetaling 30 op 100: restant 70, status blijft gecontroleerd, T gematcht; user_id = eigenaar van T, created_by = actor',
  proof.f(proof.get('b1'), 2) = 'created' AND proof.f(proof.get('b1'), 3) = '70.00' AND proof.f(proof.get('b1'), 4) = 'gecontroleerd'
  AND proof.inv('verkoop', proof.uid(3000, 100)) = '70.00|gecontroleerd'
  AND proof.txs(proof.uid(1000, 100)) = format('gematcht|%s|30.00|1', proof.uid(3000, 100))
  AND (SELECT a.user_id = proof.u(1) AND a.created_by = proof.u(6) AND a.client_id = '00000000-0000-0000-0000-0000000000c1'
              AND a.organization_id = '00000000-0000-0000-0000-00000000a001'
       FROM public.bank_transaction_allocations a WHERE a.id = proof.f(proof.get('b1'), 1)::uuid),
  proof.get('b1'));

-- B2: volledige betaling van een goedgekeurde verkoopfactuur → betaald.
SELECT proof.tx(101, 70.00);
SELECT proof.put('b2', proof.link(proof.u(6), proof.uid(1000, 101), 'verkoop', proof.uid(3000, 100), 70, proof.req(101)));
SELECT proof.record('B2', 'volledige betaling (30 + 70) van een gecontroleerde verkoopfactuur: restant 0 en betaald',
  proof.f(proof.get('b2'), 3) = '0.00' AND proof.f(proof.get('b2'), 4) = 'betaald'
  AND proof.inv('verkoop', proof.uid(3000, 100)) = '0.00|betaald', proof.get('b2'));

-- B3: een betaling keurt nooit goed: concept en verzonden blijven staan.
SELECT proof.tx(102, 50.00), proof.sinv(102, 50.00, 'concept'), proof.tx(103, 50.00), proof.sinv(103, 50.00, 'verzonden');
SELECT proof.put('b3a', proof.link(proof.u(6), proof.uid(1000, 102), 'verkoop', proof.uid(3000, 102), 50, proof.req(102)));
SELECT proof.put('b3b', proof.link(proof.u(6), proof.uid(1000, 103), 'verkoop', proof.uid(3000, 103), 50, proof.req(103)));
SELECT proof.record('B3', 'volledige betaling van concept/verzonden: restant 0, status ongewijzigd (een betaling keurt nooit goed)',
  proof.inv('verkoop', proof.uid(3000, 102)) = '0.00|concept' AND proof.inv('verkoop', proof.uid(3000, 103)) = '0.00|verzonden',
  proof.get('b3a') || ' / ' || proof.get('b3b'));

-- B4: inkoop: status verandert nooit; geexporteerd blijft exportstatus.
SELECT proof.tx(104, -80.00), proof.pinv(104, 80.00), proof.tx(105, -80.00), proof.pinv(105, 80.00, 'geexporteerd');
SELECT proof.put('b4a', proof.link(proof.u(2), proof.uid(1000, 104), 'inkoop', proof.uid(2000, 104), 80, proof.req(104)));
SELECT proof.put('b4b', proof.link(proof.u(2), proof.uid(1000, 105), 'inkoop', proof.uid(2000, 105), 80, proof.req(105)));
SELECT proof.record('B4', 'inkoop volledig betaald door een assistent: restant 0, status gecontroleerd resp. geexporteerd ongewijzigd',
  proof.inv('inkoop', proof.uid(2000, 104)) = '0.00|gecontroleerd' AND proof.inv('inkoop', proof.uid(2000, 105)) = '0.00|geexporteerd',
  proof.get('b4a') || ' / ' || proof.get('b4b'));

-- B5: twee deelbetalingen uit twee transacties op één factuur.
SELECT proof.tx(106, 60.00), proof.tx(107, 40.00), proof.sinv(106, 100.00);
SELECT proof.put('b5a', proof.link(proof.u(6), proof.uid(1000, 106), 'verkoop', proof.uid(3000, 106), 60, proof.req(106)));
SELECT proof.put('b5m', proof.inv('verkoop', proof.uid(3000, 106)));
SELECT proof.put('b5b', proof.link(proof.u(6), proof.uid(1000, 107), 'verkoop', proof.uid(3000, 106), 40, proof.req(107)));
SELECT proof.record('B5', 'twee deelbetalingen (60, dan 40): eerst 40 open en gecontroleerd, daarna 0 en betaald',
  proof.get('b5m') = '40.00|gecontroleerd' AND proof.inv('verkoop', proof.uid(3000, 106)) = '0.00|betaald',
  proof.get('b5b'));

-- B6: één transactie verdeeld over twee facturen; de eerste blijft primair.
SELECT proof.tx(108, 100.00), proof.sinv(108, 60.00), proof.sinv(109, 40.00);
SELECT proof.put('b6a', proof.link(proof.u(6), proof.uid(1000, 108), 'verkoop', proof.uid(3000, 108), 60, proof.req(108)));
SELECT proof.put('b6b', proof.link(proof.u(6), proof.uid(1000, 108), 'verkoop', proof.uid(3000, 109), 40, proof.req(109)));
SELECT proof.record('B6', 'één transactie over twee facturen: Σ = |T|, primaire factuur blijft de eerste, beide betaald',
  proof.txs(proof.uid(1000, 108)) = format('gematcht|%s|100.00|2', proof.uid(3000, 108))
  AND proof.inv('verkoop', proof.uid(3000, 108)) = '0.00|betaald' AND proof.inv('verkoop', proof.uid(3000, 109)) = '0.00|betaald',
  proof.get('b6b'));

-- B7: claim en gebeurtenis in dezelfde transactie, met de afgeleide waarden.
SELECT proof.record('B7', 'claim (link, created, hash, antwoord) en gebeurtenis (linked, vóór/na) uit dezelfde transactie',
  (SELECT r.request_kind = 'link' AND r.outcome = 'created' AND r.args_hash ~ '^[0-9a-f]{32}$'
          AND r.result->>'invoice_remaining' = '70.00' AND r.bank_transaction_id = proof.uid(1000, 100)
          AND e.event_type = 'linked' AND e.remaining_before = 100 AND e.remaining_after = 70
          AND e.status_before = 'gecontroleerd' AND e.status_after = 'gecontroleerd'
          AND e.tx_status_before = 'niet_gematcht' AND e.tx_status_after = 'gematcht' AND NOT e.formalized
          AND e.created_xact_id = r.created_xact_id AND e.allocation_id = proof.f(proof.get('b1'), 1)::uuid
   FROM public.bank_payment_requests r JOIN public.bank_payment_events e
     ON e.actor_id = r.actor_id AND e.request_id = r.request_id
   WHERE r.actor_id = proof.u(6) AND r.request_id = proof.req(100)));

-- B8: wie de uitgestelde controles naar voren haalt, krijgt toch de eindtoestand getoetst.
SELECT proof.tx(110, 20.00), proof.sinv(110, 20.00);
SELECT proof.put('b8', proof.calli(proof.u(6), format(
  'SELECT format(''%%s|%%s'', outcome, invoice_status) FROM public.link_bank_payment(%L, ''verkoop'', %L, 20, %L)',
  proof.uid(1000, 110), proof.uid(3000, 110), proof.req(110))));
SELECT proof.record('B8', 'met SET CONSTRAINTS ALL IMMEDIATE werkt de RPC gewoon en sluit de toestand aan',
  proof.get('b8') = 'ok: created|betaald' AND proof.writer_violations() = 0, proof.get('b8'));

-- ═══ C. Weigeringen — niets verandert ══════════════════════════════════════

SELECT proof.tx(200, 100.00), proof.tx(201, -100.00), proof.sinv(200, 100.00), proof.pinv(200, 100.00),
       proof.sinv(201, 100.00, 'gecontroleerd', false, '00000000-0000-0000-0000-0000000000c2'),
       proof.tx(202, 100.00, '00000000-0000-0000-0000-0000000000c3'),
       proof.sinv(203, 100.00), proof.tx(203, 100.00), proof.tx(204, 100.00);
-- 203: een afgewezen paar; 204 al 90 gekoppeld aan 200.
SELECT proof.call(proof.u(1), format(
  'INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id) VALUES (%L, ''verkoop'', %L) RETURNING id::text',
  proof.uid(1000, 203), proof.uid(3000, 203)));
SELECT proof.link(proof.u(6), proof.uid(1000, 204), 'verkoop', proof.uid(3000, 200), 90, proof.req(204));
SELECT proof.sinv(205, 100.00);
UPDATE public.sales_invoices SET amount_incl = NULL, remaining_amount = NULL WHERE id = proof.uid(3000, 205);
SELECT proof.sinv(206, 0.00);
SELECT proof.put('c_before', proof.p5digest());

SELECT proof.put('c1',  proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 200), 20, proof.req(2001)));
SELECT proof.put('c2',  proof.link(proof.u(6), proof.uid(1000, 204), 'verkoop', proof.uid(3000, 203), 20, proof.req(2002)));
SELECT proof.put('c3a', proof.link(proof.u(6), proof.uid(1000, 201), 'verkoop', proof.uid(3000, 200), 10, proof.req(2003)));
SELECT proof.put('c3b', proof.link(proof.u(6), proof.uid(1000, 200), 'inkoop', proof.uid(2000, 200), 10, proof.req(2004)));
SELECT proof.put('c4',  proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 201), 10, proof.req(2005)));
SELECT proof.put('c5a', proof.link(proof.u(6), proof.uid(1000, 202), 'verkoop', proof.uid(3000, 200), 10, proof.req(2006)));
SELECT proof.put('c5b', proof.link(proof.u(3), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 200), 10, proof.req(2007)));
SELECT proof.put('c5c', proof.link(proof.u(3), proof.uid(1000, 999999), 'verkoop', proof.uid(3000, 200), 10, proof.req(2008)));
SELECT proof.put('c6',  proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(2000, 200), 10, proof.req(2009)));
SELECT proof.put('c7',  proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 999999), 10, proof.req(2010)));
SELECT proof.put('c8',  proof.link(proof.u(6), proof.uid(1000, 203), 'verkoop', proof.uid(3000, 203), 10, proof.req(2011)));
SELECT proof.put('c9a', proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 200), 0, proof.req(2012)));
SELECT proof.put('c9b', proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 200), -5, proof.req(2013)));
SELECT proof.put('c9c', proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 200), 1.005, proof.req(2014)));
SELECT proof.put('c9d', proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 200), 'NaN', proof.req(2015)));
SELECT proof.put('c9e', proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 200), 'Infinity', proof.req(2016)));
SELECT proof.put('c9f', proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 200), NULL, proof.req(2017)));
SELECT proof.put('c9g', proof.link(proof.u(6), proof.uid(1000, 200), 'debiteur', proof.uid(3000, 200), 10, proof.req(2018)));
SELECT proof.put('c10a', proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 205), 10, proof.req(2019)));
SELECT proof.put('c10b', proof.link(proof.u(6), proof.uid(1000, 200), 'verkoop', proof.uid(3000, 206), 10, proof.req(2020)));
SELECT proof.put('c13', proof.link(NULL, proof.uid(1000, 200), 'verkoop', proof.uid(3000, 200), 10, proof.req(2021)));

SELECT proof.record('C1', 'over-allocatie op de factuur (90 + 20 > 100): 23514', proof.refused(proof.get('c1'), '23514', 'factuurbedrag'), proof.get('c1'));
SELECT proof.record('C2', 'over-allocatie op de transactie (90 + 20 > 100): 23514', proof.refused(proof.get('c2'), '23514', 'transactiebedrag'), proof.get('c2'));
SELECT proof.record('C3', 'verkeerde richting (verkoop op uitgaand, inkoop op inkomend): 22023',
  proof.refused(proof.get('c3a'), '22023', 'inkomende') AND proof.refused(proof.get('c3b'), '22023', 'uitgaande'),
  proof.get('c3a') || ' / ' || proof.get('c3b'));
SELECT proof.record('C4', 'factuur van een andere administratie (zelfde organisatie): neutrale 42501',
  proof.refused(proof.get('c4'), '42501', 'Factuur niet beschikbaar'), proof.get('c4'));
SELECT proof.record('C5', 'andere organisatie: transactie van B voor A, buitenstaander op A, onbestaande transactie: dezelfde neutrale 42501',
  proof.refused(proof.get('c5a'), '42501', 'Banktransactie niet beschikbaar')
  AND proof.refused(proof.get('c5b'), '42501', 'Banktransactie niet beschikbaar')
  AND proof.refused(proof.get('c5c'), '42501', 'Banktransactie niet beschikbaar')
  AND split_part(proof.get('c5b'), '|', 1) = split_part(proof.get('c5c'), '|', 1),
  proof.get('c5b'));
SELECT proof.record('C6', 'een inkoopfactuur-id als verkoop aangeboden: neutrale 42501', proof.refused(proof.get('c6'), '42501', 'Factuur niet beschikbaar'), proof.get('c6'));
SELECT proof.record('C7', 'onbestaande factuur: neutrale 42501', proof.refused(proof.get('c7'), '42501', 'Factuur niet beschikbaar'), proof.get('c7'));
SELECT proof.record('C8', 'afgewezen paar: 23514', proof.refused(proof.get('c8'), '23514', 'afgewezen'), proof.get('c8'));
SELECT proof.record('C9', 'bedrag 0, negatief, 3 decimalen, NaN, oneindig: 22023; NULL: 22004; onbekende soort: 22023',
  proof.refused(proof.get('c9a'), '22023', 'groter dan nul') AND proof.refused(proof.get('c9b'), '22023', 'groter dan nul')
  AND proof.refused(proof.get('c9c'), '22023', 'twee decimalen') AND proof.refused(proof.get('c9d'), '22023', 'groter dan nul')
  AND proof.refused(proof.get('c9e'), '22023', 'groter dan nul') AND proof.refused(proof.get('c9f'), '22004', 'verplicht')
  AND proof.refused(proof.get('c9g'), '22023', 'factuursoort'),
  proof.get('c9c'));
SELECT proof.record('C10', 'factuurbedrag onbekend: 22004; factuurbedrag 0: 22023',
  proof.refused(proof.get('c10a'), '22004', 'inclusief btw') AND proof.refused(proof.get('c10b'), '22023', 'positief bedrag'),
  proof.get('c10a') || ' / ' || proof.get('c10b'));
SELECT proof.record('C13', 'niet ingelogd: 28000', proof.refused(proof.get('c13'), '28000', 'Niet ingelogd'), proof.get('c13'));

-- C11: een rechtstreeks geboekte transactie (correctie-RPC boekt haar) kan niet meer worden gekoppeld.
SELECT proof.tx(207, 121.00);
SELECT proof.put('c11p', proof.rc(proof.u(2), proof.uid(1000, 207), NULL, proof.acct(8), 21, proof.req(2022)));
SELECT proof.put('c_before', proof.p5digest());
SELECT proof.put('c11', proof.link(proof.u(6), proof.uid(1000, 207), 'verkoop', proof.uid(3000, 200), 5, proof.req(2023)));
SELECT proof.record('C11', 'rechtstreeks geboekte transactie: 23514',
  proof.get('c11p') LIKE 'ok:%' AND proof.refused(proof.get('c11'), '23514', 'rechtstreeks'), proof.get('c11'));

-- C12: vrijgegeven na een geboekte correctie (PR 1, D12): 23514.
SELECT proof.put('c12r', proof.rel(proof.u(1), proof.uid(1000, 207), proof.f(proof.get('c11p'), 3)::uuid, proof.req(2024)));
SELECT proof.put('c_before', proof.p5digest());
SELECT proof.put('c12', proof.link(proof.u(6), proof.uid(1000, 207), 'verkoop', proof.uid(3000, 200), 5, proof.req(2025)));
SELECT proof.record('C12', 'vrijgegeven transactie: 23514 met de vrijgavemelding',
  proof.get('c12r') LIKE 'ok:%' AND proof.refused(proof.get('c12'), '23514', 'vrijgegeven'), proof.get('c12'));

-- C14: alleen READ COMMITTED.
SELECT proof.put('c14', proof.call(proof.u(6), format(
  'SELECT outcome FROM public.link_bank_payment(%L, ''verkoop'', %L, 5, %L)', proof.uid(1000, 200), proof.uid(3000, 200), proof.req(2026))));
-- (dezelfde aanroep onder REPEATABLE READ in een eigen transactie)
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT proof.put('c14rr', proof.call(proof.u(6), format(
  'SELECT outcome FROM public.unlink_bank_payment(%L, %L)', proof.uid(1000, 200), proof.req(2027))));
COMMIT;
SELECT proof.record('C14', 'REPEATABLE READ: 25000 (READ COMMITTED wel toegestaan)',
  proof.get('c14') = 'ok: created' AND proof.refused(proof.get('c14rr'), '25000', 'READ COMMITTED'), proof.get('c14rr'));

SELECT proof.expect_true('C15', 'alle weigeringen in C lieten de data ongemoeid (alleen C14 schreef, bewust)',
  $$(SELECT count(*) FROM public.bank_payment_requests WHERE request_id IN (
       proof.req(2001), proof.req(2002), proof.req(2003), proof.req(2004), proof.req(2005), proof.req(2006), proof.req(2007),
       proof.req(2008), proof.req(2009), proof.req(2010), proof.req(2011), proof.req(2012), proof.req(2013), proof.req(2014),
       proof.req(2015), proof.req(2016), proof.req(2017), proof.req(2018), proof.req(2019), proof.req(2020), proof.req(2021),
       proof.req(2023), proof.req(2025), proof.req(2027))) = 0
    AND (SELECT count(*) FROM public.bank_transaction_allocations WHERE bank_transaction_id IN (
       proof.uid(1000, 201), proof.uid(1000, 202), proof.uid(1000, 203), proof.uid(1000, 207))) = 0
    AND proof.inv('verkoop', proof.uid(3000, 203)) = '100.00|gecontroleerd'
    AND proof.inv('verkoop', proof.uid(3000, 201)) = '100.00|gecontroleerd'
    AND proof.inv('verkoop', proof.uid(3000, 200)) = '5.00|gecontroleerd'$$);

-- ═══ D. Rolmatrix: lezer/assistent/accountant/eigenaar × inkoop/verkoop × koppelen/ontkoppelen ═══

DO $d$
DECLARE
  v_users uuid[] := ARRAY[proof.u(4), proof.u(2), proof.u(1), proof.u(6)];
  v_names text[] := ARRAY['lezer', 'assistent', 'accountant', 'eigenaar'];
  v_rank  int[]  := ARRAY[1, 2, 3, 4];
  v_type  text;
  i int; n int := 300; v_ok boolean; v_out text; v_bad text := '';
  v_tx uuid; v_inv uuid; v_expect boolean; v_floor int;
BEGIN
  FOREACH v_type IN ARRAY ARRAY['inkoop', 'verkoop'] LOOP
    FOR i IN 1..4 LOOP
      -- koppelen
      n := n + 1;
      v_tx := proof.tx(n, CASE v_type WHEN 'inkoop' THEN -10.00 ELSE 10.00 END);
      v_inv := CASE v_type WHEN 'inkoop' THEN proof.pinv(n, 10.00) ELSE proof.sinv(n, 10.00) END;
      v_out := proof.link(v_users[i], v_tx, v_type, v_inv, 10, proof.req(n));
      v_floor := CASE v_type WHEN 'inkoop' THEN 2 ELSE 4 END;
      v_expect := v_rank[i] >= v_floor;
      v_ok := CASE WHEN v_expect THEN v_out LIKE 'ok: %|created|%'
                   ELSE proof.refused(v_out, '42501', 'Onvoldoende rechten') END;
      IF NOT v_ok THEN v_bad := v_bad || format(' [link %s %s: %s]', v_type, v_names[i], v_out); END IF;
      -- ontkoppelen (de eigenaar koppelt eerst)
      n := n + 1;
      v_tx := proof.tx(n, CASE v_type WHEN 'inkoop' THEN -10.00 ELSE 10.00 END);
      v_inv := CASE v_type WHEN 'inkoop' THEN proof.pinv(n, 10.00) ELSE proof.sinv(n, 10.00) END;
      PERFORM proof.link(proof.u(6), v_tx, v_type, v_inv, 10, proof.req(n));
      v_out := proof.unlink(v_users[i], v_tx, proof.req(n + 50));
      v_floor := CASE v_type WHEN 'inkoop' THEN 3 ELSE 4 END;
      v_expect := v_rank[i] >= v_floor;
      v_ok := CASE WHEN v_expect THEN v_out = 'ok: unlinked|1|niet_gematcht|f'
                   ELSE proof.refused(v_out, '42501', 'Onvoldoende rechten')
                        AND (SELECT count(*) FROM public.bank_transaction_allocations WHERE bank_transaction_id = v_tx) = 1 END;
      IF NOT v_ok THEN v_bad := v_bad || format(' [unlink %s %s: %s]', v_type, v_names[i], v_out); END IF;
    END LOOP;
  END LOOP;
  PERFORM proof.record('D1', 'rolmatrix 4 × 2 × 2: inkoop koppelen vanaf assistent, ontkoppelen vanaf accountant (assistent krijgt een expliciete 42501, geen stille 0-rij); verkoop beide alleen eigenaar (D2)',
    v_bad = '', nullif(v_bad, ''));
END
$d$;

-- ═══ E. Idempotentie ═══════════════════════════════════════════════════════

SELECT proof.put('e_alloc_count', (SELECT count(*)::text FROM public.bank_transaction_allocations));
SELECT proof.put('e_event_count', (SELECT count(*)::text FROM public.bank_payment_events));
SELECT proof.put('e1', proof.link(proof.u(6), proof.uid(1000, 100), 'verkoop', proof.uid(3000, 100), 30, proof.req(100)));
SELECT proof.record('E1', 'herhaling met dezelfde argumenten: exact het oorspronkelijke antwoord, replayed = true, niets nieuws',
  proof.get('e1') = regexp_replace(proof.get('b1'), '\|f$', '|t')
  AND (SELECT count(*)::text FROM public.bank_transaction_allocations) = proof.get('e_alloc_count')
  AND (SELECT count(*)::text FROM public.bank_payment_events) = proof.get('e_event_count'),
  proof.get('e1'));

SELECT proof.put('e2a', proof.link(proof.u(6), proof.uid(1000, 100), 'verkoop', proof.uid(3000, 100), 31, proof.req(100)));
SELECT proof.put('e2b', proof.link(proof.u(6), proof.uid(1000, 100), 'verkoop', proof.uid(3000, 106), 30, proof.req(100)));
SELECT proof.put('e2c', proof.link(proof.u(6), proof.uid(1000, 101), 'verkoop', proof.uid(3000, 100), 30, proof.req(100)));
SELECT proof.record('E2', 'dezelfde request_id met een ander bedrag, een andere factuur of een andere transactie: 22023, niets gewijzigd',
  proof.refused(proof.get('e2a'), '22023', 'request_id') AND proof.refused(proof.get('e2b'), '22023', 'request_id')
  AND proof.refused(proof.get('e2c'), '22023', 'request_id')
  AND (SELECT count(*)::text FROM public.bank_transaction_allocations) = proof.get('e_alloc_count'),
  proof.get('e2a'));

-- E3: de factuur van B1 is inmiddels volledig betaald (B2); de herhaling geeft nog steeds het oude antwoord.
SELECT proof.record('E3', 'herhaling na een latere toestandswijziging geeft het opgeslagen antwoord (restant 70), niet de huidige toestand',
  proof.f(proof.get('e1'), 3) = '70.00' AND proof.inv('verkoop', proof.uid(3000, 100)) = '0.00|betaald');

SELECT proof.put('e4', proof.unlink(proof.u(6), proof.uid(1000, 100), proof.req(100)));
SELECT proof.record('E4', 'een request_id van een koppeling hergebruiken voor ontkoppelen: 22023',
  proof.refused(proof.get('e4'), '22023', 'request_id'), proof.get('e4'));

SELECT proof.tx(400, 15.00), proof.sinv(400, 15.00);
SELECT proof.put('e5', proof.link(proof.u(1), proof.uid(1000, 400), 'inkoop', proof.uid(2000, 400), 15, proof.req(100)));
SELECT proof.record('E5', 'claims zijn per actor: dezelfde request_id van een andere actor is een eigen aanvraag (hier geweigerd om de factuur, niet om de id)',
  proof.refused(proof.get('e5'), '42501', 'Factuur niet beschikbaar'), proof.get('e5'));

SELECT proof.tx(401, 15.00), proof.sinv(401, 15.00);
SELECT proof.link(proof.u(6), proof.uid(1000, 401), 'verkoop', proof.uid(3000, 401), 15, proof.req(401));
SELECT proof.put('e6a', proof.unlink(proof.u(6), proof.uid(1000, 401), proof.req(402)));
SELECT proof.put('e6b', proof.unlink(proof.u(6), proof.uid(1000, 401), proof.req(402)));
SELECT proof.record('E6', 'ontkoppelen herhalen: hetzelfde antwoord met replayed = true',
  proof.get('e6a') = 'ok: unlinked|1|niet_gematcht|f' AND proof.get('e6b') = 'ok: unlinked|1|niet_gematcht|t',
  proof.get('e6b'));

-- ═══ F. Een bestaand paar wordt nooit overschreven ═════════════════════════

SELECT proof.tx(500, 50.00), proof.sinv(500, 100.00);
SELECT proof.put('f0', proof.link(proof.u(6), proof.uid(1000, 500), 'verkoop', proof.uid(3000, 500), 20, proof.req(500)));
SELECT proof.put('f1', proof.link(proof.u(6), proof.uid(1000, 500), 'verkoop', proof.uid(3000, 500), 20, proof.req(501)));
SELECT proof.record('F1', 'zelfde paar en bedrag met een nieuwe request_id: unchanged, alleen een claim, geen gebeurtenis',
  proof.f(proof.get('f1'), 2) = 'unchanged' AND proof.f(proof.get('f1'), 1) = proof.f(proof.get('f0'), 1)
  AND (SELECT count(*) FROM public.bank_payment_events WHERE request_id = proof.req(501)) = 0
  AND (SELECT outcome FROM public.bank_payment_requests WHERE request_id = proof.req(501)) = 'unchanged'
  AND proof.inv('verkoop', proof.uid(3000, 500)) = '80.00|gecontroleerd', proof.get('f1'));

SELECT proof.put('f2', proof.link(proof.u(6), proof.uid(1000, 500), 'verkoop', proof.uid(3000, 500), 25, proof.req(502)));
SELECT proof.record('F2', 'zelfde paar met een ander bedrag: 23505, de koppeling blijft 20',
  proof.refused(proof.get('f2'), '23505', 'ander bedrag')
  AND (SELECT amount FROM public.bank_transaction_allocations WHERE id = proof.f(proof.get('f0'), 1)::uuid) = 20,
  proof.get('f2'));

-- F3: een oude, consistente koppeling (L6) met hetzelfde bedrag: unchanged.
SELECT proof.put('f3', proof.link(proof.u(6), proof.uid(1000, 66), 'verkoop', proof.uid(3000, 66), 25, proof.req(503)));
SELECT proof.record('F3', 'een consistente koppeling van vóór P5a met hetzelfde bedrag: unchanged',
  proof.f(proof.get('f3'), 2) = 'unchanged', proof.get('f3'));

-- ═══ G. Ontkoppelen ════════════════════════════════════════════════════════

-- G1: ontkoppelen zet restant, status en matchvelden terug.
SELECT proof.put('g1', proof.unlink(proof.u(6), proof.uid(1000, 101), proof.req(600)));
SELECT proof.record('G1', 'ontkoppelen van 70 op een betaalde factuur: restant 70, betaald → gecontroleerd, T niet_gematcht zonder primaire factuur',
  proof.get('g1') = 'ok: unlinked|1|niet_gematcht|f'
  AND proof.inv('verkoop', proof.uid(3000, 100)) = '70.00|gecontroleerd'
  AND proof.txs(proof.uid(1000, 101)) = 'niet_gematcht||0|0'
  AND (SELECT match_confidence IS NULL FROM public.bank_transactions WHERE id = proof.uid(1000, 101)),
  proof.get('g1'));

-- G2: precies één van twee koppelingen.
SELECT proof.put('g2', proof.unlink(proof.u(6), proof.uid(1000, 108), proof.req(601), proof.alloc(proof.uid(1000, 108), proof.uid(3000, 108))));
SELECT proof.record('G2', 'één van twee koppelingen ontkoppelen: de andere blijft, T gematcht met de overgebleven factuur als primair',
  proof.get('g2') = 'ok: unlinked|1|gematcht|f'
  AND proof.txs(proof.uid(1000, 108)) = format('gematcht|%s|40.00|1', proof.uid(3000, 109))
  AND proof.inv('verkoop', proof.uid(3000, 108)) = '60.00|gecontroleerd' AND proof.inv('verkoop', proof.uid(3000, 109)) = '0.00|betaald',
  proof.get('g2'));

SELECT proof.put('g3', proof.unlink(proof.u(6), proof.uid(1000, 101), proof.req(602)));
SELECT proof.record('G3', 'niets te ontkoppelen: unchanged (alleen een claim)',
  proof.get('g3') = 'ok: unchanged|0|niet_gematcht|f', proof.get('g3'));

-- G4/G5: een geboekte aflettering, ook na tegenboeking.
SELECT proof.tx(603, 70.00), proof.sinv(603, 70.00, 'gecontroleerd', true);
SELECT proof.put('g4l', proof.link(proof.u(6), proof.uid(1000, 603), 'verkoop', proof.uid(3000, 603), 70, proof.req(603)));
SELECT proof.put('g4p', public.post_bank_allocation(proof.f(proof.get('g4l'), 1)::uuid)::text);
SELECT proof.put('g_before', proof.p5digest());
SELECT proof.put('g4', proof.unlink(proof.u(6), proof.uid(1000, 603), proof.req(604)));
SELECT proof.record('G4', 'ontkoppelen van een geboekte aflettering: 23514, niets gewijzigd',
  proof.refused(proof.get('g4'), '23514', 'aflettering') AND proof.p5digest() = proof.get('g_before'), proof.get('g4'));
SELECT public.reverse_posting_group(proof.get('g4p')::uuid, DATE '2027-03-02', 'Tegenboeking afletteringstest');
SELECT proof.put('g_before', proof.p5digest());
SELECT proof.put('g5', proof.unlink(proof.u(6), proof.uid(1000, 603), proof.req(605)));
SELECT proof.record('G5', 'ook na tegenboeking blijft de aflettering gekoppeld (A1-17, ontwerpbesluit): 23514, niets gewijzigd',
  proof.refused(proof.get('g5'), '23514', 'ook niet na een tegenboeking') AND proof.p5digest() = proof.get('g_before'),
  proof.get('g5'));

-- G6: ontkoppelen op een geboekte verkoopfactuur zet betaald terug naar gecontroleerd.
SELECT proof.tx(606, 70.00), proof.sinv(606, 70.00, 'gecontroleerd', true);
SELECT proof.put('g6l', proof.link(proof.u(6), proof.uid(1000, 606), 'verkoop', proof.uid(3000, 606), 70, proof.req(606)));
SELECT proof.put('g6m', proof.inv('verkoop', proof.uid(3000, 606)));
SELECT proof.put('g6', proof.unlink(proof.u(6), proof.uid(1000, 606), proof.req(607)));
SELECT proof.record('G6', 'geboekte verkoopfactuur: koppelen maakt haar betaald, ontkoppelen zet haar via de betaalschrijver terug op gecontroleerd',
  proof.get('g6m') = '0.00|betaald' AND proof.get('g6') LIKE 'ok: unlinked|%'
  AND proof.inv('verkoop', proof.uid(3000, 606)) = '70.00|gecontroleerd', proof.get('g6'));

-- G7: buiten de schrijver blijft betaald → gecontroleerd op een geboekte factuur geweigerd, ook met een vervalste vlag.
SELECT proof.link(proof.u(6), proof.uid(1000, 606), 'verkoop', proof.uid(3000, 606), 70, proof.req(608));
SELECT proof.put('g7a', proof.call(proof.u(6), format(
  'UPDATE public.sales_invoices SET status = ''gecontroleerd'' WHERE id = %L RETURNING status', proof.uid(3000, 606))));
/** Zet de vlag van de betaalschrijver zelf en probeert dan de status terug te zetten. */
CREATE FUNCTION proof.forge_flag_update(_id uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('boekassist.betaalschrijver', pg_current_xact_id()::text, true);
  UPDATE public.sales_invoices SET status = 'gecontroleerd' WHERE id = _id RETURNING status INTO v;
  RETURN v;
END $$;
GRANT EXECUTE ON FUNCTION proof.forge_flag_update(uuid) TO public;
SELECT proof.put('g7b', proof.call(proof.u(6), format('SELECT proof.forge_flag_update(%L)', proof.uid(3000, 606))));
SELECT proof.record('G7', 'betaald → gecontroleerd op een geboekte factuur buiten de schrijver (ook met een zelf gezette vlag): 42501',
  proof.refused(proof.get('g7a'), '42501', 'alleen nog van gecontroleerd naar betaald')
  AND proof.refused(proof.get('g7b'), '42501', 'alleen nog van gecontroleerd naar betaald')
  AND proof.inv('verkoop', proof.uid(3000, 606)) = '0.00|betaald',
  proof.get('g7b'));

SELECT proof.tx(609, -20.00), proof.pinv(609, 20.00);
SELECT proof.link(proof.u(2), proof.uid(1000, 609), 'inkoop', proof.uid(2000, 609), 20, proof.req(609));
SELECT proof.put('g8', proof.unlink(proof.u(2), proof.uid(1000, 609), proof.req(610)));
SELECT proof.record('G8', 'een assistent die een inkoopkoppeling verwijdert: expliciete 42501 (A1-06), koppeling blijft',
  proof.refused(proof.get('g8'), '42501', 'accountant')
  AND proof.txs(proof.uid(1000, 609)) = format('gematcht|%s|20.00|1', proof.uid(2000, 609)), proof.get('g8'));

-- ═══ H. Legacy: fail closed, niets herschreven ═════════════════════════════

SELECT proof.tx(700, 120.00);
SELECT proof.put('h_before', proof.p5digest());
SELECT proof.put('h1a', proof.link(proof.u(6), proof.uid(1000, 700), 'verkoop', proof.uid(3000, 60), 120, proof.req(700)));
SELECT proof.put('h1b', proof.unlink(proof.u(6), proof.uid(1000, 60), proof.req(701)));
SELECT proof.put('h1c', proof.link(proof.u(6), proof.uid(1000, 60), 'verkoop', proof.uid(3000, 60), 100, proof.req(702)));
SELECT proof.record('H1', 'via een oude match betaalde factuur (L1): koppelen vanuit een andere transactie, ontkoppelen en een niet-passend bedrag: "herstel nodig", niets gewijzigd',
  proof.refused(proof.get('h1a'), '23514', 'herstel nodig') AND proof.refused(proof.get('h1b'), '23514', 'herstel nodig')
  AND proof.refused(proof.get('h1c'), '23514', 'herstel nodig') AND proof.p5digest() = proof.get('h_before'),
  proof.get('h1a'));

SELECT proof.put('h2', proof.link(proof.u(6), proof.uid(1000, 60), 'verkoop', proof.uid(3000, 60), 120, proof.req(703)));
SELECT proof.record('H2', 'de oude match vastleggen (formalized): koppeling 120, restant blijft 0, status blijft betaald',
  proof.f(proof.get('h2'), 2) = 'created' AND proof.inv('verkoop', proof.uid(3000, 60)) = '0.00|betaald'
  AND proof.txs(proof.uid(1000, 60)) = format('gematcht|%s|120.00|1', proof.uid(3000, 60))
  AND (SELECT formalized AND remaining_before = 0 AND remaining_after = 0 FROM public.bank_payment_events WHERE request_id = proof.req(703)),
  proof.get('h2'));

SELECT proof.put('h3', proof.link(proof.u(6), proof.uid(1000, 61), 'verkoop', proof.uid(3000, 61), 90, proof.req(704)));
SELECT proof.record('H3', 'oude match zonder bijgewerkt restant (L2): gewone koppeling, restant 0 en betaald, niet formalized',
  proof.inv('verkoop', proof.uid(3000, 61)) = '0.00|betaald'
  AND (SELECT NOT formalized FROM public.bank_payment_events WHERE request_id = proof.req(704)), proof.get('h3'));

SELECT proof.tx(705, 30.00), proof.sinv(705, 30.00), proof.sinv(706, 30.00);
UPDATE public.bank_transactions SET match_status = 'gematcht', matched_invoice_id = proof.uid(3000, 705) WHERE id = proof.uid(1000, 705);
SELECT proof.put('h_before', proof.p5digest());
SELECT proof.put('h4', proof.link(proof.u(6), proof.uid(1000, 705), 'verkoop', proof.uid(3000, 706), 30, proof.req(705)));
SELECT proof.record('H4', 'oude match naar factuur X, koppelen aan factuur Y: "herstel nodig", niets gewijzigd',
  proof.refused(proof.get('h4'), '23514', 'herstel nodig') AND proof.p5digest() = proof.get('h_before'), proof.get('h4'));

SELECT proof.put('h5a', proof.link(proof.u(6), proof.uid(1000, 64), 'verkoop', proof.uid(3000, 63), 10, proof.req(706)));
SELECT proof.put('h5b', proof.unlink(proof.u(6), proof.uid(1000, 63), proof.req(707)));
SELECT proof.record('H5', 'restant wijkt af van factuurbedrag − koppelingen (L4): koppelen en ontkoppelen "herstel nodig", niets gewijzigd',
  proof.refused(proof.get('h5a'), '23514', 'Openstaand bedrag wijkt af van de koppelingen; herstel nodig')
  AND proof.refused(proof.get('h5b'), '23514', 'Openstaand bedrag wijkt af van de koppelingen; herstel nodig')
  AND proof.p5digest() = proof.get('h_before'), proof.get('h5a'));

-- H6: een verkeerd getypeerde (wees)koppeling op hetzelfde factuur-id.
SELECT proof.tx(708, -10.00), proof.tx(709, 30.00), proof.sinv(708, 30.00);
SET session_replication_role = replica;
INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, organization_id, amount, user_id)
VALUES (proof.uid(1000, 708), 'inkoop', proof.uid(3000, 708), '00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-00000000a001', 10, proof.u(1));
SET session_replication_role = origin;
SELECT proof.put('h_before', proof.p5digest());
SELECT proof.put('h6', proof.link(proof.u(6), proof.uid(1000, 709), 'verkoop', proof.uid(3000, 708), 30, proof.req(708)));
SELECT proof.record('H6', 'een koppeling van een andere soort op hetzelfde factuur-id: "herstel nodig", niets gewijzigd',
  proof.refused(proof.get('h6'), '23514', 'herstel nodig') AND proof.p5digest() = proof.get('h_before'), proof.get('h6'));

SELECT proof.put('h7a', proof.link(proof.u(6), proof.uid(1000, 65), 'verkoop', proof.uid(3000, 706), 1, proof.req(709)));
SELECT proof.put('h7b', proof.unlink(proof.u(6), proof.uid(1000, 65), proof.req(710)));
SELECT proof.record('H7', 'gecodeerd én gekoppeld (L5): koppelen en ontkoppelen "herstel nodig"',
  proof.refused(proof.get('h7a'), '23514', 'herstel nodig') AND proof.refused(proof.get('h7b'), '23514', 'herstel nodig')
  AND proof.p5digest() = proof.get('h_before'), proof.get('h7b'));

SELECT proof.put('h8', proof.unlink(proof.u(1), proof.uid(1000, 62), proof.req(711)));
SELECT proof.record('H8', 'inkoopfactuur met de oude status betaald (L3): ontkoppelen "herstel nodig" (de status wordt niet geraden)',
  proof.refused(proof.get('h8'), '23514', 'oude status betaald') AND proof.p5digest() = proof.get('h_before'), proof.get('h8'));

SELECT proof.tx(712, 40.00), proof.sinv(712, 100.00);
UPDATE public.sales_invoices SET remaining_amount = NULL WHERE id = proof.uid(3000, 712);
SELECT proof.put('h9', proof.link(proof.u(6), proof.uid(1000, 712), 'verkoop', proof.uid(3000, 712), 40, proof.req(712)));
SELECT proof.record('H9', 'restant NULL zonder koppelingen telt als afgeleid: koppelen 40 → restant 60',
  proof.f(proof.get('h9'), 3) = '60.00' AND proof.inv('verkoop', proof.uid(3000, 712)) = '60.00|gecontroleerd', proof.get('h9'));

SELECT proof.tx(713, 75.00);
SELECT proof.put('h10a', proof.link(proof.u(6), proof.uid(1000, 713), 'verkoop', proof.uid(3000, 66), 75, proof.req(713)));
SELECT proof.put('h10b', proof.unlink(proof.u(6), proof.uid(1000, 66), proof.req(714)));
SELECT proof.record('H10', 'consistente koppeling van vóór P5a (L6): aanvullen tot betaald, en de oude koppeling via de RPC ontkoppelen (restant 25, gecontroleerd)',
  proof.f(proof.get('h10a'), 4) = 'betaald' AND proof.get('h10b') = 'ok: unlinked|1|niet_gematcht|f'
  AND proof.inv('verkoop', proof.uid(3000, 66)) = '25.00|gecontroleerd', proof.get('h10b'));

-- ═══ I. Vangnet: de oude app tijdens de uitrol (directe schrijfacties) ══════

SELECT proof.tx(800, 50.00), proof.sinv(800, 50.00), proof.tx(801, 50.00), proof.tx(802, -10.00),
       proof.sinv(803, 50.00, 'gecontroleerd', false, '00000000-0000-0000-0000-0000000000c2');
SELECT proof.put('i1', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 800), 'verkoop', proof.uid(3000, 800), 30));
SELECT proof.record('I1', 'de oude app kan binnen de grenzen nog rechtstreeks koppelen; created_by = de actor',
  proof.get('i1') LIKE 'ok:%'
  AND (SELECT created_by FROM public.bank_transaction_allocations WHERE id = substr(proof.get('i1'), 5)::uuid) = proof.u(1),
  proof.get('i1'));

SELECT proof.put('i2', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 801), 'verkoop', proof.uid(3000, 800), 30));
SELECT proof.record('I2', 'rechtstreekse over-allocatie op de factuur (30 + 30 > 50): 23514 bij COMMIT', proof.refused(proof.get('i2'), '23514', 'factuurbedrag'), proof.get('i2'));

SELECT proof.sinv(804, 100.00);
SELECT proof.put('i3', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 800), 'verkoop', proof.uid(3000, 804), 30));
SELECT proof.record('I3', 'rechtstreekse over-allocatie op de transactie (30 + 30 > 50): 23514 bij COMMIT', proof.refused(proof.get('i3'), '23514', 'transactiebedrag'), proof.get('i3'));

SELECT proof.call(proof.u(1), format(
  'INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id) VALUES (%L, ''verkoop'', %L) RETURNING id::text',
  proof.uid(1000, 801), proof.uid(3000, 804)));
SELECT proof.put('i4', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 801), 'verkoop', proof.uid(3000, 804), 10));
SELECT proof.record('I4', 'rechtstreekse koppeling op een afgewezen paar: 23514 (zonder P5a aanvaard, N3)', proof.refused(proof.get('i4'), '23514', 'afgewezen'), proof.get('i4'));

SELECT proof.put('i5a', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 801), 'verkoop', proof.uid(3000, 803), 10));
SELECT proof.put('i5b', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 801), 'verkoop', proof.uid(3000, 999998), 10));
SELECT proof.put('i5c', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 801), 'inkoop', proof.uid(3000, 804), 10));
SELECT proof.record('I5', 'rechtstreeks naar een factuur van een andere administratie, een onbestaande factuur of de verkeerde soort: 42501',
  proof.refused(proof.get('i5a'), '42501', 'Factuur niet beschikbaar') AND proof.refused(proof.get('i5b'), '42501', 'Factuur niet beschikbaar')
  AND proof.refused(proof.get('i5c'), '42501', 'Factuur niet beschikbaar'), proof.get('i5a'));

SELECT proof.put('i6', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 802), 'verkoop', proof.uid(3000, 804), 10));
SELECT proof.record('I6', 'rechtstreeks in de verkeerde richting: 22023', proof.refused(proof.get('i6'), '22023', 'inkomende'), proof.get('i6'));

SELECT proof.put('i7', proof.direct_alloc_i(proof.u(1), proof.uid(1000, 801), 'verkoop', proof.uid(3000, 205), 10));
SELECT proof.record('I7', 'rechtstreeks naar een factuur zonder bedrag inclusief btw: 22004', proof.refused(proof.get('i7'), '22004', 'inclusief btw'), proof.get('i7'));

-- I8: een door de schrijver vastgelegde koppeling verandert alleen via de schrijver.
SELECT proof.put('i8a', proof.call(proof.u(1), format(
  'UPDATE public.bank_transaction_allocations SET amount = 10 WHERE id = %L RETURNING id::text', proof.f(proof.get('f0'), 1))));
SELECT proof.put('i8b', proof.call(proof.u(1), format(
  'DELETE FROM public.bank_transaction_allocations WHERE id = %L RETURNING id::text', proof.f(proof.get('f0'), 1))));
SELECT proof.put('i8c', proof.call(proof.u(1), format(
  'INSERT INTO public.bank_transaction_allocations (bank_transaction_id, invoice_type, invoice_id, client_id, amount, user_id)
   SELECT bt.id, ''verkoop'', %L, bt.client_id, 10, bt.user_id FROM public.bank_transactions bt WHERE bt.id = %L
   ON CONFLICT (bank_transaction_id, invoice_id) DO UPDATE SET amount = EXCLUDED.amount RETURNING id::text',
  proof.uid(3000, 500), proof.uid(1000, 500))));
SELECT proof.record('I8', 'een via de schrijver gemaakte koppeling: UPDATE, DELETE en upsert van de oude app worden geweigerd (42501), bedrag blijft 20',
  proof.refused(proof.get('i8a'), '42501', 'betaalschrijver') AND proof.refused(proof.get('i8b'), '42501', 'betaalschrijver')
  AND proof.refused(proof.get('i8c'), '42501', 'betaalschrijver')
  AND (SELECT amount FROM public.bank_transaction_allocations WHERE id = proof.f(proof.get('f0'), 1)::uuid) = 20,
  proof.get('i8c'));

SELECT proof.put('i9a', proof.call(proof.u(1), format(
  'DELETE FROM public.bank_transactions WHERE id = %L RETURNING id::text', proof.uid(1000, 500))));
SELECT proof.put('i9b', proof.call(proof.u(1), format(
  'DELETE FROM public.bank_transactions WHERE id = %L RETURNING id::text', proof.uid(1000, 800))));
SELECT proof.record('I9', 'banktransactie verwijderen: met een schrijverskoppeling geweigerd (cascade, 42501); met een oude koppeling zoals vroeger toegestaan',
  proof.refused(proof.get('i9a'), '42501', 'betaalschrijver') AND proof.get('i9b') LIKE 'ok:%'
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_allocations WHERE bank_transaction_id = proof.uid(1000, 800)),
  proof.get('i9a'));

SELECT proof.put('i10', proof.call(proof.u(1), format(
  'INSERT INTO public.bank_match_rejections (bank_transaction_id, invoice_type, invoice_id) VALUES (%L, ''verkoop'', %L) RETURNING id::text',
  proof.uid(1000, 500), proof.uid(3000, 500))));
SELECT proof.record('I10', 'een gekoppeld paar afwijzen: 23514', proof.refused(proof.get('i10'), '23514', 'ontkoppel eerst'), proof.get('i10'));

-- I11: append-only, ook voor de eigenaar en in replica-modus.
SELECT proof.put('i11a', proof.call(NULL, 'UPDATE public.bank_payment_events SET amount = 1 RETURNING id::text', 'postgres'));
SELECT proof.put('i11b', proof.call(NULL, 'DELETE FROM public.bank_payment_requests RETURNING request_id::text', 'postgres'));
DO $i11$
DECLARE v text;
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    TRUNCATE public.bank_payment_events;
    v := 'GEEN fout';
  EXCEPTION WHEN others THEN v := format('fout [%s] %s', SQLSTATE, SQLERRM);
  END;
  PERFORM proof.put('i11d', v);
END
$i11$;
SELECT proof.record('I11', 'claims en gebeurtenissen: UPDATE, DELETE en TRUNCATE geweigerd (42501), ook voor de eigenaar en in replica-modus',
  proof.refused(proof.get('i11a'), '42501', 'append-only') AND proof.refused(proof.get('i11b'), '42501', 'append-only')
  AND proof.refused(proof.get('i11d'), '42501', 'append-only'), proof.get('i11d'));

SELECT proof.put('i12a', proof.call(proof.u(6), format(
  'INSERT INTO public.bank_payment_events (actor_id, request_id, event_type, allocation_id, bank_transaction_id, invoice_type, invoice_id, organization_id, client_id, amount, remaining_after, status_before, status_after, tx_status_before, tx_status_after, created_xact_id)
   VALUES (%L, %L, ''linked'', gen_random_uuid(), %L, ''verkoop'', %L, ''00000000-0000-0000-0000-00000000a001'', ''00000000-0000-0000-0000-0000000000c1'', 1, 0, ''x'', ''y'', ''a'', ''b'', pg_current_xact_id()) RETURNING id::text',
  proof.u(6), proof.req(100), proof.uid(1000, 500), proof.uid(3000, 500))));
SELECT proof.put('i12b', proof.call(proof.u(4), 'SELECT count(*)::text FROM public.bank_payment_events'));
SELECT proof.put('i12c', proof.call(proof.u(3), 'SELECT count(*)::text FROM public.bank_payment_events'));
SELECT proof.record('I12', 'gebeurtenissen: geen INSERT voor authenticated (42501); de lezer ziet alles van zijn organisatie, de buitenstaander niets',
  proof.refused(proof.get('i12a'), '42501', 'permission denied')
  AND proof.get('i12b') = 'ok: ' || (SELECT count(*) FROM public.bank_payment_events)::text
  AND proof.get('i12c') = 'ok: 0', proof.get('i12a'));

-- ═══ J. Correcties en afwijzingen ══════════════════════════════════════════

SELECT proof.tx(900, -121.00), proof.pinv(900, 121.00);
SELECT proof.link(proof.u(2), proof.uid(1000, 900), 'inkoop', proof.uid(2000, 900), 121, proof.req(900));
SELECT proof.put('j1', proof.rc(proof.u(2), proof.uid(1000, 900), NULL, proof.acct(6), 21, proof.req(901)));
SELECT proof.record('J1', 'eerst koppelen, dan corrigeren (herclassificeren): de correctie-RPC weigert (22023)',
  proof.refused(proof.get('j1'), '22023', 'gekoppeld') OR proof.refused(proof.get('j1'), '22023', 'koppeling'), proof.get('j1'));

SELECT proof.tx(902, -121.00), proof.pinv(902, 121.00);
SELECT proof.put('j2p', proof.rc(proof.u(2), proof.uid(1000, 902), NULL, proof.acct(6), 21, proof.req(902)));
SELECT proof.put('j2', proof.link(proof.u(2), proof.uid(1000, 902), 'inkoop', proof.uid(2000, 902), 121, proof.req(903)));
SELECT proof.record('J2', 'eerst rechtstreeks boeken (correctie-RPC), dan koppelen: 23514',
  proof.get('j2p') LIKE 'ok:%' AND proof.refused(proof.get('j2'), '23514', 'rechtstreeks'), proof.get('j2'));

SELECT proof.put('j3', proof.call(proof.u(2), format(
  'DELETE FROM public.bank_match_rejections WHERE bank_transaction_id = %L RETURNING id::text', proof.uid(1000, 203))));
SELECT proof.put('j3l', proof.link(proof.u(6), proof.uid(1000, 203), 'verkoop', proof.uid(3000, 203), 100, proof.req(904)));
SELECT proof.record('J3', 'een afwijzing ongedaan maken maakt het paar weer koppelbaar',
  proof.get('j3') LIKE 'ok:%' AND proof.f(proof.get('j3l'), 2) = 'created', proof.get('j3l'));

-- ═══ Z. Invarianten ════════════════════════════════════════════════════════

SELECT proof.expect_true('Z1', 'elke door de schrijver geraakte factuur en transactie sluit aan; geen boekingsgroep uit balans; geen uuid in meldingen',
  $$proof.writer_violations() = 0 AND proof.unbalanced() = 0
    AND NOT EXISTS (SELECT 1 FROM proof.refusal
                    WHERE outcome ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')$$);
