import { describe, expect, it } from "vitest";
import {
  INTEGRITY_SEVERITY,
  evaluateLedgerIntegrity,
  type IntegrityLine,
  type IntegrityMarker,
  type IntegrityPurchaseInvoice,
} from "@/lib/ledger-integrity";
import type { LedgerPostingLike } from "@/lib/ledger-reporting";

/**
 * De vier integriteitscontroles, met hun ernstgraad.
 *
 * ERROR = kan niet bestaan of blokkeert het boeken aantoonbaar.
 * WAARSCHUWING = werk dat nog moet gebeuren, maar niets is kapot.
 */

const factuur = (over: Partial<IntegrityPurchaseInvoice> = {}): IntegrityPurchaseInvoice => ({
  id: "pi-1", status: "gecontroleerd", invoice_number: "F-1", supplier: "Lev BV",
  ledger_account_text: null, ...over,
});

const regel = (over: Partial<IntegrityLine> = {}): IntegrityLine => ({
  purchase_invoice_id: "pi-1", grootboekrekening_id: "gb-1", ...over,
});

let seq = 0;
/** Eén sluitende boekingsgroep van twee regels. */
function groep(groupId: string, bedrag = "100.00"): LedgerPostingLike[] {
  seq++;
  const base = {
    client_id: "client-1", posting_group_id: groupId, posting_date: "2026-04-01",
    boekjaar: 2026, currency: "EUR", source_type: "manual_journal",
  };
  return [
    { ...base, id: `${groupId}-1`, line_no: 1, grootboekrekening_id: "a", debit_amount: bedrag, credit_amount: "0.00" },
    { ...base, id: `${groupId}-2`, line_no: 2, grootboekrekening_id: "b", debit_amount: "0.00", credit_amount: bedrag },
  ];
}

const leeg = { purchaseInvoices: [], purchaseLines: [], markers: [], postings: [] };
const kinds = (r: { findings: { kind: string }[] }) => r.findings.map((f) => f.kind);

// ─────────────────────────────────────────────────────────────────────────────
describe("1. gecontroleerde factuur zonder persistente regels → ERROR", () => {
  it("1a. een postbare factuur zonder regels is een fout", () => {
    const r = evaluateLedgerIntegrity({ ...leeg, purchaseInvoices: [factuur()] });
    expect(kinds(r)).toEqual(["factuur_zonder_regels"]);
    expect(r.findings[0].severity).toBe("error");
    expect(r.errorCount).toBe(1);
    expect(r.findings[0].detail).toContain("gecontroleerd");
    expect(r.findings[0].reference).toEqual({ soort: "inkoopfactuur", id: "pi-1" });
  });

  it("1b. elke postbare status telt mee", () => {
    for (const status of ["gecontroleerd", "betaald", "geexporteerd"]) {
      const r = evaluateLedgerIntegrity({ ...leeg, purchaseInvoices: [factuur({ status })] });
      expect(kinds(r), status).toContain("factuur_zonder_regels");
    }
  });

  it("1c. 'te_controleren' zonder regels is normaal, geen bevinding", () => {
    // Die factuur is gewoon nog niet verwerkt.
    const r = evaluateLedgerIntegrity({ ...leeg, purchaseInvoices: [factuur({ status: "te_controleren" })] });
    expect(r.findings).toEqual([]);
  });

  it("1d. mét regels is er niets aan de hand", () => {
    const r = evaluateLedgerIntegrity({ ...leeg, purchaseInvoices: [factuur()], purchaseLines: [regel()] });
    expect(r.findings).toEqual([]);
  });

  it("1e. regels van een ándere factuur tellen niet mee", () => {
    const r = evaluateLedgerIntegrity({
      ...leeg,
      purchaseInvoices: [factuur({ id: "pi-1" })],
      purchaseLines: [regel({ purchase_invoice_id: "pi-2" })],
    });
    expect(kinds(r)).toContain("factuur_zonder_regels");
  });
});

describe("2. legacy-tekst zonder echte rekening → WAARSCHUWING", () => {
  it("2a. tekst aanwezig, geen enkele regel met rekening", () => {
    const r = evaluateLedgerIntegrity({
      ...leeg,
      purchaseInvoices: [factuur({ ledger_account_text: "4602 - Telefoonkosten" })],
      purchaseLines: [regel({ grootboekrekening_id: null })],
    });
    expect(kinds(r)).toEqual(["legacy_tekst_zonder_rekening"]);
    expect(r.findings[0].severity).toBe("waarschuwing");
    expect(r.warningCount).toBe(1);
    expect(r.errorCount).toBe(0);
    expect(r.findings[0].detail).toContain("4602 - Telefoonkosten");
  });

  it("2b. zodra één regel een echte rekening heeft, vervalt de waarschuwing", () => {
    const r = evaluateLedgerIntegrity({
      ...leeg,
      purchaseInvoices: [factuur({ ledger_account_text: "4602 - Telefoonkosten" })],
      purchaseLines: [regel({ grootboekrekening_id: "gb-1" })],
    });
    expect(r.findings).toEqual([]);
  });

  it("2c. zonder legacy-tekst is er niets te waarschuwen", () => {
    const r = evaluateLedgerIntegrity({
      ...leeg,
      purchaseInvoices: [factuur({ ledger_account_text: "   " })],
      purchaseLines: [regel({ grootboekrekening_id: null })],
    });
    expect(kinds(r)).not.toContain("legacy_tekst_zonder_rekening");
  });

  it("2d. een factuur kan beide bevindingen tegelijk hebben", () => {
    // Goedgekeurd, geen regels én oude tekst: een fout én een waarschuwing.
    const r = evaluateLedgerIntegrity({
      ...leeg,
      purchaseInvoices: [factuur({ ledger_account_text: "4602 - Telefoonkosten" })],
    });
    expect(kinds(r)).toEqual(["factuur_zonder_regels", "legacy_tekst_zonder_rekening"]);
    expect(r.errorCount).toBe(1);
    expect(r.warningCount).toBe(1);
  });
});

describe("3. marker zonder boekingsgroep → ERROR", () => {
  const marker = (over: Partial<IntegrityMarker> = {}): IntegrityMarker => ({
    soort: "inkoop", posting_group_id: "pg-1", ...over,
  });

  it("3a. een marker die naar niets wijst is een fout", () => {
    const r = evaluateLedgerIntegrity({ ...leeg, markers: [marker()] });
    expect(kinds(r)).toEqual(["marker_zonder_boekingsgroep"]);
    expect(r.findings[0].severity).toBe("error");
    expect(r.findings[0].subject).toBe("pg-1");
    expect(r.findings[0].detail).toContain("inkoopfactuur");
  });

  it("3b. met bijbehorende grootboekregels is er niets aan de hand", () => {
    const r = evaluateLedgerIntegrity({ ...leeg, markers: [marker()], postings: groep("pg-1") });
    expect(r.findings).toEqual([]);
  });

  it("3c. alle vier de soorten markers worden benoemd", () => {
    const soorten: IntegrityMarker["soort"][] = ["inkoop", "verkoop", "bank", "memoriaal"];
    const labels = ["inkoopfactuur", "verkoopfactuur", "bankkoppeling", "memoriaalboeking"];
    soorten.forEach((soort, i) => {
      const r = evaluateLedgerIntegrity({ ...leeg, markers: [marker({ soort, posting_group_id: `pg-${i}` })] });
      expect(r.findings[0].detail, soort).toContain(labels[i]);
    });
  });
});

describe("4. boekingsgroep niet in balans → ERROR", () => {
  it("4a. debet ≠ credit binnen één groep", () => {
    const scheef: LedgerPostingLike[] = [
      { ...groep("pg-1")[0] },
      { ...groep("pg-1")[1], credit_amount: "90.00" },
    ];
    const r = evaluateLedgerIntegrity({ ...leeg, postings: scheef });
    expect(kinds(r)).toEqual(["boekingsgroep_niet_in_balans"]);
    expect(r.findings[0].severity).toBe("error");
    expect(r.findings[0].subject).toBe("pg-1");
    // Verschil in hele centen, dezelfde rekenwijze als de rapportagekern.
    expect(r.findings[0].detail).toContain("1000 cent");
  });

  it("4b. een sluitende groep geeft niets", () => {
    const r = evaluateLedgerIntegrity({ ...leeg, postings: [...groep("pg-1"), ...groep("pg-2", "5.55")] });
    expect(r.findings).toEqual([]);
  });

  it("4c. alleen de scheve groep wordt gemeld, niet de rest", () => {
    const scheef = [...groep("pg-ok"), ...groep("pg-fout")];
    scheef[3] = { ...scheef[3], credit_amount: "99.99" };
    const r = evaluateLedgerIntegrity({ ...leeg, postings: scheef });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].subject).toBe("pg-fout");
  });

  it("4d. centen, geen floats: 0,1 + 0,2 sluit gewoon", () => {
    const base = {
      client_id: "client-1", posting_group_id: "pg-cent", posting_date: "2026-04-01",
      boekjaar: 2026, currency: "EUR", source_type: "manual_journal",
    };
    const r = evaluateLedgerIntegrity({
      ...leeg,
      postings: [
        { ...base, id: "a", line_no: 1, grootboekrekening_id: "a", debit_amount: "0.10", credit_amount: "0.00" },
        { ...base, id: "b", line_no: 2, grootboekrekening_id: "b", debit_amount: "0.20", credit_amount: "0.00" },
        { ...base, id: "c", line_no: 3, grootboekrekening_id: "c", debit_amount: "0.00", credit_amount: "0.30" },
      ],
    });
    expect(r.findings).toEqual([]);
  });

  it("4e. de volgorde hangt niet af van de rijvolgorde", () => {
    const maak = (rows: LedgerPostingLike[]) =>
      evaluateLedgerIntegrity({ ...leeg, postings: rows }).findings.map((f) => f.subject);
    const a = [...groep("pg-b"), ...groep("pg-a")];
    a[1] = { ...a[1], credit_amount: "1.00" };
    a[3] = { ...a[3], credit_amount: "1.00" };
    expect(maak(a)).toEqual(["pg-a", "pg-b"]);
    expect(maak([...a].reverse())).toEqual(["pg-a", "pg-b"]);
  });
});

describe("samenvatting en ernstmodel", () => {
  it("5a. de ernstgraden zijn precies zoals afgesproken", () => {
    expect(INTEGRITY_SEVERITY).toEqual({
      factuur_zonder_regels: "error",
      legacy_tekst_zonder_rekening: "waarschuwing",
      marker_zonder_boekingsgroep: "error",
      boekingsgroep_niet_in_balans: "error",
    });
  });

  it("5b. een schone administratie levert een leeg maar volledig rapport", () => {
    const r = evaluateLedgerIntegrity({
      ...leeg,
      purchaseInvoices: [factuur()],
      purchaseLines: [regel()],
      markers: [{ soort: "inkoop", posting_group_id: "pg-1" }],
      postings: groep("pg-1"),
    });
    expect(r.findings).toEqual([]);
    expect(r.errorCount).toBe(0);
    expect(r.warningCount).toBe(0);
    expect(r.byKind).toEqual({
      factuur_zonder_regels: 0,
      legacy_tekst_zonder_rekening: 0,
      marker_zonder_boekingsgroep: 0,
      boekingsgroep_niet_in_balans: 0,
    });
  });

  it("5c. alles tegelijk wordt per soort geteld", () => {
    const scheef = groep("pg-scheef");
    scheef[1] = { ...scheef[1], credit_amount: "1.00" };
    const r = evaluateLedgerIntegrity({
      purchaseInvoices: [factuur({ ledger_account_text: "4602 - Telefoon" })],
      purchaseLines: [],
      markers: [{ soort: "verkoop", posting_group_id: "pg-weg" }],
      postings: scheef,
    });
    expect(r.byKind).toEqual({
      factuur_zonder_regels: 1,
      legacy_tekst_zonder_rekening: 1,
      marker_zonder_boekingsgroep: 1,
      boekingsgroep_niet_in_balans: 1,
    });
    expect(r.errorCount).toBe(3);
    expect(r.warningCount).toBe(1);
  });
});
