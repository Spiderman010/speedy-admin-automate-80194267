#!/usr/bin/env bash
# Real-PostgreSQL proof for 20261021170000_btw_en_nan_validatie_in_schrijvers.sql
# (P4: btw- en NaN-validatie in de schrijvers, fail-closed), against the REAL
# writers and the real migration chain incl. PR 0, PR 1, PR 2, the hold-fix and
# the import fingerprint.
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL. Uses libpq environment only (PGHOST, PGPORT,
# PGUSER).
#
# Usage (with a local cluster already running; needs the dblink extension):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/writer-vat-nan-validation/run-proof.sh
#
# Order:
#   build-chain.sh          the REAL chain … 20261020120000 + fixtures (corrections)
#   helpers.sql             P4 helpers (seeding as owner, posting as `authenticated`)
#   pre.sql                 NEGATIVE CONTROLS: without the migration the bugs exist
#                           (NULL btw → 0%, vrijgesteld → voorbelasting, NaN in the
#                           ledger, sub-cent lines silently rounded); the existing
#                           state incl. NaN rows from before the CHECK; PRE blocks
#   preflight.sql           in full, in a READ ONLY transaction
#   TOO EARLY               without PR 2 the whole migration refuses and changes nothing
#   20261021170000 (TWICE)  the migration under test, idempotent
#   postcheck.sql           blocks captured; in full, in a READ ONLY transaction
#   proof.sql               catalogue, rollout material, E-06, F1c-N1, A3-01, A3-16,
#                           roles/tenant, posting lock
#   rollback.sql (TWICE) + after-rollback.sql
#   re-apply as ONE execution (SET lock_timeout + migration) + final.sql
#
# Mutation testing: point P4_MIGRATION at a modified copy of the migration (and
# P4_ROLLBACK at a rollback.sql whose guard accepts the mutant's bodies).

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${P4_PROOF_DB:-p4vatnanproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
M="${P4_MIGRATION:-$MIG/20261021170000_btw_en_nan_validatie_in_schrijvers.sql}"
ROLLOUT="$REPO/supabase/rollout/20261021170000_btw_en_nan_validatie_in_schrijvers"
RB="${P4_ROLLBACK:-$ROLLOUT/rollback.sql}"

: "${PGHOST:?set PGHOST}"

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

# Eén blok uit een rolloutbestand, letterlijk: van de kopregel die met _kop
# begint tot en met de eerste regel (geen commentaar) die op ';' eindigt.
block() {
  local out
  out="$(awk -v h="$2" 'index($0, h) == 1 { f = 1 } f { print } f && !/^--/ && /;[[:space:]]*$/ { exit }' "$1")"
  [ -n "$out" ] || { echo "blok '$2' niet gevonden in $1" >&2; exit 1; }
  printf '%s\n' "$out"
}

# Een bestand als ÉÉN simple-query-bericht, zoals de SQL editor (één impliciete
# transactie): \gexec stuurt de hele tekst in één keer.
one_exec() {
  ONE_FILE="$2" psql -X -q -At -v ON_ERROR_STOP=1 -d "$1" 2>&1 <<'SQL'
\set u `cat "$ONE_FILE"`
SELECT :'u' \gexec
SQL
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PRE="$ROLLOUT/preflight.sql"
POST="$ROLLOUT/postcheck.sql"
PRE1="$(block "$PRE" '-- ── PRE 1.')"
PRE2="$(block "$PRE" '-- ── PRE 2.')"
PRE3="$(block "$PRE" '-- ── PRE 3.')"
PRE4="$(block "$PRE" '-- ── PRE 4.')"
PRE5="$(block "$PRE" '-- ── PRE 5.')"
PRE6="$(block "$PRE" '-- ── PRE 6.')"
POST1="$(block "$POST" '-- ── POST 1.')"
POST2="$(block "$POST" '-- ── POST 2.')"
POST3="$(block "$POST" '-- ── POST 3.')"
POST4="$(block "$POST" '-- ── POST 4.')"
PREREQ="$(sed -n '/^DO \$migratie\$$/,/^\$migratie\$;$/p' "$M")"
[ -n "$PREREQ" ] || { echo "voorwaardencontrole niet gevonden" >&2; exit 1; }
RBGUARD="$(sed -n '/^DO \$rollback\$$/,/^\$rollback\$;$/p' "$RB")"
[ -n "$RBGUARD" ] || { echo "rollbackbewaking niet gevonden" >&2; exit 1; }

# ── de keten, de hulpfuncties, de toestand van vóór ─────────────────────────
"$HERE/build-chain.sh" "$DB"
run -f "$HERE/helpers.sql"                                                          > /dev/null
run -v pre1="$PRE1" -v pre2="$PRE2" -v pre3="$PRE3" -v pre4="$PRE4" -v pre5="$PRE5" -v pre6="$PRE6" \
    -f "$HERE/pre.sql"                                                              > /dev/null

# De volledige preflight, read-only.
RO=ok
if ! OUT="$(PGOPTIONS="$PGOPTIONS -c default_transaction_read_only=on" psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$PRE" 2>&1 >/dev/null)"; then
  RO="fout in preflight.sql: $OUT"
fi

# ── te vroeg: zonder PR 2 weigert de hele migratie en verandert niets ───────
run -c "ALTER FUNCTION public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text) RENAME TO reclassify_tijdelijk_weg;" > /dev/null
if ERR="$(run -f "$M" 2>&1 >/dev/null)"; then ERR="GEEN weigering"; fi
run -v err="$ERR" > /dev/null <<'SQL'
SELECT proof.put('te_vroeg_err', :'err');
SELECT proof.put('te_vroeg_md5', proof.p4_md5s());
SELECT proof.put('te_vroeg_constraints', proof.p4_constraints());
SQL
run -c "ALTER FUNCTION public.reclassify_tijdelijk_weg(uuid,uuid,uuid,numeric,uuid,text,text) RENAME TO reclassify_bank_transaction;" > /dev/null

# ── de migratie onder test, TWEE keer ───────────────────────────────────────
run -f "$M"                                                                         > /dev/null
run -c "SELECT proof.put('md5_na_eerste', proof.p4_md5s()), proof.put('constraints_na_eerste', proof.p4_constraints());" > /dev/null
run -f "$M"                                                                         > /dev/null

# POST direct na de migratie (vóór de bewijzen iets boeken), en de volledige postcheck read-only.
run -v post1="$POST1" -v post2="$POST2" -v post3="$POST3" -v post4="$POST4" > /dev/null <<'SQL'
SELECT proof.put('post1_all_true', proof.p4_all_true(:'post1')::text);
SELECT proof.put('post2_all_true', proof.p4_all_true(:'post2')::text);
SELECT proof.put('post3_all_true', proof.p4_all_true(:'post3')::text);
SELECT proof.put('post4', proof.p4_rows(:'post4'));
SQL
if ! OUT="$(PGOPTIONS="$PGOPTIONS -c default_transaction_read_only=on" psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$POST" 2>&1 >/dev/null)"; then
  if [ "$RO" = ok ]; then RO="fout in postcheck.sql: $OUT"; else RO="$RO; fout in postcheck.sql: $OUT"; fi
fi
run -v ro="$RO" > /dev/null <<'SQL'
SELECT proof.put('ro', :'ro');
SQL

run -v prereq="$PREREQ" -v pre5="$PRE5" -f "$HERE/proof.sql"                      > /dev/null

# ── de rollback, TWEE keer ──────────────────────────────────────────────────
run -v pre6="$PRE6" > /dev/null <<'SQL'
SELECT proof.put('pre6_voor_rollback', proof.p4_rows(:'pre6'));
SQL
run -f "$RB"                                                                        > /dev/null
run -f "$RB"                                                                        > /dev/null
run -v rbguard="$RBGUARD" -v pre6="$PRE6" -f "$HERE/after-rollback.sql"           > /dev/null

# ── en weer vooruit, als één uitvoering zoals in de SQL editor ──────────────
{ printf "SET lock_timeout = '5s';\n"; cat "$M"; } > "$TMP/apply.sql"
if ! OUT="$(one_exec "$DB" "$TMP/apply.sql")"; then
  echo "opnieuw toepassen als één uitvoering faalde: $OUT" >&2
  exit 1
fi
run -f "$HERE/final.sql"                                                            > /dev/null

# ── uitslag ─────────────────────────────────────────────────────────────────
psql -q -d "$DB" -P pager=off -c "
  SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name,
         left(regexp_replace(coalesce(detail, ''), '\s+', ' ', 'g'), 110) AS detail
  FROM proof.result ORDER BY ok, n;"
psql -q -d "$DB" -t -A -c "SELECT 'ONTBREEKT: ' || n FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n) ORDER BY n;"
psql -q -d "$DB" -t -A -c "SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"

FAILED=$(psql -q -d "$DB" -t -A -c "
  SELECT count(*) FILTER (WHERE NOT ok)
       + (SELECT count(*) FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n))
  FROM proof.result;")
if [ "$FAILED" = "0" ]; then
  echo "PASS"
else
  echo "FAIL: $FAILED"
  exit 1
fi
