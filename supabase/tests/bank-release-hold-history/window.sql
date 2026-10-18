-- W2 — DE ROLLBACK-TUSSENTIJD: fix, PR 2 en PR 1 teruggedraaid. Throwaway database only.
--
-- Zonder PR 1 boekt de gewone werkstroom zonder gebeurtenis, en kan de
-- eigenaar een marker weghalen. Hier ontstaan twee groepen die ná de eerste
-- correctiegebeurtenissen zijn geboekt:
--   13  de app boekt de vrijgegeven regel opnieuw: G13w (F2 in PR 1) — na
--       het opnieuw toepassen moet die gewoon corrigeerbaar zijn (een lopende
--       correctie op een vrijgegeven regel mag de hold niet blokkeren);
--   12  de app boekt haar, de eigenaar storneert die boeking op de
--       transactiedatum, haalt de marker weg en de app boekt opnieuw: G12a ziet
--       eruit als een historische storno — (1) t/m (7) zijn waar — maar is
--       jonger dan de eerste gebeurtenis van 12. Alleen (8) onderscheidt haar.
--   19  de eigenaar storneert de actieve groep G19 — van vóór de eerste
--       gebeurtenis (unchanged, S9) — haalt de marker weg en de app boekt
--       opnieuw: het origineel is ouder dan de gebeurtenis, de storno niet.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['W2a','W2b','W2c','W2d']);

SELECT proof.record('W2a', 'de rollback van PR 2 en PR 1 is gebeurd: geen correctie-RPC, geen hold, geen hulpfunctie; de gebeurtenissen staan er nog',
  to_regprocedure('public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)') IS NULL
  AND to_regprocedure('public.enforce_bank_transaction_release_hold()') IS NULL
  AND to_regprocedure('public.bank_transaction_group_is_settled_history(uuid,uuid)') IS NULL
  AND (SELECT count(*) FROM public.bank_transaction_posting_events) > 0);

-- 13: de app boekt de vrijgegeven regel opnieuw.
SELECT proof.put('w_app13', proof.app_code(13));
SELECT proof.put('w_g13', substr(proof.app_post(13), 5));
SELECT proof.record('W2b', 'in de tussentijd boekt de app de vrijgegeven regel 13 (geen gebeurtenis)',
  proof.get('w_app13') LIKE 'ok: %' AND proof.m(13) = proof.get('w_g13')::uuid, proof.get('w_g13'));

-- 12: boeken, storneren op de transactiedatum, marker weg, opnieuw boeken.
SELECT proof.put('w_app12', proof.app_code(12));
SELECT proof.put('w_g12a', substr(proof.app_post(12), 5));
SELECT public.reverse_posting_group(proof.get('w_g12a')::uuid, DATE '2025-11-25', 'Handmatige storno in de tussentijd');
DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = proof.uid(1000, 12);
SELECT proof.put('w_g12b', substr(proof.app_post(12), 5));
SELECT proof.record('W2c', 'in de tussentijd: 12 geboekt, op de transactiedatum gestorneerd, marker weg en opnieuw geboekt',
  proof.get('w_app12') LIKE 'ok: %' AND proof.m(12) = proof.get('w_g12b')::uuid
  AND proof.storno_of(proof.get('w_g12a')::uuid) IS NOT NULL AND proof.net(proof.uid(1000, 12), proof.acct(1)) = -500.00,
  concat_ws(' || ', proof.get('w_g12a'), proof.get('w_g12b')));

-- 19: de actieve groep (van vóór de eerste gebeurtenis) in de tussentijd storneren en opnieuw boeken.
SELECT proof.put('w_g19', proof.m(19)::text);
SELECT public.reverse_posting_group(proof.get('w_g19')::uuid, DATE '2025-11-25', 'Handmatige storno in de tussentijd');
DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = proof.uid(1000, 19);
SELECT proof.put('w_g19b', substr(proof.app_post(19), 5));
SELECT proof.record('W2d', 'in de tussentijd: de actieve groep van 19 (ouder dan haar eerste gebeurtenis) gestorneerd, marker weg en opnieuw geboekt',
  proof.m(19) = proof.get('w_g19b')::uuid AND proof.storno_of(proof.get('w_g19')::uuid) IS NOT NULL
  AND proof.net(proof.uid(1000, 19), proof.acct(1)) = -19.00,
  concat_ws(' || ', proof.get('w_g19'), proof.get('w_g19b')));
