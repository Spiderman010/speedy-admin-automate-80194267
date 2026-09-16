import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Fase 6C-b7 PR 1 — de eerste lezer van ledger_postings.
 *
 * Gewone SELECT onder RLS. Bewaakt: verplicht client_id-predicaat, half-open
 * periode via posting_date, batchen voorbij de PostgREST-limiet, geen filter
 * op reversal/actief/currency, en een niet-EUR-rij die hard faalt.
 */

type Call = { table: string; filters: Array<[string, string, unknown]>; orders: string[]; range: [number, number] | null };

const state = {
  rows: [] as Array<Record<string, unknown>>,
  calls: [] as Call[],
  error: null as { message: string; code?: string } | null,
};

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u-1" }, loading: false }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, filters: [], orders: [], range: null };
      state.calls.push(call);
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => (call.filters.push([col, "eq", val]), builder),
        lt: (col: string, val: unknown) => (call.filters.push([col, "lt", val]), builder),
        order: (col: string) => (call.orders.push(col), builder),
        range: async (from: number, to: number) => {
          call.range = [from, to];
          if (state.error) return { data: null, error: state.error };
          return { data: state.rows.slice(from, to + 1), error: null };
        },
      };
      return builder;
    },
  },
}));

import { fetchLedgerPostings, LEDGER_FETCH_BATCH_SIZE, useLedgerPostings } from "@/hooks/useLedgerPostings";
import { LedgerReportingError } from "@/lib/ledger-reporting";

const posting = (over: Record<string, unknown> = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  client_id: "c-1",
  organization_id: "org-1",
  grootboekrekening_id: "gb-1",
  posting_group_id: "g-1",
  line_no: 1,
  posting_date: "2027-02-01",
  boekjaar: 2027,
  debit_amount: 10,
  credit_amount: 0,
  currency: "EUR",
  description: null,
  source_type: "manual_journal",
  source_id: "mj-1",
  source_line_id: null,
  reversal_of_posting_id: null,
  user_id: "u-1",
  created_at: "2027-02-01T00:00:00Z",
  created_xact_id: "1",
  ...over,
});

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  state.rows = [];
  state.calls = [];
  state.error = null;
});

describe("useLedgerPostings / fetchLedgerPostings", () => {
  it("1. leest uitsluitend ledger_postings, met client_id als verplicht predicaat", async () => {
    state.rows = [posting()];
    const rows = await fetchLedgerPostings({ clientId: "c-1" });
    expect(rows).toHaveLength(1);
    // Elke aanroep (ook de lege afsluitende batch) leest alleen ledger_postings
    // en draagt het klantpredicaat.
    expect(state.calls.length).toBeGreaterThanOrEqual(1);
    expect(state.calls.every((c) => c.table === "ledger_postings")).toBe(true);
    for (const c of state.calls) expect(c.filters).toContainEqual(["client_id", "eq", "c-1"]);
  });

  it("2. zonder client_id draait er geen query en faalt een directe aanroep hard", async () => {
    await expect(fetchLedgerPostings({ clientId: "" })).rejects.toBeInstanceOf(LedgerReportingError);
    expect(state.calls).toHaveLength(0);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLedgerPostings({ clientId: undefined }), { wrapper: wrapper(qc) });
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.fetchStatus).toBe("idle");
    expect(state.calls).toHaveLength(0);
  });

  it("3. periode: alleen posting_date < toExclusive server-side; beginsaldo-rijen blijven erin", async () => {
    state.rows = [posting({ posting_date: "2026-05-01" }), posting({ posting_date: "2027-02-01" })];
    const rows = await fetchLedgerPostings({ clientId: "c-1", period: { from: "2027-01-01", toExclusive: "2027-04-01" } });
    expect(rows).toHaveLength(2);
    const filters = state.calls[0].filters;
    expect(filters).toContainEqual(["posting_date", "lt", "2027-04-01"]);
    expect(filters.some(([col]) => col === "boekjaar")).toBe(false);
    // Geen ondergrens in de query: 'from' is een rapportagegrens, geen fetchgrens.
    expect(filters.some(([col, op]) => col === "posting_date" && op !== "lt")).toBe(false);
  });

  it("4. filtert nooit op reversal_of_posting_id, actief of currency", async () => {
    state.rows = [posting({ reversal_of_posting_id: "p-orig" }), posting()];
    const rows = await fetchLedgerPostings({ clientId: "c-1" });
    expect(rows).toHaveLength(2);
    const cols = state.calls[0].filters.map(([col]) => col);
    expect(cols).not.toContain("reversal_of_posting_id");
    expect(cols).not.toContain("actief");
    expect(cols).not.toContain("currency");
    expect(cols.sort()).toEqual(["client_id"]);
  });

  it("5. batcht voorbij de PostgREST-limiet in een stabiele volgorde, tot een lege batch", async () => {
    state.rows = Array.from({ length: LEDGER_FETCH_BATCH_SIZE * 2 + 7 }, (_, i) =>
      posting({ id: `p-${String(i).padStart(5, "0")}` }),
    );
    const rows = await fetchLedgerPostings({ clientId: "c-1" });
    expect(rows).toHaveLength(LEDGER_FETCH_BATCH_SIZE * 2 + 7);
    // Een vierde, lege batch sluit af (de offset volgt de ontvangen rijen, dus
    // hij begint op 2007): de volledigheid hangt niet af van de aanname dat de
    // servercap minstens LEDGER_FETCH_BATCH_SIZE is.
    const n = LEDGER_FETCH_BATCH_SIZE;
    expect(state.calls.map((c) => c.range)).toEqual([
      [0, n - 1],
      [n, n * 2 - 1],
      [n * 2, n * 3 - 1],
      [n * 2 + 7, n * 3 + 6],
    ]);
    for (const c of state.calls) {
      expect(c.orders).toEqual(["posting_date", "posting_group_id", "line_no", "id"]);
      expect(c.filters).toContainEqual(["client_id", "eq", "c-1"]);
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("5b. een lagere servercap dan de batchgrootte kapt niets af", async () => {
    // Simuleer db-max-rows = 300: elke batch levert hoogstens 300 rijen.
    state.rows = Array.from({ length: 1234 }, (_, i) => posting({ id: `p-${String(i).padStart(5, "0")}` }));
    const cap = 300;
    const original = state.rows;
    state.rows = new Proxy(original, {
      get(target, prop, receiver) {
        if (prop === "slice") return (from: number, to: number) => target.slice(from, Math.min(to, from + cap));
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof original;
    const rows = await fetchLedgerPostings({ clientId: "c-1" });
    expect(rows).toHaveLength(1234);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1234);
    // De offset volgt de werkelijk ontvangen rijen: 0, 300, 600, 900, 1200, dan leeg.
    expect(state.calls.map((c) => c.range?.[0])).toEqual([0, 300, 600, 900, 1200, 1234]);
  });

  it("5c. een boeking die tijdens het ophalen vóór de batchgrens landt, levert geen dubbele rijen op", async () => {
    // Regressie (review P2): offset-batchen op een append-only tabel. Tussen
    // batch 1 en 2 posten we een 2-regelgroep die vóór positie 1000 sorteert;
    // alles erna schuift twee plaatsen op en batch 2 geeft twee al geziene
    // rijen terug. Zonder ontdubbeling zou een complete, gebalanceerde groep
    // dubbel meetellen — en de set-controle merkt dat niet.
    const N = LEDGER_FETCH_BATCH_SIZE + 10;
    const base = Array.from({ length: N }, (_, i) =>
      posting({ id: `p-${String(i).padStart(5, "0")}`, posting_group_id: `g-${String(i).padStart(5, "0")}` }),
    );
    state.rows = base;
    let inserted = false;
    const shifting = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "slice") {
          return (from: number, to: number) => {
            const page = target.slice(from, to + 1);
            if (from > 0 && !inserted) {
              inserted = true;
              // Landt op positie 500: alles vanaf 500 schuift 2 op.
              target.splice(500, 0,
                posting({ id: "p-new-1", posting_group_id: "g-00500-new", posting_date: "2027-02-01" }),
                posting({ id: "p-new-2", posting_group_id: "g-00500-new", posting_date: "2027-02-01", debit_amount: 0, credit_amount: 10, line_no: 2 }),
              );
              return target.slice(from, to + 1);
            }
            return page;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    state.rows = shifting as typeof base;
    const rows = await fetchLedgerPostings({ clientId: "c-1" });
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // De oorspronkelijke N rijen zijn er allemaal (niets overgeslagen)…
    for (const b of base.filter((r) => !r.id.startsWith("p-new"))) expect(ids).toContain(b.id);
    // …en de rijen 998/999 die na de verschuiving opnieuw terugkwamen, staan er één keer.
    expect(ids.filter((id) => id === "p-00998" || id === "p-00999")).toHaveLength(2);
  });

  it("6. een niet-EUR-rij maakt de fetch hard ongeldig; niets wordt weggelaten", async () => {
    state.rows = [posting(), posting({ currency: "USD" })];
    await expect(fetchLedgerPostings({ clientId: "c-1" })).rejects.toThrow(/alleen EUR/);
  });

  it("7. een rij van een andere administratie in het antwoord is een harde fout", async () => {
    state.rows = [posting(), posting({ client_id: "c-2" })];
    await expect(fetchLedgerPostings({ clientId: "c-1" })).rejects.toThrow(/andere administratie/);
  });

  it("8. een PostgREST-fout wordt doorgegeven, niet als lege set gemaskeerd", async () => {
    state.error = { message: "permission denied for table ledger_postings", code: "42501" };
    await expect(fetchLedgerPostings({ clientId: "c-1" })).rejects.toMatchObject({ code: "42501" });
  });

  it("9. de hook gebruikt de al gereserveerde query-keyfamilie ['ledger-postings', …]", async () => {
    state.rows = [posting()];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useLedgerPostings({ clientId: "c-1", period: { from: "2027-01-01", toExclusive: "2027-04-01" } }),
      { wrapper: wrapper(qc) },
    );
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    const keys = qc.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toEqual([["ledger-postings", "c-1", "2027-01-01", "2027-04-01"]]);
    // De invalidatie die de vier boek-hooks al sinds 6C-b3 uitsturen raakt deze query.
    const before = result.current.dataUpdatedAt;
    await qc.invalidateQueries({ queryKey: ["ledger-postings"] });
    await waitFor(() => expect(result.current.dataUpdatedAt).toBeGreaterThan(before));
  });

  it("10. een ongeldige periode wordt vóór de query geweigerd", async () => {
    await expect(
      fetchLedgerPostings({ clientId: "c-1", period: { from: "2027-04-01", toExclusive: "2027-01-01" } }),
    ).rejects.toThrow(/vóór/);
    expect(state.calls).toHaveLength(0);
  });
});
