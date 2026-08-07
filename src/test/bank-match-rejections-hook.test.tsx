import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import {
  useBankMatchRejections,
  useAddBankMatchRejection,
  buildRejectionMap,
  REJECTION_FETCH_BATCH_SIZE,
} from "@/hooks/useBankMatchRejections";

type QueryCall = { method: string; args: unknown[] };
type QueryResponse = { data: unknown[]; error: unknown };

const state = {
  calls: [] as QueryCall[],
  batchResponses: [] as QueryResponse[],
  deferNext: false,
  pendingResolvers: [] as Array<(v: QueryResponse) => void>,
  upserts: [] as unknown[],
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
  query.upsert = vi.fn((...args: unknown[]) => {
    state.calls.push({ method: "upsert", args });
    state.upserts.push(args);
    return { then: (resolve: (v: unknown) => void) => resolve({ error: null }) };
  });
  (query as any).then = (resolve: (v: QueryResponse) => void) => {
    if (state.deferNext) {
      state.deferNext = false;
      state.pendingResolvers.push(resolve);
      return;
    }
    resolve(state.batchResponses.shift() ?? { data: [], error: null });
  };
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

const REJECTION_INSERT = {
  organization_id: "org-1",
  client_id: "c1",
  bank_transaction_id: "tx-1",
  invoice_id: "inv-A",
  invoice_type: "inkoop" as const,
};

beforeEach(() => {
  state.calls = [];
  state.batchResponses = [];
  state.deferNext = false;
  state.pendingResolvers = [];
  state.upserts = [];
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

describe("useAddBankMatchRejection — geen raamvenster tussen mutatie en refetch", () => {
  it("past de nieuwe afwijzing direct lokaal toe terwijl de server-refetch nog loopt", async () => {
    // ECHTE mutatie-flow: geen vooraf geladen afwijzingsdata — de lijst start
    // leeg vanaf de 'server'.
    const wrapper = createWrapper();
    const { result } = renderHook(
      () => ({
        list: useBankMatchRejections({ organizationId: "org-1", clientId: "c1" }),
        add: useAddBankMatchRejection(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(result.current.list.data).toEqual([]);

    // De refetch die de mutatie triggert blijft hangen (trage server).
    state.deferNext = true;
    await act(async () => {
      await result.current.add.mutateAsync(REJECTION_INSERT);
    });

    // Refetch is gestart maar NIET afgerond…
    await waitFor(() => expect(state.pendingResolvers).toHaveLength(1));
    expect(result.current.list.isFetching).toBe(true);
    // …en toch bevat de cache de afwijzing al: het uitsluitingspredicaat
    // filtert de zojuist afgewezen factuur dus zonder enige tussenpauze.
    const rows = result.current.list.data ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bank_transaction_id: "tx-1", invoice_id: "inv-A" });
    expect(buildRejectionMap(rows).get("tx-1")).toEqual(new Set(["inv-A"]));

    // Nogmaals afwijzen van dezelfde combinatie mag geen duplicaat opleveren.
    state.deferNext = true;
    await act(async () => {
      await result.current.add.mutateAsync(REJECTION_INSERT);
    });
    expect(result.current.list.data).toHaveLength(1);

    // Server-refetch rondt af met de echte rij: cache consistent, 1 rij.
    const serverRow = {
      id: "rej-real-1",
      ...REJECTION_INSERT,
      rejected_by: "user-1",
      created_at: "2026-01-01T00:00:00Z",
    };
    await act(async () => {
      for (const resolve of state.pendingResolvers.splice(0)) {
        resolve({ data: [serverRow], error: null });
      }
    });
    await waitFor(() => expect(result.current.list.isFetching).toBe(false));
    expect(result.current.list.data).toEqual([serverRow]);
  });

  it("werkt geen caches van een andere org/klant-scope bij", async () => {
    const wrapper = createWrapper();
    const { result } = renderHook(
      () => ({
        other: useBankMatchRejections({ organizationId: "org-1", clientId: "c-ANDERS" }),
        add: useAddBankMatchRejection(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.other.isSuccess).toBe(true));

    state.deferNext = true;
    await act(async () => {
      await result.current.add.mutateAsync(REJECTION_INSERT); // client c1
    });
    // De cache van c-ANDERS krijgt de c1-afwijzing niet toegevoegd.
    expect(result.current.other.data).toEqual([]);
  });
});
