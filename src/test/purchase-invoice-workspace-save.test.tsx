import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!(Element.prototype as any).hasPointerCapture) {
  (Element.prototype as any).hasPointerCapture = () => false;
  (Element.prototype as any).setPointerCapture = () => {};
  (Element.prototype as any).releasePointerCapture = () => {};
  (Element.prototype as any).scrollIntoView = () => {};
}

const toastSpy = vi.fn();
const navigateSpy = vi.fn();
const atomicMutateAsync = vi.fn();
const legacyUpdateMutateAsync = vi.fn();
const legacyReplaceMutateAsync = vi.fn();

const invoice = {
  id: "inv-1",
  client_id: "client-1",
  supplier: "Test Leverancier BV",
  invoice_number: "F-2026-001",
  invoice_date: "2026-07-20",
  amount_excl: 100,
  btw_amount: 21,
  amount_incl: 121,
  btw_percentage: 21,
  status: "te_controleren",
  ledger_account_id: null,
  ledger_account_text: "4400 - Kantoorkosten",
  leverancier_id: null,
  notes: "Bestaande notitie",
  remaining_amount: 121,
  file_path: null,
  document_route: "manual",
  route_reason: null,
  original_ubl_path: null,
  supplier_btw_number: null,
  ocr_data: null,
  organization_id: "org-1",
  user_id: "user-1",
  grootboekrekening_id: null,
  snelstart_package_download_count: 0,
  snelstart_package_downloaded_at: null,
  created_at: "2026-07-20T08:00:00Z",
  updated_at: "2026-07-20T08:00:00Z",
};

const storedLines = [
  {
    id: "line-1",
    purchase_invoice_id: "inv-1",
    user_id: "user-1",
    organization_id: "org-1",
    omschrijving: "Consultancy",
    amount_excl: 100,
    btw_percentage: 21,
    grootboekrekening_id: "gb-1",
    sort_order: 0,
    created_at: "2026-07-20T08:00:00Z",
  },
];

const ledgerRows = [
  { id: "gb-1", nummer: 4400, omschrijving: "Kantoorkosten" },
];

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ invoiceId: "inv-1" }),
    useNavigate: () => navigateSpy,
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "purchase_invoices") {
        throw new Error(`Unexpected table ${table}`);
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: invoice, error: null }),
          }),
        }),
      };
    },
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: null, error: null }),
      }),
    },
  },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({
    activeOrganizationId: "org-1",
    isReady: true,
  }),
}));

vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({
    data: [{ id: "client-1", name: "Klant Een", btw_vrijgesteld: false }],
  }),
}));

vi.mock("@/hooks/useLeveranciers", () => ({
  useLeveranciers: () => ({ data: [] }),
}));

vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: ledgerRows }),
}));

vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({ data: [invoice] }),
  useUpdatePurchaseInvoice: () => ({ mutateAsync: legacyUpdateMutateAsync }),
}));

vi.mock("@/hooks/usePurchaseInvoiceLines", () => ({
  usePurchaseInvoiceLines: () => ({ data: storedLines, isLoading: false }),
  useReplacePurchaseInvoiceLines: () => ({ mutateAsync: legacyReplaceMutateAsync }),
  useSavePurchaseInvoiceWithLines: () => ({ mutateAsync: atomicMutateAsync }),
}));

vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: ({ value, onValueChange, onIdChange }: any) => (
    <input
      aria-label="Grootboek"
      value={value ?? ""}
      onChange={(e) => {
        onValueChange?.(e.target.value);
        onIdChange?.("gb-1");
      }}
    />
  ),
}));

import PurchaseInvoiceWorkspace from "@/pages/PurchaseInvoiceWorkspace";

function renderWorkspace() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <PurchaseInvoiceWorkspace />
    </QueryClientProvider>,
  );
}

describe("PurchaseInvoiceWorkspace atomic save", () => {
  beforeEach(() => {
    toastSpy.mockReset();
    navigateSpy.mockReset();
    atomicMutateAsync.mockReset();
    legacyUpdateMutateAsync.mockReset();
    legacyReplaceMutateAsync.mockReset();
  });

  it("saves header and lines in one RPC call without legacy mutations", async () => {
    atomicMutateAsync.mockResolvedValue(invoice);

    renderWorkspace();

    await screen.findByDisplayValue("Test Leverancier BV");

    fireEvent.change(screen.getByDisplayValue("Test Leverancier BV"), {
      target: { value: "Bijgewerkte Leverancier BV" },
    });
    fireEvent.change(screen.getByDisplayValue("Consultancy"), {
      target: { value: "Consultancy juli" },
    });

    fireEvent.click(screen.getByRole("button", { name: /opslaan/i }));

    await waitFor(() => {
      expect(atomicMutateAsync).toHaveBeenCalledTimes(1);
    });

    expect(atomicMutateAsync).toHaveBeenCalledWith({
      invoiceId: "inv-1",
      headerUpdates: {
        client_id: "client-1",
        leverancier_id: null,
        supplier: "Bijgewerkte Leverancier BV",
        invoice_number: "F-2026-001",
        invoice_date: "2026-07-20",
        amount_excl: 100,
        btw_amount: 21,
        amount_incl: 121,
        btw_percentage: 21,
        ledger_account_text: "4400 - Kantoorkosten",
        notes: "Bestaande notitie",
      },
      lines: [
        {
          omschrijving: "Consultancy juli",
          amount_excl: 100,
          btw_percentage: 21,
          grootboekrekening_id: "gb-1",
        },
      ],
    });
    expect(legacyUpdateMutateAsync).not.toHaveBeenCalled();
    expect(legacyReplaceMutateAsync).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith({ title: "Factuur opgeslagen" });
  });

  it("shows a rollback-safe error toast when the atomic RPC fails", async () => {
    atomicMutateAsync.mockRejectedValue(new Error("constraint failure"));

    renderWorkspace();

    await screen.findByDisplayValue("Test Leverancier BV");
    fireEvent.click(screen.getByRole("button", { name: /opslaan/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Opslaan mislukt",
        description: "Opslaan mislukt. De bestaande factuur en boekingsregels zijn niet gewijzigd. (constraint failure)",
        variant: "destructive",
      });
    });
    expect(legacyUpdateMutateAsync).not.toHaveBeenCalled();
    expect(legacyReplaceMutateAsync).not.toHaveBeenCalled();
  });
});
