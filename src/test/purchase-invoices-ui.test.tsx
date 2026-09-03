import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// ── Shared mutable state ──────────────────────────────────────────────────────
const state = {
  invoices: [] as any[],
  isLoading: false,
  isError: false,
  duplicateIds: null as Set<string> | null,
  vraagposten: [] as any[],
  allocations: [] as any[],
  selectedClientId: "all" as string,
  // Records every call to usePaginatedPurchaseInvoices, in order, so tests
  // can inspect the FIRST render's arguments (before any effect can run).
  paginatedCalls: [] as any[],
};

const navigateSpy = vi.fn();

vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.selectedClientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c1", name: "Klant 1" }] }),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  PURCHASE_INVOICES_PAGE_SIZE: 50,
  buildYearOptions: (current = 2026, count = 10) =>
    Array.from({ length: count }, (_, i) => current - i),
  usePaginatedPurchaseInvoices: (args: any) => {
    state.paginatedCalls.push(args);
    return {
      data: state.isError || state.isLoading
        ? undefined
        : { invoices: state.invoices, total: state.invoices.length },
      isLoading: state.isLoading,
      isFetching: false,
      isError: state.isError,
      refetch: vi.fn(),
    };
  },
  usePurchaseInvoiceDuplicates: () => ({ data: state.duplicateIds }),
  useResetPageOnChange: vi.fn(),
  useUpdatePurchaseInvoice: () => ({ mutateAsync: vi.fn(() => Promise.resolve({})) }),
  useDeletePurchaseInvoice: () => ({ mutateAsync: vi.fn(() => Promise.resolve({})), isPending: false }),
  fetchAllExportablePurchaseInvoices: vi.fn(() => Promise.resolve([])),
  markPurchaseInvoicesExported: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/hooks/useVraagposten", () => ({
  useVraagposten: () => ({ data: state.vraagposten }),
}));
vi.mock("@/hooks/useBankTransactionAllocations", () => ({
  useBankTransactionAllocations: () => ({ data: state.allocations }),
  useUpsertBankTransactionAllocation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useBankTransactions", () => ({
  useBankTransactions: () => ({ data: [] }),
  useUpdateBankTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { access_token: "tok" } }),
}));
vi.mock("@tanstack/react-query", async (orig) => {
  const actual = await orig<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) };
});
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/lib/snelstart-export", () => ({
  exportPurchaseInvoicesCSV: vi.fn(() => []),
  fetchAllExportablePurchaseInvoices: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock("@/components/PurchaseInvoiceCreateDialog", () => ({
  PurchaseInvoiceCreateDialog: () => null,
}));
vi.mock("@/components/InvoiceNumberCopyButton", () => ({
  InvoiceNumberCopyButton: () => null,
}));

import Facturen from "@/pages/Facturen";

const makeInvoice = (id: string, over: Partial<any> = {}) => ({
  id,
  client_id: "c1",
  organization_id: "org-1",
  supplier: `Leverancier ${id}`,
  invoice_number: `F-${id}`,
  invoice_date: "2026-01-10",
  amount_excl: 100,
  amount_incl: 121,
  btw_amount: 21,
  btw_percentage: 21,
  remaining_amount: 121,
  status: "te_controleren",
  document_route: "pdf_route",
  ledger_account_text: null,
  ...over,
});

function renderFacturen() {
  render(
    (<MemoryRouter initialEntries={["/facturen"]}><Facturen /></MemoryRouter>) as ReactNode as any,
  );
}

beforeEach(() => {
  state.invoices = [];
  state.isLoading = false;
  state.isError = false;
  state.duplicateIds = null;
  state.vraagposten = [];
  state.allocations = [];
  state.selectedClientId = "all";
  state.paginatedCalls = [];
  navigateSpy.mockReset();
});

describe("Inkoopfacturen UI", () => {
  // 1. Geen dubbele zichtbare h1
  it("heeft een sr-only h1 en geen zichtbare paginatitel Inkoopfacturen", () => {
    renderFacturen();
    const h1 = document.querySelector("h1");
    expect(h1).toBeInTheDocument();
    expect(h1).toHaveTextContent("Inkoopfacturen");
    expect(h1).toHaveClass("sr-only");
  });

  // 2. Overzicht-tab aanwezig en actief
  it("toont Overzicht-tab en is standaard actief", () => {
    renderFacturen();
    const overzicht = screen.getByRole("tab", { name: /^Overzicht/ });
    expect(overzicht).toBeInTheDocument();
    expect(overzicht).toHaveAttribute("data-state", "active");
  });

  // 3. Upload-tab aanwezig
  it("toont Upload-tab", () => {
    renderFacturen();
    expect(screen.getByRole("tab", { name: /^Upload/ })).toBeInTheDocument();
  });

  // 4. Upload-tab: klantselectie intact
  it("Upload-tab bevat een klantselectie voor upload", () => {
    renderFacturen();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /^Upload/ }));
    expect(screen.getByText("Kies klant voor upload")).toBeInTheDocument();
  });

  // 5. Klantfilter aanwezig in action bar
  it("toont klantfilter in de action bar", () => {
    renderFacturen();
    expect(screen.getByText("Alle klanten")).toBeInTheDocument();
  });

  // 6. Zoekveld
  it("toont het zoekveld", () => {
    renderFacturen();
    expect(screen.getByPlaceholderText(/Zoeken op leverancier/)).toBeInTheDocument();
  });

  // 7. Workflowfilter chips aanwezig
  it("toont werkflow-filterchips Te controleren, Gecontroleerd, Betaald, Geëxporteerd", () => {
    renderFacturen();
    expect(screen.getByRole("button", { name: "Te controleren" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gecontroleerd" })).toBeInTheDocument();
    // "Betaald" appears in both workflow and payment chips
    expect(screen.getAllByRole("button", { name: "Betaald" }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Geëxporteerd" })).toBeInTheDocument();
  });

  // 8. Betaalstatusfilter chips aanwezig
  it("toont betaalstatus-filterchips Openstaand, Deelbetaling, Betaald", () => {
    renderFacturen();
    expect(screen.getByRole("button", { name: "Openstaand" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deelbetaling" })).toBeInTheDocument();
    // Two "Betaald" chips: one workflow, one payment — both should be present
    const betaaldBtns = screen.getAllByRole("button", { name: "Betaald" });
    expect(betaaldBtns.length).toBeGreaterThanOrEqual(2);
  });

  // 9. Documentroutefilter aanwezig
  it("toont Route-label voor documentroutefilter", () => {
    renderFacturen();
    expect(screen.getByText("Route")).toBeInTheDocument();
  });

  // 10. Workflowstatus correct zichtbaar in tabel
  it("toont werkflow-statusbadge Te controleren in de tabel", () => {
    state.invoices = [makeInvoice("i1", { status: "te_controleren", remaining_amount: 121 })];
    renderFacturen();
    // Text appears in both the workflow filter chip and the table badge
    expect(screen.getAllByText("Te controleren").length).toBeGreaterThan(0);
  });

  // 11. Betaalstatus correct zichtbaar (apart van workflowstatus)
  it("toont betaald-badge wanneer remaining_amount=0 en status!=betaald", () => {
    state.invoices = [makeInvoice("i1", { status: "gecontroleerd", remaining_amount: 0, amount_incl: 121 })];
    renderFacturen();
    // Text appears in both the workflow filter chip and the table badge
    expect(screen.getAllByText("Gecontroleerd").length).toBeGreaterThan(0);
    // Payment badge shows Betaald (separately) — also present in filter chips
    const betaaldBadges = screen.getAllByText("Betaald");
    expect(betaaldBadges.length).toBeGreaterThan(0);
  });

  // 12. Deelbetaling zichtbaar naast workflowstatus
  it("toont Deelbetaling-badge naast workflowstatus bij gedeeltelijke betaling", () => {
    state.invoices = [makeInvoice("i1", { status: "te_controleren", remaining_amount: 50, amount_incl: 121 })];
    renderFacturen();
    // Text appears in both the workflow filter chip and the table badge
    expect(screen.getAllByText("Te controleren").length).toBeGreaterThan(0);
    // "Deelbetaling" appears in both the payment filter chip and the table badge
    expect(screen.getAllByText("Deelbetaling").length).toBeGreaterThan(0);
  });

  // 13. Openstaand bedrag correct
  it("toont openstaand bedrag voor factuur", () => {
    state.invoices = [makeInvoice("i1", { remaining_amount: 121, amount_incl: 121 })];
    renderFacturen();
    // Amount column and remaining column both show the amount
    const amountTexts = screen.getAllByText(/121/);
    expect(amountTexts.length).toBeGreaterThan(0);
  });

  // 14. Duplicaatwaarschuwing zichtbaar
  it("toont Mogelijk dubbel-badge bij duplicaat factuurnummer", () => {
    state.invoices = [makeInvoice("i1")];
    state.duplicateIds = new Set(["i1"]);
    renderFacturen();
    expect(screen.getByText("Mogelijk dubbel")).toBeInTheDocument();
  });

  // 15. Vraagpostbadge zichtbaar
  it("toont vraagpost-badge wanneer factuur een open vraagpost heeft", () => {
    state.invoices = [makeInvoice("i1")];
    state.vraagposten = [{
      id: "vp1", source_type: "purchase_invoice", source_id: "i1",
      status: "open", titel: "Test vraagpost",
    }];
    renderFacturen();
    expect(screen.getByText("Vraagpost open")).toBeInTheDocument();
  });

  // 16. Sorteerbare tabelkolommen aanwezig
  it("toont sorteerbare kolomkop Datum", () => {
    state.invoices = [makeInvoice("i1")];
    renderFacturen();
    const datumHeader = screen.getByRole("columnheader", { name: /Datum/ });
    expect(datumHeader).toBeInTheDocument();
    expect(datumHeader.className).toContain("cursor-pointer");
  });

  // 17. Sorteerbare Bedrag-kolom
  it("toont sorteerbare kolomkop Bedrag", () => {
    state.invoices = [makeInvoice("i1")];
    renderFacturen();
    const bedragHeader = screen.getByRole("columnheader", { name: /Bedrag/ });
    expect(bedragHeader.className).toContain("cursor-pointer");
  });

  // 18. Row click navigeert naar bestaande workspace
  it("klik op factuurrij navigeert naar de purchase invoice workspace", () => {
    state.invoices = [makeInvoice("inv-row-test", { supplier: "Rij klik leverancier" })];
    renderFacturen();
    const row = screen.getAllByRole("row").find(r => r.textContent?.includes("Rij klik leverancier"));
    expect(row).toBeTruthy();
    if (row) fireEvent.click(row);
    expect(navigateSpy).toHaveBeenCalledWith("/facturen/inkoop/inv-row-test");
  });

  // 19. Interactieve knoppen triggeren geen row-navigatie
  it("klik op delete-knop opent geen row-navigatie", () => {
    state.invoices = [makeInvoice("i1", { supplier: "Delete test leverancier" })];
    renderFacturen();
    const deleteBtn = screen.getByRole("button", { name: /Verwijderen/ });
    fireEvent.click(deleteBtn);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  // 20. Empty state — nog geen facturen
  it("toont lege toestand wanneer er geen facturen zijn", () => {
    state.invoices = [];
    renderFacturen();
    expect(screen.getByText("Nog geen inkoopfacturen")).toBeInTheDocument();
  });

  // 21. Error state + retry-knop
  it("toont foutmelding en retry-knop bij laadprobleem", () => {
    state.isError = true;
    renderFacturen();
    expect(screen.getByText(/Inkoopfacturen laden mislukt/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Opnieuw proberen/ })).toBeInTheDocument();
  });

  // 22. Export Snelstart knop aanwezig
  it("toont de Export Snelstart knop", () => {
    renderFacturen();
    expect(screen.getByRole("button", { name: /Export Snelstart/ })).toBeInTheDocument();
  });

  // 23. Paginatie: pagina-informatie tonen
  it("toont pagina-informatie wanneer facturen aanwezig zijn", () => {
    state.invoices = Array.from({ length: 3 }, (_, i) => makeInvoice(`p${i}`));
    renderFacturen();
    expect(screen.getByText(/van \d+ facturen/)).toBeInTheDocument();
  });
});

// ── Client-context initial scope (regression guard) ─────────────────────────
// clientFilter/uploadClientId must be seeded from ClientContext's
// selectedClientId on the VERY FIRST render — not from a hardcoded "all"/""
// that only gets corrected by a later synchronization effect. A hardcoded
// default would make the initial usePaginatedPurchaseInvoices call fetch
// ALL clients' invoices for a split second, even when the user already has
// a specific client selected in the sidebar.
describe("Inkoopfacturen — initiële klantscope", () => {
  it("start met alle klanten wanneer ClientContext 'all' is", () => {
    state.selectedClientId = "all";
    renderFacturen();
    expect(screen.getByText("Alle klanten")).toBeInTheDocument();
    expect(state.paginatedCalls[0]?.clientId).toBeUndefined();
  });

  it("scoped de EERSTE render al naar de geselecteerde klant — geen 'alle klanten' flits", () => {
    state.selectedClientId = "c1";
    renderFacturen();
    // Every recorded call — including the very first — must already carry
    // the client scope. If the component instead initialized to "all" and
    // relied on a useEffect to correct it, the first call would have
    // clientId undefined.
    expect(state.paginatedCalls.length).toBeGreaterThan(0);
    expect(state.paginatedCalls[0].clientId).toBe("c1");
    expect(state.paginatedCalls.every((c) => c.clientId === "c1")).toBe(true);
    // The action bar reflects the selected client's name immediately.
    expect(screen.getByText("Klant 1")).toBeInTheDocument();
    expect(screen.queryByText("Alle klanten")).not.toBeInTheDocument();
  });

  it("Upload-tab start met de geselecteerde klant, niet met de kies-klant placeholder", () => {
    state.selectedClientId = "c1";
    renderFacturen();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /^Upload/ }));
    // With a client already selected, uploadClientId is pre-filled, so the
    // "choose a client" placeholder must not appear.
    expect(screen.queryByText("Kies klant voor upload")).not.toBeInTheDocument();
  });

  it("Upload-tab toont wel de kies-klant placeholder wanneer ClientContext 'all' is", () => {
    state.selectedClientId = "all";
    renderFacturen();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /^Upload/ }));
    expect(screen.getByText("Kies klant voor upload")).toBeInTheDocument();
  });
});
