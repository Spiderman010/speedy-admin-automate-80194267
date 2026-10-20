import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("manual purchase invoice duplicate protection", () => {
  it("checks supplier-aware duplicates before creating a new invoice", () => {
    const source = readFileSync("src/components/PurchaseInvoiceCreateDialog.tsx", "utf8");
    const lookup = source.indexOf("await fetchPurchaseInvoiceDuplicateCandidates(");
    const matches = source.indexOf("computeDuplicateIds([candidate, ...existing])", lookup);
    const create = source.indexOf("await addInvoice.mutateAsync(", matches);
    expect(lookup).toBeGreaterThan(-1);
    expect(matches).toBeGreaterThan(lookup);
    expect(create).toBeGreaterThan(matches);
    expect(source.slice(lookup, create)).toContain("organizationId: organizationId ?? undefined");
    expect(source.slice(matches, create)).toContain("if (duplicateIds.has(candidate.id))");
    expect(source.slice(matches, create)).toContain("return;");
    expect(source.slice(matches, create)).toContain("Mogelijk dubbele inkoopfactuur");
  });
});
