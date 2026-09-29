import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";

/**
 * ACL-hardening — interne hulpfuncties alleen voor de eigenaar.
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Het GEDRAG staat in `supabase/tests/function-acl-hardening/` en draait tegen
 * een echte PostgreSQL met Supabase's standaard-functierechten nagebootst
 * (49 bewijzen): eerst de blootstelling uit productie, dan dat zij dicht is,
 * dat elk toegangspunt als `authenticated` nog echt boekt, en dat verder niets
 * — geen lichaam, geen eigenaar, geen tabelrecht — is veranderd.
 *
 * Dit bestand bewaakt de VORM, en de aanname waar de hele migratie op rust:
 * **elke SQL-aanroeper van deze hulpfuncties is SECURITY DEFINER**, en geen
 * app-code roept ze rechtstreeks aan. Een latere SECURITY INVOKER-aanroeper
 * zou na deze migratie stilzwijgend "permission denied" krijgen; die komt hier
 * dus niet ongemerkt binnen.
 */

const MIGRATION_SLUG = "_harden_internal_function_acls.sql";
const MIGRATION_DIR = "supabase/migrations";
const allMigrations = readdirSync(resolve(process.cwd(), MIGRATION_DIR))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const ownMigrations = allMigrations.filter((f) => f.endsWith(MIGRATION_SLUG));
const MIGRATION = `${MIGRATION_DIR}/${ownMigrations[0]}`;

const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");

/** Commentaar weg: een bewering over de CODE mag nooit op proza slagen. */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const sql = withoutComments(raw);
const flat = sql.replace(/\s+/g, " ").trim();

/** Het DO-blok met de vereisten apart; de rest zijn de eigenlijke opdrachten. */
const doBlock = flat.match(/DO \$migratie\$.*?\$migratie\$;/)?.[0] ?? "";
const statements = flat
  .replace(doBlock, "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const INTERN = [
  "public.lock_ledger_client(uuid)",
  "public.ledger_client_lock_key(uuid)",
  "public.posting_allowed(uuid, date)",
];

const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

/**
 * De LAATSTE definitie van elke functie over alle migraties heen, zoals
 * productie haar na toepassing in volgorde kent.
 */
function finalDefinitions(): Map<string, { header: string; body: string; file: string }> {
  const defs = new Map<string, { header: string; body: string; file: string }>();
  for (const file of allMigrations) {
    const text = readFileSync(resolve(process.cwd(), MIGRATION_DIR, file), "utf8");
    const re = /^CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_0-9]+)\s*\(/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const as = /\bAS\s+(\$[A-Za-z_0-9]*\$)/.exec(text.slice(m.index));
      if (!as) continue;
      const bodyStart = m.index + as.index + as[0].length;
      const bodyEnd = text.indexOf(as[1], bodyStart);
      defs.set(m[1], {
        header: text.slice(m.index, m.index + as.index),
        body: withoutComments(text.slice(bodyStart, bodyEnd)),
        file,
      });
    }
  }
  return defs;
}

function appSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (path === "src/test") continue;
      out.push(...appSources(path));
    } else if (/\.(ts|tsx)$/.test(entry.name) && path !== "src/integrations/supabase/types.ts") {
      out.push(path);
    }
  }
  return out;
}

describe("Migratie — ACL-hardening van interne hulpfuncties", () => {
  it("1. bestaat precies één keer, met een UTC-tijdstempel ná de handhaving van de boekingsblokkade", () => {
    expect(ownMigrations).toHaveLength(1);
    expect(ownMigrations[0]).toMatch(/^\d{14}_harden_internal_function_acls\.sql$/);
    expect(ownMigrations[0].slice(0, 14) > "20260928120000").toBe(true);
  });

  it("2. bevat uitsluitend REVOKE en GRANT op functies — geen DDL, geen data, geen standaardrechten", () => {
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(s, s).toMatch(/^(REVOKE ALL|GRANT EXECUTE) ON FUNCTION public\.\w+\([^)]*\) (FROM|TO) /);
    }
    expect(flat).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|COMMENT ON)\b/i);
    expect(flat).not.toMatch(/DEFAULT PRIVILEGES/i);
    expect(flat).not.toMatch(/OWNER TO|SECURITY (DEFINER|INVOKER)|search_path/i);
    expect(flat).not.toMatch(/ON (TABLE )?public\.(?!\w+\()/);
  });

  it("3. de drie interne hulpfuncties: alles ingetrokken van PUBLIC, anon, authenticated én service_role", () => {
    for (const fn of INTERN) {
      expect(statements, fn).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated, service_role`);
    }
  });

  it("4. niemand krijgt er iets bij, behalve authenticated op post_purchase_invoice", () => {
    const grants = statements.filter((s) => s.startsWith("GRANT"));
    expect(grants).toEqual(["GRANT EXECUTE ON FUNCTION public.post_purchase_invoice(uuid) TO authenticated"]);
    expect(flat).not.toMatch(/TO[^;]*\b(anon|service_role|PUBLIC)\b/);
  });

  it("5. post_purchase_invoice: anon en service_role eruit, authenticated wordt NOOIT ingetrokken", () => {
    const revokes = statements.filter((s) => s.includes("post_purchase_invoice"));
    expect(revokes).toContain("REVOKE ALL ON FUNCTION public.post_purchase_invoice(uuid) FROM PUBLIC, anon, service_role");
    for (const s of revokes.filter((r) => r.startsWith("REVOKE"))) {
      expect(s, "de app mist nooit, ook niet binnen de transactie, haar recht").not.toMatch(/\bauthenticated\b/);
    }
  });

  it("6. assert_posting_allowed wordt niet aangeraakt — alleen als vereiste gecontroleerd", () => {
    expect(statements.filter((s) => s.includes("assert_posting_allowed"))).toEqual([]);
    expect(doBlock).toContain("to_regprocedure('public.assert_posting_allowed(uuid,date)') IS NULL");
  });

  it("7. faalt gesloten als een doelfunctie ontbreekt", () => {
    for (const sig of [
      "public.lock_ledger_client(uuid)",
      "public.ledger_client_lock_key(uuid)",
      "public.posting_allowed(uuid,date)",
      "public.post_purchase_invoice(uuid)",
    ]) {
      expect(doBlock, sig).toContain(`to_regprocedure('${sig}') IS NULL`);
    }
    expect(doBlock).toContain("RAISE EXCEPTION");
  });

  it("8. documenteert de handmatige rollback", () => {
    expect(raw).toMatch(/ROLLBACK/);
    for (const fn of ["lock_ledger_client", "ledger_client_lock_key", "posting_allowed", "post_purchase_invoice"]) {
      expect(raw, fn).toMatch(new RegExp(`--\\s+GRANT EXECUTE ON FUNCTION public\\.${fn}\\(`));
    }
  });
});

describe("De aanname onder de migratie — wie roept deze hulpfuncties aan?", () => {
  const defs = finalDefinitions();

  it("9. elke SQL-aanroeper van lock_ledger_client en posting_allowed is SECURITY DEFINER", () => {
    const callers: string[] = [];
    for (const [name, def] of defs) {
      const calls =
        /\block_ledger_client\s*\(/.test(def.body) || /(?<!assert_)\bposting_allowed\s*\(/.test(def.body);
      if (!calls || name === "lock_ledger_client") continue;
      callers.push(name);
      expect(def.header, `${name} (${def.file}) roept een interne hulpfunctie aan`).toMatch(/SECURITY DEFINER/i);
    }
    // De bekende aanroepers; een nieuwe moet hier bewust bijgeschreven worden.
    expect(callers.sort()).toEqual([
      "assert_posting_allowed",
      "close_fiscal_year",
      "declare_opening_balance_nil",
      "lock_ledger_client_for_posting",
      "post_opening_balance",
      "reopen_fiscal_year",
      "reverse_posting_group",
      "set_posting_lock",
    ]);
  });

  it("10. ledger_client_lock_key wordt alleen door lock_ledger_client gebruikt", () => {
    const callers = [...defs]
      .filter(([name, def]) => name !== "ledger_client_lock_key" && /\bledger_client_lock_key\s*\(/.test(def.body))
      .map(([name]) => name);
    expect(callers).toEqual(["lock_ledger_client"]);
  });

  it("11. geen policy of view gebruikt een van de drie", () => {
    for (const file of allMigrations) {
      const text = withoutComments(readFileSync(resolve(process.cwd(), MIGRATION_DIR, file), "utf8"));
      for (const stmt of text.match(/CREATE (?:OR REPLACE )?(?:POLICY|VIEW)\b[^;]*;/gi) ?? []) {
        expect(stmt, file).not.toMatch(/lock_ledger_client|ledger_client_lock_key|posting_allowed/);
      }
    }
  });

  it("12. geen app-code of edge function roept de drie rechtstreeks aan", () => {
    const files = [...appSources("src"), ...appSources("supabase/functions")];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(text, file).not.toMatch(/rpc\(\s*["'`](lock_ledger_client|ledger_client_lock_key|posting_allowed|assert_posting_allowed)["'`]/);
    }
  });

  it("13. post_purchase_invoice is een echt toegangspunt voor de app, maar niet voor de edge functions", () => {
    const hook = readFileSync(resolve(process.cwd(), "src/hooks/usePurchaseInvoicePosting.ts"), "utf8");
    expect(hook).toMatch(/\.rpc\(\s*"post_purchase_invoice"/);
    for (const file of appSources("supabase/functions")) {
      expect(readFileSync(resolve(process.cwd(), file), "utf8"), file).not.toContain("post_purchase_invoice");
    }
  });
});

describe("Scope van elke latere branch", () => {
  /*
   * Bewust GEEN "deze branch wijzigt geen src/"-uitspraak: dat was waar over de
   * PR die deze migratie invoerde, maar is geen invariant en laat elke latere,
   * terechte wijziging omvallen (zie branch-sql-scope.ts). Wat wél altijd moet
   * gelden: deze migratie wordt nooit achteraf herschreven, de bestaande
   * schrijvers en de grootboekfundering blijven ongemoeid.
   */
  it("14. herschrijft deze migratie niet achteraf en raakt geen schrijver of fundering", () => {
    const touched = changed.filter((f) => f.startsWith("supabase/migrations/"));
    const introducedHere = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", "origin/main...HEAD"], { encoding: "utf8" })
      .split("\n")
      .includes(MIGRATION);
    if (!introducedHere) expect(touched, "20260929120000 wordt niet achteraf bijgesteld").not.toContain(MIGRATION);
    assertBranchTouchesNoExistingWriter(changed);
    assertBranchSqlKeepsLedgerFoundation(changed);
  });
});
