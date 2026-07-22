import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import {
  usePaginatedSalesInvoices,
  fetchAllSalesInvoices,
  fetchSalesDuplicateCandidates,
  computeSalesDuplicateIds,
  computeReceivablesSummary,
  salesSanitizeSearchTerm,
  SALES_INVOICES_PAGE_SIZE,
  SALES_FETCH_BATCH_SIZE,
  SALES_DUPLICATE_LOOKUP_BATCH_SIZE,
  type SalesDuplicateCandidate,
} from "@/hooks/useSalesInvoices";

type QueryCall = { method: string; args: unknown[] };

const state = {
  calls: [] as QueryCall[],
  response: { data: [] as unknown[], error: null as unknown, count: 0 },
  batchResponses: [] as Array<{ data: unknown[]; error: unknown }>,
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
  query.or = chain("or");
  query.order = chain("order");
  query.range = vi.fn((...args: unknown[]) => {
    state.calls.push({ method: "range", args });
    if (state.batchResponses.length) return Promise.resolve(state.batchResponses.shift());
    return Promise.resolve(state.response);
  });
  (query as { then?: unknown }).then = (
    onFulfilled: (v: { data: unknown[]; error: unknown }) => unknown,
  ) => Promise.resolve(state.batchResponses.shift() ?? { data: [], error: null }).then(onFulfilled);
  return query;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(() => makeQueryMock()) },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1" }),
}));

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const callsFor = (m: string) => state.calls.filter(c => c.method === m);

beforeEach(() => {
  state.calls = [];
  state.response = { data: [], error: null, count: 0 };
  state.batchResponses = [];
});

describe("usePaginatedSalesInvoices", () => {
  it("requests the first page as range(0, 49) with exact count and org scoping", async () => {
    state.response = { data: [{ id: "s1" }], error: null, count: 812 };
    const { result } = renderHook(
      () => usePaginatedSalesInvoices({ page: 1 }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(callsFor("select")[0].args).toEqual(["*", { count: "exact" }]);
    expect(callsFor("eq").map(c => c.args)).toContainEqual(["organization_id", "org-1"]);
    expect(callsFor("range")[0].args).toEqual([0, SALES_INVOICES_PAGE_SIZE - 1]);
    expect(result.current.data?.total).toBe(812);
  });

  it("requests the second page as range(50, 99)", async () => {
    const { result } = renderHook(
      () => usePaginatedSalesInvoices({ page: 2 }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsFor("range")[0].args).toEqual([
      SALES_INVOICES_PAGE_SIZE,
      2 * SALES_INVOICES_PAGE_SIZE - 1,
    ]);
  });

  it("applies client, status, search and sorting server-side", async () => {
    const { result } = renderHook(
      () =>
        usePaginatedSalesInvoices({
          clientId: "client-1",
          page: 1,
          status: "concept",
          search: "F-2026",
          sortField: "amount",
          sortDir: "asc",
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const eqCalls = callsFor("eq").map(c => c.args);
    expect(eqCalls).toContainEqual(["client_id", "client-1"]);
    expect(eqCalls).toContainEqual(["status", "concept"]);

    const orCall = callsFor("or")[0].args[0] as string;
    expect(orCall).toContain("invoice_number.ilike.%F-2026%");
    expect(orCall).toContain("customer_name.ilike.%F-2026%");
    expect(orCall).toContain("status.ilike.%F-2026%");

    expect(callsFor("order")[0].args).toEqual(["amount_incl", { ascending: true, nullsFirst: false }]);
    expect(callsFor("order")[1].args).toEqual(["id", { ascending: true }]);
  });
});

describe("fetchAllSalesInvoices", () => {
  it("fetches more than 1000 rows in deterministic batches ordered invoice_date DESC, id ASC", async () => {
    state.batchResponses = [
      { data: Array.from({ length: 1000 }, (_, i) => ({ id: `s-${i}` })), error: null },
      { data: Array.from({ length: 1000 }, (_, i) => ({ id: `s-${1000 + i}` })), error: null },
      { data: Array.from({ length: 120 }, (_, i) => ({ id: `s-${2000 + i}` })), error: null },
    ];
    const result = await fetchAllSalesInvoices({ organizationId: "org-1" });

    expect(result).toHaveLength(2120);
    expect(callsFor("range").map(c => c.args)).toEqual([
      [0, SALES_FETCH_BATCH_SIZE - 1],
      [SALES_FETCH_BATCH_SIZE, 2 * SALES_FETCH_BATCH_SIZE - 1],
      [2 * SALES_FETCH_BATCH_SIZE, 3 * SALES_FETCH_BATCH_SIZE - 1],
    ]);
    // every batch: invoice_date DESC then id ASC
    expect(callsFor("order").map(c => c.args)).toEqual([
      ["invoice_date", { ascending: false }], ["id", { ascending: true }],
      ["invoice_date", { ascending: false }], ["id", { ascending: true }],
      ["invoice_date", { ascending: false }], ["id", { ascending: true }],
    ]);
  });

  it("refuses to run without an organizationId", async () => {
    await expect(fetchAllSalesInvoices({ organizationId: "" })).rejects.toThrow(/organisatie/i);
    expect(callsFor("range")).toHaveLength(0);
  });

  it("applies the status scope server-side when given", async () => {
    state.batchResponses = [{ data: [], error: null }];
    await fetchAllSalesInvoices({ organizationId: "org-1", statuses: ["gecontroleerd", "betaald"] });
    expect(callsFor("in").map(c => c.args)).toContainEqual(["status", ["gecontroleerd", "betaald"]]);
  });
});

describe("duplicates across pages", () => {
  const pageInv: SalesDuplicateCandidate = {
    id: "s-page", customer_name: "Acme B.V.", invoice_number: "VF-001",
  };

  it("detects a duplicate on another page", async () => {
    state.batchResponses = [
      { data: [pageInv, { id: "s-elders", customer_name: "acme b.v. ", invoice_number: " VF-001" }], error: null },
    ];
    const candidates = await fetchSalesDuplicateCandidates([pageInv], { organizationId: "org-1" });
    const ids = computeSalesDuplicateIds(candidates);
    expect(ids.has("s-page")).toBe(true);
    expect(ids.has("s-elders")).toBe(true);
  });

  it("queries minimal columns in batches of 25", async () => {
    const many = Array.from({ length: SALES_DUPLICATE_LOOKUP_BATCH_SIZE + 3 }, (_, i) => ({
      id: `s-${i}`, customer_name: "K", invoice_number: `VF-${i}`,
    }));
    state.batchResponses = [
      { data: [], error: null },
      { data: [], error: null },
    ];
    await fetchSalesDuplicateCandidates(many, { organizationId: "org-1" });

    expect(callsFor("select")[0].args[0]).toBe("id, customer_name, invoice_number");
    const numberBatches = callsFor("in").filter(c => c.args[0] === "invoice_number");
    expect(numberBatches).toHaveLength(2);
    expect((numberBatches[0].args[1] as string[]).length).toBe(SALES_DUPLICATE_LOOKUP_BATCH_SIZE);
  });
});

describe("computeReceivablesSummary", () => {
  it("classifies paid, partial and open and sums the open total", () => {
    const summary = computeReceivablesSummary([
      { id: "1", status: "betaald", amount_excl: 100, amount_incl: 121, remaining_amount: 121 },
      { id: "2", status: "verzonden", amount_excl: 100, amount_incl: 121, remaining_amount: 0 },
      { id: "3", status: "verzonden", amount_excl: 100, amount_incl: 121, remaining_amount: 60 },
      { id: "4", status: "concept", amount_excl: 100, amount_incl: 121, remaining_amount: null },
    ]);
    expect(summary.countPaid).toBe(2);      // betaald + remaining 0
    expect(summary.countPartial).toBe(1);   // 60 of 121
    expect(summary.countOpen).toBe(1);      // null remaining -> full total open
    expect(summary.openTotal).toBe(60 + 121);
    expect(summary.totalInvoices).toBe(4);
  });
});

describe("helpers", () => {
  it("salesSanitizeSearchTerm strips or()-breakers and escapes wildcards", () => {
    expect(salesSanitizeSearchTerm(" A,B (C) ")).toBe("A B C");
    expect(salesSanitizeSearchTerm("100%_x")).toBe("100\\%\\_x");
  });
});

describe("Verkoop overview source guarantees", () => {
  const source = readFileSync(resolve(process.cwd(), "src/pages/Verkoop.tsx"), "utf-8");

  it("performs no full-list query on mount: only the paginated hook is called", () => {
    expect(source).not.toMatch(/\buseSalesInvoices\(/);
    expect(source).toMatch(/usePaginatedSalesInvoices\(/);
    // the batched full fetch runs only inside the export click handler
    expect(source).toMatch(/onClick=\{async \(\) => \{[\s\S]*?fetchAllSalesInvoices/);
  });

  it("wires the pager, page reset and org guard", () => {
    expect(source).toContain("van {totalCount} verkoopfacturen");
    expect(source).toContain("setPage(1)");
    const guardIdx = source.indexOf("if (!activeOrganizationId)");
    // the call site (not the import) must come after the org guard
    const callIdx = source.indexOf("await fetchAllSalesInvoices(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(guardIdx);
  });

  it("no longer offers client or status as sortable columns", () => {
    expect(source).not.toContain('toggleSort("client")');
    expect(source).not.toContain('toggleSort("status")');
    expect(source).toMatch(/type SortField = "invoice_number" \| "customer_name" \| "date" \| "due_date" \| "amount" \| "btw";/);
  });

  it("shows no page-scoped chip counts", () => {
    expect(source).not.toContain("forPaymentCounts");
    expect(source).not.toContain("forWorkflowCounts");
  });
});
