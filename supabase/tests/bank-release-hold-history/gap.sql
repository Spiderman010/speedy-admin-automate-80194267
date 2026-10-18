-- N — NEGATIEVE CONTROLE: PR 1 + PR 2, ZONDER DE FIX. Throwaway database only.
--
-- Dit is de tussentoestand die productie nooit mag zien. Een historische regel
-- (13: geboekt, handmatig gestorneerd, marker weg, opnieuw geboekt — alles vóór
-- PR 1) wordt via de RPC vrijgegeven. Daarna kan de app haar stil opnieuw
-- coderen en boeken, buiten "Opnieuw boeken" om: de hold van PR 1 gaat voor
-- haar nooit aan. Een gewone regel (41) is wél beschermd. Na de fix toont
-- proof.sql (D9) dat dezelfde regel 13 dan wel beschermd is.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7']);

SELECT proof.record('N0', 'tussentoestand: PR 1 en PR 2 toegepast, de hulpfunctie bestaat nog niet en de hold is die van PR 1',
  to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)') IS NULL
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.enforce_bank_transaction_release_hold()')) = '812d151a7041cdd48b7a784cd193a159'
  AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)')) = '067939e0c44a672c26ec8883717ef6d2');

SELECT proof.put('n_g13', proof.m(13)::text);
SELECT proof.put('n_rel13', proof.rel(proof.u(1), proof.uid(1000, 13), proof.m(13), proof.req(13001), 'Vrijgeven, uitzoeken'));
SELECT proof.record('N1', 'de accountant geeft de historische regel 13 vrij (RPC): storno, geen marker, niet_gematcht',
  proof.get('n_rel13') LIKE 'ok: released|f||%' AND proof.m(13) IS NULL AND proof.net(proof.uid(1000, 13), proof.acct(1)) = 0,
  proof.get('n_rel13'));

SELECT proof.put('n_app13', proof.app_code(13));
SELECT proof.record('N2', 'HET GAT: de assistent codeert de vrijgegeven historische regel gewoon opnieuw (sjabloon/handmatig boeken)',
  proof.get('n_app13') LIKE 'ok: %', proof.get('n_app13'));

SELECT proof.put('n_post13', proof.app_post(13));
SELECT proof.record('N3', 'HET GAT: en de bestaande schrijver boekt haar — een herboeking buiten "Opnieuw boeken" om, zonder gebeurtenis',
  proof.get('n_post13') LIKE 'ok: %' AND proof.m(13) = substr(proof.get('n_post13'), 5)::uuid
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                  WHERE e.bank_transaction_id = proof.uid(1000, 13) AND e.replacement_posting_group_id = proof.m(13)),
  proof.get('n_post13'));

SELECT proof.record('N4', 'de oorzaak: de historische groep van 13 staat in geen gebeurtenis als vervangen, dus "een correctie loopt nog"',
  NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e WHERE e.superseded_posting_group_id = proof.h_orig(13))
  AND proof.storno_of(proof.h_orig(13)) IS NOT NULL);

SELECT proof.put('n_rel41', proof.rel(proof.u(1), proof.uid(1000, 41), proof.m(41), proof.req(41001), 'Vrijgeven'));
SELECT proof.record('N5', 'controle: een gewone regel (41) zonder geschiedenis is na vrijgeven wél beschermd door de hold van PR 1',
  proof.get('n_rel41') LIKE 'ok: released|f||%' AND o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%',
  proof.get('n_rel41') || ' || ' || o)
FROM proof.app_code(41) o;

-- Direct na PR 1 vastgelegd (run-proof.sh), letterlijk uit de rolloutbestanden.
SELECT proof.record('N6', 'de oorspronkelijke POST 8 van PR 1 (main 3669a94) verwacht 0 en 0 en gaf hier dus STOP — zonder onderscheid',
  groepen_zonder_marker = 21 AND gebeurtenissen = 0, format('%s/%s', groepen_zonder_marker, gebeurtenissen))
FROM proof.post8_oud_m1;

SELECT proof.record('N7', 'de nieuwe POST 8 direct na PR 1: 10 bewezen historisch, 11 onverklaard, hold van PR 1 — STOP (de onverklaarde gaan voor)',
  groepen_zonder_marker = 21 AND waarvan_vervangen = 0 AND waarvan_historische_storno = 10 AND waarvan_onverklaard = 11
  AND gebeurtenissen = 0 AND hold_versie = 'PR 1' AND toestand = 'STOP',
  format('%s/%s/%s/%s/%s/%s/%s', groepen_zonder_marker, waarvan_vervangen, waarvan_historische_storno, waarvan_onverklaard, gebeurtenissen, hold_versie, toestand))
FROM proof.post8_m1;
