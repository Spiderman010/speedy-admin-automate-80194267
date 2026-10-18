#!/usr/bin/env bash
# Real-PostgreSQL proof for 20261018180000: the D12 release hold also covers a
# bank line with a proven pre-PR-1 history (booked, manually reversed on the
# transaction date, marker removed, booked again) — while every unexplained
# group keeps the PR 1 behaviour and the rollout checks STOP on it. Against the
# REAL writers and the real migration chain incl. PR 0, PR 1 and PR 2.
#
# THROWAWAY DATABASES ONLY. This script CREATEs and DROPs databases. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL.
#
# Usage (with a local cluster already running; needs the dblink extension and
# git, for the original PRE 4 of main 3669a94):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/bank-release-hold-history/run-proof.sh
#
# Database 1 (hold-fix proofs):
#   bootstrap, the REAL chain … 20261017120000 (PR 0), the real trigger bodies,
#   ../bank-transaction-corrections/fixtures.sql (PR 1), ../bank-correction-booking-description/helpers.sql (PR 2)
#   helpers.sql             history builders, forging of corrupt history, app paths
#   history.sql             history of BEFORE PR 1 with the real writers: 9 proven
#                           historical reversals, 11 corrupt groups, 2 plain lines
#   pre.sql                 P: the rollout checks before PR 1, literally (PRE 4, PRE 4b, PRE B6)
#   20261018120000 (PR 1) + 20261018150000 (PR 2)
#   gap.sql                 N: NEGATIVE CONTROL — without the fix a released historical line can be re-booked
#   snapshot.sql            baseline of catalogue and data
#   20261018180000 (TWICE)  the migration under test, idempotent
#   proof.sql               catalogue, prerequisite check, helper verdicts, POST 8/POST C literally, D12
#   corrections.sql         regular corrections (S1–S3, unchanged) on historical and plain lines
#   concurrency.sql         races with two real sessions
#   window.sql              rollback fix → PR 2 → PR 1, booking in the window, re-apply all three (F2, (8))
#   final.sql               global invariants
# Database 2 (sequential order, production-like history): POST 8 per state.
# Database 3 (the atomic production plan, production-like history with the
#   known group ids): every PRE and POST block literally, one execution of
#   M1+M2+M3, failure atomicity and invisibility of the intermediate state.
#
# Mutation testing: point HOLD_FIX_MIGRATION at a modified copy of the migration
# (and HOLD_FIX_ROLLBACK at a rollback.sql whose guard accepts the mutant's body).

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${HOLD_FIX_PROOF_DB:-holdfixproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
PR1="$MIG/20261018120000_add_bank_transaction_corrections.sql"
PR2="$MIG/20261018150000_keep_bank_description_on_correction.sql"
M="${HOLD_FIX_MIGRATION:-$MIG/20261018180000_refine_release_hold_for_settled_history.sql}"
R1="$REPO/supabase/rollout/20261018120000_add_bank_transaction_corrections"
R2="$REPO/supabase/rollout/20261018150000_keep_bank_description_on_correction"
R3="$REPO/supabase/rollout/20261018180000_refine_release_hold_for_settled_history"
RB="${HOLD_FIX_ROLLBACK:-$R3/rollback.sql}"

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

# Eén blok uit een rolloutbestand, letterlijk: van de kopregel die met _kop
# begint tot en met de eerste regel (geen commentaar) die op ';' eindigt.
block() {
  local out
  out="$(awk -v h="$2" 'index($0, h) == 1 { f = 1 } f { print } f && !/^--/ && /;[[:space:]]*$/ { exit }' "$1")"
  [ -n "$out" ] || { echo "blok '$2' niet gevonden in $1" >&2; exit 1; }
  printf '%s\n' "$out"
}

# De keten tot en met PR 0, de echte triggerlichamen, de fixtures van PR 1 en PR 2.
build() {
  local db="$1"
  psql -q -c "DROP DATABASE IF EXISTS $db;" -c "CREATE DATABASE $db;" postgres >/dev/null
  psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$HERE/../opening-balance/bootstrap.sql"                      > /dev/null
  psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$HERE/../bank-direct-allocation-guard/bootstrap-sources.sql" > /dev/null
  local f
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
    psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/$f.sql"                                               > /dev/null
  done
  # De echte lichamen van de twee triggerfuncties die de bootstrap vereenvoudigd nabouwt.
  local real
  real="$(sed -n '/^CREATE OR REPLACE FUNCTION public.update_updated_at_column()/,/^\$\$ LANGUAGE plpgsql SET search_path = public;/p' \
            "$MIG/20260411182021_ce126469-1948-4a6f-947d-ad6dd95764cb.sql")
$(sed -n '/^CREATE OR REPLACE FUNCTION public.set_organization_id()/,/^\$function\$;/p' \
            "$MIG/20260616014119_379a0719-29c0-4ba7-a513-06777db1dbc3.sql")"
  [ -n "$real" ] || { echo "triggerfuncties niet gevonden" >&2; exit 1; }
  psql -q -v ON_ERROR_STOP=1 -d "$db" -c "$real"                                                       > /dev/null
  psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$HERE/../bank-transaction-corrections/fixtures.sql"          > /dev/null
  # De hulpfuncties van PR 2 noemen de gebeurtenistabel van PR 1, die er hier nog
  # niet is (de geschiedenis is van vóór PR 1): lichamen pas bij aanroep toetsen.
  PGOPTIONS="$PGOPTIONS -c check_function_bodies=off" \
  psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$HERE/../bank-correction-booking-description/helpers.sql"    > /dev/null
  psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$HERE/helpers.sql"                                           > /dev/null
}

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

# ── de rolloutblokken, letterlijk ───────────────────────────────────────────
PRE4_OUD="$(git -C "$REPO" show 3669a94:supabase/rollout/20261018120000_add_bank_transaction_corrections/preflight.sql \
            | awk 'index($0, "-- ── PRE 4.") == 1 { f = 1 } f { print } f && !/^--/ && /;[[:space:]]*$/ { exit }')"
[ -n "$PRE4_OUD" ] || { echo "oorspronkelijke PRE 4 niet gevonden" >&2; exit 1; }
PRE4="$(block "$R1/preflight.sql" '-- ── PRE 4.')"
PRE4B="$(block "$R1/preflight.sql" '-- ── PRE 4b.')"
PREB6="$(block "$R3/preflight.sql" '-- ── PRE B6.')"
POST8="$(block "$R1/postcheck.sql" '-- ── POST 8.')"
POSTC4="$(block "$R3/postcheck.sql" '-- ── POST C4.')"
POSTC5="$(block "$R3/postcheck.sql" '-- ── POST C5.')"

# ── database 1 ──────────────────────────────────────────────────────────────
build "$DB"
run -f "$HERE/history.sql"                                                         > /dev/null
run -v pre4_oud="$PRE4_OUD" -v pre4="$PRE4" -v pre4b="$PRE4B" -v preb6="$PREB6" -f "$HERE/pre.sql" > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(coalesce(detail, ''), 110) AS detail
  FROM proof.result ORDER BY ok, n;"
