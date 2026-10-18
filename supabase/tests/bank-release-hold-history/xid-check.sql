-- X — NA HET OPNIEUW TOEPASSEN: WAT DE HOLD EN POST 8 MET DIE GROEPEN DOEN. Throwaway database only.
--
-- Vervolg op prestart.sql. De hold (bank_transaction_group_is_settled_history)
-- oordeelt in (8) bewust op de tijd: een vergissing kan haar alleen strenger
-- maken, en de tijd blijft kloppen na een logische restore (X9). POST 8 oordeelt
-- strenger, ook op de transactievolgorde (created_xact_id).
-- :'post8' en :'pre4b' = de blokken uit de rolloutbestanden, letterlijk.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['X0','X1','X2','X3','X4','X5','X6','X7','X8','X9','X10']);

SELECT proof.record('X0', 'de opzet lukte: vrijgaven, rollback, t en t2 boekten, b en b2 storneerden, haalden de marker weg en boekten opnieuw',
  proof.get('x_rel41') LIKE 'ok: released|f||%' AND proof.get('x_rel42') LIKE 'ok: released|f||%'
  AND proof.get('x_t_post') LIKE 'ok: ok: %' AND proof.get('x_t2_post') LIKE 'ok: ok: %'
  AND proof.get('x_b_post') LIKE 'ok: %' AND proof.get('x_b2_post') LIKE 'ok: %'
  AND proof.get('x_b_commit') = 'ok' AND proof.get('x_b2_commit') = 'ok'
  AND proof.m(41) = substr(proof.get('x_b_post'), 5)::uuid AND proof.m(42) = substr(proof.get('x_b2_post'), 5)::uuid,
  concat_ws(' | ', proof.get('x_t_post'), proof.get('x_b_post'), proof.get('x_t2_post'), proof.get('x_b2_post')));

/** De eerste gebeurtenis van testregel _n: tijd en xid. */
CREATE FUNCTION proof.first_event(_n integer) RETURNS TABLE (at timestamptz, xact xid8) LANGUAGE sql STABLE AS $$
  SELECT e.created_at, e.created_xact_id FROM public.bank_transaction_posting_events e
  WHERE e.bank_transaction_id = proof.uid(1000, _n) ORDER BY e.seq LIMIT 1;
$$;
/** Tijd en xid van origineel en storno van groep _g: (max tijd, min xid, max xid). */
CREATE FUNCTION proof.evidence(_g uuid) RETURNS TABLE (max_at timestamptz, min_xact xid8, max_xact xid8) LANGUAGE sql STABLE AS $$
  SELECT max(lp.created_at), min(lp.created_xact_id), max(lp.created_xact_id) FROM public.ledger_postings lp
  WHERE lp.posting_group_id IN (_g, proof.storno_of(_g));
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA proof TO public;

SELECT proof.record('X1', 'Codex: origineel en storno van G_A (41) hebben een created_at van vóór de eerste gebeurtenis, maar een created_xact_id erna',
  v.max_at < f.at AND v.min_xact > f.xact, format('%s < %s, %s > %s', v.max_at, f.at, v.min_xact, f.xact))
FROM proof.evidence(proof.get('x_ga')::uuid) v, proof.first_event(41) f;

SELECT proof.record('X2', 'restgeval: van G_A2 (42) liggen ook de xid''s vóór de gebeurtenis (t2 en b2 schreven al eerder iets)',
  v.max_at < f.at AND v.max_xact < f.xact, format('%s < %s, %s < %s', v.max_at, f.at, v.max_xact, f.xact))
FROM proof.evidence(proof.get('x_ga2')::uuid) v, proof.first_event(42) f;

SELECT proof.capture('x_pre4b', :'pre4b');
SELECT proof.record('X3', '(1)–(7) zijn voor beide waar: PRE 4b (zonder kennis van gebeurtenissen) noemt ze bewezen; ze staan in geen gebeurtenis',
  (SELECT count(*) FROM proof.x_pre4b b WHERE b.bewezen AND b.groep IN (proof.get('x_ga')::uuid, proof.get('x_ga2')::uuid)) = 2
  AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
                  WHERE e.superseded_posting_group_id IN (proof.get('x_ga')::uuid, proof.get('x_ga2')::uuid)
                     OR e.replacement_posting_group_id IN (proof.get('x_ga')::uuid, proof.get('x_ga2')::uuid)));

SELECT proof.capture('x_post8', :'post8');
SELECT proof.record('X4', 'POST 8 toetst ook de transactievolgorde: G_A (41) is onverklaard — STOP; G_A2 (42) haalt beide volgordes (restgeval)',
  waarvan_onverklaard = 1 AND waarvan_historische_storno = 2 AND waarvan_vervangen = 2 AND toestand = 'STOP',
  format('%s/%s/%s/%s', waarvan_vervangen, waarvan_historische_storno, waarvan_onverklaard, toestand))
FROM proof.x_post8;

SELECT proof.record('X5', 'de hold oordeelt op de tijd: beide groepen gelden voor haar als geschiedenis',
  proof.settled(41, proof.get('x_ga')::uuid) AND proof.settled(42, proof.get('x_ga2')::uuid));

SELECT proof.put('x_rel41b', proof.rel(proof.u(1), proof.uid(1000, 41), proof.m(41), proof.req(41902), 'Opnieuw vrijgeven'));
SELECT proof.put('x_rel42b', proof.rel(proof.u(1), proof.uid(1000, 42), proof.m(42), proof.req(42902), 'Opnieuw vrijgeven'));
SELECT proof.record('X6', 'en dat maakt de hold alleen strenger: na vrijgeven weigert de app de codering van 41 en 42, zoals bij elke bewezen regel',
  proof.get('x_rel41b') LIKE 'ok: released|f||%' AND proof.get('x_rel42b') LIKE 'ok: released|f||%'
  AND a LIKE 'fout [42501] Deze banktransactie is vrijgegeven%' AND b LIKE 'fout [42501] Deze banktransactie is vrijgegeven%',
  concat_ws(' || ', a, b))
FROM proof.app_code(41) a, proof.app_code(42) b;

SELECT proof.put('x_rp41', proof.rc(proof.u(1), proof.uid(1000, 41), NULL, proof.acct(7), 0, proof.req(41903), 'Opnieuw boeken'));
SELECT proof.put('x_rp42', proof.rc(proof.u(1), proof.uid(1000, 42), NULL, proof.acct(7), 21, proof.req(42903), 'Opnieuw boeken'));
SELECT proof.record('X7', 'en "Opnieuw boeken" (de accountant-RPC) werkt gewoon: bank precies één keer per regel',
  proof.get('x_rp41') LIKE 'ok: reposted_after_release|f|%' AND proof.get('x_rp42') LIKE 'ok: reposted_after_release|f|%'
  AND proof.net(proof.uid(1000, 41), proof.acct(1)) = -41.00 AND proof.net(proof.uid(1000, 42), proof.acct(1)) = 121.00,
  concat_ws(' || ', proof.get('x_rp41'), proof.get('x_rp42')));

-- ── een logische restore (nagebootst): de xid's van regel 10 komen uit een oude, hogere reeks ──
SELECT proof.put('x_g10', proof.h_orig(10)::text);
SELECT proof.forge(format($f$
  UPDATE public.ledger_postings SET created_xact_id = (created_xact_id::text::bigint + 100000000000)::text::xid8
  WHERE posting_group_id IN (%1$L, %2$L, %3$L) $f$,
  proof.get('x_g10'), proof.storno_of(proof.get('x_g10')::uuid), proof.m(10)));
SELECT proof.put('x_rel10', proof.rel(proof.u(1), proof.uid(1000, 10), proof.m(10), proof.req(10903), 'Vrijgeven na restore'));
SELECT proof.record('X8', 'na een (nagebootste) logische restore: de xid''s van de historische groep liggen nu ná de nieuwe gebeurtenis',
  proof.get('x_rel10') LIKE 'ok: released|f||%' AND v.min_xact > f.xact, format('%s > %s', v.min_xact, f.xact))
FROM proof.evidence(proof.get('x_g10')::uuid) v, proof.first_event(10) f;

SELECT proof.record('X9', 'de hold dekt de regel van 25-11-2025 toch: zij oordeelt op de tijd — na vrijgeven weigert de app de codering',
  proof.settled(10, proof.get('x_g10')::uuid) AND o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.app_code(10) o;

SELECT proof.capture('x_post8_restore', :'post8');
SELECT proof.record('X10', 'en POST 8 meldt het: de historische groep is op transactievolgorde niet meer te bewijzen — STOP (melden, niet negeren)',
  toestand = 'STOP' AND waarvan_onverklaard = 2,
  format('%s/%s/%s/%s', waarvan_vervangen, waarvan_historische_storno, waarvan_onverklaard, toestand))
FROM proof.x_post8_restore;
