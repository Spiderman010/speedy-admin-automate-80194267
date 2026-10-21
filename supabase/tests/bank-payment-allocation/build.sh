#!/usr/bin/env bash
# Bouwt een wegwerpdatabase met de ECHTE keten t/m de nieuwste migratie vóór P5,
# de echte RLS-blokken en de echte triggerlichamen. Gebruikt door run-proof.sh.
#
# THROWAWAY DATABASES ONLY. Nooit tegen een BoekAssist-database (niet productie
# alxlbdhpbwlehbdbfejw, geen preview-branch). Alleen libpq-omgeving
# (PGHOST/PGPORT/PGUSER).
#
# Gebruik: build.sh <database>

set -euo pipefail

DB="${1:?databasenaam}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
RLS="$MIG/20260613001452_ac57e447-1ab9-4125-9cc8-070054d55750.sql"

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
q() { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@" > /dev/null; }

psql -X -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres > /dev/null

q -f "$HERE/../opening-balance/bootstrap.sql"
q -f "$HERE/bootstrap-sources.sql"

# De ECHTE RLS-blokken van de vijf tabellen, letterlijk (3A.4–3A.7 en 3A.12).
BLOKKEN="$(sed -n '/^-- 3A\.4 purchase_invoices$/,/^-- 3A\.8 vraagposten$/p' "$RLS" | sed '$d')
$(sed -n '/^-- 3A\.12 sales_invoices$/,$p' "$RLS")"
[ "$(printf '%s\n' "$BLOKKEN" | grep -c '^CREATE POLICY')" = "20" ] || { echo "RLS-blokken niet gevonden" >&2; exit 1; }
q -c "$BLOKKEN"

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
  q -f "$MIG/$f.sql"
done

# De echte lichamen van de twee triggerfuncties die de bootstrap vereenvoudigd
# nabouwt (PR 2 pint hun md5).
REAL="$(sed -n '/^CREATE OR REPLACE FUNCTION public.update_updated_at_column()/,/^\$\$ LANGUAGE plpgsql SET search_path = public;/p' \
          "$MIG/20260411182021_ce126469-1948-4a6f-947d-ad6dd95764cb.sql")
$(sed -n '/^CREATE OR REPLACE FUNCTION public.set_organization_id()/,/^\$function\$;/p' \
          "$MIG/20260616014119_379a0719-29c0-4ba7-a513-06777db1dbc3.sql")"
[ -n "$REAL" ] || { echo "triggerfuncties niet gevonden" >&2; exit 1; }
q -c "$REAL"

# Gebruikers, rollen, administraties, rekeningschema, bewijs- en dblink-hulp;
# vanaf hier krijgen nieuwe objecten de standaardrechten van Supabase.
q -f "$HERE/../bank-transaction-corrections/fixtures.sql"

for f in \
  20261018120000_add_bank_transaction_corrections \
  20261018150000_keep_bank_description_on_correction \
  20261018180000_refine_release_hold_for_settled_history \
  20261020120000_add_bank_transaction_import_fingerprint
do
  q -f "$MIG/$f.sql"
done

q -f "$HERE/helpers.sql"
