#!/usr/bin/env bash
# Real-PostgreSQL proof for the direct bank posting writer
# (20260920195805 + the corrective hardening 20260921140000).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — exact ledger lines,
# privileges, error identity, atomicity and two genuinely concurrent sessions —
# cannot be observed from TypeScript.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/bank-transaction-posting/run-proof.sh
#
# It applies, in order:
#   ../opening-balance/bootstrap.sql   the shared test double of the
#                                      prerequisites (roles, auth.uid(),
#                                      clients, grootboekrekeningen, …)
#   bootstrap-extra.sql                bank_transactions, de afletteringstabellen
#                                      en de clientconfiguratie
#   20260914120000_...sql              the REAL ledger foundation (6C-b2)
#   20260920130000_...sql              the REAL write-boundary hardening
#   20260920195805_...sql              the REAL deployed bank writer (untouched)
#   20260921140000_...sql              the REAL corrective migration, TWICE
#   fixtures.sql + proof.sql + concurrency.sql
# and prints one line per numbered proof plus a summary.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${BTP_PROOF_DB:-btpproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/../opening-balance/bootstrap.sql"                      > /dev/null
run -f "$HERE/bootstrap-extra.sql"                                   > /dev/null
run -f "$MIG/20260914120000_add_ledger_postings_foundation.sql"      > /dev/null
run -f "$MIG/20260920130000_revoke_direct_ledger_insert.sql"         > /dev/null
run -f "$MIG/20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39.sql" > /dev/null
run -f "$MIG/20260921140000_harden_bank_transaction_posting.sql"     > /dev/null

# Idempotency: the corrective migration must survive a second application.
run -f "$MIG/20260921140000_harden_bank_transaction_posting.sql"     > /dev/null

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
