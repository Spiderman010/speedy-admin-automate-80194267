import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("purchase posting readiness gate", () => {
  it("fails closed until server-derived posting readiness is available", () => {
    const code = readFileSync("src/pages/PurchaseInvoiceWorkspace.tsx", "utf8");
    expect(code).toContain('!postingReadiness || postingReadiness.state === "geblokkeerd"');
    expect(code).not.toContain('!!postingReadiness && (postingReadiness.state === "geblokkeerd"');
    expect(code).toContain('disabled={!canApprove || !isPostableStatus || readinessBlocked');
  });
});
