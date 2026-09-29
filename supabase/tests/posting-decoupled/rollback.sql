-- REAL POSTGRESQL PROOF for 6C-b11 PR H — deel 3, NA de terugdraai.
-- Run against a THROWAWAY local cluster only. See run-proof.sh.
--
-- run-proof.sh heeft zojuist 20260928120000_enforce_posting_lock.sql opnieuw
-- toegepast. Dat is de gedocumenteerde rollback, en die moet EXACT de vorige
-- lichamen teruggeven, zonder één recht of eigenaar te verplaatsen.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

DO $$
DECLARE
  v_naam text;
  v_mis  text := '';
BEGIN
  FOREACH v_naam IN ARRAY proof.changed_functions() || proof.untouched_functions() LOOP
    IF proof.hash(v_naam) IS DISTINCT FROM proof.snap_get('pre.hash.' || v_naam) THEN
      v_mis := v_mis || v_naam || ' ';
    END IF;
    IF proof.acl(v_naam) IS DISTINCT FROM proof.snap_get('pre.acl.' || v_naam) THEN
      v_mis := v_mis || v_naam || '(acl) ';
    END IF;
  END LOOP;
  PERFORM proof.record('R1', 'ROLLBACK: 20260928120000 opnieuw toepassen geeft exact de vorige lichamen én rechten terug',
    v_mis = '', format('afwijkend: %s', COALESCE(NULLIF(v_mis, ''), 'niets')));

  PERFORM proof.record('R2', 'en na de rollback is de functieverzameling weer die van vóór de migratie',
    proof.function_set() = proof.snap_get('pre.functions'));
END $$;
