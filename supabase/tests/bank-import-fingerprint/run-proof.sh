#!/usr/bin/env bash
# Real-PostgreSQL proof for 20261020120000_add_bank_transaction_import_fingerprint.sql.
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — a unique violation
# under RLS, two genuinely concurrent sessions, rollback and re-application —
# cannot be observed from TypeScript.
#
# Usage (with a local cluster already running; needs the dblink extension):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/bank-import-fingerprint/run-proof.sh
#
# Order:
#   ../opening-balance/bootstrap.sql                roles, auth.uid(), has_min_role, clients
#   ../bank-transaction-posting/bootstrap-extra.sql bank_transactions (real shape) + read policy
#   ../year-close/fixtures.sql                      organisations, users, roles, proof helpers
#   fixtures.sql                                    production write policies/grants, HISTORICAL
#                                                   rows (identical payments, a double import),
#                                                   baseline of data and catalogue, helpers
#   rollout preflight.sql                           must run cleanly (read-only) before the migration
#   20261020120000 (REAL)                           the migration under test, applied TWICE
#   rollout postcheck.sql                           placeholders filled in; every column true
#   proof.sql                                       P1–P5
#   concurrency.sql                                 C1–C4, two real sessions
#   the ROLLBACK block from the migration header    applied TWICE, then rollback.sql
#   20261020120000 + final.sql                      re-applied after rollback
#
# Mutation testing: point FP_MIGRATION at a modified copy of the migration
# (e.g. CREATE INDEX instead of CREATE UNIQUE INDEX); the proofs that depend on
# the removed protection must then fail.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${FP_PROOF_DB:-fpproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
T="$REPO/supabase/tests"
ROLLOUT="$REPO/supabase/rollout/20261020120000_add_bank_transaction_import_fingerprint"
M="${FP_MIGRATION:-$MIG/20261020120000_add_bank_transaction_import_fingerprint.sql}"   # alleen voor de negatieve controle overschrijven

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
val() { psql -q -t -A -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }

run -f "$T/opening-balance/bootstrap.sql"                          > /dev/null
run -f "$T/bank-transaction-posting/bootstrap-extra.sql"           > /dev/null
run -f "$T/year-close/fixtures.sql"                                > /dev/null
run -f "$HERE/fixtures.sql"                                        > /dev/null

# PRE: alleen lezen, moet foutloos draaien op de echte vorm.
run -f "$ROLLOUT/preflight.sql"                                    > /dev/null
PRE_ROWS="$(val "SELECT count(*) FROM public.bank_transactions;")"
PRE_POLICIES="$(val "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_transactions';")"

# De migratie onder test, TWEE keer: zij moet een tweede toepassing overleven.
run -f "$M"                                                        > /dev/null
run -f "$M"                                                        > /dev/null

# POST met de placeholders ingevuld zoals de eigenaar dat doet; elke kolom moet true zijn.
POST="$(sed -e "s/NULL::bigint AS pre_banktransacties/${PRE_ROWS}::bigint AS pre_banktransacties/" \
            -e "s/NULL::bigint AS pre_policies/${PRE_POLICIES}::bigint AS pre_policies/" "$ROLLOUT/postcheck.sql")"
POST_ROW="$(psql -q -v ON_ERROR_STOP=1 -d "$DB" -t -A -F ' ' -c "$POST" | tail -n 1)"
run -c "SELECT proof.record('POST', 'rollout postcheck.sql (ingevuld): elke kolom true',
          '$POST_ROW' !~ '(^| )f( |$)' AND '$POST_ROW' ~ '^(t ?)+\$', '$POST_ROW');" > /dev/null

run -f "$HERE/proof.sql"                                           > /dev/null
run -v conn="$CONN" -f "$HERE/concurrency.sql"                     > /dev/null

# De gedocumenteerde ROLLBACK, letterlijk uit de kop, TWEE keer.
run -c "INSERT INTO proof.state SELECT 'rows_before_rollback', count(*)::text FROM public.bank_transactions;" > /dev/null
ROLLBACK="$(sed -n '/^-- ROLLBACK-BEGIN$/,/^-- ROLLBACK-END$/p' "$M" | grep -v '^-- ROLLBACK-' | sed 's/^-- \{0,1\}//')"
[ -n "$ROLLBACK" ] || { echo "rollbackblok niet gevonden" >&2; exit 1; }
run -c "$ROLLBACK"                                                 > /dev/null
run -c "$ROLLBACK"                                                 > /dev/null
run -f "$HERE/rollback.sql"                                        > /dev/null

# En weer vooruit.
run -f "$M"                                                        > /dev/null
run -f "$HERE/final.sql"                                           > /dev/null

psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(coalesce(detail, ''), 130) AS detail
  FROM proof.result ORDER BY coalesce(ok, false), n;"

psql -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE ok IS NOT TRUE;")
[ "$FAILED" = "0" ]
