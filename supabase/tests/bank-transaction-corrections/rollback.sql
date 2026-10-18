-- NA DE ROLLBACK (het blok uit de kop van de migratie, twee keer uitgevoerd).
-- Throwaway database only.
--   B1  de RPC's, triggerfuncties en triggers zijn weg
--   B2  de gebeurtenistabel en haar inhoud blijven staan; geen enkele rij veranderd
--   B3  alle bestaande functies en triggers byte-gelijk
--   B4  het gat is weer open (gedocumenteerd gevolg): de eigenaar kan een
--       marker weghalen, een vrijgegeven regel kan weer gewoon geboekt worden —
--       en dat laatste is één boeking, geen dubbele
--   B5  de lineage blijft compleet

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SELECT set_config('test.user_id', '00000000-0000-0000-0000-0000000000e1', false);

SELECT proof.plan(ARRAY['B1','B2','B3','B4a','B4b','B5']);

SELECT proof.expect_true('B1', 'de drie RPC''s, de markerbewaking en de hold zijn weg; alleen de gebeurtenistabel houdt haar eigen append-only-bewaking (2 functies, 3 triggers)', $$
  (SELECT array_agg(p.proname::text ORDER BY p.proname COLLATE "C") FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text NOT IN (SELECT sig FROM proof.functions_before))
  = ARRAY['enforce_bank_transaction_posting_event', 'prevent_bank_transaction_posting_event_mutation']
  AND (SELECT array_agg(format('%s/%s/%s', t.tgrelid::regclass, t.tgname, t.tgenabled) ORDER BY t.tgname COLLATE "C")
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
         AND (t.tgrelid::regclass::text, t.tgname) NOT IN (SELECT tbl, tgname FROM proof.triggers_before))
  = ARRAY['bank_transaction_posting_events/enforce_bank_transaction_posting_event_trigger/O',
          'bank_transaction_posting_events/prevent_bank_transaction_posting_event_mutation_trigger/A',
          'bank_transaction_posting_events/prevent_bank_transaction_posting_event_truncate_trigger/A'] $$);

SELECT proof.record('B2', 'de gebeurtenistabel staat er nog, en geen enkele rij — grootboek, markers, bankregels, gebeurtenissen — veranderde',
  to_regclass('public.bank_transaction_posting_events') IS NOT NULL
  AND (SELECT count(*) FROM public.bank_transaction_posting_events) > 0
  AND proof.digest() = proof.get('digest_before_rollback'));

SELECT proof.expect_true('B3', 'alle bestaande functies en triggers byte-gelijk aan vóór PR 1', $$
  NOT EXISTS (SELECT * FROM proof.functions_before
              EXCEPT SELECT p.oid::regprocedure::text, md5(p.prosrc), p.prosecdef, p.provolatile,
                            coalesce(p.proconfig::text, ''), pg_get_userbyid(p.proowner), coalesce(p.proacl::text, '')
                     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace)
  AND NOT EXISTS (SELECT * FROM proof.triggers_before
                  EXCEPT SELECT t.tgrelid::regclass::text, t.tgname, t.tgenabled::text, pg_get_triggerdef(t.oid)
                         FROM pg_trigger t WHERE NOT t.tgisinternal) $$);

SELECT proof.record('B4a', 'gat weer open: de eigenaar kan een marker zonder tegenboeking weghalen (in een subtransactie, teruggedraaid)',
  o = 'gelukt (teruggedraaid)', o)
FROM proof.nc_try(format('DELETE FROM public.bank_transaction_postings WHERE bank_transaction_id = %L', proof.uid(1000, 951))) o;

UPDATE public.bank_transactions SET match_status = 'handmatig_geboekt', grootboekrekening_id = proof.acct(7), btw_percentage = 21
WHERE id = proof.uid(1000, 950);
SELECT proof.put('b950', public.post_bank_transaction(proof.uid(1000, 950))::text);
SELECT proof.record('B4b', 'zonder hold boekt de gewone werkstroom een vrijgegeven regel weer — één keer: bank −121,00',
  proof.marker(proof.uid(1000, 950)) = proof.get('b950')::uuid AND proof.net(proof.uid(1000, 950), proof.acct(1)) = -121.00,
  proof.net(proof.uid(1000, 950), proof.acct(1))::text);

SELECT proof.record('B5', 'de lineage blijft compleet en alles in balans', proof.lineage_violations() = 0 AND proof.unbalanced() = 0);
