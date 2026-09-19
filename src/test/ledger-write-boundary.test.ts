import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Statische bewaking van de schrijfdeur naar het grootboek
 * (20260920130000_revoke_direct_ledger_insert.sql).
 *
 * Wat de DATABASE doet wordt bewezen tegen een echte PostgreSQL in
 * supabase/tests/ledger-write-boundary/ — privileges zijn een uitspraak over
 * PostgreSQL, niet over TypeScript, en die kun je niet met een reguliere
 * expressie bewijzen. Dit bestand bewaakt de twee dingen die daar juist NIET
 * te zien zijn en die in deze repo kunnen wegglijden:
 *
 *   1. de migratie zegt nog steeds wat zij hoort te zeggen, en
 *   2. de applicatie is nog steeds geen schrijver — geen enkel pad in src/ of
 *      supabase/functions/ schrijft rechtstreeks in ledger_postings.
 *
 * (2) is de eigenlijke inzet: zodra iemand een `.insert()` op die tabel
 * toevoegt, is dat pad in productie kapot én is de bedoeling van de migratie
 * verlaten. Dan hoort deze test te vallen, niet de gebruiker.
 */

const MIGRATION = "supabase/migrations/20260920130000_revoke_direct_ledger_insert.sql";

const raw = readFileSync(resolve(process.cwd(), MIGRATION), "utf-8");

// Alleen uitvoerbare SQL: de headercomment documenteert onder meer de rollback
// (`GRANT INSERT ... TO authenticated`) en zou anders elke assertie hieronder
// op zijn kop zetten.
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("Migratie — directe schrijfdeur naar ledger_postings", () => {
  it("1. trekt het INSERT-recht van authenticated in", () => {
    expect(sql).toMatch(/REVOKE\s+INSERT\s+ON\s+public\.ledger_postings\s+FROM\s+authenticated\s*;/i);
  });

  it("2. geeft dat recht nergens in dezelfde migratie terug", () => {
    const grants = [...sql.matchAll(/GRANT\s+([^;]*?)\s+ON\s+public\.ledger_postings\s+TO\s+([^;]*);/gi)];
    expect(grants).toEqual([]);
  });

  it("3. laat service_role met rust — een bewuste, aparte afweging", () => {
    expect(sql).not.toMatch(/REVOKE[^;]*\bservice_role\b/i);
  });

  it("4. raakt de bestaande append-only-grendels niet aan", () => {
    // Geen DROP/ALTER op triggers, policies of de tabel zelf: deze migratie
    // neemt alleen een recht weg.
    expect(sql).not.toMatch(/\bDROP\s+(TRIGGER|POLICY|TABLE|FUNCTION)\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    // Als statement, niet als woord: de COMMENT-tekst noemt TRUNCATE terecht.
    expect(sql).not.toMatch(/^\s*TRUNCATE\b/im);
  });

  it("5. houdt het insertbeleid als vangnet in stand", () => {
    // De policy blijft bestaan; zij wordt alleen van een toelichting voorzien.
    expect(sql).toMatch(/COMMENT ON POLICY role_ledger_postings_insert ON public\.ledger_postings/);
    expect(sql).not.toMatch(/DROP POLICY[^;]*role_ledger_postings_insert/i);
  });

  it("6. voegt geen source_type-whitelist toe", () => {
    // Bewust niet gekozen: een lijst die je kunt vergeten bij te werken houdt de
    // deur op een kier. Zie de header van de migratie.
    expect(sql).not.toMatch(/source_type\s+IN\s*\(/i);
    expect(sql).not.toMatch(/CHECK\s*\([^)]*source_type/i);
  });
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(full) && !full.includes(`${"src"}/test/`)) {
      out.push(full);
    }
  }
  return out;
}

describe("Applicatiecode is geen grootboekschrijver", () => {
  const roots = ["src", "supabase/functions"].map((d) => resolve(process.cwd(), d));
  const files = roots.flatMap((root) => sourceFiles(root));

  it("7. noemt ledger_postings alleen om te lezen, nooit om te schrijven", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      let at = text.indexOf("ledger_postings");
      while (at !== -1) {
        // De keten achter .from("ledger_postings") tot het einde van de
        // expressie; ruim genoeg voor een doorgaans opgemaakte queryketen.
        const tail = text.slice(at, at + 400);
        if (/\.\s*(insert|upsert|update|delete)\s*\(/.test(tail)) {
          offenders.push(`${file}: ${tail.slice(0, 120)}`);
        }
        at = text.indexOf("ledger_postings", at + 1);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("8. leest die tabel wel — anders bewijst 7 niets", () => {
    const readers = files.filter((f) => readFileSync(f, "utf-8").includes('from("ledger_postings")'));
    expect(readers.length).toBeGreaterThan(0);
  });
});
