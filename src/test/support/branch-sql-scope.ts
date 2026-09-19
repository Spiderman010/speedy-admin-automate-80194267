import { readFileSync } from "node:fs";
import { expect } from "vitest";

/**
 * Eén gedeelde regel voor wat een branch met SQL mag doen.
 *
 * WAAROM DIT BESTAAT
 * Veel UI- en rekenlaag-PR's legden vast: "deze branch bevat geen migratie en
 * geen SQL". Dat was waar over die PR, maar het is geen INVARIANT: elke latere
 * fase die terecht een migratie meebrengt, laat zo'n assertie omvallen — en dan
 * staat de reviewer voor de keuze tussen de migratie of de test, terwijl er
 * niets mis is met beide. Dat is precies eerder gebeurd (6C-b8 tegen de
 * beginbalansmigratie, Balans/W&V PR 1 tegen de classificatiemigratie) en
 * telkens opgelost door de scope-uitspraak te vervangen door wat zij werkelijk
 * beschermde.
 *
 * WAT ZIJ WERKELIJK BESCHERMDEN
 * Elk van die lagen leest van `public.ledger_postings`. Wat er niet mag
 * gebeuren, is dat een migratie die fundering (6C-b2, 20260914120000) wijzigt,
 * verzwakt of weggooit. Wat er WEL mag gebeuren, is dat een migratie er iets
 * additiefs bij zet — een CHECK, een index, een trigger — want dat kan geen
 * bestaande kolom, rij of garantie aantasten.
 *
 * Deze helper legt dat onderscheid één keer vast, zodat dertien testbestanden
 * niet dertien eigen varianten hoeven te onderhouden.
 */

/** Alleen uitvoerbare SQL: een rollback-comment bevat vrijwel altijd DROP's. */
function executableSql(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const FOUNDATION = "supabase/migrations/20260914120000_add_ledger_postings_foundation.sql";

/**
 * Elke migratie die deze branch toevoegt of wijzigt, mag de grootboekfundering
 * niet aantasten.
 *
 * @param changed uitvoer van `git diff --name-only origin/main...HEAD`, gesplitst
 */
export function assertBranchSqlKeepsLedgerFoundation(changed: readonly string[]): void {
  const foundation = readFileSync(FOUNDATION, "utf8");

  for (const file of changed.filter((f) => f.startsWith("supabase/migrations/"))) {
    // De fundering zelf wordt nooit gewijzigd — dat is wél een invariant.
    expect(file, "de fundering 20260914120000 mag nooit worden gewijzigd").not.toBe(FOUNDATION);

    const sql = executableSql(file);

    // Een tabel weggooien waar onuitwisbare boekhouding in staat: nooit.
    expect(sql, file).not.toMatch(/DROP TABLE[^;]*ledger_postings/i);
    expect(sql, file).not.toMatch(/TRUNCATE[^;]*ledger_postings/i);

    // ALTER TABLE op het grootboek mag uitsluitend ADDITIEF zijn. Een kolom
    // wijzigen, hernoemen of weggooien raakt vastgelegde boekhouding; een
    // CHECK of een constraint erbij kan dat per definitie niet.
    for (const statement of sql.match(/ALTER TABLE(?: IF EXISTS)? public\.ledger_postings[^;]*/gi) ?? []) {
      expect(statement.replace(/\s+/g, " "), `${file}: alleen additieve ALTER TABLE`).toMatch(
        /ALTER TABLE(?: IF EXISTS)? public\.ledger_postings\s+(ADD CONSTRAINT|ENABLE|VALIDATE CONSTRAINT)/i,
      );
    }

    // Een migratie mag haar EIGEN toevoeging idempotent weggooien, maar nooit
    // een object dat de fundering zelf aanmaakt.
    for (const drop of sql.match(/DROP (?:TABLE|FUNCTION|TRIGGER|POLICY|INDEX|CONSTRAINT)[^;]*/gi) ?? []) {
      if (!/ledger_postings/i.test(drop)) continue;
      const naam = drop.match(/DROP \w+(?: IF EXISTS)? ([\w.]+)/i)?.[1] ?? "";
      if (!naam) continue;
      expect(foundation, `${file}: ${drop}`).not.toContain(`CREATE TRIGGER ${naam}`);
      expect(foundation, `${file}: ${drop}`).not.toContain(`CREATE CONSTRAINT TRIGGER ${naam}`);
      expect(foundation, `${file}: ${drop}`).not.toContain(`INDEX IF NOT EXISTS ${naam}`);
    }
  }
}

/**
 * Geen enkele SQL in deze branch raakt de bestaande boekingsschrijvers aan.
 * Een nieuwe schrijver toevoegen mag; de vijf bestaande herschrijven niet.
 */
export function assertBranchTouchesNoExistingWriter(changed: readonly string[]): void {
  const bestaandeSchrijvers = [
    "supabase/migrations/20260915140000_add_purchase_ledger_posting.sql",
    "supabase/migrations/20260915160000_add_sales_ledger_posting.sql",
    "supabase/migrations/20260917120000_add_bank_settlement_posting.sql",
    "supabase/migrations/20260918120000_add_manual_journal_posting.sql",
    "supabase/migrations/20260919120000_add_opening_balance_posting.sql",
  ];
  for (const writer of bestaandeSchrijvers) {
    expect(changed, writer).not.toContain(writer);
  }
}
