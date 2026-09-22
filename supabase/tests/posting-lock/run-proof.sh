#!/usr/bin/env bash
# Real-PostgreSQL proof for 6C-b11 PR C — de boekingsblokkade
# (20260927120000_add_posting_lock_foundation.sql).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — triggers, privileges,
# RLS, atomicity and the independence of two controls — cannot be observed from
# TypeScript.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/posting-lock/run-proof.sh
#
# The whole year-close stack is applied first, INCLUDING PR A and PR B, so the
# proof can show the two controls side by side: a fiscal year that is closed
# while no posting lock exists, and a posting lock that moves without touching
# the fiscal year at all. That independence is the point of PR C.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${PL_PROOF_DB:-plproof}"
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
run -f "$MIG/20260925120000_add_fiscal_year_lifecycle_events.sql"          > /dev/null
run -f "$MIG/20260926120000_close_writes_fiscal_year_event.sql"            > /dev/null

run -f "$HERE/../year-close/fixtures.sql"                                  > /dev/null

# De wereld zoals zij vandaag is, met afgesloten boekjaren en al. Nu pas de
# migratie onder test — zodat het ontbreken van een backfill echt iets zegt.
run -f "$HERE/seed.sql"                                                    > /dev/null
run -f "$MIG/20260927120000_add_posting_lock_foundation.sql"               > /dev/null

# Idempotency: de migratie moet een tweede toepassing ongeschonden overleven.
run -f "$MIG/20260927120000_add_posting_lock_foundation.sql"               > /dev/null

run -f "$HERE/proof.sql"                               > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 90) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
