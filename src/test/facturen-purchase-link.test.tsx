/**
 * P5b — Inkoopfacturen: "Koppel" in de aflettering loopt via de betaalschrijver.
 *
 * Eén link_bank_payment-aanroep in plaats van koppeling + restant + matchvelden
 * los. Een betaling wijzigt de inkoopstatus nooit (D1-3); de pagina neemt het
 * restant over uit het antwoord. Bij een weigering: één melding, niets anders.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  toasts: [] as any[],
  invoices: [] as any[],
  allocations: [] as any[],
  bankTransactions: [] as any[],
  linkCalls: [] as any[],
  linkError: null as Error | null,
  updateInvoiceCalls: [] as any[],
  updateTxCalls: [] as any[],
}));

vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => vi.fn() };
});
vi.mock("@/hooks/useClientContext", () => ({ useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({ useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }) }));
vi.mock("@/hooks/useClients", () => ({ useClients: () => ({ data: [{ id: "c1", name: "Klant 1" }] }) }));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  PURCHASE_INVOICES_PAGE_SIZE: 50,
  buildYearOptions: (current = new Date().getFullYear(), count = 10) => Array.from({ length: count }, (_, i) => current - i),
  usePaginatedPurchaseInvoices: () => ({
    data: { invoices: h.invoices, total: h.invoices.length }, isLoading: false, isFetching: false, isError: false, refetch: vi.fn(),
  }),
  usePurchaseInvoiceDuplicates: () => ({ data: null }),
  useResetPageOnChange: vi.fn(),
  useUpdatePurchaseInvoice: () => ({ mutateAsync: vi.fn(async (args: any) => { h.updateInvoiceCalls.push(args); return {}; }), isPending: false }),
  useDeletePurchaseInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  fetchAllExportablePurchaseInvoices: vi.fn(() => Promise.resolve([])),
  markPurchaseInvoicesExported: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/hooks/useVraagposten", () => ({ useVraagposten: () => ({ data: [] }) }));
vi.mock("@/hooks/useBankTransactionAllocations", () => ({ useBankTransactionAllocations: () => ({ data: h.allocations }) }));
vi.mock("@/hooks/useBankTransactions", () => ({
  useBankTransactions: () => ({ data: h.bankTransactions }),
  useUpdateBankTransaction: () => ({ mutateAsync: vi.fn(async (args: any) => { h.updateTxCalls.push(args); return {}; }), isPending: false }),
}));
vi.mock("@/hooks/useBankPaymentLink", () => ({
  useBankPaymentLink: () => ({
    link: async (input: any) => {
      h.linkCalls.push(input);
      if (h.linkError) throw h.linkError;
      return { allocationId: "a-1", outcome: "created", invoiceRemaining: 0, invoiceStatus: "gecontroleerd", txMatchStatus: "gematcht", replayed: false };
    },
    unlink: vi.fn(),
    refresh: async () => undefined,
  }),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ session: { access_token: "tok" } }) }));
vi.mock("@tanstack/react-query", async (orig) => {
  const actual = await orig<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: (t: any) => { h.toasts.push(t); } }) }));
vi.mock("@/lib/snelstart-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/snelstart-export")>();
  return { ...actual, exportPurchaseInvoicesCSV: vi.fn(() => []) };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/components/PurchaseInvoiceCreateDialog", () => ({ PurchaseInvoiceCreateDialog: () => null }));
vi.mock("@/components/InvoiceNumberCopyButton", () => ({ InvoiceNumberCopyButton: () => null }));

import Facturen from "@/pages/Facturen";
import { BankPaymentError } from "@/lib/bank-payment-link";

const invoice = {
  id: "P1", client_id: "c1", organization_id: "org-1", supplier: "Leverancier Een", invoice_number: "INK-1",
  invoice_date: "2026-01-05", amount_excl: 100, amount_incl: 121, btw_amount: 21, btw_percentage: 21,
  remaining_amount: 61, status: "gecontroleerd", document_route: "pdf_route", ledger_account_text: null,
};

function renderFacturen() {
  render((<MemoryRouter initialEntries={["/facturen"]}><Facturen /></MemoryRouter>) as ReactNode as any);
}

async function openLinkDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Aflettering bekijken" }));
  fireEvent.click(await screen.findByRole("button", { name: "Koppel" }));
  return screen.findByRole("button", { name: "Koppelen" });
}

beforeEach(() => {
  h.toasts = [];
  h.invoices = [invoice];
  h.allocations = [{ id: "a-0", bank_transaction_id: "tx-0", invoice_type: "inkoop", invoice_id: "P1", client_id: "c1", amount: 60 }];
  h.bankTransactions = [
    { id: "tx-0", client_id: "c1", organization_id: "org-1", amount: -60, transaction_date: "2026-01-06", description: "Eerste deel", match_status: "gematcht", matched_invoice_id: "P1", reference: null, counter_account: null },
    { id: "tx-1", client_id: "c1", organization_id: "org-1", amount: -61, transaction_date: "2026-01-07", description: "INK-1 rest", match_status: "niet_gematcht", matched_invoice_id: null, reference: null, counter_account: null },
  ];
  h.linkCalls = [];
  h.linkError = null;
  h.updateInvoiceCalls = [];
  h.updateTxCalls = [];
});

describe("Inkoopfacturen — koppelen in de aflettering via de betaalschrijver", () => {
  it("één RPC (inkoop, factuur, transactie, voorgesteld bedrag); geen eigen restant of match", async () => {
    renderFacturen();
    fireEvent.click(await openLinkDialog());
    await waitFor(() => expect(h.linkCalls).toHaveLength(1));
    expect(h.linkCalls[0]).toEqual({ bankTransactionId: "tx-1", invoiceType: "inkoop", invoiceId: "P1", amount: 61 });
    await waitFor(() => expect(h.toasts.at(-1)?.title).toBe("Betaling gekoppeld"));
    expect(h.updateInvoiceCalls).toEqual([]);
    expect(h.updateTxCalls).toEqual([]);
  });

  it("een weigering: één zichtbare fout, geen enkele andere schrijfactie", async () => {
    h.linkError = new BankPaymentError("Betalingen koppelen is nog niet beschikbaar: de database-update ontbreekt. Er is niets gewijzigd.", "PGRST202", true);
    renderFacturen();
    fireEvent.click(await openLinkDialog());
    await waitFor(() => expect(h.toasts.at(-1)?.variant).toBe("destructive"));
    expect(h.toasts.at(-1)?.description).toMatch(/nog niet beschikbaar.*niets gewijzigd/);
    expect(h.updateInvoiceCalls).toEqual([]);
    expect(h.updateTxCalls).toEqual([]);
  });
});
