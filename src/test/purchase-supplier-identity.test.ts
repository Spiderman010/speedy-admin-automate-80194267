import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("purchase supplier identity", () => {
  it("clears linked supplier ID when free-text supplier name is edited", () => {
    const source = readFileSync("src/components/PurchaseInvoiceCreateDialog.tsx", "utf8");
    expect(source).toContain('onChange={(e) => update({ supplier: e.target.value, leverancier_id: "" })}');
    expect(source).toContain("leverancier_id: form.leverancier_id || null");
    expect(source).toContain("supplier: form.supplier.trim()");
  });
});
