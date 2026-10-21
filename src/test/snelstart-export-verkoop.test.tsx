import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Herstelpakket P6 — SnelStart-verkoopexport vanuit de pagina Verkoop
 * (A2-05 / D-04 / B2-12 / C-11): één administratie per export.
 *
 * Alleen de databron is vervangen (in-memory, twee administraties). De
 * exportfuncties `fetchAllSalesInvoices` en `exportSalesInvoicesCSV` zijn echt.
 */

const h = vi.hoisted(() => ({ selectedClientId: "all", toasts: [] as any[] }));

vi.mock("@/integrations/supabase/client", async () => {
  const { fakeSupabase } = await import("./support/snelstart-export-fakes");
  return { supabase: fakeSupabase };
});
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ session: null, user: { id: "user-1" } }) }));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: h.selectedClientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", async () => {
  const f = await import("./support/snelstart-export-fakes");
  return { useClients: () => ({ data: [f.CLIENT_EEN, f.CLIENT_TWEE] }) };
});
vi.mock("@/hooks/useSalesInvoices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useSalesInvoices")>();
  return {
    ...actual,
    usePaginatedSalesInvoices: () => ({ data: { invoices: [], total: 0 }, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }),
    useScopedSalesInvoices: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
    useSalesReceivablesSummary: () => ({ data: undefined }),
    useSalesInvoiceDuplicates: () => ({ data: new Set<string>() }),
    useAddSalesInvoice: () => ({ mutateAsync: vi.fn() }),
    useUpdateSalesInvoice: () => ({ mutateAsync: vi.fn(() => Promise.resolve({})) }),
    useDeleteSalesInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});
vi.mock("@/hooks/useBankTransactionAllocations", () => ({
  useBankTransactionAllocations: () => ({ data: [] }),
  useUpsertBankTransactionAllocation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/useBankTransactions", () => ({
  useBankTransactions: () => ({ data: [] }),
  useUpdateBankTransaction: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/useSalesInvoicePosting", () => ({
  useSalesInvoicePosting: () => ({ data: null }),
  usePostSalesInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (t: any) => { h.toasts.push(t); } }),
}));
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));
vi.mock("@/components/CreateVraagpostDialog", () => ({ CreateVraagpostDialog: () => null }));
vi.mock("@/components/SalesInvoiceDialog", () => ({ SalesInvoiceDialog: () => null }));

import Verkoop from "@/pages/Verkoop";
import { csvLines, downloads, fakeDb, installDownloadCapture, salesRow, selectsOn } from "./support/snelstart-export-fakes";

function renderVerkoop() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/verkoop"]}>
        <Verkoop />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const exportButton = () => screen.getByRole("button", { name: /^Export$/ });
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  fakeDb.reset();
  h.toasts.length = 0;
  h.selectedClientId = "all";
  installDownloadCapture();
  fakeDb.tables.sales_invoices = [
    salesRow("s-een", "c1", { customer_name: "Klant Een BV", invoice_number: "V-001" }),
    salesRow("s-twee", "c2", { customer_name: "Klant Twee BV", invoice_number: "V-901" }),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Verkoop — SnelStart-export alleen per administratie (A2-05, D-04, B2-12, C-11)", () => {
  it("bij 'Alle klanten' staat de knop uit met uitleg; geen query en geen CSV", async () => {
    renderVerkoop();
    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveAccessibleDescription(/Kies één administratie/);
    fireEvent.click(exportButton());
    await settle();
    expect(selectsOn("sales_invoices")).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });

  it("met één administratie bevat het bestand alleen haar facturen", async () => {
    h.selectedClientId = "c1";
    renderVerkoop();
    expect(exportButton()).toBeEnabled();
    fireEvent.click(exportButton());
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].name).toBe("Bakkerij_Een_BV_verkoopfacturen_snelstart.csv");
    const { bom, lines } = await csvLines(downloads[0]);
    expect(bom).toBe(true);
    expect(lines).toEqual([
      '"Datum";"Omschrijving";"Grootboekrekening";"Bedrag";"Btw-code"',
      '"01-10-2026";"Klant Een BV - V-001";"8000 - Omzet";"121,00";"1"',
    ]);
    expect(selectsOn("sales_invoices")[0].filters).toEqual(expect.arrayContaining(["organization_id=eq.org-1", "client_id=eq.c1"]));
  });

  it("de verdedigingslaag weigert als de server rijen van een andere administratie teruggeeft", async () => {
    h.selectedClientId = "c1";
    fakeDb.ignoreClientFilter = true;
    renderVerkoop();
    fireEvent.click(exportButton());
    await waitFor(() => expect(h.toasts.some((t) => t.title === "Export mislukt")).toBe(true));
    expect(String(h.toasts.find((t) => t.title === "Export mislukt").description)).toMatch(/administratie/i);
    expect(downloads).toHaveLength(0);
  });
});
