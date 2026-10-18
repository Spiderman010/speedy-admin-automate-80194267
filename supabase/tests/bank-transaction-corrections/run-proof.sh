#!/usr/bin/env bash
# Real-PostgreSQL proof for Bankcorrecties v1.1 PR 1 (20261018120000):
# correction events, marker protection, the D12 release hold and the three
# correction RPCs, against the REAL writers and the real migration chain.
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — real writers, real
# locks, two genuinely concurrent sessions, faults after every step and at
# COMMIT, rollback and re-application — cannot be observed from TypeScript.
#
# Usage (with a local cluster already running; needs the dblink extension):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/bank-transaction-corrections/run-proof.sh
#
# Order:
#   ../opening-balance/bootstrap.sql                 roles, auth.uid(), organisations,
#                                                    clients, grootboekrekeningen
#   ../bank-direct-allocation-guard/bootstrap-sources.sql   pre-ledger application tables
#   the REAL migration chain 20260904120000 … 20261017120000 (incl. PR 0)
#   fixtures.sql            users, roles, chart of accounts, helpers, fault switches
#   pre.sql                 NEGATIVE CONTROL: without PR 1 a posted bank line is stuck,
#                           and the owner can drop or rewrite a marker without lineage
#   snapshot.sql            baseline of data and catalogue
#   20261018120000 (TWICE)  the migration under test, idempotent
#   proof.sql               K1–K3, K6–K11 and the invariants per scenario
#   faults.sql              K5: a fault after every step and at COMMIT changes nothing
#   order.sql               the exact order of mutations and locks
#   concurrency.sql         K4 + K11 races with two real sessions
#   ROLLBACK block (TWICE) + rollback.sql   functional rollback, history kept
#   20261018120000 + final.sql              re-applied; global invariants
#
# Mutation testing: point CORR_MIGRATION at a modified copy of the migration;
# the proofs that depend on the removed protection must then fail.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${CORR_PROOF_DB:-corrproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
M="${CORR_MIGRATION:-$MIG/20261018120000_add_bank_transaction_corrections.sql}"

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/../opening-balance/bootstrap.sql"                                    > /dev/null
run -f "$HERE/../bank-direct-allocation-guard/bootstrap-sources.sql"               > /dev/null

for f in \
  20260904120000_add-accounting-foundation-ledger-links \
  20260914120000_add_ledger_postings_foundation \
  20260915120000_add_client_vat_ledger_config \
  20260915140000_add_purchase_ledger_posting \
  20260915160000_add_sales_ledger_posting \
  20260916120000_add_client_bank_ledger_config \
  20260917120000_add_bank_settlement_posting \
  20260918120000_add_manual_journal_posting \
  20260919120000_add_opening_balance_posting \
  20260920130000_revoke_direct_ledger_insert \
  20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39 \
  20260921120000_add_ledger_reversal_posting \
  20260921140000_harden_bank_transaction_posting \
  20260922120000_add_bank_bulk_posting \
  20260924120000_add_year_close_writer \
  20260925120000_add_fiscal_year_lifecycle_events \
  20260926120000_close_writes_fiscal_year_event \
  20260927120000_add_posting_lock_foundation \
  20260928120000_enforce_posting_lock \
  20260929120000_harden_internal_function_acls \
  20261001120000_add_fiscal_year_reopen \
  20261002120000_decouple_year_watermark_from_posting \
  20261010120000_add_bank_match_rejections \
  20261017120000_guard_direct_bank_posting_against_allocations
do
  run -f "$MIG/$f.sql"                                                             > /dev/null
done

run -f "$HERE/fixtures.sql"                                                        > /dev/null

# Negatieve controle: zonder PR 1.
run -f "$HERE/pre.sql"                                                             > /dev/null
run -f "$HERE/snapshot.sql"                                                        > /dev/null

# De migratie onder test, TWEE keer: zij moet een tweede toepassing overleven.
run -f "$M"                                                                        > /dev/null
run -f "$M"                                                                        > /dev/null

run -f "$HERE/proof.sql"                                                           > /dev/null
run -v conn="$CONN" -f "$HERE/faults.sql"                                          > /dev/null
run -v conn="$CONN" -f "$HERE/order.sql"                                           > /dev/null
run -v conn="$CONN" -f "$HERE/concurrency.sql"                                     > /dev/null

# De gedocumenteerde ROLLBACK, letterlijk uit de kop, TWEE keer.
run -c "INSERT INTO proof.state VALUES ('digest_before_rollback', proof.digest());" > /dev/null
ROLLBACK="$(sed -n '/^-- ROLLBACK-BEGIN$/,/^-- ROLLBACK-END$/p' "$M" | grep -v '^-- ROLLBACK-' | sed 's/^-- \{0,1\}//')"
[ -n "$ROLLBACK" ] || { echo "rollbackblok niet gevonden" >&2; exit 1; }
run -c "$ROLLBACK"                                                                 > /dev/null
run -c "$ROLLBACK"                                                                 > /dev/null
run -f "$HERE/rollback.sql"                                                        > /dev/null

# En weer vooruit.
run -f "$M"                                                                        > /dev/null
run -f "$HERE/final.sql"                                                           > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(coalesce(detail, ''), 110) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

# Elk verwacht bewijs moet er zijn: een bewijs dat stil wegvalt (bv. doordat
# een uitgestelde controle bij COMMIT de hele opdracht terugdraaide) is een FAIL.
MISSING=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n);")
if [ "$MISSING" != "0" ]; then
  psql -q -d "$DB" -t -A -c "SELECT 'ONTBREEKT: ' || n FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n) ORDER BY n;"
fi

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ] && [ "$MISSING" = "0" ]
