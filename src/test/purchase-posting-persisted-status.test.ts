import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("purchase invoice posting approval gate", () => {
  it("uses the persisted invoice approval, never unsaved form status", () => {
    const workspace = readFileSync("src/pages/PurchaseInvoiceWorkspace.tsx", "utf8");
    expect(workspace).toContain('["gecontroleerd", "betaald", "geexporteerd"].includes(invoice?.status ?? "")');
    expect(workspace).not.toContain('["gecontroleerd", "betaald", "geexporteerd"].includes(header.status)');
  });

  it("refreshes invoice state only after successful atomic save", () => {
    const hook = readFileSync("src/hooks/usePurchaseInvoiceLines.ts", "utf8");
    expect(hook).toContain('qc.invalidateQueries({ queryKey: ["purchase_invoice", vars.invoiceId] })');
  });
});
