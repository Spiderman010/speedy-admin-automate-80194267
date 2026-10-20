import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("manual purchase invoice single-submit guard", () => {
  it("locks before duplicate lookup and releases the lock after failure or success", () => {
    const source = readFileSync("src/components/PurchaseInvoiceCreateDialog.tsx", "utf8");
    const start = source.indexOf("submittingRef.current = true");
    const lookup = source.indexOf("await fetchPurchaseInvoiceDuplicateCandidates(", start);
    const save = source.indexOf("await addInvoice.mutateAsync(", lookup);
    const release = source.indexOf("submittingRef.current = false", save);
    expect(source).toContain("if (submittingRef.current) return;");
    expect(source).toContain("!checkingDuplicate");
    expect(start).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(start);
    expect(save).toBeGreaterThan(lookup);
    expect(release).toBeGreaterThan(save);
    expect(source.slice(save, release)).toContain("finally {");
    expect(source).toContain("disabled={addInvoice.isPending || checkingDuplicate}");
  });
});
