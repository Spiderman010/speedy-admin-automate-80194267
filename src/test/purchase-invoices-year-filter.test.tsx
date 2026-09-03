import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import {
  usePaginatedPurchaseInvoices,
  fetchAllExportablePurchaseInvoices,
  buildYearOptions,
  getYearDateRange,
  useResetPageOnChange,
  EXPORT_BATCH_SIZE,
} from "@/hooks/usePurchaseInvoices";

type QueryCall = { method: string; args: unknown[] };

const state = {
  calls: [] as QueryCall[],
  response: { data: [] as unknown[], error: null as unknown, count: 0 },
};

function makeQueryMock() {
  const query: Record<string, unknown> = {};
  const chain = (method: string) =>
    vi.fn((...args: unknown[]) => {
      state.calls.push({ method, args });
      return query;
    });
  for (const m of ["select", "eq", "or", "order", "in", "gte", "lt"]) query[m] = chain(m);
  query.range = vi.fn((...args: unknown[]) => {
    state.calls.push({ method: "range", args });
    return Promise.resolve(state.response);
  });
  return query;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(() => makeQueryMock()) },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const callsFor = (method: string) => state.calls.filter(c => c.method === method);

beforeEach(() => {
  state.calls = [];
  state.response = { data: [], error: null, count: 0 };
});

describe("buildYearOptions", () => {
  it("generates the current year plus the previous nine years dynamically", () => {
    expect(buildYearOptions(2026)).toEqual([2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017]);
    expect(buildYearOptions(2030)[0]).toBe(2030);
    expect(buildYearOptions()).toHaveLength(10);
    expect(buildYearOptions()[0]).toBe(new Date().getFullYear());
  });
});

describe("getYearDateRange", () => {
  it("returns a half-open interval per year", () => {
    expect(getYearDateRange(2025)).toEqual({ from: "2025-01-01", to: "2026-01-01" });
    expect(getYearDateRange(2026)).toEqual({ from: "2026-01-01", to: "2027-01-01" });
  });
  it("returns null for 'all' and undefined", () => {
    expect(getYearDateRange("all")).toBeNull();
    expect(getYearDateRange(undefined)).toBeNull();
  });
});

describe("usePaginatedPurchaseInvoices year filter", () => {
  it("adds no invoice_date filter by default (all years)", async () => {
    const { result } = renderHook(
      () => usePaginatedPurchaseInvoices({ organizationId: "org-1", page: 1 }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsFor("gte")).toHaveLength(0);
    expect(callsFor("lt")).toHaveLength(0);
  });

  it("filters invoice_date >= 2025-01-01 and < 2026-01-01 for year 2025", async () => {
    const { result } = renderHook(
      () => usePaginatedPurchaseInvoices({ organizationId: "org-1", page: 1, year: 2025 }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsFor("gte")[0].args).toEqual(["invoice_date", "2025-01-01"]);
    expect(callsFor("lt")[0].args).toEqual(["invoice_date", "2026-01-01"]);
  });

  it("filters 2026 as >= 2026-01-01 and < 2027-01-01", async () => {
    const { result } = renderHook(
      () => usePaginatedPurchaseInvoices({ organizationId: "org-1", page: 1, year: 2026 }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsFor("gte")[0].args).toEqual(["invoice_date", "2026-01-01"]);
    expect(callsFor("lt")[0].args).toEqual(["invoice_date", "2027-01-01"]);
  });

  it("combines client, workflow status, route, search, sorting and pagination with the year", async () => {
    state.response = { data: [{ id: "inv-1" }], error: null, count: 84 };
    const { result } = renderHook(
      () =>
        usePaginatedPurchaseInvoices({
          organizationId: "org-1",
          clientId: "client-1",
          page: 2,
          year: 2025,
          status: "gecontroleerd",
          documentRoute: "pdf_route",
          search: "KPN",
          sortField: "amount",
          sortDir: "asc",
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const eqCalls = callsFor("eq").map(c => c.args);
    expect(eqCalls).toContainEqual(["organization_id", "org-1"]);
    expect(eqCalls).toContainEqual(["client_id", "client-1"]);
    expect(eqCalls).toContainEqual(["status", "gecontroleerd"]);
    expect(eqCalls).toContainEqual(["document_route", "pdf_route"]);
    expect(callsFor("gte")[0].args).toEqual(["invoice_date", "2025-01-01"]);
    expect(callsFor("or")[0].args[0]).toContain("supplier.ilike.%KPN%");
    expect(callsFor("order")[0].args).toEqual(["amount_incl", { ascending: true, nullsFirst: false }]);
    expect(callsFor("range")[0].args).toEqual([50, 99]);
    // Total count comes from the server query, not from client-side slicing.
    expect(result.current.data?.total).toBe(84);
    expect(result.current.data?.invoices).toHaveLength(1);
  });

  it("does not slice results client-side by year", async () => {
    // invoice_date 2025 but created_at 2026 — the server filter decides, the hook returns rows as-is.
    state.response = {
      data: [{ id: "inv-1", invoice_date: "2025-12-18", created_at: "2026-01-09T10:00:00Z" }],
      error: null,
      count: 1,
    };
    const { result } = renderHook(
      () => usePaginatedPurchaseInvoices({ organizationId: "org-1", page: 1, year: 2025 }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.invoices).toHaveLength(1);
  });
});

describe("useResetPageOnChange with the year dependency", () => {
  it("resets to page 1 when the selected year changes", () => {
    const reset = vi.fn();
    const { rerender } = renderHook(
      ({ deps }: { deps: unknown[] }) => useResetPageOnChange(reset, deps),
      { initialProps: { deps: ["all"] as unknown[] } },
    );
    expect(reset).not.toHaveBeenCalled();
    rerender({ deps: [2025] });
    expect(reset).toHaveBeenCalledTimes(1);
    rerender({ deps: [2025] });
    expect(reset).toHaveBeenCalledTimes(1);
    rerender({ deps: ["all"] });
    expect(reset).toHaveBeenCalledTimes(2);
  });
});

describe("fetchAllExportablePurchaseInvoices year scope", () => {
  it("keeps existing behaviour without a year", async () => {
    await fetchAllExportablePurchaseInvoices({ organizationId: "org-1" });
    expect(callsFor("gte")).toHaveLength(0);
    expect(callsFor("in")[0].args).toEqual(["status", ["gecontroleerd", "betaald"]]);
    expect(callsFor("range")[0].args).toEqual([0, EXPORT_BATCH_SIZE - 1]);
  });

  it("scopes the export to the selected year", async () => {
    await fetchAllExportablePurchaseInvoices({ organizationId: "org-1", year: 2025 });
    expect(callsFor("gte")[0].args).toEqual(["invoice_date", "2025-01-01"]);
    expect(callsFor("lt")[0].args).toEqual(["invoice_date", "2026-01-01"]);
  });

  it("combines client and year in the export scope", async () => {
    await fetchAllExportablePurchaseInvoices({ organizationId: "org-1", clientId: "client-a", year: 2025 });
    const eqCalls = callsFor("eq").map(c => c.args);
    expect(eqCalls).toContainEqual(["client_id", "client-a"]);
    expect(callsFor("gte")[0].args).toEqual(["invoice_date", "2025-01-01"]);
    expect(callsFor("lt")[0].args).toEqual(["invoice_date", "2026-01-01"]);
  });

  it("ignores the year filter when 'all' is selected", async () => {
    await fetchAllExportablePurchaseInvoices({ organizationId: "org-1", year: "all" });
    expect(callsFor("gte")).toHaveLength(0);
  });
});
