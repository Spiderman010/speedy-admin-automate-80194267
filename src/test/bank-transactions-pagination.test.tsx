import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import {
  usePaginatedBankTransactions,
  fetchAllBankTransactions,
  bankSanitizeSearchTerm,
  isServerFilterableBankStatus,
  BANK_TRANSACTIONS_PAGE_SIZE,
  BANK_FETCH_BATCH_SIZE,
} from "@/hooks/useBankTransactions";

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
    if (state.batchResponses.length) {
      return Promise.resolve(state.batchResponses.shift());
    }
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

const callsFor = (m: string) => state.calls.filter(c => c.method === m);

beforeEach(() => {
  state.calls = [];
  state.response = { data: [], error: null, count: 0 };
  state.batchResponses = [];
});

describe("usePaginatedBankTransactions", () => {
  it("requests the first page as range(0, 49) with exact count", async () => {
    state.response = { data: [{ id: "t1" }, { id: "t2" }], error: null, count: 240 };
    const { result } = renderHook(
      () => usePaginatedBankTransactions({ organizationId: "org-1", page: 1 }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(callsFor("select")[0].args).toEqual(["*", { count: "exact" }]);
    expect(callsFor("range")[0].args).toEqual([0, BANK_TRANSACTIONS_PAGE_SIZE - 1]);
    expect(result.current.data?.transactions).toHaveLength(2);
    expect(result.current.data?.total).toBe(240);
  });

  it("requests the second page as range(50, 99)", async () => {
    const { result } = renderHook(
      () => usePaginatedBankTransactions({ organizationId: "org-1", page: 2 }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsFor("range")[0].args).toEqual([
      BANK_TRANSACTIONS_PAGE_SIZE,
      2 * BANK_TRANSACTIONS_PAGE_SIZE - 1,
    ]);
  });

  it("applies org, client, status, search and sorting server-side", async () => {
    const { result } = renderHook(
      () =>
        usePaginatedBankTransactions({
          organizationId: "org-1",
          clientId: "client-1",
          page: 1,
          status: "open",
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

    const inCalls = callsFor("in").map(c => c.args);
    expect(inCalls).toContainEqual(["match_status", ["niet_gematcht", "suggestie"]]);

    const orCall = callsFor("or")[0].args[0] as string;
    expect(orCall).toContain("description.ilike.%vodafone%");
    expect(orCall).toContain("reference.ilike.%vodafone%");
    expect(orCall).toContain("counter_account.ilike.%vodafone%");

    expect(callsFor("order").map(c => c.args)[0]).toEqual([
      "amount",
      { ascending: true, nullsFirst: false },
    ]);
  });

  it("maps status keys to match_status values (gematcht / handmatig)", async () => {
    const { result } = renderHook(
      () => usePaginatedBankTransactions({ organizationId: "org-1", page: 1, status: "handmatig" }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsFor("in").map(c => c.args)).toContainEqual(["match_status", ["handmatig_geboekt"]]);
  });

  it("returns an empty page without querying when the client subset is empty", async () => {
    const { result } = renderHook(
      () => usePaginatedBankTransactions({ organizationId: "org-1", page: 1, clientIds: [] }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ transactions: [], total: 0 });
    expect(callsFor("range")).toHaveLength(0);
  });
});

describe("fetchAllBankTransactions", () => {
  it("fetches more than 1000 rows in deterministic id-ordered batches", async () => {
    state.batchResponses = [
      { data: Array.from({ length: 1000 }, (_, i) => ({ id: `t-${i}` })), error: null },
      { data: Array.from({ length: 1000 }, (_, i) => ({ id: `t-${1000 + i}` })), error: null },
      { data: Array.from({ length: 250 }, (_, i) => ({ id: `t-${2000 + i}` })), error: null },
    ];
    const result = await fetchAllBankTransactions({ organizationId: "org-1" });

    expect(result).toHaveLength(2250);
    expect(callsFor("range").map(c => c.args)).toEqual([
      [0, BANK_FETCH_BATCH_SIZE - 1],
      [BANK_FETCH_BATCH_SIZE, 2 * BANK_FETCH_BATCH_SIZE - 1],
      [2 * BANK_FETCH_BATCH_SIZE, 3 * BANK_FETCH_BATCH_SIZE - 1],
    ]);
    callsFor("order").forEach(c => expect(c.args).toEqual(["id", { ascending: true }]));
  });

  it("returns immediately for an empty client subset", async () => {
    const result = await fetchAllBankTransactions({ clientIds: [] });
    expect(result).toEqual([]);
    expect(callsFor("range")).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("bankSanitizeSearchTerm strips or()-breakers and escapes wildcards", () => {
    expect(bankSanitizeSearchTerm(" A,B (C) ")).toBe("A B C");
    expect(bankSanitizeSearchTerm("50%_x")).toBe("50\\%\\_x");
  });

  it("isServerFilterableBankStatus is true for simple statuses, false for derived ones", () => {
    ["all", "open", "gematcht", "handmatig"].forEach(s =>
      expect(isServerFilterableBankStatus(s)).toBe(true));
    ["blokkeert_export", "niet_in_bankexport"].forEach(s =>
      expect(isServerFilterableBankStatus(s)).toBe(false));
  });
});

describe("Bank overview source guarantees", () => {
  it("does not run an unbounded full-list select on mount and wires the pager", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/pages/Bank.tsx"), "utf-8");

    // table renders from the paginated hook, not the whole-set memo
    expect(source).toContain("usePaginatedBankTransactions(");
    expect(source).toContain("tableRows.map((t) => {");
    // whole-set matching query is gated behind a selection (never bare mount)
    expect(source).toMatch(/enabled: orgEnabled && hasSelection/);
    // pager present with range + total
    expect(source).toContain("van {tableTotal} transacties");
    // page reset wired
    expect(source).toContain("setPage(1)");
  });
});
