#!/usr/bin/env bash
# Real-PostgreSQL proof for 20261010120000_add_bank_match_rejections.sql.
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and RLS and grants can only be observed by a real
# server under a real `SET ROLE`.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGUSER=postgres \
#     supabase/tests/bank-match-rejections/run-proof.sh
#
# Order:
#   ../opening-balance/bootstrap.sql                roles, auth.uid(), has_min_role, clients
#   ../bank-transaction-posting/bootstrap-extra.sql bank_transactions + allocations (real shape)
#   20260914120000 (REAL)                           ledger_postings, to prove it is untouched
#   bootstrap-sources.sql                           invoice doubles + allocation read policy
#   ../year-close/fixtures.sql                      organisations, users, roles, proof helpers
#   fixtures.sql                                    transactions, invoices, allocation, ledger group, snapshot
#   20261010120000 (REAL)                           the migration under test, applied TWICE
#   proof.sql                                       S1-S7, A1-A18, B1-B6, R1-R7, U1-U3, N1-N8, C1
#   the ROLLBACK block from the migration header    applied TWICE, then checked

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${BMR_PROOF_DB:-bmrproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
T="$REPO/supabase/tests"
M="${BMR_MIGRATION:-$MIG/20261010120000_add_bank_match_rejections.sql}"   # alleen voor de negatieve controle overschrijven

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$T/opening-balance/bootstrap.sql"                          > /dev/null
run -f "$T/bank-transaction-posting/bootstrap-extra.sql"           > /dev/null
run -f "$MIG/20260914120000_add_ledger_postings_foundation.sql"    > /dev/null
run -f "$HERE/bootstrap-sources.sql"                               > /dev/null
run -f "$T/year-close/fixtures.sql"                                > /dev/null
run -f "$HERE/fixtures.sql"                                        > /dev/null

# De migratie onder test, TWEE keer: zij moet een tweede toepassing overleven.
run -f "$M"                                                        > /dev/null
run -f "$M"                                                        > /dev/null

run -f "$HERE/proof.sql"                                           > /dev/null

# De gedocumenteerde ROLLBACK, letterlijk uit de kop, TWEE keer.
ROLLBACK="$(sed -n '/^-- ROLLBACK-BEGIN$/,/^-- ROLLBACK-END$/p' "$M" | grep -v '^-- ROLLBACK-' | sed 's/^-- \{0,1\}//')"
[ -n "$ROLLBACK" ] || { echo "rollbackblok niet gevonden" >&2; exit 1; }
run -c "$ROLLBACK" > /dev/null
run -c "$ROLLBACK" > /dev/null
run -c "
  SELECT proof.expect_true('X1', 'rollback: tabel en triggerfunctie zijn weg',
    \$\$to_regclass('public.bank_match_rejections') IS NULL
      AND to_regprocedure('public.enforce_bank_match_rejection_scope()') IS NULL\$\$);
  SELECT proof.expect_true('X2', 'rollback: bank_transactions, afletteringen, facturen en grootboek bestaan nog',
    \$\$to_regclass('public.bank_transactions') IS NOT NULL AND to_regclass('public.bank_transaction_allocations') IS NOT NULL
      AND to_regclass('public.purchase_invoices') IS NOT NULL AND to_regclass('public.sales_invoices') IS NOT NULL
      AND to_regclass('public.ledger_postings') IS NOT NULL\$\$);" > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 110) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
