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
  escapeIlikeValue,
  buildIlikeOrFilter,
  searchCacheKey,
  clampPage,
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
    // literal-safe, double-quoted ilike values
    expect(orCall).toContain('invoice_number.ilike."%F-2026%"');
    expect(orCall).toContain('customer_name.ilike."%F-2026%"');
    expect(orCall).toContain('status.ilike."%F-2026%"');

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

  it("detects a normalized duplicate on another page (whitespace + casing)", async () => {
    state.batchResponses = [
      { data: [pageInv, { id: "s-elders", customer_name: "acme b.v. ", invoice_number: " vf-001 " }], error: null },
    ];
    const candidates = await fetchSalesDuplicateCandidates([pageInv], { organizationId: "org-1" });
    const ids = computeSalesDuplicateIds(candidates);
    expect(ids.has("s-page")).toBe(true);
    expect(ids.has("s-elders")).toBe(true);
  });

  it("uses a case-insensitive ilike net (not exact .in) and org/client scoping, minimal columns", async () => {
    state.batchResponses = [{ data: [], error: null }];
    await fetchSalesDuplicateCandidates([pageInv], { organizationId: "org-1", clientId: "client-1" });

    // no exact .in on invoice_number — it would miss " vf-001 " / casing
    expect(callsFor("in").some(c => c.args[0] === "invoice_number")).toBe(false);
    // minimal columns
    expect(callsFor("select")[0].args[0]).toBe("id, customer_name, invoice_number");
    // org + client scoping preserved
    const eqCalls = callsFor("eq").map(c => c.args);
    expect(eqCalls).toContainEqual(["organization_id", "org-1"]);
    expect(eqCalls).toContainEqual(["client_id", "client-1"]);
    // ilike or() net for the page's number
    const orArg = callsFor("or")[0].args[0] as string;
    expect(orArg).toContain('invoice_number.ilike."%VF-001%"');
  });

  it("discards over-matches via the final normalized check (VF-0011 ≠ VF-001)", () => {
    // the broad ilike net may return VF-0011; the exact normalized compare drops it
    const ids = computeSalesDuplicateIds([
      { id: "a", customer_name: "Acme", invoice_number: "VF-001" },
      { id: "b", customer_name: "Acme", invoice_number: "VF-0011" },
    ]);
    expect(ids.size).toBe(0);
  });

  it("splits large pages into ilike batches of 25", async () => {
    const many = Array.from({ length: SALES_DUPLICATE_LOOKUP_BATCH_SIZE + 3 }, (_, i) => ({
      id: `s-${i}`, customer_name: "K", invoice_number: `VF-${i}`,
    }));
    state.batchResponses = [
      { data: [], error: null },
      { data: [], error: null },
    ];
    await fetchSalesDuplicateCandidates(many, { organizationId: "org-1" });

    const orCalls = callsFor("or");
    expect(orCalls).toHaveLength(2);
    // first batch packs 25 ilike terms
    expect((orCalls[0].args[0] as string).split("invoice_number.ilike.").length - 1).toBe(SALES_DUPLICATE_LOOKUP_BATCH_SIZE);
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

describe("literal search escaping", () => {
  it("preserves apostrophes literally (O'Reilly)", () => {
    expect(escapeIlikeValue("O'Reilly")).toBe('"%O\'Reilly%"');
    expect(buildIlikeOrFilter(["customer_name"], "O'Reilly")).toBe('customer_name.ilike."%O\'Reilly%"');
  });

  it("preserves commas by quoting (ACME, BV)", () => {
    expect(escapeIlikeValue("ACME, BV")).toBe('"%ACME, BV%"');
    const filter = buildIlikeOrFilter(["invoice_number", "customer_name"], "ACME, BV");
    expect(filter).toBe('invoice_number.ilike."%ACME, BV%",customer_name.ilike."%ACME, BV%"');
  });

  it("preserves parentheses literally", () => {
    expect(escapeIlikeValue("(net)")).toBe('"%(net)%"');
  });

  it("escapes LIKE wildcards % and _ so they match literally", () => {
    expect(escapeIlikeValue("50%")).toBe('"%50\\%%"');
    expect(escapeIlikeValue("a_b")).toBe('"%a\\_b%"');
  });

  it("escapes embedded backslashes and double quotes", () => {
    expect(escapeIlikeValue('a\\b"c')).toBe('"%a\\\\b\\"c%"');
  });

  it("returns an empty filter for blank input", () => {
    expect(buildIlikeOrFilter(["customer_name"], "   ")).toBe("");
  });

  it("searchCacheKey trims only the ends and preserves internal whitespace + punctuation", () => {
    // leading/trailing trimmed, internal spacing kept exactly
    expect(searchCacheKey("  ACME,  BV  ")).toBe("ACME,  BV");
    expect(searchCacheKey("O'Reilly (x)")).toBe("O'Reilly (x)");
  });

  it("searchCacheKey distinguishes single vs double internal spaces (matches backend term)", () => {
    const single = searchCacheKey("ACME BV");
    const doubled = searchCacheKey("ACME  BV");
    expect(single).toBe("ACME BV");
    expect(doubled).toBe("ACME  BV");
    expect(single).not.toBe(doubled);
    // and each key equals exactly the trimmed term applySearch/buildIlikeOrFilter sends
    expect(single).toBe("ACME BV".trim());
    expect(doubled).toBe("ACME  BV".trim());
  });
});

describe("search cache-key isolation (hook-level)", () => {
  it("dedupes an identical search but issues a new query when only internal whitespace changes", async () => {
    // staleTime: Infinity ⇒ an identical query key would NOT refetch, so any
    // extra backend call proves the key actually differs.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const a = renderHook(
      () => usePaginatedSalesInvoices({ page: 1, search: "ACME BV" }),
      { wrapper },
    );
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    const afterFirst = callsFor("range").length;

    // same term again → identical key → served from cache, no new backend query
    const same = renderHook(
      () => usePaginatedSalesInvoices({ page: 1, search: "ACME BV" }),
      { wrapper },
    );
    await waitFor(() => expect(same.result.current.isSuccess).toBe(true));
    expect(callsFor("range").length).toBe(afterFirst);

    // only internal whitespace changed → distinct key → a new backend query
    const b = renderHook(
      () => usePaginatedSalesInvoices({ page: 1, search: "ACME  BV" }),
      { wrapper },
    );
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));
    expect(callsFor("range").length).toBe(afterFirst + 1);

    // and the two backend searches carried the exact (different) ilike values
    const orValues = callsFor("or").map(c => c.args[0] as string);
    expect(orValues.some(v => v.includes('"%ACME BV%"'))).toBe(true);
    expect(orValues.some(v => v.includes('"%ACME  BV%"'))).toBe(true);
  });
});

describe("clampPage", () => {
  it("keeps a valid page unchanged", () => {
    expect(clampPage(2, 5)).toBe(2);
  });

  it("moves to the final page when the count shrinks (delete only row on last page)", () => {
    // was on page 3 (rows 101–150); the only row there is deleted → 100 rows → 2 pages
    const totalPagesAfterDelete = Math.max(1, Math.ceil(100 / SALES_INVOICES_PAGE_SIZE));
    expect(clampPage(3, totalPagesAfterDelete)).toBe(2);
  });

  it("never goes below 1", () => {
    expect(clampPage(3, 0)).toBe(1);
    expect(clampPage(0, 5)).toBe(1);
  });
});

describe("useSalesInvoices gating (Bank consumer)", () => {
  it("does not query when disabled (empty selection)", async () => {
    const { useSalesInvoices } = await import("@/hooks/useSalesInvoices");
    const { result } = renderHook(
      () => useSalesInvoices({ enabled: false }),
      { wrapper: createWrapper() },
    );
    // give react-query a tick; the query must stay idle
    await new Promise(r => setTimeout(r, 10));
    expect(result.current.fetchStatus).toBe("idle");
    expect(callsFor("range")).toHaveLength(0);
  });

  it("returns no rows for an empty client subset without querying", async () => {
    const rows = await fetchAllSalesInvoices({ organizationId: "org-1", clientIds: [] });
    expect(rows).toEqual([]);
    expect(callsFor("range")).toHaveLength(0);
  });

  it("scopes to a client subset server-side via .in(client_id)", async () => {
    state.batchResponses = [{ data: [], error: null }];
    await fetchAllSalesInvoices({ organizationId: "org-1", clientIds: ["c1", "c2"] });
    expect(callsFor("in").map(c => c.args)).toContainEqual(["client_id", ["c1", "c2"]]);
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

  it("clamps the page when the total shrinks", () => {
    expect(source).toContain("clampPage(p, totalPages)");
  });

  it("does not force knownDuplicate=false while the duplicate set is loading", () => {
    // must pass undefined (not false) when duplicateIds is not yet available
    expect(source).toContain("editInvoice && duplicateIds ? duplicateIds.has(editInvoice.id) : undefined");
  });
});

describe("Bank consumer source guarantee", () => {
  const source = readFileSync(resolve(process.cwd(), "src/pages/Bank.tsx"), "utf-8");
  it("gates useSalesInvoices on selection with client scoping", () => {
    expect(source).toMatch(/useSalesInvoices\(\{[\s\S]*?clientId: singleClientId,[\s\S]*?clientIds: singleClientId \? undefined : clientIdsForQuery,[\s\S]*?enabled: orgEnabled && hasSelection,[\s\S]*?\}\)/);
    // no bare unbounded call remains
    expect(source).not.toContain("useSalesInvoices();");
  });
});
