import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertReportingCurrency,
  assertSingleClient,
  buildAccountReport,
  buildRunningBalance,
  centsToAmount,
  classifyLedgerCategory,
  compareLedgerRows,
  isBeforePeriod,
  isInPeriod,
  LedgerReportingError,
  resolveLedgerAccount,
  resolveLedgerSource,
  signedAmountCents,
  toCents,
  UNKNOWN_ACCOUNT_LABEL,
  yearPeriod,
  type LedgerAccountLike,
  type LedgerPostingLike,
} from "@/lib/ledger-reporting";

/**
 * Fase 6C-b7 PR 1 — de pure rapportagekern.
 *
 * Elke test bouwt zijn fixture uit balanced boekingsgroepen zoals de vier
 * schrijvers ze produceren. De cijfers komen uitsluitend uit ledger_postings;
 * test 15 bewijst dat een journal_entries-achtige rij hier niet eens
 * binnen kán komen zonder het type te schenden.
 */

const C1 = "client-1";
const C2 = "client-2";

let seq = 0;
function row(over: Partial<LedgerPostingLike> & Pick<LedgerPostingLike, "grootboekrekening_id">): LedgerPostingLike {
  seq += 1;
  return {
    id: `p-${String(seq).padStart(4, "0")}`,
    client_id: C1,
    posting_group_id: "g-1",
    line_no: 1,
    posting_date: "2027-03-15",
    boekjaar: 2027,
    debit_amount: 0,
    credit_amount: 0,
    currency: "EUR",
    description: null,
    source_type: "manual_journal",
    source_id: "src-1",
    source_line_id: null,
    reversal_of_posting_id: null,
    ...over,
  };
}

/** Eén balanced groep: [account, debet, credit] per regel. */
function group(
  groupId: string,
  date: string,
  legs: Array<[account: string, debit: number, credit: number]>,
  over: Partial<LedgerPostingLike> = {},
): LedgerPostingLike[] {
  return legs.map(([account, debit, credit], i) =>
    row({
      posting_group_id: groupId,
      line_no: i + 1,
      posting_date: date,
      boekjaar: Number(date.slice(0, 4)),
      grootboekrekening_id: account,
      debit_amount: debit,
      credit_amount: credit,
      ...over,
    }),
  );
}

const accounts: LedgerAccountLike[] = [
  { id: "gb-1100", nummer: 1100, omschrijving: "Bank", categorie: "activa", actief: true },
  { id: "gb-1300", nummer: 1300, omschrijving: "Debiteuren", categorie: "activa", actief: true },
  { id: "gb-1520", nummer: 1520, omschrijving: "BTW te vorderen", categorie: "activa", actief: true },
  { id: "gb-1600", nummer: 1600, omschrijving: "Crediteuren", categorie: "passiva", actief: true },
  { id: "gb-4000", nummer: 4000, omschrijving: "Kosten", categorie: "kosten", actief: true },
  { id: "gb-4999", nummer: 4999, omschrijving: "Oude kostenrekening", categorie: "kosten", actief: false },
  { id: "gb-8000", nummer: 8000, omschrijving: "Omzet", categorie: "omzet", actief: true },
  { id: "gb-0900", nummer: 900, omschrijving: "Privé-opnamen", categorie: "privé", actief: true },
  { id: "gb-9999", nummer: 9999, omschrijving: "Typo", categorie: "Kostem", actief: true },
];

const Q1 = { from: "2027-01-01", toExclusive: "2027-04-01" };

function okReport(rows: LedgerPostingLike[], period = Q1, clientId = C1) {
  const report = buildAccountReport({ rows, clientId, period, accounts });
  if (report.ok === false) throw new Error(`report invalid: ${JSON.stringify(report.failures)}`);
  return report;
}
const rollup = (r: ReturnType<typeof okReport>, id: string) => r.rollups.find((x) => x.account.id === id)!;

describe("ledger-reporting — geld en teken", () => {
  it("toCents is exact voor strings en herstelt float-weergaven", () => {
    expect(toCents("1234.56")).toBe(123456);
    expect(toCents("0.29")).toBe(29);
    expect(toCents("-3.5")).toBe(-350);
    expect(toCents("7")).toBe(700);
    expect(toCents(0.29)).toBe(29);
    expect(toCents(1234.56)).toBe(123456);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(centsToAmount(123456)).toBe(1234.56);
    expect(() => toCents("abc")).toThrow(LedgerReportingError);
    expect(() => toCents(Number.NaN)).toThrow(LedgerReportingError);
  });

  it("signedAmount = debet − credit, debet-positief, geen categorie-omklap", () => {
    expect(signedAmountCents({ debit_amount: 100, credit_amount: 0 })).toBe(10000);
    expect(signedAmountCents({ debit_amount: 0, credit_amount: 100 })).toBe(-10000);
  });
});

describe("ledger-reporting — rekeningrollup", () => {
  it("1. balanced 2-regelgroep → twee rekeningen, periode in balans", () => {
    const r = okReport(group("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1600", 0, 100]]));
    expect(rollup(r, "gb-4000")).toMatchObject({ periodDebitCents: 10000, periodCreditCents: 0, closingCents: 10000 });
    expect(rollup(r, "gb-1600")).toMatchObject({ periodDebitCents: 0, periodCreditCents: 10000, closingCents: -10000 });
    expect(r.totals.periodDebitCents).toBe(r.totals.periodCreditCents);
    expect(r.totals.closingCents).toBe(0);
  });

  it("2. 3-regel inkoopgroep → elke poot op zijn eigen rekening", () => {
    const r = okReport(
      group("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1520", 21, 0], ["gb-1600", 0, 121]]),
    );
    expect(rollup(r, "gb-4000").closingCents).toBe(10000);
    expect(rollup(r, "gb-1520").closingCents).toBe(2100);
    expect(rollup(r, "gb-1600").closingCents).toBe(-12100);
    expect(r.totals.periodDebitCents).toBe(12100);
  });

  it("3. debetsaldo is positief", () => {
    const r = okReport(group("g-1", "2027-02-01", [["gb-4000", 250, 0], ["gb-1600", 0, 250]]));
    expect(rollup(r, "gb-4000").closingCents).toBe(25000);
  });

  it("4. creditsaldo is negatief (niet omgeklapt naar positief)", () => {
    const r = okReport(group("g-1", "2027-02-01", [["gb-1300", 121, 0], ["gb-8000", 0, 121]]));
    expect(rollup(r, "gb-8000").closingCents).toBe(-12100);
    expect(rollup(r, "gb-8000").account.categorie).toBe("omzet");
  });

  it("5. nulsaldo: een rekening met beweging maar eindsaldo 0 blijft; alleen 0/0/0/0 kan worden weggelaten", () => {
    const rows = [
      // Vóór de periode: 1600 gaat +10 en −10, dus beginsaldo 0 zonder periodebeweging.
      ...group("g-0a", "2026-06-01", [["gb-1600", 10, 0], ["gb-1100", 0, 10]]),
      ...group("g-0b", "2026-06-02", [["gb-1100", 10, 0], ["gb-1600", 0, 10]]),
      // In de periode: 4000 ↔ 1100 heen en terug — beweging, eindsaldo 0.
      ...group("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1100", 0, 100]]),
      ...group("g-2", "2027-02-02", [["gb-1100", 100, 0], ["gb-4000", 0, 100]]),
    ];
    const r = okReport(rows);
    expect(rollup(r, "gb-4000")).toMatchObject({ periodDebitCents: 10000, periodCreditCents: 10000, closingCents: 0 });
    expect(rollup(r, "gb-1600")).toMatchObject({ openingCents: 0, periodDebitCents: 0, periodCreditCents: 0, closingCents: 0 });
    expect(r.rollups.map((x) => x.account.id)).toEqual(["gb-1100", "gb-1600", "gb-4000"]);
    // Zonder nulrekeningen verdwijnt alleen 1600 (geen beweging, geen saldo);
    // 4000 heeft beweging en blijft ondanks eindsaldo 0.
    const noZero = buildAccountReport({ rows, clientId: C1, period: Q1, accounts, includeZeroAccounts: false });
    expect(noZero.ok && noZero.rollups.map((x) => x.account.id)).toEqual(["gb-1100", "gb-4000"]);
  });

  it("6. ondergrens: from is inclusief, de dag ervoor telt als beginsaldo", () => {
    const rows = [
      ...group("g-a", "2026-12-31", [["gb-4000", 10, 0], ["gb-1600", 0, 10]]),
      ...group("g-b", "2027-01-01", [["gb-4000", 20, 0], ["gb-1600", 0, 20]]),
    ];
    const r = okReport(rows);
    expect(rollup(r, "gb-4000")).toMatchObject({ openingCents: 1000, periodDebitCents: 2000, closingCents: 3000 });
    expect(isBeforePeriod("2026-12-31", Q1)).toBe(true);
    expect(isInPeriod("2027-01-01", Q1)).toBe(true);
  });

  it("7. bovengrens: toExclusive is exclusief, die dag telt nergens mee", () => {
    const rows = [
      ...group("g-a", "2027-03-31", [["gb-4000", 10, 0], ["gb-1600", 0, 10]]),
      ...group("g-b", "2027-04-01", [["gb-4000", 999, 0], ["gb-1600", 0, 999]]),
    ];
    const r = okReport(rows);
    expect(rollup(r, "gb-4000")).toMatchObject({ openingCents: 0, periodDebitCents: 1000, closingCents: 1000 });
    expect(r.totals.rowCount).toBe(2);
    expect(isInPeriod("2027-03-31", Q1)).toBe(true);
    expect(isInPeriod("2027-04-01", Q1)).toBe(false);
    expect(yearPeriod(2027)).toEqual({ from: "2027-01-01", toExclusive: "2028-01-01" });
  });

  it("8. beginsaldo = Σ(debet − credit) vóór from; eindsaldo = begin + debet − credit", () => {
    const rows = [
      ...group("g-a", "2026-06-01", [["gb-1100", 500, 0], ["gb-8000", 0, 500]]),
      ...group("g-b", "2026-09-01", [["gb-4000", 120, 0], ["gb-1100", 0, 120]]),
      ...group("g-c", "2027-02-01", [["gb-4000", 30, 0], ["gb-1100", 0, 30]]),
    ];
    const r = okReport(rows);
    expect(rollup(r, "gb-1100")).toMatchObject({
      openingCents: 38000, periodDebitCents: 0, periodCreditCents: 3000, closingCents: 35000,
    });
    expect(r.totals.openingCents).toBe(0);
  });

  it("9. boekjaar ≠ jaar van posting_date → posting_date bepaalt, boekjaar niet", () => {
    // Gebroken boekjaar: geboekt op 2027-02-01 maar toegerekend aan boekjaar 2026.
    const rows = group("g-1", "2027-02-01", [["gb-4000", 50, 0], ["gb-1600", 0, 50]], { boekjaar: 2026 });
    const r = okReport(rows);
    expect(rollup(r, "gb-4000").periodDebitCents).toBe(5000);
    const outside = okReport(rows, yearPeriod(2026));
    expect(outside.rollups).toHaveLength(0);
  });

  it("10. dezelfde rekening bij twee administraties wordt nooit samengevoegd", () => {
    const c1 = group("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1600", 0, 100]]);
    const c2 = group("g-2", "2027-02-01", [["gb-4000", 999, 0], ["gb-1600", 0, 999]], { client_id: C2 });
    expect(rollup(okReport(c1), "gb-4000").closingCents).toBe(10000);
    expect(rollup(okReport(c2, Q1, C2), "gb-4000").closingCents).toBe(99900);
  });

  it("11. een rij van een andere administratie in de set is een harde fout, geen stille optelling", () => {
    const rows = [
      ...group("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1600", 0, 100]]),
      ...group("g-2", "2027-02-01", [["gb-4000", 1, 0], ["gb-1600", 0, 1]], { client_id: C2 }),
    ];
    expect(() => buildAccountReport({ rows, clientId: C1, period: Q1, accounts })).toThrow(/andere administratie/);
    expect(() => assertSingleClient(rows, "")).toThrow(/vereist een administratie/);
  });

  it("12. alle vier source_types samen in één periode blijven in balans", () => {
    const rows = [
      ...group("g-p", "2027-01-10", [["gb-4000", 100, 0], ["gb-1520", 21, 0], ["gb-1600", 0, 121]], { source_type: "purchase_invoice" }),
      ...group("g-s", "2027-01-11", [["gb-1300", 242, 0], ["gb-8000", 0, 200], ["gb-1600", 0, 42]], { source_type: "sales_invoice" }),
      ...group("g-b", "2027-01-12", [["gb-1100", 242, 0], ["gb-1300", 0, 242]], { source_type: "bank_allocation" }),
      ...group("g-m", "2027-01-13", [["gb-4000", 5, 0], ["gb-1100", 0, 5]], { source_type: "manual_journal" }),
    ];
    const r = okReport(rows);
    expect(r.totals.periodDebitCents).toBe(r.totals.periodCreditCents);
    expect(r.totals.closingCents).toBe(0);
    expect(r.rollups).toHaveLength(6);
  });

  it("13. inkoop + bankaflettering: kosten en BTW één keer, crediteuren netto nul", () => {
    const rows = [
      ...group("g-p", "2027-01-10", [["gb-4000", 100, 0], ["gb-1520", 21, 0], ["gb-1600", 0, 121]], { source_type: "purchase_invoice" }),
      ...group("g-b", "2027-01-20", [["gb-1600", 121, 0], ["gb-1100", 0, 121]], { source_type: "bank_allocation" }),
    ];
    const r = okReport(rows);
    expect(rollup(r, "gb-4000").closingCents).toBe(10000);
    expect(rollup(r, "gb-1520").closingCents).toBe(2100);
    expect(rollup(r, "gb-1600").closingCents).toBe(0);
    expect(rollup(r, "gb-1100").closingCents).toBe(-12100);
  });

  it("14. een toekomstige tegenboeking telt gewoon mee en salderen naar nul — zonder filter", () => {
    const original = group("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1600", 0, 100]]);
    const reversal = group("g-2", "2027-02-05", [["gb-1600", 100, 0], ["gb-4000", 0, 100]], {
      source_type: "reversal",
    }).map((x, i) => ({ ...x, reversal_of_posting_id: original[i].id }));
    const r = okReport([...original, ...reversal]);
    expect(rollup(r, "gb-4000")).toMatchObject({ periodDebitCents: 10000, periodCreditCents: 10000, closingCents: 0 });
    expect(rollup(r, "gb-1600").closingCents).toBe(0);
    expect(r.totals.rowCount).toBe(4);
  });

  it("15. journal_entries kunnen geen enkel resultaat beïnvloeden", () => {
    // (a) Statisch: de module en de hook bevragen of importeren de legacy
    //     tabel en de documenttabellen nergens (de naam mag in een
    //     toelichting staan; een query of import mag niet).
    for (const path of ["src/lib/ledger-reporting.ts", "src/hooks/useLedgerPostings.ts"]) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(/from\(\s*["'](journal_entries|purchase_invoices|sales_invoices|bank_transactions|bank_transaction_allocations|manual_journals|manual_journal_lines)["']/);
      expect(text, path).not.toMatch(/import[^;]*(useJournalEntries|journal-entry-utils|ledger-mutations|usePurchaseInvoices|useSalesInvoices|useBankTransactions|snelstart-export)/);
      expect(text, path).not.toMatch(/amount_incl|amount_excl|btw_amount|remaining_amount/);
      // Er is precies één tabel die deze laag leest.
      const tables = [...text.matchAll(/from\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]);
      expect(tables.every((t) => t === "ledger_postings"), path).toBe(true);
    }
    // (b) Gedrag: een journal_entries-vormige rij mist debit/credit; wordt hij
    //     toch aangeboden, dan telt hij nooit als bedrag en breekt hij de balans.
    const legacyLike = {
      id: "je-1", client_id: C1, entry_date: "2027-02-01", amount: 100, btw_amount: 21,
      grootboekrekening_id: "gb-4000", ledger_account_text: "4000 - Kosten",
    };
    const rows = group("g-1", "2027-02-01", [["gb-4000", 10, 0], ["gb-1600", 0, 10]]);
    const smuggled = [...rows, legacyLike as unknown as LedgerPostingLike];
    expect(() => buildAccountReport({ rows: smuggled, clientId: C1, period: Q1, accounts })).toThrow(
      LedgerReportingError,
    );
  });

  it("16. leeg grootboek → geldig rapport zonder rekeningen, alle totalen nul", () => {
    const r = okReport([]);
    expect(r.rollups).toEqual([]);
    expect(r.totals).toEqual({ openingCents: 0, periodDebitCents: 0, periodCreditCents: 0, closingCents: 0, rowCount: 0 });
  });

  it("17. een inactieve rekening met boekingen blijft in het rapport staan", () => {
    const r = okReport(group("g-1", "2027-02-01", [["gb-4999", 80, 0], ["gb-1600", 0, 80]]));
    const inactive = rollup(r, "gb-4999");
    expect(inactive.account).toMatchObject({ resolved: true, actief: false, nummer: 4999 });
    expect(inactive.closingCents).toBe(8000);
  });

  it("18. een niet-herleidbare rekening wordt 'Onbekende rekening', zijn boekingen blijven", () => {
    const r = okReport(group("g-1", "2027-02-01", [["gb-ghost", 33, 0], ["gb-1600", 0, 33]]));
    const ghost = rollup(r, "gb-ghost");
    expect(ghost.account).toEqual({
      id: "gb-ghost", nummer: null, omschrijving: UNKNOWN_ACCOUNT_LABEL, categorie: "onbekend", actief: null, resolved: false,
    });
    expect(ghost.closingCents).toBe(3300);
    // Zonder rekeningenlijst is álles onbekend, maar niets verdwijnt.
    const bare = buildAccountReport({ rows: r.rollups.length ? group("g-2", "2027-02-01", [["gb-4000", 1, 0], ["gb-1600", 0, 1]]) : [], clientId: C1, period: Q1 });
    expect(bare.ok && bare.rollups.every((x) => !x.account.resolved)).toBe(true);
    // Onbekende rekeningen sorteren achteraan.
    expect(r.rollups.map((x) => x.account.id)).toEqual(["gb-1600", "gb-ghost"]);
  });

  it("19. een onbekende/vrije-tekstcategorie wordt 'onbekend' en niet weggelaten", () => {
    expect(classifyLedgerCategory("Kostem")).toBe("onbekend");
    expect(classifyLedgerCategory("")).toBe("onbekend");
    expect(classifyLedgerCategory(null)).toBe("onbekend");
    expect(classifyLedgerCategory(" activa ")).toBe("activa");
    expect(classifyLedgerCategory("OMZET")).toBe("omzet");
    const r = okReport(group("g-1", "2027-02-01", [["gb-9999", 12, 0], ["gb-1600", 0, 12]]));
    expect(rollup(r, "gb-9999").account).toMatchObject({ resolved: true, categorie: "onbekend", nummer: 9999 });
  });

  it("20. privé blijft expliciet privé — zonder verzonnen balans- of W&V-plaats", () => {
    expect(classifyLedgerCategory("privé")).toBe("privé");
    const r = okReport(group("g-1", "2027-02-01", [["gb-0900", 40, 0], ["gb-1100", 0, 40]]));
    expect(rollup(r, "gb-0900").account.categorie).toBe("privé");
    // De module exporteert geen enkele afbeelding van categorie naar
    // balans/W&V — dat is een eigenaarsbesluit, niet iets wat hier "even" bestaat.
    const text = readFileSync("src/lib/ledger-reporting.ts", "utf8");
    expect(text).not.toMatch(/eigen_vermogen|equity|balanceSheet|incomeStatement|naturalBalance/i);
  });

  it("21. een niet-EUR-rij wordt geweigerd, nooit meegeteld en nooit weggelaten", () => {
    const rows = [
      ...group("g-1", "2027-02-01", [["gb-4000", 100, 0], ["gb-1600", 0, 100]]),
      ...group("g-2", "2027-02-02", [["gb-4000", 100, 0], ["gb-1600", 0, 100]], { currency: "USD" }),
    ];
    expect(() => buildAccountReport({ rows, clientId: C1, period: Q1, accounts })).toThrow(/alleen EUR; 2 boeking\(en\) in USD/);
    expect(() => assertReportingCurrency(rows)).toThrow(LedgerReportingError);
    // Ook een rij buiten de periode maakt de set ongeldig: valuta is een
    // eigenschap van de set, niet van de periode.
    const outside = [...rows.slice(0, 2), ...group("g-3", "2025-01-01", [["gb-4000", 1, 0], ["gb-1600", 0, 1]], { currency: "GBP" })];
    expect(() => buildAccountReport({ rows: outside, clientId: C1, period: Q1, accounts })).toThrow(/GBP/);
  });

  it("22. een bewust ongebalanceerde fixture faalt de zelfcontrole en levert geen cijfers", () => {
    const rows = [
      row({ grootboekrekening_id: "gb-4000", debit_amount: 100, posting_date: "2027-02-01" }),
      row({ grootboekrekening_id: "gb-1600", credit_amount: 99.99, posting_date: "2027-02-01", line_no: 2 }),
    ];
    const r = buildAccountReport({ rows, clientId: C1, period: Q1, accounts });
    expect(r.ok).toBe(false);
    if (r.ok !== false) return;
    expect(r.failures).toEqual([
      { kind: "period_unbalanced", periodDebitCents: 10000, periodCreditCents: 9999, differenceCents: 1 },
    ]);
    expect("rollups" in r).toBe(false);

    // Een scheef beginsaldo is evengoed ongeldig.
    const skewedOpening = [row({ grootboekrekening_id: "gb-1100", debit_amount: 5, posting_date: "2026-01-01" })];
    const o = buildAccountReport({ rows: skewedOpening, clientId: C1, period: Q1, accounts });
    expect(o.ok).toBe(false);
    if (o.ok === false) expect(o.failures).toEqual([{ kind: "opening_unbalanced", openingCents: 500 }]);
  });

  it("23. grote set: integer-centen blijven exact waar floats zouden driften", () => {
    // 10.000 groepen van 0,01 + 0,02 = 0,03: in floats is 0.01+0.02 al 0.030000000000000002.
    const rows: LedgerPostingLike[] = [];
    let floatDebit = 0;
    for (let i = 0; i < 10_000; i++) {
      const date = `2027-0${1 + (i % 3)}-1${i % 9}`;
      rows.push(...group(`g-${i}`, date, [["gb-4000", 0.01, 0], ["gb-1520", 0.02, 0], ["gb-1600", 0, 0.03]]));
      floatDebit += 0.01 + 0.02;
    }
    const r = okReport(rows);
    expect(r.totals.periodDebitCents).toBe(30_000);
    expect(r.totals.periodCreditCents).toBe(30_000);
    expect(rollup(r, "gb-4000").closingCents).toBe(10_000);
    expect(rollup(r, "gb-1600").closingCents).toBe(-30_000);
    // Bewijs dat de float-route wél zou afwijken:
    expect(floatDebit === 300).toBe(false);
  });

  it("24. invoervolgorde beïnvloedt de rekeningtotalen niet", () => {
    const rows = [
      ...group("g-a", "2026-06-01", [["gb-1100", 500, 0], ["gb-8000", 0, 500]]),
      ...group("g-b", "2027-02-01", [["gb-4000", 120, 0], ["gb-1100", 0, 120]]),
      ...group("g-c", "2027-03-01", [["gb-4000", 30, 0], ["gb-1600", 0, 30]]),
    ];
    const forward = okReport(rows);
    const reversed = okReport([...rows].reverse());
    const shuffled = okReport([rows[3], rows[0], rows[5], rows[2], rows[4], rows[1]]);
    expect(reversed.rollups).toEqual(forward.rollups);
    expect(shuffled.rollups).toEqual(forward.rollups);
    expect(shuffled.totals).toEqual(forward.totals);
  });
});

describe("ledger-reporting — lopend saldo", () => {
  it("25. volgorde is deterministisch: posting_date, posting_group_id, line_no, id", () => {
    const rows = [
      ...group("g-b", "2027-02-01", [["gb-1100", 0, 20], ["gb-4000", 20, 0]]),
      ...group("g-a", "2027-02-01", [["gb-1100", 50, 0], ["gb-8000", 0, 50]]),
      ...group("g-z", "2026-12-01", [["gb-1100", 100, 0], ["gb-8000", 0, 100]]),
      ...group("g-c", "2027-03-01", [["gb-1100", 0, 5], ["gb-4000", 5, 0]]),
    ];
    const shuffled = [rows[7], rows[2], rows[5], rows[0], rows[6], rows[3], rows[1], rows[4]];
    const rb = buildRunningBalance({ rows: shuffled, clientId: C1, accountId: "gb-1100", period: Q1, accounts });
    expect(rb.openingCents).toBe(10000);
    expect(rb.lines.map((l) => l.row.posting_group_id)).toEqual(["g-a", "g-b", "g-c"]);
    expect(rb.lines.map((l) => l.balanceCents)).toEqual([15000, 13000, 12500]);
    expect(rb.closingCents).toBe(12500);
    expect(rb.account.nummer).toBe(1100);
    // Zelfde groep, zelfde datum: line_no beslist; daarna id.
    const twoLines = group("g-1", "2027-02-01", [["gb-1100", 1, 0], ["gb-1100", 2, 0], ["gb-8000", 0, 3]]);
    expect([twoLines[1], twoLines[0]].sort(compareLedgerRows).map((r) => r.line_no)).toEqual([1, 2]);
    const sameLine = { ...twoLines[0], id: "p-0000" };
    expect([twoLines[0], sameLine].sort(compareLedgerRows)[0].id).toBe("p-0000");
    expect(compareLedgerRows(twoLines[0], twoLines[0])).toBe(0);
    // Lopend saldo van één rekening sluit aan op het rollup-eindsaldo.
    expect(rollup(okReport(rows), "gb-1100").closingCents).toBe(rb.closingCents);
    // Buiten de periode: onbekende rekening blijft ook hier zichtbaar.
    const ghost = buildRunningBalance({ rows, clientId: C1, accountId: "gb-none", period: Q1, accounts });
    expect(ghost.account.omschrijving).toBe(UNKNOWN_ACCOUNT_LABEL);
    expect(ghost.lines).toEqual([]);
  });
});

describe("ledger-reporting — bron-drilldown", () => {
  it("26. de vier ondersteunde source_types wijzen naar bestaande routes", () => {
    expect(resolveLedgerSource("purchase_invoice", "pi-1")).toEqual({
      kind: "resolved", sourceType: "purchase_invoice", label: "Inkoop", path: "/facturen/inkoop/pi-1",
    });
    expect(resolveLedgerSource("sales_invoice", "si-1")).toMatchObject({ kind: "resolved", path: "/verkoop" });
    expect(resolveLedgerSource("bank_allocation", "al-1")).toMatchObject({ kind: "resolved", path: "/bank" });
    expect(resolveLedgerSource("manual_journal", "mj-1")).toMatchObject({ kind: "resolved", path: "/grootboek/memoriaal" });
    // Elke route bestaat echt in App.tsx.
    const app = readFileSync("src/App.tsx", "utf8");
    for (const p of ['"/facturen/inkoop/:invoiceId"', '"/verkoop"', '"/bank"', '"/grootboek/memoriaal"']) {
      expect(app).toContain(`path=${p}`);
    }
  });

  it("27. een onbekend source_type of ontbrekend id levert een expliciet onopgelost resultaat, geen verzonnen route", () => {
    expect(resolveLedgerSource("reversal", "x")).toEqual({
      kind: "unresolved", sourceType: "reversal", label: "reversal", reason: 'Onbekend brontype "reversal"',
    });
    expect(resolveLedgerSource("", null)).toMatchObject({ kind: "unresolved", label: "Onbekende bron" });
    expect(resolveLedgerSource("purchase_invoice", null)).toMatchObject({
      kind: "unresolved", label: "Inkoop", reason: "Inkoopfactuur zonder source_id",
    });
  });
});

describe("ledger-reporting — hulpfuncties", () => {
  it("resolveLedgerAccount zonder lijst en met lijst", () => {
    expect(resolveLedgerAccount("gb-1100", accounts)).toMatchObject({ resolved: true, nummer: 1100, categorie: "activa" });
    expect(resolveLedgerAccount("gb-1100", undefined).resolved).toBe(false);
  });

  it("een ongeldige periode wordt geweigerd", () => {
    expect(() => buildAccountReport({ rows: [], clientId: C1, period: { from: "2027-01-01", toExclusive: "2027-01-01" } })).toThrow(/vóór/);
    expect(() => buildAccountReport({ rows: [], clientId: C1, period: { from: "1-1-2027", toExclusive: "2027-02-01" } })).toThrow(/ISO/);
  });
});
