// B2-09: na uitloggen of een gebruikerswissel blijft niets van de vorige
// gebruiker in de querycache. Gedragstests op de echte AppShell (sidebar),
// de echte Instellingen-pagina en de echte UserScopedQueryCache.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

type AuthState = { user: { id: string; email: string } | null; session: null; loading: boolean };
let authState: AuthState = { user: { id: "gebruiker-a", email: "a@kantoor.test" }, session: null, loading: false };

const signOut = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: (...args: unknown[]) => signOut(...args), updateUser: vi.fn() } },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => authState }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({ useClients: () => ({ data: [{ id: "c1", name: "Klant 1" }] }) }));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/components/OrganizationSelector", () => ({ OrganizationSelector: () => null }));
vi.mock("@/hooks/useAppSettings", () => ({
  useAppSettings: () => ({ data: { profiel: { naam: "Medewerker A" } }, isLoading: false }),
  useSaveAppSetting: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { queryClient } from "@/lib/query-client";
import { AppShell } from "@/components/layout/app-shell";
import Instellingen from "@/pages/Instellingen";
import { UserScopedQueryCache } from "@/components/UserScopedQueryCache";

/** Wat er bij gebruiker A in de cache staat: sleutels zonder gebruiker of organisatie (B2-09). */
function seedCacheOfUserA() {
  queryClient.setQueryData(["app_settings"], { profiel: { naam: "Medewerker A", telefoon: "06-12345678" } });
  queryClient.setQueryData(["bank_transactions", "all", "all", "all", ""], [{ id: "tx-1", counter_account: "NL91ABNA0417164300" }]);
}

beforeEach(() => {
  authState = { user: { id: "gebruiker-a", email: "a@kantoor.test" }, session: null, loading: false };
  queryClient.clear();
  signOut.mockReset();
});
afterEach(() => queryClient.clear());

describe("uitloggen leegt de querycache (B2-09)", () => {
  it("de uitlogknop in de zijbalk: eerst uitloggen, dan de cache legen, dan naar /auth", async () => {
    let cacheSizeDuringSignOut = -1;
    signOut.mockImplementation(async () => {
      cacheSizeDuringSignOut = queryClient.getQueryCache().getAll().length;
      return { error: null };
    });
    seedCacheOfUserA();
    render(
      <MemoryRouter initialEntries={["/bank"]}>
        <Routes>
          <Route path="/bank" element={<AppShell><div>pagina</div></AppShell>} />
          <Route path="/auth" element={<div>inlogscherm</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Uitloggen/ }));

    expect(await screen.findByText("inlogscherm")).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(cacheSizeDuringSignOut).toBe(2); // de cache werd pas ná het uitloggen geleegd
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getQueryData(["app_settings"])).toBeUndefined();
  });

  it("de uitlogknop in Instellingen › Profiel leegt de cache ook", async () => {
    signOut.mockResolvedValue({ error: null });
    seedCacheOfUserA();
    render(
      <MemoryRouter initialEntries={["/instellingen"]}>
        <Instellingen />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Uitloggen/ }));

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryClient.getQueryCache().getAll()).toHaveLength(0));
  });
});

describe("UserScopedQueryCache: de cache hoort bij één gebruiker", () => {
  /** Toont de instellingen zoals useAppSettings ze cachet: sleutel zonder gebruiker. */
  function Profiel() {
    const userId = authState.user?.id ?? null;
    const { data } = useQuery({
      queryKey: ["app_settings"],
      queryFn: async () => ({ eigenaar: userId }),
      enabled: userId !== null,
    });
    return <p>{data ? `profiel van ${data.eigenaar}` : "geen profiel"}</p>;
  }

  function renderBoundary(client: QueryClient) {
    const tree = () => (
      <QueryClientProvider client={client}>
        <UserScopedQueryCache>
          <Profiel />
        </UserScopedQueryCache>
      </QueryClientProvider>
    );
    const view = render(tree());
    return { rerender: () => view.rerender(tree()) };
  }

  it("bij een wissel naar een andere gebruiker ziet die nooit de gegevens van de vorige", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderBoundary(client);
    expect(await screen.findByText("profiel van gebruiker-a")).toBeInTheDocument();

    authState = { user: { id: "gebruiker-b", email: "b@kantoor.test" }, session: null, loading: false };
    act(() => rerender());
    // In de render waarin de wissel binnenkomt toont de grens niets, ook geen oude gegevens.
    expect(screen.queryByText("profiel van gebruiker-a")).not.toBeInTheDocument();

    expect(await screen.findByText("profiel van gebruiker-b")).toBeInTheDocument();
    expect(client.getQueryData(["app_settings"])).toEqual({ eigenaar: "gebruiker-b" });
  });

  it("een sessie die wegvalt (verlopen, ander tabblad) leegt de cache", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderBoundary(client);
    expect(await screen.findByText("profiel van gebruiker-a")).toBeInTheDocument();

    authState = { user: null, session: null, loading: false };
    act(() => rerender());

    await waitFor(() => expect(client.getQueryData(["app_settings"])).toBeUndefined());
    expect(screen.queryByText("profiel van gebruiker-a")).not.toBeInTheDocument();
    expect(await screen.findByText("geen profiel")).toBeInTheDocument();
  });

  it("een tokenvernieuwing van dezelfde gebruiker laat de cache staan", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderBoundary(client);
    expect(await screen.findByText("profiel van gebruiker-a")).toBeInTheDocument();
    const clear = vi.spyOn(client, "clear");

    authState = { user: { id: "gebruiker-a", email: "a@kantoor.test" }, session: null, loading: false };
    act(() => rerender());

    expect(screen.getByText("profiel van gebruiker-a")).toBeInTheDocument();
    expect(clear).not.toHaveBeenCalled();
  });
});
