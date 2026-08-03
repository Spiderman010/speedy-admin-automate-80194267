import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import {
  useBankMatchRejections,
  REJECTION_FETCH_BATCH_SIZE,
} from "@/hooks/useBankMatchRejections";

type QueryCall = { method: string; args: unknown[] };

const state = {
  calls: [] as QueryCall[],
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
  query.order = chain("order");
  query.range = chain("range");
  // The builder is awaited after the filters are applied; resolve with the
  // next queued batch at that point.
  (query as any).then = (resolve: (v: unknown) => void) =>
    resolve(state.batchResponses.shift() ?? { data: [], error: null });
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
  state.batchResponses = [];
});

describe("useBankMatchRejections — batched fetch", () => {
  it("fetches more rows than one API batch via deterministic ranges until a short batch", async () => {
    state.batchResponses = [
      { data: Array.from({ length: 1000 }, (_, i) => ({ id: `r-${i}` })), error: null },
      { data: Array.from({ length: 1000 }, (_, i) => ({ id: `r-${1000 + i}` })), error: null },
      { data: Array.from({ length: 137 }, (_, i) => ({ id: `r-${2000 + i}` })), error: null },
    ];
    const { result } = renderHook(
      () => useBankMatchRejections({ organizationId: "org-1", clientId: "c1" }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(2137);
    expect(callsFor("range").map(c => c.args)).toEqual([
      [0, REJECTION_FETCH_BATCH_SIZE - 1],
      [REJECTION_FETCH_BATCH_SIZE, 2 * REJECTION_FETCH_BATCH_SIZE - 1],
      [2 * REJECTION_FETCH_BATCH_SIZE, 3 * REJECTION_FETCH_BATCH_SIZE - 1],
    ]);
    // Deterministic ordering on every batch: created_at asc + id asc tiebreak.
    const orderArgs = callsFor("order").map(c => c.args);
    expect(orderArgs).toEqual([
      ["created_at", { ascending: true }],
      ["id", { ascending: true }],
      ["created_at", { ascending: true }],
      ["id", { ascending: true }],
      ["created_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
    // Org/client scoping preserved on every batch.
    const eqCalls = callsFor("eq").map(c => c.args);
    expect(eqCalls.filter(a => a[0] === "organization_id")).toHaveLength(3);
    expect(eqCalls.filter(a => a[0] === "client_id")).toHaveLength(3);
  });

  it("returns immediately for an empty client subset without querying", async () => {
    const { result } = renderHook(
      () => useBankMatchRejections({ organizationId: "org-1", clientIds: [] }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
    expect(callsFor("range")).toHaveLength(0);
  });
});
