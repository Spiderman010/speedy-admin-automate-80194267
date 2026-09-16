import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Fase 6C-b6 (PR 2) — de hooks rond memoriaalboekingen.
 *
 * Kern van deze tests: de regels gaan uitsluitend via één aanroep van
 * save_manual_journal_lines() (nooit een client-side DELETE + INSERT), en de
 * client stuurt nooit organization_id mee — die leidt de database af.
 */

type Result = { data: unknown; error: unknown };

const state = {
  journals: [] as Array<Record<string, unknown>>,
  markers: [] as Array<Record<string, unknown>>,
  lines: [] as Array<Record<string, unknown>>,
  error: null as { message: string; code?: string } | null,
};

/** Alle from()-aanroepen: [tabel, operatie, argument]. */
const ops: Array<{ table: string; op: string; arg: unknown }> = [];

const { rpcSpy } = vi.hoisted(() => ({ rpcSpy: vi.fn() }));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u-1" }, loading: false }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));

function tableData(table: string): unknown {
  if (table === "manual_journals") return state.journals;
  if (table === "manual_journal_postings") return state.markers;
  if (table === "manual_journal_lines") return state.lines;
  return [];
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      let pending: unknown = null;
      const settle = (): Result =>
        state.error ? { data: null, error: state.error } : { data: pending ?? tableData(table), error: null };
      const record = (op: string, arg?: unknown) => {
        ops.push({ table, op, arg });
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        eq: (col: string, val: unknown) => (record("eq", { [col]: val }), builder),
        in: (col: string, val: unknown) => (record("in", { [col]: val }), builder),
        insert: (payload: unknown) => {
          record("insert", payload);
          pending = { id: "mj-new", ...(payload as object) };
          return builder;
        },
        update: (payload: unknown) => {
          record("update", payload);
          pending = { id: "mj-1", ...(payload as object) };
          return builder;
        },
        delete: () => (record("delete"), builder),
        single: async () => settle(),
        maybeSingle: async () => {
          const value = pending ?? (tableData(table) as unknown[])[0] ?? null;
          return state.error ? { data: null, error: state.error } : { data: value, error: null };
        },
        then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(settle()).then(resolve, reject),
      };
      return builder;
    },
    rpc: rpcSpy,
  },
}));

import {
  useCreateManualJournal,
  useDeleteManualJournal,
  useManualJournals,
  useSaveManualJournalLines,
  useUpdateManualJournal,
} from "@/hooks/useManualJournals";

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  return { queryClient, invalidateSpy, wrapper: wrapper(queryClient) };
}

const journal = (over: Record<string, unknown> = {}) => ({
  id: "mj-1",
  organization_id: "org-1",
  client_id: "c-1",
  user_id: "u-1",
  posting_date: "2027-03-31",
  description: "Afschrijving",
  reference: "MEM-1",
  created_at: "2027-03-31T00:00:00Z",
  updated_at: "2027-03-31T00:00:00Z",
  ...over,
});

beforeEach(() => {
  rpcSpy.mockReset();
  rpcSpy.mockResolvedValue({ data: null, error: null });
  ops.length = 0;
  state.journals = [];
  state.markers = [];
  state.lines = [];
  state.error = null;
});

describe("useManualJournals", () => {
  it("1. leidt de status af uit de claimtabel, niet uit een statuskolom", async () => {
    state.journals = [journal(), journal({ id: "mj-2" })];
    state.markers = [{ manual_journal_id: "mj-2", posting_group_id: "g-2", total_amount: 121 }];
    state.lines = [
      { id: "l-1", manual_journal_id: "mj-1", sort_order: 0, debit_amount: 100, credit_amount: 0 },
    ];

    const { wrapper } = setup();
    const { result } = renderHook(() => useManualJournals({ organizationId: "org-1", clientId: "c-1" }), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(result.current.data?.map((i) => i.posted)).toEqual([false, true]);
    expect(result.current.data?.[0].lines).toHaveLength(1);
    expect(result.current.data?.[1].marker?.posting_group_id).toBe("g-2");
  });

  it("2. haalt markers en regels gebundeld op (geen query per boeking)", async () => {
    state.journals = [journal(), journal({ id: "mj-2" }), journal({ id: "mj-3" })];
    const { wrapper } = setup();
    const { result } = renderHook(() => useManualJournals({ organizationId: "org-1", clientId: "c-1" }), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    const inCalls = ops.filter((o) => o.op === "in");
    expect(inCalls).toHaveLength(2);
    expect(inCalls.map((o) => o.table).sort()).toEqual(["manual_journal_lines", "manual_journal_postings"]);
  });

  it("3. een fout op de claim- of regelquery wordt niet stilgezwegen", async () => {
    state.journals = [journal()];
    state.error = { message: "Could not find the table in the schema cache", code: "PGRST205" };
    const { wrapper } = setup();
    const { result } = renderHook(() => useManualJournals({ organizationId: "org-1", clientId: "c-1" }), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useSaveManualJournalLines", () => {
  it("4. roept save_manual_journal_lines precies één keer aan, zonder losse DELETE/INSERT", async () => {
    const { wrapper, invalidateSpy } = setup();
    const { result } = renderHook(() => useSaveManualJournalLines(), { wrapper });

    await result.current.mutateAsync({
      journalId: "mj-1",
      lines: [
        { sort_order: 0, grootboekrekening_id: "gb-1", omschrijving: null, debit_amount: 100, credit_amount: 0 },
        { sort_order: 1, grootboekrekening_id: "gb-2", omschrijving: null, debit_amount: 0, credit_amount: 100 },
      ],
    });

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy.mock.calls[0][0]).toBe("save_manual_journal_lines");
    expect(rpcSpy.mock.calls[0][1]._journal_id).toBe("mj-1");
    expect(rpcSpy.mock.calls[0][1]._lines).toHaveLength(2);
    // Geen enkele directe tabelbewerking op de regels.
    expect(ops.filter((o) => o.table === "manual_journal_lines")).toHaveLength(0);

    const keys = invalidateSpy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual([
      JSON.stringify(["manual_journal_lines", "mj-1"]),
      JSON.stringify(["manual_journals"]),
    ]);
  });

  it("5. stuurt geen organization_id of user_id mee in de regels", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useSaveManualJournalLines(), { wrapper });
    await result.current.mutateAsync({
      journalId: "mj-1",
      lines: [{ sort_order: 0, grootboekrekening_id: "gb-1", omschrijving: null, debit_amount: 1, credit_amount: 0 }],
    });
    const payload = JSON.stringify(rpcSpy.mock.calls[0][1]);
    expect(payload).not.toContain("organization_id");
    expect(payload).not.toContain("user_id");
  });

  it("6. een RPC-fout wordt doorgegeven en niet als succes gemeld", async () => {
    rpcSpy.mockResolvedValue({ data: null, error: { code: "42501", message: "Geen rechten" } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSaveManualJournalLines(), { wrapper });
    await expect(
      result.current.mutateAsync({ journalId: "mj-1", lines: [] }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("kop-mutaties", () => {
  it("7. insert stuurt user_id maar nooit organization_id (trigger leidt hem af)", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCreateManualJournal(), { wrapper });
    await result.current.mutateAsync({
      client_id: "c-1",
      posting_date: "2027-03-31",
      description: "  Afschrijving  ",
      reference: "",
    });

    const insert = ops.find((o) => o.op === "insert")?.arg as Record<string, unknown>;
    expect(insert).toEqual({
      client_id: "c-1",
      posting_date: "2027-03-31",
      description: "Afschrijving",
      reference: null,
      user_id: "u-1",
    });
    expect(Object.keys(insert)).not.toContain("organization_id");
  });

  it("8. update stuurt alleen de kopvelden, geen organization_id of user_id", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useUpdateManualJournal(), { wrapper });
    await result.current.mutateAsync({
      id: "mj-1",
      form: { client_id: "c-1", posting_date: "2027-04-01", description: "Nieuw", reference: "R" },
    });

    const update = ops.find((o) => o.op === "update")?.arg as Record<string, unknown>;
    expect(Object.keys(update).sort()).toEqual(["client_id", "description", "posting_date", "reference"]);
  });

  it("9. verwijderen ververst lijst, kop en regels", async () => {
    const { wrapper, invalidateSpy } = setup();
    const { result } = renderHook(() => useDeleteManualJournal(), { wrapper });
    await result.current.mutateAsync("mj-1");

    expect(ops.some((o) => o.table === "manual_journals" && o.op === "delete")).toBe(true);
    const keys = invalidateSpy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual([
      JSON.stringify(["manual_journals"]),
      JSON.stringify(["manual_journal", "mj-1"]),
      JSON.stringify(["manual_journal_lines", "mj-1"]),
    ]);
  });
});
