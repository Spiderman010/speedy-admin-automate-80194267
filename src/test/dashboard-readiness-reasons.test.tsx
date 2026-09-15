import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// Verifies review finding 2: the named config reasons produced by
// client-readiness are actually rendered to the user on the dashboard.

const state = {
  clients: [] as any[],
  accounts: [] as any[],
};

const q = (data: any[]) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });

vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "all", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useClients", () => ({ useClients: () => q(state.clients) }));
vi.mock("@/hooks/usePurchaseInvoices", () => ({ usePurchaseInvoices: () => q([]) }));
vi.mock("@/hooks/useBankTransactions", () => ({ useBankTransactions: () => q([]) }));
vi.mock("@/hooks/useVraagposten", () => ({ useVraagposten: () => q([]) }));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => q(state.accounts),
}));

import Dashboard from "@/pages/Index";

/** Fully configured client; each test removes exactly one thing. */
const makeClient = (over: Partial<any> = {}) => ({
  id: "c-1",
  name: "Klant Een",
  organization_id: "org-1",
  user_id: "u-1",
  bank_dagboek: 1100,
  inkoop_dagboek: 700,
  verkoop_dagboek: 800,
  debiteuren_rekening_id: "gb-1300",
  crediteuren_rekening_id: "gb-1600",
  btw_te_vorderen_rekening_id: "gb-btw-vorderen",
  btw_te_betalen_rekening_id: "gb-btw-betalen",
  // 6C-b5a added a fifth required configuration field; the "fully
  // configured" fixture must include it too.
  bank_rekening_id: "gb-bank",
  ...over,
});

const ACCOUNT_1799 = { id: "gb-1799", nummer: 1799, omschrijving: "Onbekende betalingen", client_id: null };

function renderDashboard() {
  render(
    (
      <MemoryRouter initialEntries={["/"]}>
        <Dashboard />
      </MemoryRouter>
    ) as ReactNode as any,
  );
}

/** The warning line rendered under the client name in the werkvoorraad row. */
const clientRow = () => screen.getByText("Klant Een").closest("td")!;

beforeEach(() => {
  state.clients = [makeClient()];
  state.accounts = [ACCOUNT_1799];
});

describe("Dashboard — readiness config reasons", () => {
  it("toont 'Debiteurenrekening ontbreekt' wanneer alleen die ontbreekt", () => {
    state.clients = [makeClient({ debiteuren_rekening_id: null })];
    renderDashboard();
    expect(within(clientRow()).getByText(/Debiteurenrekening ontbreekt/)).toBeInTheDocument();
    expect(within(clientRow()).queryByText(/Crediteurenrekening ontbreekt/)).not.toBeInTheDocument();
  });

  it("toont 'Crediteurenrekening ontbreekt' wanneer alleen die ontbreekt", () => {
    state.clients = [makeClient({ crediteuren_rekening_id: null })];
    renderDashboard();
    expect(within(clientRow()).getByText(/Crediteurenrekening ontbreekt/)).toBeInTheDocument();
    expect(within(clientRow()).queryByText(/Debiteurenrekening ontbreekt/)).not.toBeInTheDocument();
  });

  it("toont beide redenen wanneer beide rekeningen ontbreken", () => {
    state.clients = [makeClient({ debiteuren_rekening_id: null, crediteuren_rekening_id: null })];
    renderDashboard();
    const text = clientRow().textContent ?? "";
    expect(text).toContain("Debiteurenrekening ontbreekt");
    expect(text).toContain("Crediteurenrekening ontbreekt");
  });

  it("blijft ontbrekende dagboeken tonen", () => {
    state.clients = [makeClient({ bank_dagboek: null, inkoop_dagboek: null })];
    renderDashboard();
    const text = clientRow().textContent ?? "";
    expect(text).toContain("Bank-dagboek ontbreekt");
    expect(text).toContain("Inkoop-dagboek ontbreekt");
  });

  it("behoudt de bestaande 1799-waarschuwing", () => {
    state.accounts = []; // 1799 afwezig
    renderDashboard();
    expect(within(clientRow()).getByText(/Rekening 1799 ontbreekt/)).toBeInTheDocument();
  });

  it("toont geen dubbele waarschuwingen", () => {
    state.clients = [makeClient({ bank_dagboek: null, debiteuren_rekening_id: null })];
    state.accounts = [];
    renderDashboard();
    const text = clientRow().textContent ?? "";
    const count = (needle: string) => text.split(needle).length - 1;
    expect(count("Bank-dagboek ontbreekt")).toBe(1);
    expect(count("Debiteurenrekening ontbreekt")).toBe(1);
    expect(count("Rekening 1799 ontbreekt")).toBe(1);
    // Geen los achtergebleven "ontbreekt" van het oude suffix-patroon.
    expect(count("ontbreekt")).toBe(3);
  });

  it("toont geen configuratiewaarschuwing wanneer alles compleet is", () => {
    renderDashboard();
    expect(clientRow().textContent).not.toContain("ontbreekt");
  });
});
