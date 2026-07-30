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
  salesLoading: false,
  salesError: false,
};

const makeTx = (over: Partial<any> = {}) => ({
  id: "tx-1",
  client_id: "c1",
  organization_id: "org-1",
  transaction_date: "2026-01-10",
  description: "Betaling factuur",
  reference: null,
  counter_account: null,
  counter_account_name: null,
  amount: -100,
  match_status: "suggestie",
  match_confidence: 95,
  matched_invoice_id: null,
  matched_invoice_type: null,
  grootboekrekening_id: null,
  ledger_account: null,
  notes: null,
  ...over,
});

// ── Module mocks ────────────────────────────────────────────────────────────
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }),
}));

vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));

vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c1", name: "Klant 1", btw_status: "btw_plichtig" }] }),
}));

vi.mock("@/hooks/useBankTransactions", () => ({
  BANK_TRANSACTIONS_PAGE_SIZE: 50,
  isServerFilterableBankStatus: () => true,
  useBankTransactions: () => ({
    data: state.wholeSetError ? undefined : state.transactions,
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
  useUpdateBankTransaction: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({ data: [], refetch: vi.fn() }),
  useUpdatePurchaseInvoice: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/hooks/useSalesInvoices", () => ({
  useSalesInvoices: () => ({
    data: state.salesError ? undefined : [],
    isLoading: state.salesLoading,
    isError: state.salesError,
    refetch: vi.fn(),
  }),
  useUpdateSalesInvoice: () => ({ mutateAsync: vi.fn() }),
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

// rankCandidates drives the "safe" criteria; return an exact-amount candidate
// so safety hinges solely on match_confidence in these tests.
vi.mock("@/components/BankMatchDialog", () => ({
  BankMatchDialog: () => null,
  rankCandidates: (tx: any) => [
    {
      id: `inv-${tx.id}`,
      type: tx.amount >= 0 ? "verkoop" : "inkoop",
      number: "F-1",
      amount: Math.abs(tx.amount),
      score: 100,
      isPartialPayment: false,
      reasons: [],
      date: "2026-01-01",
      relation: "Klant 1",
    },
  ],
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
  ClientMultiSelect: () => null,
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: () => null,
}));

import Bank from "@/pages/Bank";

const SELECT_RE = /Selecteer alle veilige suggesties \((\d+)\)/;
const ALL_SELECTED_RE = /Alle veilige suggesties geselecteerd \((\d+)\)/;

function renderBank(): void {
  render(
    <MemoryRouter initialEntries={["/bank"]}>
      <Bank />
    </MemoryRouter> as ReactNode as any,
  );
}

const safeButton = () =>
  screen.queryByRole("button", { name: SELECT_RE }) ??
  screen.queryByRole("button", { name: ALL_SELECTED_RE }) ??
  screen.queryByRole("button", { name: /Selecteer veilige suggesties…/ });

beforeEach(() => {
  state.transactions = [];
  state.pagedTransactions = [];
  state.pagedTotal = 0;
  state.wholeSetLoading = false;
  state.wholeSetError = false;
  state.salesLoading = false;
  state.salesError = false;
});

describe("Bank — Selecteer alle veilige suggesties", () => {
  it("rendert de knop niet zonder veilige suggesties", async () => {
    // Alleen een onzekere suggestie (confidence < 90) ⇒ geen veilige ids.
    state.transactions = [makeTx({ id: "tx-unsafe", match_confidence: 40 })];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();
    await waitFor(() => expect(screen.getByText("Bankafschriften")).toBeInTheDocument());
    expect(safeButton()).toBeNull();
  });

  it("is disabled zolang matchingdata niet gereed is", async () => {
    state.transactions = [makeTx()];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    state.salesLoading = true; // matchingReady === false
    renderBank();
    await waitFor(() => expect(screen.getByText("Bankafschriften")).toBeInTheDocument());
    // Banner is gegate op matchingReady ⇒ knop niet zichtbaar/actief.
    const btn = safeButton();
    if (btn) expect(btn).toBeDisabled();
    else expect(btn).toBeNull();
  });

  it("toont het aantal nog niet geselecteerde veilige suggesties", async () => {
    state.transactions = [
      makeTx({ id: "tx-1" }),
      makeTx({ id: "tx-2", amount: -200 }),
      makeTx({ id: "tx-unsafe", match_confidence: 10, amount: -300 }),
    ];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 3;
    renderBank();
    const btn = await screen.findByRole("button", { name: SELECT_RE });
    expect(btn).toHaveAccessibleName("Selecteer alle veilige suggesties (2)");
    expect(btn).toBeEnabled();
  });

  it("selecteert veilige ids, ook die niet op de huidige pagina staan, en wordt daarna disabled", async () => {
    state.transactions = [
      makeTx({ id: "tx-1" }),
      makeTx({ id: "tx-2", amount: -200 }),
    ];
    // Pagina 2 toont maar één rij; tx-2 is niet zichtbaar.
    state.pagedTransactions = [state.transactions[0]];
    state.pagedTotal = 2;
    renderBank();
    const btn = await screen.findByRole("button", { name: SELECT_RE });
    fireEvent.click(btn);

    // Bulk-toolbar toont het aantal geselecteerde regels vóór verwerking.
    await waitFor(() =>
      expect(screen.getByText(/2 transactie\(s\) geselecteerd/)).toBeInTheDocument(),
    );
    const after = await screen.findByRole("button", { name: ALL_SELECTED_RE });
    expect(after).toHaveAccessibleName("Alle veilige suggesties geselecteerd (2)");
    expect(after).toBeDisabled();
  });

  it("laat bestaande handmatige selecties intact", async () => {
    state.transactions = [
      makeTx({ id: "tx-1" }),
      makeTx({ id: "tx-unsafe", match_confidence: 10, amount: -300 }),
    ];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 2;
    renderBank();

    // Selecteer eerst handmatig de onveilige rij via haar checkbox.
    const rowCheckboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(rowCheckboxes[rowCheckboxes.length - 1]);
    await waitFor(() =>
      expect(screen.getByText(/1 transactie\(s\) geselecteerd/)).toBeInTheDocument(),
    );

    fireEvent.click(await screen.findByRole("button", { name: SELECT_RE }));

    // Handmatige selectie blijft staan naast de toegevoegde veilige suggestie.
    await waitFor(() =>
      expect(screen.getByText(/2 transactie\(s\) geselecteerd/)).toBeInTheDocument(),
    );
  });

  it("toont bij één veilige suggestie het label met (1)", async () => {
    state.transactions = [makeTx({ id: "tx-1" })];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();
    const btn = await screen.findByRole("button", { name: SELECT_RE });
    expect(btn).toHaveAccessibleName("Selecteer alle veilige suggesties (1)");
  });
});
