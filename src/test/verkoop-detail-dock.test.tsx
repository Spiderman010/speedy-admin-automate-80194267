import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
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

const invoiceB = { ...invoice, id: "si-2", customer_name: "Tweede Klant BV", invoice_number: "V-DOK-002" };

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ session: null }) }));
// Bestuurbaar werkgebied (administratie en organisatie), voor de scopetest.
const scope = vi.hoisted(() => ({ clientId: "all", organizationId: "org-1" }));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: scope.clientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: scope.organizationId, isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c-1", name: "Administratie Een" }] }),
}));
vi.mock("@/hooks/useSalesInvoices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useSalesInvoices")>();
  return {
    ...actual,
    usePaginatedSalesInvoices: () => ({
      // Verse objecten per aanroep, zoals na een herlading van de query.
      data: { invoices: [{ ...invoice }, { ...invoiceB }], total: 2 },
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
import { SalesInvoiceDetailDock } from "@/components/SalesInvoiceEditDialog";
import { supabase } from "@/integrations/supabase/client";

function renderVerkoop() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/verkoop"]}>
        {/* Staat voor de navigatie van de app-shell (sidebar/kop) buiten de pagina. */}
        <nav>
          <Link to="/bank">Naar Bank</Link>
        </nav>
        <Routes>
          <Route path="/verkoop" element={<Verkoop />} />
          <Route path="/bank" element={<p>Bankpagina</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const { rerender } = render(tree());
  return { rerenderVerkoop: () => rerender(tree()) };
}

describe("Verkoop — desktop detaildok (>= 1360px)", () => {
  const originalMatchMedia = window.matchMedia;
  // Bestuurbare viewport: alleen de dok-breakpoint reageert op `wide`, en een
  // wissel wordt aan de luisteraars gemeld zoals een echte MediaQueryList doet.
  let wide = true;
  const listeners = new Set<() => void>();
  const setWide = (next: boolean) => {
    wide = next;
    act(() => listeners.forEach((l) => l()));
  };

  beforeEach(() => {
    scope.clientId = "all";
    scope.organizationId = "org-1";
    wide = true;
    listeners.clear();
    window.matchMedia = ((query: string) => ({
      get matches() {
        return query === "(min-width: 1360px)" && wide;
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  const rowFor = (nummer: string) => screen.getAllByRole("row").find((r) => r.textContent?.includes(nummer))!;

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

  it("wisselt zonder vraag van factuur zolang er niets is gewijzigd", () => {
    renderVerkoop();
    const dock = screen.getByTestId("sales-detail-dock");
    fireEvent.click(rowFor("V-DOK-001"));
    fireEvent.click(rowFor("V-DOK-002"));
    expect(screen.queryByTestId("sales-unsaved-switch")).not.toBeInTheDocument();
    expect(within(dock).getByDisplayValue("Tweede Klant BV")).toBeInTheDocument();
  });

  it("vraagt bevestiging bij een klik buiten het dok met niet-opgeslagen invoer (Codex P1)", () => {
    renderVerkoop();
    const dock = screen.getByTestId("sales-detail-dock");
    fireEvent.click(rowFor("V-DOK-001"));
    fireEvent.change(within(dock).getByDisplayValue("Dok Klant BV"), { target: { value: "Dok Klant BV (gewijzigd)" } });

    // Alles buiten het dok is nu inert; een klik daarbuiten opent de bevestiging.
    expect(screen.getByRole("table").closest("[inert]")).not.toBeNull();
    fireEvent.click(rowFor("V-DOK-002"));
    const confirm = screen.getByTestId("sales-unsaved-switch");
    expect(within(confirm).getByText("Wijzigingen niet opgeslagen")).toBeInTheDocument();
    // De gevolgen worden ook aangekondigd (Codex P2, review 3).
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(
      "De niet-opgeslagen wijzigingen in deze factuur gaan verloren.",
    );

    // Terug naar factuur: niets verloren, nog steeds factuur A.
    fireEvent.click(within(confirm).getByRole("button", { name: "Terug naar factuur" }));
    expect(screen.queryByTestId("sales-unsaved-switch")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Dok Klant BV (gewijzigd)")).toBeInTheDocument();
    expect(rowFor("V-DOK-001")).toHaveAttribute("data-state", "selected");

    // Opnieuw, nu verwerpen: de factuur sluit, het scherm is weer vrij en B kan worden gekozen.
    fireEvent.click(rowFor("V-DOK-002"));
    fireEvent.click(within(screen.getByTestId("sales-unsaved-switch")).getByRole("button", { name: "Wijzigingen verwerpen" }));
    expect(screen.queryByDisplayValue("Dok Klant BV (gewijzigd)")).not.toBeInTheDocument();
    expect(screen.getByRole("table").closest("[inert]")).toBeNull();
    fireEvent.click(rowFor("V-DOK-002"));
    expect(screen.getByDisplayValue("Tweede Klant BV")).toBeInTheDocument();
    expect(rowFor("V-DOK-002")).toHaveAttribute("data-state", "selected");
  });

  it("navigeert niet weg bij niet-opgeslagen invoer in het dok (Codex P1, review 5)", () => {
    renderVerkoop();
    fireEvent.click(rowFor("V-DOK-001"));
    fireEvent.change(
      within(screen.getByTestId("sales-detail-dock")).getByDisplayValue("Dok Klant BV"),
      { target: { value: "Nog niet opgeslagen" } },
    );
    expect(screen.getByRole("link", { name: "Naar Bank" }).closest("[inert]")).not.toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Naar Bank" }));
    expect(screen.queryByText("Bankpagina")).not.toBeInTheDocument();
    expect(screen.getByTestId("sales-unsaved-switch")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Nog niet opgeslagen")).toBeInTheDocument();
  });

  it("laat een open keuzemenu of dialoog (Radix-laag) zijn eigen klik-buiten afhandelen", () => {
    renderVerkoop();
    fireEvent.click(rowFor("V-DOK-001"));
    fireEvent.change(
      within(screen.getByTestId("sales-detail-dock")).getByDisplayValue("Dok Klant BV"),
      { target: { value: "Nog niet opgeslagen" } },
    );
    // Radix zet pointer-events op de body uit zolang een modale laag open is.
    document.body.style.pointerEvents = "none";
    try {
      fireEvent.click(document.body);
      expect(screen.queryByTestId("sales-unsaved-switch")).not.toBeInTheDocument();
    } finally {
      document.body.style.pointerEvents = "";
    }
    fireEvent.click(document.body);
    expect(screen.getByTestId("sales-unsaved-switch")).toBeInTheDocument();
  });

  it("navigeert gewoon zonder niet-opgeslagen invoer", () => {
    renderVerkoop();
    fireEvent.click(rowFor("V-DOK-001"));
    fireEvent.click(screen.getByRole("link", { name: "Naar Bank" }));
    expect(screen.getByText("Bankpagina")).toBeInTheDocument();
  });

  it("vraagt bij verversen of sluiten van het venster om bevestiging zolang er niet-opgeslagen invoer is", () => {
    renderVerkoop();
    fireEvent.click(rowFor("V-DOK-001"));
    const beforeUnload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(beforeUnload()).toBe(false);
    fireEvent.change(
      within(screen.getByTestId("sales-detail-dock")).getByDisplayValue("Dok Klant BV"),
      { target: { value: "Nog niet opgeslagen" } },
    );
    expect(beforeUnload()).toBe(true);
  });

  it("behoudt de invoer als dezelfde, al geopende factuur opnieuw wordt gekozen (Codex P2, review 2)", () => {
    renderVerkoop();
    fireEvent.click(rowFor("V-DOK-001"));
    fireEvent.change(
      within(screen.getByTestId("sales-detail-dock")).getByDisplayValue("Dok Klant BV"),
      { target: { value: "Concept blijft staan" } },
    );
    // De rij is inmiddels een nieuw object (verse query-data); opnieuw klikken
    // op dezelfde factuur mag het formulier niet opnieuw vullen. In het dok valt
    // die klik op de bewakingslaag; terug naar de factuur laat de invoer staan.
    fireEvent.click(rowFor("V-DOK-001"));
    expect(screen.getByDisplayValue("Concept blijft staan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Terug naar factuur" }));
    expect(screen.getByDisplayValue("Concept blijft staan")).toBeInTheDocument();
  });

  it("houdt de container vast bij een viewportwissel zolang er niet-opgeslagen invoer is (Codex P2)", () => {
    renderVerkoop();
    fireEvent.click(rowFor("V-DOK-001"));
    fireEvent.change(
      within(screen.getByTestId("sales-detail-dock")).getByDisplayValue("Dok Klant BV"),
      { target: { value: "Nog niet opgeslagen" } },
    );

    // Het venster wordt smaller dan 1360px: het dok blijft, de invoer ook, er komt geen dialoog.
    setWide(false);
    expect(screen.getByTestId("sales-detail-dock")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Nog niet opgeslagen")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Het vastgehouden dok blijft in beeld als vast paneel, niet onder de lijst (Codex P2, review 7).
    expect(screen.getByTestId("sales-detail-dock")).toHaveAttribute("data-layout", "floating");
    expect(screen.getByTestId("sales-detail-dock").className).toContain("fixed");

    // Weer breed: terug in de kolom, invoer nog steeds aanwezig.
    setWide(true);
    expect(screen.getByTestId("sales-detail-dock")).toHaveAttribute("data-layout", "docked");
    expect(screen.getByDisplayValue("Nog niet opgeslagen")).toBeInTheDocument();
  });

  it("volgt de viewport weer zodra er niets meer open staat", () => {
    renderVerkoop();
    expect(screen.getByTestId("sales-detail-dock")).toBeInTheDocument();
    setWide(false);
    expect(screen.queryByTestId("sales-detail-dock")).not.toBeInTheDocument();
  });

  it("toont nooit het document van een eerder gekozen factuur als dat antwoord later binnenkomt (Codex P1, review 3)", async () => {
    // Twee signed-URL-verzoeken die we zelf in omgekeerde volgorde laten slagen.
    const pending = new Map<string, (url: string) => void>();
    vi.mocked(supabase.storage.from).mockReturnValue({
      createSignedUrl: (path: string) =>
        new Promise((resolve) => pending.set(path, (url) => resolve({ data: { signedUrl: url }, error: null }))),
    } as never);
    const a = { ...invoice, pdf_path: "org/a.pdf" };
    const b = { ...invoiceB, pdf_path: "org/b.pdf" };
    const props = { open: true, onOpenChange: vi.fn(), onSave: vi.fn(), onApprove: vi.fn(), allInvoices: [] };
    const queryClient = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}><SalesInvoiceDetailDock {...props} invoice={a as never} /></QueryClientProvider>,
    );
    rerender(<QueryClientProvider client={queryClient}><SalesInvoiceDetailDock {...props} invoice={b as never} /></QueryClientProvider>);

    await act(async () => pending.get("org/b.pdf")!("https://signed/b.pdf"));
    await act(async () => pending.get("org/a.pdf")!("https://signed/a.pdf")); // te laat
    expect(document.querySelector("iframe")).toHaveAttribute("src", "https://signed/b.pdf");
  });

  it("start geen export zolang het dok niet-opgeslagen invoer heeft (Codex P1, review 4)", () => {
    renderVerkoop();
    fireEvent.click(rowFor("V-DOK-001"));
    fireEvent.change(
      within(screen.getByTestId("sales-detail-dock")).getByDisplayValue("Dok Klant BV"),
      { target: { value: "Nog niet opgeslagen" } },
    );
    vi.mocked(supabase.from).mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    expect(screen.getByTestId("sales-unsaved-switch")).toBeInTheDocument();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("sluit de geopende factuur als het werkgebied wisselt (Codex P1, review 6)", () => {
    const { rerenderVerkoop } = renderVerkoop();
    const dock = screen.getByTestId("sales-detail-dock");

    // Factuur A (administratie c-1) staat open in het dok.
    fireEvent.click(rowFor("V-DOK-001"));
    expect(within(dock).getByDisplayValue("Dok Klant BV")).toBeInTheDocument();

    // Andere administratie waar de factuur niet bij hoort: de factuur sluit.
    scope.clientId = "c-2";
    rerenderVerkoop();
    expect(within(dock).queryByDisplayValue("Dok Klant BV")).not.toBeInTheDocument();
  });

  it("houdt de factuur open bij een administratie waar zij bij hoort, sluit haar bij een andere organisatie", () => {
    const { rerenderVerkoop } = renderVerkoop();
    const dock = screen.getByTestId("sales-detail-dock");
    fireEvent.click(rowFor("V-DOK-001"));

    scope.clientId = "c-1"; // de administratie van de factuur zelf
    rerenderVerkoop();
    expect(within(dock).getByDisplayValue("Dok Klant BV")).toBeInTheDocument();

    scope.organizationId = "org-2";
    rerenderVerkoop();
    expect(within(dock).queryByDisplayValue("Dok Klant BV")).not.toBeInTheDocument();
  });
});
