import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * #290 — de SnelStart-bankexport werkt alleen voor precies één administratie.
 *
 * Met meerdere geselecteerde administraties (of "Alle klanten") is de knop
 * "Export Snelstart" uitgeschakeld en ontstaat er geen CSV. Met één
 * administratie bevat de CSV uitsluitend de bankregels van díe administratie,
 * ook als de gegevens die de pagina binnenkrijgt regels van een andere
 * administratie bevatten (de nagebouwde whole-set hieronder levert bewust
 * regels van twee administraties).
 *
 * Voorheen bewaakten alleen drie letterlijke broncode-strings dit
 * (bank-transactions-pagination.test.tsx; nulmeting E-03, mutatie M1). Deze test
 * rendert de echte Bank-pagina en vangt de echte download af.
 */

const state = {
  transactions: [] as any[],
  toasts: [] as any[],
  blobs: [] as Array<{ content: string; type: string | undefined }>,
  downloads: [] as string[],
};

const row = (id: string, client_id: string, description: string, amount: number) => ({
  id,
  client_id,
  organization_id: "org-1",
  transaction_date: "2026-03-10",
  description,
  reference: null,
  counter_account: null,
  counter_account_name: null,
  amount,
  match_status: "handmatig_geboekt",
  match_confidence: null,
  matched_invoice_id: null,
  matched_invoice_type: null,
  grootboekrekening_id: "gb-4500",
  ledger_account: null,
  notes: null,
});

vi.mock("@/hooks/use-toast", () => {
  const toast = (t: unknown) => {
    state.toasts.push(t);
  };
  return { toast, useToast: () => ({ toast }) };
});
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
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({
    data: [
      { id: "c1", name: "Klant 1", btw_status: "btw_plichtig", bank_dagboek: 1100 },
      { id: "c2", name: "Klant 2", btw_status: "btw_plichtig", bank_dagboek: 1110 },
    ],
  }),
}));
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
  // Bewust NIET op administratie gefilterd: de export moet zelf afbakenen.
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
  useActiveGrootboekrekeningen: () => ({
    data: [{ id: "gb-4500", nummer: 4500, omschrijving: "Telefoonkosten", organization_id: "org-1", client_id: null }],
  }),
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
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));
vi.mock("@/components/OrganizationSelector", () => ({ OrganizationSelector: () => null }));
// De klantkeuze als drie knoppen; de pagina krijgt exact de waarde die de echte
// ClientMultiSelect zou doorgeven.
vi.mock("@/components/ClientMultiSelect", () => ({
  ClientMultiSelect: ({ value, onChange }: any) => (
    <div>
      <span data-testid="client-select">{value.allMode ? "alle" : value.selectedIds.join(",")}</span>
      <button type="button" onClick={() => onChange({ allMode: false, selectedIds: ["c1"] })}>kies c1</button>
      <button type="button" onClick={() => onChange({ allMode: false, selectedIds: ["c1", "c2"] })}>kies c1 en c2</button>
      <button type="button" onClick={() => onChange({ allMode: true, selectedIds: [] })}>kies alle klanten</button>
    </div>
  ),
}));

import Bank from "@/pages/Bank";

const urlStatics = URL as unknown as Record<string, unknown>;
let anchorClick: { mockRestore: () => void } | undefined;

beforeEach(() => {
  state.transactions = [
    row("t-c1-a", "c1", "Telefoon klant 1", -50),
    row("t-c1-b", "c1", "Internet klant 1", -25),
    row("t-c2-a", "c2", "Telefoon klant 2", -75),
  ];
  state.toasts = [];
  state.blobs = [];
  state.downloads = [];
  // De echte download afvangen: Blob-inhoud, object-URL en de klik op de link.
  vi.stubGlobal(
    "Blob",
    class {
      constructor(parts: unknown[], options?: { type?: string }) {
        state.blobs.push({ content: parts.map(String).join(""), type: options?.type });
      }
    },
  );
  urlStatics.createObjectURL = vi.fn(() => "blob:boekassist-test");
  urlStatics.revokeObjectURL = vi.fn();
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    state.downloads.push(this.download);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  anchorClick?.mockRestore();
  delete urlStatics.createObjectURL;
  delete urlStatics.revokeObjectURL;
});

function renderBank() {
  // Een eigen QueryClient: elke hook die hier niet is nagebouwd, faalt dan
  // zichtbaar in de test in plaats van op een ontbrekende provider.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/bank?client=c1"]}>
        <Bank />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const exportButton = () => screen.getByRole("button", { name: /Export Snelstart/ });
// `hidden: true`: een open, modale dialoog verbergt de rest van de pagina voor
// hulptechnologie, maar de klantselectie kan dan nog steeds wijzigen (URL,
// organisatiewissel); de dialoog moet die wijziging zelf opnieuw toetsen.
const choose = (label: string) => fireEvent.click(screen.getAllByRole("button", { name: label, hidden: true })[0]);
const csvBlobs = () => state.blobs.filter((b) => (b.type ?? "").startsWith("text/csv"));

describe("#290 SnelStart-bankexport: alleen bij precies één administratie", () => {
  it("met twee geselecteerde administraties is de knop uit en ontstaat er geen CSV", () => {
    renderBank();
    choose("kies c1 en c2");
    expect(screen.getByTestId("client-select")).toHaveTextContent("c1,c2");

    expect(exportButton()).toBeDisabled();
    fireEvent.click(exportButton());

    expect(screen.queryByRole("button", { name: /Download bankexport/ })).toBeNull();
    expect(csvBlobs()).toEqual([]);
    expect(urlStatics.createObjectURL).not.toHaveBeenCalled();
    expect(state.downloads).toEqual([]);
    expect(state.toasts.some((t) => t?.title === "Bankexport aangemaakt")).toBe(false);
  });

  it("met 'Alle klanten' is de knop ook uit en ontstaat er geen CSV", () => {
    renderBank();
    choose("kies alle klanten");
    expect(screen.getByTestId("client-select")).toHaveTextContent("alle");

    expect(exportButton()).toBeDisabled();
    fireEvent.click(exportButton());

    expect(screen.queryByRole("button", { name: /Download bankexport/ })).toBeNull();
    expect(csvBlobs()).toEqual([]);
    expect(state.downloads).toEqual([]);
  });

  it("met één administratie bevat de CSV alleen díe bankregels, ook als de data er meer bevat", async () => {
    renderBank();
    expect(screen.getByTestId("client-select")).toHaveTextContent("c1");
    expect(exportButton()).toBeEnabled();
    fireEvent.click(exportButton());

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Download bankexport/ }));

    await waitFor(() => expect(csvBlobs()).toHaveLength(1));
    const csv = csvBlobs()[0].content;
    expect(csv).toContain("Telefoon klant 1");
    expect(csv).toContain("Internet klant 1");
    expect(csv).not.toContain("klant 2");
    // Twee transacties × twee boekregels, plus de kopregel; dagboek van klant 1.
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(5);
    expect(lines.slice(1).every((l) => l.startsWith("1100;"))).toBe(true);
    expect(state.downloads).toEqual(["Klant_1_banktransacties_snelstart.csv"]);
    expect(state.toasts).toContainEqual(
      expect.objectContaining({ title: "Bankexport aangemaakt", description: "2 bankregel(s) geëxporteerd." }),
    );
  });

  it("wie na de voorcontrole alsnog meer administraties kiest, kan niet meer downloaden", async () => {
    renderBank();
    fireEvent.click(exportButton());
    const dialog = await screen.findByRole("dialog");
    const download = within(dialog).getByRole("button", { name: /Download bankexport/ });
    expect(download).toBeEnabled();

    choose("kies c1 en c2");
    expect(download).toBeDisabled();
    fireEvent.click(download);

    expect(csvBlobs()).toEqual([]);
    expect(state.downloads).toEqual([]);
  });
});
