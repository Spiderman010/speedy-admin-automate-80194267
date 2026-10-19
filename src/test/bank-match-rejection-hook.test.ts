import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/hooks/useBankMatchRejections.ts"), "utf8");

describe("bank-match rejection hook security contract", () => {
  it("requires authentication, explicit organization and administration selection", () => {
    expect(source).toContain("!!user && !!organizationId && sortedClientIds.length > 0");
    expect(source).toContain('.eq("organization_id", organizationId)');
    expect(source).toContain('.in("client_id", sortedClientIds)');
  });

  it("reads all pages and propagates failures instead of treating them as empty feedback", () => {
    expect(source).toContain(".range(offset, offset + PAGE_SIZE - 1)");
    expect(source).toContain("if (error) throw error");
    expect(source).toContain("if ((data?.length ?? 0) < PAGE_SIZE) return result");
  });

  it("records only rejection feedback, with tenant scope, not financial posting", () => {
    expect(source).toContain('.from("bank_match_rejections").upsert(');
    expect(source).toContain("organization_id: input.organizationId");
    expect(source).toContain("client_id: input.clientId");
    expect(source).not.toMatch(/\.from\("(?:ledger_postings|bank_transactions|bank_transaction_allocations)"\)/);
  });
});

const dialog = readFileSync(resolve(process.cwd(), "src/components/BankMatchDialog.tsx"), "utf8");

describe("bank match dialog rejection enforcement", () => {
  it("does not offer matches until rejection feedback is available", () => {
    expect(dialog).toContain("if (!rejectionIndex) return []");
  });

  it("filters rejected candidates before rendering and selection", () => {
    expect(dialog).toContain("withoutRejectedCandidates(rejectionIndex, transaction.id,");
    expect(dialog).toContain("rankCandidates(transaction, purchaseInvoices, salesInvoices)");
  });
});
