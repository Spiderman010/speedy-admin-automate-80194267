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
  updateTxCalls: [] as any[],
};

// Default confidence is deliberately 80 (< 90): safety must NOT depend on
// match_confidence — only on direction, exact amount and partial payment.
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
  match_confidence: 80,
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
  useSalesInvoices: () => ({
    data: state.salesError ? undefined : [],
    isLoading: state.salesLoading,
    isError: state.salesError,
    refetch: vi.fn(),
  }),
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

// rankCandidates drives the safe criteria. Per transaction the candidates are
// configured via test-only fields on the tx:
//   __candidate: undefined → one exact-amount candidate in the correct direction (safe);
//                null      → no candidates at all;
//                object    → overrides (type, amount, isPartialPayment, score).
//   __candidates: array of override objects → multiple candidates, returned in
//                 the given (already ranked, best-first) order.
vi.mock("@/components/BankMatchDialog", () => ({
  BankMatchDialog: () => null,
  rankCandidates: (tx: any) => {
    if (tx.__candidate === null) return [];
    const overs: any[] = tx.__candidates ?? [tx.__candidate ?? {}];
    return overs.map((over, i) => ({
      id: over.id ?? (i === 0 ? `inv-${tx.id}` : `inv-${tx.id}-${i}`),
      type: over.type ?? (tx.amount >= 0 ? "verkoop" : "inkoop"),
      name: "Klant 1",
      invoiceNumber: "F-1",
      amount: over.amount ?? Math.abs(tx.amount),
      score: over.score ?? 100,
      isPartialPayment: over.isPartialPayment ?? false,
      reasons: [],
      date: "2026-01-01",
      relation: "Klant 1",
    }));
  },
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

const SELECT_RE = /Selecteer alle veilige matches \((\d+)\)/;
const ALL_SELECTED_RE = /Alle veilige matches geselecteerd \((\d+)\)/;
const BANNER_RE = /(\d+) veilige match(es)? → direct bevestigen/;

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
  screen.queryByRole("button", { name: /Selecteer veilige matches…/ });

beforeEach(() => {
  state.transactions = [];
  state.pagedTransactions = [];
  state.pagedTotal = 0;
  state.wholeSetLoading = false;
  state.wholeSetError = false;
  state.salesLoading = false;
  state.salesError = false;
  state.updateTxCalls = [];
});

describe("Bank — veilige matches (banner + selectieknop)", () => {
  it("telt een exacte match met confidence 80 en status niet_gematcht mee in banner én knop", async () => {
    state.transactions = [makeTx({ id: "tx-1", match_status: "niet_gematcht", match_confidence: 80 })];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();
    const btn = await screen.findByRole("button", { name: SELECT_RE });
    expect(btn).toHaveAccessibleName("Selecteer alle veilige matches (1)");
    expect(screen.getByText(BANNER_RE)).toHaveTextContent("1 veilige match → direct bevestigen");
  });

  it("telt een exacte match met confidence 80 en status suggestie mee in banner én knop", async () => {
    state.transactions = [makeTx({ id: "tx-1", match_status: "suggestie", match_confidence: 80 })];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();
    const btn = await screen.findByRole("button", { name: SELECT_RE });
    expect(btn).toHaveAccessibleName("Selecteer alle veilige matches (1)");
    expect(screen.getByText(BANNER_RE)).toHaveTextContent("1 veilige match → direct bevestigen");
  });

  it("sluit een kandidaat met verkeerde richting uit", async () => {
    // Negatief bedrag verwacht inkoop; kandidaat is verkoop → onveilig.
    state.transactions = [makeTx({ id: "tx-wrong", __candidate: { type: "verkoop" } })];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();
    await waitFor(() => expect(screen.getByText("Bankafschriften")).toBeInTheDocument());
    expect(safeButton()).toBeNull();
    expect(screen.queryByText(BANNER_RE)).toBeNull();
  });

  it("sluit een bedragverschil groter dan €0,01 uit", async () => {
    state.transactions = [makeTx({ id: "tx-diff", amount: -100, __candidate: { amount: 100.05 } })];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();
    await waitFor(() => expect(screen.getByText("Bankafschriften")).toBeInTheDocument());
    expect(safeButton()).toBeNull();
    expect(screen.queryByText(BANNER_RE)).toBeNull();
  });

  it("sluit een deelbetaling uit", async () => {
    state.transactions = [makeTx({ id: "tx-partial", __candidate: { isPartialPayment: true } })];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();
    await waitFor(() => expect(screen.getByText("Bankafschriften")).toBeInTheDocument());
    expect(safeButton()).toBeNull();
    expect(screen.queryByText(BANNER_RE)).toBeNull();
  });

  it("banner-aantal en knop-aantal zijn identiek bij een gemengde set", async () => {
    state.transactions = [
      makeTx({ id: "tx-1", match_status: "niet_gematcht" }),
      makeTx({ id: "tx-2", match_status: "suggestie", amount: -200 }),
      makeTx({ id: "tx-unsafe", amount: -300, __candidate: { isPartialPayment: true } }),
    ];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 3;
    renderBank();
    const btn = await screen.findByRole("button", { name: SELECT_RE });
    const bannerCount = Number(screen.getByText(BANNER_RE).textContent!.match(BANNER_RE)![1]);
    const buttonCount = Number(btn.getAttribute("aria-label")!.match(SELECT_RE)![1]);
    expect(bannerCount).toBe(2);
    expect(buttonCount).toBe(bannerCount);
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

  it("selecteert veilige ids, ook die niet op de huidige pagina staan, en wordt daarna disabled", async () => {
    state.transactions = [
      makeTx({ id: "tx-1", match_status: "niet_gematcht" }),
      makeTx({ id: "tx-2", amount: -200 }),
    ];
    // De pagina toont maar één rij; tx-2 is niet zichtbaar.
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
    expect(after).toHaveAccessibleName("Alle veilige matches geselecteerd (2)");
    expect(after).toBeDisabled();
  });

  it("laat bestaande handmatige selecties intact", async () => {
    state.transactions = [
      makeTx({ id: "tx-1" }),
      makeTx({ id: "tx-unsafe", amount: -300, __candidate: { amount: 350 } }),
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

    // Handmatige selectie blijft staan naast de toegevoegde veilige match.
    await waitFor(() =>
      expect(screen.getByText(/2 transactie\(s\) geselecteerd/)).toBeInTheDocument(),
    );
  });

  it("bulk-bevestiging verwerkt exact dezelfde veilige ids, inclusief niet_gematcht", async () => {
    state.transactions = [
      makeTx({ id: "tx-1", match_status: "niet_gematcht" }),
      makeTx({ id: "tx-2", match_status: "suggestie", amount: -200 }),
      makeTx({ id: "tx-unsafe", amount: -300, __candidate: { isPartialPayment: true } }),
    ];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 3;
    renderBank();

    // Selecteer ook de onveilige rij handmatig: bulk-bevestiging moet die overslaan.
    const rowCheckboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(rowCheckboxes[rowCheckboxes.length - 1]);
    fireEvent.click(await screen.findByRole("button", { name: SELECT_RE }));
    await waitFor(() =>
      expect(screen.getByText(/3 transactie\(s\) geselecteerd/)).toBeInTheDocument(),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Veilige matches bevestigen \(2\)/ }),
    );

    await waitFor(() => expect(state.updateTxCalls.length).toBeGreaterThanOrEqual(2));
    const confirmed = state.updateTxCalls.filter(c => c.match_status === "gematcht");
    expect(confirmed.map(c => c.id).sort()).toEqual(["tx-1", "tx-2"]);
    expect(confirmed.map(c => c.matched_invoice_id).sort()).toEqual(["inv-tx-1", "inv-tx-2"]);
    // De onveilige rij is nooit bevestigd.
    expect(state.updateTxCalls.some(c => c.id === "tx-unsafe")).toBe(false);
  });

  it("toont bij één veilige match het label met (1)", async () => {
    state.transactions = [makeTx({ id: "tx-1" })];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();
    const btn = await screen.findByRole("button", { name: SELECT_RE });
    expect(btn).toHaveAccessibleName("Selecteer alle veilige matches (1)");
  });

  it("valt nooit terug op een lager gerangschikte factuur als de topkandidaat een deelbetaling is", async () => {
    // Topkandidaat (score 100): deelbetaling, €200. Lagere kandidaat (score 80):
    // exact €100, geen deelbetaling. Transactie €100. De topkandidaat faalt de
    // validatie ⇒ de transactie is NIET veilig; de lagere exacte factuur mag
    // nooit als betaald worden gemarkeerd.
    state.transactions = [
      makeTx({
        id: "tx-rank",
        amount: -100,
        match_status: "niet_gematcht",
        __candidates: [
          { score: 100, isPartialPayment: true, amount: 200 },
          { score: 80, isPartialPayment: false, amount: 100 },
        ],
      }),
    ];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();
    await waitFor(() => expect(screen.getByText("Bankafschriften")).toBeInTheDocument());

    // Niet in bannertelling, niet in knoptelling.
    expect(screen.queryByText(BANNER_RE)).toBeNull();
    expect(safeButton()).toBeNull();

    // Handmatig selecteren geeft géén bulk-bevestigingsknop (0 veilige ids)
    // en er vindt geen enkele match-mutatie plaats.
    const rowCheckboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(rowCheckboxes[rowCheckboxes.length - 1]);
    await waitFor(() =>
      expect(screen.getByText(/1 transactie\(s\) geselecteerd/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /Veilige matches bevestigen/ })).toBeNull();
    expect(state.updateTxCalls.filter(c => c.match_status === "gematcht")).toEqual([]);
  });

  it("valt nooit terug op een lager gerangschikte factuur als de topkandidaat een bedragverschil heeft", async () => {
    // Topkandidaat (score 100): geen deelbetaling maar €200 op een transactie
    // van €100. Lagere kandidaat (score 80): exact €100. De topkandidaat faalt
    // de bedragvalidatie ⇒ NIET veilig; de lagere kandidaat wordt nooit gekozen.
    state.transactions = [
      makeTx({
        id: "tx-rank2",
        amount: -100,
        match_status: "suggestie",
        __candidates: [
          { score: 100, isPartialPayment: false, amount: 200 },
          { score: 80, isPartialPayment: false, amount: 100 },
        ],
      }),
    ];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();
    await waitFor(() => expect(screen.getByText("Bankafschriften")).toBeInTheDocument());

    expect(screen.queryByText(BANNER_RE)).toBeNull();
    expect(safeButton()).toBeNull();
    // Rijknop toont "Controleer" (handmatige beoordeling), niet "✓ Bevestig".
    expect(screen.getByRole("button", { name: "Controleer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "✓ Bevestig" })).toBeNull();
    expect(state.updateTxCalls.filter(c => c.match_status === "gematcht")).toEqual([]);
  });

  it("verwerkt een exacte, correcte topkandidaat normaal, ook met lagere kandidaten erachter", async () => {
    state.transactions = [
      makeTx({
        id: "tx-top",
        amount: -100,
        match_status: "niet_gematcht",
        __candidates: [
          { score: 100, isPartialPayment: false, amount: 100 },
          { score: 80, isPartialPayment: false, amount: 100 },
        ],
      }),
    ];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();

    const btn = await screen.findByRole("button", { name: SELECT_RE });
    expect(btn).toHaveAccessibleName("Selecteer alle veilige matches (1)");
    expect(screen.getByText(BANNER_RE)).toHaveTextContent("1 veilige match → direct bevestigen");

    fireEvent.click(btn);
    fireEvent.click(
      await screen.findByRole("button", { name: /Veilige matches bevestigen \(1\)/ }),
    );

    await waitFor(() => {
      const confirmed = state.updateTxCalls.filter(c => c.match_status === "gematcht");
      expect(confirmed).toHaveLength(1);
      // De hoogst gerangschikte kandidaat wordt gekoppeld, niet de lagere.
      expect(confirmed[0].id).toBe("tx-top");
      expect(confirmed[0].matched_invoice_id).toBe("inv-tx-top");
    });
  });

  it("heeft op mobiel een interactieve hoogte van minimaal 44px", async () => {
    state.transactions = [makeTx({ id: "tx-1" })];
    state.pagedTransactions = state.transactions;
    state.pagedTotal = 1;
    renderBank();
    const btn = await screen.findByRole("button", { name: SELECT_RE });
    // 44px op mobiel; sm:min-h-0 laat desktop de compacte sm-hoogte behouden.
    expect(btn.className).toContain("min-h-[44px]");
    expect(btn.className).toContain("sm:min-h-0");
  });
});
