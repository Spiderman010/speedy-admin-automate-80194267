-- REAL POSTGRESQL PROOF for 6C-b11 PR H — de anti-clobber-toets is load-bearing.
-- Run against a THROWAWAY local cluster only. See run-proof.sh.
--
-- run-proof.sh heeft zojuist één doelfunctie onschadelijk gewijzigd (de
-- blokkadetoets staat er nog; alleen de hash verschilt), de hashes van alle
-- doelfuncties vastgelegd onder 'mut.hash.*', en daarna geprobeerd de migratie
-- toe te passen. Hier: is dat geweigerd, noemt de weigering de juiste functie,
-- en is er werkelijk niets gewijzigd?
--
-- Variabelen: :phase ('C' of 'D'), :mutated (functienaam), :rejected (0/1),
-- :'msg' (de eerste foutregel van psql).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

-- psql-variabelen worden niet vervangen binnen dollar-quotes; via GUC's dus.
SELECT set_config('proof.phase', :'phase', false),
       set_config('proof.mutated', :'mutated', false),
       set_config('proof.rejected', :'rejected', false),
       set_config('proof.msg', :'msg', false);

DO $$
DECLARE
  v_phase   text := current_setting('proof.phase');
  v_mutated text := current_setting('proof.mutated');
  v_rej     boolean := (current_setting('proof.rejected') = '1');
  v_msg     text := current_setting('proof.msg');
  v_naam    text;
  v_mis     text := '';
BEGIN
  PERFORM proof.record(v_phase || '1',
    format('%s: een onbekend lichaam van %s (mét blokkadetoets) laat de migratie WEIGEREN', v_phase, v_mutated),
    v_rej AND v_msg LIKE '%PR H geweigerd: public.' || v_mutated || '() heeft een onbekend lichaam%',
    left(v_msg, 160));

  PERFORM proof.record(v_phase || '2',
    format('%s: de weigering noemt de werkelijke hash en beide toegestane hashes, en eist handmatig onderzoek', v_phase),
    v_msg LIKE '%md5(prosrc) = ' || proof.snap_get('mut.hash.' || v_mutated) || '%'
      AND v_msg LIKE '%verwacht vóór PR H: %' AND v_msg LIKE '%ná PR H: %'
      AND v_msg LIKE '%Onderzoek handmatig%');

  FOREACH v_naam IN ARRAY proof.changed_functions() || proof.untouched_functions() LOOP
    IF proof.hash(v_naam) IS DISTINCT FROM proof.snap_get('mut.hash.' || v_naam)
       OR proof.acl(v_naam) IS DISTINCT FROM proof.snap_get('mut.acl.' || v_naam) THEN
      v_mis := v_mis || v_naam || ' ';
    END IF;
  END LOOP;
  PERFORM proof.record(v_phase || '3',
    format('%s: en er is NIETS gewijzigd — geen enkel lichaam, geen enkel recht', v_phase),
    v_mis = '' AND proof.function_set() = proof.snap_get('mut.functions'),
    format('afwijkend: %s', COALESCE(NULLIF(v_mis, ''), 'niets')));

  PERFORM proof.record(v_phase || '4',
    format('%s: de gewijzigde functie draagt de blokkadetoets nog — de weigering kwam dus uitsluitend van de hashtoets', v_phase),
    proof.src(v_mutated) LIKE '%assert_posting_allowed(%' OR v_mutated = 'bank_bulk_posting_candidates');
END $$;
