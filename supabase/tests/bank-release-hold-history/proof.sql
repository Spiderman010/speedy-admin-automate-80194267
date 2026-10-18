-- BEWIJZEN NA 20261018180000 (twee keer toegepast) — throwaway database only.
--
--   C  catalogus: precies één nieuwe functie (de hulpfunctie) en één nieuw
--      lichaam (de hold = PR 1 + de uitzondering); verder niets, geen rij
--   V  de voorwaardencontrole uit de migratie weigert bij elke afwijking
--   H  het oordeel van de hulpfunctie per testregel: alleen bewezen geschiedenis
--   Q  POST 8 (PR 1), POST C4 en C5 letterlijk uit de rolloutbestanden
--   D  D12: een vrijgegeven historische regel is voor elk pad en elke rol
--      dicht — behalve de expliciete accountant-RPC's
--
-- :'prereq' = het DO-blok uit de migratie onder test; :'post8', :'postc4' en
-- :'postc5' = de blokken uit de rolloutbestanden, letterlijk.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY[
  'C1','C2','C3','C4','C5','C6','C7','C8',
  'V0','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11',
  'H1','H2a','H2b','H2c','H2d','H2e','H2f','H2g','H2h','H2i','H2j','H2k','H3','H4','H5','H6','H7',
  'Q1','Q2','Q3','Q4',
  'D1','D2a','D2b','D2c','D2d','D2e','D3a','D3b','D3c','D3d','D3e','D4a','D4b','D4c','D5','D6','D7','D8',
  'D9a','D9b','D10a','D10b','D10c','D10d','D11']);

-- ═══ C. CATALOGUS ════════════════════════════════════════════════════════════

SELECT proof.expect_true('C1', 'precies één nieuwe functie: de hulpfunctie', $$
  (SELECT array_agg(name) FROM (SELECT name FROM proof.catalog() WHERE kind = 'function'
                                EXCEPT SELECT name FROM proof.catalog_before WHERE kind = 'function') x)
  = ARRAY['bank_transaction_group_is_settled_history(uuid,uuid)']
  AND NOT EXISTS (SELECT name FROM proof.catalog_before WHERE kind = 'function'
                  EXCEPT SELECT name FROM proof.catalog() WHERE kind = 'function') $$);

SELECT proof.expect_true('C2', 'verder veranderde alleen het lichaam en het commentaar van de hold: elke schrijver, RPC, trigger, tabel, policy, constraint en index byte-gelijk', $$
  (SELECT array_agg(DISTINCT kind || ':' || name ORDER BY kind || ':' || name)
   FROM ((SELECT * FROM proof.catalog() EXCEPT SELECT * FROM proof.catalog_before)
         UNION ALL
         (SELECT * FROM proof.catalog_before EXCEPT SELECT * FROM proof.catalog())) d)
  = ARRAY['comment:bank_transaction_group_is_settled_history(uuid,uuid)', 'comment:enforce_bank_transaction_release_hold()',
          'function:bank_transaction_group_is_settled_history(uuid,uuid)', 'function:enforce_bank_transaction_release_hold()'] $$);

SELECT proof.expect_true('C3', 'het hold-lichaam is exact dat van PR 1 plus de ene voorwaarde en haar toelichting (zonder die regels: md5 van PR 1)', $$
  (SELECT md5(prosrc) = '43347fb9f48ed4c161e291fa769577c2'
          AND md5(replace(replace(prosrc,
                E'\n  -- Een bewezen historische storno van vóór de correctiegebeurtenissen van\n  -- deze transactie (bank_transaction_group_is_settled_history) is zo''n groep\n  -- niet: zij hoort bij geen lopende correctie en schakelt de hold niet uit.', ''),
                E'\n         AND NOT public.bank_transaction_group_is_settled_history(OLD.id, lp.posting_group_id)', ''))
              = '812d151a7041cdd48b7a784cd193a159'
   FROM pg_proc WHERE oid = 'public.enforce_bank_transaction_release_hold()'::regprocedure) $$);

SELECT proof.expect_true('C4', 'de hold houdt elke eigenschap van PR 1: SECURITY DEFINER, VOLATILE, search_path, eigenaar, rechten, resultaat', $$
  (SELECT substr(def, 34) FROM proof.catalog() WHERE kind = 'function' AND name = 'enforce_bank_transaction_release_hold()')
  = (SELECT substr(def, 34) FROM proof.catalog_before WHERE kind = 'function' AND name = 'enforce_bank_transaction_release_hold()')
  AND (SELECT prosecdef AND provolatile = 'v' AND proconfig = ARRAY['search_path=public']
       FROM pg_proc WHERE oid = 'public.enforce_bank_transaction_release_hold()'::regprocedure) $$);

SELECT proof.expect_true('C5', 'de hulpfunctie: SQL, STABLE (kan niet schrijven), geen SECURITY DEFINER, vaste search_path, eigenaar als de schrijver, voor niemand uitvoerbaar', $$
  (SELECT p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql') AND p.provolatile = 's' AND NOT p.prosecdef
          AND p.proconfig = ARRAY['search_path=public']
          AND p.proowner = (SELECT proowner FROM pg_proc WHERE oid = 'public.post_bank_transaction(uuid)'::regprocedure)
          AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
          AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
   FROM pg_proc p WHERE p.oid = 'public.bank_transaction_group_is_settled_history(uuid,uuid)'::regprocedure) $$);

SELECT proof.record('C6', 'de app-rollen kunnen de hulpfunctie niet aanroepen (assistent, accountant, service_role)',
  a LIKE 'fout [42501] permission denied for function bank_transaction_group_is_settled_history%'
  AND b LIKE 'fout [42501] permission denied%' AND c LIKE 'fout [42501] permission denied%', concat_ws(' || ', a, b, c))
FROM proof.call(proof.u(2), format('SELECT public.bank_transaction_group_is_settled_history(%L, %L)::text', proof.uid(1000, 10), proof.h_orig(10))) a,
     proof.call(proof.u(1), format('SELECT public.bank_transaction_group_is_settled_history(%L, %L)::text', proof.uid(1000, 10), proof.h_orig(10))) b,
     proof.call(NULL, format('SELECT public.bank_transaction_group_is_settled_history(%L, %L)::text', proof.uid(1000, 10), proof.h_orig(10)), 'service_role') c;

SELECT proof.record('C7', 'geen enkele rij veranderde door de migratie (grootboek, storno''s, markers, gebeurtenissen, bankregels, alle andere tabellen)',
  proof.digest() = proof.get('digest_before_fix') AND proof.rest_digest() = proof.get('rest_before_fix'));

SELECT proof.record('C8', 'idempotent: de tweede toepassing veranderde niets aan de catalogus',
  proof.catalog_digest() = proof.get('catalog_after_first_fix'));

-- ═══ V. DE VOORWAARDENCONTROLE, LETTERLIJK UIT DE MIGRATIE ═══════════════════

SELECT proof.record('V0', 'in de beoordeelde toestand (tweede toepassing) laat de controle de migratie door', o = 'ok', o)
FROM proof.prereq_passes(:'prereq') o;

SELECT proof.prereq_refuses('V1', 'weigert zonder de gebeurtenistabel van PR 1',
  'ALTER TABLE public.bank_transaction_posting_events RENAME TO proof_weg', :'prereq', 'de tabellen van het grootboek en van PR 1 ontbreken');
SELECT proof.prereq_refuses('V2', 'weigert zonder created_at op de gebeurtenissen (het bewijs van "vóór de gebeurtenissen")',
  'ALTER TABLE public.bank_transaction_posting_events RENAME COLUMN created_at TO proof_weg', :'prereq', 'de kolommen waarop het bewijs');
SELECT proof.prereq_refuses('V3', 'weigert zonder PR 2 (geen correctie-RPC)',
  'ALTER FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text) RENAME TO proof_weg', :'prereq', 'PR 2 (20261018150000) is niet toegepast');
SELECT proof.prereq_refuses('V4', 'weigert als de correctie-RPC niet die van PR 2 is (ander lichaam)',
  $s$ALTER FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text) RENAME TO proof_weg;
     CREATE FUNCTION public.reclassify_bank_transaction(uuid, uuid, uuid, numeric, uuid, text, text) RETURNS void LANGUAGE sql AS 'SELECT'$s$,
  :'prereq', 'PR 2 (20261018150000) is niet toegepast');
SELECT proof.prereq_refuses('V5', 'weigert zonder hold',
  'ALTER FUNCTION public.enforce_bank_transaction_release_hold() RENAME TO proof_weg', :'prereq', 'enforce_bank_transaction_release_hold ontbreekt');
SELECT proof.prereq_refuses('V6', 'weigert als de hold een ander lichaam heeft dan PR 1 of deze migratie',
  $s$CREATE OR REPLACE FUNCTION public.enforce_bank_transaction_release_hold() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS 'BEGIN RETURN NEW; END'$s$,
  :'prereq', 'niet de beoordeelde versie');
SELECT proof.prereq_refuses('V7', 'weigert als de hold een andere eigenaar heeft dan de schrijver',
  'ALTER FUNCTION public.enforce_bank_transaction_release_hold() OWNER TO authenticated', :'prereq', 'andere eigenaar dan de schrijver');
SELECT proof.prereq_refuses('V8', 'weigert als de hold-trigger niet ENABLE ALWAYS is',
  'ALTER TABLE public.bank_transactions ENABLE TRIGGER enforce_bank_transaction_release_hold_trigger', :'prereq', 'niet ENABLE ALWAYS');
SELECT proof.prereq_refuses('V9', 'weigert als de hold-trigger ontbreekt',
  'DROP TRIGGER enforce_bank_transaction_release_hold_trigger ON public.bank_transactions', :'prereq', 'ontbreekt of is niet ENABLE ALWAYS');
SELECT proof.prereq_refuses('V10', 'weigert als de hulpfunctie al in een andere vorm bestaat (ander lichaam)',
  $s$CREATE OR REPLACE FUNCTION public.bank_transaction_group_is_settled_history(_transaction_id uuid, _posting_group_id uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS 'SELECT true'$s$,
  :'prereq', 'bestaat al in een andere vorm');
SELECT proof.prereq_refuses('V11', 'weigert als de hulpfunctie een andere eigenaar heeft',
  'ALTER FUNCTION public.bank_transaction_group_is_settled_history(uuid, uuid) OWNER TO authenticated', :'prereq', 'bestaat al in een andere vorm');

-- ═══ H. HET OORDEEL VAN DE HULPFUNCTIE ═══════════════════════════════════════

SELECT proof.expect_true('H1', 'waar voor elke bewezen historische groep (10–18; bij 15 beide) — ook 13, waar na de vrijgave al gebeurtenissen zijn', $$
  (SELECT bool_and(proof.settled(n, proof.h_orig(n))) FROM unnest(ARRAY[10, 11, 12, 13, 14, 15, 16, 17, 18]) n)
  AND proof.settled(15, proof.h_orig(15, 2)) $$);

CREATE TABLE proof.h2 (id text, n integer, grp_of integer, what text);
INSERT INTO proof.h2 VALUES
  ('H2a', 20, 20, 'niet gestorneerd'),
  ('H2b', 21, 21, 'storno op een latere datum'),
  ('H2c', 22, 22, 'geen nieuwe boeking na de storno (7)'),
  ('H2d', 23, 23, 'de storno is zelf tegengeboekt (5)'),
  ('H2e', 24, 24, 'niet neutraal per grootboekrekening (4)'),
  ('H2f', 25, 25, 'een regel hoort bij een andere transactie (1)'),
  ('H2g', 26, 25, 'diezelfde groep, gezien vanuit de andere transactie (1)'),
  ('H2h', 27, 27, 'het origineel op een andere datum (3)'),
  ('H2i', 28, 28, 'de claim op een andere datum (3)'),
  ('H2j', 29, 29, 'de storno mist een regel (2)'),
  ('H2k', 30, 30, 'een stornoregel zonder verwijzing (2); 31: claim van een andere bronsoort (2)');
SELECT proof.record(id, format('onwaar: %s', what),
  NOT proof.settled(n, proof.h_orig(grp_of)) AND (id <> 'H2k' OR NOT proof.settled(31, proof.h_orig(31))),
  proof.settled(n, proof.h_orig(grp_of))::text)
FROM proof.h2 ORDER BY id;

SELECT proof.expect_true('H3', 'onwaar voor elke actieve markergroep (6)', $$
  NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m
              WHERE public.bank_transaction_group_is_settled_history(m.bank_transaction_id, m.posting_group_id) IS DISTINCT FROM false) $$);

SELECT proof.expect_true('H4', 'onwaar voor een groep die als vervangen in een gebeurtenis staat (6): de vrijgegeven groep van 13 en van 41', $$
  NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e
              WHERE e.superseded_posting_group_id IS NOT NULL
                AND public.bank_transaction_group_is_settled_history(e.bank_transaction_id, e.superseded_posting_group_id) IS DISTINCT FROM false)
  AND (SELECT count(*) FROM public.bank_transaction_posting_events e WHERE e.superseded_posting_group_id IS NOT NULL) = 2 $$);

SELECT proof.expect_true('H5', 'onwaar voor een stornogroep zelf (1: geen directe bankregels)', $$
  NOT EXISTS (SELECT 1 FROM public.ledger_reversal_postings r JOIN public.ledger_postings o ON o.posting_group_id = r.original_posting_group_id
              WHERE o.source_type = 'bank_transaction'
                AND public.bank_transaction_group_is_settled_history(o.source_id, r.reversal_posting_group_id) IS DISTINCT FROM false) $$);

SELECT proof.expect_true('H6', 'onwaar voor de groep van een andere transactie (de historische groep van 10, gevraagd voor 11)', $$
  NOT proof.settled(11, proof.h_orig(10)) AND NOT proof.settled(10, proof.h_orig(11)) $$);

SELECT proof.expect_true('H7', 'onwaar — nooit NULL — voor een onbekende transactie, een onbekende groep en NULL', $$
  proof.settled(99, proof.h_orig(10)) = false AND proof.settled(10, gen_random_uuid()) = false
  AND public.bank_transaction_group_is_settled_history(NULL, proof.h_orig(10)) = false
  AND public.bank_transaction_group_is_settled_history(proof.uid(1000, 10), NULL) = false $$);

-- ═══ Q. DE POST-CONTROLES, LETTERLIJK ════════════════════════════════════════

SELECT proof.capture('post8_fix', :'post8');
SELECT proof.capture('postc4_fix', :'postc4');
SELECT proof.capture('postc5_fix', :'postc5');

SELECT proof.record('Q1', 'POST 8 na de fix: 2 vervangen, 10 bewezen historisch, 11 onverklaard, hold van de fix — STOP (de corrupte geschiedenis blijft STOP)',
  groepen_zonder_marker = 23 AND waarvan_vervangen = 2 AND waarvan_historische_storno = 10 AND waarvan_onverklaard = 11
  AND hold_versie = '20261018180000' AND toestand = 'STOP',
  format('%s/%s/%s/%s/%s/%s/%s', groepen_zonder_marker, waarvan_vervangen, waarvan_historische_storno, waarvan_onverklaard, gebeurtenissen, hold_versie, toestand))
FROM proof.post8_fix;

SELECT proof.record('Q2', 'POST 8 en de hold oordelen gelijk: het aantal groepen dat de hulpfunctie (en dus de hold) historisch noemt = POST 8',
  p.waarvan_historische_storno = (SELECT count(DISTINCT grp) FROM (
      SELECT DISTINCT lp.source_id AS tx, lp.posting_group_id AS grp FROM public.ledger_postings lp
      WHERE lp.source_type = 'bank_transaction'
        AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.bank_transaction_id = lp.source_id AND m.posting_group_id = lp.posting_group_id)) k
    WHERE public.bank_transaction_group_is_settled_history(k.tx, k.grp)
      AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e WHERE e.superseded_posting_group_id = k.grp)),
  p.waarvan_historische_storno::text)
FROM proof.post8_fix p;

SELECT proof.expect_true('Q3', 'POST C4: precies de 10 bewezen groepen waar, elke corrupte en vervangen groep onwaar; geen bekende productiegroep', $$
  (SELECT count(*) FROM proof.postc4_fix WHERE bewezen_historisch) = 10
  AND NOT EXISTS (SELECT 1 FROM proof.postc4_fix c WHERE c.bewezen_historisch
                  AND (c.banktransactie, c.groep) NOT IN (SELECT proof.uid(1000, n), proof.h_orig(n) FROM unnest(ARRAY[10, 11, 12, 13, 14, 15, 16, 17, 18]) n
                                                         UNION SELECT proof.uid(1000, 15), proof.h_orig(15, 2)))
  AND NOT EXISTS (SELECT 1 FROM proof.postc4_fix WHERE vervangen AND bewezen_historisch)
  AND NOT EXISTS (SELECT 1 FROM proof.postc4_fix WHERE bekend) $$);

SELECT proof.expect_true('Q4', 'POST C5: voor elke regel met bewezen geschiedenis dekt de hold na een vrijgave (9 regels, overal waar)', $$
  (SELECT count(*) FROM proof.postc5_fix) = 9 AND (SELECT bool_and(hold_dekt_na_vrijgave) FROM proof.postc5_fix)
  AND (SELECT array_agg(banktransactie ORDER BY banktransactie) FROM proof.postc5_fix)
      = (SELECT array_agg(proof.uid(1000, n) ORDER BY proof.uid(1000, n)) FROM unnest(ARRAY[10, 11, 12, 13, 14, 15, 16, 17, 18]) n) $$);

-- ═══ D. D12 — DE VRIJGEGEVEN HISTORISCHE REGEL ═══════════════════════════════
-- Regel 10 is zoals de regel in productie: € 3.993, geboekt op 25-11-2025,
-- dezelfde dag gestorneerd, marker weg, opnieuw geboekt — alles vóór PR 1.

SELECT proof.purchase(1010, 99.00);
SELECT proof.put('d_g10', proof.m(10)::text);
SELECT proof.put('d_rel10', proof.rel(proof.u(1), proof.uid(1000, 10), proof.m(10), proof.req(10001), 'Vrijgeven, eerst uitzoeken'));
SELECT proof.record('D1', 'de accountant geeft de historische regel vrij (RPC): storno van de actieve groep, geen marker, niet_gematcht, bank netto 0',
  proof.get('d_rel10') LIKE 'ok: released|f||%' AND proof.m(10) IS NULL AND proof.net(proof.uid(1000, 10), proof.acct(1)) = 0
  AND (SELECT match_status = 'niet_gematcht' AND grootboekrekening_id IS NULL FROM public.bank_transactions WHERE id = proof.uid(1000, 10)),
  proof.get('d_rel10'));
SELECT proof.put('d_digest', proof.digest());

CREATE FUNCTION proof.upd(_user uuid, _n integer, _set text, _role text DEFAULT 'authenticated') RETURNS text LANGUAGE sql AS $$
  SELECT proof.call(_user, format('UPDATE public.bank_transactions SET %s WHERE id = %L RETURNING id::text', _set, proof.uid(1000, _n)), _role);
$$;
GRANT EXECUTE ON FUNCTION proof.upd(uuid, integer, text, text) TO public;

SELECT proof.record('D2a', 'assistent: handmatig boeken (status, rekening, BTW) geweigerd',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(proof.u(2), 10, format('match_status = ''handmatig_geboekt'', grootboekrekening_id = %L, btw_percentage = 0', proof.acct(6))) o;
SELECT proof.record('D2b', 'assistent: een sjabloon / "Toepassen op open bankregels" (alleen de rekening) geweigerd',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(proof.u(2), 10, format('grootboekrekening_id = %L', proof.acct(7))) o;
SELECT proof.record('D2c', 'assistent: alleen het BTW-percentage geweigerd',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(proof.u(2), 10, 'btw_percentage = 21') o;
SELECT proof.record('D2d', 'assistent: matchen met een factuur (bevestigen, automatische scan, bulk-bevestigen) geweigerd',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(proof.u(2), 10, format('match_status = ''gematcht'', matched_invoice_id = %L, match_confidence = 100', proof.uid(2000, 1010))) o;
SELECT proof.record('D2e', 'assistent: een suggestie zetten (automatische scan) geweigerd',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(proof.u(2), 10, format('match_status = ''suggestie'', matched_invoice_id = %L, match_confidence = 60', proof.uid(2000, 1010))) o;

SELECT proof.record('D3a', 'dezelfde codering als accountant via de app geweigerd (de hold kijkt niet naar de rol)',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(proof.u(1), 10, format('match_status = ''handmatig_geboekt'', grootboekrekening_id = %L', proof.acct(6))) o;
SELECT proof.record('D3b', 'service_role (omzeilt RLS) geweigerd',
  o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', o)
FROM proof.upd(NULL, 10, format('match_status = ''handmatig_geboekt'', grootboekrekening_id = %L', proof.acct(6)), 'service_role') o;
SELECT proof.expect_error('D3c', 'ook de eigenaar in replica-modus (ENABLE ALWAYS)',
  format($q$SET LOCAL session_replication_role = replica;
            UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = %L WHERE id = %L$q$,
         proof.acct(6), proof.uid(1000, 10)),
  '42501', 'Deze banktransactie is vrijgegeven');
SELECT proof.record('D3d', 'het bedrag wijzigen geweigerd (identiteit bevroren)',
  o LIKE 'fout [42501] Deze banktransactie heeft een boekingsgeschiedenis%', o)
FROM proof.upd(proof.u(2), 10, 'amount = -3994.00') o;
SELECT proof.record('D3e', 'verwijderen geweigerd, ook voor een accountant',
  o LIKE 'fout [42501] Deze banktransactie heeft een boekingsgeschiedenis%', o)
FROM proof.call(proof.u(1), format('DELETE FROM public.bank_transactions WHERE id = %L RETURNING id::text', proof.uid(1000, 10))) o;

SELECT proof.record('D4a', 'een directe herboeking via de schrijver geweigerd (22023: niet gecodeerd, en coderen kan niet)',
  o LIKE 'fout [22023] Alleen handmatig gecodeerde%', o)
FROM proof.app_post(10) o;
SELECT proof.record('D4b', 'de bulkboeking weigert haar',
  o LIKE 'ok: rejected%', o)
FROM proof.call(proof.u(1), format('SELECT outcome FROM public.post_bank_transactions_bulk(ARRAY[%L]::uuid[])', proof.uid(1000, 10))) o;
SELECT proof.record('D4c', 'de inhaalslag noemt haar review_needed, niet ready',
  o = 'ok: review_needed', o)
FROM proof.call(proof.u(1), format('SELECT workflow_state FROM public.bank_bulk_posting_candidates(%L, 2025) WHERE transaction_id = %L',
                                   '00000000-0000-0000-0000-0000000000c1', proof.uid(1000, 10))) o;

SELECT proof.record('D5', 'en niets daarvan veranderde één rij', proof.digest() = proof.get('d_digest'));

SELECT proof.record('D6', 'de assistent kan ook "Opnieuw boeken" niet (accountant vereist)',
  o LIKE 'fout [42501] Geen rechten om een geboekte banktransactie te corrigeren%', o)
FROM proof.rc(proof.u(2), proof.uid(1000, 10), NULL, proof.acct(6), 0, proof.req(10002), 'Opnieuw boeken') o;

SELECT proof.put('d_rp10', proof.rc(proof.u(1), proof.uid(1000, 10), NULL, proof.acct(6), 0, proof.req(10003), 'Op 8250 opnieuw boeken'));
SELECT proof.record('D7', 'de expliciete accountant-RPC werkt: herboekt (S3) — bank € 3.993 precies één keer, op 8250, tekst uit de historie, bankregel byte-gelijk',
  proof.get('d_rp10') LIKE 'ok: reposted_after_release|f|%'
  AND proof.m(10) = proof.f(proof.get('d_rp10'), 3)::uuid
  AND proof.net(proof.uid(1000, 10), proof.acct(1)) = -3993.00 AND proof.net(proof.uid(1000, 10), proof.acct(6)) = 3993.00
  AND proof.net(proof.uid(1000, 10), proof.acct(7)) = 0
  AND proof.active_text(10) = 'Historische regel 10' AND proof.intact(10),
  proof.get('d_rp10'));

SELECT proof.expect_true('D8', 'na de herboeking: de historische groep blijft bewezen geschiedenis, de vrijgegeven groep is vervangen, de nieuwe is de marker', $$
  proof.settled(10, proof.h_orig(10))
  AND EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e WHERE e.superseded_posting_group_id = proof.get('d_g10')::uuid)
  AND proof.group_count(10) = 3 AND proof.reversal_count(10) = 2 $$);

-- D9: regel 13 (in de tussentoestand door de app stil herboekt, gap.sql) is
-- met de fix wél beschermd: nogmaals vrijgeven, dan is elk app-pad dicht.
SELECT proof.put('d_rel13', proof.rel(proof.u(1), proof.uid(1000, 13), proof.m(13), proof.req(13002), 'Opnieuw vrijgeven'));
SELECT proof.record('D9a', 'regel 13 uit de negatieve controle: na de fix weigert de app-codering die eerder lukte',
  proof.get('d_rel13') LIKE 'ok: released|f||%' AND o LIKE 'fout [42501] Deze banktransactie is vrijgegeven%', proof.get('d_rel13') || ' || ' || o)
FROM proof.app_code(13) o;
SELECT proof.record('D9b', 'en de directe herboeking ook', o LIKE 'fout [22023] Alleen handmatig gecodeerde%', o)
FROM proof.app_post(13) o;

-- D10: "Terug naar werkstroom" op een historische regel.
SELECT proof.put('d_rel16', proof.rel(proof.u(1), proof.uid(1000, 16), proof.m(16), proof.req(16001), 'Vrijgeven'));
SELECT proof.record('D10a', 'regel 16 vrijgegeven: de app is dicht, en de assistent mag haar niet terugzetten (accountant)',
  proof.get('d_rel16') LIKE 'ok: released|f||%' AND a LIKE 'fout [42501] Deze banktransactie is vrijgegeven%' AND b LIKE 'fout [42501]%',
  concat_ws(' || ', proof.get('d_rel16'), a, b))
FROM proof.app_code(16) a, proof.ret(proof.u(2), proof.uid(1000, 16), proof.req(16002)) b;
SELECT proof.put('d_ret16', proof.ret(proof.u(1), proof.uid(1000, 16), proof.req(16003), 'Uitgezocht: gewone werkstroom'));
SELECT proof.put('d_app16', proof.app_code(16));
SELECT proof.put('d_post16', proof.app_post(16));
SELECT proof.record('D10b', 'de accountant zet haar terug; daarna codeert en boekt de assistent haar via de gewone werkstroom',
  proof.get('d_ret16') LIKE 'ok: returned|f|%' AND proof.get('d_app16') LIKE 'ok: %' AND proof.get('d_post16') LIKE 'ok: %',
  concat_ws(' || ', proof.get('d_ret16'), proof.get('d_app16'), proof.get('d_post16')));
SELECT proof.record('D10c', 'één boeking: bank € 175 precies één keer, op 8250',
  proof.net(proof.uid(1000, 16), proof.acct(1)) = -175.00 AND proof.net(proof.uid(1000, 16), proof.acct(6)) = 175.00
  AND proof.net(proof.uid(1000, 16), proof.acct(7)) = 0);
SELECT proof.put('d_fix16', proof.rc(proof.u(1), proof.uid(1000, 16), proof.m(16), proof.acct(7), 0, proof.req(16004), 'Toch kantoorkosten'));
SELECT proof.record('D10d', 'en die boeking is later gewoon te corrigeren (S1)',
  proof.get('d_fix16') LIKE 'ok: reclassified|f|%' AND proof.net(proof.uid(1000, 16), proof.acct(7)) = 175.00, proof.get('d_fix16'));

-- D11: een onverklaarde groep (24, niet neutraal) gedraagt zich als onder PR 1:
-- na een vrijgave gaat de hold voor haar niet aan. Daarom geven PRE 4 en POST 8
-- op zo'n groep STOP — in productie komt het niet voor (PRE B6: alleen de bekende).
SELECT proof.put('d_rel24', proof.rel(proof.u(1), proof.uid(1000, 24), proof.m(24), proof.req(24001), 'Vrijgeven'));
SELECT proof.record('D11', 'onverklaard (24): gedrag als PR 1 — de hold gaat na vrijgeven niet aan; precies daarom STOP in PRE 4 en POST 8',
  proof.get('d_rel24') LIKE 'ok: released|f||%' AND o LIKE 'ok: %' AND NOT proof.settled(24, proof.h_orig(24)),
  proof.get('d_rel24') || ' || ' || o)
FROM proof.app_code(24) o;
