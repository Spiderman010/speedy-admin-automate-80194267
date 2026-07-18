import { describe, it, expect } from "vitest";
import {
  isBlankLine,
  isPartiallyFilledLine,
  computeLineTotals,
  validatePurchaseLines,
  derivePrefillLine,
} from "@/lib/purchase-line-validation";

// Deze tests borgen de blank-line regels voor handmatig aangemaakte
// inkoopfacturen. Ze werken direct op de pure helpers zodat de logica
// onafhankelijk van React getest kan worden.

const blank = { omschrijving: "", amount_input: "", grootboekrekening_id: null };
const filled = { omschrijving: "Kantoor", amount_input: "100,00", grootboekrekening_id: "gb-1" };

describe("isBlankLine", () => {
  it("herkent een volledig lege regel", () => {
    expect(isBlankLine(blank)).toBe(true);
  });
  it("witruimte-only telt als leeg", () => {
    expect(isBlankLine({ omschrijving: "   ", amount_input: "  ", grootboekrekening_id: null })).toBe(true);
  });
  it("regel met omschrijving is niet leeg", () => {
    expect(isBlankLine({ ...blank, omschrijving: "Iets" })).toBe(false);
  });
  it("regel met bedrag is niet leeg", () => {
    expect(isBlankLine({ ...blank, amount_input: "10" })).toBe(false);
  });
  it("regel met grootboekrekening is niet leeg", () => {
    expect(isBlankLine({ ...blank, grootboekrekening_id: "gb-9" })).toBe(false);
  });
  it("volledig ingevulde regel is niet leeg", () => {
    expect(isBlankLine(filled)).toBe(false);
  });
});

describe("isPartiallyFilledLine", () => {
  it("blanco is niet partieel", () => {
    expect(isPartiallyFilledLine(blank)).toBe(false);
  });
  it("volledig is niet partieel", () => {
    expect(isPartiallyFilledLine(filled)).toBe(false);
  });
  it("alleen bedrag zonder omschrijving is partieel", () => {
    expect(isPartiallyFilledLine({ omschrijving: "", amount_input: "50", grootboekrekening_id: null })).toBe(true);
  });
  it("alleen omschrijving zonder bedrag is partieel", () => {
    expect(isPartiallyFilledLine({ omschrijving: "Iets", amount_input: "", grootboekrekening_id: null })).toBe(true);
  });
  it("alleen grootboekrekening zonder bedrag of omschrijving is partieel", () => {
    expect(isPartiallyFilledLine({ omschrijving: "", amount_input: "", grootboekrekening_id: "gb-1" })).toBe(true);
  });
});

// De rest van de tests spiegelt de UI-workflow: eerst filteren, dan totalen /
// validatie berekenen — precies zoals InvoiceEditDialog dit doet.
type UILine = { omschrijving: string; amount_input: string; grootboekrekening_id: string | null; btw_percentage: number };

const meaningful = (rows: UILine[]) =>
  rows.filter((r) => !isBlankLine(r)).map((r) => ({
    omschrijving: r.omschrijving,
    amount_excl: Number(r.amount_input.replace(",", ".")) || 0,
    btw_percentage: r.btw_percentage,
  }));

describe("totals negeren blanco regels", () => {
  it("blanco regel telt niet mee — €100 @21% blijft €100/€21/€121", () => {
    const rows: UILine[] = [
      { omschrijving: "Kantoor", amount_input: "100", grootboekrekening_id: "gb-1", btw_percentage: 21 },
      { omschrijving: "", amount_input: "", grootboekrekening_id: null, btw_percentage: 21 },
    ];
    expect(computeLineTotals(meaningful(rows))).toEqual({ sumExcl: 100, sumBtw: 21, sumIncl: 121 });
  });

  it("gemengde BTW telt correct: 100@21 + 50@9 = 150/25.5/175.5", () => {
    const rows: UILine[] = [
      { omschrijving: "Kantoor", amount_input: "100", grootboekrekening_id: "gb-1", btw_percentage: 21 },
      { omschrijving: "Eten", amount_input: "50", grootboekrekening_id: "gb-2", btw_percentage: 9 },
    ];
    expect(computeLineTotals(meaningful(rows))).toEqual({ sumExcl: 150, sumBtw: 25.5, sumIncl: 175.5 });
  });

  it("verwijder eerste regel → alleen tweede regel telt", () => {
    const rows: UILine[] = [
      { omschrijving: "Eten", amount_input: "50", grootboekrekening_id: "gb-2", btw_percentage: 9 },
    ];
    expect(computeLineTotals(meaningful(rows))).toEqual({ sumExcl: 50, sumBtw: 4.5, sumIncl: 54.5 });
  });
});

describe("validatie: partieel blokkeert, blanco wordt overgeslagen", () => {
  const header = { amount_excl: 100, btw_amount: 21, amount_incl: 121 };

  it("blanco regel naast populated regel: validatie slaagt", () => {
    const rows: UILine[] = [
      { omschrijving: "Kantoor", amount_input: "100", grootboekrekening_id: "gb-1", btw_percentage: 21 },
      { omschrijving: "", amount_input: "", grootboekrekening_id: null, btw_percentage: 21 },
    ];
    // Simuleer dialog: skip blanks; controleer alleen populated regels.
    const populated = rows.filter((r) => !isBlankLine(r));
    for (const r of populated) {
      expect(isPartiallyFilledLine(r)).toBe(false);
    }
    expect(validatePurchaseLines(meaningful(rows), header)).toBeNull();
  });

  it("partiele regel wordt gedetecteerd (mist bedrag)", () => {
    const partial: UILine = { omschrijving: "Onvolledig", amount_input: "", grootboekrekening_id: null, btw_percentage: 21 };
    expect(isPartiallyFilledLine(partial)).toBe(true);
  });
});

describe("prefill: één voorstelregel uit header", () => {
  it("gebruikt amount_excl uit header", () => {
    expect(derivePrefillLine({ amount_excl: 100, amount_incl: 121, btw_percentage: 21, isBtwVrijgesteld: false }))
      .toEqual({ amount_excl: 100, btw_percentage: 21 });
  });
  it("leidt excl af uit incl wanneer excl ontbreekt", () => {
    const r = derivePrefillLine({ amount_excl: null, amount_incl: 121, btw_percentage: 21, isBtwVrijgesteld: false });
    expect(r?.amount_excl).toBeCloseTo(100, 2);
    expect(r?.btw_percentage).toBe(21);
  });
  it("BTW-vrijgesteld → pct=0 en excl = incl", () => {
    expect(derivePrefillLine({ amount_excl: null, amount_incl: 100, btw_percentage: 21, isBtwVrijgesteld: true }))
      .toEqual({ amount_excl: 100, btw_percentage: 0 });
  });
  it("geen header → geen voorstelregel", () => {
    expect(derivePrefillLine({ amount_excl: null, amount_incl: null, btw_percentage: null, isBtwVrijgesteld: false }))
      .toBeNull();
  });
});
