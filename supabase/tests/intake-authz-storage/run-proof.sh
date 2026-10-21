#!/usr/bin/env bash
# Real-PostgreSQL proof voor de P2-migraties (herstelprogramma V2, pakket 2):
#   20261021160000_restrict_invoice_storage_to_current_members.sql  B2-08
#   20261021161000_enforce_purchase_invoice_line_parent.sql         A2-17 = B1-02
#   20261021162000_guard_purchase_line_replacement.sql              A2-07 (D5 open)
#   20261021163000_revoke_predicate_function_execute.sql            B1-05
#
# ALLEEN TEGEN EEN WEGWERPCLUSTER. Dit script maakt en verwijdert een database.
# Richt het nooit op een BoekAssist-database: niet productie
# (alxlbdhpbwlehbdbfejw), niet een preview-branch. Het hoort niet bij
# `npm run test`: rechten, RLS en triggers zijn alleen op een echte server
# onder een echte `SET ROLE` waar te nemen.
#
# Gebruik (alleen libpq-omgevingsvariabelen):
#   PGHOST=/pad/naar/socketmap PGPORT=5432 PGUSER=postgres \
#     supabase/tests/intake-authz-storage/run-proof.sh
#   (CI: PGHOST=127.0.0.1, met PGPASSWORD indien nodig)
#
# Volgorde:
#   bootstrap.sql            Supabase-compatibel testdubbel (rollen, auth, storage,
#                            standaardrechten) — geen policies, geen tabellen van de app
#   ALLE echte migraties vóór het P2-venster, ongewijzigd en in volgorde
#   fixtures.sql             twee organisaties, rollen, facturen, regels, objecten;
#                            daarna verlaat de ex-medewerker organisatie A
#   proof-before.sql         V01–V11: de bekende lekken op de oude policies
#   rollout-preflight.sql    de plakbare read-only preflight uit het rapport
#   de P2-migraties, ELK TWEE KEER
#   rollout-postcheck.sql    de plakbare read-only postcheck uit het rapport
#   alle echte migraties na het P2-venster (na een merge van andere pakketten)
#   proof-after.sql          Q, S, O, R, W, P: genummerde bewijzen
#   W14–W17                  twee gelijktijdige sessies (rijgrendel, review H-02)
# en drukt één regel per bewijs af, plus een samenvatting.

set -euo pipefail

case "${PGHOST:-}" in
  /*|127.0.0.1|::1|localhost) ;;
  *) echo "run-proof: PGHOST moet een socketmap of loopback-adres zijn (wegwerpcluster)." >&2; exit 2 ;;
esac
case "${PGHOST},${PGUSER:-}" in
  *supabase*|*pooler*|*alxlbdhpbwlehbdbfejw*) echo "run-proof: Supabase/productie geweigerd." >&2; exit 2 ;;
esac

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
export PSQLRC=/dev/null

DB="${P2_PROOF_DB:-p2intakeproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
WINDOW_FIRST="20261021160000"
WINDOW_LAST="20261021165959"

psql -X -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

run() { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

run -f "$HERE/bootstrap.sql" >/dev/null

mapfile -t ALL < <(cd "$MIG" && ls -1 ./*.sql | sed 's|^\./||' | LC_ALL=C sort)
BEFORE=(); OWN=(); AFTER=()
for f in "${ALL[@]}"; do
  stamp="${f%%_*}"
  if [[ "$stamp" < "$WINDOW_FIRST" ]]; then BEFORE+=("$f")
  elif [[ "$stamp" > "$WINDOW_LAST" ]]; then AFTER+=("$f")
  else OWN+=("$f"); fi
done
[ "${#OWN[@]}" -eq 4 ] || { echo "run-proof: verwacht 4 P2-migraties in het venster, gevonden ${#OWN[@]}." >&2; exit 2; }

for f in "${BEFORE[@]}"; do run -1 -f "$MIG/$f" >/dev/null; done

# De plakbare preflight/postcheck (één SELECT per bestand) wordt ongewijzigd
# uitgevoerd en als tabel bewaard, zodat proof-after.sql de uitkomst toetst.
capture() {
  { printf 'CREATE TABLE proof.%s AS\n' "$1"; sed -e 's/;[[:space:]]*$//' "$2"; printf ';\n'; } | run >/dev/null
}

run -f "$HERE/fixtures.sql" >/dev/null
run -f "$HERE/proof-before.sql" >/dev/null
capture preflight "$HERE/rollout-preflight.sql"

# De migraties onder test, elk TWEE keer: ze moeten een tweede toepassing overleven.
for f in "${OWN[@]}"; do
  run -1 -f "$MIG/$f" >/dev/null
  run -1 -f "$MIG/$f" >/dev/null
done

capture postcheck "$HERE/rollout-postcheck.sql"

for f in "${AFTER[@]}"; do run -1 -f "$MIG/$f" >/dev/null; done

run -f "$HERE/proof-after.sql" >/dev/null

# ═════ W14–W17 — gelijktijdige opslag (review H-02) ═════════════════════════
# Twee sessies van dezelfde accountant vervangen tegelijk de regels van
# factuur e1. T1 houdt zijn transactie open (pg_sleep); T2 start pas als T1
# aantoonbaar slaapt. Met de rijgrendel wacht T2 op T1 en wint daarna; zonder
# grendel weigerde de guard T2 met 42501 (nulmeting in de review).
ACC="a0000000-0000-4000-8000-000000000002"
INV="2a000000-0000-4000-8000-0000000000e1"
replace_sql() {  # $1 = omschrijving, $2 = extra SQL vóór COMMIT
  printf "BEGIN; SET LOCAL ROLE authenticated; SELECT proof.als('%s');
SELECT 'OK rows=' || count(*) FROM public.replace_purchase_invoice_lines('%s', '[{\"omschrijving\":\"%s\",\"amount_excl\":100,\"sort_order\":0}]'::jsonb);
%s COMMIT;" "$ACC" "$INV" "$1" "$2"
}
T1_OUT="$(mktemp)"; T2_OUT="$(mktemp)"
PGAPPNAME=p2_t1 psql -X -q -At -v ON_ERROR_STOP=1 -d "$DB" -c "$(replace_sql T1 "SELECT pg_sleep(3);")" >"$T1_OUT" 2>&1 &
T1_PID=$!
for _ in $(seq 1 100); do
  [ "$(psql -X -q -At -d "$DB" -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'p2_t1' AND query LIKE '%pg_sleep%' AND wait_event = 'PgSleep'")" = "1" ] && break
  sleep 0.1
done
T2_START=$(date +%s%N)
psql -X -q -At -d "$DB" -c "$(replace_sql T2 "")" >"$T2_OUT" 2>&1 || true
T2_MS=$(( ($(date +%s%N) - T2_START) / 1000000 ))
wait "$T1_PID" || true
lit() { printf "'%s'" "$(tr '\n' ' ' <"$1" | sed "s/'/''/g; s/ *$//")"; }
run >/dev/null <<SQL
SELECT proof.expect('W14', 'gelijktijdige opslag: de eerste sessie slaagt', $(lit "$T1_OUT"), '%OK rows=1%');
SELECT proof.expect('W15', '… de tweede sessie wacht op de eerste en slaagt ook (geen misleidende 42501)', $(lit "$T2_OUT"), '%OK rows=1%');
SELECT proof.expect('W16', '… de tweede sessie heeft echt gewacht (≥ 1 500 ms)', ($T2_MS >= 1500)::text, 'true');
SELECT proof.expect('W17', '… daarna precies één regel: die van de laatste opslag',
  (SELECT count(*) || '|' || min(omschrijving) FROM public.purchase_invoice_lines WHERE purchase_invoice_id = '$INV'), '1|T2');
SQL
rm -f "$T1_OUT" "$T2_OUT"

echo "keten: ${#BEFORE[@]} migraties vóór het venster, ${#OWN[@]} eigen (elk 2×), ${#AFTER[@]} erna"

psql -X -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(detail, 120) AS detail
  FROM proof.result ORDER BY ok, n;"

psql -X -q -d "$DB" -t -c "
  SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -X -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE NOT ok;")
[ "$FAILED" = "0" ]
