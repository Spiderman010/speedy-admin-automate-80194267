import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";
import { appCode, appFilesMatching, appSourceFiles } from "@/test/support/app-sources";

/**
 * Legacy `journal_entries` wordt ook in de DATABASE alleen-lezen.
 *
 * WAT HIER WEL EN NIET WORDT BEWEZEN
 * Het GEDRAG staat in `supabase/tests/journal-entries-read-only/` en draait
 * tegen een echte PostgreSQL met Supabase's standaardrechten nagebootst en de
 * échte policies uit 20260613001452 (37 bewijzen): eerst dat schrijven kon,
 * dan dat het op beide lagen dicht is, dat lezen en tenant-isolatie gelijk
 * blijven, en dat verder niets — geen rij, kolom, FK, trigger, functie of
 * ander tabelrecht — is veranderd.
 *
 * Dit bestand bewaakt de VORM van de migratie, en de aanname waar zij op rust:
 * niemand in app, edge functions of database schrijft `journal_entries` nog.
 */

const MIGRATION_SLUG = "_make_journal_entries_read_only.sql";
const MIGRATION_DIR = "supabase/migrations";
const allMigrations = readdirSync(resolve(process.cwd(), MIGRATION_DIR))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const ownMigrations = allMigrations.filter((f) => f.endsWith(MIGRATION_SLUG));
const MIGRATION = `${MIGRATION_DIR}/${ownMigrations[0]}`;

const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");

function withoutComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const flat = withoutComments(raw).replace(/\s+/g, " ").trim();
const doBlock = flat.match(/DO \$migratie\$.*?\$migratie\$;/)?.[0] ?? "";
const statements = flat
  .replace(doBlock, "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
const changed = git("diff", "--name-only", "origin/main...HEAD");
const addedHere = git("diff", "--name-only", "--diff-filter=A", "origin/main...HEAD");
const introducedHere = addedHere.includes(MIGRATION);

describe("Migratie — journal_entries alleen-lezen", () => {
  it("1. bestaat precies één keer, met een tijdstempel ná de laatste migratie die er al was", () => {
    expect(ownMigrations).toHaveLength(1);
    expect(ownMigrations[0]).toMatch(/^\d{14}_make_journal_entries_read_only\.sql$/);
    expect(ownMigrations[0].slice(0, 14) > "20260929120000").toBe(true);
  });

  it("2. is uitsluitend rechten en policies: REVOKE, GRANT SELECT, DROP POLICY", () => {
    expect(statements).toEqual([
      "REVOKE ALL ON TABLE public.journal_entries FROM PUBLIC, anon, authenticated, service_role",
      "GRANT SELECT ON TABLE public.journal_entries TO authenticated, service_role",
      "DROP POLICY IF EXISTS role_journal_entries_insert ON public.journal_entries",
      "DROP POLICY IF EXISTS role_journal_entries_update ON public.journal_entries",
      "DROP POLICY IF EXISTS role_journal_entries_delete ON public.journal_entries",
    ]);
  });

  it("3. raakt geen data, geen schema, geen functie, geen trigger en zet RLS niet uit", () => {
    expect(flat).not.toMatch(/\b(INSERT INTO|UPDATE public|DELETE FROM|TRUNCATE)\b/i);
    expect(flat).not.toMatch(/\bCREATE\b|\bALTER\b/i);
    expect(flat).not.toMatch(/DROP (TABLE|COLUMN|FUNCTION|TRIGGER|INDEX|CONSTRAINT)/i);
    expect(flat).not.toMatch(/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i);
    expect(flat).not.toMatch(/OWNER TO|DEFAULT PRIVILEGES/i);
    expect(flat).not.toMatch(/ledger_postings|manual_journal/);
  });

  it("4. het leespad blijft: SELECT-policy wordt niet verwijderd, SELECT gaat terug naar authenticated", () => {
    expect(flat).not.toMatch(/DROP POLICY[^;]*role_journal_entries_select/);
    expect(statements).toContain("GRANT SELECT ON TABLE public.journal_entries TO authenticated, service_role");
  });

  it("5. niemand krijgt er iets bij: alleen SELECT wordt toegekend, en nooit aan anon of PUBLIC", () => {
    const grants = statements.filter((s) => s.startsWith("GRANT"));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/^GRANT SELECT ON/);
    expect(grants[0]).not.toMatch(/\b(anon|PUBLIC)\b/);
  });

  it("6. faalt gesloten: tabel ontbreekt, RLS staat uit, of de SELECT-policy ontbreekt", () => {
    expect(doBlock).toContain("to_regclass('public.journal_entries') IS NULL");
    expect(doBlock).toMatch(/relrowsecurity/);
    expect(doBlock).toContain("policyname = 'role_journal_entries_select'");
    expect((doBlock.match(/RAISE EXCEPTION/g) ?? []).length).toBe(3);
  });

  describe("7. de rollback is het exacte, uitvoerbare omgekeerde", () => {
    // Het blok tussen ROLLBACK-BEGIN en ROLLBACK-END, zonder het "-- " ervoor.
    const block = raw.match(/^-- ROLLBACK-BEGIN\n([\s\S]*?)^-- ROLLBACK-END$/m)?.[1] ?? "";
    const rollback = block
      .split("\n")
      .map((line) => line.replace(/^-- ?/, ""))
      .join("\n");
    const rollbackFlat = rollback.replace(/\s+/g, " ").trim();
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();

    it("7a. staat als afgebakend blok in de migratie en is volledig uitvoerbaar (geen proza, geen geneste commentaar)", () => {
      expect(block).not.toBe("");
      for (const line of block.split("\n").filter(Boolean)) {
        expect(line, "elke regel is een uitgeschakelde SQL-regel").toMatch(/^-- +\S/);
      }
      expect(rollback).not.toMatch(/--/);
      // Elke opdracht eindigt op ';' en is SQL.
      const stmts = rollbackFlat.split(";").map((s) => s.trim()).filter(Boolean);
      for (const s of stmts) expect(s).toMatch(/^(GRANT|DROP POLICY IF EXISTS|CREATE POLICY) /);
    });

    it("7b. geeft elke rol die de migratie intrekt (behalve PUBLIC) de volledige vroegere rechten terug", () => {
      const revoke = statements.find((s) => s.startsWith("REVOKE ALL ON TABLE public.journal_entries FROM"));
      const revoked = (revoke ?? "").replace(/^.* FROM /, "").split(",").map((r) => r.trim());
      const restored = [...rollbackFlat.matchAll(/GRANT ALL ON TABLE public\.journal_entries TO ([^;]+);/g)]
        .flatMap((m) => m[1].split(",").map((r) => r.trim()));
      expect(revoked).toContain("PUBLIC");
      expect(restored.sort()).toEqual(revoked.filter((r) => r !== "PUBLIC").sort());
    });

    it("7c. kent PUBLIC niets toe — de bewezen uitgangs-ACL had geen PUBLIC-regel", () => {
      expect(rollbackFlat).not.toMatch(/\bTO\b[^;]*\bPUBLIC\b/);
    });

    it("7d. herstelt de drie schrijfpolicies letterlijk zoals 20260613001452 ze aanmaakte", () => {
      const original = readFileSync(
        resolve(process.cwd(), MIGRATION_DIR, "20260613001452_ac57e447-1ab9-4125-9cc8-070054d55750.sql"),
        "utf8",
      );
      for (const policy of ["role_journal_entries_insert", "role_journal_entries_update", "role_journal_entries_delete"]) {
        const create = original.match(new RegExp(`CREATE POLICY ${policy} ON public\\.journal_entries[^;]*;`))?.[0];
        expect(create, `${policy} bestond in 20260613001452`).toBeTruthy();
        expect(rollbackFlat, `${policy} letterlijk in de rollback`).toContain(norm(create!));
        // Idempotent: eerst weg, dan opnieuw.
        expect(rollbackFlat.indexOf(`DROP POLICY IF EXISTS ${policy} ON public.journal_entries;`)).toBeLessThan(
          rollbackFlat.indexOf(`CREATE POLICY ${policy}`),
        );
      }
    });

    it("7e. raakt de SELECT-policy niet, en herstelt precies wat de migratie weghaalde", () => {
      expect(rollbackFlat).not.toMatch(/role_journal_entries_select/);
      const dropped = statements.filter((s) => s.startsWith("DROP POLICY")).map((s) => s.match(/role_journal_entries_\w+/)![0]);
      const recreated = [...rollbackFlat.matchAll(/CREATE POLICY (role_journal_entries_\w+)/g)].map((m) => m[1]);
      expect(recreated.sort()).toEqual(dropped.sort());
    });

    it("7f. de oude, onvolledige rollback (alleen authenticated, alleen INSERT/UPDATE/DELETE) zou hier falen", () => {
      const incomplete = "GRANT INSERT, UPDATE, DELETE ON public.journal_entries TO authenticated;";
      const restoredBy = (sql: string) =>
        [...sql.matchAll(/GRANT ALL ON TABLE public\.journal_entries TO ([^;]+);/g)].flatMap((m) =>
          m[1].split(",").map((r) => r.trim()),
        );
      expect(restoredBy(incomplete)).toEqual([]);
      expect(restoredBy(rollbackFlat).sort()).toEqual(["anon", "authenticated", "service_role"]);
    });
  });
});

describe("De aanname onder de migratie — niemand schrijft journal_entries nog", () => {
  it("8. geen app- of edge-functiecode doet INSERT/UPDATE/UPSERT/DELETE op journal_entries", () => {
    expect(
      appFilesMatching(/\.from\(\s*["'`]journal_entries["'`]\s*\)[^;]*\.(insert|update|upsert|delete)\s*\(/),
    ).toEqual([]);
  });

  it("9. geen edge function noemt journal_entries zelfs maar", () => {
    for (const file of appSourceFiles("supabase/functions")) {
      expect(appCode(file), file).not.toContain("journal_entries");
    }
  });

  it("10. geen databasefunctie (laatste definitie over alle migraties) schrijft of leest journal_entries", () => {
    const bodies = new Map<string, string>();
    for (const file of allMigrations) {
      const text = readFileSync(resolve(process.cwd(), MIGRATION_DIR, file), "utf8");
      const re = /^CREATE (?:OR REPLACE )?FUNCTION ([a-z_0-9.]+)\s*\(/gim;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const as = /\bAS\s+(\$[A-Za-z_0-9]*\$)/.exec(text.slice(m.index));
        if (!as) continue;
        const start = m.index + as.index + as[0].length;
        bodies.set(m[1], withoutComments(text.slice(start, text.indexOf(as[1], start))));
      }
    }
    const users = [...bodies].filter(([, body]) => body.includes("journal_entries")).map(([name]) => name);
    expect(users).toEqual([]);
  });

  it("11. de historische lees- en exportpaden blijven bestaan", () => {
    expect(appCode("src/hooks/useJournalEntries.ts")).toMatch(/\.from\("journal_entries"\)\.select\(/);
    // Snelle invoer (alleen-lezen), Bronmutaties en Rapportages (incl. de SnelStart-zip).
    expect(appFilesMatching(/useJournalEntries\(/)).toEqual(
      expect.arrayContaining(["src/pages/Boekingen.tsx", "src/pages/GrootboekMutaties.tsx", "src/pages/Overzichten.tsx"]),
    );
    expect(appCode("src/lib/snelstart-export.ts")).toMatch(/export function exportJournalEntriesCSV/);
    expect(appCode("src/lib/snelstart-export.ts")).toMatch(/export async function exportAllForClient/);
  });
});

describe("Scope", () => {
  it("12. geen bestaande migratie wordt gewijzigd, hernoemd of verwijderd — ooit", () => {
    // Een toegepaste migratie is onveranderlijk; dit geldt voor élke branch.
    expect(git("diff", "--name-only", "--diff-filter=MDR", "origin/main...HEAD", "--", MIGRATION_DIR)).toEqual([]);
    assertBranchTouchesNoExistingWriter(changed);
    assertBranchSqlKeepsLedgerFoundation(changed);
  });

  it("13. de branch die deze migratie invoert, laat de app en de gegenereerde types ongemoeid", () => {
    // Alleen geldig voor de invoerende branch; latere branches mogen dat wél.
    if (!introducedHere) return;
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    expect(changed.filter((f) => f.startsWith("src/") && !f.startsWith("src/test/"))).toEqual([]);
  });
});
