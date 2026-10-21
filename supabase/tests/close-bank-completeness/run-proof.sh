#!/usr/bin/env bash
# Real-PostgreSQL proof for herstel P7 — de jaarafsluiting telt ook gecodeerde,
# nog niet geboekte bankregels (A3-02) en alleen werk van de eigen organisatie
# (B1-04): 20261021200000_close_fiscal_year_direct_bank_completeness.sql.
#
# THROWAWAY DATABASE ONLY. This script CREATEs and DROPs a database. It must
# never be pointed at a BoekAssist database — not production
# (alxlbdhpbwlehbdbfejw), not any preview branch. It is not part of `npm run
# test`: CI has no PostgreSQL.
#
# Usage — only the libpq environment, nothing else (needs dblink):
#   PGHOST=/path/to/socketdir PGPORT=5432 PGUSER=postgres \
#     supabase/tests/close-bank-completeness/run-proof.sh
#
# Order:
#   ../opening-balance/bootstrap.sql                  roles, auth.uid(), organisations,
#                                                     clients, grootboekrekeningen
#   ../bank-direct-allocation-guard/bootstrap-sources.sql   the pre-ledger tables, WITH
#                                                     organization_id (no marker stubs)
#   the REAL chain 20260904120000 … 20261020120000    incl. every writer, PR E, PR H,
#                                                     the direct-allocation guard and the
#                                                     bank corrections (+ the two real
#                                                     trigger bodies they pin)
#   fixtures.sql                                      one administratie per case
#   pre.sql                                           NEGATIVE CONTROL on the PR E body
#   rollout preflight.sql + impact.sql                read-only, on the PR E state
#   anti-clobber                                      an unknown body → the migration refuses
#   20261021200000 (TWICE)                            the migration under test
#   rollout postcheck.sql (filled in from PRE 3)      read-only, one row of booleans
#   proof.sql + concurrency.sql                       numbered proofs, two real sessions
#   rollout rollback.sql (TWICE) + after-rollback.sql the old behaviour back, data intact
#   20261021200000 again + final.sql                  catalogue and deadlock invariants
# and prints one line per proof plus a summary; exit code 1 on any FAIL.

set -euo pipefail

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

DB="${P7_PROOF_DB:-p7closeproof}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
T="$REPO/supabase/tests"
M="${P7_MIGRATION:-$MIG/20261021200000_close_fiscal_year_direct_bank_completeness.sql}"
R="$REPO/supabase/rollout/20261021200000_close_fiscal_year_direct_bank_completeness"

: "${PGHOST:?set PGHOST}"
CONN="host=$PGHOST port=${PGPORT:-5432} dbname=$DB user=${PGUSER:-postgres}"

psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;" postgres >/dev/null

# De uitslag verschijnt ALTIJD, ook als een stap halverwege afbreekt (bijvoorbeeld
# een weigerende bewaking in een mutatierun via P7_MIGRATION). Exitcode: 0 alleen
# als alles draaide en elk bewijs slaagde.
COMPLETED=0
finish() {
  local rc=$?
  set +e
  if psql -X -q -t -A -d "$DB" -c "SELECT 1 FROM proof.result LIMIT 1" >/dev/null 2>&1; then
    psql -X -q -d "$DB" -P pager=off -c "
      SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS uitslag, n, name, left(coalesce(detail, ''), 120) AS detail
      FROM proof.result ORDER BY ok, n;"
    psql -X -q -d "$DB" -t -c "
      SELECT format('%s van %s bewijzen geslaagd', count(*) FILTER (WHERE ok), count(*)) FROM proof.result;"
    FAILED=$(psql -X -q -d "$DB" -t -A -c "SELECT count(*) FROM proof.result WHERE ok IS NOT TRUE;")
  else
    FAILED=unknown
  fi
  if [ "$COMPLETED" != "1" ]; then
    echo "AFGEBROKEN (rc=$rc): niet alle stappen zijn uitgevoerd — dit telt als FAIL" >&2
    exit $(( rc == 0 ? 1 : rc ))
  fi
  [ "$FAILED" = "0" ] || exit 1
  exit 0
}
trap finish EXIT

run() { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
val() { psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }
ro()  { PGOPTIONS="$PGOPTIONS -c default_transaction_read_only=on" psql -X -q -t -A -F '|' -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
# psql interpoleert :'variabelen' in een script (stdin), niet in -c.
rec() {
  run -v n="$1" -v name="$2" -v ok="$3" -v detail="$4" > /dev/null <<'SQL'
SELECT proof.record(:'n', :'name', :'ok'::boolean, :'detail');
SQL
}

# ── de echte keten ──────────────────────────────────────────────────────────
run -f "$T/opening-balance/bootstrap.sql"                                   > /dev/null
run -f "$T/bank-direct-allocation-guard/bootstrap-sources.sql"              > /dev/null
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
  run -f "$MIG/$f.sql"                                                      > /dev/null
done
# De bankcorrecties pinnen de echte lichamen van twee triggerfuncties die de
# bootstrap vereenvoudigd nabouwt (zie ../bank-release-hold-history/run-proof.sh).
REAL="$(sed -n '/^CREATE OR REPLACE FUNCTION public.update_updated_at_column()/,/^\$\$ LANGUAGE plpgsql SET search_path = public;/p' \
          "$MIG/20260411182021_ce126469-1948-4a6f-947d-ad6dd95764cb.sql")
$(sed -n '/^CREATE OR REPLACE FUNCTION public.set_organization_id()/,/^\$function\$;/p' \
          "$MIG/20260616014119_379a0719-29c0-4ba7-a513-06777db1dbc3.sql")"
[ -n "$REAL" ] || { echo "triggerfuncties niet gevonden" >&2; exit 1; }
run -c "$REAL"                                                              > /dev/null
for f in \
  20261018120000_add_bank_transaction_corrections \
  20261018150000_keep_bank_description_on_correction \
  20261018180000_refine_release_hold_for_settled_history \
  20261020120000_add_bank_transaction_import_fingerprint
do
  run -f "$MIG/$f.sql"                                                      > /dev/null
done

# ── fixtures en de negatieve controle (PR E-lichaam) ────────────────────────
run -f "$HERE/fixtures.sql"                                                 > /dev/null
run -f "$HERE/pre.sql"                                                      > /dev/null

# ── uitrol: preflight en impact, ALLEEN LEZEN, op de toestand vóór de migratie
PRE="$(ro -f "$R/preflight.sql")"
PRE1="$(sed -n 1p <<< "$PRE")"; PRE2="$(sed -n 2p <<< "$PRE")"; PRE3="$(sed -n 3p <<< "$PRE")"
rec P1 'uitrol: preflight PRE 1 draait alleen-lezen en geeft op de PR E-toestand overal true' \
    "$([[ "$PRE1" =~ ^(t\|)*t$ ]] && echo true || echo false)" "$PRE1"
rec P2 'uitrol: preflight PRE 2 (rechten zoals PR E ze zette) overal true' \
    "$([[ "$PRE2" =~ ^(t\|)*t$ ]] && echo true || echo false)" "$PRE2"
IFS='|' read -r PRE_YC PRE_EV PRE_WM PRE_BT PRE_BTP PRE_LP <<< "$PRE3"

IMP="$(ro -f "$R/impact.sql")"
IMP1="$(sed -n 1p <<< "$IMP")"
IMP2_CLIENTS="$(sed -n '2,$p' <<< "$IMP" | grep -E '^[0-9a-f-]{36}\|[0-9a-f-]{36}\|' | cut -d'|' -f2 | LC_ALL=C sort | paste -sd, -)"
IMP3="$(tail -n 1 <<< "$IMP")"
EXPECT_CLIENTS="$(val "SELECT string_agg(c::text, ',' ORDER BY c::text) FROM unnest(ARRAY[
  proof.client(1), proof.client(7), proof.client(13), proof.client(14), proof.client(99)]) c;")"
rec P3 'uitrol: impact.sql (alleen lezen) — 5 administraties met 5 ongeboekte gecodeerde bankregels in een open jaar; D8: 1 regel vóór de beginbalans en 1 van vóór de schrijver (1 administratie); H-1: 1 onboekbare regel zonder organisatie apart' \
    "$([ "$IMP1" = "5|5|0|0|1|1|1|1" ] && echo true || echo false)" "$IMP1"
rec P3b 'uitrol: impact.sql noemt exact K1, K7, K13, K14 en KB — niet K2–K6, niet de vrijgegeven regel (K11), niet de andere organisatie (K8), niet de regel zonder organisatie (K10)' \
    "$([ "$IMP2_CLIENTS" = "$EXPECT_CLIENTS" ] && echo true || echo false)" "$IMP2_CLIENTS"
rec P3c 'uitrol: impact.sql B1-04-telling — 1 inkoop- en 1 bankrij van een andere organisatie, 1 inkoop- en 1 bankrij zonder organisatie' \
    "$([ "$IMP3" = "1|0|0|1|0|1|0|0|1" ] && echo true || echo false)" "$IMP3"

# ── anti-clobber: een onbekend lichaam laat de migratie weigeren ────────────
run > /dev/null <<'SQL'
DO $$
DECLARE d text := pg_get_functiondef('public.close_fiscal_year(uuid,integer)'::regprocedure);
BEGIN
  PERFORM proof.put('def_pr_e', d);
  EXECUTE replace(d, '''Niet ingelogd''', '''Niet ingelogd (hotfix)''');
  PERFORM proof.put('md5_hotfix', proof.close_md5());
END $$;
SQL
if CLOBBER_ERR="$(run -f "$M" 2>&1 >/dev/null)"; then CLOBBER_ERR="GEEN weigering"; fi
rec A1 'anti-clobber: op een onbekend lichaam weigert de migratie met de drie hashes' \
    "$([[ "$CLOBBER_ERR" == *"P7 geweigerd: public.close_fiscal_year() heeft een onbekend lichaam"* ]] && echo true || echo false)" \
    "$(tr '\n' ' ' <<< "$CLOBBER_ERR" | cut -c1-200)"
rec A2 'anti-clobber: en laat dat onbekende lichaam ongemoeid' \
    "$([ "$(val "SELECT proof.close_md5() = proof.get('md5_hotfix') AND proof.get('md5_hotfix') <> '14cdfaa498bbbc305e95dbf0faa52e26'")" = t ] && echo true || echo false)" ''
run -c "DO \$\$ BEGIN EXECUTE proof.get('def_pr_e'); END \$\$;"            > /dev/null
rec A3 'anti-clobber: het PR E-lichaam is daarna exact hersteld' \
    "$([ "$(val "SELECT proof.close_md5()")" = 14cdfaa498bbbc305e95dbf0faa52e26 ] && echo true || echo false)" ''

run -c "SELECT proof.put('catalogus_voor', proof.catalog_digest());"        > /dev/null

# ── de migratie onder test, TWEE keer ───────────────────────────────────────
run -f "$M"                                                                 > /dev/null
run -f "$M"                                                                 > /dev/null

# ── uitrol: postcheck, ingevuld met PRE 3, ALLEEN LEZEN ─────────────────────
POST_SQL="$(sed -e "s/NULL::bigint AS pre_jaarafsluitingen/${PRE_YC}::bigint AS pre_jaarafsluitingen/" \
                -e "s/NULL::bigint AS pre_gebeurtenissen/${PRE_EV}::bigint AS pre_gebeurtenissen/" \
                -e "s/NULL::text   AS pre_watermerk_en_blokkade_md5/'${PRE_WM}'::text AS pre_watermerk_en_blokkade_md5/" \
                -e "s/NULL::bigint AS pre_banktransacties/${PRE_BT}::bigint AS pre_banktransacties/" \
                -e "s/NULL::bigint AS pre_directe_boekingen/${PRE_BTP}::bigint AS pre_directe_boekingen/" \
                -e "s/NULL::bigint AS pre_grootboekregels/${PRE_LP}::bigint AS pre_grootboekregels/" "$R/postcheck.sql")"
POST="$(ro -c "$POST_SQL" | tail -n 1)"
rec P4 'uitrol: postcheck (ingevuld met PRE 3, alleen lezen) geeft één rij met overal true' \
    "$([[ "$POST" =~ ^(t\|)*t$ ]] && echo true || echo false)" "$POST"
POST_LEEG="$(ro -f "$R/postcheck.sql" | tail -n 1)"
rec P4b 'uitrol: een NIET ingevulde postcheck geeft false (bewust: geen stille groene uitslag)' \
    "$([[ "$POST_LEEG" == *"|f|f|f|f|f|f" ]] && echo true || echo false)" "$POST_LEEG"
PRE_NA="$(ro -f "$R/preflight.sql" | sed -n 1p)"
rec P5 'uitrol: na de migratie meldt PRE 1 lichaam_is_pr_e = false en nog_niet_toegepast = false (STOP: al toegepast)' \
    "$([[ "$PRE_NA" == "t|t|t|t|t|t|t|f|f|t" ]] && echo true || echo false)" "$PRE_NA"

# ── de bewijzen ─────────────────────────────────────────────────────────────
run -f "$HERE/proof.sql"                                                    > /dev/null
run -v conn="$CONN" -f "$HERE/concurrency.sql"                              > /dev/null

# ── rollback: eerst de bewaking op een onbekend lichaam, dan TWEE keer echt ──
run -c "SELECT proof.put('digest_voor_rollback', proof.data_digest());"     > /dev/null
run > /dev/null <<'SQL'
DO $$
DECLARE d text := pg_get_functiondef('public.close_fiscal_year(uuid,integer)'::regprocedure);
BEGIN
  PERFORM proof.put('def_p7', d);
  PERFORM proof.put('md5_p7_voor_hotfix', proof.close_md5());
  EXECUTE replace(d, '''Niet ingelogd''', '''Niet ingelogd (hotfix)''');
  PERFORM proof.put('rollback_guard_md5_voor', proof.close_md5());
END $$;
SQL
if RB_ERR="$(PGOPTIONS="$PGOPTIONS -c log_error_verbosity=default" psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$DB" -f "$R/rollback.sql" 2>&1 >/dev/null)"; then RB_ERR="GEEN weigering"; fi
run -v e="$(tr '\n' ' ' <<< "$RB_ERR" | cut -c1-300)" > /dev/null <<'SQL'
SELECT proof.put('rollback_guard', :'e');
SQL
run -c "SELECT proof.put('rollback_guard_md5_na', proof.close_md5());"      > /dev/null
run -c "DO \$\$ BEGIN EXECUTE proof.get('def_p7'); END \$\$;"               > /dev/null
[ "$(val "SELECT proof.close_md5() = proof.get('md5_p7_voor_hotfix')")" = t ] || { echo "lichaam onder test niet hersteld" >&2; exit 1; }

run -f "$R/rollback.sql"                                                    > /dev/null
run -f "$R/rollback.sql"                                                    > /dev/null
run -f "$HERE/after-rollback.sql"                                           > /dev/null

# ── en weer vooruit ─────────────────────────────────────────────────────────
run -f "$M"                                                                 > /dev/null
run -c "SELECT proof.put('catalogus_na', proof.catalog_digest());"          > /dev/null
run -f "$HERE/final.sql"                                                    > /dev/null

COMPLETED=1
