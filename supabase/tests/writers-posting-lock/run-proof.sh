#!/usr/bin/env bash
# Real-PostgreSQL proof for 6C-b11 PR D — de schrijvers toetsen de blokkade
# (20260928120000_writers_respect_posting_lock.sql).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — seven writers, a bulk
# preflight, and two genuinely concurrent sessions racing a lock change against
# a posting — cannot be observed from TypeScript.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/writers-posting-lock/run-proof.sh
#
# This harness applies the WHOLE posting stack, because PR D touches all of it:
# purchase, sales, bank settlement, bank transaction (hardened), manual journal,
# opening balance, reversal and the bulk orchestration — then the lifecycle
# migrations, then the migration under test, twice.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${WPL_PROOF_DB:-wplproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/../opening-balance/bootstrap.sql"                            > /dev/null
run -f "$HERE/bootstrap-sources.sql"                                       > /dev/null
run -f "$MIG/20260914120000_add_ledger_postings_foundation.sql"            > /dev/null
run -f "$MIG/20260915120000_add_client_vat_ledger_config.sql"              > /dev/null
run -f "$MIG/20260915140000_add_purchase_ledger_posting.sql"               > /dev/null
run -f "$MIG/20260915160000_add_sales_ledger_posting.sql"                  > /dev/null
run -f "$MIG/20260916120000_add_client_bank_ledger_config.sql"             > /dev/null
run -f "$MIG/20260917120000_add_bank_settlement_posting.sql"               > /dev/null
run -f "$MIG/20260918120000_add_manual_journal_posting.sql"                > /dev/null
run -f "$MIG/20260919120000_add_opening_balance_posting.sql"               > /dev/null
run -f "$MIG/20260920130000_revoke_direct_ledger_insert.sql"               > /dev/null
run -f "$MIG/20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39.sql"      > /dev/null
run -f "$MIG/20260921120000_add_ledger_reversal_posting.sql"               > /dev/null
run -f "$MIG/20260921140000_harden_bank_transaction_posting.sql"           > /dev/null
run -f "$MIG/20260922120000_add_bank_bulk_posting.sql"                     > /dev/null
run -f "$MIG/20260924120000_add_year_close_writer.sql"                     > /dev/null
run -f "$MIG/20260925120000_add_fiscal_year_lifecycle_events.sql"          > /dev/null
run -f "$MIG/20260926120000_close_writes_fiscal_year_event.sql"            > /dev/null
run -f "$MIG/20260927120000_add_posting_lock_foundation.sql"               > /dev/null

run -f "$MIG/20260928120000_writers_respect_posting_lock.sql"              > /dev/null
# Idempotency: herdefinities moeten een tweede toepassing overleven.
run -f "$MIG/20260928120000_writers_respect_posting_lock.sql"              > /dev/null

run -f "$HERE/fixtures.sql"                            > /dev/null
run -f "$HERE/proof.sql"                               > /dev/null
run -v conn="$CONN" -f "$HERE/concurrency.sql"         > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 88) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
