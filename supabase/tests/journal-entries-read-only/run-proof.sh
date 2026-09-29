#!/usr/bin/env bash
# Real-PostgreSQL proof for 20260930120000_make_journal_entries_read_only.sql.
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and privileges and RLS can only be observed by a
# real server under a real `SET ROLE`.
#
# Usage (with a local cluster already running):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/journal-entries-read-only/run-proof.sh
#
# It applies, in order:
#   default-privileges.sql        Supabase's default table/function grants, first
#   ../opening-balance/bootstrap.sql, the ledger foundation + direct-insert revoke
#   ../year-close/fixtures.sql    proof helpers, organisations, users and roles
#   journal-entries-double.sql    the table as 20260411/20260531/20260603 left it
#   20260719201000_...sql         REAL: grootboekrekening_id + FK
#   20260613001452 block 3A.10    REAL: the four role policies, cut from the file
#   fixtures.sql                  three historical rows
#   pre-proof.sql                 V1-V7: the exposure, plus snapshots
#   20260930120000_...sql         the REAL migration under test, applied TWICE
#   proof.sql                     1-30
#   the ROLLBACK block            from the migration header, applied TWICE
#   rollback-proof.sql            R1-R6: exact pre-migration ACL and policies
# and prints one line per numbered proof plus a summary.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${JE_PROOF_DB:-jeproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
T="$REPO/supabase/tests"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/default-privileges.sql"                                      > /dev/null
run -f "$T/opening-balance/bootstrap.sql"                                   > /dev/null
run -f "$MIG/20260914120000_add_ledger_postings_foundation.sql"            > /dev/null
run -f "$MIG/20260920130000_revoke_direct_ledger_insert.sql"               > /dev/null
run -f "$T/year-close/fixtures.sql"                                         > /dev/null
run -f "$HERE/journal-entries-double.sql"                                   > /dev/null
run -f "$MIG/20260719201000_add_journal_entries_grootboekrekening.sql"     > /dev/null

# De echte policies, letterlijk uit de migratie geknipt (blok 3A.10).
POLICIES="$(sed -n '/^-- 3A.10 journal_entries/,/^-- 3A.11/p' "$MIG/20260613001452_ac57e447-1ab9-4125-9cc8-070054d55750.sql")"
[ -n "$POLICIES" ] || { echo "blok 3A.10 niet gevonden" >&2; exit 1; }
run -c "$POLICIES"                                                          > /dev/null

run -f "$HERE/fixtures.sql"                                                 > /dev/null
run -f "$HERE/pre-proof.sql"                                                > /dev/null

# De migratie onder test, TWEE keer: zij moet een tweede toepassing overleven.
if [ "${JE_SKIP_MIGRATION:-0}" != "1" ]; then
  run -f "$MIG/20260930120000_make_journal_entries_read_only.sql"          > /dev/null
  run -f "$MIG/20260930120000_make_journal_entries_read_only.sql"          > /dev/null
fi

run -f "$HERE/proof.sql"                                                    > /dev/null

# De gedocumenteerde ROLLBACK, letterlijk uit de kop van de migratie (tussen
# ROLLBACK-BEGIN en ROLLBACK-END, zonder het "-- " ervoor), TWEE keer: hij moet
# de toestand van vóór de migratie exact herstellen, en idempotent zijn.
# JE_ROLLBACK_SQL mag een ander bestand aanwijzen — alleen voor de negatieve controle.
if [ -n "${JE_ROLLBACK_SQL:-}" ]; then
  ROLLBACK="$(cat "$JE_ROLLBACK_SQL")"
else
  ROLLBACK="$(sed -n '/^-- ROLLBACK-BEGIN$/,/^-- ROLLBACK-END$/p' "$MIG/20260930120000_make_journal_entries_read_only.sql" \
              | grep -v '^-- ROLLBACK-' | sed 's/^-- \{0,1\}//')"
fi
[ -n "$ROLLBACK" ] || { echo "rollbackblok niet gevonden" >&2; exit 1; }
run -c "$ROLLBACK"                                                          > /dev/null
run -c "$ROLLBACK"                                                          > /dev/null
run -f "$HERE/rollback-proof.sql"                                           > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 110) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
