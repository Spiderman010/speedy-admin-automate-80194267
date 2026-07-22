import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import {
  usePaginatedPurchaseInvoices,
  useResetPageOnChange,
  sanitizeSearchTerm,
  PURCHASE_INVOICES_PAGE_SIZE,
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
  query.select = chain("select");
  query.eq = chain("eq");
  query.or = chain("or");
  query.order = chain("order");
  query.range = vi.fn((...args: unknown[]) => {
    state.calls.push({ method: "range", args });
    return Promise.resolve(state.response);
  });
  return query;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => makeQueryMock()),
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const callsFor = (method: string) => state.calls.filter(c => c.method === method);

beforeEach(() => {
  state.calls = [];
  state.response = { data: [], error: null, count: 0 };
});

describe("usePaginatedPurchaseInvoices", () => {
  it("requests the first page as range(0, 49) with exact count", async () => {
    state.response = {
      data: [{ id: "inv-1" }, { id: "inv-2" }],
      error: null,
      count: 120,
    };
    const { result } = renderHook(
      () => usePaginatedPurchaseInvoices({ organizationId: "org-1", page: 1 }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(callsFor("select")[0].args).toEqual(["*", { count: "exact" }]);
    expect(callsFor("range")[0].args).toEqual([0, PURCHASE_INVOICES_PAGE_SIZE - 1]);
    expect(result.current.data?.invoices).toHaveLength(2);
  });

  it("requests the second page as range(50, 99)", async () => {
    const { result } = renderHook(
      () => usePaginatedPurchaseInvoices({ organizationId: "org-1", page: 2 }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(callsFor("range")[0].args).toEqual([
      PURCHASE_INVOICES_PAGE_SIZE,
      2 * PURCHASE_INVOICES_PAGE_SIZE - 1,
    ]);
  });

  it("exposes the exact total count independent of page size", async () => {
    state.response = { data: [{ id: "inv-1" }], error: null, count: 731 };
    const { result } = renderHook(
      () => usePaginatedPurchaseInvoices({ organizationId: "org-1", page: 1 }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.total).toBe(731);
  });

  it("applies status, route, search and sorting server-side", async () => {
    const { result } = renderHook(
      () =>
        usePaginatedPurchaseInvoices({
          organizationId: "org-1",
          clientId: "client-1",
          page: 1,
          status: "te_controleren",
          documentRoute: "pdf_route",
          search: "vodafone",
          sortField: "amount",
          sortDir: "asc",
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const eqCalls = callsFor("eq").map(c => c.args);
    expect(eqCalls).toContainEqual(["organization_id", "org-1"]);
    expect(eqCalls).toContainEqual(["client_id", "client-1"]);
    expect(eqCalls).toContainEqual(["status", "te_controleren"]);
    expect(eqCalls).toContainEqual(["document_route", "pdf_route"]);

    const orCall = callsFor("or")[0].args[0] as string;
    expect(orCall).toContain("supplier.ilike.%vodafone%");
    expect(orCall).toContain("invoice_number.ilike.%vodafone%");
    expect(orCall).toContain("ledger_account_text.ilike.%vodafone%");

    const orderCalls = callsFor("order").map(c => c.args);
    expect(orderCalls[0]).toEqual(["amount_incl", { ascending: true, nullsFirst: false }]);
  });

  it('skips the eq filters when status and route are "all" and search is empty', async () => {
    const { result } = renderHook(
      () =>
        usePaginatedPurchaseInvoices({
          organizationId: "org-1",
          page: 1,
          status: "all",
          documentRoute: "all",
          search: "",
        }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const eqCalls = callsFor("eq").map(c => c.args.map(String));
    expect(eqCalls.some(a => a[0] === "status")).toBe(false);
    expect(eqCalls.some(a => a[0] === "document_route")).toBe(false);
    expect(callsFor("or")).toHaveLength(0);
  });
});

describe("sanitizeSearchTerm", () => {
  it("strips or()-breaking characters and escapes ilike wildcards", () => {
    expect(sanitizeSearchTerm("  ACME, B.V. (Noord) ")).toBe("ACME B.V. Noord");
    expect(sanitizeSearchTerm("100%_zeker")).toBe("100\\%\\_zeker");
  });
});

describe("useResetPageOnChange", () => {
  it("does not reset on mount, resets when a dependency changes", () => {
    const reset = vi.fn();
    const { rerender } = renderHook(
      ({ deps }: { deps: unknown[] }) => useResetPageOnChange(reset, deps),
      { initialProps: { deps: ["zoekterm", "all"] } },
    );
    expect(reset).not.toHaveBeenCalled();

    rerender({ deps: ["zoekterm", "all"] });
    expect(reset).not.toHaveBeenCalled();

    rerender({ deps: ["andere zoekterm", "all"] });
    expect(reset).toHaveBeenCalledTimes(1);

    rerender({ deps: ["andere zoekterm", "concept"] });
    expect(reset).toHaveBeenCalledTimes(2);
  });
});
