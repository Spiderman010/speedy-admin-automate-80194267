#!/usr/bin/env bash
# Real-PostgreSQL proof for 6C-b11 PR B — de afsluiting schrijft haar gebeurtenis
# (20260926120000_close_writes_fiscal_year_event.sql).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — one shared timestamp,
# transactional rollback, privileges and exact row counts — cannot be observed
# from TypeScript.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/close-writes-event/run-proof.sh
#
# The world is built up exactly as production has it, INCLUDING PR A: three
# fiscal years are closed through the OLD writer first, so there are genuine
# backfilled events to leave alone, and only then is the migration under test
# applied — twice.
#
#   ../opening-balance/bootstrap.sql            prerequisites test double
#   20260914120000 / 20260918120000 /
#   20260919120000 / 20260920130000             the REAL ledger stack
#   ../year-close/bootstrap-sources.sql         source/marker table doubles
#   20260924120000                              the REAL year close writer (6C-b10)
#   ../year-close/fixtures.sql                  orgs, users, roles, proof helpers
#   ../fiscal-year-events/seed.sql              closes under the OLD writer
#   20260925120000                              PR A: events table + backfill
#   20260926120000                              the migration UNDER TEST, TWICE
#   proof.sql

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${CWE_PROOF_DB:-cweproof}"
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
# Sluit drie boekjaren af met de OUDE schrijver: die afsluitingen horen straks
# een gebackfilde gebeurtenis te krijgen, en die mag PR B niet aanraken.
run -f "$HERE/../fiscal-year-events/seed.sql"                              > /dev/null

run -f "$MIG/20260925120000_add_fiscal_year_lifecycle_events.sql"          > /dev/null
run -f "$MIG/20260926120000_close_writes_fiscal_year_event.sql"            > /dev/null

# Idempotency: de migratie herdefinieert een functie en moet een tweede
# toepassing ongeschonden overleven.
run -f "$MIG/20260926120000_close_writes_fiscal_year_event.sql"            > /dev/null

run -f "$HERE/proof.sql"                               > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 95) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
