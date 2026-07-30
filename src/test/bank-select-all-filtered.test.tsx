import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// ── Mock state knobs ────────────────────────────────────────────────────────
const state = {
  transactions: [] as any[],
  pagedTransactions: [] as any[],
  pagedTotal: 0,
  wholeSetLoading: false,
  wholeSetError: false,
  updateTxCalls: [] as any[],
};

// 83 filtered transactions: the first 12 match the search term "subscriptie",
// the rest do not. All niet_gematcht, without invoice candidates, so the
// safe-match banner never interferes with these tests.
function seedTransactions(count = 83): void {
  state.transactions = Array.from({ length: count }, (_, i) => ({
    id: `t-${i + 1}`,
    client_id: "c1",
    organization_id: "org-1",
    transaction_date: "2026-01-10",
    description: i < 12 ? `Subscriptie dienst ${i + 1}` : `Betaling ${i + 1}`,
    reference: null,
    counter_account: null,
    counter_account_name: null,
    amount: -(10 + i),
    match_status: "niet_gematcht",
    match_confidence: null,
    matched_invoice_id: null,
    matched_invoice_type: null,
    grootboekrekening_id: null,
    ledger_account: null,
    notes: null,
    __candidate: null,
  }));
  state.pagedTransactions = state.transactions.slice(0, 50);
  state.pagedTotal = count;
}

// ── Module mocks ────────────────────────────────────────────────────────────
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }),
}));

vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));

vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({
    data: [
      { id: "c1", name: "Klant 1", btw_status: "btw_plichtig" },
      { id: "c2", name: "Klant 2", btw_status: "btw_plichtig" },
    ],
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
  bankSanitizeSearchTerm: (raw: string) =>
    raw.trim().replace(/[,()"']/g, " ").replace(/[%_]/g, (m: string) => `\\${m}`).replace(/\s+/g, " ").trim(),
  useBankTransactions: () => ({
    data: state.wholeSetError || state.wholeSetLoading ? undefined : state.transactions,
    isLoading: state.wholeSetLoading,
    isError: state.wholeSetError,
    refetch: vi.fn(),
  }),
  usePaginatedBankTransactions: () => ({
    data: { transactions: state.pagedTransactions, total: state.pagedTotal },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useAddBankTransaction: () => ({ mutateAsync: vi.fn() }),
  useUpdateBankTransaction: () => ({
    mutateAsync: vi.fn((args: any) => {
      state.updateTxCalls.push(args);
      return Promise.resolve({});
    }),
  }),
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
  rankCandidates: (tx: any) => (tx.__candidate === null ? [] : []),
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
// Renders a plain button so tests can switch the client selection without
// driving the real multiselect UI.
vi.mock("@/components/ClientMultiSelect", () => ({
  ClientMultiSelect: ({ onChange }: any) => (
    <button type="button" onClick={() => onChange({ allMode: false, selectedIds: ["c2"] })}>
      __switch-client
    </button>
  ),
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: () => null,
}));

import Bank from "@/pages/Bank";

const SELECT_ALL_FILTERED_RE = /Selecteer alle (\d+) gefilterde transacties/;
const PAGE_NOTICE_RE = /Alle (\d+) transacties op deze pagina zijn geselecteerd\./;
const FULL_NOTICE_RE = /Alle (\d+) gefilterde transacties zijn geselecteerd/;
const TOOLBAR_RE = /(\d+) transactie\(s\) geselecteerd/;

function renderBank(): void {
  render(
    <MemoryRouter initialEntries={["/bank"]}>
      <Bank />
    </MemoryRouter> as ReactNode as any,
  );
}

async function selectCurrentPage(): Promise<void> {
  const header = await screen.findByRole("checkbox", { name: "Selecteer alle rijen op deze pagina" });
  fireEvent.click(header);
  await waitFor(() => expect(screen.getByText(TOOLBAR_RE)).toBeInTheDocument());
}

beforeEach(() => {
  seedTransactions();
  state.wholeSetLoading = false;
  state.wholeSetError = false;
  state.updateTxCalls = [];
});

describe("Bank — alle gefilterde transacties selecteren", () => {
  it("header-selectie selecteert precies de 50 zichtbare rijen en biedt de 83 gefilterde aan", async () => {
    renderBank();
    await selectCurrentPage();

    expect(screen.getByText("50 transactie(s) geselecteerd")).toBeInTheDocument();
    expect(screen.getByText(PAGE_NOTICE_RE)).toHaveTextContent(
      "Alle 50 transacties op deze pagina zijn geselecteerd.",
    );
    const action = screen.getByRole("button", { name: SELECT_ALL_FILTERED_RE });
    expect(action).toHaveAccessibleName("Selecteer alle 83 gefilterde transacties");
    // Selecting rows never performs a mutation.
    expect(state.updateTxCalls).toEqual([]);
  });

  it("volledige selectie bevat alle 83 ids, ook buiten de huidige pagina, zonder enige mutatie", async () => {
    renderBank();
    await selectCurrentPage();
    fireEvent.click(screen.getByRole("button", { name: SELECT_ALL_FILTERED_RE }));

    // 83 selected while only 50 rows are visible ⇒ off-page ids included.
    await waitFor(() =>
      expect(screen.getByText("83 transactie(s) geselecteerd")).toBeInTheDocument(),
    );
    expect(screen.getAllByText(FULL_NOTICE_RE).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Selectie wissen" })).toBeInTheDocument();
    expect(state.updateTxCalls).toEqual([]);
  });

  it("Selectie wissen leegt de selectie en verbergt de bulk-toolbar", async () => {
    renderBank();
    await selectCurrentPage();
    fireEvent.click(screen.getByRole("button", { name: SELECT_ALL_FILTERED_RE }));
    await waitFor(() =>
      expect(screen.getByText("83 transactie(s) geselecteerd")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Selectie wissen" }));
    await waitFor(() => expect(screen.queryByText(TOOLBAR_RE)).toBeNull());
  });

  it("wijziging van de zoektekst (scope 83 → 12) wist de oude selectie", async () => {
    renderBank();
    await selectCurrentPage();
    fireEvent.click(screen.getByRole("button", { name: SELECT_ALL_FILTERED_RE }));
    await waitFor(() =>
      expect(screen.getByText("83 transactie(s) geselecteerd")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByPlaceholderText(/Zoeken op omschrijving/), {
      target: { value: "subscriptie" },
    });
    // Debounced search updates the selection scope ⇒ selection cleared.
    await waitFor(() => expect(screen.queryByText(TOOLBAR_RE)).toBeNull());
  });

  it("wisselen van klant wist de oude selectie", async () => {
    renderBank();
    await selectCurrentPage();
    expect(screen.getByText("50 transactie(s) geselecteerd")).toBeInTheDocument();

    fireEvent.click(screen.getAllByText("__switch-client")[0]);
    await waitFor(() => expect(screen.queryByText(TOOLBAR_RE)).toBeNull());
  });

  it("alleen pagina of sorteervolgorde wijzigen behoudt de selectie (ook handmatige)", async () => {
    renderBank();
    // Handmatige selectie van één rij (eerste rij-checkbox na de header).
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);
    await waitFor(() =>
      expect(screen.getByText("1 transactie(s) geselecteerd")).toBeInTheDocument(),
    );

    // Sorteren: presentatie, geen membership ⇒ selectie blijft.
    fireEvent.click(screen.getByText("Bedrag"));
    expect(screen.getByText("1 transactie(s) geselecteerd")).toBeInTheDocument();

    // Pagineren: presentatie, geen membership ⇒ selectie blijft.
    fireEvent.click(screen.getByRole("button", { name: /Volgende/ }));
    await waitFor(() =>
      expect(screen.getByText("1 transactie(s) geselecteerd")).toBeInTheDocument(),
    );
  });

  it("volledige selectie blijft behouden bij paginanavigatie", async () => {
    renderBank();
    await selectCurrentPage();
    fireEvent.click(screen.getByRole("button", { name: SELECT_ALL_FILTERED_RE }));
    await waitFor(() =>
      expect(screen.getByText("83 transactie(s) geselecteerd")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Volgende/ }));
    await waitFor(() =>
      expect(screen.getByText("83 transactie(s) geselecteerd")).toBeInTheDocument(),
    );
  });

  it("biedt de volledige selectie niet aan terwijl de whole-set laadt", async () => {
    state.wholeSetLoading = true;
    renderBank();
    await selectCurrentPage();

    expect(screen.getByText("50 transactie(s) geselecteerd")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: SELECT_ALL_FILTERED_RE })).toBeNull();
    expect(screen.queryByText(PAGE_NOTICE_RE)).toBeNull();
  });

  it("biedt de volledige selectie niet aan wanneer de whole-set in fout is", async () => {
    state.wholeSetError = true;
    renderBank();
    await selectCurrentPage();

    expect(screen.getByText("50 transactie(s) geselecteerd")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: SELECT_ALL_FILTERED_RE })).toBeNull();
  });

  it("acties hebben een 44px-minimumhoogte op mobiel en dynamische toegankelijke namen", async () => {
    renderBank();
    await selectCurrentPage();

    const action = screen.getByRole("button", { name: SELECT_ALL_FILTERED_RE });
    expect(action.getAttribute("aria-label")).toBe("Selecteer alle 83 gefilterde transacties");
    expect(action.className).toContain("min-h-[44px]");
    expect(action.className).toContain("sm:min-h-0");

    fireEvent.click(action);
    const clear = await screen.findByRole("button", { name: "Selectie wissen" });
    expect(clear.className).toContain("min-h-[44px]");
    expect(clear.className).toContain("sm:min-h-0");
  });
});
