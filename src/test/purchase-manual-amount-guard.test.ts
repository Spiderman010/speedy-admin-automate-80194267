import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("manual purchase invoice creation amount control", () => {
  it("validates inconsistent totals before submitting a new draft", () => {
    const source = readFileSync("src/components/PurchaseInvoiceCreateDialog.tsx", "utf8");
    const validation = source.indexOf('title: "Factuurbedragen sluiten niet aan"');
    const creation = source.indexOf("await addInvoice.mutateAsync(");
    expect(validation).toBeGreaterThan(-1);
    expect(creation).toBeGreaterThan(validation);
    expect(source).toContain("amountExcl + btwAmount - amountIncl");
    expect(source).toContain("Math.abs(Math.round(");
    expect(source).toContain("amountExcl != null && btwAmount != null && amountIncl != null");
  });
});
