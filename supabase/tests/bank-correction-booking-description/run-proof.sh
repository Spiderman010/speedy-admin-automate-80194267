#!/usr/bin/env bash
# Real-PostgreSQL proof for Bankcorrecties v1.1 PR 2 (20261018150000): a
# correction keeps bank_transactions.description byte-equal — the imported
# bank text — while the ledger lines get the booking description, against the
# REAL writers and the real migration chain incl. PR 0 and PR 1.
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — MVCC visibility to
# other sessions, faults after every step and at COMMIT, real locks — cannot
# be observed from TypeScript.
#
# Usage (with a local cluster already running; needs the dblink extension):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/bank-correction-booking-description/run-proof.sh
#
# Order:
#   ../opening-balance/bootstrap.sql + ../bank-direct-allocation-guard/bootstrap-sources.sql
#   the REAL migration chain 20260904120000 … 20261017120000 (incl. PR 0)
#   the REAL bodies of update_updated_at_column and set_organization_id, taken
#     from their migrations (the bootstrap carries simplified copies; the
#     migration pins the production bodies of every trigger on bank_transactions)
#   ../bank-transaction-corrections/fixtures.sql   users, roles, accounts, helpers (PR 1)
#   20261018120000 (PR 1, the merged file)
#   helpers.sql             original bank text per test line, dedup key, digests
#   pre.sql                 NEGATIVE CONTROL: with PR 1 a correction overwrites the bank text
#   snapshot.sql            baseline of catalogue and data
#   20261018150000 (TWICE)  the migration under test, idempotent
#   proof.sql               catalogue, prerequisite check, S0–S4 behaviour
#   isolation.sql           three real sessions: nobody sees the temporary text
#   faults.sql              a fault after every step and at COMMIT changes nothing
#   concurrency.sql         races with two real sessions
#   rollout rollback.sql (TWICE) + after-rollback.sql, re-apply + final.sql
#
# Mutation testing: point CORR2_MIGRATION at a modified copy of the migration.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${CORR2_PROOF_DB:-corr2proof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
PR1="$MIG/20261018120000_add_bank_transaction_corrections.sql"
M="${CORR2_MIGRATION:-$MIG/20261018150000_keep_bank_description_on_correction.sql}"
ROLLOUT="$REPO/supabase/rollout/20261018150000_keep_bank_description_on_correction"

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

# De echte lichamen van de twee triggerfuncties die de bootstrap vereenvoudigd
# nabouwt — letterlijk uit hun migraties, zodat de pins van productie gelden.
REAL_FUNCTIONS="$(sed -n '/^CREATE OR REPLACE FUNCTION public.update_updated_at_column()/,/^\$\$ LANGUAGE plpgsql SET search_path = public;/p' \
                    "$MIG/20260411182021_ce126469-1948-4a6f-947d-ad6dd95764cb.sql")
$(sed -n '/^CREATE OR REPLACE FUNCTION public.set_organization_id()/,/^\$function\$;/p' \
                    "$MIG/20260616014119_379a0719-29c0-4ba7-a513-06777db1dbc3.sql")"
[ -n "$REAL_FUNCTIONS" ] || { echo "triggerfuncties niet gevonden" >&2; exit 1; }
run -c "$REAL_FUNCTIONS"                                                           > /dev/null

run -f "$HERE/../bank-transaction-corrections/fixtures.sql"                        > /dev/null
run -f "$PR1"                                                                      > /dev/null
run -f "$HERE/helpers.sql"                                                         > /dev/null

# Negatieve controle: met PR 1, zonder PR 2.
run -f "$HERE/pre.sql"                                                             > /dev/null
run -f "$HERE/snapshot.sql"                                                        > /dev/null

# De migratie onder test, TWEE keer.
run -f "$M"                                                                        > /dev/null
run -f "$M"                                                                        > /dev/null

# De voorwaardencontrole, letterlijk uit de migratie onder test.
PREREQ="$(sed -n '/^DO \$migratie\$$/,/^\$migratie\$;$/p' "$M")"
[ -n "$PREREQ" ] || { echo "voorwaardencontrole niet gevonden" >&2; exit 1; }

run -v prereq="$PREREQ" -f "$HERE/proof.sql"                                       > /dev/null
run -v conn="$CONN" -f "$HERE/isolation.sql"                                       > /dev/null
run -v conn="$CONN" -f "$HERE/faults.sql"                                          > /dev/null
run -v conn="$CONN" -f "$HERE/concurrency.sql"                                     > /dev/null

# De gedocumenteerde rollback, TWEE keer, en dan weer vooruit.
run -c "INSERT INTO proof.state VALUES ('digest_before_rollback', proof.digest()), ('rest_before_rollback', proof.rest_digest());" > /dev/null
run -f "$ROLLOUT/rollback.sql"                                                     > /dev/null
run -f "$ROLLOUT/rollback.sql"                                                     > /dev/null
RBGUARD="$(sed -n '/^DO \$rollback\$$/,/^\$rollback\$;$/p' "$ROLLOUT/rollback.sql")"
[ -n "$RBGUARD" ] || { echo "rollbackbewaking niet gevonden" >&2; exit 1; }
run -v rbguard="$RBGUARD" -f "$HERE/after-rollback.sql"                            > /dev/null
run -f "$M"                                                                        > /dev/null
run -f "$HERE/final.sql"                                                           > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(coalesce(detail, ''), 110) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

MISSING=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n);")
if [ "$MISSING" != "0" ]; then
  psql -q -d "$DB" -t -A -c "SELECT 'ONTBREEKT: ' || n FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n) ORDER BY n;"
fi

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ] && [ "$MISSING" = "0" ]
