import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// ── Mock state knobs ────────────────────────────────────────────────────────
const state = {
  clients: [] as any[],
  invoices: [] as any[],
  transactions: [] as any[],
  vraagposten: [] as any[],
  invoicesError: false,
};

const q = (data: any[], isError = false) => ({
  data: isError ? undefined : data,
  isLoading: false,
  isError,
  refetch: vi.fn(),
});

vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "all", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => q(state.clients),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => q(state.invoices, state.invoicesError),
}));
vi.mock("@/hooks/useBankTransactions", () => ({
  useBankTransactions: () => q(state.transactions),
}));
vi.mock("@/hooks/useVraagposten", () => ({
  useVraagposten: () => q(state.vraagposten),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => q([]),
}));

import Dashboard from "@/pages/Index";

function renderDashboard(): void {
  render(
    (
      <MemoryRouter initialEntries={["/"]}>
        <Dashboard />
      </MemoryRouter>
    ) as ReactNode as any,
  );
}

const makeInvoice = (over: Partial<any> = {}) => ({
  id: "inv-1",
  client_id: "c1",
  supplier: "Simyo",
  invoice_number: "F-100",
  invoice_date: "2026-07-01",
  created_at: "2026-07-01T00:00:00Z",
  status: "te_controleren",
  amount_excl: 100,
  amount_incl: 121,
  remaining_amount: 121,
  ...over,
});

beforeEach(() => {
  state.clients = [];
  state.invoices = [];
  state.transactions = [];
  state.vraagposten = [];
  state.invoicesError = false;
});

describe("Dashboard", () => {
  it("toont operationele KPI's met waarden uit bestaande data en linkt naar bestaande routes", () => {
    state.invoices = [
      makeInvoice({ id: "i1" }),
      makeInvoice({ id: "i2", status: "gecontroleerd", remaining_amount: 50, amount_incl: 121 }),
      makeInvoice({ id: "i3", status: "betaald", remaining_amount: 0 }),
    ];
    state.transactions = [
      { id: "t1", match_status: "niet_gematcht" },
      { id: "t2", match_status: "suggestie" },
      { id: "t3", match_status: "gematcht" },
    ];
    state.vraagposten = [
      { id: "v1", status: "open", titel: "Onbekende betaling", created_at: "2026-07-02" },
      { id: "v2", status: "opgelost" },
    ];
    renderDashboard();

    // Nog te verwerken: 1 · Bank: 2 · Vraagposten: 1 · Openstaand inkoop: 2 (i1 open + i2 partial)
    // KPI-cards worden gevonden via hun unieke contextregel (de titels "Bank"
    // en "Vraagposten" komen ook voor in de snelle navigatie).
    const kpi = (context: string | RegExp) => screen.getByText(context).closest("a")!;
    expect(kpi("inkoopfacturen te controleren")).toHaveAttribute("href", "/facturen");
    expect(kpi("inkoopfacturen te controleren")).toHaveTextContent("1");
    expect(kpi("transacties nog af te letteren")).toHaveAttribute("href", "/bank");
    expect(kpi("transacties nog af te letteren")).toHaveTextContent("2");
    expect(kpi("open of in behandeling")).toHaveAttribute("href", "/vraagposten");
    expect(kpi("open of in behandeling")).toHaveTextContent("1");
    expect(kpi(/nog te betalen/)).toHaveAttribute("href", "/facturen");
    expect(kpi(/nog te betalen/)).toHaveTextContent("2");
    // Contextregel toont het werkelijke restbedrag (121 + 50), geen fictieve trends.
    expect(kpi(/nog te betalen/)).toHaveTextContent("171");
  });

  it("toont de werkvoorraad per administratie met status en Openen-actie", () => {
    state.clients = [{ id: "c1", name: "Bakkerij Jansen" }];
    state.invoices = [makeInvoice()];
    renderDashboard();

    expect(screen.getByText("Werkvoorraad per administratie")).toBeInTheDocument();
    expect(screen.getByText("Bakkerij Jansen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Openen/ })).toBeInTheDocument();
  });

  it("toont openstaande items onder Aandacht vereist met werkende links", () => {
    state.invoices = [makeInvoice()];
    state.vraagposten = [
      { id: "v1", status: "open", titel: "Onbekende betaling", created_at: "2026-06-01" },
    ];
    renderDashboard();

    const vraagpost = screen.getByText("Onbekende betaling").closest("a")!;
    expect(vraagpost).toHaveAttribute("href", "/vraagposten");
    const factuur = screen.getByText("Simyo").closest("a")!;
    expect(factuur).toHaveAttribute("href", "/facturen");
  });

  it("toont nuttige lege toestanden zonder data", () => {
    renderDashboard();
    expect(screen.getByText("Geen openstaande acties")).toBeInTheDocument();
    expect(screen.getByText("Nog geen administraties")).toBeInTheDocument();
    // KPI's tonen 0, geen fictieve waarden.
    expect(screen.getByText("inkoopfacturen te controleren").closest("a")).toHaveTextContent("0");
  });

  it("toont een beheerste foutmelding met retry bij een mislukte query", () => {
    state.invoicesError = true;
    renderDashboard();
    expect(
      screen.getByText("Een deel van de dashboardgegevens kon niet worden geladen."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Opnieuw laden" })).toBeInTheDocument();
  });

  it("gebruikt de snelle navigatie uitsluitend voor bestaande routes", () => {
    renderDashboard();
    for (const [label, href] of [
      ["Bank", "/bank"],
      ["Inkoop", "/facturen"],
      ["Verkoop", "/verkoop"],
      ["Vraagposten", "/vraagposten"],
      ["Administraties", "/klanten"],
      ["Rapportages", "/overzichten"],
    ] as const) {
      const links = screen.getAllByRole("link", { name: new RegExp(`^${label}$`) });
      expect(links.some(l => l.getAttribute("href") === href)).toBe(true);
    }
  });
});
