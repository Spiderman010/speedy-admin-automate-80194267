import { fireEvent, render, screen, within } from "@testing-library/react";
// Overzichten bevat sinds 6C-b7 PR 3 een <Link> naar de proef- en saldibalans.
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const state = {
  selectedClientId: "c1",
  invoices: [] as any[],
  isLoading: false,
  isError: false,
};

const refetchSpy = vi.fn();
const setSelectedClientIdSpy = vi.fn();

const query = (data: any[]) => ({
  data: state.isLoading || state.isError ? undefined : data,
  isLoading: state.isLoading,
  isError: state.isError,
  refetch: refetchSpy,
});

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.selectedClientId, setSelectedClientId: setSelectedClientIdSpy }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => query([
    { id: "c1", name: "Administratie Jansen en Partners Holding B.V.", bank_dagboek: 1100 },
    { id: "c2", name: "Bakkerij De Hoek", bank_dagboek: 1100 },
  ]),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({ usePurchaseInvoices: () => query(state.invoices) }));
vi.mock("@/hooks/useJournalEntries", () => ({ useJournalEntries: () => query([]) }));
vi.mock("@/hooks/useBankTransactions", () => ({ useBankTransactions: () => query([]) }));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({ useActiveGrootboekrekeningen: () => query([]) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/snelstart-export", () => ({ exportAllForClient: vi.fn(() => Promise.resolve()) }));

import Overzichten from "@/pages/Overzichten";

const source = readFileSync(path.resolve(__dirname, "../pages/Overzichten.tsx"), "utf8");

beforeEach(() => {
  vi.clearAllMocks();
  state.selectedClientId = "c1";
  state.invoices = [];
  state.isLoading = false;
  state.isError = false;
});

describe("Rapportages pagina", () => {
  it("rendert de paginakop en de toegankelijke administratiekeuze", () => {
    render(<MemoryRouter><Overzichten /></MemoryRouter>);
    expect(screen.getByRole("heading", { level: 1, name: "Rapportages" })).toBeInTheDocument();
    expect(screen.getByText("Financiële overzichten per administratie")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Administratie selecteren" })).toBeInTheDocument();
  });

  /*
   * Dit legde eerder "alle VIJF rapportkaarten" vast, met een telling van hoe
   * vaak "Beschikbaar" voorkomt. Dat was waar op dat moment, maar het is geen
   * INVARIANT: elk rapport dat later wordt opgeleverd — de controle van
   * Diagnostics v1 bijvoorbeeld — laat zo'n telling omvallen terwijl er niets
   * mis is. Zelfde afweging als in `src/test/support/branch-sql-scope.ts`.
   *
   * Wat de test werkelijk beschermde: elke kaart draagt zijn status als TEKST
   * (niet alleen als kleur), en elk rapport heeft de status die erbij hoort.
   * Dat wordt nu per kaart vastgelegd, wat sterker is dan een totaal.
   */
  it("rendert elke rapportkaart met zijn eigen tekstuele beschikbaarheidsstatus", () => {
    render(<MemoryRouter><Overzichten /></MemoryRouter>);
    const verwacht: Record<string, string> = {
      "Proef- en saldibalans": "Beschikbaar",
      "Balans": "Beschikbaar",
      "Winst-en-verliesrekening": "Beschikbaar",
      "Controle": "Beschikbaar",
      "Grootboek": "Nog niet beschikbaar",
      "BTW-overzicht": "Nog niet beschikbaar",
    };
    for (const [title, status] of Object.entries(verwacht)) {
      const kop = screen.getByRole("heading", { level: 3, name: title });
      const kaart = kop.closest("div.min-h-32");
      expect(kaart, title).not.toBeNull();
      // Exacte match op het statuselement zelf: "Nog niet beschikbaar" mag
      // nooit als "Beschikbaar" wegkomen omdat het er toevallig in zit.
      expect(within(kaart as HTMLElement).getByText(status), title).toBeInTheDocument();
    }
    // Geen enkele kaart draagt een status die het product niet kent.
    expect(screen.queryByText("Beschikbaar na openingsbalans")).toBeNull();
  });

  it("toont niet-werkende periodefilters uitgeschakeld", () => {
    render(<MemoryRouter><Overzichten /></MemoryRouter>);
    expect(screen.getByRole("combobox", { name: "Boekjaar nog niet beschikbaar" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Periode nog niet beschikbaar" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Vergelijking nog niet beschikbaar" })).toBeDisabled();
  });

  it("toont een duidelijke lege staat zonder administratie", () => {
    state.selectedClientId = "all";
    render(<MemoryRouter><Overzichten /></MemoryRouter>);
    expect(screen.getByText("Selecteer een administratie om rapportages te bekijken.")).toBeInTheDocument();
    expect(screen.queryByText("€ 0,00")).not.toBeInTheDocument();
  });

  it("toont ontbrekende financiële data niet als nulbedragen", () => {
    render(<MemoryRouter><Overzichten /></MemoryRouter>);
    expect(screen.getByText("Geen financiële gegevens beschikbaar")).toBeInTheDocument();
    expect(screen.queryByText("€ 0,00")).not.toBeInTheDocument();
  });

  it("toont skeletons tijdens laden", () => {
    state.isLoading = true;
    const { container } = render(<MemoryRouter><Overzichten /></MemoryRouter>);
    expect(screen.getByLabelText("Rapportages laden")).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("toont een foutmelding en gebruikt alleen bestaande refetch-acties", () => {
    state.isError = true;
    render(<MemoryRouter><Overzichten /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Opnieuw proberen" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Rapportagegegevens konden niet worden geladen.");
    expect(refetchSpy).toHaveBeenCalledTimes(5);
  });

  it("houdt het bestaande overzicht en recente facturen bereikbaar", () => {
    state.invoices = [{
      id: "i1",
      supplier: "Leverancier met een uitzonderlijk lange handelsnaam B.V.",
      invoice_number: "INV-2026-001",
      invoice_date: "2026-09-01",
      amount_excl: 100,
      btw_amount: 21,
      amount_incl: 121,
    }];
    render(<MemoryRouter><Overzichten /></MemoryRouter>);
    expect(screen.getByRole("heading", { level: 2, name: "Brondocumenten van deze administratie" })).toBeInTheDocument();
    expect(screen.getByText("Recente inkoopfacturen")).toBeInTheDocument();
    expect(screen.getByText("INV-2026-001")).toBeInTheDocument();
    expect(screen.getByText("Leverancier met een uitzonderlijk lange handelsnaam B.V.")).toHaveAttribute(
      "title",
      "Leverancier met een uitzonderlijk lange handelsnaam B.V.",
    );
  });

  it("stapelt en schaalt de werkruimte responsief zonder pagina-overloop", () => {
    render(<MemoryRouter><Overzichten /></MemoryRouter>);
    const workspace = screen.getByRole("heading", { level: 1, name: "Rapportages" }).closest("div.min-w-0");
    expect(workspace).toHaveClass("overflow-x-hidden");
    expect(source).toContain("grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5");
    expect(source).toContain("overflow-x-auto");
    expect(source).toContain("h-9 w-full");
  });

  it("introduceert geen database-mutatie of nieuwe financiële rekenformule", () => {
    expect(source).not.toMatch(/supabase\s*\.from\(/);
    expect(source).not.toContain("useMutation");
    expect(source).not.toContain("ledger_postings");
    expect(source.match(/\.reduce\(/g)).toHaveLength(3);
    expect(source).toContain("s + (i.amount_incl ?? 0)");
    expect(source).toContain("s + (i.btw_amount ?? 0)");
    expect(source).toContain("s + e.amount");
  });
});