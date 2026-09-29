#!/usr/bin/env bash
# Real-PostgreSQL proof for 6C-b11 PR H — de ontkoppeling van het jaarwatermerk
# en de boekingsblokkade (20261002120000_decouple_year_watermark_from_posting.sql).
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — that the watermark no
# longer rejects, that the lock still does, that nothing else moved, and that
# the rollback is exact — cannot be observed from TypeScript.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/posting-decoupled/run-proof.sh
#
# Volgorde:
#   1. de volledige stapel t/m PR E (20261001120000) — de productiestand;
#   2. pre.sql   — negatieve controle (het watermerk weigert NU) + momentopnamen;
#   3. de migratie onder test, TWEE keer (idempotent);
#   4. proof.sql — de scenario's A t/m G en de dekking van elke schrijver;
#   5. negatieve controle C: één schrijver onschadelijk gewijzigd (blokkadetoets
#      blijft) → de migratie MOET weigeren en niets veranderen (negative.sql);
#   6. rollback: 20260928120000 opnieuw → rollback.sql (hashes exact terug);
#   7. negatieve controle D: de preflight gewijzigd → weigeren, niets veranderen;
#      rollback opnieuw;
#   8. de migratie nogmaals → final.sql (hashes exact vooruit) + de handoff-hashes.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${PDC_PROOF_DB:-pdcproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
T="$REPO/supabase/tests"
UNDER_TEST="$MIG/20261002120000_decouple_year_watermark_from_posting.sql"
ROLLBACK="$MIG/20260928120000_enforce_posting_lock.sql"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$T/opening-balance/bootstrap.sql"                                   > /dev/null
run -f "$T/bank-transaction-posting/bootstrap-extra.sql"                    > /dev/null
run -f "$MIG/20260914120000_add_ledger_postings_foundation.sql"            > /dev/null
run -f "$MIG/20260918120000_add_manual_journal_posting.sql"                > /dev/null
run -f "$MIG/20260919120000_add_opening_balance_posting.sql"               > /dev/null
run -f "$MIG/20260920130000_revoke_direct_ledger_insert.sql"               > /dev/null
run -f "$MIG/20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39.sql"      > /dev/null
run -f "$MIG/20260921120000_add_ledger_reversal_posting.sql"               > /dev/null
run -f "$MIG/20260921140000_harden_bank_transaction_posting.sql"           > /dev/null
run -f "$MIG/20260922120000_add_bank_bulk_posting.sql"                     > /dev/null
run -f "$T/year-close/bootstrap-sources.sql"                                > /dev/null
run -f "$MIG/20260924120000_add_year_close_writer.sql"                     > /dev/null
run -f "$MIG/20260925120000_add_fiscal_year_lifecycle_events.sql"          > /dev/null
run -f "$MIG/20260926120000_close_writes_fiscal_year_event.sql"            > /dev/null
run -f "$MIG/20260927120000_add_posting_lock_foundation.sql"               > /dev/null
run -f "$MIG/20260928120000_enforce_posting_lock.sql"                      > /dev/null
run -f "$MIG/20260929120000_harden_internal_function_acls.sql"             > /dev/null
run -f "$MIG/20261001120000_add_fiscal_year_reopen.sql"                    > /dev/null

run -f "$T/year-close/fixtures.sql"                                         > /dev/null
run -f "$T/posting-lock-enforced/fixtures.sql"                              > /dev/null
run -f "$T/fiscal-year-reopen/fixtures.sql"                                 > /dev/null
run -f "$HERE/fixtures.sql"                                                 > /dev/null

# Deel 1: negatieve controle en momentopnamen, VÓÓR de migratie.
run -f "$HERE/pre.sql"                                                      > /dev/null

# De migratie onder test, TWEE keer: zij moet een tweede toepassing overleven.
run -f "$UNDER_TEST"                                                        > /dev/null
run -c "SELECT proof.snap_put('once.hash.' || k, proof.hash(k)) FROM unnest(proof.changed_functions()) k;" > /dev/null
run -f "$UNDER_TEST"                                                        > /dev/null

# Deel 2: de bewijzen.
run -f "$HERE/proof.sql"                                                    > /dev/null

# Negatieve controle van de anti-clobber-toets: één doelfunctie onschadelijk
# wijzigen (blokkadetoets blijft), momentopname, de migratie proberen — zij
# MOET weigeren en niets veranderen.
negative() {  # $1 = fase, $2 = functienaam
  run -c "SELECT proof.mutate('$2');" > /dev/null
  run -c "SELECT proof.snap_put('mut.hash.' || k, proof.hash(k)), proof.snap_put('mut.acl.' || k, proof.acl(k))
          FROM unnest(proof.changed_functions() || proof.untouched_functions()) k;
          SELECT proof.snap_put('mut.functions', proof.function_set());" > /dev/null
  local rc=0 out
  out="$(psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$UNDER_TEST" 2>&1)" || rc=$?
  local msg
  msg="$(printf '%s' "$out" | grep -o 'PR H geweigerd.*' | head -1)"
  run -v phase="$1" -v mutated="$2" -v rejected="$([ "$rc" = "0" ] && echo 0 || echo 1)" -v msg="$msg" \
      -f "$HERE/negative.sql" > /dev/null
}

# Deel 3a (C): vanuit de NA-stand — één schrijver gewijzigd, de rest exact "ná".
negative C post_manual_journal

# Deel 3b: de gedocumenteerde rollback (herstelt óók de gewijzigde schrijver), en of hij exact is.
run -f "$ROLLBACK"                                                          > /dev/null
run -f "$HERE/rollback.sql"                                                 > /dev/null

# Deel 3c (D): vanuit de VÓÓR-stand — de preflight gewijzigd, de rest exact "vóór".
negative D bank_bulk_posting_candidates
run -f "$ROLLBACK"                                                          > /dev/null

# Deel 4: opnieuw vooruit, en de hashes voor de handoff.
run -f "$UNDER_TEST"                                                        > /dev/null
run -f "$HERE/final.sql"

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 110) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
