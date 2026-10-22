/**
 * Organisatiewissel met een gevulde importpreview (review #295): de echte
 * importdialoog in de echte bankpagina; hooks gemockt, geen netwerk. Na de
 * wissel mag een heropende dialoog niets van het afschrift van de vorige
 * organisatie tonen, ook niet als het laden nog liep tijdens de wissel.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({
  org: "org-1",
  ctx: "c1",
  rejectionsLoaded: true,
  dialogProps: null as any,
  matchDialogProps: null as any,
  clientSelect: null as any,
  bankTxArgs: [] as any[],
  addTx: vi.fn(),
  updateTx: vi.fn(),
  updatePurchase: vi.fn(),
  updateSales: vi.fn(),
  upsert: vi.fn(),
  toast: vi.fn(),
  extraClients: [] as any[],
  loadExisting: vi.fn(),
  fetchPurchases: vi.fn(),
  fetchSales: vi.fn(),
}));

const CLIENTS: Record<string, any[]> = {
  "org-1": [{ id: "c1", name: "Klant 1", organization_id: "org-1", ibans: ["NL91RABO0123456789"] }],
  "org-2": [{ id: "c2", name: "Klant 2", organization_id: "org-2", ibans: [] }],
};

vi.mock("@/hooks/useBankMatchRejections", () => ({
  useBankMatchRejections: () => ({ data: h.rejectionsLoaded ? [] : undefined, isSuccess: h.rejectionsLoaded, isError: false }),
  useRecordBankMatchRejection: () => ({ mutateAsync: vi.fn(async () => undefined) }),
  assertBankMatchNotRejected: vi.fn(async () => undefined),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: h.ctx, setSelectedClientId: (v: string) => { h.ctx = v; } }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: h.org, isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({ useClients: (orgId?: string) => ({ data: [...(CLIENTS[orgId ?? ""] ?? []), ...h.extraClients] }) }));
const TX = {
  id: "t1", client_id: "c1", organization_id: "org-1", transaction_date: "2026-10-02", description: "KPN INK-90",
  reference: null, counter_account: null, amount: -50, match_status: "niet_gematcht", matched_invoice_id: null,
  match_confidence: null, grootboekrekening_id: null, btw_percentage: null,
};
vi.mock("@/hooks/useBankTransactions", () => ({
  BANK_TRANSACTIONS_PAGE_SIZE: 50,
  isServerFilterableBankStatus: (s: string) => ["all", "open", "gematcht", "handmatig"].includes(s),
  BANK_STATUS_MATCH_VALUES: { all: undefined, open: ["niet_gematcht", "suggestie"], gematcht: ["gematcht"], handmatig: ["handmatig_geboekt"] },
  bankSanitizeSearchTerm: (raw: string) => raw.trim(),
  fetchAllBankTransactions: (...a: any[]) => h.loadExisting(...a),
  useBankTransactions: (opts: any) => { h.bankTxArgs.push(opts); return { data: opts.enabled ? [TX] : undefined, isLoading: false, isError: false, refetch: vi.fn() }; },
  usePaginatedBankTransactions: () => ({ data: { transactions: [], total: 0 }, isLoading: false, isFetching: false, isError: false, isPlaceholderData: false, refetch: vi.fn() }),
  useAddBankTransaction: () => ({ mutateAsync: (...a: any[]) => h.addTx(...a) }),
  useUpdateBankTransaction: () => ({ mutateAsync: (...a: any[]) => h.updateTx(...a) }),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  fetchAllPurchaseInvoices: (...a: any[]) => h.fetchPurchases(...a),
  usePurchaseInvoices: () => ({
    data: [{ id: "p1", client_id: "c1", supplier: "KPN", invoice_number: "INK-90", status: "gecontroleerd", amount_incl: 50, amount_excl: null, remaining_amount: 50, invoice_date: "2026-09-01" }],
    isLoading: false, isError: false, refetch: vi.fn(),
  }),
  useUpdatePurchaseInvoice: () => ({ mutateAsync: (...a: any[]) => h.updatePurchase(...a) }),
}));
vi.mock("@/hooks/useSalesInvoices", () => ({
  fetchAllSalesInvoices: (...a: any[]) => h.fetchSales(...a),
  useSalesInvoices: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateSalesInvoice: () => ({ mutateAsync: (...a: any[]) => h.updateSales(...a) }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({ useActiveGrootboekrekeningen: () => ({ data: [] }) }));
vi.mock("@/hooks/useBookingTemplates", () => ({ useBookingTemplates: () => ({ data: [] }) }));
vi.mock("@/hooks/useVraagposten", () => ({ useVraagposten: () => ({ data: [] }), useCreateVraagpost: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/hooks/useBankTransactionAllocations", () => ({
  useBankTransactionAllocations: () => ({ data: [] }),
  useUpsertBankTransactionAllocation: () => ({ mutateAsync: (...a: any[]) => h.upsert(...a) }),
  useDeleteAllocationsForTransaction: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/components/BankMatchDialog", async (importOriginal) => ({
  ...(await importOriginal() as any),
  BankMatchDialog: (props: any) => { h.matchDialogProps = props; return null; },
}));
vi.mock("@/hooks/useBankLedgerStatus", () => ({ useBankLedgerStatus: () => ({ data: undefined }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: (...a: any[]) => h.toast(...a) }), toast: (...a: any[]) => h.toast(...a) }));
vi.mock("@/hooks/bankImportFingerprint", () => ({
  importFingerprintSupported: async () => true,
  withImportFingerprint: (row: any) => row,
  isImportFingerprintConflict: () => false,
}));
vi.mock("@/components/BankAfletteringDrawer", () => ({ BankAfletteringDrawer: () => null }));
vi.mock("@/components/VerwerkingsScherm", () => ({ VerwerkingsScherm: () => null }));
vi.mock("@/components/CreateVraagpostDialog", () => ({ CreateVraagpostDialog: () => null }));
vi.mock("@/components/ClientMultiSelect", () => ({
  ClientMultiSelect: (props: any) => { h.clientSelect = props; return null; },
}));
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));
vi.mock("@/components/OrganizationSelector", () => ({ OrganizationSelector: () => null }));

import Bank from "@/pages/Bank";

const page = () => <MemoryRouter initialEntries={["/bank"]}><Bank /></MemoryRouter>;
const TEXT = [":20:STARTUMS", ":25:NL91RABO0123456789", ":28C:00001", ":60F:C261001EUR1000,00",
  ":61:261002D12,50N544NONREF", ":86:Parkeergarage Centrum", ":62F:C261002EUR987,50", "-"].join("\n");

function chooseFile() {
  const f = new File([TEXT], "afschrift.sta", { type: "text/plain" });
  Object.defineProperty(f, "text", { value: () => Promise.resolve(TEXT) });
  fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [f] } });
}

function switchOrganization(view: ReturnType<typeof render>) {
  // OrganizationSelector.tsx doet precies dit bij een wissel.
  h.org = "org-2";
  h.ctx = "all";
  view.rerender(page());
}

beforeEach(() => {
  h.org = "org-1";
  h.ctx = "c1";
  h.rejectionsLoaded = true;
  h.extraClients = [];
  h.loadExisting = vi.fn(async () => []);
  for (const k of ["addTx", "updateTx", "updatePurchase", "updateSales", "upsert", "toast"] as const) h[k] = vi.fn(async () => ({}));
  h.fetchPurchases = vi.fn(async () => []);
  h.fetchSales = vi.fn(async () => []);
});

describe("organisatiewissel met een importpreview (review #295)", () => {
  it("preview gevuld → wissel → heropenen: geen rijen, geen doeladministratie, geen importknop", async () => {
    const view = render(page());
    fireEvent.click(screen.getByRole("button", { name: /Upload afschrift/ }));
    chooseFile();
    expect(await screen.findByRole("button", { name: /1 transacties importeren/ })).toBeInTheDocument();
    expect(screen.getByText(/Parkeergarage Centrum/)).toBeInTheDocument();

    switchOrganization(view);
    await waitFor(() => expect(screen.queryByText(/Parkeergarage Centrum/)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Upload afschrift/ }));

    expect(screen.getByRole("button", { name: /Bestand selecteren/ })).toBeInTheDocument();
    expect(screen.queryByText(/Parkeergarage Centrum/)).toBeNull();
    expect(screen.queryByTestId("import-target")).toBeNull();
    expect(screen.queryByRole("button", { name: /transacties importeren/ })).toBeNull();
  });

  it("een laadactie die tijdens de wissel nog loopt, zet na afloop niets meer terug", async () => {
    let finish!: (rows: any[]) => void;
    h.loadExisting = vi.fn(() => new Promise<any[]>((resolve) => { finish = resolve; }));
    const view = render(page());
    fireEvent.click(screen.getByRole("button", { name: /Upload afschrift/ }));
    chooseFile();
    await waitFor(() => expect(h.loadExisting).toHaveBeenCalledTimes(1));

    switchOrganization(view);
    fireEvent.click(screen.getByRole("button", { name: /Upload afschrift/ }));
    await act(async () => { finish([]); await Promise.resolve(); await new Promise((r) => setTimeout(r, 20)); });

    expect(screen.queryByText(/Parkeergarage Centrum/)).toBeNull();
    expect(screen.queryByTestId("import-target")).toBeNull();
    expect(screen.queryByRole("button", { name: /transacties importeren/ })).toBeNull();
  });
});
