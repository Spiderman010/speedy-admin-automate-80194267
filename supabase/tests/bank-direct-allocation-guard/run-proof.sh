#!/usr/bin/env bash
# Real-PostgreSQL proof for PR 0: no double bank booking through a direct
# posting AND an invoice allocation (20261017120000).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — refusals by the real
# writers and guards, privileges, two genuinely concurrent sessions, rollback
# and re-application — cannot be observed from TypeScript.
#
# Usage (with a local cluster already running; needs the dblink extension):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/bank-direct-allocation-guard/run-proof.sh
#
# Order:
#   ../opening-balance/bootstrap.sql   shared test double: roles, auth.uid(),
#                                      organisations, clients, grootboekrekeningen
#   bootstrap-sources.sql              the pre-ledger application tables (no
#                                      stubs for markers, writers or triggers)
#   the REAL migration chain           20260904120000 … 20261010120000, incl. the
#                                      invoice writers, bank settlement, direct
#                                      bank posting, reversal engine, bulk and PR H
#   fixtures.sql                       users, roles, chart of accounts, helpers
#   pre.sql + concurrency-pre.sql      NEGATIVE CONTROL: without PR 0 the double
#                                      booking succeeds (also under concurrency)
#   snapshot.sql                       baseline of data and catalogue
#   20261017120000 (TWICE)             the migration under test, idempotent
#   proof.sql + concurrency.sql        the same attacks refused; scenarios 1–10;
#                                      races in both orders with two sessions
#   ROLLBACK block (TWICE) + rollback.sql   guards gone, gap back, data intact
#   20261017120000 + final.sql         re-applied; global invariants
#
# Mutation testing: point GUARD_MIGRATION at a modified copy of the migration;
# the proofs that depend on the removed protection must then fail.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${GUARD_PROOF_DB:-guardproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
M="${GUARD_MIGRATION:-$MIG/20261017120000_guard_direct_bank_posting_against_allocations.sql}"

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/../opening-balance/bootstrap.sql"                                    > /dev/null
run -f "$HERE/bootstrap-sources.sql"                                               > /dev/null

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
  20261010120000_add_bank_match_rejections
do
  run -f "$MIG/$f.sql"                                                             > /dev/null
done

run -f "$HERE/fixtures.sql"                                                        > /dev/null

# Negatieve controle: dezelfde aanvallen, zonder PR 0.
run -f "$HERE/pre.sql"                                                             > /dev/null
run -v conn="$CONN" -f "$HERE/concurrency-pre.sql"                                 > /dev/null
run -f "$HERE/snapshot.sql"                                                        > /dev/null

# De migratie onder test, TWEE keer: zij moet een tweede toepassing overleven.
run -f "$M"                                                                        > /dev/null
run -f "$M"                                                                        > /dev/null

run -f "$HERE/proof.sql"                                                           > /dev/null
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

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
