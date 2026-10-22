#!/usr/bin/env bash
# Bouwt in database $1 de ECHTE migratieketen tot en met 20261020120000, met de
# echte lichamen van de triggerfuncties die de bootstrap vereenvoudigd nabouwt
# en de fixtures van bank-transaction-corrections (gebruikers e1–e6 met elke
# rol, organisatie A met c1 en de btw-vrijgestelde c2, organisatie B met c3,
# het rekeningschema, en proof.call/expect_*). Daarna staat de database precies
# vóór 20261021170000_btw_en_nan_validatie_in_schrijvers.sql.
#
# THROWAWAY DATABASES ONLY. Dit script DROPt en CREATEt database $1. Nooit
# richten op een BoekAssist-database — niet productie (alxlbdhpbwlehbdbfejw),
# niet een previewbranch. Gebruikt uitsluitend PGHOST/PGPORT/PGUSER.
#
# Gebruikt door: run-proof.sh hiernaast, en de fase 2 van
# ../bank-transaction-posting/run-proof.sh en ../bank-bulk-posting/run-proof.sh.

set -euo pipefail

DB="${1:?databasenaam}"
: "${PGHOST:?set PGHOST}"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
T="$REPO/supabase/tests"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null
run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$T/opening-balance/bootstrap.sql"                       > /dev/null
run -f "$T/bank-direct-allocation-guard/bootstrap-sources.sql"  > /dev/null
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
  run -f "$MIG/$f.sql" > /dev/null
done

# De echte lichamen van de twee triggerfuncties die de bootstrap vereenvoudigd
# nabouwt — letterlijk uit hun migraties (PR 2 pint de triggers op bank_transactions).
REAL="$(sed -n '/^CREATE OR REPLACE FUNCTION public.update_updated_at_column()/,/^\$\$ LANGUAGE plpgsql SET search_path = public;/p' \
          "$MIG/20260411182021_ce126469-1948-4a6f-947d-ad6dd95764cb.sql")
$(sed -n '/^CREATE OR REPLACE FUNCTION public.set_organization_id()/,/^\$function\$;/p' \
          "$MIG/20260616014119_379a0719-29c0-4ba7-a513-06777db1dbc3.sql")"
[ -n "$REAL" ] || { echo "triggerfuncties niet gevonden" >&2; exit 1; }
run -c "$REAL" > /dev/null

run -f "$T/bank-transaction-corrections/fixtures.sql" > /dev/null

for f in \
  20261018120000_add_bank_transaction_corrections \
  20261018150000_keep_bank_description_on_correction \
  20261018180000_refine_release_hold_for_settled_history \
  20261020120000_add_bank_transaction_import_fingerprint
do
  run -f "$MIG/$f.sql" > /dev/null
done
