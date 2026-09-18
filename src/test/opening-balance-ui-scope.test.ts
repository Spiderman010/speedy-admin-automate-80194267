import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Fase 6C-b8 (PR 2) — statische bewaking van de UI-laag.
 *
 * Geen brondocumenttotalen, geen journal_entries, nooit rechtstreeks in
 * ledger_postings of in de nihil-kolommen schrijven, regels uitsluitend via de
 * save-RPC, geen migratie/SQL/typewijziging/afhankelijkheid in deze branch, en
 * de route genest onder Grootboek zonder nieuw nav-item.
 */

const SOURCES = [
  "src/pages/Beginbalans.tsx",
  "src/hooks/useOpeningBalances.ts",
  "src/hooks/useOpeningBalancePosting.ts",
  "src/lib/opening-balance-utils.ts",
  "src/components/grootboek/OpeningBalanceTable.tsx",
  "src/components/grootboek/OpeningBalanceSummary.tsx",
  "src/components/grootboek/OpeningBalancePostingAction.tsx",
  "src/components/grootboek/OpeningBalanceNilAction.tsx",
].map((path) => ({ path, text: readFileSync(path, "utf8") }));

function changedFiles(): string[] {
  return execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

describe("Beginbalans-UI — bronnen", () => {
  it("52. gebruikt nergens journal_entries of de legacy-helpers", () => {
    for (const { path, text } of SOURCES) {
      expect(text, path).not.toMatch(/journal_entries/);
      expect(text, path).not.toMatch(/useJournalEntries/);
      expect(text, path).not.toMatch(/ledger-mutations/);
      expect(text, path).not.toMatch(/snelstart-export/);
    }
  });

  it("53. leest geen brondocumenttotalen en geen factuur-, bank- of allocatietabellen", () => {
    for (const { path, text } of SOURCES) {
      expect(text, path).not.toMatch(/from\(["'](purchase_invoices|sales_invoices|bank_transactions|bank_transaction_allocations|purchase_invoice_lines)["']\)/);
      expect(text, path).not.toMatch(/amount_incl|amount_excl|btw_amount|remaining_amount/);
    }
  });

  it("schrijft nooit rechtstreeks in ledger_postings, opening_balance_postings of de nihil-kolommen", () => {
    for (const { path, text } of SOURCES) {
      expect(text, path).not.toMatch(/from\(["']ledger_postings["']\)/);
      expect(text, path).not.toMatch(/from\(["']opening_balance_postings["']\)\s*\.\s*(insert|update|delete|upsert)/);
      expect(text, path).not.toMatch(/nil_declaration\s*:/);
      expect(text, path).not.toMatch(/nil_declared_(at|by)\s*:/);
    }
  });

  it("25. regels gaan uitsluitend via save_opening_balance_lines — geen insert/update/delete op opening_balance_lines", () => {
    for (const { path, text } of SOURCES) {
      expect(text, path).not.toMatch(/from\(["']opening_balance_lines["']\)\s*\.\s*(insert|update|delete|upsert)/);
    }
    const hooks = SOURCES.find((s) => s.path === "src/hooks/useOpeningBalances.ts")!.text;
    expect(hooks.match(/rpc\("save_opening_balance_lines"/g)).toHaveLength(1);
    const posting = SOURCES.find((s) => s.path === "src/hooks/useOpeningBalancePosting.ts")!.text;
    expect(posting.match(/rpc\("post_opening_balance"/g)).toHaveLength(1);
    expect(posting.match(/rpc\("declare_opening_balance_nil"/g)).toHaveLength(1);
  });

  it("geboekt en nihil zijn afgeleid, er is geen lokale statuskolom", () => {
    for (const { path, text } of SOURCES) {
      expect(text, path).not.toMatch(/\.status\b/);
      expect(text, path).not.toMatch(/\bis_posted\b|\bposted_at\b|\bgeboekt_op\b/);
    }
    const utils = SOURCES.find((s) => s.path === "src/lib/opening-balance-utils.ts")!.text;
    expect(utils).toMatch(/nil_declaration === true && header\.nil_declared_at !== null/);
    expect(utils).toMatch(/if \(marker\) \{\s*return \{\s*kind: "posted"/);
  });

  it("32. er wordt nooit een sluitrekening (9998, 2010, tussenrekening, eigen vermogen) toegevoegd", () => {
    for (const { path, text } of SOURCES) {
      expect(text, path).not.toMatch(/9998|2010|2011|Tussenrekening|suspense|autoBalance|balancingLine/i);
    }
  });

  it("de rekeningkeuze is de bestaande GrootboekCombobox, met administratiebereik en actieve rekeningen", () => {
    const table = SOURCES.find((s) => s.path.endsWith("OpeningBalanceTable.tsx"))!.text;
    expect(table).toMatch(/<GrootboekCombobox/);
    expect(table).toMatch(/clientId=\{clientId\}/);
    const combobox = readFileSync("src/components/GrootboekCombobox.tsx", "utf8");
    expect(combobox).toMatch(/useActiveGrootboekrekeningen/);
    expect(combobox).toMatch(/a\.client_id === null \|\| a\.client_id === clientId/);
    expect(combobox).not.toMatch(/postableOnly/);
  });
});

describe("Beginbalans-UI — branch-scope", () => {
  const changed = changedFiles();

  it("54. geen migratie en geen SQL in deze branch", () => {
    expect(changed.filter((f) => f.startsWith("supabase/"))).toEqual([]);
    expect(changed.filter((f) => f.endsWith(".sql"))).toEqual([]);
  });

  it("55. gegenereerde Supabase-types ongewijzigd, en alleen als typen geïmporteerd", () => {
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    for (const { path, text } of SOURCES) {
      for (const line of text.split("\n").filter((l) => /integrations\/supabase\/types/.test(l))) {
        expect(line, path).toMatch(/^import type /);
      }
    }
  });

  it("56. geen wijziging in package.json of lockfiles", () => {
    expect(changed).not.toContain("package.json");
    expect(changed.filter((f) => /package-lock\.json|bun\.lockb|pnpm-lock\.yaml|yarn\.lock/.test(f))).toEqual([]);
  });

  it("raakt de boekhoudkern niet aan (schrijvers, rapportage, nav)", () => {
    for (const f of changed) {
      expect(f).not.toMatch(/ledger-reporting\.ts|proef-saldibalans\.ts|ledger-completeness\.ts|snelstart-export\.ts|nav\.ts$/);
      expect(f).not.toMatch(/useManualJournal|usePurchaseInvoicePosting|useSalesInvoicePosting|useBankAllocationPosting/);
    }
  });

  it("57/58. route genest onder /grootboek, ingang vanuit Grootboek, geen nieuw nav-item", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toMatch(/path="\/grootboek\/beginbalans"/);
    expect(app).toMatch(/path="\/grootboek"/);
    const nav = readFileSync("src/components/layout/nav.ts", "utf8");
    expect(nav).not.toMatch(/beginbalans/i);
    const grootboek = readFileSync("src/pages/Grootboek.tsx", "utf8");
    expect(grootboek).toContain('to="/grootboek/beginbalans"');
    expect(grootboek).toContain("Beginbalans");
  });
});
