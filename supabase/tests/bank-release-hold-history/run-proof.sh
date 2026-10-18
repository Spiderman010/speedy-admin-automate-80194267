#!/usr/bin/env bash
# Real-PostgreSQL proof for 20261018180000: the D12 release hold also covers a
# bank line with a proven pre-PR-1 history (booked, manually reversed on the
# transaction date, marker removed, booked again) — while every unexplained
# group keeps the PR 1 behaviour and the rollout checks STOP on it. Against the
# REAL writers and the real migration chain incl. PR 0, PR 1 and PR 2.
#
# THROWAWAY DATABASES ONLY. This script CREATEs and DROPs databases. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL.
#
# Usage (with a local cluster already running; needs the dblink extension and
# git, for the original PRE 4 of main 3669a94):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/bank-release-hold-history/run-proof.sh
#
# Database 1 (hold-fix proofs):
#   bootstrap, the REAL chain … 20261017120000 (PR 0), the real trigger bodies,
#   ../bank-transaction-corrections/fixtures.sql (PR 1), ../bank-correction-booking-description/helpers.sql (PR 2)
#   helpers.sql             history builders, forging of corrupt history, app paths
#   history.sql             history of BEFORE PR 1 with the real writers: 9 proven
#                           historical reversals, 11 corrupt groups, 2 plain lines
#   pre.sql                 P: the rollout checks before PR 1, literally (PRE 4, PRE 4b, PRE B6)
#   20261018120000 (PR 1) + 20261018150000 (PR 2)
#   gap.sql                 N: NEGATIVE CONTROL — without the fix a released historical line can be re-booked
#   snapshot.sql            baseline of catalogue and data
#   20261018180000 (TWICE)  the migration under test, idempotent
#   proof.sql               catalogue, prerequisite check, helper verdicts, POST 8/POST C literally, D12
#   corrections.sql         regular corrections (S1–S3, unchanged) on historical and plain lines
#   concurrency.sql         races with two real sessions
#   window.sql              rollback fix → PR 2 → PR 1, booking in the window, re-apply all three (F2, (8))
#   final.sql               global invariants
# Database 2 (sequential order, production-like history): POST 8 per state.
# Database 3 (the atomic production plan, production-like history with the
#   known group ids): every PRE and POST block literally, one execution of
#   M1+M2+M3, failure atomicity and invisibility of the intermediate state.
#
# Mutation testing: point HOLD_FIX_MIGRATION at a modified copy of the migration
# (and HOLD_FIX_ROLLBACK at a rollback.sql whose guard accepts the mutant's body).

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${HOLD_FIX_PROOF_DB:-holdfixproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
PR1="$MIG/20261018120000_add_bank_transaction_corrections.sql"
PR2="$MIG/20261018150000_keep_bank_description_on_correction.sql"
M="${HOLD_FIX_MIGRATION:-$MIG/20261018180000_refine_release_hold_for_settled_history.sql}"
R1="$REPO/supabase/rollout/20261018120000_add_bank_transaction_corrections"
R2="$REPO/supabase/rollout/20261018150000_keep_bank_description_on_correction"
R3="$REPO/supabase/rollout/20261018180000_refine_release_hold_for_settled_history"
RB="${HOLD_FIX_ROLLBACK:-$R3/rollback.sql}"

CONN="host=${PGHOST:?set PGHOST} port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

# Eén blok uit een rolloutbestand, letterlijk: van de kopregel die met _kop
# begint tot en met de eerste regel (geen commentaar) die op ';' eindigt.
block() {
  local out
  out="$(awk -v h="$2" 'index($0, h) == 1 { f = 1 } f { print } f && !/^--/ && /;[[:space:]]*$/ { exit }' "$1")"
  [ -n "$out" ] || { echo "blok '$2' niet gevonden in $1" >&2; exit 1; }
  printf '%s\n' "$out"
}

# De keten tot en met PR 0, de echte triggerlichamen, de fixtures van PR 1 en PR 2.
build() {
  local db="$1"
  psql -q -c "DROP DATABASE IF EXISTS $db;" -c "CREATE DATABASE $db;" postgres >/dev/null
  psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$HERE/../opening-balance/bootstrap.sql"                      > /dev/null
  psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$HERE/../bank-direct-allocation-guard/bootstrap-sources.sql" > /dev/null
  local f
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
    psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$MIG/$f.sql"                                               > /dev/null
  done
  # De echte lichamen van de twee triggerfuncties die de bootstrap vereenvoudigd nabouwt.
  local real
  real="$(sed -n '/^CREATE OR REPLACE FUNCTION public.update_updated_at_column()/,/^\$\$ LANGUAGE plpgsql SET search_path = public;/p' \
            "$MIG/20260411182021_ce126469-1948-4a6f-947d-ad6dd95764cb.sql")
$(sed -n '/^CREATE OR REPLACE FUNCTION public.set_organization_id()/,/^\$function\$;/p' \
            "$MIG/20260616014119_379a0719-29c0-4ba7-a513-06777db1dbc3.sql")"
  [ -n "$real" ] || { echo "triggerfuncties niet gevonden" >&2; exit 1; }
  psql -q -v ON_ERROR_STOP=1 -d "$db" -c "$real"                                                       > /dev/null
  psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$HERE/../bank-transaction-corrections/fixtures.sql"          > /dev/null
  # De hulpfuncties van PR 2 noemen de gebeurtenistabel van PR 1, die er hier nog
  # niet is (de geschiedenis is van vóór PR 1): lichamen pas bij aanroep toetsen.
  PGOPTIONS="$PGOPTIONS -c check_function_bodies=off" \
  psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$HERE/../bank-correction-booking-description/helpers.sql"    > /dev/null
  psql -q -v ON_ERROR_STOP=1 -d "$db" -f "$HERE/helpers.sql"                                           > /dev/null
}

run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

# Een bestand als ÉÉN simple-query-bericht uitvoeren, zoals de SQL editor:
# \gexec stuurt de hele tekst in één keer (libpq PQexec), zonder haar op te
# delen — anders dan psql -f, dat opdracht voor opdracht stuurt. (psql -c kan
# niet: het bestand is groter dan één argument mag zijn.) Drukt de uitkomsten
# af, de laatste regel is de laatste uitkomst; of de foutmelding.
one_exec() {
  ONE_FILE="$2" psql -X -q -At -d "$1" 2>&1 <<'SQL'
\set u `cat "$ONE_FILE"`
SELECT :'u' \gexec
SQL
}
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── de rolloutblokken, letterlijk ───────────────────────────────────────────
PRE4_OUD="$(git -C "$REPO" show 3669a94:supabase/rollout/20261018120000_add_bank_transaction_corrections/preflight.sql \
            | awk 'index($0, "-- ── PRE 4.") == 1 { f = 1 } f { print } f && !/^--/ && /;[[:space:]]*$/ { exit }')"
[ -n "$PRE4_OUD" ] || { echo "oorspronkelijke PRE 4 niet gevonden" >&2; exit 1; }
POST8_OUD="$(git -C "$REPO" show 3669a94:supabase/rollout/20261018120000_add_bank_transaction_corrections/postcheck.sql \
             | awk 'index($0, "-- ── POST 8.") == 1 { f = 1 } f { print } f && !/^--/ && /;[[:space:]]*$/ { exit }')"
[ -n "$POST8_OUD" ] || { echo "oorspronkelijke POST 8 niet gevonden" >&2; exit 1; }
PRE4="$(block "$R1/preflight.sql" '-- ── PRE 4.')"
PRE4B="$(block "$R1/preflight.sql" '-- ── PRE 4b.')"
PREB6="$(block "$R3/preflight.sql" '-- ── PRE B6.')"
POST8="$(block "$R1/postcheck.sql" '-- ── POST 8.')"
POSTC4="$(block "$R3/postcheck.sql" '-- ── POST C4.')"
POSTC5="$(block "$R3/postcheck.sql" '-- ── POST C5.')"

# ── database 1 ──────────────────────────────────────────────────────────────
build "$DB"
run -f "$HERE/history.sql"                                                         > /dev/null
run -v pre4_oud="$PRE4_OUD" -v pre4="$PRE4" -v pre4b="$PRE4B" -v preb6="$PREB6" -f "$HERE/pre.sql" > /dev/null

# PR 1, en direct daarna de oorspronkelijke en de nieuwe POST 8.
run -f "$PR1"                                                                      > /dev/null
run -v post8_oud="$POST8_OUD" -v post8="$POST8" > /dev/null <<'SQL'
SELECT proof.capture('post8_oud_m1', :'post8_oud');
SELECT proof.capture('post8_m1', :'post8');
SQL
run -f "$PR2"                                                                      > /dev/null

# Negatieve controle: de tussentoestand.
run -f "$HERE/gap.sql"                                                             > /dev/null
run -f "$HERE/snapshot.sql"                                                        > /dev/null

# De migratie onder test, TWEE keer.
run -f "$M"                                                                        > /dev/null
run -c "SELECT proof.put('catalog_after_first_fix', proof.catalog_digest());"     > /dev/null
run -f "$M"                                                                        > /dev/null

PREREQ="$(sed -n '/^DO \$migratie\$$/,/^\$migratie\$;$/p' "$M")"
[ -n "$PREREQ" ] || { echo "voorwaardencontrole niet gevonden" >&2; exit 1; }
run -v prereq="$PREREQ" -v post8="$POST8" -v postc4="$POSTC4" -v postc5="$POSTC5" -f "$HERE/proof.sql" > /dev/null
run -f "$HERE/corrections.sql"                                                     > /dev/null
run -v conn="$CONN" -f "$HERE/concurrency.sql"                                     > /dev/null

# De rollback in de gedocumenteerde volgorde: de fix (TWEE keer), PR 2 (TWEE keer), PR 1 (TWEE keer).
run -c "SELECT proof.put('digest_before_rollback', proof.digest()), proof.put('rest_before_rollback', proof.rest_digest());" > /dev/null
# PR 2 terugdraaien terwijl de fix er nog is: moet weigeren (de volgorde is fix → PR 2 → PR 1).
if PR2RB_ERR="$(run -f "$R2/rollback.sql" 2>&1 >/dev/null)"; then PR2RB_ERR="GEEN weigering"; fi
run -f "$RB"                                                                       > /dev/null
run -f "$RB"                                                                       > /dev/null
RBGUARD="$(sed -n '/^DO \$rollback\$$/,/^\$rollback\$;$/p' "$RB")"
[ -n "$RBGUARD" ] || { echo "rollbackbewaking niet gevonden" >&2; exit 1; }
run -v rbguard="$RBGUARD" -v pr2rb_err="$PR2RB_ERR" -f "$HERE/rollback-fix.sql"   > /dev/null
run -f "$R2/rollback.sql"                                                          > /dev/null
run -f "$R2/rollback.sql"                                                          > /dev/null
PR1_ROLLBACK="$(sed -n '/^-- ROLLBACK-BEGIN$/,/^-- ROLLBACK-END$/p' "$PR1" | grep -v '^-- ROLLBACK-' | sed 's/^-- \{0,1\}//')"
[ -n "$PR1_ROLLBACK" ] || { echo "rollbackblok van PR 1 niet gevonden" >&2; exit 1; }
run -c "$PR1_ROLLBACK"                                                             > /dev/null
run -c "$PR1_ROLLBACK"                                                             > /dev/null
run -f "$HERE/window.sql"                                                          > /dev/null

# En weer vooruit, in de volgorde van de uitrol.
run -f "$PR1"                                                                      > /dev/null
run -f "$PR2"                                                                      > /dev/null
run -f "$M"                                                                        > /dev/null
run -v post8="$POST8" -v pre4b="$PRE4B" -f "$HERE/reapply.sql"                    > /dev/null
run -f "$HERE/final.sql"                                                           > /dev/null

# ── database 2: de vier toestanden, los na elkaar (productiegelijk) ──────────
DBS="$DB"
if [ "${HOLD_FIX_SKIP_PLAN:-0}" != "1" ]; then
DB2="${DB}_seq"; DBS="$DBS $DB2"
run2() { psql -q -v ON_ERROR_STOP=1 -d "$DB2" "$@"; }
build "$DB2"
run2 -v known=0 -f "$HERE/prodlike.sql"                                            > /dev/null
run2 -v pre4="$PRE4" -v pre4b="$PRE4B" > /dev/null <<'SQL'
SELECT proof.capture('z_pre4', :'pre4');
SELECT proof.capture('z_pre4b', :'pre4b');
SQL
run2 -f "$PR1"                                                                     > /dev/null
run2 -v post8="$POST8" > /dev/null <<'SQL'
SELECT proof.capture('z_post8_m1', :'post8');
SELECT proof.put('z_catalog_m1', md5(string_agg(oid::regprocedure::text || md5(prosrc), ',' ORDER BY oid::regprocedure::text)))
FROM pg_proc WHERE pronamespace = 'public'::regnamespace;
SQL
# De fix vóór PR 2: moet weigeren.
if ERR="$(run2 -f "$M" 2>&1 >/dev/null)"; then ERR="GEEN weigering"; fi
run2 -v err="$ERR" > /dev/null <<'SQL'
SELECT proof.put('z_fix_te_vroeg', :'err');
SELECT proof.put('z_catalog_na_weigering', md5(string_agg(oid::regprocedure::text || md5(prosrc), ',' ORDER BY oid::regprocedure::text)))
FROM pg_proc WHERE pronamespace = 'public'::regnamespace;
SQL
run2 -f "$PR2"                                                                     > /dev/null
run2 -v post8="$POST8" > /dev/null <<'SQL'
SELECT proof.capture('z_post8_m2', :'post8');
SELECT proof.put('z_gat', proof.gap_probe(10));
SQL
run2 -f "$M"                                                                       > /dev/null
run2 -v post8="$POST8" -v postc4="$POSTC4" -v postc5="$POSTC5" > /dev/null <<'SQL'
SELECT proof.capture('z_post8_m3', :'post8');
SELECT proof.capture('z_postc4', :'postc4');
SELECT proof.capture('z_postc5', :'postc5');
SQL
run2 -f "$HERE/seq.sql"                                                            > /dev/null

# ── database 3: het uitvoerplan (productiegelijk, met de productie-id's) ────
DB3="${DB}_plan"; DB4="${DB}_zicht"; DBL="${DB}_los"; DBS="$DBS $DB3 $DB4"
run3() { psql -q -v ON_ERROR_STOP=1 -d "$DB3" "$@"; }
U="$R3/uitvoering.sql"
build "$DB3"
run3 -v known=1 -f "$HERE/prodlike.sql"                                            > /dev/null

# 1. De PRE's volledig, read-only.
RO=ok
for f in "$R1/preflight.sql" "$R3/preflight.sql"; do
  if ! OUT="$(PGOPTIONS="$PGOPTIONS -c default_transaction_read_only=on" psql -X -q -v ON_ERROR_STOP=1 -d "$DB3" -f "$f" 2>&1 >/dev/null)"; then
    RO="fout in $f: $OUT"
  fi
done
run3 -v ro="$RO" \
     -v pre1="$(block "$R1/preflight.sql" '-- ── PRE 1.')" -v pre2="$(block "$R1/preflight.sql" '-- ── PRE 2.')" \
     -v pre4="$PRE4" -v pre4b="$PRE4B" -v pre6="$(block "$R1/preflight.sql" '-- ── PRE 6.')" \
     -v pre7="$(block "$R1/preflight.sql" '-- ── PRE 7.')" -v pre8="$(block "$R1/preflight.sql" '-- ── PRE 8.')" \
     -v pre11="$(block "$R1/preflight.sql" '-- ── PRE 11.')" \
     -v b1="$(block "$R3/preflight.sql" '-- ── PRE B1.')" -v b2="$(block "$R3/preflight.sql" '-- ── PRE B2.')" \
     -v b3="$(block "$R3/preflight.sql" '-- ── PRE B3.')" -v b4="$(block "$R3/preflight.sql" '-- ── PRE B4.')" \
     -v b5="$(block "$R3/preflight.sql" '-- ── PRE B5.')" -v b6="$PREB6" \
     -v b7="$(block "$R3/preflight.sql" '-- ── PRE B7.')" -v b8="$(block "$R3/preflight.sql" '-- ── PRE B8.')" > /dev/null <<'SQL'
SELECT proof.put('a_pre_readonly', :'ro');
SELECT proof.capture('a_pre1', :'pre1'), proof.capture('a_pre2', :'pre2'), proof.capture('a_pre4', :'pre4'),
       proof.capture('a_pre4b', :'pre4b'), proof.capture('a_pre6', :'pre6'), proof.capture('a_pre7', :'pre7'),
       proof.capture('a_pre8', :'pre8'), proof.capture('a_pre11', :'pre11');
SELECT proof.capture('a_b1', :'b1'), proof.capture('a_b2', :'b2'), proof.capture('a_b3', :'b3'), proof.capture('a_b4', :'b4'),
       proof.capture('a_b5', :'b5'), proof.capture('a_b6', :'b6'), proof.capture('a_b7', :'b7'), proof.capture('a_b8', :'b8');
SELECT proof.put('a_catalog_pre', proof.catalog_digest()), proof.put('a_digest_pre', proof.digest());
SQL

# PRE B9: de proef op geneste dollar-aanhalingstekens, als één bericht (zoals de editor) en via psql -f.
awk 'index($0, "-- ── PRE B9.") == 1 { f = 1 } f && !/^--/ { print }' "$R3/preflight.sql" > "$TMP/b9.sql"
[ "$(grep -c . "$TMP/b9.sql")" = "5" ] || { echo "PRE B9 niet gevonden" >&2; exit 1; }
B9_EEN="$(one_exec "$DB3" "$TMP/b9.sql" | tail -1)"
B9_F="$(psql -X -q -At -d "$DB3" -f "$TMP/b9.sql" 2>&1 | tail -1)"
# Een editor die knipt bij elke regel die op ';' eindigt, en elk stuk los verstuurt.
B9_KNIP="$(awk '{ buf = buf $0 "\n" } /;[[:space:]]*$/ { printf "%s%c", buf, 0; buf = "" }' "$TMP/b9.sql" \
           | xargs -0 -I{} psql -X -q -At -d "$DB3" -c {} 2>&1 || true)"
run3 -v een="$B9_EEN" -v f="$B9_F" -v knip="$B9_KNIP" > /dev/null <<'SQL'
SELECT proof.put('a_b9_een', :'een'), proof.put('a_b9_f', :'f'), proof.put('a_b9_knip', :'knip');
SQL

# Kopieën, vóór elke poging: voor het zichtbaarheidsbewijs en voor opdracht-voor-opdracht.
psql -q -c "DROP DATABASE IF EXISTS $DB4;" -c "CREATE DATABASE $DB4 TEMPLATE $DB3;" postgres >/dev/null
psql -q -c "DROP DATABASE IF EXISTS $DBL;" -c "CREATE DATABASE $DBL TEMPLATE $DB3;" postgres >/dev/null

# De gesaboteerde kopie: alleen de eindcontrole IN de DO-opdracht (de eerste
# vermelding van de md5 van de hulpfunctie) verwacht een andere waarde.
HELPER_MD5="$(sed -n "s/.*md5(p.prosrc) = '\([0-9a-f]\{32\}\)', false).*/\1/p" "$R3/postcheck.sql" | head -1)"
[ -n "$HELPER_MD5" ] || { echo "md5 van de hulpfunctie niet gevonden in POST C1" >&2; exit 1; }
sed "0,/IS NOT DISTINCT FROM '$HELPER_MD5'/s//IS NOT DISTINCT FROM 'gesaboteerd'/" "$U" > "$TMP/sabotage.sql"
cmp -s "$U" "$TMP/sabotage.sql" && { echo "sabotage niet aangebracht" >&2; exit 1; }
[ "$(diff "$U" "$TMP/sabotage.sql" | grep -c '^[<>]')" = "2" ] || { echo "sabotage raakt meer dan één regel" >&2; exit 1; }

# 2. Opdracht voor opdracht, doorgaan na een fout, lock_timeout al 5s op de sessie, gesaboteerd.
SPLIT_OUT="$(PGOPTIONS="$PGOPTIONS -c lock_timeout=5s" psql -X -q -At -d "$DB3" -f "$TMP/sabotage.sql" 2>&1 || true)"
SPLIT_LAST="$(printf '%s\n' "$SPLIT_OUT" | grep -v '^psql:' | tail -1)"
run3 -v err="$SPLIT_OUT" -v last="$SPLIT_LAST" > /dev/null <<'SQL'
SELECT proof.put('a_split', :'err'), proof.put('a_split_last', :'last'), proof.put('a_split_catalog', proof.catalog_digest());
SQL

# 3. Eén uitvoering terwijl een andere sessie een grendel op bank_transactions vasthoudt.
PGAPPNAME=houder psql -X -q -d "$DB3" -c "BEGIN; LOCK TABLE public.bank_transactions IN ROW EXCLUSIVE MODE; SELECT pg_sleep(20); COMMIT;" >/dev/null 2>&1 &
HOLDER=$!
for _ in $(seq 1 100); do
  [ "$(psql -X -At -d "$DB3" -c "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.application_name = 'houder' AND l.relation = 'public.bank_transactions'::regclass AND l.granted")" = "1" ] && break
  psql -X -q -At -d "$DB3" -c "SELECT pg_sleep(0.1)" >/dev/null
done
ERR="$(one_exec "$DB3" "$U")"
psql -X -q -At -d "$DB3" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'houder'" >/dev/null
wait "$HOLDER" || true
run3 -v err="$ERR" > /dev/null <<'SQL'
SELECT proof.put('a_lock', :'err'), proof.put('a_lock_catalog', proof.catalog_digest());
SQL

# 4. Een fout ná de drie migraties: de eindcontrole gesaboteerd (alleen hier).
ERR="$(one_exec "$DB3" "$TMP/sabotage.sql")"
run3 -v err="$ERR" > /dev/null <<'SQL'
SELECT proof.put('a_sabotage', :'err'), proof.put('a_sabotage_catalog', proof.catalog_digest());
SQL

# 4b. Een afgekapte plak: halverwege de tekst van PR 2.
CUT=$(( $(grep -n '^  -- ═══ 20261018150000_keep_bank_description_on_correction.sql ═══$' "$U" | cut -d: -f1) + 200 ))
head -n "$CUT" "$U" > "$TMP/afgekapt.sql"
ERR="$(one_exec "$DB3" "$TMP/afgekapt.sql")"
run3 -v err="$ERR" > /dev/null <<'SQL'
SELECT proof.put('a_kort', :'err'), proof.put('a_kort_catalog', proof.catalog_digest()), proof.put('a_digest_na_pogingen', proof.digest());
SQL

# 5. Eén uitvoering, zoals de editor: één simple-query-bericht = één transactie.
UITKOMST="$(one_exec "$DB3" "$U" | tail -1)"
# … en op een kopie opdracht voor opdracht (psql -f): ook één DO-opdracht.
LOS="$(psql -X -q -At -d "$DBL" -f "$U" 2>/dev/null | tail -1)"
run3 -v u="$UITKOMST" -v los="$LOS" > /dev/null <<'SQL'
SELECT proof.put('a_uitkomst', :'u'), proof.put('a_los_uitkomst', :'los');
SQL

# 6. De POST's volledig, read-only, en elk blok vastgelegd.
RO=ok
for f in "$R1/postcheck.sql" "$R2/postcheck.sql" "$R3/postcheck.sql"; do
  if ! OUT="$(PGOPTIONS="$PGOPTIONS -c default_transaction_read_only=on" psql -X -q -v ON_ERROR_STOP=1 -d "$DB3" -f "$f" 2>&1 >/dev/null)"; then
    RO="fout in $f: $OUT"
  fi
done
run3 -v ro="$RO" \
     -v p1_1="$(block "$R1/postcheck.sql" '-- ── POST 1.')" -v p1_2="$(block "$R1/postcheck.sql" '-- ── POST 2.')" \
     -v p1_3="$(block "$R1/postcheck.sql" '-- ── POST 3.')" -v p1_4="$(block "$R1/postcheck.sql" '-- ── POST 4.')" \
     -v p1_5="$(block "$R1/postcheck.sql" '-- ── POST 5.')" -v p1_6="$(block "$R1/postcheck.sql" '-- ── POST 6.')" \
     -v p1_7="$(block "$R1/postcheck.sql" '-- ── POST 7.')" -v p1_8="$POST8" \
     -v p2_1="$(block "$R2/postcheck.sql" '-- ── POST 1.')" -v p2_2="$(block "$R2/postcheck.sql" '-- ── POST 2.')" \
     -v p2_3="$(block "$R2/postcheck.sql" '-- ── POST 3.')" -v p2_4="$(block "$R2/postcheck.sql" '-- ── POST 4.')" \
     -v c1="$(block "$R3/postcheck.sql" '-- ── POST C1.')" -v c2="$(block "$R3/postcheck.sql" '-- ── POST C2.')" \
     -v c3="$(block "$R3/postcheck.sql" '-- ── POST C3.')" -v c4="$POSTC4" -v c5="$POSTC5" \
     -v c6="$(block "$R3/postcheck.sql" '-- ── POST C6.')" > /dev/null <<'SQL'
SELECT proof.put('a_post_readonly', :'ro');
SELECT proof.capture('p1_post1', :'p1_1'), proof.capture('p1_post2', :'p1_2'), proof.capture('p1_post3', :'p1_3'),
       proof.capture('p1_post4', :'p1_4'), proof.capture('p1_post5', :'p1_5'), proof.capture('p1_post6', :'p1_6'),
       proof.capture('p1_post7', :'p1_7'), proof.capture('p1_post8', :'p1_8');
SELECT proof.capture('p2_post1', :'p2_1'), proof.capture('p2_post2', :'p2_2'), proof.capture('p2_post3', :'p2_3'),
       proof.capture('p2_post4', :'p2_4');
SELECT proof.capture('c_c1', :'c1'), proof.capture('c_c2', :'c2'), proof.capture('c_c3', :'c3'),
       proof.capture('c_c4', :'c4'), proof.capture('c_c5', :'c5'), proof.capture('c_c6', :'c6');
SQL
run3 -f "$HERE/atomic.sql"                                                         > /dev/null

# ── database 4 (kopie van 3 vóór elke poging): niemand ziet de tussentoestand ──
FIXKOP='  -- ═══ 20261018180000_refine_release_hold_for_settled_history.sql ═══'
[ "$(grep -cxF "$FIXKOP" "$U")" = "1" ] || { echo "kop van de fix in uitvoering.sql niet gevonden" >&2; exit 1; }
awk -v kop="$FIXKOP" '$0 == kop { print "  PERFORM pg_sleep(3);" } { print }' "$U" > "$TMP/zicht.sql"
[ "$(diff "$U" "$TMP/zicht.sql" | grep -c '^>')" = "1" ] && [ "$(diff "$U" "$TMP/zicht.sql" | grep -c '^<')" = "0" ] \
  || { echo "de geïnstrumenteerde kopie wijkt meer af dan één regel" >&2; exit 1; }
CONN4="host=${PGHOST} port=${PGPORT:-5432} dbname=$DB4 user=${PGUSER:-postgres}"
ZICHT_FILE="$TMP/zicht.sql" psql -q -v ON_ERROR_STOP=1 -d "$DB4" -v conn="$CONN4" -f "$HERE/visibility.sql" > /dev/null
fi

# ── database 5: transacties die vóór de eerste gebeurtenis begonnen (Codex) ──
DB5="${DB}_xid"; DBS="$DBS $DB5"
run5() { psql -q -v ON_ERROR_STOP=1 -d "$DB5" "$@"; }
build "$DB5"
run5 -v known=0 -f "$HERE/prodlike.sql"                                            > /dev/null
run5 -f "$PR1"                                                                     > /dev/null
run5 -f "$PR2"                                                                     > /dev/null
run5 -f "$M"                                                                       > /dev/null
CONN5="host=${PGHOST} port=${PGPORT:-5432} dbname=$DB5 user=${PGUSER:-postgres}"
run5 -v conn="$CONN5" -v rbfix="$(cat "$RB")" -v rb2="$(cat "$R2/rollback.sql")" -v rb1="$PR1_ROLLBACK" \
     -f "$HERE/prestart.sql"                                                       > /dev/null
run5 -f "$PR1"                                                                     > /dev/null
run5 -f "$PR2"                                                                     > /dev/null
run5 -f "$M"                                                                       > /dev/null
run5 -v post8="$POST8" -v pre4b="$PRE4B" -f "$HERE/xid-check.sql"                > /dev/null

# ── uitslag over alle databases ─────────────────────────────────────────────
TOTAL_FAILED=0
for d in $DBS; do
  echo "═══ $d"
  psql -q -d "$d" -P pager=off -c "
    SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(regexp_replace(coalesce(detail, ''), '\s+', ' ', 'g'), 110) AS detail
    FROM proof.result ORDER BY ok, n;"
  psql -q -d "$d" -t -A -c "SELECT 'ONTBREEKT: ' || n FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n) ORDER BY n;"
  F=$(psql -q -d "$d" -t -A -c "SELECT count(*) FILTER (WHERE NOT ok) + (SELECT count(*) FROM proof.expected x WHERE NOT EXISTS (SELECT 1 FROM proof.result r WHERE r.n = x.n)) FROM proof.result;")
  TOTAL_FAILED=$((TOTAL_FAILED + F))
done
for d in $DBS; do
  psql -q -d "$d" -t -A -c "SELECT format('%s: %s van %s bewijzen geslaagd', current_database(), count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"
done
[ "$TOTAL_FAILED" = "0" ]
