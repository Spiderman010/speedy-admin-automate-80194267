#!/usr/bin/env bash
# Real-PostgreSQL proof for 6C-b11 PR E — heropenen en opnieuw afsluiten
# (20261001120000_add_fiscal_year_reopen.sql).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/fiscal-year-reopen/run-proof.sh
#
# It applies the stack of ../posting-lock-enforced (foundation → PR D) plus
# the ACL hardening, then:
#   ../year-close/fixtures.sql, ../posting-lock-enforced/fixtures.sql
#   fixtures.sql            helpers + ERFENIS, created BEFORE the migration
#   20261001120000_...sql   the REAL migration under test, applied TWICE
#   proof.sql + concurrency.sql
# and prints one line per numbered proof plus a summary.
#
# PRE_E_ONLY=1 skips the migration and the proofs that need it: the negative
# control (the proofs must fail without PR E).

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${FYR_PROOF_DB:-fyrproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
T="$REPO/supabase/tests"

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$T/opening-balance/bootstrap.sql"                                   > /dev/null
run -f "$T/bank-transaction-posting/bootstrap-extra.sql"                    > /dev/null
run -f "$MIG/20260914120000_add_ledger_postings_foundation.sql"            > /dev/null
run -f "$MIG/20260918120000_add_manual_journal_posting.sql"                > /dev/null
run -f "$MIG/20260919120000_add_opening_balance_posting.sql"               > /dev/null
run -f "$MIG/20260920130000_revoke_direct_ledger_insert.sql"               > /dev/null
run -f "$MIG/20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39.sql"      > /dev/null
run -f "$MIG/20260921120000_add_ledger_reversal_posting.sql"               > /dev/null
run -f "$MIG/20260921140000_harden_bank_transaction_posting.sql"           > /dev/null
run -f "$MIG/20260922120000_add_bank_bulk_posting.sql"                     > /dev/null
run -f "$T/year-close/bootstrap-sources.sql"                                > /dev/null
run -f "$MIG/20260924120000_add_year_close_writer.sql"                     > /dev/null
run -f "$MIG/20260925120000_add_fiscal_year_lifecycle_events.sql"          > /dev/null
run -f "$MIG/20260926120000_close_writes_fiscal_year_event.sql"            > /dev/null
run -f "$MIG/20260927120000_add_posting_lock_foundation.sql"               > /dev/null
run -f "$MIG/20260928120000_enforce_posting_lock.sql"                      > /dev/null
run -f "$MIG/20260929120000_harden_internal_function_acls.sql"             > /dev/null

run -f "$T/year-close/fixtures.sql"                                         > /dev/null
run -f "$T/posting-lock-enforced/fixtures.sql"                              > /dev/null
run -f "$HERE/fixtures.sql"                                                 > /dev/null

if [ "${PRE_E_ONLY:-0}" != "1" ]; then
  # De migratie onder test, TWEE keer: zij moet een tweede toepassing overleven.
  run -f "$MIG/20261001120000_add_fiscal_year_reopen.sql"                  > /dev/null
  run -f "$MIG/20261001120000_add_fiscal_year_reopen.sql"                  > /dev/null
fi

# Zonder PR E breken de bewijzen af op de eerste aanroep van reopen_fiscal_year;
# ON_ERROR_STOP staat daarom hier uit, zodat de negatieve controle toch telt.
psql -q -v ON_ERROR_STOP="$([ "${PRE_E_ONLY:-0}" = "1" ] && echo 0 || echo 1)" -d "$DB" -f "$HERE/proof.sql" > /dev/null 2>&1 \
  || [ "${PRE_E_ONLY:-0}" = "1" ]
if [ "${PRE_E_ONLY:-0}" != "1" ]; then
  run -v conn="$CONN" -f "$HERE/concurrency.sql"                            > /dev/null
fi

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 110) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
