import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// ── Mock state knobs ────────────────────────────────────────────────────────
const state = {
  transactions: [] as any[],
  rejections: [] as any[],
  rejectionsLoading: false,
  rejectionsError: false,
  purchaseInvoices: [] as any[],
  allocations: [] as any[],
  updateTxCalls: [] as any[],
  rejectionAdds: [] as any[],
  rejectionClears: [] as any[],
  allocationUpserts: [] as any[],
  failNextClear: false,
};

const makeTx = (over: Partial<any> = {}) => ({
  id: "tx-1",
  client_id: "c1",
  organization_id: "org-1",
  transaction_date: "2026-01-10",
  description: "Betaling Simyo",
  reference: null,
  counter_account: null,
  counter_account_name: null,
  amount: -100,
  match_status: "niet_gematcht",
  match_confidence: null,
  matched_invoice_id: null,
  grootboekrekening_id: null,
  ledger_account: null,
  notes: null,
  ...over,
});

const makeRejection = (txId: string, invoiceId: string) => ({
  id: `rej-${txId}-${invoiceId}`,
  organization_id: "org-1",
  client_id: "c1",
  bank_transaction_id: txId,
  invoice_id: invoiceId,
  invoice_type: "inkoop",
  rejected_by: "user-1",
  created_at: "2026-01-01T00:00:00Z",
});

const makePurchaseInvoice = (id: string, over: Partial<any> = {}) => ({
  id,
  client_id: "c1",
  organization_id: "org-1",
  supplier: "Simyo",
  invoice_number: `F-${id}`,
  invoice_date: "2026-01-01",
  amount_excl: 100,
  amount_incl: 100,
  remaining_amount: 100,
  status: "gecontroleerd",
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
  BANK_STATUS_MATCH_VALUES: {
    all: undefined,
    open: ["niet_gematcht", "suggestie"],
    gematcht: ["gematcht"],
    handmatig: ["handmatig_geboekt"],
  },
  bankSanitizeSearchTerm: (raw: string) => raw.trim(),
  useBankTransactions: () => ({
    data: state.transactions,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  usePaginatedBankTransactions: () => ({
    data: { transactions: state.transactions, total: state.transactions.length },
    isLoading: false,
    isFetching: false,
    isError: false,
    isPlaceholderData: false,
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
  usePurchaseInvoices: () => ({ data: state.purchaseInvoices, refetch: vi.fn() }),
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
  useBankTransactionAllocations: () => ({ data: state.allocations }),
  useUpsertBankTransactionAllocation: () => ({
    mutateAsync: vi.fn((args: any) => {
      state.allocationUpserts.push(args);
      return Promise.resolve({});
    }),
  }),
  useDeleteAllocationsForTransaction: () => ({ mutateAsync: vi.fn(() => Promise.resolve()) }),
}));

// Minimal chainable so the live-allocation lookup inside the match flow
// resolves to an empty result instead of crashing.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({ data: [], error: null })),
      })),
    })),
    rpc: vi.fn(),
  },
}));

// Hooks are mocked with recording knobs; the REAL pure helpers
// (buildRejectionMap, filterRejectedCandidates) are kept via importOriginal so
// these tests exercise the actual shared rejection predicate.
vi.mock("@/hooks/useBankMatchRejections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useBankMatchRejections")>();
  return {
    ...actual,
    useBankMatchRejections: () => ({
      data: state.rejectionsLoading || state.rejectionsError ? undefined : state.rejections,
      isLoading: state.rejectionsLoading,
      isError: state.rejectionsError,
      refetch: vi.fn(),
    }),
    useAddBankMatchRejection: () => ({
      mutateAsync: vi.fn((args: any) => {
        state.rejectionAdds.push(args);
        return Promise.resolve();
      }),
    }),
    useClearBankMatchRejection: () => ({
      mutateAsync: vi.fn((args: any) => {
        state.rejectionClears.push(args);
        if (state.failNextClear) {
          state.failNextClear = false;
          return Promise.reject(new Error("clear mislukt"));
        }
        return Promise.resolve();
      }),
    }),
  };
});

// rankCandidates drives matching. Per transaction:
//   __candidate: null → no candidates; object → single candidate overrides.
//   __candidates: array of overrides (already ranked, best-first).
// Candidate ids default to inv-<txid> and can be overridden per entry.
vi.mock("@/components/BankMatchDialog", () => ({
  BankMatchDialog: ({ open, transaction, onConfirm }: any) =>
    open && transaction ? (
      <>
        <button
          type="button"
          onClick={() => onConfirm(transaction.id, "inv-A", "inkoop", true, false, null)}
        >
          __dialog-confirm-inv-A
        </button>
        <button
          type="button"
          onClick={() => onConfirm(transaction.id, "inv-A", "inkoop", false, false, null, 60)}
        >
          __dialog-confirm-extra-inv-A
        </button>
      </>
    ) : null,
  rankCandidates: (tx: any) => {
    if (tx.__candidate === null) return [];
    const overs: any[] = tx.__candidates ?? [tx.__candidate ?? {}];
    return overs.map((over, i) => ({
      id: over.id ?? (i === 0 ? `inv-${tx.id}` : `inv-${tx.id}-${i}`),
      type: over.type ?? (tx.amount >= 0 ? "verkoop" : "inkoop"),
      name: "Simyo",
      invoiceNumber: "F-1",
      amount: over.amount ?? Math.abs(tx.amount),
      score: over.score ?? 100,
      isPartialPayment: over.isPartialPayment ?? false,
      reasons: [],
      date: "2026-01-01",
      relation: "Simyo",
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
  VerwerkingsScherm: ({ open, onMatchInvoice }: any) =>
    open ? (
      <button type="button" onClick={() => onMatchInvoice("tx-1", "inv-A", "inkoop")}>
        __verwerk-match-inv-A
      </button>
    ) : null,
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
import { buildRejectionMap, filterRejectedCandidates } from "@/hooks/useBankMatchRejections";

const BANNER_RE = /(\d+) veilige match(es)? → direct bevestigen/;
const SELECT_RE = /Selecteer alle veilige matches \((\d+)\)/;

function renderBank(): void {
  render(
    <MemoryRouter initialEntries={["/bank"]}>
      <Bank />
    </MemoryRouter> as ReactNode as any,
  );
}

const gematchtCalls = () => state.updateTxCalls.filter(c => c.match_status === "gematcht");

beforeEach(() => {
  state.transactions = [];
  state.rejections = [];
  state.rejectionsLoading = false;
  state.rejectionsError = false;
  state.purchaseInvoices = [];
  state.allocations = [];
  state.updateTxCalls = [];
  state.rejectionAdds = [];
  state.rejectionClears = [];
  state.allocationUpserts = [];
  state.failNextClear = false;
});

describe("pure helpers (shared rejection predicate)", () => {
  it("buildRejectionMap groups invoice ids per transaction", () => {
    const map = buildRejectionMap([
      makeRejection("t1", "inv-A"),
      makeRejection("t1", "inv-B"),
      makeRejection("t2", "inv-A"),
    ] as any);
    expect(map.get("t1")).toEqual(new Set(["inv-A", "inv-B"]));
    expect(map.get("t2")).toEqual(new Set(["inv-A"]));
    expect(map.get("t3")).toBeUndefined();
  });

  it("filterRejectedCandidates removes only the rejected ids", () => {
    const cands = [{ id: "inv-A" }, { id: "inv-B" }] as any;
    expect(filterRejectedCandidates(cands, new Set(["inv-A"]))).toEqual([{ id: "inv-B" }]);
    expect(filterRejectedCandidates(cands, undefined)).toBe(cands);
    expect(filterRejectedCandidates(cands, new Set())).toBe(cands);
  });
});

describe("Bank — afwijzingen worden vastgelegd en gerespecteerd", () => {
  it("A1: Afwijzen legt de exacte combinatie vast vóór het loskoppelen", async () => {
    state.transactions = [
      makeTx({ id: "tx-1", match_status: "suggestie", match_confidence: 80, matched_invoice_id: "inv-A", __candidate: { id: "inv-A" } }),
    ];
    state.purchaseInvoices = [makePurchaseInvoice("inv-A")];
    renderBank();

    fireEvent.click(await screen.findByRole("button", { name: "Afwijzen" }));

    await waitFor(() => expect(state.rejectionAdds).toHaveLength(1));
    expect(state.rejectionAdds[0]).toEqual({
      organization_id: "org-1",
      client_id: "c1",
      bank_transaction_id: "tx-1",
      invoice_id: "inv-A",
      invoice_type: "inkoop",
    });
    // Daarna pas de reset van de transactie.
    await waitFor(() =>
      expect(state.updateTxCalls).toContainEqual({
        id: "tx-1",
        match_status: "niet_gematcht",
        matched_invoice_id: null,
        match_confidence: null,
      }),
    );
  });

  it("A2: een afgewezen factuur wordt niet opnieuw voorgesteld voor dezelfde transactie", async () => {
    state.transactions = [makeTx({ id: "tx-1", __candidate: { id: "inv-A" } })];
    state.rejections = [makeRejection("tx-1", "inv-A")];
    renderBank();
    await waitFor(() => expect(screen.getByText("Bankafschriften")).toBeInTheDocument());

    // Geen veilige match meer, geen auto-scan banner, geen bevestiging mogelijk.
    expect(screen.queryByText(BANNER_RE)).toBeNull();
    expect(screen.queryByRole("button", { name: SELECT_RE })).toBeNull();
    expect(screen.queryByRole("button", { name: /Automatisch voorstellen/ })).toBeNull();
    expect(gematchtCalls()).toEqual([]);
  });

  it("B: na afwijzing van factuur A blijft factuur B gewoon voorstelbaar en wordt B gekoppeld", async () => {
    state.transactions = [
      makeTx({
        id: "tx-1",
        __candidates: [
          { id: "inv-A", score: 100 },
          { id: "inv-B", score: 80 },
        ],
      }),
    ];
    state.rejections = [makeRejection("tx-1", "inv-A")];
    state.purchaseInvoices = [makePurchaseInvoice("inv-A"), makePurchaseInvoice("inv-B")];
    renderBank();

    // B is nu de topkandidaat en veilig.
    const btn = await screen.findByRole("button", { name: SELECT_RE });
    fireEvent.click(btn);
    fireEvent.click(await screen.findByRole("button", { name: /Veilige matches bevestigen \(1\)/ }));

    await waitFor(() => expect(gematchtCalls()).toHaveLength(1));
    expect(gematchtCalls()[0].matched_invoice_id).toBe("inv-B");
    expect(state.updateTxCalls.some(c => c.matched_invoice_id === "inv-A")).toBe(false);
  });

  it("C: een afwijzing geldt alleen voor die transactie — dezelfde factuur blijft geldig voor een andere", async () => {
    state.transactions = [
      makeTx({ id: "tx-1", __candidate: { id: "inv-A" } }),
      makeTx({ id: "tx-2", amount: -100, __candidate: { id: "inv-A" } }),
    ];
    state.rejections = [makeRejection("tx-1", "inv-A")];
    state.purchaseInvoices = [makePurchaseInvoice("inv-A")];
    renderBank();

    // Alleen tx-2 telt als veilige match.
    const btn = await screen.findByRole("button", { name: SELECT_RE });
    expect(btn).toHaveAccessibleName("Selecteer alle veilige matches (1)");
    fireEvent.click(btn);
    fireEvent.click(await screen.findByRole("button", { name: /Veilige matches bevestigen \(1\)/ }));

    await waitFor(() => expect(gematchtCalls()).toHaveLength(1));
    expect(gematchtCalls()[0]).toMatchObject({ id: "tx-2", matched_invoice_id: "inv-A" });
  });

  it("D: expliciete handmatige bevestiging koppelt een eerder afgewezen factuur en wist de afwijzing", async () => {
    state.transactions = [makeTx({ id: "tx-1", __candidate: null })];
    state.rejections = [makeRejection("tx-1", "inv-A")];
    state.purchaseInvoices = [makePurchaseInvoice("inv-A")];
    renderBank();

    // Open de handmatige dialoog (Koppel) — die is bewust NIET gefilterd.
    fireEvent.click(await screen.findByRole("button", { name: "Koppel" }));
    fireEvent.click(await screen.findByRole("button", { name: "__dialog-confirm-inv-A" }));

    await waitFor(() =>
      expect(gematchtCalls()).toContainEqual(
        expect.objectContaining({ id: "tx-1", matched_invoice_id: "inv-A" }),
      ),
    );
    // De verouderde afwijzing wordt gewist zodat die de bewuste keuze niet meer blokkeert.
    await waitFor(() =>
      expect(state.rejectionClears).toContainEqual({ bankTransactionId: "tx-1", invoiceId: "inv-A" }),
    );
  });

  it("E: zonder afwijzingsgeschiedenis blijft het bestaande gedrag ongewijzigd", async () => {
    state.transactions = [makeTx({ id: "tx-1" })]; // standaard exacte kandidaat inv-tx-1
    renderBank();
    const btn = await screen.findByRole("button", { name: SELECT_RE });
    expect(btn).toHaveAccessibleName("Selecteer alle veilige matches (1)");
    expect(screen.getByText(BANNER_RE)).toHaveTextContent("1 veilige match → direct bevestigen");
  });

  it("F: ontkoppelen legt de afwijzing van de primaire factuur vast", async () => {
    state.transactions = [
      makeTx({ id: "tx-1", match_status: "gematcht", match_confidence: 100, matched_invoice_id: "inv-A" }),
    ];
    state.purchaseInvoices = [makePurchaseInvoice("inv-A")];
    renderBank();

    // Ontkoppel-knop (icon-only, tooltip "Ontkoppelen") — vind hem via het
    // Unlink-icoon in de gematcht-rij.
    await waitFor(() => {
      const unlink = screen
        .getAllByRole("button")
        .find(b => b.querySelector('svg[class*="unlink" i], svg.lucide-unlink'));
      expect(unlink).toBeTruthy();
      fireEvent.click(unlink!);
    });

    await waitFor(() => expect(state.rejectionAdds).toHaveLength(1));
    expect(state.rejectionAdds[0]).toMatchObject({
      bank_transaction_id: "tx-1",
      invoice_id: "inv-A",
      invoice_type: "inkoop",
    });
  });
});

describe("Bank — gating, bulk-ontkoppelen, extra allocatie en foutpaden", () => {
  it("G1: zolang de afwijzingsgeschiedenis laadt is automatische matching geblokkeerd", async () => {
    state.transactions = [makeTx({ id: "tx-1" })]; // veilige kandidaat beschikbaar
    state.rejectionsLoading = true;
    renderBank();
    await waitFor(() => expect(screen.getByText("Bankafschriften")).toBeInTheDocument());

    expect(screen.queryByText(BANNER_RE)).toBeNull();
    expect(screen.queryByRole("button", { name: SELECT_RE })).toBeNull();
    expect(screen.queryByRole("button", { name: /Automatisch voorstellen/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "✓ Bevestig" })).toBeNull();
    expect(gematchtCalls()).toEqual([]);
  });

  it("G2: een mislukte afwijzingsquery blokkeert matching en toont een fout met retry", async () => {
    state.transactions = [makeTx({ id: "tx-1" })];
    state.rejectionsError = true;
    renderBank();
    await waitFor(() =>
      expect(
        screen.getByText(/Afwijzingsgeschiedenis laden mislukt — automatische matching is uitgeschakeld/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Opnieuw laden" })).toBeInTheDocument();
    // undefined data wordt NIET als lege lijst behandeld: geen veilige matches.
    expect(screen.queryByText(BANNER_RE)).toBeNull();
    expect(screen.queryByRole("button", { name: SELECT_RE })).toBeNull();
    expect(gematchtCalls()).toEqual([]);
  });

  it("H: bulk-ontkoppelen legt de primaire afwijzing per transactie vast vóór het wissen", async () => {
    state.transactions = [
      makeTx({ id: "tx-1", match_status: "gematcht", match_confidence: 100, matched_invoice_id: "inv-A" }),
      makeTx({ id: "tx-2", match_status: "gematcht", match_confidence: 100, matched_invoice_id: "inv-B" }),
    ];
    state.purchaseInvoices = [makePurchaseInvoice("inv-A"), makePurchaseInvoice("inv-B")];
    renderBank();

    // Selecteer beide rijen en start de bulk-ontkoppeling via de toolbar.
    const checkboxes = await screen.findAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);
    await waitFor(() =>
      expect(screen.getByText("2 transactie(s) geselecteerd")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Ontkoppel geselecteerde/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Ontkoppelen" }));

    await waitFor(() => expect(state.rejectionAdds).toHaveLength(2));
    expect(state.rejectionAdds).toContainEqual(
      expect.objectContaining({ bank_transaction_id: "tx-1", invoice_id: "inv-A" }),
    );
    expect(state.rejectionAdds).toContainEqual(
      expect.objectContaining({ bank_transaction_id: "tx-2", invoice_id: "inv-B" }),
    );
    // De afwijzing is vastgelegd vóór de reset — de auto-matcher kan de
    // combinatie dus niet direct herstellen (zelfde uitsluiting als test A2).
  });

  it("I: een geslaagde extra (additional) allocatie van een afgewezen factuur wist die afwijzing", async () => {
    // Gematchte transactie met een deel-allocatie: de Plus-knop verschijnt.
    state.transactions = [
      makeTx({ id: "tx-1", match_status: "gematcht", match_confidence: 100, matched_invoice_id: "inv-X" }),
    ];
    state.allocations = [
      { id: "al-1", bank_transaction_id: "tx-1", invoice_id: "inv-X", invoice_type: "inkoop", client_id: "c1", amount: 40, user_id: "u1", created_at: "", updated_at: "" },
    ];
    state.purchaseInvoices = [makePurchaseInvoice("inv-X"), makePurchaseInvoice("inv-A")];
    state.rejections = [makeRejection("tx-1", "inv-A")];
    renderBank();

    // Open de extra-allocatie-dialoog via de Plus-knop.
    await waitFor(() => {
      const plus = screen
        .getAllByRole("button")
        .find(b => b.querySelector('svg[class*="plus" i]'));
      expect(plus).toBeTruthy();
      fireEvent.click(plus!);
    });
    fireEvent.click(await screen.findByRole("button", { name: "__dialog-confirm-extra-inv-A" }));

    // Wissen gebeurt pas NA de geslaagde allocatie-upsert.
    await waitFor(() =>
      expect(state.rejectionClears).toContainEqual({ bankTransactionId: "tx-1", invoiceId: "inv-A" }),
    );
    expect(state.allocationUpserts).toContainEqual(
      expect.objectContaining({ bank_transaction_id: "tx-1", invoice_id: "inv-A" }),
    );
  });

  it("J: een mislukte rejection-clear breekt een geslaagde koppeling + allocatie niet", async () => {
    state.transactions = [makeTx({ id: "tx-1", __candidate: null })];
    state.rejections = [makeRejection("tx-1", "inv-A")];
    state.purchaseInvoices = [makePurchaseInvoice("inv-A")];
    state.failNextClear = true;
    renderBank();

    fireEvent.click(await screen.findByRole("button", { name: "Koppel" }));
    fireEvent.click(await screen.findByRole("button", { name: "__dialog-confirm-inv-A" }));

    // Link + allocatie zijn geschreven vóór de clear-poging…
    await waitFor(() =>
      expect(gematchtCalls()).toContainEqual(
        expect.objectContaining({ id: "tx-1", matched_invoice_id: "inv-A" }),
      ),
    );
    await waitFor(() =>
      expect(state.allocationUpserts).toContainEqual(
        expect.objectContaining({ bank_transaction_id: "tx-1", invoice_id: "inv-A" }),
      ),
    );
    // …de clear is geprobeerd en mislukt, zonder de koppeling terug te draaien.
    await waitFor(() => expect(state.rejectionClears).toHaveLength(1));
    expect(state.updateTxCalls.some(c => c.match_status === "niet_gematcht")).toBe(false);
  });
});

describe("Bank — VerwerkingsScherm handmatige override", () => {
  async function openVerwerkingAndMatch() {
    state.transactions = [makeTx({ id: "tx-1", __candidate: null })];
    state.rejections = [makeRejection("tx-1", "inv-A")];
    state.purchaseInvoices = [makePurchaseInvoice("inv-A")];
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: /Verwerken/ }));
    fireEvent.click(await screen.findByRole("button", { name: "__verwerk-match-inv-A" }));
  }

  it("wist de exacte afwijzing pas na geslaagde link-, factuur- en allocatie-writes", async () => {
    await openVerwerkingAndMatch();

    await waitFor(() =>
      expect(gematchtCalls()).toContainEqual(
        expect.objectContaining({ id: "tx-1", matched_invoice_id: "inv-A" }),
      ),
    );
    await waitFor(() =>
      expect(state.allocationUpserts).toContainEqual(
        expect.objectContaining({ bank_transaction_id: "tx-1", invoice_id: "inv-A" }),
      ),
    );
    await waitFor(() =>
      expect(state.rejectionClears).toContainEqual({ bankTransactionId: "tx-1", invoiceId: "inv-A" }),
    );
  });

  it("een mislukte clear draait de geslaagde boeking niet terug", async () => {
    state.failNextClear = true;
    await openVerwerkingAndMatch();

    await waitFor(() =>
      expect(gematchtCalls()).toContainEqual(
        expect.objectContaining({ id: "tx-1", matched_invoice_id: "inv-A" }),
      ),
    );
    await waitFor(() => expect(state.rejectionClears).toHaveLength(1));
    // Geen reset van de transactie na de mislukte clear.
    expect(state.updateTxCalls.some(c => c.match_status === "niet_gematcht")).toBe(false);
  });
});

describe("Bank — alle matchpaden delen dezelfde afwijzingsregel (brongaranties)", () => {
  let bankSource = "";
  let hookSource = "";
  beforeEach(async () => {
    if (bankSource) return;
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    bankSource = readFileSync(resolve(process.cwd(), "src/pages/Bank.tsx"), "utf-8");
    hookSource = readFileSync(resolve(process.cwd(), "src/hooks/useBankMatchRejections.ts"), "utf-8");
  });

  it("rankCandidates wordt alleen aangeroepen via de twee gefilterde entrypoints", () => {
    // Import line + eligibleCandidatesFor + getSafeMatchCandidate = 3 mentions.
    const calls = bankSource.match(/rankCandidates\(/g) ?? [];
    expect(calls).toHaveLength(2);
    // Both entry points route through the shared filter.
    const filtered = bankSource.match(/filterRejectedCandidates\(/g) ?? [];
    expect(filtered.length).toBeGreaterThanOrEqual(2);
    // Mutation-time helpers receive the per-transaction rejection set.
    expect(bankSource).toContain("getSafeMatchCandidate(tx, invoices, salesInvs, rejectedByTxId.get(tx.id))");
    expect(bankSource).toContain("getSafeMatchCandidate(t, invoices ?? [], salesInvs ?? [], rejectedByTxId.get(t.id))");
  });

  it("automatische herberekening wist nooit afwijzingen; alleen expliciete handmatige matches wel", () => {
    // clearMatchRejection is called from exactly the three explicit manual
    // paths: primary dialog confirm, additional-allocation confirm and the
    // VerwerkingsScherm onMatchInvoice override.
    const clears = bankSource.match(/clearMatchRejection\.mutateAsync\(/g) ?? [];
    expect(clears).toHaveLength(3);
    // Rejections cannot be duplicated: unique-key upsert with ignoreDuplicates.
    expect(hookSource).toContain('onConflict: "bank_transaction_id,invoice_id"');
    expect(hookSource).toContain("ignoreDuplicates: true");
  });

  it("matchingReady omvat de afwijzingsquery en de drawer gebruikt dezelfde filter", async () => {
    expect(bankSource).toContain(
      "hasSelection && !rejectionsLoading && !rejectionsFetching && !rejectionsError && !!matchRejections;",
    );
    expect(bankSource).toContain("const matchingReady = wholeSetReady && salesReady && rejectionsReady;");
    expect(bankSource).toContain("if (rejectionsError) refetchRejections();");
    // Bulk unlink persists via the same helper as row unlink.
    const recordCalls = bankSource.match(/recordMatchRejection\(tx, tx\.matched_invoice_id\)/g) ?? [];
    expect(recordCalls.length).toBeGreaterThanOrEqual(2);
    // Drawer suggestions run through the shared predicate.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const drawerSource = readFileSync(
      resolve(process.cwd(), "src/components/BankAfletteringDrawer.tsx"),
      "utf-8",
    );
    expect(drawerSource).toContain("filterRejectedCandidates(");
    expect(drawerSource).toContain("rejectedInvoiceIds");
    // Batched fetching in the hook: ranges until a short batch.
    expect(hookSource).toContain("REJECTION_FETCH_BATCH_SIZE");
    expect(hookSource).toContain(".range(offset, offset + REJECTION_FETCH_BATCH_SIZE - 1)");
  });
});
