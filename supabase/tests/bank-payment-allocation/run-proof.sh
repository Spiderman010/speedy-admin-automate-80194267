#!/usr/bin/env bash
# Real-PostgreSQL proof for P5 — atomaire betalingen en allocaties:
#   20261021180000_add_atomic_bank_payment_link (P5a) en
#   20261021183000_enforce_bank_payment_writer (P5c),
# against the REAL writers, the REAL RLS of the five source tables and the real
# migration chain up to and including 20261020120000.
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL, and what is claimed here — real locks, two and
# three genuinely concurrent sessions, faults after every step and at COMMIT,
# rollback and re-application — cannot be observed from TypeScript.
#
# Usage (with a local cluster already running; needs the dblink extension).
# Only the libpq environment is used:
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/bank-payment-allocation/run-proof.sh
#
# Order:
#   build.sh                 bootstrap, bootstrap-sources.sql, the REAL RLS blocks of
#                            20260613001452 (sed), the real chain … PR 0, the real
#                            trigger bodies, ../bank-transaction-corrections/fixtures.sql,
#                            PR 1, PR 2, the hold fix, 20261020120000, helpers.sql
#   pre.sql                  N: NEGATIVE CONTROL without P5a, plus legacy rows L1–L6
#   snapshot.sql             data and catalogue that P5a must not touch
#   rollout PRE (P5a)        U: every block literally, in a READ ONLY transaction
#   P5a (TWICE)              the migration under test, idempotent
#   rollout POST (P5a)       U: literally, read only; POST = PRE where it must be
#   proof.sql                A–J, Z: catalogue, link, refusals, role matrix, replay,
#                            existing pair, unlink, legacy, safety net, corrections
#   faults.sql               K: a fault after every step and at COMMIT changes nothing
#   concurrency.sql          L: races with two/three real sessions, no deadlock
#   ROLLBACK P5a (TWICE)     literally from the header + rollback.sql
#   P5a + final.sql          re-applied; replay survives; global invariants
#   P5c (TWICE) + p5c.sql    P: enforcement (REVOKE, writer guard, invoice guard)
#   ROLLBACK P5c (TWICE)     literally from the header + p5c-rollback.sql
#   P5c                      re-applied
#
# Mutation testing: point P5A_MIGRATION / P5C_MIGRATION at a modified copy; the
# proofs that depend on the removed protection must then fail.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${P5_PROOF_DB:-p5proof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
MA="${P5A_MIGRATION:-$MIG/20261021180000_add_atomic_bank_payment_link.sql}"
MC="${P5C_MIGRATION:-$MIG/20261021183000_enforce_bank_payment_writer.sql}"

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

"$HERE/build.sh" "$DB"

run() { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@" > /dev/null; }

# Uitrolmateriaal, letterlijk: één blok uit een rolloutbestand (van de kopregel
# tot en met de eerste regel zonder commentaar die op ';' eindigt), uitgevoerd
# in een ALLEEN-LEZEN transactie. Uitvoer: rijen als a|b|c.
R5A="$REPO/supabase/rollout/20261021180000_add_atomic_bank_payment_link"
R5C="$REPO/supabase/rollout/20261021183000_enforce_bank_payment_writer"
block() {
  local out
  out="$(awk -v h="$2" 'index($0, h) == 1 { f = 1 } f { print } f && !/^--/ && /;[[:space:]]*$/ { exit }' "$1")"
  [ -n "$out" ] || { echo "blok '$2' niet gevonden in $1" >&2; exit 1; }
  printf '%s\n' "$out"
}
ro() { PGOPTIONS="$PGOPTIONS -c default_transaction_read_only=on" psql -X -q -At -F'|' -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
rec() {
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -v n="$1" -v name="$2" -v ok="$3" -v detail="$4" > /dev/null <<'SQL'
SELECT proof.plan(ARRAY[:'n']);
SELECT proof.record(:'n', :'name', :'ok'::boolean, :'detail');
SQL
}
expect_eq() {
  if [ "$3" = "$4" ]; then rec "$1" "$2" true "$3"; else rec "$1" "$2" false "kreeg: $3 | verwacht: $4"; fi
}

rollback_of() {
  local r
  r="$(sed -n '/^-- ROLLBACK-BEGIN$/,/^-- ROLLBACK-END$/p' "$1" | grep -v '^-- ROLLBACK-' | sed 's/^-- \{0,1\}//')"
  [ -n "$r" ] || { echo "rollbackblok niet gevonden in $1" >&2; exit 1; }
  printf '%s\n' "$r"
}

run -f "$HERE/pre.sql"
run -f "$HERE/snapshot.sql"

# U — PRE van P5a, letterlijk en alleen lezen, op de bekende testdata (N en L1–L6).
ro "$(cat "$R5A/preflight.sql")" > /dev/null
expect_eq U1 'P5a PRE 1: vereisten aanwezig, P5a nog niet, verkooptrigger de beoordeelde' \
  "$(ro "$(block "$R5A/preflight.sql" '-- ── PRE 1.')")" 't|t|t|t|t|t|t|t'
PRE2="$(ro "$(block "$R5A/preflight.sql" '-- ── PRE 2.')")"
expect_eq U2 'P5a PRE 3 vindt precies de testfacturen die de schrijver weigert (L1, L3, L4, N2, N3, N4)' \
  "$(ro "$(block "$R5A/preflight.sql" '-- ── PRE 3.')" | tr '\n' ';')" \
  'inkoop|Q3i inkoop met de oude status betaald (ontkoppelen geweigerd)|1;verkoop|Q3c over-allocatie (som koppelingen > factuurbedrag)|1;verkoop|Q3d betaald zonder enige koppeling (oude match)|2;verkoop|Q3h restant wijkt af van factuurbedrag − koppelingen|2;'
expect_eq U3 'P5a PRE 4 vindt precies de testtransacties die de schrijver weigert (L1, L2, L5, N2, N3)' \
  "$(ro "$(block "$R5A/preflight.sql" '-- ── PRE 4.')" | tr '\n' ';')" \
  'Q4b gematcht via een oude match zonder koppeling (alleen die match kan worden vastgelegd)|2;Q4d gecodeerd én gekoppeld|1;Q4e koppelingen, maar niet gematcht (wordt bij de volgende koppeling gematcht)|3;'
expect_eq U4 'P5a PRE 5: één koppeling op een afgewezen paar (N3), geen STOP' \
  "$(ro "$(block "$R5A/preflight.sql" '-- ── PRE 5.')")" '0|0|0|1|0|f'
PRE6="$(ro "$(block "$R5A/preflight.sql" '-- ── PRE 6.')")"

# P5a, TWEE keer: hij moet een tweede toepassing overleven.
run -f "$MA"
run -f "$MA"

# U — POST van P5a.
ro "$(cat "$R5A/postcheck.sql")" > /dev/null
expect_eq U5 'P5a POST 1: structuur, rechten, RLS en triggers' \
  "$(ro "$(block "$R5A/postcheck.sql" '-- ── POST 1.')")" 't|t|t|t|t|t|t'
expect_eq U6 'P5a POST 2 = PRE 6: geen rij gewijzigd, created_by nergens gevuld' \
  "$(ro "$(block "$R5A/postcheck.sql" '-- ── POST 2.')")" "$PRE6|0"
expect_eq U7 'P5a POST 3: nog geen claims of gebeurtenissen' \
  "$(ro "$(block "$R5A/postcheck.sql" '-- ── POST 3.')")" '0|0|0'
expect_eq U8 'P5a POST 4 = PRE 2: catalogus buiten P5a ongewijzigd' \
  "$(ro "$(block "$R5A/postcheck.sql" '-- ── POST 4.')")" "$PRE2"

run -f "$HERE/proof.sql"
run -v conn="$CONN" -f "$HERE/faults.sql"
run -v conn="$CONN" -f "$HERE/concurrency.sql"

# De gedocumenteerde ROLLBACK van P5a, letterlijk uit de kop, TWEE keer.
run -c "SELECT proof.put('digest_before_rollback', proof.p5digest());"
RA="$(rollback_of "$MA")"
run -c "$RA"
run -c "$RA"
run -f "$HERE/rollback.sql"

# En weer vooruit.
run -f "$MA"
run -f "$HERE/final.sql"

# P5c, TWEE keer, na P5a.
run -c "SELECT proof.put('p5c_data', proof.p5data()), proof.put('p5c_acl', proof.acl('public.bank_transaction_allocations'));"

# U — PRE van P5c. In deze testdata schreef de "oude app" na het eerste gebruik
# van de schrijver nog twee koppelingen rechtstreeks (H6 en L14): PRE 3 moet ze
# vinden (in productie: STOP).
ro "$(cat "$R5C/preflight.sql")" > /dev/null
expect_eq U9 'P5c PRE 1: P5a aanwezig, P5c nog niet' \
  "$(ro "$(block "$R5C/preflight.sql" '-- ── PRE 1.')")" 't|t|t|t'
expect_eq U10 'P5c PRE 3 vindt de directe schrijfacties van na het eerste gebruik (2: H6 en L14)' \
  "$(ro "$(block "$R5C/preflight.sql" '-- ── PRE 3.')" | cut -d'|' -f2)" '2'
expect_eq U11 'P5c PRE 4: geen facturen met restant 0 zonder bedrag' \
  "$(ro "$(block "$R5C/preflight.sql" '-- ── PRE 4.')")" ''
C6="$(ro "$(block "$R5C/preflight.sql" '-- ── PRE 6.')")"

run -f "$MC"
run -f "$MC"

ro "$(cat "$R5C/postcheck.sql")" > /dev/null
expect_eq U12 'P5c POST 1: alleen lezen, guards actief, policies staan, schrijver bereikbaar' \
  "$(ro "$(block "$R5C/postcheck.sql" '-- ── POST 1.')")" 't|t|t|t|t|t'
expect_eq U13 'P5c POST 2 = PRE 6: geen rij gewijzigd' \
  "$(ro "$(block "$R5C/postcheck.sql" '-- ── POST 2.')")" "$C6"

run -f "$HERE/p5c.sql"

# De gedocumenteerde ROLLBACK van P5c, letterlijk uit de kop, TWEE keer; dan weer vooruit.
run -c "SELECT proof.put('p5c_digest_before_rollback', proof.p5digest());"
RC="$(rollback_of "$MC")"
run -c "$RC"
run -c "$RC"
run -f "$HERE/p5c-rollback.sql"
run -f "$MC"
run -c "SELECT proof.plan(ARRAY['Q3']);
        SELECT proof.expect_true('Q3', 'P5c opnieuw toegepast: guards terug, alleen SELECT voor authenticated, invarianten gelden',
          \$\$EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'enforce_bank_allocation_writer_trigger')
             AND NOT has_table_privilege('authenticated', 'public.bank_transaction_allocations', 'INSERT')
             AND proof.writer_violations() = 0 AND proof.unbalanced() = 0\$\$);"

psql -X -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(coalesce(detail, ''), 110) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -X -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

# Elk verwacht bewijs moet er zijn: een bewijs dat stil wegvalt (bv. doordat een
# uitgestelde controle bij COMMIT de hele opdracht terugdraaide) is een FAIL.
MISSING=$(psql -X -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n);")
if [ "$MISSING" != "0" ]; then
  psql -X -q -d "$DB" -t -A -c "SELECT 'ONTBREEKT: ' || n FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n) ORDER BY n;"
fi

FAILED=$(psql -X -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ] && [ "$MISSING" = "0" ]
