import { describe, it, expect } from "vitest";
import { deriveHeaderFromLines } from "@/lib/purchase-header-derivation";
import { computeLineTotals } from "@/lib/purchase-line-validation";

describe("deriveHeaderFromLines", () => {
  it("incompleet header + één 9%-regel → 100/9/109", () => {
    const totals = computeLineTotals([
      { omschrijving: "x", amount_excl: 100, btw_percentage: 9 },
    ]);
    const out = deriveHeaderFromLines(
      { amount_excl: 100, btw_amount: null, amount_incl: 100 },
      totals,
    );
    expect(out).toEqual({ amount_excl: 100, btw_amount: 9, amount_incl: 109 });
  });

  it("incompleet header (incl=null) + één 9%-regel → 100/9/109", () => {
    const totals = computeLineTotals([
      { omschrijving: "x", amount_excl: 100, btw_percentage: 9 },
    ]);
    const out = deriveHeaderFromLines(
      { amount_excl: 100, btw_amount: null, amount_incl: null },
      totals,
    );
    expect(out).toEqual({ amount_excl: 100, btw_amount: 9, amount_incl: 109 });
  });

  it("mixed VAT: 100@21, 50@9, 25@0 → 175/25.5/200.5", () => {
    const totals = computeLineTotals([
      { omschrijving: "a", amount_excl: 100, btw_percentage: 21 },
      { omschrijving: "b", amount_excl: 50, btw_percentage: 9 },
      { omschrijving: "c", amount_excl: 25, btw_percentage: 0 },
    ]);
    const out = deriveHeaderFromLines(
      { amount_excl: 175, btw_amount: null, amount_incl: 175 },
      totals,
    );
    expect(out).toEqual({ amount_excl: 175, btw_amount: 25.5, amount_incl: 200.5 });
  });

  it("volledig header blijft ongewijzigd", () => {
    const totals = computeLineTotals([
      { omschrijving: "x", amount_excl: 100, btw_percentage: 21 },
    ]);
    const header = { amount_excl: 100, btw_amount: 21, amount_incl: 121 };
    expect(deriveHeaderFromLines(header, totals)).toBe(header);
  });

  it("user-edited header (incl != excl) blijft ongewijzigd", () => {
    const totals = computeLineTotals([
      { omschrijving: "x", amount_excl: 100, btw_percentage: 9 },
    ]);
    const header = { amount_excl: 100, btw_amount: null, amount_incl: 150 };
    expect(deriveHeaderFromLines(header, totals)).toBe(header);
  });

  it("geen VAT in regels → header ongewijzigd", () => {
    const totals = computeLineTotals([
      { omschrijving: "x", amount_excl: 100, btw_percentage: 0 },
    ]);
    const header = { amount_excl: 100, btw_amount: null, amount_incl: 100 };
    expect(deriveHeaderFromLines(header, totals)).toBe(header);
  });

  it("geen regels → header ongewijzigd", () => {
    const totals = computeLineTotals([]);
    const header = { amount_excl: 100, btw_amount: null, amount_incl: 100 };
    expect(deriveHeaderFromLines(header, totals)).toBe(header);
  });

  it("amount_excl ontbreekt → header ongewijzigd", () => {
    const totals = computeLineTotals([
      { omschrijving: "x", amount_excl: 100, btw_percentage: 9 },
    ]);
    const header = { amount_excl: null, btw_amount: null, amount_incl: null };
    expect(deriveHeaderFromLines(header, totals)).toBe(header);
  });
});
