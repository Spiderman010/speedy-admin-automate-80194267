import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { assertBranchSqlKeepsLedgerFoundation } from "@/test/support/branch-sql-scope";

/**
 * Fase 6C-b7 PR 2 — de oude "Grootboekmutaties" heet nu "Bronmutaties", zodat
 * hij nooit met het grootboek op /grootboek/saldi wordt verward. Alleen de
 * zichtbare titel en één toelichtende zin veranderen; de afleiding uit
 * brondocumenten blijft byte-voor-byte gelijk.
 */

describe("Bronmutaties — hernoeming", () => {
  const page = readFileSync("src/pages/GrootboekMutaties.tsx", "utf8");

  it("30. de zichtbare titel is Bronmutaties", () => {
    expect(page).toMatch(/<h1 className="sr-only">Bronmutaties<\/h1>/);
    expect(page).not.toMatch(/<h1[^>]*>Grootboekmutaties<\/h1>/);
  });

  it("31. de toelichting is zichtbaar", () => {
    expect(page).toContain("Dit overzicht is afgeleid uit brondocumenten en is niet het officiële grootboek.");
  });

  it("32. de onderliggende bronlogica is ongewijzigd", () => {
    // ledger-mutations.ts is niet aangeraakt in deze branch…
    const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(changed).not.toContain("src/lib/ledger-mutations.ts");
    // …en de pagina gebruikt nog exact dezelfde helpers.
    for (const fn of ["buildLedgerMutations", "filterLedgerMutations", "collectLedgerYears", "useJournalEntries"]) {
      expect(page).toContain(fn);
    }
    expect(page).not.toMatch(/useLedgerPostings|ledger_postings|ledger-reporting/);
  });

  it("de Grootboek-actiebalk verwijst naar Grootboeksaldi én naar Bronmutaties", () => {
    const grootboek = readFileSync("src/pages/Grootboek.tsx", "utf8");
    expect(grootboek).toContain('to="/grootboek/saldi"');
    expect(grootboek).toContain("Grootboeksaldi");
    expect(grootboek).toContain('to="/grootboek/mutaties"');
    expect(grootboek).toContain("Bronmutaties");
  });

  it("routes genest onder /grootboek; nav.ts, types en migraties ongewijzigd", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain('path="/grootboek/saldi"');
    expect(app).toContain('path="/grootboek/saldi/:accountId"');
    const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" });
    expect(changed).not.toMatch(/nav\.ts/);
    expect(changed).not.toMatch(/integrations\/supabase\/types\.ts/);
    // Voorheen: "deze branch bevat geen migratie". Dat was een uitspraak over de
    // SCOPE van één UI-PR, geen invariant — zodra een latere fase wél een
    // migratie meebrengt (6C-b8, beginbalans) kan hij niet meer kloppen. Wat
    // hier werkelijk beschermd moet worden is het contract waar deze laag op
    // leest: een migratie in deze branch mag de fundering uit 6C-b2 niet
    // wijzigen of weggooien.
    // Het onderscheid tussen een ADDITIEVE migratie (mag) en een die de
    // fundering wijzigt of weggooit (mag niet) staat op één plek, zodat
    // dertien testbestanden er niet dertien varianten van onderhouden.
    assertBranchSqlKeepsLedgerFoundation(changed.split("\n").filter(Boolean));
  });
});
