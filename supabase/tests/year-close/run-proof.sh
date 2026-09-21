#!/usr/bin/env bash
# Real-PostgreSQL proof for 6C-b10 — de jaarafsluiting
# (20260924120000_add_year_close_writer.sql).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — triggers, privileges,
# atomicity and two genuinely concurrent sessions — cannot be observed from
# TypeScript.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/year-close/run-proof.sh
#
# It applies, in order:
#   ../opening-balance/bootstrap.sql            the shared test double of the
#                                               prerequisites (roles, auth.uid(),
#                                               clients, grootboekrekeningen, …)
#   20260914120000_...sql   the REAL ledger foundation (6C-b2)
#   20260918120000_...sql   the REAL manual journal writer (6C-b6)
#   20260919120000_...sql   the REAL opening balance writer (6C-b8)
#   20260920130000_...sql   the REAL write-boundary hardening
#   20260921120000_...sql   the REAL reversal engine (6C-b9), so proof 30 can
#                           show it is still there and still refuses a closed year
#   bootstrap-sources.sql   test doubles for the purchase/sales/bank source and
#                           marker tables the year close writer re-checks
#   20260924120000_...sql   the REAL migration under test, applied TWICE
#   fixtures.sql + proof.sql + concurrency.sql
# and prints one line per numbered proof plus a summary.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${YC_PROOF_DB:-ycproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/../opening-balance/bootstrap.sql"                            > /dev/null
run -f "$MIG/20260914120000_add_ledger_postings_foundation.sql"            > /dev/null
run -f "$MIG/20260918120000_add_manual_journal_posting.sql"                > /dev/null
run -f "$MIG/20260919120000_add_opening_balance_posting.sql"               > /dev/null
run -f "$MIG/20260920130000_revoke_direct_ledger_insert.sql"               > /dev/null
run -f "$MIG/20260921120000_add_ledger_reversal_posting.sql"              > /dev/null
run -f "$HERE/bootstrap-sources.sql"                                       > /dev/null
run -f "$MIG/20260924120000_add_year_close_writer.sql"                     > /dev/null

# Idempotency: the migration must survive a second application unchanged.
run -f "$MIG/20260924120000_add_year_close_writer.sql"                     > /dev/null

run -f "$HERE/fixtures.sql"                            > /dev/null
run -f "$HERE/proof.sql"                               > /dev/null
run -v conn="$CONN" -f "$HERE/concurrency.sql"         > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 110) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
