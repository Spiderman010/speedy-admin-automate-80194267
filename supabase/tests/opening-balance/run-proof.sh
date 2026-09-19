#!/usr/bin/env bash
# Real-PostgreSQL proof for 6C-b8 PR 1 (opening balance schema, writer, invariants).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and this proof deliberately needs a real one.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/opening-balance/run-proof.sh
#
# It applies, in order:
#   bootstrap.sql                                   test double of the prerequisites
#   supabase/migrations/20260914120000_...sql       the REAL ledger foundation (6C-b2)
#   supabase/migrations/20260919120000_...sql       the REAL migration under test
#   supabase/migrations/20260920130000_...sql       the write-boundary hardening,
#                                                   part of the schema since
#                                                   6C-b9 voorwerk — applied here
#                                                   so this suite proves the
#                                                   invariants still hold WITH the
#                                                   direct-insert door closed
#   proof.sql + concurrency.sql                     the proofs
# and prints one line per numbered proof plus a summary.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${OB_PROOF_DB:-obproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/bootstrap.sql"                                                        > /dev/null
run -f "$REPO/supabase/migrations/20260914120000_add_ledger_postings_foundation.sql" > /dev/null
run -f "$REPO/supabase/migrations/20260919120000_add_opening_balance_posting.sql"    > /dev/null

# Idempotency: the migration must survive a second application unchanged.
run -f "$REPO/supabase/migrations/20260919120000_add_opening_balance_posting.sql"    > /dev/null

run -f "$REPO/supabase/migrations/20260920130000_revoke_direct_ledger_insert.sql"    > /dev/null

run -f "$HERE/proof.sql"                                > /dev/null
run -v conn="$CONN" -f "$HERE/concurrency.sql"          > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 120) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
