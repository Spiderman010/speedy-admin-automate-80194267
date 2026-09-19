#!/usr/bin/env bash
# Real-PostgreSQL proof for the ledger write boundary
# (20260920130000_revoke_direct_ledger_insert.sql).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and this proof deliberately needs a real one,
# because the claim under test ("authenticated cannot write to the ledger") is
# a statement about PostgreSQL privileges, not about TypeScript.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/ledger-write-boundary/run-proof.sh
#
# It applies, in order:
#   ../opening-balance/bootstrap.sql            the shared test double of the
#                                               prerequisites (roles, auth.uid(),
#                                               clients, grootboekrekeningen, …)
#   supabase/migrations/20260914120000_...sql   the REAL ledger foundation (6C-b2)
#   supabase/migrations/20260919120000_...sql   a REAL writer, so the proof can
#                                               post end-to-end
#   supabase/migrations/20260920130000_...sql   the REAL migration under test
#   fixtures.sql + proof.sql                    stamgegevens and the proofs
# and prints one line per numbered proof plus a summary.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${LWB_PROOF_DB:-lwbproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/../opening-balance/bootstrap.sql"                                      > /dev/null
run -f "$REPO/supabase/migrations/20260914120000_add_ledger_postings_foundation.sql"  > /dev/null
run -f "$REPO/supabase/migrations/20260919120000_add_opening_balance_posting.sql"     > /dev/null
run -f "$REPO/supabase/migrations/20260920130000_revoke_direct_ledger_insert.sql"     > /dev/null
run -f "$REPO/supabase/migrations/20260921120000_add_ledger_reversal_posting.sql"     > /dev/null

# Idempotency: the migration must survive a second application unchanged.
run -f "$REPO/supabase/migrations/20260920130000_revoke_direct_ledger_insert.sql"     > /dev/null

run -f "$HERE/fixtures.sql" > /dev/null
run -f "$HERE/proof.sql"    > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 120) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
