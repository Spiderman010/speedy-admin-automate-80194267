import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertBranchSqlKeepsLedgerFoundation,
  assertBranchTouchesNoExistingWriter,
} from "@/test/support/branch-sql-scope";

/**
 * De grens tussen de legacy snelle invoer (`journal_entries`) en het grootboek.
 *
 * `ledger_postings` is de enige financiële waarheid. `journal_entries` is één
 * bedrag op één rekening, zonder tegenrekening, zonder debet/credit en zonder
 * jaarafsluiting of boekingsblokkade; het telt nergens mee in het grootboek.
 * Dit bestand legt vast:
 *   1. de app SCHRIJFT niet meer naar `journal_entries` (alleen lezen);
 *   2. snelle invoer leidt naar het memoriaal, en het memoriaal boekt
 *      uitsluitend via `post_manual_journal()` — met jaar- én blokkadetoets;
 *   3. de rapportage leest `ledger_postings`, nooit `journal_entries`;
 *   4. niemand vernietigt de historische regels: geen migratie, geen app-pad.
 */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** Commentaar weg: een bewering over de CODE mag nooit op proza slagen. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (path === "src/test") continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name) && path !== "src/integrations/supabase/types.ts") {
      out.push(path);
    }
  }
  return out;
}

const APP_FILES = [...sourceFiles("src"), ...sourceFiles("supabase/functions")];

/** Elke `.from("<tabel>")`-keten tot aan de eerste `;`. */
function tableChains(table: string): Array<{ file: string; chain: string }> {
  const out: Array<{ file: string; chain: string }> = [];
  const re = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)[^;]*`, "g");
  for (const file of APP_FILES) {
    for (const m of code(file).matchAll(re)) out.push({ file, chain: m[0] });
  }
  return out;
}

const WRITE = /\.(insert|update|upsert|delete)\s*\(/;

const migrations = readdirSync(resolve(process.cwd(), "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();

function sqlCode(file: string): string {
  return read(`supabase/migrations/${file}`)
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** De laatste definitie van een functie over alle migraties heen. */
function finalFunction(name: string): { header: string; body: string; file: string } {
  let found = { header: "", body: "", file: "" };
  for (const file of migrations) {
    const text = read(`supabase/migrations/${file}`);
    const re = new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\s*\\(`, "gim");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const as = /\bAS\s+(\$[A-Za-z_0-9]*\$)/.exec(text.slice(m.index));
      if (!as) continue;
      const start = m.index + as.index + as[0].length;
      found = { header: text.slice(m.index, m.index + as.index), body: text.slice(start, text.indexOf(as[1], start)), file };
    }
  }
  return found;
}

const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

describe("1. De app schrijft niet meer naar journal_entries", () => {
  it("geen enkel app- of edge-functiepad doet INSERT/UPDATE/UPSERT/DELETE op journal_entries", () => {
    const writes = tableChains("journal_entries").filter(({ chain }) => WRITE.test(chain));
    expect(writes.map((w) => w.file)).toEqual([]);
  });

  it("het enige pad naar journal_entries is de SELECT in useJournalEntries", () => {
    const chains = tableChains("journal_entries");
    expect(chains.map((c) => c.file)).toEqual(["src/hooks/useJournalEntries.ts"]);
    expect(chains[0].chain).toMatch(/\.select\(/);
  });

  it("useJournalEntries exporteert alleen de leeshook — geen aanmaak- of verwijderhook", () => {
    const exported = [...code("src/hooks/useJournalEntries.ts").matchAll(/export function (\w+)/g)].map((m) => m[1]);
    expect(exported).toEqual(["useJournalEntries"]);
    expect(code("src/hooks/useJournalEntries.ts")).not.toMatch(/useMutation/);
  });

  it("geen RPC of edge function schrijft journal_entries via een omweg", () => {
    for (const file of APP_FILES) {
      expect(code(file), file).not.toMatch(/rpc\(\s*["'`][^"'`]*journal_entr/i);
    }
    for (const file of sourceFiles("supabase/functions")) {
      expect(code(file), file).not.toContain("journal_entries");
    }
  });

  it("de snelle-invoerpagina zelf muteert niets en praat niet rechtstreeks met de database", () => {
    const page = code("src/pages/Boekingen.tsx");
    expect(page).not.toMatch(/useMutation|mutateAsync|\.insert\(|\.delete\(|\.update\(|\.rpc\(/);
    expect(page).not.toMatch(/integrations\/supabase\/client/);
    expect(page).not.toMatch(/useAddJournalEntry|useDeleteJournalEntry|buildJournalEntryInsertPayload/);
  });
});

describe("2. Snelle invoer → memoriaal → post_manual_journal()", () => {
  it("de snelle-invoerpagina verwijst naar het memoriaal, en die route bestaat", () => {
    expect(code("src/pages/Boekingen.tsx")).toContain('"/grootboek/memoriaal"');
    expect(code("src/App.tsx")).toMatch(/path="\/grootboek\/memoriaal" element=\{<Memoriaal \/>\}/);
  });

  it("het memoriaal boekt via de bestaande RPC post_manual_journal — geen tweede schrijver", () => {
    expect(code("src/hooks/useManualJournalPosting.ts")).toMatch(/\.rpc\(\s*"post_manual_journal"/);
    // Was: een vaste lijst van twee migraties. Dat was waar tot PR H
    // (20261002120000), dat de schrijver terecht opnieuw definieert; geen
    // invariant. Wat blijft: elke definitie is een CREATE OR REPLACE van
    // dezelfde functie in een migratie — nooit een tweede schrijver onder een
    // andere naam, en nooit een definitie buiten supabase/migrations.
    const writers = migrations.filter((f) => /^CREATE (?:OR REPLACE )?FUNCTION public\.post_manual_journal\s*\(/im.test(read(`supabase/migrations/${f}`)));
    expect(writers[0]).toBe("20260918120000_add_manual_journal_posting.sql");
    expect(writers.length).toBeGreaterThanOrEqual(2);
    expect(migrations.filter((f) => /FUNCTION public\.\w*(memoriaal|manual_journal)\w*\s*\(/i.test(read(`supabase/migrations/${f}`)))
      .every((f) => writers.includes(f) || !/CREATE (?:OR REPLACE )?FUNCTION public\.post_\w*manual/i.test(read(`supabase/migrations/${f}`)))).toBe(true);
  });

  it("post_manual_journal is SECURITY DEFINER en toetst de rol én de boekingsblokkade", () => {
    /*
     * Was: "toetst zowel het afgesloten jaar als de boekingsblokkade", met de
     * laatste definitie vastgepind op PR D. Sinds PR H (20261002120000) is de
     * boekingsblokkade de enige datumgrendel en is het watermerk levenscyclus.
     * Wat blijft: de laatste definitie is SECURITY DEFINER, toetst de rol en
     * toetst de blokkade op de boekingsdatum van het memoriaal.
     */
    const fn = finalFunction("post_manual_journal");
    expect(fn.file).toBe("20261002120000_decouple_year_watermark_from_posting.sql");
    expect(fn.header).toMatch(/SECURITY DEFINER/);
    // Het lichaam noemt het watermerk nog in een toelichting; de TOETS is weg.
    expect(fn.body).not.toMatch(/afgesloten_boekjaar IS NOT NULL|<= v_client\.afgesloten_boekjaar/);
    expect(fn.body).toContain("PERFORM public.assert_posting_allowed(v_journal.client_id, v_journal.posting_date);");
    expect(fn.body).toMatch(/has_min_role\(/);
  });

  it("geen app-code schrijft rechtstreeks in ledger_postings", () => {
    const writes = tableChains("ledger_postings").filter(({ chain }) => WRITE.test(chain));
    expect(writes.map((w) => w.file)).toEqual([]);
  });
});

describe("3. De rapportage leest ledger_postings, nooit journal_entries", () => {
  const REPORTING = [
    "src/lib/ledger-reporting.ts",
    "src/lib/financial-statements.ts",
    "src/lib/proef-saldibalans.ts",
    "src/lib/year-close-readiness.ts",
    "src/hooks/useLedgerPostings.ts",
    "src/pages/GrootboekSaldi.tsx",
    "src/pages/ProefSaldibalans.tsx",
    "src/pages/Balans.tsx",
    "src/pages/WinstVerlies.tsx",
    "src/pages/Jaarafsluiting.tsx",
  ];

  it.each(REPORTING)("%s leest journal_entries niet", (file) => {
    const src = code(file);
    expect(src).not.toMatch(/journal_entries|useJournalEntries|journal-entry-utils/);
  });

  it("useLedgerPostings leest uitsluitend ledger_postings", () => {
    const tables = [...code("src/hooks/useLedgerPostings.ts").matchAll(/\.from\(\s*"(\w+)"/g)].map((m) => m[1]);
    expect(new Set(tables)).toEqual(new Set(["ledger_postings"]));
  });
});

describe("4. De historische regels blijven bestaan", () => {
  it("geen migratie vernietigt journal_entries of haar rijen", () => {
    for (const file of migrations) {
      const sql = sqlCode(file);
      expect(sql, file).not.toMatch(/DROP TABLE[^;]*journal_entries/i);
      expect(sql, file).not.toMatch(/TRUNCATE[^;]*journal_entries/i);
      expect(sql, file).not.toMatch(/DELETE FROM[^;]*journal_entries/i);
    }
  });

  it("de historische regels blijven leesbaar voor pagina, Bronmutaties, Rapportages en SnelStart-export", () => {
    expect(code("src/pages/Boekingen.tsx")).toMatch(/useJournalEntries\(/);
    expect(code("src/pages/GrootboekMutaties.tsx")).toMatch(/useJournalEntries\(/);
    expect(code("src/pages/Overzichten.tsx")).toMatch(/useJournalEntries\(/);
    expect(code("src/lib/snelstart-export.ts")).toMatch(/export function exportJournalEntriesCSV/);
  });
});

describe("Scope van elke latere branch", () => {
  it("geen gewijzigde migratie tast de grootboekfundering of de bestaande schrijvers aan", () => {
    // Bewust geen "deze branch bevat geen SQL": de vervolgmigratie die directe
    // writes op journal_entries dichtzet, hoort juist wél SQL te bevatten.
    assertBranchTouchesNoExistingWriter(changed);
    assertBranchSqlKeepsLedgerFoundation(changed);
  });
});
