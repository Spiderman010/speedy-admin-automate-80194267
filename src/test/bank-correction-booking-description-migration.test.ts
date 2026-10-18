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
 * Bankcorrecties v1.1 — PR 2: de bankomschrijving blijft de geïmporteerde tekst.
 *
 * Eén opvolgende migratie vervangt alleen reclassify_bank_transaction. Het
 * echte gedrag (byte-gelijke bankomschrijving in S0–S4, de boekingsomschrijving
 * in het grootboek, onzichtbaarheid van de tijdelijke tekst voor andere
 * sessies, een fout na elke stap en bij COMMIT, races, rollback) wordt bewezen
 * tegen een echte PostgreSQL in supabase/tests/bank-correction-booking-description/.
 * Deze test bewaakt dat de nieuwe functie letterlijk die van PR 1 is met precies
 * de beoordeelde wijzigingen, en de samenhang met harnas en uitrolcontroles.
 */

const MIGRATION_DIR = "supabase/migrations";
const FILE = "20261018150000_keep_bank_description_on_correction.sql";
const MIGRATION = `${MIGRATION_DIR}/${FILE}`;
const PR1_FILE = "20261018120000_add_bank_transaction_corrections.sql";
/**
 * De opvolgende fix van de vrijgave-hold. Zij herdefinieert de hold-trigger-
 * functie op bank_transactions — precies wat test 17 en 20 hieronder bewaken.
 * Het veiligheidsargument van deze migratie is daarvoor herbeoordeeld: de nieuwe
 * hold voegt één leesvoorwaarde toe (een STABLE hulpfunctie), schrijft niets en
 * zendt niets uit (test 20). De hold-pin hieronder blijft die van PR 1: deze
 * migratie draait vóór de fix (de fix eist PR 2), en haar voorwaardencontrole
 * moet de PR 1-hold blijven eisen.
 */
const HOLD_FIX_FILE = "20261018180000_refine_release_hold_for_settled_history.sql";
const HOLD_FIX_BODY_MD5 = "43347fb9f48ed4c161e291fa769577c2";
const HOLD_FIX_HELPER_MD5 = "697f9413067e9c5b73323b792c51cda9";
/** SHA-256 van de migratie zoals beoordeeld. */
const REVIEWED_SHA256 = "1cc32885a3d095ec2fa0bb36e16d4337cb5fdf8f95f59440175ee9b6ff3fe54d";
const PR1_BODY_MD5 = "a931207c1a4e97f06e7797ed105c0264";
const PR2_BODY_MD5 = "067939e0c44a672c26ec8883717ef6d2";
const WRITER_MD5 = "2369978c713ac78a0c039dd5c3e5eb4c";
const HARNESS = "supabase/tests/bank-correction-booking-description";
const ROLLOUT = "supabase/rollout/20261018150000_keep_bank_description_on_correction";
const SIGNATURE = "uuid, uuid, uuid, numeric, uuid, text, text";
/** De eigenaar van de RPC moet die van de schrijver zijn: CREATE OR REPLACE behoudt de eigenaar. */
const OWNER_CHECK =
  "  IF (SELECT p.proowner FROM pg_proc p\n" +
  "      WHERE p.oid = 'public.reclassify_bank_transaction(uuid,uuid,uuid,numeric,uuid,text,text)'::regprocedure)\n" +
  "     IS DISTINCT FROM\n" +
  "     (SELECT p.proowner FROM pg_proc p WHERE p.oid = 'public.post_bank_transaction(uuid)'::regprocedure) THEN\n";


/** De vijf triggers op bank_transactions en de lichamen van hun functies, zoals in de migraties. */
const BANK_TRIGGERS: [string, string, string, string][] = [
  ["enforce_bank_transaction_release_hold_trigger", "enforce_bank_transaction_release_hold", "812d151a7041cdd48b7a784cd193a159", "A"],
  ["prevent_org_user_rebind_trg", "prevent_org_user_rebind", "9d75d3c98a66f0fc0299b795ee40461e", "O"],
  ["prevent_posted_bank_transaction_mutation_trigger", "prevent_posted_bank_transaction_mutation", "a6437536b1942e78d5b072f22fe6a842", "O"],
  ["set_organization_id_trigger", "set_organization_id", "e56450399d8f95c5ed42fd2df04bed06", "O"],
  ["update_bank_transactions_updated_at", "update_updated_at_column", "301a884953d37769916294bb60562e05", "O"],
];

/** De beoordeelde wijzigingen ten opzichte van de functie uit PR 1 — elk exact één keer. */
const HUNKS: [string, string][] = [
  ["  v_old_desc    text;\n", "  v_old_desc    text;\n  v_hist_desc   text;\n"],
  [
    `  -- De omschrijving die de schrijver straks gebruikt, met zijn eigen regel.
  v_new_desc := COALESCE(NULLIF(btrim(COALESCE(v_desc_arg, v_tx.description)), ''), 'Bankboeking');

  IF v_state IN ('S1', 'S2') THEN
    SELECT lp.description INTO v_old_desc
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = v_marker.posting_group_id
    ORDER BY lp.line_no, lp.id
    LIMIT 1;
  END IF;
`,
    `  -- De boekingsomschrijving voor de grootboekregels. De bankomschrijving
  -- (bank_transactions.description) is de geïmporteerde tekst en blijft dat.
  -- Zonder nieuwe omschrijving blijft de bestaande boekingsomschrijving staan:
  -- die van de actieve of tegengeboekte groep (S1, S2), of — na vrijgeven of
  -- terugzetten — die van de laatst vervangen groep, uit het grootboek via de
  -- gebeurtenis die haar vervangt. Alleen een transactie die nog nooit direct
  -- geboekt is, krijgt bij haar eerste boeking de bankomschrijving, zoals elke
  -- eerste boeking door de schrijver.
  IF v_state IN ('S1', 'S2') THEN
    SELECT lp.description INTO v_old_desc
    FROM public.ledger_postings lp
    WHERE lp.posting_group_id = v_marker.posting_group_id
    ORDER BY lp.line_no, lp.id
    LIMIT 1;
  ELSE
    SELECT lp.description INTO v_hist_desc
    FROM public.bank_transaction_posting_events e
    JOIN public.ledger_postings lp ON lp.posting_group_id = e.superseded_posting_group_id
    WHERE e.bank_transaction_id = v_tx.id
    ORDER BY e.seq DESC, lp.line_no, lp.id
    LIMIT 1;
  END IF;

  v_new_desc := COALESCE(v_desc_arg, v_old_desc, v_hist_desc,
                         NULLIF(btrim(v_tx.description), ''), 'Bankboeking');
`,
  ],
  [
    `  -- De factuurmatch blijft zoals hij is (de RPC herrekent geen facturen), behalve
  -- een onbevestigde suggestie: die vervalt, zoals bij bulk boeken.
  UPDATE public.bank_transactions bt SET
    match_status         = 'handmatig_geboekt',
    grootboekrekening_id = _grootboekrekening_id,
    btw_percentage       = _btw_percentage,
    matched_invoice_id   = CASE WHEN v_tx.match_status = 'suggestie' THEN NULL ELSE bt.matched_invoice_id END,
    match_confidence     = CASE WHEN v_tx.match_status = 'suggestie' THEN NULL ELSE bt.match_confidence END,
    description          = COALESCE(v_desc_arg, bt.description)
  WHERE bt.id = v_tx.id;

  v_new_group := public.post_bank_transaction(v_tx.id);
`,
    `  -- De factuurmatch blijft zoals hij is (de RPC herrekent geen facturen), behalve
  -- een onbevestigde suggestie: die vervalt, zoals bij bulk boeken.
  --
  -- De schrijver leest de omschrijving van zijn grootboekregels uit
  -- bank_transactions.description. Daarom staat de boekingsomschrijving daar
  -- alleen tijdens de boeking, binnen deze transactie en onder de rijgrendel:
  -- geen andere sessie ziet haar (MVCC). Direct na de boeking krijgt de
  -- bankregel haar oorspronkelijke omschrijving byte-gelijk terug, ook NULL.
  -- Een fout op welk punt ook draait alles terug.
  UPDATE public.bank_transactions bt SET
    match_status         = 'handmatig_geboekt',
    grootboekrekening_id = _grootboekrekening_id,
    btw_percentage       = _btw_percentage,
    matched_invoice_id   = CASE WHEN v_tx.match_status = 'suggestie' THEN NULL ELSE bt.matched_invoice_id END,
    match_confidence     = CASE WHEN v_tx.match_status = 'suggestie' THEN NULL ELSE bt.match_confidence END,
    description          = v_new_desc
  WHERE bt.id = v_tx.id;

  v_new_group := public.post_bank_transaction(v_tx.id);

  UPDATE public.bank_transactions bt SET
    description = v_tx.description
  WHERE bt.id = v_tx.id;

  IF NOT EXISTS (SELECT 1 FROM public.bank_transactions bt
                 WHERE bt.id = v_tx.id
                   AND bt.description COLLATE "C" IS NOT DISTINCT FROM v_tx.description COLLATE "C") THEN
    RAISE EXCEPTION 'De oorspronkelijke bankomschrijving bleef niet behouden; er is niets geboekt' USING ERRCODE = '23514';
  END IF;
`,
  ],
];

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const raw = read(MIGRATION);
const pr1 = read(`${MIGRATION_DIR}/${PR1_FILE}`);
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

/** De functiedefinitie van reclassify_bank_transaction, van CREATE tot en met `$$;`. */
function definition(text: string): string {
  const start = text.indexOf("CREATE OR REPLACE FUNCTION public.reclassify_bank_transaction(");
  if (start < 0) throw new Error("reclassify_bank_transaction niet gevonden");
  return text.slice(start, text.indexOf("\n$$;\n", start) + "\n$$;\n".length);
}

/** Het lichaam tussen `AS $$` en `$$;` — letterlijk, dus gelijk aan prosrc. */
function bodyOf(def: string): string {
  return def.slice(def.indexOf("AS $$") + "AS $$".length, def.lastIndexOf("$$;"));
}

/** De rechten en het commentaar direct na de functie (tot de volgende functie of het eind). */
function grantsAfter(text: string): string {
  const end = text.indexOf("\n$$;\n", text.indexOf("CREATE OR REPLACE FUNCTION public.reclassify_bank_transaction(")) + "\n$$;\n".length;
  const next = text.indexOf("\nCREATE OR REPLACE FUNCTION", end);
  return text.slice(end, next < 0 ? undefined : next).trim();
}

/** Uitvoerbare SQL zonder commentaarregels en zonder de inhoud van stringliterals of functielichamen. */
function topLevelStatements(text: string): string[] {
  return text
    .replace(/AS \$\$[\s\S]*?\$\$;/g, "AS $$ … $$;")
    .replace(/\$(migratie|rollback)\$[\s\S]*?\$\1\$/g, "…")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .replace(/'(?:[^']|'')*'/g, "''")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
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

const newDef = definition(raw);
const pr1Def = definition(pr1);
const newBody = bodyOf(newDef);

describe("migratie 20261018150000 — vorm", () => {
  it("1. bestaat één keer en sorteert direct na PR 1", () => {
    const files = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.filter((f) => f.endsWith("_keep_bank_description_on_correction.sql"))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf(PR1_FILE) + 1);
  });

  it("2. byte-voor-byte de beoordeelde versie (SHA-256 over de ruwe bytes)", () => {
    const bytes = readFileSync(resolve(process.cwd(), MIGRATION));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(REVIEWED_SHA256);
  });

  it("3. de functie is letterlijk die uit PR 1, met precies de beoordeelde wijzigingen", () => {
    expect(md5(bodyOf(pr1Def))).toBe(PR1_BODY_MD5);
    let expected = pr1Def;
    for (const [oud, nieuw] of HUNKS) {
      expect(expected.split(oud).length - 1, oud.slice(0, 60)).toBe(1);
      expected = expected.replace(oud, nieuw);
    }
    expect(newDef).toBe(expected);
    expect(md5(newBody)).toBe(PR2_BODY_MD5);
  });

  it("4. alleen reclassify_bank_transaction: zelfde signatuur, uitkomsttype, plpgsql, SECURITY DEFINER, search_path, VOLATILE", () => {
    expect([...raw.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)/gi)].map((m) => m[1])).toEqual([
      "reclassify_bank_transaction",
    ]);
    const kop = (d: string) => d.slice(0, d.indexOf("AS $$") + "AS $$".length);
    expect(kop(newDef)).toBe(kop(pr1Def));
    expect(kop(newDef)).toMatch(/LANGUAGE plpgsql\s+VOLATILE\s+SECURITY DEFINER\s+SET search_path = public\s+AS \$\$/);
  });

  it("5. op het hoogste niveau alleen de voorwaardencontrole, de functie, rechten en commentaar — geen data, geen tabel, geen trigger", () => {
    const kinds = topLevelStatements(raw).map((s) => s.split(/\s+/).slice(0, 2).join(" ").toUpperCase());
    expect(kinds).toEqual(["DO …", "CREATE OR", "REVOKE ALL", "GRANT EXECUTE", "COMMENT ON"]);
    const code = topLevelStatements(raw).join(";\n");
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE TABLE|CREATE TRIGGER|CREATE INDEX)\b/i);
  });

  it("6. dezelfde rechten als PR 1: alleen authenticated mag uitvoeren", () => {
    const grants = (t: string) => grantsAfter(t).split("\nCOMMENT ON")[0].trim();
    expect(grants(raw)).toBe(grants(pr1));
    expect(grants(raw)).toBe(
      `REVOKE ALL ON FUNCTION public.reclassify_bank_transaction(${SIGNATURE})\n  FROM PUBLIC, anon, authenticated, service_role;\n` +
        `GRANT EXECUTE ON FUNCTION public.reclassify_bank_transaction(${SIGNATURE})\n  TO authenticated;`,
    );
    expect(grantsAfter(raw)).toContain("bank_transactions.description blijft na elke correctie byte-gelijk");
  });
});

describe("het gedrag in de code", () => {
  it("7. de schrijver blijft de enige bron van grootboekregels; geen INSERT in het grootboek, geen andere schrijver herdefinieerd", () => {
    expect(newBody.split("public.post_bank_transaction(v_tx.id)").length - 1).toBe(1);
    expect(newBody).not.toMatch(/INSERT INTO public\.ledger_postings/i);
    expect(raw).not.toMatch(/FUNCTION\s+(?:public\.)?(post_bank_transaction|release_bank_transaction_posting|return_bank_transaction_to_workflow)\b/i);
  });

  it("8. de boekingstekst staat alleen tijdens de schrijver in de bankregel: zetten → schrijver → byte-gelijk herstel → toets → pas dán de gebeurtenis", () => {
    const zet = newBody.indexOf("    description          = v_new_desc\n");
    const schrijver = newBody.indexOf("v_new_group := public.post_bank_transaction(v_tx.id);");
    const herstel = newBody.indexOf("    description = v_tx.description\n  WHERE bt.id = v_tx.id;");
    const toets = newBody.indexOf(`bt.description COLLATE "C" IS NOT DISTINCT FROM v_tx.description COLLATE "C"`);
    const gebeurtenis = newBody.indexOf("INSERT INTO public.bank_transaction_posting_events", schrijver);
    expect(zet).toBeGreaterThan(0);
    expect(schrijver).toBeGreaterThan(zet);
    expect(herstel).toBeGreaterThan(schrijver);
    expect(toets).toBeGreaterThan(herstel);
    expect(gebeurtenis).toBeGreaterThan(toets);
    expect(newBody).toContain("RAISE EXCEPTION 'De oorspronkelijke bankomschrijving bleef niet behouden; er is niets geboekt' USING ERRCODE = '23514';");
    // Precies deze twee schrijfacties op de bankregel; de oude overschrijving is weg.
    expect(newBody.split("UPDATE public.bank_transactions bt SET").length - 1).toBe(2);
    expect(newBody).not.toContain("COALESCE(v_desc_arg, bt.description)");
  });

  it("9. zonder nieuwe omschrijving blijft de boekingsomschrijving uit het grootboek; de bankomschrijving alleen bij een eerste boeking", () => {
    expect(newBody).toContain(
      "v_new_desc := COALESCE(v_desc_arg, v_old_desc, v_hist_desc,\n                         NULLIF(btrim(v_tx.description), ''), 'Bankboeking');",
    );
    expect(newBody).toMatch(/JOIN public\.ledger_postings lp ON lp\.posting_group_id = e\.superseded_posting_group_id\s+WHERE e\.bank_transaction_id = v_tx\.id\s+ORDER BY e\.seq DESC, lp\.line_no, lp\.id\s+LIMIT 1;/);
    // De omschrijving wordt berekend vóór de unchanged-toets, die haar vergelijkt met het grootboek.
    expect(newBody.indexOf("v_new_desc := COALESCE(v_desc_arg")).toBeLessThan(newBody.indexOf("AND v_old_desc IS NOT DISTINCT FROM v_new_desc THEN"));
  });

  it("10. de voorwaardencontrole pint de RPC (PR 1 of deze) en haar eigenaar, de schrijver, de vijf triggers met hun functielichamen, en weigert RULE's en publicaties", () => {
    const pre = raw.slice(raw.indexOf("DO $migratie$"), raw.indexOf("$migratie$;"));
    expect(pre).toContain(OWNER_CHECK);
    expect(pre).toContain(`IF v_md5 NOT IN ('${PR1_BODY_MD5}', '${PR2_BODY_MD5}') THEN`);
    expect(pre).toContain(`IS DISTINCT FROM '${WRITER_MD5}' THEN`);
    for (const [tg, fn, h, modus] of BANK_TRIGGERS) {
      expect(pre, tg).toMatch(new RegExp(`\\('${tg}',\\s+'${fn}',\\s+'${h}', '${modus}'\\)`));
    }
    expect(pre).toContain("FROM pg_rules r WHERE r.schemaname = 'public' AND r.tablename = 'bank_transactions'");
    expect(pre).toContain("FROM pg_publication p WHERE p.puballtables");
    expect(pre).toContain("pt.schemaname = 'public' AND pt.tablename = 'bank_transactions'");
    expect((pre.match(/USING ERRCODE = '55000'/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it("11. de pins van de triggerfuncties zijn die van hun echte migraties (niet van een testkopie)", () => {
    const definitions = new Map<string, string>();
    for (const f of readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((x) => x.endsWith(".sql") && x < FILE).sort()) {
      const text = read(`${MIGRATION_DIR}/${f}`);
      for (const m of text.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(\s*\)[\s\S]*?AS\s+(\$\w*\$)([\s\S]*?)\2/gi)) {
        definitions.set(m[1], m[3]); // de laatste definitie wint, zoals bij toepassen
      }
    }
    for (const [, fn, h] of BANK_TRIGGERS) expect(md5(definitions.get(fn) ?? ""), fn).toBe(h);
  });
});

describe("rollback, harnas en uitrolcontroles", () => {
  it("12. rollback.sql zet de functie byte-gelijk terug naar PR 1, met haar rechten en commentaar — alleen vanuit PR 2 of PR 1, en doet verder niets", () => {
    const rb = read(`${ROLLOUT}/rollback.sql`);
    expect(definition(rb)).toBe(pr1Def);
    expect(grantsAfter(rb)).toBe(grantsAfter(pr1));
    const guard = rb.slice(rb.indexOf("DO $rollback$"), rb.indexOf("$rollback$;"));
    expect(guard).toContain(`v_md5 NOT IN ('${PR2_BODY_MD5}', '${PR1_BODY_MD5}')`);
    expect(guard).toContain("USING ERRCODE = '55000'");
    expect(guard).toContain(OWNER_CHECK);
    expect(rb.indexOf("DO $rollback$")).toBeLessThan(rb.indexOf("CREATE OR REPLACE FUNCTION"));
    expect(topLevelStatements(rb).map((s) => s.split(/\s+/).slice(0, 2).join(" ").toUpperCase())).toEqual([
      "DO …",
      "CREATE OR",
      "REVOKE ALL",
      "GRANT EXECUTE",
      "COMMENT ON",
    ]);
    expect(raw).toContain(`-- rollback: voer ${ROLLOUT}/rollback.sql`);
  });

  it("13. PRE en POST bestaan, zijn alleen-lezen (elke opdracht is een SELECT of WITH) en noemen het juiste project", () => {
    for (const f of ["preflight.sql", "postcheck.sql"]) {
      const text = read(`${ROLLOUT}/${f}`);
      expect(text, f).toContain("alxlbdhpbwlehbdbfejw");
      for (const stmt of topLevelStatements(text)) expect(stmt, f).toMatch(/^(SELECT|WITH)\b/i);
    }
  });

  it("14. POST pint het nieuwe lichaam en de ongewijzigde functies; PRE en POST pinnen dezelfde triggers als de migratie", () => {
    const post = read(`${ROLLOUT}/postcheck.sql`);
    const pre = read(`${ROLLOUT}/preflight.sql`);
    expect(post).toContain(`md5(p.prosrc) = '${PR2_BODY_MD5}'`);
    expect(post).toMatch(new RegExp(`\\('post_bank_transaction',\\s+'${WRITER_MD5}'\\)`));
    expect(pre).toMatch(new RegExp(`\\('post_bank_transaction',\\s+'${WRITER_MD5}'\\)`));
    expect(pre).toContain(`md5(prosrc) = '${PR1_BODY_MD5}'`);
    for (const [tg, fn, h, modus] of BANK_TRIGGERS) {
      const row = new RegExp(`\\('${tg}',\\s+'${fn}',\\s+'${h}', '${modus}'\\)`);
      expect(pre, tg).toMatch(row);
      expect(post, tg).toMatch(row);
    }
  });

  it("15. het harnas: echte keten incl. PR 0 en PR 1, de echte triggerlichamen, negatieve controle, twee keer toepassen, isolatie, fouten, races, rollback en opnieuw", () => {
    const run = read(`${HARNESS}/run-proof.sh`);
    expect(run).toContain("20261017120000_guard_direct_bank_posting_against_allocations");
    expect(run).toContain(`PR1="$MIG/${PR1_FILE}"`);
    expect(run).toContain("20260411182021_ce126469-1948-4a6f-947d-ad6dd95764cb.sql");
    expect(run).toContain("20260616014119_379a0719-29c0-4ba7-a513-06777db1dbc3.sql");
    expect(run).toContain('RB="${CORR2_ROLLBACK:-$ROLLOUT/rollback.sql}"');
    const order = ["pre.sql", "snapshot.sql", 'run -f "$M"', "proof.sql", "isolation.sql", "faults.sql", "concurrency.sql", 'run -f "$RB"', "after-rollback.sql", "final.sql"];
    let at = run.indexOf("run -f \"$HERE/helpers.sql\"");
    for (const step of order) {
      const next = run.indexOf(step, at);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    expect(run.split('run -f "$M"').length - 1).toBe(3);
    for (const f of ["helpers.sql", "pre.sql", "snapshot.sql", "proof.sql", "isolation.sql", "faults.sql", "concurrency.sql", "after-rollback.sql", "final.sql"]) {
      expect(existsSync(resolve(process.cwd(), HARNESS, f)), f).toBe(true);
    }
  });

  it("16. het harnas schrijft uitsluitend via de echte RPC's en schrijvers; nooit tegen productie", () => {
    for (const f of ["proof.sql", "isolation.sql", "faults.sql", "concurrency.sql", "final.sql", "after-rollback.sql", "pre.sql"]) {
      const text = read(`${HARNESS}/${f}`);
      expect(text, f).not.toMatch(/INSERT INTO public\.(ledger_postings|ledger_reversal_postings|bank_transaction_postings|bank_transaction_posting_events)/i);
      expect(text, f).not.toMatch(/alxlbdhpbwlehbdbfejw|supabase\.co/);
    }
    expect(read(`${HARNESS}/run-proof.sh`)).toMatch(/THROWAWAY DATABASE ONLY/);
  });

  it("17. na PR 1 vervangt alleen deze migratie een functie van PR 1 (reclassify_bank_transaction), en de hold-fix alleen de hold", () => {
    const pr1Functions = [...pr1.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(\w+)\s*\(/gi)].map((m) => m[1]);
    expect(pr1Functions).toContain("reclassify_bank_transaction");
    for (const f of readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((x) => x.endsWith(".sql") && x > PR1_FILE)) {
      const defined = [...read(`${MIGRATION_DIR}/${f}`).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi)].map((m) => m[1]);
      const overlap = defined.filter((n) => pr1Functions.includes(n));
      expect(overlap, f).toEqual(
        f === FILE ? ["reclassify_bank_transaction"] : f === HOLD_FIX_FILE ? ["enforce_bank_transaction_release_hold"] : [],
      );
    }
  });
});

describe("na deze migratie", () => {
  it("20. struikeldraad: geen latere migratie zet een trigger, RULE of publicatie op bank_transactions of herdefinieert een van de vastgepinde functies", () => {
    // Het veiligheidsargument van de tijdelijke omschrijving (geen trigger schrijft
    // haar ergens weg, niets zendt haar uit) geldt voor de catalogus van nu. Een
    // latere migratie die dat raakt, moet het argument opnieuw laten beoordelen en
    // de pins in deze migratie, PRE/POST en deze test bijwerken.
    const pinned = ["post_bank_transaction", "reclassify_bank_transaction", ...BANK_TRIGGERS.map(([, fn]) => fn)];
    for (const f of readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((x) => x.endsWith(".sql") && x > FILE)) {
      const code = read(`${MIGRATION_DIR}/${f}`)
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n");
      expect(code, f).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER[^;]*\bON\s+(?:public\.)?bank_transactions\b/i);
      expect(code, f).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?RULE[^;]*\bbank_transactions\b/i);
      expect(code, f).not.toMatch(/PUBLICATION[^;]*\bbank_transactions\b|FOR\s+ALL\s+TABLES|TABLES\s+IN\s+SCHEMA/i);
      // Ook via dynamische SQL (zo kwam set_organization_id_trigger ooit op bank_transactions): elke
      // CREATE TRIGGER binnen een EXECUTE in een latere migratie vraagt om dezelfde herbeoordeling.
      expect(code, f).not.toMatch(/EXECUTE\s+(?:format\s*\()?\s*'[^;]*CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER/i);
      expect(code, f).not.toMatch(/ALTER\s+TABLE[^;]*\bbank_transactions\b[^;]*TRIGGER/i);
      for (const fn of pinned) {
        // Herbeoordeeld: de hold-fix mag (alleen) de hold herdefiniëren — zie hieronder.
        if (f === HOLD_FIX_FILE && fn === "enforce_bank_transaction_release_hold") continue;
        expect(code, `${f}: ${fn}`).not.toMatch(new RegExp(`FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`, "i"));
      }
    }
  });

  it("20b. herbeoordeling van de hold-fix: de nieuwe hold en haar hulpfunctie schrijven niets en zenden niets uit", () => {
    const fix = read(`${MIGRATION_DIR}/${HOLD_FIX_FILE}`);
    const bodyAfter = (header: string) => {
      const start = fix.indexOf(header);
      expect(start, header).toBeGreaterThan(0);
      const from = fix.indexOf("AS $$", start) + "AS $$".length;
      return fix.slice(from, fix.indexOf("$$;", from));
    };
    const hold = bodyAfter("CREATE OR REPLACE FUNCTION public.enforce_bank_transaction_release_hold()");
    const helper = bodyAfter("CREATE OR REPLACE FUNCTION public.bank_transaction_group_is_settled_history(");
    expect(md5(hold)).toBe(HOLD_FIX_BODY_MD5);
    expect(md5(helper)).toBe(HOLD_FIX_HELPER_MD5);
    const code = (b: string) =>
      b.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").replace(/'(?:[^']|'')*'/g, "''");
    for (const [naam, b] of [["hold", hold], ["hulpfunctie", helper]] as const) {
      expect(code(b), naam).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY|NOTIFY|pg_notify|dblink\w*|EXECUTE|PERFORM)\b/i);
    }
    expect(fix).toMatch(/bank_transaction_group_is_settled_history\([\s\S]*?\)\s+RETURNS boolean\s+LANGUAGE sql\s+STABLE\s+SET search_path = public\s+AS \$\$/);
    // Geen nieuwe trigger, RULE of publicatie: de fix voegt alleen een voorwaarde toe aan een bestaande triggerfunctie.
    const top = fix.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").replace(/AS \$\$[\s\S]*?\$\$;/g, "");
    expect(top).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER|RULE|PUBLICATION|ALTER\s+TABLE/i);
  });
});

describe("branch-grenzen", () => {
  const changed = git("diff", "--name-only", "origin/main...HEAD");
  const introducedHere =
    git("diff", "--name-only", "--diff-filter=A", "origin/main...HEAD")?.includes(MIGRATION) ?? false;

  it("18. geen bestaande migratie gewijzigd, verwijderd, hernoemd of van type veranderd", (ctx) => {
    const existing = git("diff", "--name-only", "--diff-filter=MDRT", "origin/main...HEAD", "--", MIGRATION_DIR);
    if (!existing) return ctx.skip();
    expect(existing).toEqual([]);
  });

  it("19. op de branch die PR 2 invoert: geen app, geen gegenereerde types, geen packages, geen export; fundering en schrijvers onaangeroerd", (ctx) => {
    if (!changed || !introducedHere) return ctx.skip();
    for (const f of [
      "src/integrations/supabase/types.ts", "package.json", "package-lock.json", "bun.lockb",
      "src/pages/Bank.tsx", "src/lib/snelstart-export.ts", "src/lib/bank-statement-parser.ts",
      "supabase/functions/mcp/index.ts", "ENVIRONMENT.md",
    ]) {
      expect(changed, f).not.toContain(f);
    }
    expect(changed.filter((f) => f.startsWith("src/") && !f.startsWith("src/test/"))).toEqual([]);
    expect(changed.filter((f) => f.startsWith("supabase/functions/"))).toEqual([]);
    expect(changed.filter((f) => f.startsWith(`${MIGRATION_DIR}/`))).toEqual([MIGRATION]);
    assertBranchSqlKeepsLedgerFoundation(changed);
    assertBranchTouchesNoExistingWriter(changed);
  });
});
