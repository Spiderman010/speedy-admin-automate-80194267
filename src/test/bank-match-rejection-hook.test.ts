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
    expect(source).toContain('if (lastId) query = query.gt("id", lastId)');
    expect(source).toContain(".limit(PAGE_SIZE)");
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

const bankPage = readFileSync(resolve(process.cwd(), "src/pages/Bank.tsx"), "utf8");

describe("Bank page reject feedback integration", () => {
  it("applies one fail-closed rejected-candidate filter across ranked suggestions", () => {
    expect(bankPage).toContain("const rankAllowedCandidates = useCallback(");
    expect(bankPage).toContain("withoutRejectedCandidates(rejectionIndex, tx.id, rankCandidates(tx, purchase, sales))");
    expect((bankPage.match(/rankAllowedCandidates\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(bankPage).toContain("rejectionIndex={rejectionIndex}");
  });

  it("records a concrete rejected invoice before resetting the bank transaction", () => {
    expect(bankPage).toContain("const recordSuggestionRejection = useCallback(");
    expect(bankPage).toMatch(/await recordSuggestionRejection\(tx\);[\s\S]*?await updateTx\.mutateAsync\(\{/);
    expect(bankPage).toMatch(/await recordSuggestionRejection\(t\);[\s\S]*?await updateTx\.mutateAsync\(\{/);
  });

  it("blocks direct invoice confirmation when rejection feedback is unavailable", () => {
    expect(bankPage).toContain("if (!rejectionIndex) throw new Error");
    expect(bankPage).toContain("isRejectedCandidate(rejectionIndex, tx.id, { id: invoiceId, type: invoiceType })");
  });
});

const processingScreen = readFileSync(resolve(process.cwd(), "src/components/VerwerkingsScherm.tsx"), "utf8");

describe("Codex P1: processing screen rejection guard", () => {
  it("hides rejected invoices and fails closed while feedback is unavailable", () => {
    expect(processingScreen).toContain("if (!current || !rejectionIndex) return []");
    expect(processingScreen).toContain("!isRejectedCandidate(rejectionIndex, current.id, { id: i.id, type: i.type })");
    expect(bankPage).toContain("rejectionIndex={rejectionIndex}");
  });

  it("blocks processing screen financial writes before any mutation", () => {
    const handler = bankPage.split("onMatchInvoice={async (id, invoiceId, invoiceType) => {")[1];
    expect(handler).toBeDefined();
    const beforeWrite = handler.split("await updateTx.mutateAsync")[0];
    expect(beforeWrite).toContain("if (!rejectionIndex || !tx || isRejectedCandidate(rejectionIndex, id, { id: invoiceId, type: invoiceType }))");
  });
});

describe("Codex P2: matched invoice type is resolved, not inferred from sign", () => {
  it("uses the scoped purchase or sales collections and fails on missing or ambiguous IDs", () => {
    expect(bankPage).toContain("invoices?.some(i => i.id === matched && i.client_id === tx.client_id)");
    expect(bankPage).toContain("salesInvs?.some(i => i.id === matched && i.client_id === tx.client_id)");
    expect(bankPage).toContain('if (matched && !matchedPurchase && !matchedSales) throw new Error');
    expect(bankPage).toContain('if (matched && matchedPurchase && matchedSales) throw new Error');
    expect(bankPage).toContain('type: matchedPurchase ? "inkoop" as const : "verkoop" as const');
  });
});

describe("Codex P1/P2: fresh recheck and keyset pagination", () => {
  it("queries each financial candidate against current database state", () => {
    expect(source).toContain("export async function assertBankMatchNotRejected(");
    expect(source).toContain('.eq("bank_transaction_id", bankTransactionId)');
    expect(source).toContain('.eq("invoice_type", invoiceType)');
    expect(source).toContain('.eq("invoice_id", invoiceId)');
    expect(bankPage).toContain("await assertBankMatchNotRejected(");
  });
  it("uses keyset pagination instead of mutable offsets", () => {
    expect(source).toContain('query.gt("id", lastId)');
    expect(source).not.toContain(".range(offset,");
  });
});

describe("PR #256: rejection history and replacement message contract", () => {
  it("counts rejection feedback by bank transaction, not across administrations", () => {
    expect(bankPage).toContain("const rejectionCounts = useMemo(() => {");
    expect(bankPage).toContain("counts.set(row.bank_transaction_id, (counts.get(row.bank_transaction_id) ?? 0) + 1)");
    expect(bankPage).toContain("}, [rejectionRows]);");
  });

  it("only calls an eligible, same-direction candidate a replacement", () => {
    expect(bankPage).toContain('best && !bestIsWrongDirection ? "; de huidige kandidaat is een andere factuur."');
    expect(bankPage).toContain('"; er is momenteel geen geschikte andere factuurkandidaat."');
  });

  it("explains the scope of a successful rejection without claiming all suggestions disappear", () => {
    expect(bankPage).toContain('title: "Afwijzing opgeslagen"');
    expect(bankPage).toContain("Een andere factuur kan nog wel als suggestie verschijnen.");
  });
});
