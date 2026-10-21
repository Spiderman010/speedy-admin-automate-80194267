#!/usr/bin/env bash
# Draait ELK echt-PostgreSQL-bewijsharnas van de repo — elke submap van
# supabase/tests met een run-proof.sh — na elkaar tegen een WEGWERPcluster, en
# faalt zodra één harnas faalt. Nieuwe harnassen worden vanzelf opgepikt: er is
# geen vaste lijst.
#
# ALLEEN TEGEN EEN WEGWERPCLUSTER. De harnassen maken en verwijderen hun eigen
# databases (DROP/CREATE DATABASE). Nooit richten op een BoekAssist-database:
# niet productie (alxlbdhpbwlehbdbfejw), niet een preview-branch. Daarom weigert
# dit script elke host die geen Unix-socketmap of loopback-adres is.
#
# Gebruik (alleen libpq-omgevingsvariabelen, net als de harnassen zelf):
#   Unix-socket:  PGHOST=/tmp/pgXX/sock PGPORT=5432 PGUSER=postgres scripts/ci/run-db-proofs.sh
#   TCP (CI):     PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=... scripts/ci/run-db-proofs.sh
#
# Vereisten: psql en git op het PATH; een PostgreSQL 16-server met de
# contrib-extensies dblink en pgcrypto; een superuser (de harnassen gebruiken
# CREATE EXTENSION, SET ROLE, COPY ... FROM PROGRAM en pg_terminate_backend);
# volledige git-historie (bank-release-hold-history leest `git show 3669a94:...`).
# Server-side dblink-verbindingen gebruiken dezelfde PGHOST/PGPORT/PGUSER, zonder
# wachtwoord: de server moet zichzelf daarlangs zonder wachtwoord bereiken (in de
# officiële postgres-container is loopback "trust"; op een socketcluster ook).
#
# Een harnas faalt bij: exitcode ≠ 0; het woord FAIL ergens in de uitvoer; een
# ONTBREEKT-regel; geen samenvattingsregel "N van M bewijzen geslaagd"; 0
# bewijzen; N < M; of een aantal PASS-/FAIL-regels in de uitslagtabel dat niet
# klopt met de samenvatting. Het script faalt als één harnas faalt.
#
# Optioneel:
#   DB_PROOFS_LOG_DIR   map voor de logs per harnas (standaard een tijdelijke map;
#                       de logs blijven staan en het pad wordt afgedrukt)
#   GITHUB_STEP_SUMMARY wordt aangevuld met de uitslagtabel (GitHub Actions)

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TESTS="$REPO/supabase/tests"
PRODUCTION_REF="alxlbdhpbwlehbdbfejw"

die() { echo "run-db-proofs: $*" >&2; exit 2; }

# ── 1. Alleen een lokaal wegwerpcluster ──────────────────────────────────────
[ -n "${PGHOST:-}" ] || die "PGHOST ontbreekt (Unix-socketmap, 127.0.0.1, ::1 of localhost)."
for var in PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE; do
  [ -z "${!var:-}" ] || die "$var is gezet; dat kan de verbinding omleiden. Zet hem uit en gebruik alleen PGHOST/PGPORT/PGUSER."
done
case "${PGHOST},${PGUSER:-}" in
  *supabase*|*pooler*|*"$PRODUCTION_REF"*) die "PGHOST/PGUSER wijst naar Supabase of productie — geweigerd." ;;
esac
case "$PGHOST" in
  /*) [ -d "$PGHOST" ] || die "socketmap $PGHOST bestaat niet." ;;
  127.0.0.1|::1|localhost) ;;
  *) die "PGHOST=$PGHOST is geen Unix-socketmap en geen loopback-adres — geweigerd: de harnassen verwijderen databases." ;;
esac
export PGHOST
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
# Hermetisch: geen ~/.psqlrc of pager die de uitvoer verandert.
export PSQLRC=/dev/null PAGER=cat
command -v psql >/dev/null || die "psql niet gevonden."
command -v git >/dev/null || die "git niet gevonden."

q() { psql -X -q -At -v ON_ERROR_STOP=1 -d postgres "$@"; }

# Een TSV-tabel uitgelijnd afdrukken (zonder afhankelijkheid van `column`).
align() {
  awk -F'\t' '{ for (i = 1; i <= NF; i++) { c[NR, i] = $i; if (length($i) > w[i]) w[i] = length($i) } if (NF > nf) nf = NF }
    END { for (r = 1; r <= NR; r++) { line = ""; for (i = 1; i <= nf; i++) line = line sprintf(i < nf ? "%-" w[i] "s  " : "%s", c[r, i]); print line } }'
}

# ── 2. Vooraf: bereikbaar, superuser, extensies, dblink terug naar zichzelf ──
ok=""
for _ in $(seq 1 30); do
  if q -c "SELECT 1" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || die "geen verbinding met $PGHOST:$PGPORT als $PGUSER: $(q -c 'SELECT 1' 2>&1 | head -3)"
SERVER_VERSION="$(q -c "SHOW server_version")"
[ "$(q -c "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")" = "t" ] \
  || die "$PGUSER is geen superuser; de harnassen hebben dat nodig."
[ "$(q -c "SELECT count(*) FROM pg_available_extensions WHERE name IN ('dblink', 'pgcrypto')")" = "2" ] \
  || die "de extensies dblink en pgcrypto zijn niet beschikbaar (installeer de contrib-module)."
PRE_DB="db_proofs_preflight"
q -c "DROP DATABASE IF EXISTS $PRE_DB" -c "CREATE DATABASE $PRE_DB" >/dev/null || die "kan geen wegwerpdatabase maken."
LOOP_CONN="host=$PGHOST port=$PGPORT dbname=$PRE_DB user=$PGUSER"
DBLINK_ERR="$(psql -X -q -At -v ON_ERROR_STOP=1 -d "$PRE_DB" -v conn="$LOOP_CONN" 2>&1 >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS dblink;
SELECT dblink_connect('preflight', :'conn');
SELECT dblink_disconnect('preflight');
SQL
)" || { q -c "DROP DATABASE IF EXISTS $PRE_DB" >/dev/null 2>&1; die "dblink kan niet terugverbinden via '$LOOP_CONN' (nodig voor de gelijktijdigheidsbewijzen): $DBLINK_ERR"; }
q -c "DROP DATABASE IF EXISTS $PRE_DB" >/dev/null || die "kan de wegwerpdatabase niet opruimen."

# ── 3. De harnassen: elke submap met een run-proof.sh ────────────────────────
shopt -s nullglob
HARNESSES=("$TESTS"/*/run-proof.sh)
[ "${#HARNESSES[@]}" -gt 0 ] || die "geen enkel harnas gevonden onder $TESTS."

WORK="$(mktemp -d "${TMPDIR:-/tmp}/db-proofs.XXXXXX")" || die "mktemp mislukt."
LOGS="${DB_PROOFS_LOG_DIR:-$WORK/logs}"
mkdir -p "$LOGS" "$WORK/tmp" || die "kan $LOGS niet aanmaken."
trap 'rm -rf "$WORK/tmp"' EXIT

echo "DB-bewijzen: ${#HARNESSES[@]} harnassen, PostgreSQL $SERVER_VERSION via $PGHOST:$PGPORT als $PGUSER"
echo "Logs: $LOGS"

ROWS=()
FAILED=()
TOTAL_N=0
TOTAL_M=0
START_ALL=$(date +%s)

for script in "${HARNESSES[@]}"; do
  name="$(basename "$(dirname "$script")")"
  log="$LOGS/$name.log"
  printf '… %s\n' "$name"
  start=$(date +%s)
  # Elk harnas krijgt een eigen, lege TMPDIR (mktemp in bank-release-hold-history).
  mkdir -p "$WORK/tmp/$name"
  ( cd "$REPO" && TMPDIR="$WORK/tmp/$name" bash "$script" ) > "$log" 2>&1
  rc=$?
  secs=$(( $(date +%s) - start ))

  # Samenvatting(en): "N van M bewijzen geslaagd" (één per database).
  read -r n m lines < <(grep -oE '[0-9]+ van [0-9]+ bewijzen geslaagd' "$log" \
    | awk '{ n += $1; m += $3; c++ } END { printf "%d %d %d\n", n, m, c }')
  pass_rows=$(grep -cE '^[[:space:]]*PASS[[:space:]]*\|' "$log")
  fail_rows=$(grep -cE '^[[:space:]]*FAIL[[:space:]]*\|' "$log")
  fail_words=$(grep -cw 'FAIL' "$log")
  missing=$(grep -c 'ONTBREEKT' "$log")

  reasons=()
  [ "$rc" -eq 0 ] || reasons+=("exitcode $rc")
  [ "$lines" -gt 0 ] || reasons+=("geen samenvatting")
  [ "$fail_words" -eq 0 ] || reasons+=("$fail_words× FAIL")
  [ "$missing" -eq 0 ] || reasons+=("$missing× ONTBREEKT")
  if [ "$lines" -gt 0 ]; then
    [ "$m" -gt 0 ] || reasons+=("0 bewijzen")
    [ "$n" -eq "$m" ] || reasons+=("$n van $m geslaagd")
    [ "$pass_rows" -eq "$n" ] || reasons+=("$pass_rows PASS-regels ≠ $n geslaagd")
    [ $((pass_rows + fail_rows)) -eq "$m" ] || reasons+=("$((pass_rows + fail_rows)) uitslagregels ≠ $m bewijzen")
  fi

  if [ "${#reasons[@]}" -eq 0 ]; then
    verdict="groen"
  else
    verdict="ROOD: $(printf '%s; ' "${reasons[@]}")"
    verdict="${verdict%; }"
    FAILED+=("$name")
  fi
  TOTAL_N=$((TOTAL_N + n))
  TOTAL_M=$((TOTAL_M + m))
  ROWS+=("$(printf '%s\t%s\t%s\t%s\t%s\t%s/%s\t%s' "$name" "$rc" "$secs" "$pass_rows" "$fail_rows" "$n" "$m" "$verdict")")
done

TOTAL_SECS=$(( $(date +%s) - START_ALL ))
OK_COUNT=$(( ${#HARNESSES[@]} - ${#FAILED[@]} ))

# ── 4. De tabel ──────────────────────────────────────────────────────────────
echo
{
  printf 'harnas\trc\tduur(s)\tPASS\tFAIL\tbewijzen\tuitslag\n'
  printf '%s\n' "${ROWS[@]}"
  printf 'TOTAAL\t-\t%s\t-\t-\t%s/%s\t%s van %s harnassen groen\n' "$TOTAL_SECS" "$TOTAL_N" "$TOTAL_M" "$OK_COUNT" "${#HARNESSES[@]}"
} | tee "$LOGS/summary.tsv" | align

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### DB-bewijzen (PostgreSQL $SERVER_VERSION)"
    echo
    echo "| harnas | rc | duur (s) | PASS | FAIL | bewijzen | uitslag |"
    echo "|---|---|---|---|---|---|---|"
    for row in "${ROWS[@]}"; do
      IFS=$'\t' read -r c1 c2 c3 c4 c5 c6 c7 <<< "$row"
      echo "| $c1 | $c2 | $c3 | $c4 | $c5 | $c6 | $c7 |"
    done
    echo "| **totaal** | | $TOTAL_SECS | | | **$TOTAL_N/$TOTAL_M** | **$OK_COUNT van ${#HARNESSES[@]} groen** |"
  } >> "$GITHUB_STEP_SUMMARY"
fi

# ── 5. Bij rood: de oorzaak zichtbaar maken en falen ─────────────────────────
if [ "${#FAILED[@]}" -gt 0 ]; then
  for name in "${FAILED[@]}"; do
    log="$LOGS/$name.log"
    echo
    echo "════ $name — FAIL/ONTBREEKT/ERROR-regels"
    grep -nE '(^|[^[:alnum:]_])FAIL([^[:alnum:]_]|$)|ONTBREEKT|ERROR' "$log" | head -40
    echo "════ $name — laatste 40 regels van $log"
    tail -n 40 "$log"
  done
  echo
  echo "DB-bewijzen ROOD: ${#FAILED[@]} van ${#HARNESSES[@]} harnassen gefaald (${FAILED[*]})."
  exit 1
fi

echo
echo "DB-bewijzen groen: ${#HARNESSES[@]} van ${#HARNESSES[@]} harnassen, $TOTAL_N van $TOTAL_M bewijzen, ${TOTAL_SECS} s."
