import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Verkoop — het vaste detaildok op brede desktop (>= 1360px).
 *
 * Het dok en de bestaande dialoog renderen dezelfde factuurdetail met dezelfde
 * selectie en handlers; hier wordt bewezen dat op het desktoppad de detail in
 * het dok staat en de dialoog niet opent. De smalle-schermtests van de
 * dialoog zelf staan in `sales-invoice-ledger-link.test.tsx` en zijn
 * ongewijzigd.
 */

const invoice = {
  id: "si-1",
  client_id: "c-1",
  organization_id: "org-1",
  user_id: "u-1",
  customer_name: "Dok Klant BV",
  invoice_number: "V-DOK-001",
  invoice_date: "2026-04-01",
  due_date: "2026-05-01",
  amount_excl: 1000,
  amount_incl: 1210,
  btw_amount: 210,
  btw_percentage: 21,
  btw_verlegd: false,
  status: "concept",
  ledger_account_text: "",
  grootboekrekening_id: null,
  remaining_amount: 1210,
  notes: null,
  pdf_path: null,
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ session: null }) }));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "all", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c-1", name: "Administratie Een" }] }),
}));
vi.mock("@/hooks/useSalesInvoices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useSalesInvoices")>();
  return {
    ...actual,
    usePaginatedSalesInvoices: () => ({
      data: { invoices: [invoice], total: 1 },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    }),
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
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));
vi.mock("@/components/CreateVraagpostDialog", () => ({ CreateVraagpostDialog: () => null }));
vi.mock("@/components/SalesInvoiceDialog", () => ({ SalesInvoiceDialog: () => null }));

import Verkoop from "@/pages/Verkoop";

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

describe("Verkoop — desktop detaildok (>= 1360px)", () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    // Alleen de dok-breakpoint matcht; alle andere media queries blijven false.
    window.matchMedia = ((query: string) => ({
      matches: query === "(min-width: 1360px)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("toont de geselecteerde factuur in het vaste dok en opent de dialoog niet", () => {
    renderVerkoop();

    // Het dok staat er al vóór een selectie, zonder factuurdetail.
    const dock = screen.getByTestId("sales-detail-dock");
    expect(dock).toHaveAccessibleName("Verkoopfactuur controleren");
    expect(within(dock).queryByDisplayValue("Dok Klant BV")).not.toBeInTheDocument();

    // Selecteren via de bestaande rij-interactie.
    const row = screen.getAllByRole("row").find((r) => r.textContent?.includes("V-DOK-001"));
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    expect(row).toHaveAttribute("data-state", "selected");

    // De bestaande detail en acties staan in het dok.
    expect(within(dock).getByText("Verkoopfactuur controleren")).toBeInTheDocument();
    expect(within(dock).getByDisplayValue("Dok Klant BV")).toBeInTheDocument();
    expect(within(dock).getByDisplayValue("V-DOK-001")).toBeInTheDocument();
    expect(within(dock).getByRole("button", { name: /Opslaan/ })).toBeEnabled();
    expect(within(dock).getByRole("button", { name: /Goedkeuren/ })).toBeEnabled();
    expect(within(dock).getByTestId("sales-posting-button")).toBeInTheDocument();

    // De dialoog rendert/opent niet op dit desktoppad.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getAllByText("Verkoopfactuur controleren")).toHaveLength(1);
  });
});
