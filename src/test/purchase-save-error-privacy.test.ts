import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The purchase workspace must never interpolate raw RPC errors into user-facing
// toast text. Server errors can contain SQL, schema details or internal row IDs.
describe("purchase workspace save error privacy boundary", () => {
  it("uses a fixed, actionable Dutch message and never interpolates raw RPC errors", () => {
    const source = readFileSync("src/pages/PurchaseInvoiceWorkspace.tsx", "utf8");
    const start = source.indexOf("await saveInvoiceWithLines.mutateAsync(");
    const end = source.indexOf("} finally {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const saveAction = source.slice(start, end);
    expect(saveAction).toContain('title: "Opslaan mislukt"');
    expect(saveAction).toContain("Vernieuw de factuur en controleer de gegevens");
    expect(saveAction).not.toContain("const raw =");
    expect(saveAction).not.toContain("e?.message");
    expect(saveAction).not.toContain("(raw ?");
  });
});
