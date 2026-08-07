import { render, screen, fireEvent, getAllByText } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// ── Mock state knobs ────────────────────────────────────────────────────────
const state = {
  transactions: [] as any[],
  wholeSetLoading: false,
  wholeSetError: false,
};

const makeRow = (id: string, over: Partial<any> = {}) => ({
  id,
  client_id: "c1",
  organization_id: "org-1",
  transaction_date: "2026-01-10",
  description: `Rij ${id}`,
  reference: null,
  counter_account: null,
  counter_account_name: null,
  amount: -25,
  match_status: "niet_gematcht",
  match_confidence: null,
  matched_invoice_id: null,
  matched_invoice_type: null,
  grootboekrekening_id: null,
  ledger_account: null,
  notes: null,
  ...over,
});

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }),
}));

vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));

vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({
    data: [{ id: "c1", name: "Klant 1", btw_status: "btw_plichtig" }],
  }),
}));

vi.mock("@/hooks/useBankTransactions", () => ({
  BANK_TRANSACTIONS_PAGE_SIZE: 50,
  isServerFilterableBankStatus: (s: string) =>
    ["all", "open", "gematcht", "handmatig"].includes(s),
  BANK_STATUS_MATCH_VALUES: {
    all: undefined,
    open: ["niet_gematcht", "suggestie"],
    gematcht: ["gematcht"],
    handmatig: ["handmatig_geboekt"],
  },
  bankSanitizeSearchTerm: (raw: string) => raw.trim(),
  useBankTransactions: () => ({
    data: state.wholeSetError || state.wholeSetLoading ? undefined : state.transactions,
    isLoading: state.wholeSetLoading,
    isError: state.wholeSetError,
    refetch: vi.fn(),
  }),
  usePaginatedBankTransactions: (opts: any) => ({
    data: {
      transactions: state.transactions.slice(
        (opts.page - 1) * 50,
        opts.page * 50,
      ),
      total: state.transactions.length,
    },
    isLoading: false,
    isFetching: false,
    isError: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  }),
  useAddBankTransaction: () => ({ mutateAsync: vi.fn() }),
  useUpdateBankTransaction: () => ({ mutateAsync: vi.fn(() => Promise.resolve({})) }),
}));

vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({ data: [], refetch: vi.fn() }),
  useUpdatePurchaseInvoice: () => ({ mutateAsync: vi.fn(() => Promise.resolve({})) }),
}));

vi.mock("@/hooks/useSalesInvoices", () => ({
  useSalesInvoices: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateSalesInvoice: () => ({ mutateAsync: vi.fn(() => Promise.resolve({})) }),
}));

vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: [] }),
}));

vi.mock("@/hooks/useBookingTemplates", () => ({
  useBookingTemplates: () => ({ data: [] }),
}));

vi.mock("@/hooks/useVraagposten", () => ({
  useVraagposten: () => ({ data: [] }),
  useCreateVraagpost: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/hooks/useBankTransactionAllocations", () => ({
  useBankTransactionAllocations: () => ({ data: [] }),
  useUpsertBankTransactionAllocation: () => ({ mutateAsync: vi.fn() }),
  useDeleteAllocationsForTransaction: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("@/components/BankMatchDialog", () => ({
  BankMatchDialog: () => null,
  rankCandidates: () => [],
}));

vi.mock("@/components/BankStatementUploadDialog", () => ({
  BankStatementUploadDialog: () => null,
}));
vi.mock("@/components/BankAfletteringDrawer", () => ({
  BankAfletteringDrawer: () => null,
}));
vi.mock("@/components/VerwerkingsScherm", () => ({
  VerwerkingsScherm: () => null,
}));
vi.mock("@/components/CreateVraagpostDialog", () => ({
  CreateVraagpostDialog: () => null,
}));
vi.mock("@/components/ClientMultiSelect", () => ({
  ClientMultiSelect: ({ value }: any) => (
    <span data-testid="client-select">client={value.selectedIds.join(",")}</span>
  ),
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: () => null,
}));
vi.mock("@/components/OrganizationSelector", () => ({
  OrganizationSelector: () => null,
}));

import Bank from "@/pages/Bank";

function renderBank(): void {
  render(
    (
      <MemoryRouter initialEntries={["/bank?client=c1"]}>
        <Bank />
      </MemoryRouter>
    ) as ReactNode as any,
  );
}

beforeEach(() => {
  state.transactions = [];
  state.wholeSetLoading = false;
  state.wholeSetError = false;
});

describe("Bank pagina UI", () => {
  it("heeft geen zichtbare paginatitel Bankafschriften — AppHeader toont Bank", () => {
    renderBank();
    const h1 = document.querySelector("h1");
    expect(h1).toBeInTheDocument();
    expect(h1).toHaveTextContent("Bankafschriften");
    expect(h1).toHaveClass("sr-only");
  });

  it("toont status-tabs met de juiste labels", () => {
    renderBank();
    // Each tab label is found as an accessible tab role.
    expect(screen.getByRole("tab", { name: /^Alle/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Open/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Gematcht/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Handmatig/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Blokkeert export/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Onbekende betalingen/ })).toBeInTheDocument();
  });

  it("het tabblad Alle is standaard actief", () => {
    renderBank();
    const allTab = screen.getByRole("tab", { name: /^Alle/ });
    expect(allTab).toHaveAttribute("data-state", "active");
  });

  it("klikken op een tab activeert dat tabblad", () => {
    renderBank();
    const openTab = screen.getByRole("tab", { name: /^Open/ });
    expect(openTab).toHaveAttribute("data-state", "inactive");
    // Radix UI Tabs triggers onValueChange via onMouseDown
    fireEvent.mouseDown(openTab);
    expect(openTab).toHaveAttribute("data-state", "active");
  });

  it("toont het zoekveld", () => {
    renderBank();
    expect(
      screen.getByPlaceholderText(/Zoeken op omschrijving/),
    ).toBeInTheDocument();
  });

  it("toont de vraagpost Select filter", () => {
    renderBank();
    expect(screen.getByText("Alle vraagposten")).toBeInTheDocument();
  });

  it("toont confidence-pills enkel bij statusfilter Open", () => {
    renderBank();
    // Not visible when tab is "all"
    expect(screen.queryByText(/≥90%/)).not.toBeInTheDocument();

    // Switch to Open tab — Radix Tabs fires onValueChange via onMouseDown
    fireEvent.mouseDown(screen.getByRole("tab", { name: /^Open/ }));
    expect(screen.getByText(/≥90%/)).toBeInTheDocument();
    expect(screen.getByText(/60–89%/)).toBeInTheDocument();
    expect(screen.getByText("Geen suggestie")).toBeInTheDocument();
  });

  it("toont aantallen in tabs zodra data beschikbaar is", () => {
    state.transactions = [
      makeRow("t1"),
      makeRow("t2", { match_status: "gematcht" }),
      makeRow("t3", { match_status: "suggestie" }),
    ];
    renderBank();
    const allTab = screen.getByRole("tab", { name: /^Alle/ });
    expect(allTab).toHaveTextContent("3");
    const matchedTab = screen.getByRole("tab", { name: /^Gematcht/ });
    expect(matchedTab).toHaveTextContent("1");
  });

  it("toont de knoppen Upload afschrift, Export Snelstart en Afletterrapport CSV", () => {
    renderBank();
    expect(screen.getByRole("button", { name: /Upload afschrift/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export Snelstart/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Afletterrapport CSV/ })).toBeInTheDocument();
  });

  it("toont rijen in de tabel wanneer transacties aanwezig zijn", () => {
    state.transactions = [
      makeRow("t1", { description: "Huur kantoor uniek beschrijving A", amount: -1200 }),
      makeRow("t2", { description: "Simyo factuur uniek beschrijving B", amount: -45.5, match_status: "gematcht" }),
    ];
    renderBank();
    // Use getAllByText in case descriptions appear in blocker area too
    expect(screen.getAllByText("Huur kantoor uniek beschrijving A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Simyo factuur uniek beschrijving B").length).toBeGreaterThan(0);
  });

  it("toont de lege toestand als er geen transacties zijn maar wel een klant", () => {
    state.transactions = [];
    renderBank();
    expect(
      screen.getByText(/Nog geen transacties. Upload een bankafschrift om te beginnen./),
    ).toBeInTheDocument();
  });

  it("toont de tabel-kolommen Datum, Omschrijving, Bedrag, Status", () => {
    state.transactions = [makeRow("t1")];
    renderBank();
    expect(screen.getByRole("columnheader", { name: /Datum/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Omschrijving/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Bedrag/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Status/ })).toBeInTheDocument();
  });
});
