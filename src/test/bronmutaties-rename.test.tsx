import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

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
    for (const bestand of changed.split("\n").filter((f) => f.startsWith("supabase/migrations/"))) {
      const sql = readFileSync(bestand, "utf8")
        .split("\n")
        .filter((r) => !r.trimStart().startsWith("--"))
        .join("\n");
      expect(sql, bestand).not.toMatch(/ALTER TABLE public\.ledger_postings/);
      expect(sql, bestand).not.toMatch(/DROP TABLE[^;]*ledger_postings/);
      // Een migratie mag haar EIGEN toevoeging aan ledger_postings idempotent
      // weggooien, maar nooit een object uit de fundering zelf.
      const fundering = readFileSync(
        "supabase/migrations/20260914120000_add_ledger_postings_foundation.sql",
        "utf8",
      );
      for (const drop of sql.match(/DROP (?:TABLE|FUNCTION|TRIGGER|POLICY|INDEX)[^;]*/g) ?? []) {
        if (!/ledger_postings/.test(drop)) continue;
        const naam = drop.match(/DROP \w+(?: IF EXISTS)? ([\w.]+)/)?.[1] ?? "";
        expect(fundering, `${bestand}: ${drop}`).not.toContain(`CREATE TRIGGER ${naam}`);
        expect(fundering, `${bestand}: ${drop}`).not.toContain(`CREATE CONSTRAINT TRIGGER ${naam}`);
        expect(fundering, `${bestand}: ${drop}`).not.toContain(`INDEX IF NOT EXISTS ${naam}`);
      }
    }
  });
});
