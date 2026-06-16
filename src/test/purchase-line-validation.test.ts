import { describe, it, expect } from "vitest";
import {
  computeLineTotals,
  computeLineDiffs,
  lineTolerance,
  validatePurchaseLines,
  derivePrefillLine,
} from "@/lib/purchase-line-validation";


describe("purchase line validation", () => {
  it("returns null for empty lines", () => {
    expect(validatePurchaseLines([], { amount_excl: 100, btw_amount: 21, amount_incl: 121 })).toBeNull();
  });

  it("computes totals for single VAT rate", () => {
    const t = computeLineTotals([
      { omschrijving: "a", amount_excl: 100, btw_percentage: 21 },
    ]);
    expect(t).toEqual({ sumExcl: 100, sumBtw: 21, sumIncl: 121 });
  });

  it("supports mixed VAT percentages (21% + 9% + 0%)", () => {
    const t = computeLineTotals([
      { omschrijving: "a", amount_excl: 100, btw_percentage: 21 },
      { omschrijving: "b", amount_excl: 50, btw_percentage: 9 },
      { omschrijving: "c", amount_excl: 30, btw_percentage: 0 },
    ]);
    // 21 + 4.5 + 0 = 25.5
    expect(t.sumExcl).toBe(180);
    expect(t.sumBtw).toBe(25.5);
    expect(t.sumIncl).toBe(205.5);
  });

  it("validates header excl/btw/incl with mixed VAT correctly", () => {
    const lines = [
      { omschrijving: "hoog", amount_excl: 100, btw_percentage: 21 },
      { omschrijving: "laag", amount_excl: 50, btw_percentage: 9 },
    ];
    expect(validatePurchaseLines(lines, { amount_excl: 150, btw_amount: 25.5, amount_incl: 175.5 })).toBeNull();
  });

  it("reports excl mismatch in clear NL message", () => {
    const msg = validatePurchaseLines(
      [{ omschrijving: "x", amount_excl: 99, btw_percentage: 21 }],
      { amount_excl: 100, btw_amount: null, amount_incl: null },
    );
    expect(msg).toContain("excl. BTW");
    expect(msg).toContain("-€1.00");
  });

  it("reports btw mismatch independently from excl/incl", () => {
    const msg = validatePurchaseLines(
      [{ omschrijving: "x", amount_excl: 100, btw_percentage: 21 }],
      { amount_excl: 100, btw_amount: 20, amount_incl: null },
    );
    expect(msg).toContain("BTW");
    expect(msg).toContain("+€1.00");
  });

  it("reports multiple mismatches in a single message", () => {
    const msg = validatePurchaseLines(
      [{ omschrijving: "x", amount_excl: 100, btw_percentage: 21 }],
      { amount_excl: 90, btw_amount: 20, amount_incl: 110 },
    );
    expect(msg).toMatch(/excl\. BTW/);
    expect(msg).toMatch(/BTW \(som/);
    expect(msg).toMatch(/incl\. BTW/);
  });

  it("absorbs 1-cent rounding drift on totals", () => {
    // 33.33 * 3 = 99.99 but invoice may say 100.00
    const lines = [
      { omschrijving: "a", amount_excl: 33.33, btw_percentage: 21 },
      { omschrijving: "b", amount_excl: 33.33, btw_percentage: 21 },
      { omschrijving: "c", amount_excl: 33.34, btw_percentage: 21 },
    ];
    expect(validatePurchaseLines(lines, { amount_excl: 100, btw_amount: 21, amount_incl: 121 })).toBeNull();
  });

  it("requires omschrijving and finite amount_excl", () => {
    expect(validatePurchaseLines(
      [{ omschrijving: "", amount_excl: 10, btw_percentage: 21 }],
      { amount_excl: 10, btw_amount: 2.1, amount_incl: 12.1 },
    )).toMatch(/omschrijving/);
    expect(validatePurchaseLines(
      [{ omschrijving: "x", amount_excl: Number.NaN, btw_percentage: 21 }],
      { amount_excl: 0, btw_amount: 0, amount_incl: 0 },
    )).toMatch(/geldig bedrag/);
  });

  it("scales tolerance with line count", () => {
    expect(lineTolerance(1)).toBe(0.02);
    expect(lineTolerance(5)).toBe(0.05);
    expect(lineTolerance(20)).toBe(0.20);
  });

  it("skips missing header totals", () => {
    const d = computeLineDiffs(
      [{ omschrijving: "x", amount_excl: 100, btw_percentage: 21 }],
      { amount_excl: null, btw_amount: null, amount_incl: 121 },
    );
    expect(d.excl).toBeNull();
    expect(d.btw).toBeNull();
    expect(d.incl).toBe(0);
    expect(d.allOk).toBe(true);
});

describe("derivePrefillLine", () => {
  it("uses header excl when present (21% BTW)", () => {
    expect(derivePrefillLine({
      amount_excl: 100, amount_incl: 121, btw_percentage: 21, isBtwVrijgesteld: false,
    })).toEqual({ amount_excl: 100, btw_percentage: 21 });
  });

  it("derives excl from incl using header pct when excl missing (21%)", () => {
    const r = derivePrefillLine({
      amount_excl: null, amount_incl: 121, btw_percentage: 21, isBtwVrijgesteld: false,
    });
    expect(r).toEqual({ amount_excl: 100, btw_percentage: 21 });
  });

  it("derives excl from incl using header pct when excl missing (9%)", () => {
    const r = derivePrefillLine({
      amount_excl: null, amount_incl: 109, btw_percentage: 9, isBtwVrijgesteld: false,
    });
    expect(r).toEqual({ amount_excl: 100, btw_percentage: 9 });
  });

  it("BTW-vrijgesteld forces pct=0 and excl=incl when only incl present", () => {
    const r = derivePrefillLine({
      amount_excl: null, amount_incl: 250, btw_percentage: 21, isBtwVrijgesteld: true,
    });
    expect(r).toEqual({ amount_excl: 250, btw_percentage: 0 });
  });

  it("BTW-vrijgesteld forces pct=0 even when header excl + pct are set", () => {
    const r = derivePrefillLine({
      amount_excl: 250, amount_incl: 302.5, btw_percentage: 21, isBtwVrijgesteld: true,
    });
    expect(r).toEqual({ amount_excl: 250, btw_percentage: 0 });
  });

  it("returns null when neither excl nor incl is available", () => {
    expect(derivePrefillLine({
      amount_excl: null, amount_incl: null, btw_percentage: 21, isBtwVrijgesteld: false,
    })).toBeNull();
  });

  it("incl-only with no pct treats invoice as 0% (excl = incl)", () => {
    const r = derivePrefillLine({
      amount_excl: null, amount_incl: 100, btw_percentage: null, isBtwVrijgesteld: false,
    });
    expect(r).toEqual({ amount_excl: 100, btw_percentage: 0 });
  });

  it("rounds derived excl to 2 decimals", () => {
    const r = derivePrefillLine({
      amount_excl: null, amount_incl: 100, btw_percentage: 21, isBtwVrijgesteld: false,
    });
    // 100 / 1.21 = 82.6446... → 82.64
    expect(r).toEqual({ amount_excl: 82.64, btw_percentage: 21 });
  });

  it("ignores NaN/Infinity inputs and falls back correctly", () => {
    const r = derivePrefillLine({
      amount_excl: Number.NaN, amount_incl: 121, btw_percentage: 21, isBtwVrijgesteld: false,
    });
    expect(r).toEqual({ amount_excl: 100, btw_percentage: 21 });
  });

  it("derived prefill round-trips through validation within tolerance", () => {
    const prefill = derivePrefillLine({
      amount_excl: null, amount_incl: 121, btw_percentage: 21, isBtwVrijgesteld: false,
    })!;
    const err = validatePurchaseLines(
      [{ omschrijving: "x", amount_excl: prefill.amount_excl, btw_percentage: prefill.btw_percentage }],
      { amount_excl: null, btw_amount: null, amount_incl: 121 },
    );
    expect(err).toBeNull();
  });

  it("BTW-vrijgesteld prefill round-trips through validation", () => {
    const prefill = derivePrefillLine({
      amount_excl: null, amount_incl: 250, btw_percentage: null, isBtwVrijgesteld: true,
    })!;
    const err = validatePurchaseLines(
      [{ omschrijving: "x", amount_excl: prefill.amount_excl, btw_percentage: prefill.btw_percentage }],
      { amount_excl: 250, btw_amount: 0, amount_incl: 250 },
    );
    expect(err).toBeNull();
  });
});

});
