import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

/**
 * Review P2-2 — `useLedgerCompleteness` mag niet op elk rapportbezoek draaien.
 *
 * `fetchLedgerCompletenessCounts` doet negen parallelle tellingen met
 * gepagineerde id-lijsten per administratie. De jaarrekeningrapporten hebben
 * die uitkomst alleen nodig zodra vaststaat dát het rapport leeg is. Deze
 * tests kijken naar de énige waarheid die telt: gaat er werkelijk een query
 * naar de database, of niet.
 *
 * De schakelaar is een optie op de hook, geen voorwaardelijke hook-aanroep —
 * de hook draait altijd (React-regel), de query niet.
 */

const queries: string[] = [];

/**
 * Elke Supabase-methode geeft hetzelfde object terug en het object is
 * awaitable; daarmee dekt deze stub zowel `select(...).eq(...)` (een telling)
 * als `select(...).eq(...).order(...).range(...)` (een id-lijst).
 */
function stubQuery() {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "range", "neq", "not", "limit"]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], count: 0, error: null }).then(resolve);
  return chain;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      queries.push(table);
      return stubQuery();
    },
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/hooks/useOpeningBalances", () => ({
  useOpeningBalanceOverview: () => ({ data: undefined, isPending: false, isError: false }),
}));

import { useLedgerCompleteness } from "@/hooks/useLedgerCompleteness";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  queries.length = 0;
});

describe("useLedgerCompleteness — de zware telquery is schakelbaar", () => {
  it("1. zonder optie blijft het gedrag ongewijzigd: de query draait", async () => {
    // Backwards compatible voor de bestaande aanroepers (saldischermen en de
    // proef- en saldibalans), die de meter altijd tonen.
    renderHook(() => useLedgerCompleteness("client-1"), { wrapper });
    await waitFor(() => expect(queries.length).toBeGreaterThan(0));
  });

  it("2. enabled: true draait de query", async () => {
    renderHook(() => useLedgerCompleteness("client-1", { enabled: true }), { wrapper });
    await waitFor(() => expect(queries.length).toBeGreaterThan(0));
  });

  it("3. enabled: false raakt de database niet aan", async () => {
    const { result } = renderHook(() => useLedgerCompleteness("client-1", { enabled: false }), { wrapper });
    // Even de tijd geven dat een onterechte fetch zichtbaar wordt.
    await new Promise((r) => setTimeout(r, 20));
    expect(queries).toEqual([]);
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("4. zonder administratie blijft de query uit, ook met enabled: true", async () => {
    renderHook(() => useLedgerCompleteness(undefined, { enabled: true }), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(queries).toEqual([]);
  });
});
