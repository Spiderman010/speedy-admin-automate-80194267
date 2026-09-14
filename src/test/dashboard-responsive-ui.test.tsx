import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

// Gerichte responsive/presentatie-checks voor het dashboard.
// Zakelijke logica (readiness, KPI's) wordt gedekt door
// dashboard.test.tsx en dashboard-readiness-reasons.test.tsx.

const state = {
  clients: [] as any[],
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
vi.mock("@/hooks/useGrootboekrekeningen", () => ({ useGrootboekrekeningen: () => q([]) }));

import Dashboard from "@/pages/Index";

const source = readFileSync(path.resolve(__dirname, "../pages/Index.tsx"), "utf8");

function renderDashboard(): void {
  render(
    (
      <MemoryRouter initialEntries={["/"]}>
        <Dashboard />
      </MemoryRouter>
    ) as ReactNode as any,
  );
}

beforeEach(() => {
  state.clients = [];
});

describe("Dashboard — responsive presentatie", () => {
  it("kapt lange administratienamen veilig af met title-attribuut", () => {
    const longName = "Administratiekantoor Van Der Berg en Partners Holding B.V. — vestiging Amsterdam-Zuidoost";
    state.clients = [{ id: "c1", name: longName }];
    renderDashboard();
    const el = screen.getByText(longName);
    expect(el).toHaveClass("truncate");
    expect(el).toHaveAttribute("title", longName);
  });

  it("gebruikt responsive kolomklassen en veilige tekstafbreking", () => {
    expect(source).toContain("hidden text-right sm:table-cell");
    expect(source).toContain("truncate");
    expect(source).toContain("break-words");
    expect(source).toContain("overflow-x-auto");
  });

  it("houdt statusbadges en acties compact met bruikbare touch targets", () => {
    expect(source).toContain("whitespace-nowrap");
    expect(source).toContain('className="h-9');
    expect(source).not.toContain("min-h-[44px]");
  });

  it("laat de foutmelding netjes teruglopen op smalle schermen", () => {
    expect(source).toMatch(/flex flex-wrap items-center gap-3 rounded-lg border border-destructive/);
  });

  it("laat readiness-redenen teruglopen in plaats van overlopen", () => {
    const src = source;
    expect(src).toMatch(/flex flex-wrap items-center gap-x-2 break-words text-xs text-warning/);
  });

  it("houdt 1799-waarschuwing informatief en zonder dubbele meldingen", () => {
    state.clients = [
      {
        id: "c-1",
        name: "Klant Een",
        organization_id: "org-1",
        bank_dagboek: null,
        inkoop_dagboek: 700,
        verkoop_dagboek: 800,
        debiteuren_rekening_id: "gb-1300",
        crediteuren_rekening_id: "gb-1600",
      },
    ];
    renderDashboard();
    const row = screen.getByText("Klant Een").closest("td")!;
    const text = row.textContent ?? "";
    expect(text).toContain("Bank-dagboek ontbreekt");
    expect(text).toContain("Rekening 1799 ontbreekt");
    expect(text.split("Bank-dagboek ontbreekt").length - 1).toBe(1);
    expect(text.split("Rekening 1799 ontbreekt").length - 1).toBe(1);
  });

  it("voegt geen queries, mutations of supabase-aanroepen toe", () => {
    expect(source).not.toMatch(/supabase\s*\.from\(/);
    expect(source).not.toContain("rpc(");
    expect(source).not.toContain("useMutation");
  });
});
