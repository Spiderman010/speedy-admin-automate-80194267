/**
 * Bank.tsx — de import en de organisatiewissel (nulmeting A1-11, B2-10), en de
 * directe bevestiging zonder afwijzingsdata. De echte pagina; de hooks zijn
 * gemockt en registreren elke schrijfactie. Geen netwerk.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
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
  fetchPurchases: vi.fn(),
  fetchSales: vi.fn(),
}));

const CLIENTS: Record<string, any[]> = {
  "org-1": [{ id: "c1", name: "Klant 1", organization_id: "org-1", ibans: [] }],
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
  fetchAllBankTransactions: vi.fn(async () => []),
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
vi.mock("@/components/BankStatementUploadDialog", () => ({
  BankStatementUploadDialog: (props: any) => { h.dialogProps = props; return null; },
}));
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
const row = (over: any) => ({
  date: "2026-10-02", amount: -50, description: "KPN INK-90", counterAccount: null, reference: "NONREF",
  matchedInvoiceId: null, matchConfidence: null, matchStatus: "niet_gematcht", matchedInvoiceLabel: null,
  importFingerprint: null, importSource: "mt940", bankReference: null, ...over,
});

beforeEach(() => {
  h.org = "org-1";
  h.ctx = "c1";
  h.rejectionsLoaded = true;
  h.dialogProps = null;
  h.matchDialogProps = null;
  h.bankTxArgs = [];
  h.extraClients = [];
  h.fetchPurchases = vi.fn(async () => []);
  h.fetchSales = vi.fn(async () => []);
  h.addTx = vi.fn(async (r: any) => ({ id: "new", ...r }));
  for (const k of ["updateTx", "updatePurchase", "updateSales", "upsert", "toast"] as const) h[k] = vi.fn(async () => ({}));
});

describe("import (A1-11): alleen voorstellen, nooit een factuur of koppeling schrijven", () => {
  it("schrijft nooit 'gematcht', geen restant, geen status en geen koppeling", async () => {
    render(page());
    await act(async () => {
      await h.dialogProps.onImport("c1", [
        row({ matchStatus: "gematcht", matchedInvoiceId: "p1", matchConfidence: 100 }), // ook als een aanroeper het toch probeert
        row({ amount: -50.01, matchStatus: "suggestie", matchedInvoiceId: "p1", matchConfidence: 100 }),
        row({ amount: -12, matchStatus: "handmatig_geboekt", matchedInvoiceId: "p1", matchConfidence: 100, grootboekrekeningId: "gb-1", btwPercentage: 21 }),
        row({ amount: -7, matchStatus: "suggestie", matchedInvoiceId: null, matchConfidence: 80 }),
      ]);
    });
    expect(h.addTx.mock.calls.map(([r]: any[]) => [r.match_status, r.matched_invoice_id])).toEqual([
      ["suggestie", "p1"], ["suggestie", "p1"], ["handmatig_geboekt", null], ["niet_gematcht", null],
    ]);
    expect(h.updatePurchase).not.toHaveBeenCalled();
    expect(h.updateSales).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.toast.mock.calls.at(-1)[0].title).toBe("4 van 4 transacties geïmporteerd");
  });

  it("weigert hard een administratie die niet bij de actieve organisatie hoort", async () => {
    render(page());
    let outcome: unknown;
    await act(async () => { outcome = await h.dialogProps.onImport("c2", [row({})]); });
    expect(outcome).toBe(false);
    expect(h.addTx).not.toHaveBeenCalled();
    expect(h.toast.mock.calls.at(-1)[0]).toMatchObject({ title: "Importeren is niet gestart", variant: "destructive" });
  });
});

describe("import: organisatie van de administratie zelf (review Nit-1)", () => {
  it("een administratie in de lijst met een ander organization_id wordt geweigerd", async () => {
    h.extraClients = [{ id: "c-vreemd", name: "Vreemde klant", organization_id: "org-2", ibans: [] }];
    render(page());
    let outcome: unknown;
    await act(async () => { outcome = await h.dialogProps.onImport("c-vreemd", [row({})]); });
    expect(outcome).toBe(false);
    expect(h.addTx).not.toHaveBeenCalled();
    expect(h.toast.mock.calls.at(-1)[0]).toMatchObject({ title: "Importeren is niet gestart", variant: "destructive" });
  });
});

describe("importsuggesties: facturen van de importadministratie, niet van de paginaselectie (review P2-5)", () => {
  it("de dialoog laadt inkoop- en verkoopfacturen van precies de gekozen importadministratie, binnen de actieve organisatie", async () => {
    h.fetchPurchases = vi.fn(async () => [{ id: "p-c9", client_id: "c9" }]);
    h.fetchSales = vi.fn(async () => [{ id: "s-c9", client_id: "c9" }]);
    render(page()); // bankpagina staat op c1
    let loaded: any;
    await act(async () => { loaded = await h.dialogProps.loadInvoices("c9"); });
    expect(h.fetchPurchases).toHaveBeenCalledWith({ organizationId: "org-1", clientId: "c9" });
    expect(h.fetchSales).toHaveBeenCalledWith({ organizationId: "org-1", clientId: "c9" });
    expect(loaded).toEqual({ purchases: [{ id: "p-c9", client_id: "c9" }], sales: [{ id: "s-c9", client_id: "c9" }] });
  });
});

describe("organisatiewissel (B2-10)", () => {
  it("leegt de gekozen administratie, sluit de importdialoog en importeert niet meer in de oude administratie", async () => {
    const view = render(page());
    fireEvent.click(screen.getByRole("button", { name: /Upload afschrift/ }));
    expect(h.dialogProps).toMatchObject({ open: true, defaultClientId: "c1" });
    expect(h.clientSelect.value.selectedIds).toEqual(["c1"]);

    // OrganizationSelector.tsx doet precies dit bij een wissel.
    h.org = "org-2";
    h.ctx = "all";
    view.rerender(page());

    expect(h.dialogProps.open).toBe(false);
    expect(h.dialogProps.defaultClientId).toBeUndefined();
    expect(h.clientSelect.value.selectedIds).toEqual([]);
    expect(h.bankTxArgs.at(-1)).toMatchObject({ organizationId: "org-2", clientId: undefined, enabled: false });
    let outcome: unknown;
    await act(async () => { outcome = await h.dialogProps.onImport("c1", [row({})]); });
    expect(outcome).toBe(false);
    expect(h.addTx).not.toHaveBeenCalled();
  });

  it("het eerste vaststellen van de organisatie is geen wissel: de gekozen administratie blijft", () => {
    const view = render(page());
    view.rerender(page());
    expect(h.clientSelect.value.selectedIds).toEqual(["c1"]);
  });
});

describe("directe bevestiging zonder afwijzingsdata (vervangt het stringcontract op de dode handleConfirm)", () => {
  it("koppelt niets en schrijft niets zolang de afwijzingen niet geladen zijn", async () => {
    h.rejectionsLoaded = false;
    render(page());
    expect(h.matchDialogProps.rejectionIndex).toBeUndefined();
    await act(async () => {
      await h.matchDialogProps.onConfirm("t1", "p1", "inkoop", true, false, null, 50);
    });
    expect(h.updateTx).not.toHaveBeenCalled();
    expect(h.updatePurchase).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.toast.mock.calls.at(-1)[0]).toMatchObject({ title: "Fout bij koppelen", variant: "destructive" });
  });
});
