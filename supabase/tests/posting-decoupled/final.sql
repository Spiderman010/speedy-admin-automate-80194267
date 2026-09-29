-- REAL POSTGRESQL PROOF for 6C-b11 PR H — deel 4, na het OPNIEUW toepassen.
-- Run against a THROWAWAY local cluster only. See run-proof.sh.
--
-- Na de rollback is de migratie opnieuw toegepast: de lichamen moeten weer
-- exact die van deel 2 zijn. Daarmee is de migratie in beide richtingen
-- deterministisch. Tot slot de hashes voor de productie-handoff.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;

DO $$
DECLARE
  v_naam text;
  v_mis  text := '';
BEGIN
  FOREACH v_naam IN ARRAY proof.changed_functions() || proof.untouched_functions() LOOP
    IF proof.hash(v_naam) IS DISTINCT FROM proof.snap_get('post.hash.' || v_naam) THEN
      v_mis := v_mis || v_naam || ' ';
    END IF;
  END LOOP;
  PERFORM proof.record('R3', 'opnieuw toepassen na de rollback geeft exact de lichamen van deel 2 terug',
    v_mis = '', format('afwijkend: %s', COALESCE(NULLIF(v_mis, ''), 'niets')));
END $$;

\set QUIET off
\pset pager off
\echo
\echo '── Functiehashes (md5(prosrc)) voor de productie-handoff ──'
SELECT k AS functie,
       proof.snap_get('pre.hash.' || k)  AS hash_voor_20261002120000,
       proof.snap_get('post.hash.' || k) AS hash_na_20261002120000
FROM unnest(proof.changed_functions() || proof.untouched_functions()) AS k
ORDER BY k;
