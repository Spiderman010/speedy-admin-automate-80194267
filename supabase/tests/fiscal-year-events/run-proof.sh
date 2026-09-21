#!/usr/bin/env bash
# Real-PostgreSQL proof for 6C-b11 PR A — de fundering van de boekjaarlevenscyclus
# (20260925120000_add_fiscal_year_lifecycle_events.sql).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — triggers, privileges,
# RLS, constraints and an actual backfill over actual rows — cannot be observed
# from TypeScript.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/fiscal-year-events/run-proof.sh
#
# THE ORDER MATTERS, and it is the point of this harness. The world is built up
# as production has it TODAY, real fiscal years are closed through the real
# writer, and only THEN is the migration under test applied — twice. That is the
# only way to prove that the backfill sees genuine rows and that a repeat run
# adds nothing.
#
#   ../opening-balance/bootstrap.sql            shared test double of the
#                                               prerequisites (roles, auth.uid(),
#                                               clients, grootboekrekeningen, …)
#   20260914120000_...sql   the REAL ledger foundation (6C-b2)
#   20260918120000_...sql   the REAL manual journal writer (6C-b6)
#   20260919120000_...sql   the REAL opening balance writer (6C-b8)
#   20260920130000_...sql   the REAL write-boundary hardening
#   ../year-close/bootstrap-sources.sql         source/marker table doubles
#   20260924120000_...sql   the REAL year close writer (6C-b10)
#   ../year-close/fixtures.sql                  orgs, users, roles, proof helpers
#   seed.sql                close three fiscal years through close_fiscal_year()
#   20260925120000_...sql   the migration UNDER TEST, applied TWICE
#   proof.sql
#
# and prints one line per numbered proof plus a summary.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${FYE_PROOF_DB:-fyeproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/../opening-balance/bootstrap.sql"                            > /dev/null
run -f "$MIG/20260914120000_add_ledger_postings_foundation.sql"            > /dev/null
run -f "$MIG/20260918120000_add_manual_journal_posting.sql"                > /dev/null
run -f "$MIG/20260919120000_add_opening_balance_posting.sql"               > /dev/null
run -f "$MIG/20260920130000_revoke_direct_ledger_insert.sql"               > /dev/null
run -f "$HERE/../year-close/bootstrap-sources.sql"                         > /dev/null
run -f "$MIG/20260924120000_add_year_close_writer.sql"                     > /dev/null

run -f "$HERE/../year-close/fixtures.sql"                                  > /dev/null
run -f "$HERE/seed.sql"                                                    > /dev/null

# The world as production has it today. Now migrate.
run -f "$MIG/20260925120000_add_fiscal_year_lifecycle_events.sql"          > /dev/null

# Idempotency: the migration — and its backfill — must survive a second
# application unchanged. This is the assertion that "it only runs once" is NOT
# what we are relying on.
run -f "$MIG/20260925120000_add_fiscal_year_lifecycle_events.sql"          > /dev/null

run -f "$HERE/proof.sql"                               > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 100) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
