#!/usr/bin/env bash
# Real-PostgreSQL proof for Balans/W&V PR 1 (reporting classification schema).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and this proof deliberately needs a real one.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/reporting-classification/run-proof.sh
#
# It applies, in order:
#   bootstrap.sql                                   test double of the prerequisites
#   supabase/migrations/20260412222343_...sql       the REAL chart-of-accounts migration
#   shape.sql                                       every later production change on the table, verbatim
#   pre.sql                                         "existing" rows + snapshot
#   supabase/migrations/20260920120000_...sql       the REAL migration under test — applied TWICE
#   proof.sql                                       the proofs
# and prints one line per numbered proof plus a summary.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${RC_PROOF_DB:-rcproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/bootstrap.sql"                                                                  > /dev/null
run -f "$REPO/supabase/migrations/20260412222343_b9d16193-0605-43a9-9fbf-ba324ff5b1de.sql"   > /dev/null
run -f "$HERE/shape.sql"                                                                     > /dev/null
run -f "$HERE/pre.sql"                                                                       > /dev/null

run -f "$REPO/supabase/migrations/20260920120000_add_reporting_classification.sql"           > /dev/null
# Idempotency: the migration must survive a second application unchanged.
run -f "$REPO/supabase/migrations/20260920120000_add_reporting_classification.sql"           > /dev/null

run -f "$HERE/proof.sql"                                                                     > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 120) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
