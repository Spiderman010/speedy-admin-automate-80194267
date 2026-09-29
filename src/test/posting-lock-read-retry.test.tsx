import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

/**
 * Een tijdelijke leesfout op de boekingsblokkade moet de NORMALE herstelwegen
 * behouden: de omsluitende query faalt, React Query herkanst, en na uitputting
 * blijft er een expliciete refetch over. Nooit wordt de fout gevangen en als
 * geslaagde data met een verzonnen stand gecachet.
 *
 * De hook is NIET gemockt: `useLedgerCatchup` draait echt tegen een gemockte
 * Supabase-client waarvan uitsluitend de blokkadelezing faalt.
 */

const state = {
  /** Zoveel blokkadelezingen falen nog voordat er weer een antwoord komt. */
  lockFailuresLeft: 0,
  lock: null as string | null,
  lockReads: 0,
};

const INVOICE = {
  id: "pi-1", client_id: "client-1", status: "gecontroleerd", invoice_date: "2026-03-01",
  invoice_number: "F-1", supplier: "Lev BV", amount_excl: 100, amount_incl: 121, btw_amount: 21,
};

function builder(table: string, columns = "") {
  const rows =
    table === "purchase_invoices" ? [INVOICE]
    : table === "purchase_invoice_lines" ? [{ purchase_invoice_id: "pi-1", amount_excl: 100, grootboekrekening_id: "gb-1" }]
    : [];
  // fetchAll() pagineert tot een lege batch: range() moet dus echt snijden.
  let from = 0;
  let to = rows.length - 1;
  const api: Record<string, unknown> = {
    select: (cols: string) => builder(table, cols),
    eq: () => api,
    in: () => api,
    gte: () => api,
    lt: () => api,
    order: () => api,
    range: (a: number, b: number) => { from = a; to = b; return api; },
    maybeSingle: async () => {
      if (table !== "clients") return { data: null, error: null };
      if (columns.includes("posting_locked_through")) {
        state.lockReads += 1;
        if (state.lockFailuresLeft > 0) {
          state.lockFailuresLeft -= 1;
          return { data: null, error: { code: "PGRST000", message: "connection reset" } };
        }
        return { data: { id: "client-1", posting_locked_through: state.lock }, error: null };
      }
      return {
        data: { id: "client-1", crediteuren_rekening_id: "cred", debiteuren_rekening_id: "deb", btw_te_vorderen_rekening_id: "btwv", btw_te_betalen_rekening_id: "btwb" },
        error: null,
      };
    },
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }).then(ok),
  };
  return api;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: string) => builder(table), rpc: async () => ({ data: null, error: null }) },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-1" }, session: null, loading: false }) }));

import { useLedgerCatchup } from "@/hooks/useLedgerCatchup";

function wrapperMet(retry: number | false) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry, retryDelay: 0, gcTime: 0 }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  state.lockFailuresLeft = 0;
  state.lock = null;
  state.lockReads = 0;
});

describe("Een tijdelijke leesfout op de blokkade", () => {
  it("7. bereikt React Query als fout — de query slaagt niet stilzwijgend met een verzonnen stand", async () => {
    state.lockFailuresLeft = 99;
    const { result } = renderHook(() => useLedgerCatchup("client-1", { year: null }), { wrapper: wrapperMet(false) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect((result.current.error as { message?: string }).message).toBe("connection reset");
  });

  it("8. wordt door de gewone retry herkanst, en daarna is de ECHTE blokkadestand zichtbaar", async () => {
    state.lockFailuresLeft = 1;
    state.lock = "2026-12-31";
    const { result } = renderHook(() => useLedgerCatchup("client-1", { year: null }), { wrapper: wrapperMet(1) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(state.lockReads).toBe(2);
    const record = result.current.data!.records[0];
    // Niet 'onbekend', niet 'klaar': de werkelijke blokkade dekt de datum.
    expect(record.state).toBe("geblokkeerd");
    expect(record.blocks.map((b) => b.code)).toEqual(["boekingsblokkade"]);
    expect(record.blocks[0].label).toBe("Boekingsdatum 01-03-2026 valt binnen de boekingsblokkade t/m 31-12-2026.");
  });

  it("8b. en met een geslaagde herkansing zonder blokkade is het record gewoon klaar (null, niet onbekend)", async () => {
    state.lockFailuresLeft = 1;
    state.lock = null;
    const { result } = renderHook(() => useLedgerCatchup("client-1", { year: null }), { wrapper: wrapperMet(1) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.records[0].state).toBe("klaar");
    expect(result.current.data!.purchase.onbekend).toBe(0);
  });

  it("9. na uitputting blijft het een fout mét herstelweg: refetch() zonder remount geeft de echte stand", async () => {
    state.lockFailuresLeft = 2;
    state.lock = "2026-12-31";
    const { result } = renderHook(() => useLedgerCatchup("client-1", { year: null }), { wrapper: wrapperMet(1) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(state.lockReads).toBe(2);
    // Geen data: niets is als "onbekend maar geslaagd" gecachet.
    expect(result.current.data).toBeUndefined();

    await result.current.refetch();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.records[0].state).toBe("geblokkeerd");
  });
});
