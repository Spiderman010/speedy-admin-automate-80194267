#!/usr/bin/env bash
# Real-PostgreSQL proof for herstelpakket P6 (A2-04): what does the REAL
# post_purchase_invoice() put in the ledger for the invoices the SnelStart
# export now writes per boekingsregel?
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: the vitest job has no PostgreSQL. What the real writer books is
# captured in the committed fixture src/test/fixtures/snelstart-export-ledger.json,
# which src/test/snelstart-export-ledger.test.ts lays next to the export.
#
# Proof 5.1 compares the freshly generated ledger with that committed fixture,
# so a changed post_purchase_invoice() turns this harness red instead of
# leaving a stale fixture behind. After an intended writer change: run with
# LEDGER_FIXTURE_UPDATE=1, review the fixture diff and the comparison test,
# and commit both.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/snelstart-export-ledger/run-proof.sh
#   LEDGER_FIXTURE_UPDATE=1 PGHOST=… supabase/tests/snelstart-export-ledger/run-proof.sh
#
# Order:
#   ../opening-balance/bootstrap.sql                 shared test double: roles,
#                                                    auth.uid(), organisations,
#                                                    clients, grootboekrekeningen
#   ../bank-direct-allocation-guard/bootstrap-sources.sql
#                                                    the pre-ledger application
#                                                    tables (no stubs for markers,
#                                                    writers or triggers)
#   the REAL migration chain                         20260904120000 … 20261010120000,
#                                                    incl. the last definition of
#                                                    post_purchase_invoice (20261002120000)
#   fixtures.sql                                     users, roles, accounts, invoices S1–S8
#   proof.sql                                        numbered proofs: role and tenant
#                                                    refusals, postings, refusals,
#                                                    ledger content
#   export.sql                                       source rows + ledger rows → JSON
#
# Known test-double deviation (nulmeting F1b-N2): bootstrap-sources.sql adds an
# FK purchase_invoice_lines → purchase_invoices that production does not have.
# It does not affect what the writer posts.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${LEDGER_PROOF_DB:-snelstartledgerproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
FIXTURE="$REPO/src/test/fixtures/snelstart-export-ledger.json"

: "${PGHOST:?set PGHOST}"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/../opening-balance/bootstrap.sql"                          > /dev/null
run -f "$HERE/../bank-direct-allocation-guard/bootstrap-sources.sql"     > /dev/null

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
  run -f "$MIG/$f.sql"                                                   > /dev/null
done

# Geen latere migratie herdefinieert post_purchase_invoice(); toets dat, zodat
# deze vergelijking niet stil een oude schrijver bewijst.
LATER="$(grep -l -i -E 'CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?FUNCTION[[:space:]]+(public\.)?post_purchase_invoice[[:space:]]*\(' "$MIG"/*.sql \
  | xargs -n1 basename | sort | tail -1)"
[ "$LATER" = "20261002120000_decouple_year_watermark_from_posting.sql" ] || {
  echo "post_purchase_invoice() is later herdefinieerd in $LATER: werk de keten van dit harnas bij" >&2; exit 1; }

run -f "$HERE/fixtures.sql"                                              > /dev/null
run -f "$HERE/proof.sql"                                                 > /dev/null

# ── 5. De vastgelegde fixture is precies wat de echte schrijver nu boekt ─────
GEN="$(mktemp "${TMPDIR:-/tmp}/snelstart-export-ledger.XXXXXX")"
trap 'rm -f "$GEN"' EXIT
run -v out="$GEN" -f "$HERE/export.sql"                                  > /dev/null
if [ "${LEDGER_FIXTURE_UPDATE:-0}" = "1" ]; then
  mkdir -p "$(dirname "$FIXTURE")"
  cp "$GEN" "$FIXTURE"
  echo "fixture bijgewerkt: $FIXTURE (controleer de diff en src/test/snelstart-export-ledger.test.ts)"
fi
if [ -f "$FIXTURE" ] && cmp -s "$GEN" "$FIXTURE"; then
  run -c "INSERT INTO proof.result VALUES ('5.1', 'de vastgelegde fixture is precies wat de echte schrijver nu boekt', true, NULL);" > /dev/null
else
  run -c "INSERT INTO proof.result VALUES ('5.1', 'de vastgelegde fixture is precies wat de echte schrijver nu boekt', false, 'verschil met src/test/fixtures/snelstart-export-ledger.json: draai met LEDGER_FIXTURE_UPDATE=1');" > /dev/null
fi

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(coalesce(detail, ''), 110) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
