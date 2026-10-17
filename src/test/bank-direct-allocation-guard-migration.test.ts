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
 * PR 0 — geen dubbele bankboeking via een directe boeking én een factuurkoppeling.
 *
 * Het échte gedrag (de weigeringen door de echte schrijvers en guards, rechten,
 * twee gelijktijdige sessies, de negatieve controle zonder PR 0, rollback en
 * opnieuw toepassen) wordt bewezen tegen een echte PostgreSQL in
 * supabase/tests/bank-direct-allocation-guard/ (125 bewijzen). CI heeft geen
 * PostgreSQL; deze test bewaakt de vorm van de migratie, haar grenzen en de
 * samenhang met het harnas en de uitrolcontroles.
 */

const MIGRATION_DIR = "supabase/migrations";
const FILE = "20261017120000_guard_direct_bank_posting_against_allocations.sql";
const MIGRATION = `${MIGRATION_DIR}/${FILE}`;
/** SHA-256 van de migratie zoals beoordeeld en voor productie overgedragen. */
const REVIEWED_SHA256 = "d1fa9bae418a200cfd2ae46408690535913778df96b8d6acdd39c19eaf8ebd97";
const HARNESS = "supabase/tests/bank-direct-allocation-guard";
const ROLLOUT = "supabase/rollout/20261017120000_guard_direct_bank_posting_against_allocations";

const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
/** Zonder commentaar: de kop beschrijft juist wat er NIET gebeurt. */
const sql = raw
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const GUARDS = {
  enforce_bank_allocation_not_directly_posted: {
    trigger: "validate_bank_allocation_not_directly_posted_trigger",
    table: "bank_transaction_allocations",
    timing: "AFTER INSERT OR UPDATE OF bank_transaction_id",
    // Het app-pad: botst met elke FOR UPDATE, blokkeert gewone UPDATEs niet.
    lock: "FOR KEY SHARE",
  },
  enforce_bank_allocation_posting_not_directly_posted: {
    trigger: "validate_bank_allocation_posting_not_directly_posted_trigger",
    table: "bank_allocation_postings",
    timing: "BEFORE INSERT",
    // Wat de schrijvers al houden; daarbuiten botst hij met guards 1 en 3.
    lock: "FOR UPDATE",
  },
  enforce_bank_direct_posting_without_allocations: {
    trigger: "validate_bank_direct_posting_without_allocations_trigger",
    table: "bank_transaction_postings",
    timing: "BEFORE INSERT",
    lock: "FOR UPDATE",
  },
} as const;
type GuardName = keyof typeof GUARDS;
const NAMES = Object.keys(GUARDS) as GuardName[];

/** Het lichaam tussen `AS $$` en `$$;` van één guardfunctie — letterlijk, dus gelijk aan prosrc. */
function rawBody(name: GuardName): string {
  const m = raw.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)\\n[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`));
  if (!m) throw new Error(`functie ${name} niet gevonden`);
  return m[1];
}

/** Hetzelfde lichaam zonder commentaarregels, voor inhoudelijke controles. */
function body(name: GuardName): string {
  return rawBody(name)
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

/** Uitvoerbare SQL zonder commentaarregels en zonder de inhoud van stringliterals. */
function statements(text: string): string[] {
  return text
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

describe("migratie 20261017120000 — vorm", () => {
  it("1. bestaat één keer, en sorteert na de bankschrijvers, PR H en 20261010120000", () => {
    const files = readdirSync(resolve(process.cwd(), MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.filter((f) => f.endsWith("_guard_direct_bank_posting_against_allocations.sql"))).toEqual([FILE]);
    const positie = files.indexOf(FILE);
    for (const prefix of ["20260917120000_", "20260920195805_", "20261002120000_", "20261010120000_"]) {
      const voorganger = files.findIndex((f) => f.startsWith(prefix));
      expect(voorganger, prefix).toBeGreaterThanOrEqual(0);
      expect(voorganger, prefix).toBeLessThan(positie);
    }
  });

  it("2. byte-voor-byte de beoordeelde versie (SHA-256 over de ruwe bytes)", () => {
    const sha256 = createHash("sha256").update(readFileSync(resolve(process.cwd(), MIGRATION))).digest("hex");
    expect(sha256).toBe(REVIEWED_SHA256);
  });

  it("3. precies drie nieuwe functies, elk een triggerfunctie: plpgsql, SECURITY DEFINER, vaste search_path", () => {
    const defs = [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\(/g)].map((m) => m[1]);
    expect(defs.sort()).toEqual(NAMES.map((n) => `public.${n}`).sort());
    for (const name of NAMES) {
      expect(sql, name).toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)\\nRETURNS trigger\\nLANGUAGE plpgsql\\nSECURITY DEFINER\\nSET search_path = public\\nAS \\$\\$`),
      );
      // VOLATILE (de standaard): elke opdracht in de functie krijgt een verse snapshot.
      expect(sql.match(new RegExp(`FUNCTION public\\.${name}\\(\\)[\\s\\S]*?AS \\$\\$`))?.[0], name).not.toMatch(/STABLE|IMMUTABLE/);
    }
  });

  it("4. geen enkel uitvoerrecht: REVOKE voor PUBLIC en alle drie de applicatierollen, geen GRANT", () => {
    for (const name of NAMES) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated, service_role;`);
    }
    expect(sql).not.toMatch(/\bGRANT\b/);
  });

  it("5. drie triggers, idempotent aangemaakt, met de juiste tabel, timing en functie; geen ENABLE ALWAYS", () => {
    for (const name of NAMES) {
      const g = GUARDS[name];
      expect(sql).toContain(`DROP TRIGGER IF EXISTS ${g.trigger} ON public.${g.table};`);
      expect(sql).toContain(
        `CREATE TRIGGER ${g.trigger}\n  ${g.timing} ON public.${g.table}\n  FOR EACH ROW EXECUTE FUNCTION public.${name}();`,
      );
    }
    expect(sql.match(/CREATE TRIGGER/g)).toHaveLength(3);
    expect(sql).not.toMatch(/ENABLE ALWAYS|DISABLE TRIGGER|session_replication_role/i);
  });
});

describe("de guards — wat zij toetsen", () => {
  it("6. alle drie grendelen de banktransactie vóórdat zij een marker of koppeling tellen; guards 2 en 3 met FOR UPDATE", () => {
    for (const name of NAMES) {
      const b = body(name);
      const lock = b.indexOf(`FROM public.bank_transactions bt\n  WHERE bt.id = NEW.bank_transaction_id\n  ${GUARDS[name].lock};`);
      expect(lock, name).toBeGreaterThan(0);
      const firstRead = b.search(/IF EXISTS \(/);
      expect(firstRead, name).toBeGreaterThan(lock);
      // Precies één grendel op de banktransactie per guard.
      expect(b.match(/FROM public\.bank_transactions bt/g), name).toHaveLength(1);
    }
    // Elk paar botsende routes heeft minstens één kant met FOR UPDATE: twee
    // FOR KEY SHARE-grendels zouden elkaar niet tegenhouden.
    expect(NAMES.filter((n) => GUARDS[n].lock === "FOR KEY SHARE")).toEqual(["enforce_bank_allocation_not_directly_posted"]);
  });

  it("7. alle drie alleen onder READ COMMITTED, getoetst vóór de grendel; guard 1 alleen bij INSERT of een echte verplaatsing", () => {
    for (const name of NAMES) {
      const b = body(name);
      expect(b, name).toMatch(/IF current_setting\('transaction_isolation'\) <> 'read committed' THEN[\s\S]*?USING ERRCODE = '25000';/);
      expect(b.indexOf("transaction_isolation"), name).toBeLessThan(b.indexOf(GUARDS[name].lock));
    }
    const b = body("enforce_bank_allocation_not_directly_posted");
    expect(b).toMatch(/IF TG_OP = 'UPDATE' AND NEW\.bank_transaction_id IS NOT DISTINCT FROM OLD\.bank_transaction_id THEN\s+RETURN NULL;/);
    expect(b).toMatch(/FROM public\.bank_transaction_postings m\s+WHERE m\.bank_transaction_id = NEW\.bank_transaction_id/);
  });

  it("7b. guard 1 toetst eerst tenantconsistentie, met één neutrale weigering, vóór de boekingsstaat", () => {
    const b = body("enforce_bank_allocation_not_directly_posted");
    expect(b).toMatch(/SELECT bt\.organization_id, bt\.client_id INTO v_tx_org, v_tx_client\s+FROM public\.bank_transactions bt/);
    const tenant = b.search(
      /IF NOT FOUND\s+OR NEW\.organization_id IS DISTINCT FROM v_tx_org\s+OR NEW\.client_id IS DISTINCT FROM v_tx_client THEN\s+RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501';/,
    );
    expect(tenant).toBeGreaterThan(b.indexOf("FOR KEY SHARE"));
    expect(tenant).toBeLessThan(b.indexOf("FROM public.bank_transaction_postings m"));
  });

  it("8. guard 2: de transactie komt uit de koppeling zelf (FOR SHARE), niet uit de marker", () => {
    const b = body("enforce_bank_allocation_posting_not_directly_posted");
    expect(b).toMatch(/SELECT a\.bank_transaction_id INTO v_alloc_tx\s+FROM public\.bank_transaction_allocations a\s+WHERE a\.id = NEW\.allocation_id\s+FOR SHARE;/);
    expect(b).toMatch(/IF v_alloc_tx IS DISTINCT FROM NEW\.bank_transaction_id THEN/);
    expect(b).toMatch(/FROM public\.bank_transaction_postings m\s+WHERE m\.bank_transaction_id = NEW\.bank_transaction_id/);
  });

  it("9. guard 3: weigert bij een geboekte aflettering én bij elke koppeling", () => {
    const b = body("enforce_bank_direct_posting_without_allocations");
    expect(b).toMatch(/FROM public\.bank_allocation_postings p\s+WHERE p\.bank_transaction_id = NEW\.bank_transaction_id/);
    expect(b).toMatch(/FROM public\.bank_transaction_allocations a\s+WHERE a\.bank_transaction_id = NEW\.bank_transaction_id/);
  });

  it("10. weigeringen gebruiken 23514, 25000 of de neutrale 42501, nooit 23505: de schrijvers vangen rond hun marker alleen unique_violation", () => {
    for (const name of NAMES) {
      const codes = [...body(name).matchAll(/ERRCODE = '(\w+)'/g)].map((m) => m[1]);
      expect(codes.length, name).toBeGreaterThan(0);
      for (const code of codes) expect(["23514", "25000", "42501"], `${name}: ${code}`).toContain(code);
    }
    // 42501 alleen in guard 1, en alleen met de neutrale tekst van de schrijvers.
    for (const name of NAMES) {
      const neutral = body(name).match(/RAISE EXCEPTION '([^']*)' USING ERRCODE = '42501'/g) ?? [];
      expect(neutral, name).toEqual(
        name === "enforce_bank_allocation_not_directly_posted"
          ? ["RAISE EXCEPTION 'Banktransactie niet beschikbaar' USING ERRCODE = '42501'"]
          : [],
      );
    }
  });

  it("11. integriteit, geen autorisatie: geen auth.uid(), geen rol, geen administratiegrendel", () => {
    for (const name of NAMES) {
      const b = body(name);
      expect(b, name).not.toMatch(/auth\.uid|has_min_role|current_user|session_user/);
      expect(b, name).not.toMatch(/\block_ledger_client\s*\(|(?<!assert_)\bposting_allowed\s*\(/);
    }
  });
});

describe("wat de migratie niet doet", () => {
  it("12. geen data, geen schema-wijziging, geen schrijver: alleen functies, triggers, commentaar en een vereistencontrole", () => {
    expect(sql).not.toMatch(/\b(INSERT INTO|UPDATE public\.|DELETE FROM|TRUNCATE|ALTER TABLE|CREATE TABLE|DROP TABLE|CREATE POLICY|DROP POLICY|ALTER FUNCTION)\b/i);
    expect(sql).not.toMatch(/INSERT INTO public\.ledger_postings/);
    for (const writer of [
      "post_bank_transaction", "post_bank_allocation", "post_purchase_invoice", "post_sales_invoice",
      "post_manual_journal", "post_opening_balance", "reverse_posting_group", "bank_bulk_posting_candidates",
      "post_bank_transactions_bulk", "prevent_posted_bank_transaction_mutation", "prevent_posted_bank_allocation_mutation",
      "enforce_bank_transaction_source_claim", "enforce_bank_source_claim",
    ]) {
      expect(sql, writer).not.toMatch(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${writer}\\s*\\(`, "i"));
    }
  });

  it("13. faalt gesloten zonder de tabellen, kolommen en schrijvers waarop zij leunt", () => {
    for (const t of ["bank_transactions", "bank_transaction_allocations", "bank_allocation_postings", "bank_transaction_postings"]) {
      expect(sql).toContain(`to_regclass('public.${t}') IS NULL`);
    }
    expect(sql).toContain("to_regprocedure('public.post_bank_transaction(uuid)') IS NULL");
    expect(sql).toContain("to_regprocedure('public.post_bank_allocation(uuid)') IS NULL");
  });

  it("14. een gedocumenteerde rollback die exact de drie triggers en drie functies weghaalt, en geen projectrefs", () => {
    const block = raw.match(/-- ROLLBACK-BEGIN\n([\s\S]*?)-- ROLLBACK-END/)?.[1] ?? "";
    const lines = block.split("\n").filter(Boolean).map((l) => l.replace(/^-- {3}/, ""));
    expect(lines).toEqual([
      ...NAMES.slice().reverse().map((n) => `DROP TRIGGER IF EXISTS ${GUARDS[n].trigger} ON public.${GUARDS[n].table};`),
      ...NAMES.slice().reverse().map((n) => `DROP FUNCTION IF EXISTS public.${n}();`),
    ]);
    expect(raw).not.toMatch(/olumcwneiejjefhkzgmz|ycuofllsdssoezwwpqmv/);
    expect(raw).toContain("alxlbdhpbwlehbdbfejw");
  });
});

describe("harnas en uitrolcontroles", () => {
  it("15. het echt-PostgreSQL-harnas past de echte keten toe, doet de negatieve controle vóór de migratie, past haar twee keer toe en rolt terug", () => {
    const run = readFileSync(resolve(process.cwd(), `${HARNESS}/run-proof.sh`), "utf8");
    expect(run).toMatch(/THROWAWAY DATABASE ONLY/);
    for (const f of [
      "20260915140000_add_purchase_ledger_posting", "20260915160000_add_sales_ledger_posting",
      "20260917120000_add_bank_settlement_posting", "20260920195805_6ad6dbd8-cdb3-4ecd-8482-46464f138c39",
      "20261002120000_decouple_year_watermark_from_posting",
    ]) {
      expect(run, f).toContain(f);
    }
    expect(run.indexOf('"$HERE/pre.sql"')).toBeLessThan(run.indexOf('run -f "$M"'));
    expect(run.match(/^run -f "\$M"/gm)).toHaveLength(3);
    expect(run.match(/^run -c "\$ROLLBACK"/gm)).toHaveLength(2);
    expect(run).toContain("concurrency-pre.sql");
    expect(run).toContain("concurrency.sql");
  });

  it("16. het harnas gebruikt geen stubs voor wat het bewaakt: geen marker-, grootboek- of schrijverdubbel", () => {
    const bootstrap = readFileSync(resolve(process.cwd(), `${HARNESS}/bootstrap-sources.sql`), "utf8")
      .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    for (const object of ["bank_allocation_postings", "bank_transaction_postings", "purchase_invoice_postings",
                          "sales_invoice_postings", "ledger_postings", "ledger_reversal_postings"]) {
      expect(bootstrap, object).not.toMatch(new RegExp(`CREATE TABLE[^;]*\\b${object}\\b`));
    }
    expect(bootstrap).not.toMatch(/CREATE (?:OR REPLACE )?FUNCTION/);
    // De fixtures boeken uitsluitend via de echte schrijvers.
    const fixtures = readFileSync(resolve(process.cwd(), `${HARNESS}/fixtures.sql`), "utf8");
    expect(fixtures).not.toMatch(/INSERT INTO public\.(ledger_postings|bank_transaction_postings|bank_allocation_postings)/);
  });

  it("17. PRE en POST bestaan, zijn alleen-lezen (elke opdracht is een SELECT) en noemen het juiste project", () => {
    for (const f of ["preflight.sql", "postcheck.sql"]) {
      const path = resolve(process.cwd(), `${ROLLOUT}/${f}`);
      expect(existsSync(path), f).toBe(true);
      const text = readFileSync(path, "utf8");
      const stmts = statements(text);
      expect(stmts.length, f).toBeGreaterThan(5);
      for (const s of stmts) expect(s.slice(0, 60), f).toMatch(/^(SELECT|WITH)\b/i);
      expect(text, f).toContain("alxlbdhpbwlehbdbfejw");
      // De geblokkeerde refs mogen alleen in een "nooit"-regel voorkomen.
      for (const line of text.split("\n").filter((l) => /olumcwneiejjefhkzgmz|ycuofllsdssoezwwpqmv/.test(l))) {
        expect(line, f).toMatch(/nooit|never/i);
      }
    }
    expect(readFileSync(resolve(process.cwd(), `${ROLLOUT}/preflight.sql`), "utf8")).toMatch(/AS stop;/);
  });

  it("18. POST pint de guardlichamen: md5 per functie is die van het lichaam in de migratie", () => {
    const post = readFileSync(resolve(process.cwd(), `${ROLLOUT}/postcheck.sql`), "utf8");
    for (const name of NAMES) {
      const md5 = createHash("md5").update(rawBody(name), "utf8").digest("hex");
      expect(post, name).toContain(`('${name}',`);
      expect(post, name).toMatch(new RegExp(`\\('${name}',\\s+'${md5}'\\)`));
    }
  });
});

describe("branch-grenzen", () => {
  const changed = git("diff", "--name-only", "origin/main...HEAD");
  const introducedHere =
    git("diff", "--name-only", "--diff-filter=A", "origin/main...HEAD")?.includes(MIGRATION) ?? false;

  it("19. geen bestaande migratie gewijzigd, verwijderd, hernoemd of van type veranderd", (ctx) => {
    const existing = git("diff", "--name-only", "--diff-filter=MDRT", "origin/main...HEAD", "--", MIGRATION_DIR);
    if (!existing) return ctx.skip();
    expect(existing).toEqual([]);
  });

  it("20. op de branch die PR 0 invoert: geen app, geen gegenereerde types, geen packages; fundering en schrijvers onaangeroerd", (ctx) => {
    if (!changed || !introducedHere) return ctx.skip();
    for (const f of [
      "src/integrations/supabase/types.ts", "package.json", "package-lock.json",
      "src/pages/Bank.tsx", "src/pages/Facturen.tsx", "src/pages/Verkoop.tsx",
      "supabase/functions/mcp/index.ts", ".lovable/mcp/manifest.json",
    ]) {
      expect(changed, f).not.toContain(f);
    }
    expect(changed.filter((f) => f.startsWith("src/") && !f.startsWith("src/test/"))).toEqual([]);
    assertBranchSqlKeepsLedgerFoundation(changed);
    assertBranchTouchesNoExistingWriter(changed);
  });
});
