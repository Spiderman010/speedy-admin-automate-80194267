-- X2 — NA HET OPNIEUW TOEPASSEN: GEEN GESCHIEDENIS VAN NA DE EERSTE GEBEURTENIS. Throwaway database only.
--
-- Vervolg op prestart.sql. :'post8' en :'pre4b' = de blokken uit de
-- rolloutbestanden, letterlijk.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['X0','X1','X2','X3','X4','X5']);

SELECT proof.record('X0', 'de opzet lukte: vrijgave, rollback, t boekte, b storneerde, haalde de marker weg en boekte opnieuw',
  proof.get('x_rel41') LIKE 'ok: released|f||%' AND proof.get('x_t_code') LIKE 'ok: ok: %' AND proof.get('x_t_post') LIKE 'ok: ok: %'
  AND proof.get('x_t_commit') = 'ok' AND proof.get('x_b_rev') LIKE 'ok: %' AND proof.get('x_b_unmark') = 'ok'
  AND proof.get('x_b_post') LIKE 'ok: %' AND proof.get('x_b_commit') = 'ok'
  AND proof.m(41) = substr(proof.get('x_b_post'), 5)::uuid,
  concat_ws(' | ', proof.get('x_t_post'), proof.get('x_b_rev'), proof.get('x_b_post')));

SELECT proof.record('X1', 'Codex'' scenario: origineel, storno en claim hebben elk een created_at van vóór de eerste gebeurtenis — de tijd alleen zou dit "geschiedenis" noemen',
  (SELECT max(lp.created_at) FROM public.ledger_postings lp
   WHERE lp.posting_group_id IN (proof.get('x_ga')::uuid, proof.storno_of(proof.get('x_ga')::uuid)))
  < (SELECT min(e.created_at) FROM public.bank_transaction_posting_events e WHERE e.bank_transaction_id = proof.uid(1000, 41))
  AND (SELECT r.created_at FROM public.ledger_reversal_postings r WHERE r.original_posting_group_id = proof.get('x_ga')::uuid)
      < (SELECT min(e.created_at) FROM public.bank_transaction_posting_events e WHERE e.bank_transaction_id = proof.uid(1000, 41)));

SELECT proof.record('X2', 'maar hun transacties schreven pas daarna: created_xact_id van origineel en storno is groter dan die van de eerste gebeurtenis',
  (SELECT min(lp.created_xact_id) FROM public.ledger_postings lp
   WHERE lp.posting_group_id IN (proof.get('x_ga')::uuid, proof.storno_of(proof.get('x_ga')::uuid)))
  > (SELECT e.created_xact_id FROM public.bank_transaction_posting_events e WHERE e.bank_transaction_id = proof.uid(1000, 41)
     ORDER BY e.seq LIMIT 1));

SELECT proof.capture('x_pre4b', :'pre4b');
SELECT proof.record('X3', 'en (1)–(7) zijn waar: PRE 4b (zonder kennis van gebeurtenissen) noemt haar bewezen; zij staat in geen gebeurtenis',
  b.bewezen
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                  WHERE e.superseded_posting_group_id = proof.get('x_ga')::uuid OR e.replacement_posting_group_id = proof.get('x_ga')::uuid),
  b.toestand)
FROM proof.x_pre4b b WHERE b.groep = proof.get('x_ga')::uuid;

SELECT proof.record('X4', 'de hulpfunctie noemt haar GEEN historische storno: (8) toetst ook de volgorde van de transacties',
  NOT proof.settled(41, proof.get('x_ga')::uuid), proof.settled(41, proof.get('x_ga')::uuid)::text);

SELECT proof.capture('x_post8', :'post8');
SELECT proof.record('X5', 'POST 8 noemt haar onverklaard: STOP',
  waarvan_onverklaard = 1 AND waarvan_historische_storno = 1 AND toestand = 'STOP',
  format('%s/%s/%s/%s', waarvan_vervangen, waarvan_historische_storno, waarvan_onverklaard, toestand))
FROM proof.x_post8;
