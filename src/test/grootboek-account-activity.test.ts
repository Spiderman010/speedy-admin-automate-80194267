import { describe, expect, it } from "vitest";
import { accountIdsWithActivity, rollupHasLedgerActivity } from "@/lib/grootboek-account-activity";
import { buildAccountReport, yearPeriod, type LedgerPostingLike } from "@/lib/ledger-reporting";
import {
  buildFinancialStatements,
  movementOnPeriodStartFromRows,
  openingBalanceContributionFromRows,
} from "@/lib/financial-statements";

/**
 * De activiteitsdefinitie van "Met saldo" is een KOPIE van `rollupHasActivity()`
 * in `financial-statements.ts`. Die functie is daar privé en het bestand is
 * byte-voor-byte bevroren, dus exporteren kon niet.
 *
 * Deze tests ijken de kopie aan de échte engine-uitkomst: voor
 * niet-geclassificeerde rekeningen geeft `buildFinancialStatements()` per
 * rekening `hasActivity` terug, en dat moet exact hetzelfde antwoord zijn.
 * Gaan de twee ooit uit elkaar lopen, dan valt dit om.
 */

const CLIENT = "client-1";
const YEAR = 2026;
const PERIOD = yearPeriod(YEAR);

let seq = 0;
function boeking(debet: string, credit: string, bedrag: string, datum = "2026-04-01"): LedgerPostingLike[] {
  seq++;
  const g = `pg-${seq}`;
  const base = {
    client_id: CLIENT, posting_group_id: g, posting_date: datum,
    boekjaar: Number(datum.slice(0, 4)), currency: "EUR", source_type: "manual_journal",
  };
  return [
    { ...base, id: `${g}-1`, line_no: 1, grootboekrekening_id: debet, debit_amount: bedrag, credit_amount: "0.00" },
    { ...base, id: `${g}-2`, line_no: 2, grootboekrekening_id: credit, debit_amount: "0.00", credit_amount: bedrag },
  ];
}

/** Ongeclassificeerd, zodat de engine `hasActivity` per rekening teruggeeft. */
const rek = (id: string, nummer: number) => ({
  id, nummer, omschrijving: `Rekening ${nummer}`, categorie: "kosten", actief: true,
  client_id: null, statement_type: null, report_group: null, normal_side: null, report_sort: null,
});

const rapport = (rows: LedgerPostingLike[], accounts: ReturnType<typeof rek>[]) =>
  buildAccountReport({ rows, clientId: CLIENT, period: PERIOD, accounts });

describe("rollupHasLedgerActivity", () => {
  it("1. debet- en creditbeweging telt als activiteit", () => {
    const accounts = [rek("a", 4400), rek("b", 1600)];
    const report = rapport(boeking("a", "b", "100.00"), accounts);
    if (report.ok !== true) throw new Error("kern faalde");
    for (const rollup of report.rollups) expect(rollupHasLedgerActivity(rollup), rollup.account.id).toBe(true);
  });

  it("2. beweging die op nul uitkomt telt óók als activiteit", () => {
    // Dit is het geval dat `eindsaldo !== 0` zou verbergen.
    const accounts = [rek("a", 4400), rek("b", 1600)];
    const report = rapport([...boeking("a", "b", "500.00"), ...boeking("b", "a", "500.00")], accounts);
    if (report.ok !== true) throw new Error("kern faalde");
    const a = report.rollups.find((r) => r.account.id === "a")!;
    expect(a.closingCents).toBe(0);
    expect(a.periodDebitCents).toBeGreaterThan(0);
    expect(rollupHasLedgerActivity(a)).toBe(true);
  });

  it("3. een rekening zonder enige beweging telt niet", () => {
    expect(rollupHasLedgerActivity({
      account: { id: "stil", nummer: 4500, omschrijving: "Stil", categorie: "kosten", actief: true, client_id: null },
      openingCents: 0, periodDebitCents: 0, periodCreditCents: 0, closingCents: 0, periodLineCount: 0,
    } as never)).toBe(false);
  });

  it("4. een openingssaldo zonder periodebeweging telt wél", () => {
    // De rekening draagt saldo; er is alleen dit jaar niets mee gebeurd.
    const accounts = [rek("a", 4400), rek("b", 1600)];
    const report = rapport(boeking("a", "b", "250.00", "2025-06-01"), accounts);
    if (report.ok !== true) throw new Error("kern faalde");
    const a = report.rollups.find((r) => r.account.id === "a")!;
    expect(a.periodDebitCents).toBe(0);
    expect(a.openingCents).not.toBe(0);
    expect(rollupHasLedgerActivity(a)).toBe(true);
  });

  it("5. accountIdsWithActivity levert precies de actieve rekeningen", () => {
    const accounts = [rek("a", 4400), rek("b", 1600), rek("stil", 4500)];
    const report = rapport(boeking("a", "b", "100.00"), accounts);
    if (report.ok !== true) throw new Error("kern faalde");
    expect([...accountIdsWithActivity(report.rollups)].sort()).toEqual(["a", "b"]);
  });
});

describe("gelijkwaardigheid met de rapportage-engine", () => {
  /**
   * De engine geeft voor elke ONGECLASSIFICEERDE rekening `hasActivity` terug.
   * Dat is dezelfde vraag, beantwoord door de private `rollupHasActivity()`.
   * Hier worden beide antwoorden naast elkaar gelegd.
   */
  function vergelijk(rows: LedgerPostingLike[], accounts: ReturnType<typeof rek>[]) {
    const report = rapport(rows, accounts);
    if (report.ok !== true) throw new Error("kern faalde");
    const fs = buildFinancialStatements({
      report,
      period: PERIOD,
      accounts: accounts as never,
      openingBalanceContribution: openingBalanceContributionFromRows(rows, PERIOD),
      movementOnPeriodStart: movementOnPeriodStartFromRows(rows, PERIOD),
    });
    if (!fs.ok) throw new Error("engine faalde");

    const viaKopie = accountIdsWithActivity(report.rollups);
    for (const account of fs.unclassified.accounts) {
      expect(viaKopie.has(account.accountId), `${account.accountNumber}`).toBe(account.hasActivity);
    }
    return fs.unclassified.accounts.length;
  }

  it("6. gewone beweging: beide lagen zeggen hetzelfde", () => {
    const accounts = [rek("a", 4400), rek("b", 1600)];
    expect(vergelijk(boeking("a", "b", "100.00"), accounts)).toBeGreaterThan(0);
  });

  it("7. beweging die op nul uitkomt: beide lagen zeggen 'actief'", () => {
    const accounts = [rek("a", 4400), rek("b", 1600)];
    vergelijk([...boeking("a", "b", "500.00"), ...boeking("b", "a", "500.00")], accounts);
  });

  it("8. openingssaldo zonder periodebeweging: beide lagen zeggen 'actief'", () => {
    const accounts = [rek("a", 4400), rek("b", 1600)];
    vergelijk(boeking("a", "b", "250.00", "2025-06-01"), accounts);
  });

  it("9. de definitie is niet 'eindsaldo ≠ 0'", () => {
    // Zou de kopie op closingCents draaien, dan zou test 7 omvallen. Hier wordt
    // dat expliciet vastgelegd, zodat de reden zichtbaar blijft.
    const accounts = [rek("a", 4400), rek("b", 1600)];
    const report = rapport([...boeking("a", "b", "500.00"), ...boeking("b", "a", "500.00")], accounts);
    if (report.ok !== true) throw new Error("kern faalde");
    for (const rollup of report.rollups) {
      expect(rollup.closingCents).toBe(0);
      expect(rollupHasLedgerActivity(rollup)).toBe(true);
    }
  });
});
