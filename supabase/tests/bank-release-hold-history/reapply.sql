-- W3 — OPNIEUW TOEGEPAST: PR 1, PR 2 en 20261018180000. Throwaway database only.
--
--   W3a  de catalogus is exact die na de eerste toepassing
--   W3b  F2, de lopende correctie op een vrijgegeven regel: in de toestand
--        "marker net los, gebeurtenis volgt" is de groep GEEN historische storno
--        ((7) en (8) onwaar) en laat de hold de codering door
--   W3c  en de echte correctie-RPC op die regel slaagt
--   W3d  de groep uit de tussentijd die op een historische storno lijkt: (1)–(7)
--        waar, maar jonger dan de eerste gebeurtenis — dus (8) onwaar, geen
--        historische storno
--   W3e  POST 8 noemt haar onverklaard: STOP
--   W3f  en de hold gedraagt zich voor haar als onder PR 1 (daarom STOP)
--   W3g  de hold werkt weer voor de bewezen historische regel

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['W3a','W3b','W3c','W3d','W3e','W3f','W3g']);

SELECT proof.record('W3a', 'opnieuw toegepast: de catalogus is exact die na de eerste toepassing van de fix',
  proof.catalog_digest() = proof.get('catalog_after_first_fix'));

-- W3b: de toestand midden in een correctie, teruggedraaid.
CREATE FUNCTION proof.w3_inflight() RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_g uuid := proof.m(13); v_settled boolean; v7 boolean; v8 boolean; v_upd text;
BEGIN
  BEGIN
    PERFORM public.reverse_posting_group(v_g, DATE '2025-11-25', 'Correctie loopt');
    DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = proof.uid(1000, 13);
    v_settled := public.bank_transaction_group_is_settled_history(proof.uid(1000, 13), v_g);
    -- (7): een latere directe boeking na de storno?
    v7 := EXISTS (SELECT 1 FROM public.ledger_postings g
                  WHERE g.source_type = 'bank_transaction' AND g.source_id = proof.uid(1000, 13) AND g.posting_group_id <> v_g
                    AND g.created_at >= (SELECT max(v.created_at) FROM public.ledger_postings v
                                         WHERE v.posting_group_id = proof.storno_of(v_g)));
    -- (8): alles strikt ouder dan de eerste gebeurtenis?
    v8 := NOT EXISTS (SELECT 1 FROM public.ledger_postings x
                      WHERE x.posting_group_id IN (v_g, proof.storno_of(v_g))
                        AND x.created_at >= (SELECT min(e.created_at) FROM public.bank_transaction_posting_events e
                                             WHERE e.bank_transaction_id = proof.uid(1000, 13)));
    UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = proof.acct(7), btw_percentage = 0
    WHERE id = proof.uid(1000, 13);
    v_upd := 'codering door de hold';
    RAISE EXCEPTION USING ERRCODE = 'P0003', MESSAGE = 'terugdraaien';
  EXCEPTION WHEN SQLSTATE 'P0003' THEN NULL;
            WHEN others THEN v_upd := format('fout [%s] %s', SQLSTATE, SQLERRM);
  END;
  RETURN concat_ws('|', v_settled, v7, v8, v_upd);
END $$;
GRANT EXECUTE ON FUNCTION proof.w3_inflight() TO public;
SELECT proof.record('W3b', 'F2 midden in een correctie (vrijgegeven regel, marker net los): geen historische storno — (7) en (8) onwaar — en de hold laat de codering door',
  o = 'f|f|f|codering door de hold', o)
FROM proof.w3_inflight() o;

SELECT proof.put('w_rc13', proof.rc(proof.u(1), proof.uid(1000, 13), proof.m(13), proof.acct(7), 0, proof.req(13003), 'Na de tussentijd corrigeren'));
SELECT proof.record('W3c', 'F2: de in de tussentijd geboekte groep van de vrijgegeven historische regel 13 is gewoon te corrigeren (S1)',
  proof.get('w_rc13') LIKE format('ok: reclassified|f|%%|%s|%%', proof.get('w_g13'))
  AND proof.net(proof.uid(1000, 13), proof.acct(1)) = -250.00 AND proof.net(proof.uid(1000, 13), proof.acct(7)) = 250.00
  AND proof.hist_lineage_violations(ARRAY[13]) = 0,
  proof.get('w_rc13'));

-- W3d: (1)–(7) waar, (8) onwaar. PRE 4b letterlijk (zonder kennis van gebeurtenissen).
SELECT proof.capture('pre4b_now', :'pre4b');
SELECT proof.record('W3d', 'de groep uit de tussentijd (12) voldoet aan (1)–(7) — PRE 4b zou haar bewezen noemen — maar is jonger dan de eerste gebeurtenis: geen historische storno',
  b.b1_zelfde_transactie AND b.b2_reversalketen AND b.b3_transactiedatum AND b.b4_neutraal AND b.b5_storno_geldig AND b.b6_actuele_marker_daarna
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                  WHERE e.superseded_posting_group_id = proof.get('w_g12a')::uuid OR e.replacement_posting_group_id = proof.get('w_g12a')::uuid)
  AND NOT proof.settled(12, proof.get('w_g12a')::uuid),
  format('%s%s%s%s%s%s/%s', b.b1_zelfde_transactie::int, b.b2_reversalketen::int, b.b3_transactiedatum::int, b.b4_neutraal::int,
         b.b5_storno_geldig::int, b.b6_actuele_marker_daarna::int, proof.settled(12, proof.get('w_g12a')::uuid)))
FROM proof.pre4b_now b
WHERE b.groep = proof.get('w_g12a')::uuid;

SELECT proof.capture('post8_reapply', :'post8');
SELECT proof.record('W3e', 'POST 8 noemt haar onverklaard: 12 onverklaard (11 corrupt + deze) — STOP',
  waarvan_onverklaard = 12 AND toestand = 'STOP' AND hold_versie = '20261018180000',
  format('%s/%s/%s/%s/%s', groepen_zonder_marker, waarvan_vervangen, waarvan_historische_storno, waarvan_onverklaard, toestand))
FROM proof.post8_reapply;

SELECT proof.put('w_rel12', proof.rel(proof.u(1), proof.uid(1000, 12), proof.m(12), proof.req(12004), 'Vrijgeven'));
SELECT proof.record('W3f', 'en voor 12 gedraagt de hold zich na vrijgeven als onder PR 1 (de groep uit de tussentijd is onverklaard) — precies daarom STOP',
  proof.get('w_rel12') LIKE 'ok: released|f||%' AND o LIKE 'ok: %', proof.get('w_rel12') || ' || ' || o)
FROM proof.app_code(12) o;

SELECT proof.put('w_rel10', proof.rel(proof.u(1), proof.uid(1000, 10), proof.m(10), proof.req(10004), 'Vrijgeven na heropname'));
SELECT proof.record('W3g', 'de hold werkt weer: de bewezen historische regel 10 is na vrijgeven dicht voor de app',
  proof.get('w_rel10') LIKE 'ok: released|f||%' AND o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', proof.get('w_rel10') || ' || ' || o)
FROM proof.app_code(10) o;
