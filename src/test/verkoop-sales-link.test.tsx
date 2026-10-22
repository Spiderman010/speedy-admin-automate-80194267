/**
 * P5b — Verkoop: "Koppel" in de aflettering loopt via de betaalschrijver.
 *
 * Vroeger schreef handleSalesLink vier dingen los (koppeling, restant uit een
 * momentopname, `betaald` bij ≤ € 0,01 — ook zonder goedkeuring — en de
 * matchvelden). Nu: één link_bank_payment-aanroep; de pagina neemt restant en
 * status over uit het antwoord van de database. Bij een weigering: één melding
 * en geen enkele andere schrijfactie.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  toasts: [] as any[],
  invoices: [] as any[],
  allocations: [] as any[],
  bankTransactions: [] as any[],
  linkCalls: [] as any[],
  linkError: null as Error | null,
  linkResult: null as any,
  updateInvoiceCalls: [] as any[],
  updateTxCalls: [] as any[],
}));

vi.mock("@/integrations/supabase/client", async () => {
  const { fakeSupabase } = await import("./support/snelstart-export-fakes");
  return { supabase: fakeSupabase };
});
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ session: null, user: { id: "user-1" } }) }));
vi.mock("@/hooks/useClientContext", () => ({ useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({ useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }) }));
vi.mock("@/hooks/useClients", () => ({ useClients: () => ({ data: [{ id: "c1", name: "Klant 1", organization_id: "org-1" }] }) }));
vi.mock("@/hooks/useSalesInvoices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useSalesInvoices")>();
  return {
    ...actual,
    usePaginatedSalesInvoices: () => ({ data: { invoices: h.invoices, total: h.invoices.length }, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }),
    useScopedSalesInvoices: () => ({ data: h.invoices, isLoading: false, isError: false, refetch: vi.fn() }),
    useSalesReceivablesSummary: () => ({ data: undefined }),
    useSalesInvoiceDuplicates: () => ({ data: new Set<string>() }),
    useAddSalesInvoice: () => ({ mutateAsync: vi.fn() }),
    useUpdateSalesInvoice: () => ({ mutateAsync: vi.fn(async (args: any) => { h.updateInvoiceCalls.push(args); return {}; }), isPending: false }),
    useDeleteSalesInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});
vi.mock("@/hooks/useBankTransactionAllocations", () => ({
  useBankTransactionAllocations: () => ({ data: h.allocations }),
}));
vi.mock("@/hooks/useBankTransactions", () => ({
  useBankTransactions: () => ({ data: h.bankTransactions }),
  useUpdateBankTransaction: () => ({ mutateAsync: vi.fn(async (args: any) => { h.updateTxCalls.push(args); return {}; }), isPending: false }),
}));
vi.mock("@/hooks/useBankPaymentLink", () => ({
  useBankPaymentLink: () => ({
    link: async (input: any) => {
      h.linkCalls.push(input);
      if (h.linkError) throw h.linkError;
      return h.linkResult;
    },
    unlink: vi.fn(),
    refresh: async () => undefined,
  }),
}));
vi.mock("@/hooks/useSalesInvoicePosting", () => ({
  useSalesInvoicePosting: () => ({ data: null }),
  usePostSalesInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: (t: any) => { h.toasts.push(t); } }) }));
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));
vi.mock("@/components/CreateVraagpostDialog", () => ({ CreateVraagpostDialog: () => null }));
vi.mock("@/components/SalesInvoiceDialog", () => ({ SalesInvoiceDialog: () => null }));

import Verkoop from "@/pages/Verkoop";
import { BankPaymentError } from "@/lib/bank-payment-link";

const invoice = {
  id: "S1", client_id: "c1", organization_id: "org-1", customer_name: "Klant Een BV", invoice_number: "V-001",
  invoice_date: "2026-01-05", due_date: null, amount_excl: 100, btw_amount: 0, amount_incl: 100, btw_percentage: 0,
  btw_verlegd: false, remaining_amount: 70, status: "concept", notes: null, user_id: "user-1",
  created_at: "2026-01-05T00:00:00Z", updated_at: "2026-01-05T00:00:00Z",
};

function renderVerkoop() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/verkoop"]}><Verkoop /></MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openLinkDialog() {
  await waitFor(() => expect(document.querySelector("svg.lucide-landmark")).not.toBeNull());
  fireEvent.click(document.querySelector("svg.lucide-landmark")!.closest("button")!);
  fireEvent.click(await screen.findByRole("button", { name: "Koppel" }));
  return screen.findByRole("button", { name: "Koppelen" });
}

beforeEach(() => {
  h.toasts = [];
  h.invoices = [invoice];
  h.allocations = [{ id: "a-0", bank_transaction_id: "tx-0", invoice_type: "verkoop", invoice_id: "S1", client_id: "c1", amount: 30 }];
  h.bankTransactions = [
    { id: "tx-0", client_id: "c1", organization_id: "org-1", amount: 30, transaction_date: "2026-01-06", description: "Eerste deel", match_status: "gematcht", matched_invoice_id: "S1", reference: null, counter_account: null },
    { id: "tx-1", client_id: "c1", organization_id: "org-1", amount: 50, transaction_date: "2026-01-07", description: "V-001 tweede deel", match_status: "niet_gematcht", matched_invoice_id: null, reference: null, counter_account: null },
  ];
  h.linkCalls = [];
  h.linkError = null;
  h.linkResult = { allocationId: "a-1", outcome: "created", invoiceRemaining: 20, invoiceStatus: "concept", txMatchStatus: "gematcht", replayed: false };
  h.updateInvoiceCalls = [];
  h.updateTxCalls = [];
});

describe("Verkoop — koppelen in de aflettering via de betaalschrijver", () => {
  it("één RPC (verkoop, factuur, transactie, voorgesteld bedrag); geen eigen restant, betaald of match", async () => {
    renderVerkoop();
    fireEvent.click(await openLinkDialog());
    await waitFor(() => expect(h.linkCalls).toHaveLength(1));
    expect(h.linkCalls[0]).toEqual({ bankTransactionId: "tx-1", invoiceType: "verkoop", invoiceId: "S1", amount: 50 });
    await waitFor(() => expect(h.toasts.at(-1)?.title).toBe("Deelbetaling gekoppeld"));
    expect(h.updateInvoiceCalls).toEqual([]);
    expect(h.updateTxCalls).toEqual([]);
  });

  it("een volledig betaalde maar niet goedgekeurde factuur blijft concept: de melding zegt het", async () => {
    h.linkResult = { ...h.linkResult, invoiceRemaining: 0, invoiceStatus: "concept" };
    renderVerkoop();
    fireEvent.click(await openLinkDialog());
    await waitFor(() => expect(h.toasts.at(-1)?.description).toMatch(/nog niet goedgekeurd/));
    expect(h.updateInvoiceCalls).toEqual([]);
  });

  it("een weigering: één zichtbare fout, geen enkele andere schrijfactie", async () => {
    h.linkError = new BankPaymentError("Onvoldoende rechten: een verkoopbetaling koppelen vereist de rol owner", "42501");
    renderVerkoop();
    fireEvent.click(await openLinkDialog());
    await waitFor(() => expect(h.toasts.at(-1)?.variant).toBe("destructive"));
    expect(h.toasts.at(-1)).toMatchObject({ title: "Koppelen mislukt", description: "Onvoldoende rechten: een verkoopbetaling koppelen vereist de rol owner" });
    expect(h.updateInvoiceCalls).toEqual([]);
    expect(h.updateTxCalls).toEqual([]);
  });
});
