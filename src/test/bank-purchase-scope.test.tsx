/**
 * Nulmeting C-01 / A1-16 (Bank.tsx:345-348) — inkoopfacturen in Bank.
 *
 * Voorheen organisatiebreed en zonder selectie geladen; nu per gekozen
 * administratie(s), net als de verkoopfacturen, en een mislukte of nog lopende
 * inkooplading is geen lege kandidatenlijst: Verwerken blijft dan dicht.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({
  context: "c1" as string,
  purchaseArgs: [] as any[],
  purchase: { data: [] as any[] | undefined, isLoading: false, isError: false },
}));

vi.mock("@/hooks/useBankMatchRejections", () => ({
  assertBankMatchNotRejected: vi.fn(async () => undefined),
  useBankMatchRejections: () => ({ data: [], isSuccess: true, isError: false }),
  useRecordBankMatchRejection: () => ({ mutateAsync: vi.fn(async () => undefined) }),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: h.context, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c1", name: "Klant 1", organization_id: "org-1" }] }),
}));
vi.mock("@/hooks/useBankTransactions", () => ({
  BANK_TRANSACTIONS_PAGE_SIZE: 50,
  isServerFilterableBankStatus: () => true,
  BANK_STATUS_MATCH_VALUES: { all: undefined, open: ["niet_gematcht", "suggestie"], gematcht: ["gematcht"], handmatig: ["handmatig_geboekt"] },
  bankSanitizeSearchTerm: (raw: string) => raw.trim(),
  fetchAllBankTransactions: vi.fn(async () => []),
  useBankTransactions: () => ({
    data: [{ id: "t1", client_id: "c1", organization_id: "org-1", transaction_date: "2026-10-01", amount: -50, description: "Huur", reference: null, counter_account: null, match_status: "niet_gematcht", matched_invoice_id: null, match_confidence: null, grootboekrekening_id: null, btw_percentage: null }],
    isLoading: false, isError: false, refetch: vi.fn(),
  }),
  usePaginatedBankTransactions: () => ({
    data: { transactions: [], total: 0 }, isLoading: false, isFetching: false, isError: false, isPlaceholderData: false, refetch: vi.fn(),
  }),
  useAddBankTransaction: () => ({ mutateAsync: vi.fn() }),
  useUpdateBankTransaction: () => ({ mutateAsync: vi.fn(async () => ({})) }),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: (args: any) => {
    h.purchaseArgs.push(args);
    return { ...h.purchase, refetch: vi.fn() };
  },
  useUpdatePurchaseInvoice: () => ({ mutateAsync: vi.fn(async () => ({})) }),
}));
vi.mock("@/hooks/useSalesInvoices", () => ({
  useSalesInvoices: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateSalesInvoice: () => ({ mutateAsync: vi.fn(async () => ({})) }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({ useActiveGrootboekrekeningen: () => ({ data: [] }) }));
vi.mock("@/hooks/useBookingTemplates", () => ({ useBookingTemplates: () => ({ data: [] }) }));
vi.mock("@/hooks/useVraagposten", () => ({ useVraagposten: () => ({ data: [] }), useCreateVraagpost: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/hooks/useBankTransactionAllocations", () => ({
  useBankTransactionAllocations: () => ({ data: [] }),
  useUpsertBankTransactionAllocation: () => ({ mutateAsync: vi.fn() }),
  useDeleteAllocationsForTransaction: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/useBankLedgerStatus", () => ({ useBankLedgerStatus: () => ({ data: undefined }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/components/BankMatchDialog", () => ({ BankMatchDialog: () => null, rankCandidates: () => [] }));
vi.mock("@/components/BankStatementUploadDialog", () => ({ BankStatementUploadDialog: () => null }));
vi.mock("@/components/BankAfletteringDrawer", () => ({ BankAfletteringDrawer: () => null }));
vi.mock("@/components/VerwerkingsScherm", () => ({ VerwerkingsScherm: () => null }));
vi.mock("@/components/CreateVraagpostDialog", () => ({ CreateVraagpostDialog: () => null }));
vi.mock("@/components/ClientMultiSelect", () => ({ ClientMultiSelect: () => null }));
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));

import Bank from "@/pages/Bank";

const renderBank = () => render(<MemoryRouter initialEntries={["/bank"]}><Bank /></MemoryRouter>);
const verwerken = () => screen.getByRole("button", { name: /Verwerken/ });

beforeEach(() => {
  h.context = "c1";
  h.purchaseArgs = [];
  h.purchase = { data: [], isLoading: false, isError: false };
});

describe("Bank — inkoopfacturen per gekozen administratie", () => {
  it("vraagt alleen de inkoopfacturen van de gekozen administratie op", () => {
    renderBank();
    expect(h.purchaseArgs.at(-1)).toEqual({ organizationId: "org-1", clientId: "c1", clientIds: undefined, enabled: true });
  });

  it("zonder administratiekeuze wordt er niets opgevraagd (niet organisatiebreed)", () => {
    h.context = "all";
    renderBank();
    expect(h.purchaseArgs.at(-1)).toMatchObject({ clientId: undefined, enabled: false });
  });

  it("met de inkoopfacturen geladen kan Verwerken", () => {
    renderBank();
    expect(verwerken()).toBeEnabled();
  });

  it("een mislukte inkooplading is geen lege lijst: melding en Verwerken dicht", () => {
    h.purchase = { data: undefined, isLoading: false, isError: true };
    renderBank();
    expect(screen.getByText(/Inkoopfacturen voor matching en aflettering laden mislukt/)).toBeInTheDocument();
    expect(verwerken()).toBeDisabled();
  });

  it("tijdens het laden van de inkoopfacturen blijft Verwerken dicht", () => {
    h.purchase = { data: undefined, isLoading: true, isError: false };
    renderBank();
    expect(verwerken()).toBeDisabled();
  });
});
