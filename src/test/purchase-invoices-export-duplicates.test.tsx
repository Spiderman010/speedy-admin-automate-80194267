import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fetchAllExportablePurchaseInvoices,
  fetchPurchaseInvoiceDuplicateCandidates,
  computeDuplicateIds,
  EXPORT_BATCH_SIZE,
  DUPLICATE_LOOKUP_BATCH_SIZE,
  type DuplicateCandidate,
} from "@/hooks/usePurchaseInvoices";

type QueryCall = { method: string; args: unknown[] };

const state = {
  calls: [] as QueryCall[],
  // one response per executed query, consumed in order
  responses: [] as Array<{ data: unknown[]; error: unknown }>,
};

function makeQueryMock() {
  const query: Record<string, unknown> = {};
  const chain = (method: string) =>
    vi.fn((...args: unknown[]) => {
      state.calls.push({ method, args });
      return query;
    });
  query.select = chain("select");
  query.eq = chain("eq");
  query.in = chain("in");
  query.order = chain("order");
  query.range = vi.fn((...args: unknown[]) => {
    state.calls.push({ method: "range", args });
    return Promise.resolve(state.responses.shift() ?? { data: [], error: null });
  });
  // duplicate-candidate queries resolve without .range(): make the builder thenable
  (query as { then?: unknown }).then = (
    onFulfilled: (v: { data: unknown[]; error: unknown }) => unknown,
  ) => Promise.resolve(state.responses.shift() ?? { data: [], error: null }).then(onFulfilled);
  return query;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => makeQueryMock()),
  },
}));

const callsFor = (method: string) => state.calls.filter(c => c.method === method);

beforeEach(() => {
  state.calls = [];
  state.responses = [];
});

const invoiceRow = (id: number) => ({ id: `inv-${id}`, status: "gecontroleerd" });

describe("fetchAllExportablePurchaseInvoices", () => {
  it("fetches more than 1000 rows in deterministic id-ordered batches until exhausted", async () => {
    state.responses = [
      { data: Array.from({ length: 1000 }, (_, i) => invoiceRow(i)), error: null },
      { data: Array.from({ length: 1000 }, (_, i) => invoiceRow(1000 + i)), error: null },
      { data: Array.from({ length: 300 }, (_, i) => invoiceRow(2000 + i)), error: null },
    ];

    const result = await fetchAllExportablePurchaseInvoices({ organizationId: "org-1" });

    expect(result).toHaveLength(2300);
    expect(callsFor("range").map(c => c.args)).toEqual([
      [0, EXPORT_BATCH_SIZE - 1],
      [EXPORT_BATCH_SIZE, 2 * EXPORT_BATCH_SIZE - 1],
      [2 * EXPORT_BATCH_SIZE, 3 * EXPORT_BATCH_SIZE - 1],
    ]);
    // deterministic ordering + status scoping applied on every batch
    const orderCalls = callsFor("order").map(c => c.args);
    expect(orderCalls).toHaveLength(3);
    orderCalls.forEach(args => expect(args).toEqual(["id", { ascending: true }]));
    const inCalls = callsFor("in").map(c => c.args);
    inCalls.forEach(args => expect(args).toEqual(["status", ["gecontroleerd", "betaald"]]));
  });

  it("stops after one batch when fewer rows than the batch size are returned", async () => {
    state.responses = [{ data: [invoiceRow(1), invoiceRow(2)], error: null }];
    const result = await fetchAllExportablePurchaseInvoices({});
    expect(result).toHaveLength(2);
    expect(callsFor("range")).toHaveLength(1);
  });
});

describe("duplicate detection across pages", () => {
  const pageInvoice: DuplicateCandidate = {
    id: "inv-page",
    client_id: "client-1",
    invoice_number: "F-2026-001",
    supplier: "Acme B.V.",
    supplier_btw_number: null,
    leverancier_id: null,
  };

  it("detects a duplicate that lives on another page", async () => {
    const offPageDuplicate: DuplicateCandidate = {
      ...pageInvoice,
      id: "inv-elsewhere",
    };
    state.responses = [{ data: [pageInvoice, offPageDuplicate], error: null }];

    const candidates = await fetchPurchaseInvoiceDuplicateCandidates([pageInvoice], {
      organizationId: "org-1",
    });
    const ids = computeDuplicateIds(candidates);

    expect(ids.has("inv-page")).toBe(true);
    expect(ids.has("inv-elsewhere")).toBe(true);
  });

  it("queries only the required columns, scoped to page invoice numbers and clients", async () => {
    state.responses = [{ data: [], error: null }];
    await fetchPurchaseInvoiceDuplicateCandidates([pageInvoice], { organizationId: "org-1" });

    expect(callsFor("select")[0].args[0]).toBe(
      "id, client_id, invoice_number, supplier, supplier_btw_number, leverancier_id",
    );
    const inCalls = callsFor("in").map(c => c.args);
    expect(inCalls).toContainEqual(["invoice_number", ["F-2026-001"]]);
    expect(inCalls).toContainEqual(["client_id", ["client-1"]]);
    expect(callsFor("eq").map(c => c.args)).toContainEqual(["organization_id", "org-1"]);
  });

  it("splits large pages into lookup batches", async () => {
    const many = Array.from({ length: DUPLICATE_LOOKUP_BATCH_SIZE + 5 }, (_, i) => ({
      ...pageInvoice,
      id: `inv-${i}`,
      invoice_number: `F-${i}`,
    }));
    state.responses = [
      { data: [], error: null },
      { data: [], error: null },
    ];
    await fetchPurchaseInvoiceDuplicateCandidates(many, {});

    const numberBatches = callsFor("in").filter(c => c.args[0] === "invoice_number");
    expect(numberBatches).toHaveLength(2);
    expect((numberBatches[0].args[1] as string[]).length).toBe(DUPLICATE_LOOKUP_BATCH_SIZE);
    expect((numberBatches[1].args[1] as string[]).length).toBe(5);
  });

  it("does not flag distinct suppliers with the same invoice number", () => {
    const other: DuplicateCandidate = {
      id: "inv-other",
      client_id: "client-1",
      invoice_number: "F-2026-001",
      supplier: "Totally Different Corp",
      supplier_btw_number: "NL999999999B99",
      leverancier_id: null,
    };
    const withBtw = { ...pageInvoice, supplier_btw_number: "NL111111111B11" };
    const ids = computeDuplicateIds([withBtw, other]);
    expect(ids.size).toBe(0);
  });
});

describe("Facturen overview source guarantees", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/pages/Facturen.tsx"),
    "utf-8",
  );
  const hookSource = readFileSync(
    resolve(process.cwd(), "src/hooks/usePurchaseInvoices.ts"),
    "utf-8",
  );

  it("mounts without a full-list query: only the paginated hook is called", () => {
    // No call site of the unpaginated hook may remain (the word only appears
    // in the import path / derived hook names).
    expect(source).not.toMatch(/\busePurchaseInvoices\(/);
    expect(source).toMatch(/usePaginatedPurchaseInvoices\(/);
    // The batched full fetch may only run from the export click handler.
    expect(source).toMatch(/onClick=\{async \(\) => \{[\s\S]*?fetchAllExportablePurchaseInvoices/);
  });

  it("no longer offers status as a sortable column", () => {
    expect(source).not.toContain('toggleSort("status")');
    expect(source).not.toContain('SortIcon field="status"');
    expect(source).toMatch(/type SortField = "supplier" \| "invoice_number" \| "date" \| "amount" \| "btw";/);
    expect(hookSource).toMatch(/PurchaseInvoiceSortField = "supplier" \| "invoice_number" \| "date" \| "amount" \| "btw";/);
    expect(hookSource).not.toMatch(/status:\s*"status"/);
  });

  it("shows no per-page chip counts", () => {
    expect(source).not.toContain("forPaymentCounts");
    expect(source).not.toContain("forWorkflowCounts");
    expect(source).not.toContain("forRouteCounts");
  });
});
