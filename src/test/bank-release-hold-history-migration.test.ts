import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";

/**
 * Bankcorrecties v1.1 — de vrijgave-hold (D12) en historische storno's van vóór PR 1.
 *
 * Eén opvolgende migratie (20261018180000) voegt een interne, alleen-lezen
 * hulpfunctie toe en geeft de hold van PR 1 precies één extra voorwaarde: een
 * BEWEZEN historische storno telt niet als lopende correctie. Het gedrag —
 * welke geschiedenis bewezen is en welke niet, dat elk app-pad na een vrijgave
 * dicht is terwijl de accountant-RPC werkt, dat lopende correcties niet worden
 * geblokkeerd, de rollback, de vier uitroltoestanden en het uitvoerplan als één
 * transactie — wordt bewezen tegen een echte PostgreSQL in
 * supabase/tests/bank-release-hold-history/. Deze test bewaakt de vorm: de hold
 * is letterlijk die van PR 1 plus de beoordeelde wijziging, de hulpfunctie kan
 * niet schrijven, uitvoering.sql is exact bewaking + de drie migraties, en de
 * samenhang met harnas en uitrolcontroles.
 */

const MIGRATION_DIR = "supabase/migrations";
const FILE = "20261018180000_refine_release_hold_for_settled_history.sql";
const MIGRATION = `${MIGRATION_DIR}/${FILE}`;
const PR1_FILE = "20261018120000_add_bank_transaction_corrections.sql";
const PR2_FILE = "20261018150000_keep_bank_description_on_correction.sql";
/** SHA-256 van de migratie zoals beoordeeld. */
const REVIEWED_SHA256 = "c12c3e6e18fdf2dcbdffcb521ae647674009477328502f4a8b8a8057656230b9";
const PR1_HOLD_MD5 = "812d151a7041cdd48b7a784cd193a159";
const FIX_HOLD_MD5 = "43347fb9f48ed4c161e291fa769577c2";
const HELPER_MD5 = "c97cc25d4fb1849831528c6dc2d43501";
const PR2_RECLASSIFY_MD5 = "067939e0c44a672c26ec8883717ef6d2";
const HARNESS = "supabase/tests/bank-release-hold-history";
const ROLLOUT = "supabase/rollout/20261018180000_refine_release_hold_for_settled_history";
const PR1_ROLLOUT = "supabase/rollout/20261018120000_add_bank_transaction_corrections";
const PR2_ROLLOUT = "supabase/rollout/20261018150000_keep_bank_description_on_correction";
const HOLD = "CREATE OR REPLACE FUNCTION public.enforce_bank_transaction_release_hold()";
const HELPER = "CREATE OR REPLACE FUNCTION public.bank_transaction_group_is_settled_history(";
/** De bekende historische storno in productie (PRE 4/PRE 4b, door de eigenaar beoordeeld). */
const KNOWN = [
  "fb1d2550-9a9e-4e09-8a31-e05e59bf3a4a",
  "ff598a0f-e4e3-4b82-968a-9666b54c5ad8",
  "0b1aec4c-1bd1-42f3-b392-6a6125da98e3",
];

/** De beoordeelde wijzigingen in de hold ten opzichte van PR 1 — elk exact één keer. */
const HOLD_HUNKS: [string, string][] = [
  [
    "  -- bijvoorbeeld tijdens een functionele rollback van deze migratie.\n",
    "  -- bijvoorbeeld tijdens een functionele rollback van deze migratie.\n" +
      "  -- Een bewezen historische storno van vóór de correctiegebeurtenissen van\n" +
      "  -- deze transactie (bank_transaction_group_is_settled_history) is zo'n groep\n" +
      "  -- niet: zij hoort bij geen lopende correctie en schakelt de hold niet uit.\n",
  ],
  [
    "                         WHERE e.superseded_posting_group_id = lp.posting_group_id)) THEN\n",
    "                         WHERE e.superseded_posting_group_id = lp.posting_group_id)\n" +
      "         AND NOT public.bank_transaction_group_is_settled_history(OLD.id, lp.posting_group_id)) THEN\n",
  ],
];

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const raw = read(MIGRATION);
const pr1 = read(`${MIGRATION_DIR}/${PR1_FILE}`);
const pr2 = read(`${MIGRATION_DIR}/${PR2_FILE}`);
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** De functiedefinitie, van CREATE tot en met `$$;`. */
function definition(text: string, header: string): string {
  const start = text.indexOf(header);
  if (start < 0) throw new Error(`${header} niet gevonden`);
  return text.slice(start, text.indexOf("\n$$;\n", start) + "\n$$;\n".length);
}

/** Het lichaam tussen `AS $$` en `$$;` — letterlijk, dus gelijk aan prosrc. */
function bodyOf(def: string): string {
  return def.slice(def.indexOf("AS $$") + "AS $$".length, def.lastIndexOf("$$;"));
}

/** Wat direct na een functie staat (rechten en commentaar), tot de volgende functie of het eind. */
function after(text: string, header: string): string {
  const end = text.indexOf("\n$$;\n", text.indexOf(header)) + "\n$$;\n".length;
  const next = text.indexOf("\nCREATE OR REPLACE FUNCTION", end);
  const tail = text.slice(end, next < 0 ? undefined : next);
  return tail.split("\n-- ──")[0].trim();
}

/** De rechten en het commentaar direct na een functie: van `$$;` tot en met het einde van COMMENT ON. */
function rightsAndComment(text: string, header: string): string {
  const end = text.indexOf("\n$$;\n", text.indexOf(header)) + "\n$$;\n".length;
  const comment = text.indexOf("COMMENT ON FUNCTION", end);
  return text.slice(end, text.indexOf("';\n", comment) + 3).trim();
}

/** Uitvoerbare SQL zonder commentaarregels en zonder de inhoud van stringliterals, DO-blokken of functielichamen. */
function topLevelStatements(text: string): string[] {
  return text
    .replace(/AS \$\$[\s\S]*?\$\$;/g, "AS $$ … $$;")
    .replace(/\$(migratie|rollback|uitrol)\$[\s\S]*?\$\1\$/g, "…")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .replace(/'(?:[^']|'')*'/g, "''")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Code zonder commentaar en zonder de inhoud van stringliterals. */
function codeOf(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .replace(/'(?:[^']|'')*'/g, "''");
}

function git(...args: string[]): string[] | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

const holdDef = definition(raw, HOLD);
const pr1HoldDef = definition(pr1, HOLD);
const helperDef = definition(raw, HELPER);
const helperBody = bodyOf(helperDef);
const prereq = raw.slice(raw.indexOf("DO $migratie$"), raw.indexOf("$migratie$;"));

describe("migratie 20261018180000 — vorm", () => {
  it("1. bestaat één keer en sorteert direct na PR 2 (die de hold van PR 1 pint)", () => {
    const files = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.filter((f) => f.endsWith("_refine_release_hold_for_settled_history.sql"))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf(PR2_FILE) + 1);
    expect(files.indexOf(PR2_FILE)).toBe(files.indexOf(PR1_FILE) + 1);
  });

  it("2. byte-voor-byte de beoordeelde versie (SHA-256 over de ruwe bytes)", () => {
    expect(sha256(readFileSync(resolve(process.cwd(), MIGRATION)))).toBe(REVIEWED_SHA256);
  });

  it("3. de hold is letterlijk die uit PR 1, met precies de beoordeelde wijziging (één voorwaarde en haar toelichting)", () => {
    expect(md5(bodyOf(pr1HoldDef))).toBe(PR1_HOLD_MD5);
    let expected = pr1HoldDef;
    for (const [oud, nieuw] of HOLD_HUNKS) {
      expect(expected.split(oud).length - 1, oud.slice(0, 60)).toBe(1);
      expected = expected.replace(oud, nieuw);
    }
    expect(holdDef).toBe(expected);
    expect(md5(bodyOf(holdDef))).toBe(FIX_HOLD_MD5);
  });

  it("4. de nieuwe voorwaarde staat BINNEN de NOT EXISTS die de hold uitschakelt: zij kan de hold alleen vaker laten gelden", () => {
    const body = bodyOf(holdDef);
    const gate = body.slice(body.indexOf("IF v_last = 'released' AND v_coding_changed"), body.indexOf(") THEN", body.indexOf("IF v_last = 'released'")) + 6);
    expect(gate).toBe(
      "IF v_last = 'released' AND v_coding_changed\n" +
        "     AND NOT EXISTS (\n" +
        "       SELECT 1 FROM public.ledger_postings lp\n" +
        "       WHERE lp.source_type = 'bank_transaction' AND lp.source_id = OLD.id\n" +
        "         AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_posting_events e\n" +
        "                         WHERE e.superseded_posting_group_id = lp.posting_group_id)\n" +
        "         AND NOT public.bank_transaction_group_is_settled_history(OLD.id, lp.posting_group_id)) THEN",
    );
    expect(body.split("bank_transaction_group_is_settled_history").length - 1).toBe(2); // de aanroep en de toelichting
  });

  it("5. dezelfde rechten als PR 1 voor de hold; het commentaar noemt de uitzondering", () => {
    const rights = (t: string) => after(t, HOLD).split("\nCOMMENT ON")[0].trim();
    expect(rights(raw)).toBe(rights(pr1));
    expect(rights(raw)).toBe("REVOKE ALL ON FUNCTION public.enforce_bank_transaction_release_hold() FROM PUBLIC, anon, authenticated, service_role;");
    expect(after(raw, HOLD)).toContain("schakelt die hold niet uit");
    expect(holdDef.slice(0, holdDef.indexOf("AS $$"))).toBe(pr1HoldDef.slice(0, pr1HoldDef.indexOf("AS $$")));
  });

  it("6. op het hoogste niveau alleen de voorwaardencontrole, twee functies, hun rechten en commentaar — geen data, tabel, trigger of GRANT", () => {
    const kinds = topLevelStatements(raw).map((s) => s.split(/\s+/).slice(0, 2).join(" ").toUpperCase());
    expect(kinds).toEqual(["DO …", "CREATE OR", "REVOKE ALL", "COMMENT ON", "CREATE OR", "REVOKE ALL", "COMMENT ON"]);
    const code = topLevelStatements(raw).join(";\n");
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|GRANT|CREATE TABLE|CREATE TRIGGER|CREATE INDEX)\b/i);
    expect([...raw.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)/gi)].map((m) => m[1])).toEqual([
      "bank_transaction_group_is_settled_history",
      "enforce_bank_transaction_release_hold",
    ]);
  });
});

describe("de hulpfunctie", () => {
  it("7. SQL, STABLE, geen SECURITY DEFINER, vaste search_path, en voor niemand uitvoerbaar", () => {
    expect(helperDef.slice(0, helperDef.indexOf("AS $$") + "AS $$".length)).toBe(
      "CREATE OR REPLACE FUNCTION public.bank_transaction_group_is_settled_history(\n" +
        "  _transaction_id   uuid,\n" +
        "  _posting_group_id uuid\n" +
        ")\nRETURNS boolean\nLANGUAGE sql\nSTABLE\nSET search_path = public\nAS $$",
    );
    expect(md5(helperBody)).toBe(HELPER_MD5);
    expect(after(raw, HELPER).split("\nCOMMENT ON")[0].trim()).toBe(
      "REVOKE ALL ON FUNCTION public.bank_transaction_group_is_settled_history(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;",
    );
    expect(raw).not.toMatch(/GRANT[^;]*bank_transaction_group_is_settled_history/i);
  });

  it("8. alleen lezen: geen schrijfopdracht, geen dynamische SQL, geen uitzending", () => {
    expect(codeOf(helperBody)).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY|NOTIFY|pg_notify|dblink\w*|EXECUTE|set_config)\b/i);
  });

  it("9. elk van de acht bewijsstukken staat erin — een eerdere datum of een ontbrekende marker alleen is nooit genoeg", () => {
    const parts = [
      // (1) dezelfde transactie, alleen directe bankregels
      "WHERE o.source_type <> 'bank_transaction' OR o.source_id IS DISTINCT FROM _transaction_id)",
      // (2) de reversalketen
      "AND (SELECT count(*) FROM claim) = 1",
      "AND (SELECT c.original_source_type FROM claim c) = 'bank_transaction'",
      "OR v.reversal_of_posting_id IS NULL",
      "OR NOT EXISTS (SELECT 1 FROM orig o WHERE o.id = v.reversal_of_posting_id))",
      "AND (SELECT count(DISTINCT v.reversal_of_posting_id) FROM rev v) = (SELECT count(*) FROM orig)",
      // (3) de transactiedatum, voor origineel, storno en claim
      "AND NOT EXISTS (SELECT 1 FROM orig o, tx t WHERE o.posting_date <> t.transaction_date)",
      "AND NOT EXISTS (SELECT 1 FROM rev v, tx t WHERE v.posting_date <> t.transaction_date)",
      "WHERE c.posting_date <> t.transaction_date OR c.original_posting_date <> t.transaction_date)",
      // (4) neutraal per grootboekrekening
      "GROUP BY x.grootboekrekening_id\n                    HAVING sum(x.saldo) <> 0)",
      // (5) de storno niet zelf tegengeboekt
      "WHERE r2.original_posting_group_id = (SELECT c.reversal_posting_group_id FROM claim c))",
      // (6) geen marker, in geen gebeurtenis
      "AND NOT EXISTS (SELECT 1 FROM public.bank_transaction_postings m WHERE m.posting_group_id = _posting_group_id)",
      "WHERE e.superseded_posting_group_id = _posting_group_id\n                       OR e.replacement_posting_group_id = _posting_group_id)",
      // (7) daarna een nieuwe directe boeking
      "AND g.created_at >= (SELECT max(v.created_at) FROM rev v))",
      // (8) alles strikt ouder dan de eerste gebeurtenis
      "WHERE f.at IS NOT NULL AND x.created_at >= f.at);",
    ];
    for (const p of parts) expect(helperBody, p.slice(0, 60)).toContain(p);
    expect(helperBody).toContain("UNION ALL SELECT v.created_at FROM rev v\n                          UNION ALL SELECT c.created_at FROM claim c) x");
    // Eén keten van AND's: geen OR op het hoogste niveau die een bewijsstuk kan omzeilen.
    const select = codeOf(helperBody.slice(helperBody.lastIndexOf("  SELECT\n")));
    const depth0 = select.replace(/\((?:[^()]|\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\)/g, "( )");
    expect(depth0).not.toMatch(/\bOR\b/i);
  });
});

describe("de voorwaardencontrole", () => {
  it("10. eist PR 2 (en dus PR 1), de hold van PR 1 of deze, dezelfde eigenaar als de schrijver, de trigger ENABLE ALWAYS en de kolommen van het bewijs", () => {
    expect(prereq).toContain(`IS DISTINCT FROM '${PR2_RECLASSIFY_MD5}' THEN`);
    expect(prereq).toContain(`IF v_md5 NOT IN ('${PR1_HOLD_MD5}', '${FIX_HOLD_MD5}') THEN`);
    expect(prereq).toContain(`IS DISTINCT FROM '${HELPER_MD5}'`);
    expect(prereq).toContain("(SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_bank_transaction(uuid)'))");
    expect(prereq).toContain("AND t.tgenabled = 'A' AND NOT t.tgisinternal");
    for (const kolom of ["'public.ledger_postings'::regclass AND a.attname = 'created_at'", "a.attname = 'reversal_of_posting_id'",
                         "'public.ledger_reversal_postings'::regclass AND a.attname = 'created_at'",
                         "'public.bank_transaction_posting_events'::regclass AND a.attname = 'created_at'"]) {
      expect(prereq, kolom).toContain(kolom);
    }
    expect((prereq.match(/USING ERRCODE = '55000'/g) ?? []).length).toBe(8);
    // Een object dat (nog) niet bestaat geeft geen fout bij het plannen: to_regprocedure, geen ::regprocedure.
    expect(prereq).not.toMatch(/'::regprocedure/);
    expect(raw.indexOf("DO $migratie$")).toBeLessThan(raw.indexOf(HELPER));
  });

  it("11. PR 2 pint de hold van PR 1: deze migratie kan alleen ná PR 2, en PR 2 niet opnieuw zolang deze er is", () => {
    expect(pr2).toMatch(new RegExp(`\\('enforce_bank_transaction_release_hold_trigger',\\s+'enforce_bank_transaction_release_hold',\\s+'${PR1_HOLD_MD5}', 'A'\\)`));
    expect(prereq).toContain("RAISE EXCEPTION 'Voorwaarde: PR 2 (20261018150000) is niet toegepast'");
  });
});

describe("rollback", () => {
  it("12. rollback.sql zet de hold byte-gelijk terug naar PR 1 (rechten en commentaar) en verwijdert de hulpfunctie — alleen vanuit deze of PR 1", () => {
    const rb = read(`${ROLLOUT}/rollback.sql`);
    expect(definition(rb, HOLD)).toBe(pr1HoldDef);
    expect(rightsAndComment(rb, HOLD)).toBe(rightsAndComment(pr1, HOLD));
    const guard = rb.slice(rb.indexOf("DO $rollback$"), rb.indexOf("$rollback$;"));
    expect(guard).toContain(`v_md5 NOT IN ('${FIX_HOLD_MD5}', '${PR1_HOLD_MD5}')`);
    expect(guard).toContain("USING ERRCODE = '55000'");
    expect(guard).toContain("(SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure('public.post_bank_transaction(uuid)'))");
    expect(topLevelStatements(rb).map((s) => s.split(/\s+/).slice(0, 2).join(" ").toUpperCase())).toEqual([
      "DO …", "CREATE OR", "REVOKE ALL", "COMMENT ON", "DROP FUNCTION",
    ]);
    expect(rb).toContain("DROP FUNCTION IF EXISTS public.bank_transaction_group_is_settled_history(uuid, uuid);");
    expect(raw).toContain(`-- rollback: voer ${ROLLOUT}/rollback.sql`);
  });
});

describe("het uitvoerplan: één uitvoering", () => {
  const u = read(`${ROLLOUT}/uitvoering.sql`);
  const files = [PR1_FILE, PR2_FILE, FILE];

  it("13. uitvoering.sql is exact: bewaking vooraf + de drie migraties letterlijk, in volgorde + bewaking achteraf", () => {
    let at = 0;
    for (const f of files) {
      const begin = `-- ═══ BEGIN ${f} ═══\n`;
      const end = `-- ═══ EINDE ${f} ═══\n`;
      const b = u.indexOf(begin, at);
      expect(b, f).toBeGreaterThan(at);
      const e = u.indexOf(end, b);
      expect(u.slice(b + begin.length, e), f).toBe(read(`${MIGRATION_DIR}/${f}`));
      expect(u.split(begin).length - 1, f).toBe(1);
      at = e;
    }
    // De kop noemt de sha256 van elk bestand, en die klopt.
    for (const f of files) expect(u).toContain(`--   ${f}  ${sha256(readFileSync(resolve(process.cwd(), MIGRATION_DIR, f)))}`);
  });

  it("14. de bewaking: SET LOCAL eerst (anders weigert zij: geen ene transactie), niets van PR 1 aanwezig, en aan het eind exact de beoordeelde eindtoestand", () => {
    const head = u.slice(0, u.indexOf(`-- ═══ BEGIN ${PR1_FILE} ═══`));
    const tail = u.slice(u.indexOf(`-- ═══ EINDE ${FILE} ═══`));
    const headStatements = topLevelStatements(head);
    expect(headStatements.length).toBe(3);
    expect(headStatements[0]).toBe("SET LOCAL lock_timeout = ''");
    expect(headStatements[1]).toBe("DO …");
    expect(headStatements[2]).toMatch(/^SELECT set_config\('', txid_current\(\)::text, true\)$/);
    expect(head).toContain("SET LOCAL lock_timeout = '5s';");
    expect(head).toContain("IF current_setting('lock_timeout') IS DISTINCT FROM '5s' THEN");
    expect(head).toContain("to_regclass('public.bank_transaction_posting_events') IS NOT NULL");
    expect(tail).toContain("IF current_setting('boekassist.uitrol_xid', true) IS DISTINCT FROM txid_current()::text THEN");
    for (const h of [PR2_RECLASSIFY_MD5, FIX_HOLD_MD5, HELPER_MD5]) expect(tail).toContain(`IS DISTINCT FROM '${h}'`);
    expect(tail).toContain("AND t.tgenabled = 'A'");
    expect(tail).toContain("SELECT 'gecombineerde uitrol voltooid' AS uitkomst,");
    // Geen eigen transactiebesturing: de editor voert de tekst als één transactie uit.
    expect(topLevelStatements(u).filter((s) => /^(BEGIN|COMMIT|ROLLBACK|START|END|SAVEPOINT)\b/i.test(s))).toEqual([]);
    expect(u).toContain("alxlbdhpbwlehbdbfejw");
  });

  it("15. uitvoerplan.md beschrijft de ene uitvoering, de STOP-criteria, het onderhoudsprotocol en waarom los na elkaar STOP is", () => {
    const plan = read(`${ROLLOUT}/uitvoerplan.md`);
    for (const s of ["alxlbdhpbwlehbdbfejw", "olumcwneiejjefhkzgmz", "ycuofllsdssoezwwpqmv", "uitvoering.sql", "PRE B9", "PRE B6",
                     "PRE 4", "POST 8", "IN ORDE", "TIJDELIJK", "STOP", "lock_timeout", "rollback.sql", "Onderhoudsprotocol"]) {
      expect(plan, s).toContain(s);
    }
  });
});

describe("uitrolcontroles", () => {
  const pre = read(`${ROLLOUT}/preflight.sql`);
  const post = read(`${ROLLOUT}/postcheck.sql`);

  it("16. PRE B en POST C zijn alleen-lezen (SELECT of WITH; alleen PRE B9 heeft een SET LOCAL) en noemen het juiste project", () => {
    for (const [f, text] of [["preflight.sql", pre], ["postcheck.sql", post]] as const) {
      expect(text, f).toContain("alxlbdhpbwlehbdbfejw");
      for (const stmt of topLevelStatements(text)) {
        if (f === "preflight.sql" && stmt === "SET LOCAL lock_timeout = ''") continue;
        expect(stmt, f).toMatch(/^(SELECT|WITH)\b/i);
      }
    }
    expect(topLevelStatements(pre).filter((s) => /^SET\b/i.test(s))).toEqual(["SET LOCAL lock_timeout = ''"]);
  });

  it("17. PRE B6 en POST C4 kennen de beoordeelde historische storno; POST C pint de hulpfunctie, de hold en de trigger", () => {
    for (const id of KNOWN) expect(pre, id).toContain(id);
    expect(post).toContain(KNOWN[0]);
    expect(post).toContain(`md5(p.prosrc) = '${HELPER_MD5}'`);
    expect(post).toContain(`md5(p.prosrc) = '${FIX_HOLD_MD5}'`);
    expect(post).toContain(
      "'CREATE TRIGGER enforce_bank_transaction_release_hold_trigger BEFORE DELETE OR UPDATE ON public.bank_transactions FOR EACH ROW EXECUTE FUNCTION enforce_bank_transaction_release_hold()'",
    );
  });

  it("18. PRE 4 (PR 1) onderscheidt bewezen geschiedenis van onverklaard; POST 8 kent ook de gebeurtenissen en de hold-versie", () => {
    const p1pre = read(`${PR1_ROLLOUT}/preflight.sql`);
    const p1post = read(`${PR1_ROLLOUT}/postcheck.sql`);
    for (const k of ["waarvan_historische_storno", "waarvan_onverklaard", "b1_zelfde_transactie", "b6_actuele_marker_daarna", "STOP — niet gestorneerd"]) {
      expect(p1pre, k).toContain(k);
    }
    for (const k of ["waarvan_onverklaard", "hold_versie", `WHEN '${PR1_HOLD_MD5}' THEN 'PR 1'`, `WHEN '${FIX_HOLD_MD5}' THEN '20261018180000'`,
                     "'IN ORDE'", "'TIJDELIJK", "e.replacement_posting_group_id = k.grp", "WHERE f.at IS NOT NULL AND y.created_at >= f.at"]) {
      expect(p1post, k).toContain(k);
    }
    // PRE 7 en POST 7 sluiten dezelfde functies uit, inclusief de hulpfunctie.
    const list = (t: string, kop: string) => {
      const b = t.slice(t.indexOf(kop));
      return b.slice(b.indexOf("p.proname NOT IN ("), b.indexOf("AS bestaande_functies_digest"));
    };
    expect(list(p1post, "-- ── POST 7.")).toBe(list(p1pre, "-- ── PRE 7."));
    expect(list(p1pre, "-- ── PRE 7.")).toContain("'bank_transaction_group_is_settled_history'");
  });

  it("19. de POST's van PR 1 en PR 2 aanvaarden de hold van de fix naast die van PR 1", () => {
    expect(read(`${PR1_ROLLOUT}/postcheck.sql`)).toContain(FIX_HOLD_MD5);
    expect(read(`${PR2_ROLLOUT}/postcheck.sql`)).toContain(FIX_HOLD_MD5);
  });
});

describe("het harnas", () => {
  const run = read(`${HARNESS}/run-proof.sh`);

  it("20. echte keten incl. PR 0, echte triggerlichamen, geschiedenis van vóór PR 1, PRE letterlijk, PR 1 + PR 2, negatieve controle, twee keer toepassen, rollback in volgorde en opnieuw", () => {
    expect(run).toContain("20261017120000_guard_direct_bank_posting_against_allocations");
    expect(run).toContain("20260411182021_ce126469-1948-4a6f-947d-ad6dd95764cb.sql");
    expect(run).toContain("20260616014119_379a0719-29c0-4ba7-a513-06777db1dbc3.sql");
    expect(run).toContain('M="${HOLD_FIX_MIGRATION:-$MIG/20261018180000_refine_release_hold_for_settled_history.sql}"');
    expect(run).toContain('RB="${HOLD_FIX_ROLLBACK:-$R3/rollback.sql}"');
    const order = [
      'run -f "$HERE/history.sql"', 'run -v pre4_oud="$PRE4_OUD"', 'run -f "$PR1"', 'run -f "$PR2"', 'run -f "$HERE/gap.sql"',
      'run -f "$HERE/snapshot.sql"', 'run -f "$M"', 'run -f "$M"', '-f "$HERE/proof.sql"', 'run -f "$HERE/corrections.sql"',
      '-f "$HERE/concurrency.sql"', 'run -f "$RB"', 'run -f "$RB"', '-f "$HERE/rollback-fix.sql"', 'run -f "$R2/rollback.sql"',
      'run -c "$PR1_ROLLBACK"', 'run -f "$HERE/window.sql"', 'run -f "$PR1"', 'run -f "$PR2"', 'run -f "$M"',
      '-f "$HERE/reapply.sql"', 'run -f "$HERE/final.sql"',
    ];
    let at = run.indexOf('build "$DB"');
    for (const step of order) {
      const next = run.indexOf(step, at + 1);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    for (const f of ["helpers.sql", "history.sql", "pre.sql", "gap.sql", "snapshot.sql", "proof.sql", "corrections.sql", "concurrency.sql",
                     "rollback-fix.sql", "window.sql", "reapply.sql", "final.sql", "prodlike.sql", "seq.sql", "atomic.sql", "visibility.sql"]) {
      expect(existsSync(resolve(process.cwd(), HARNESS, f)), f).toBe(true);
    }
  });

  it("21. de drie productiegelijke databases: los na elkaar (TIJDELIJK), het uitvoerplan als één uitvoering (\\gexec), read-only PRE/POST, en zichtbaarheid", () => {
    expect(run).toContain('build "$DB2"');
    expect(run).toContain('run2 -f "$HERE/seq.sql"');
    expect(run).toContain('build "$DB3"');
    expect(run).toContain("SELECT :'u' \\gexec");
    expect(run).toContain("-c default_transaction_read_only=on");
    expect(run).toContain('U="$R3/uitvoering.sql"');
    expect(run).toContain('psql -X -q -v ON_ERROR_STOP=1 -d "$DB3" -f "$U"'); // opdracht voor opdracht: moet weigeren
    expect(run).toContain('run3 -f "$HERE/atomic.sql"');
    expect(run).toContain('-f "$HERE/visibility.sql"');
    expect(run).toMatch(/THROWAWAY DATABASES ONLY/);
  });

  it("22. alleen history.sql en prodlike.sql bootsen geschiedenis na (proof.forge); niets schrijft rechtstreeks in grootboek, markers of gebeurtenissen; nooit productie", () => {
    for (const f of readdirSync(resolve(process.cwd(), HARNESS)).filter((x) => x.endsWith(".sql") || x.endsWith(".sh"))) {
      const text = read(`${HARNESS}/${f}`);
      if (!["helpers.sql", "history.sql", "prodlike.sql"].includes(f)) {
        expect(text, f).not.toContain("proof.forge(");
        expect(text, f).not.toMatch(/INSERT INTO public\.(ledger_postings|ledger_reversal_postings|bank_transaction_postings|bank_transaction_posting_events)/i);
      }
      // Alleen in commentaar mag een projectref staan (als waarschuwing); nooit in uitvoerbare code.
      const code = text.split("\n").filter((l) => !/^\s*(--|#)/.test(l)).join("\n");
      expect(code, f).not.toMatch(/supabase\.co|alxlbdhpbwlehbdbfejw|olumcwneiejjefhkzgmz|ycuofllsdssoezwwpqmv/);
    }
    expect(read(`${HARNESS}/helpers.sql`)).toContain("ALTER TABLE public.ledger_postings ENABLE ALWAYS TRIGGER prevent_ledger_posting_mutation_trigger;");
  });
});

describe("branch-grenzen", () => {
  const changed = git("diff", "--name-only", "origin/main...HEAD");
  const introducedHere = git("diff", "--name-only", "--diff-filter=A", "origin/main...HEAD")?.includes(MIGRATION) ?? false;

  it("23. geen bestaande migratie gewijzigd, verwijderd, hernoemd of van type veranderd", (ctx) => {
    const existing = git("diff", "--name-only", "--diff-filter=MDRT", "origin/main...HEAD", "--", MIGRATION_DIR);
    if (!existing) return ctx.skip();
    expect(existing).toEqual([]);
  });

  it("24. op de branch die de fix invoert: alleen deze migratie, geen app, types, packages of functies; fundering en schrijvers onaangeroerd", (ctx) => {
    if (!changed || !introducedHere) return ctx.skip();
    for (const f of ["src/integrations/supabase/types.ts", "package.json", "package-lock.json", "bun.lockb", "ENVIRONMENT.md",
                     "supabase/functions/mcp/index.ts", "src/lib/snelstart-export.ts"]) {
      expect(changed, f).not.toContain(f);
    }
    expect(changed.filter((f) => f.startsWith("src/") && !f.startsWith("src/test/"))).toEqual([]);
    expect(changed.filter((f) => f.startsWith("supabase/functions/"))).toEqual([]);
    expect(changed.filter((f) => f.startsWith(`${MIGRATION_DIR}/`))).toEqual([MIGRATION]);
    expect(changed.filter((f) => f.startsWith("supabase/rollout/") && ![ROLLOUT, PR1_ROLLOUT, PR2_ROLLOUT].some((d) => f.startsWith(`${d}/`)))).toEqual([]);
    assertBranchSqlKeepsLedgerFoundation(changed);
    assertBranchTouchesNoExistingWriter(changed);
  });

  it("25. geen schrijver of RPC herdefinieerd: alleen de hold (een triggerfunctie) en de nieuwe hulpfunctie", () => {
    expect(raw).not.toMatch(/FUNCTION\s+(?:public\.)?(post_bank_transaction|reclassify_bank_transaction|release_bank_transaction_posting|return_bank_transaction_to_workflow|reverse_posting_group|post_bank_transactions_bulk)\b/i);
  });
});
