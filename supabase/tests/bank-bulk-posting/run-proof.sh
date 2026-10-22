#!/usr/bin/env bash
# Real-PostgreSQL proof for the bank bulk layer
# (20260922120000, on top of 20260920195805 + 20260921140000).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of
# `npm run test`: CI has no PostgreSQL, and what is claimed here — per-row
# isolation of a partial failure, exact ledger lines, privileges, error
# identity and two genuinely concurrent sessions — cannot be observed from
# TypeScript.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/bank-bulk-posting/run-proof.sh
#
# It applies, in order:
#   ../opening-balance/bootstrap.sql            roles, auth.uid(), clients, accounts
#   ../bank-transaction-posting/bootstrap-extra.sql
#                                               bank_transactions, afletteringen, RLS
#   20260914120000_...sql                       the REAL ledger foundation (6C-b2)
#   20260920130000_...sql                       the REAL write-boundary hardening
#   20260920195805_...sql                       the REAL deployed bank writer
#   20260921140000_...sql                       the REAL corrective hardening
#   20260922120000_...sql                       the migration under test, TWICE
#   ../bank-transaction-posting/fixtures.sql    organisaties, gebruikers, rekeningen
#   helpers.sql + proof.sql + concurrency.sql
# and then, in a SECOND database (phase 2), the bulk layer as it is NOW:
#   ../writer-vat-nan-validation/build-chain.sh   the real chain … 20261020120000
#   ../writer-vat-nan-validation/helpers.sql
#   20261021170000_...sql                       btw- en NaN-validatie (E-06)
#   proof-p4.sql                                the stronger replacement of the
#                                               old NULL-means-no-VAT seeds
# and prints one line per numbered proof plus a summary per database.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${BBP_PROOF_DB:-bbpproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
BTP="$HERE/../bank-transaction-posting"

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/../opening-balance/bootstrap.sql"                       > /dev/null
run -f "$BTP/bootstrap-extra.sql"                                     > /dev/null
run -f "$MIG/20260914120000_add_ledger_postings_foundation.sql"       > /dev/null
run -f "$MIG/20260920130000_revoke_direct_ledger_insert.sql"          > /dev/null
run -f "$MIG/20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39.sql" > /dev/null
run -f "$MIG/20260921140000_harden_bank_transaction_posting.sql"      > /dev/null
run -f "$MIG/20260922120000_add_bank_bulk_posting.sql"                > /dev/null

# Idempotency: the new migration must survive a second application.
run -f "$MIG/20260922120000_add_bank_bulk_posting.sql"                > /dev/null

run -f "$BTP/fixtures.sql"                             > /dev/null
run -f "$HERE/helpers.sql"                             > /dev/null
run -f "$HERE/proof.sql"                               > /dev/null
run -v conn="$CONN" -f "$HERE/concurrency.sql"         > /dev/null

# ── fase 2: de bulklaag van NU, op de volledige keten ───────────────────────
DB2="${DB}_p4"
P4H="$HERE/../writer-vat-nan-validation"
"$P4H/build-chain.sh" "$DB2"
psql -q -v ON_ERROR_STOP=1 -d "$DB2" -f "$P4H/helpers.sql"                                           > /dev/null
psql -q -v ON_ERROR_STOP=1 -d "$DB2" -f "$MIG/20261021170000_btw_en_nan_validatie_in_schrijvers.sql" > /dev/null
psql -q -v ON_ERROR_STOP=1 -d "$DB2" -f "$HERE/proof-p4.sql"                                         > /dev/null

FAILED=0
for d in "$DB" "$DB2"; do
  echo "═══ $d"
  psql -q -d "$d" -P pager=off -c "
    SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 110) AS detail
    FROM proof.result ORDER BY ok, n;"
  psql -q -d "$d" -t -c "
    SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"
  F=$(psql -q -d "$d" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
  FAILED=$((FAILED + F))
done
# Fase 2 kondigt haar bewijzen aan (proof.plan): een bewijs dat stil wegvalt is een FAIL.
M2=$(psql -q -d "$DB2" -t -A -c "SELECT count(*) FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n);")
[ "$M2" = "0" ] || psql -q -d "$DB2" -t -A -c "SELECT 'ONTBREEKT: ' || n FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n);"
[ "$FAILED" = "0" ] && [ "$M2" = "0" ]
