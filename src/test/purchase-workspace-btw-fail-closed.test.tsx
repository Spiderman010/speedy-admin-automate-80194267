import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Herstel P4 — de inkoopwerkbank neemt nooit stil een btw-percentage aan,
 * herleidt de kop nooit uit regels, laat btw nooit stil vallen en wisselt de
 * administratie niet per toetsaanslag.
 *
 * Gedragstests op de ECHTE werkbank: alleen de databronnen en de opslag-RPC
 * zijn vervangen (mockpatroon van purchase-invoice-workspace-ui.test.tsx). Elk
 * scenario is de reproductie uit de nulmeting (A2-02, D-01, FD-N2, F1c-N1,
 * D-02, A3-16) en was vóór deze wijziging rood.
 */

if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
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

const baseInvoice = {
  id: "inv-1",
  client_id: "client-1",
  supplier: "Verzekeraar NV",
  invoice_number: "POL-2026-1",
  invoice_date: "2026-07-20",
  amount_excl: 100 as number | null,
  btw_amount: 21 as number | null,
  amount_incl: 121 as number | null,
  btw_percentage: 21 as number | null,
  status: "te_controleren",
  ledger_account_id: null,
  ledger_account_text: null,
  leverancier_id: null,
  notes: null,
  remaining_amount: 121,
  file_path: null as string | null,
  document_route: "pdf_route",
  route_reason: null,
  original_ubl_path: null,
  supplier_btw_number: null,
  ocr_data: null as unknown,
  organization_id: "org-1",
  user_id: "user-1",
  grootboekrekening_id: null,
  snelstart_package_download_count: 0,
  snelstart_package_downloaded_at: null,
  created_at: "2026-07-20T08:00:00Z",
  updated_at: "2026-07-20T08:00:00Z",
};

const baseLine = {
  id: "line-1", purchase_invoice_id: "inv-1", user_id: "user-1", organization_id: "org-1",
  omschrijving: "Premie", amount_excl: 100, btw_percentage: 21 as number | null, grootboekrekening_id: "gb-1",
  sort_order: 0, created_at: "2026-07-20T08:00:00Z",
};

/** Wat process-invoice voor een 0%-factuur opsloeg: `|| null` maakte van 0 een NULL. */
const ZERO_AS_STORED = { amount_excl: 100, btw_amount: null, amount_incl: 100, btw_percentage: null, remaining_amount: 100 };

const state = {
  invoice: { ...baseInvoice } as any,
  storedLines: [] as any[],
  clients: [] as any[],
  /** null = nog niet geboekt. */
  posting: null as null | { purchase_invoice_id: string; posting_group_id: string; created_at: string },
  /** Koppelingen van deze factuur; `"fout"` = de controle mislukt. */
  allocations: [] as Array<{ id: string }> | "fout",
};

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useParams: () => ({ invoiceId: "inv-1" }), useNavigate: () => navigateSpy };
});

/** Een kleine, ketenbare PostgREST-dubbel: elke filter geeft zichzelf terug. */
function chain(result: () => { data: unknown; error: unknown }) {
  const q: any = {};
  for (const m of ["select", "eq", "in", "order", "limit", "range"]) q[m] = () => q;
  q.maybeSingle = async () => result();
  q.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(result()).then(resolve, reject);
  return q;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "purchase_invoices") return chain(() => ({ data: state.invoice, error: null }));
      if (table === "purchase_invoice_postings") return chain(() => ({ data: state.posting, error: null }));
      if (table === "bank_transaction_allocations") {
        return chain(() => (state.allocations === "fout"
          ? { data: null, error: { message: "permission denied" } }
          : { data: state.allocations, error: null }));
      }
      throw new Error(`Unexpected table ${table}`);
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({ useClients: () => ({ data: state.clients }) }));
vi.mock("@/hooks/useLeveranciers", () => ({ useLeveranciers: () => ({ data: [] }) }));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: [{ id: "gb-1", nummer: 4400, omschrijving: "Kantoorkosten" }] }),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({ usePurchaseInvoices: () => ({ data: [state.invoice] }) }));
vi.mock("@/hooks/usePurchaseInvoiceLines", () => ({
  usePurchaseInvoiceLines: () => ({ data: state.storedLines, isLoading: false }),
  useSavePurchaseInvoiceWithLines: () => ({ mutateAsync: atomicMutateAsync }),
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: ({ value, onValueChange, onIdChange }: any) => (
    <input aria-label="Grootboek" value={value ?? ""}
      onChange={(e) => { onValueChange?.(e.target.value); onIdChange?.("gb-1"); }} />
  ),
}));

import PurchaseInvoiceWorkspace from "@/pages/PurchaseInvoiceWorkspace";

function renderWorkspace() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PurchaseInvoiceWorkspace />
    </QueryClientProvider>,
  );
}

async function ready() {
  renderWorkspace();
  await screen.findByLabelText("Leveranciersnaam");
}

const approveBtn = () => screen.getByRole("button", { name: /goedkeuren/i });
const saveBtn = () => screen.getByRole("button", { name: /^opslaan$/i });
const totals = () => screen.getByTestId("totals-summary");
const headerPct = () => screen.getByRole("combobox", { name: "BTW-percentage" });
const linePcts = () => screen.queryAllByRole("combobox", { name: "BTW-percentage regel" });
const actionBar = () => within(screen.getByTestId("action-bar"));

/** Radix Select in jsdom: openen met het toetsenbord, dan de optie aanklikken. */
async function choose(trigger: HTMLElement, option: string) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

/** Kies een grootboekrekening voor de (enige) regel. */
function chooseLineAccount() {
  const inputs = screen.getAllByLabelText("Grootboek");
  fireEvent.change(inputs[inputs.length - 1], { target: { value: "4400 - Kantoorkosten" } });
}

beforeEach(() => {
  toastSpy.mockReset();
  navigateSpy.mockReset();
  atomicMutateAsync.mockReset();
  atomicMutateAsync.mockResolvedValue(baseInvoice);
  state.invoice = { ...baseInvoice };
  state.storedLines = [];
  state.posting = null;
  state.allocations = [];
  state.clients = [
    { id: "client-1", name: "Klant Een BV", btw_vrijgesteld: false },
    { id: "client-2", name: "Tweede Klant BV", btw_vrijgesteld: false },
  ];
});

// ── A2-02 / D-01: een ontbrekend percentage blijft "nog niet gekozen" ────────

describe("A2-02 / D-01 — de €100/€0/€100-factuur wordt nooit stil € 121", () => {
  it("toont geen 21%, verandert de kop niet en meldt geen 'sluit aan'; goedkeuren vraagt een expliciete keuze", async () => {
    state.invoice = { ...baseInvoice, ...ZERO_AS_STORED };
    await ready();

    // De kop is het document: 100 / leeg / 100, geen percentage.
    expect(screen.getByLabelText("Bedrag excl.")).toHaveValue("100,00");
    expect(screen.getByLabelText("BTW-bedrag")).toHaveValue("");
    expect(screen.getByLabelText("Bedrag incl.")).toHaveValue("100,00");
    expect(headerPct()).not.toHaveTextContent("21%");
    expect(headerPct()).toHaveTextContent("Kies");
    // De afgeleide regel krijgt evenmin een percentage.
    expect(screen.getByLabelText("Bedrag excl. regel")).toHaveValue("100,00");
    expect(linePcts()).toHaveLength(1);
    expect(linePcts()[0]).not.toHaveTextContent("21%");

    // Geen groene totaalcontrole zolang de btw niet gekozen is.
    expect(totals()).not.toHaveAttribute("data-totals-state", "green");
    expect(within(totals()).getByRole("status")).toHaveTextContent("BTW niet herkend — kies 0%, 9% of 21%.");

    chooseLineAccount();
    expect(approveBtn()).toBeDisabled();
    expect(actionBar().getByText(/Goedkeuren nog niet mogelijk/).parentElement).toHaveTextContent("BTW niet herkend — kies 0%, 9% of 21%");
  });

  it("na de expliciete keuze 0% sluit het aan op de ORIGINELE kop en gaat er nergens 21 de database in", async () => {
    state.invoice = { ...baseInvoice, ...ZERO_AS_STORED };
    await ready();
    await choose(headerPct(), "0%");
    // De kopkeuze geldt ook voor de regel die nog geen keuze had.
    await waitFor(() => expect(linePcts()[0]).toHaveTextContent("0%"));
    chooseLineAccount();

    await waitFor(() => expect(totals()).toHaveAttribute("data-totals-state", "green"));
    expect(screen.getByLabelText("Bedrag incl.")).toHaveValue("100,00");
    await waitFor(() => expect(approveBtn()).toBeEnabled());
    fireEvent.click(approveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    const { headerUpdates, lines } = atomicMutateAsync.mock.calls[0][0];
    expect(headerUpdates).toMatchObject({ amount_excl: 100, btw_amount: null, amount_incl: 100, btw_percentage: 0, status: "gecontroleerd" });
    expect(lines).toEqual([{ omschrijving: "Verzekeraar NV", amount_excl: 100, btw_percentage: 0, grootboekrekening_id: "gb-1" }]);
  });

  it("kiest de gebruiker 21% bij een document van € 100 incl., dan vergelijkt de controle met dat document: geen groen, geen goedkeuring", async () => {
    state.invoice = { ...baseInvoice, ...ZERO_AS_STORED };
    await ready();
    await choose(headerPct(), "21%");
    chooseLineAccount();
    // De kop blijft het document; hij wordt niet naar 121 "genormaliseerd".
    expect(screen.getByLabelText("Bedrag incl.")).toHaveValue("100,00");
    expect(screen.getByLabelText("BTW-bedrag")).toHaveValue("");
    await waitFor(() => expect(totals()).toHaveAttribute("data-totals-state", "amber"));
    expect(approveBtn()).toBeDisabled();
  });

  it("controle: een opgeslagen 0 blijft 0 — 0 en NULL zijn strikt verschillend", async () => {
    state.invoice = { ...baseInvoice, amount_excl: 100, btw_amount: 0, amount_incl: 100, btw_percentage: 0, remaining_amount: 100 };
    await ready();
    expect(headerPct()).toHaveTextContent("0%");
    expect(screen.getByLabelText("BTW-bedrag")).toHaveValue("0,00");
    expect(linePcts()[0]).toHaveTextContent("0%");
    chooseLineAccount();
    await waitFor(() => expect(approveBtn()).toBeEnabled());
    fireEvent.click(approveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    expect(atomicMutateAsync.mock.calls[0][0].headerUpdates).toMatchObject({ btw_amount: 0, amount_incl: 100, btw_percentage: 0 });
  });

  it("een 0%-UBL-e-factuur blijft 0%: de UBL-regel met 0% en het kop-percentage 0 worden zo bewaard", async () => {
    state.invoice = {
      ...baseInvoice, amount_excl: 100, btw_amount: 0, amount_incl: 100, btw_percentage: 0, remaining_amount: 100,
      ocr_data: { source: "ubl", mixed_vat_rates: false, invoice_lines: [{ description: "Premie aansprakelijkheid", amount_excl: 100, btw_percentage: 0 }] },
    };
    await ready();
    expect(screen.getByLabelText("Omschrijving")).toHaveValue("Premie aansprakelijkheid");
    expect(linePcts()[0]).toHaveTextContent("0%");
    expect(headerPct()).toHaveTextContent("0%");
    chooseLineAccount();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    expect(atomicMutateAsync.mock.calls[0][0].headerUpdates).toMatchObject({ btw_amount: 0, amount_incl: 100, btw_percentage: 0 });
  });

  it("alleen incl. bekend en geen percentage: er wordt geen regel verzonnen en de kop blijft ongemoeid", async () => {
    state.invoice = { ...baseInvoice, amount_excl: null, btw_amount: null, amount_incl: 121, btw_percentage: null };
    await ready();
    expect(screen.getByText("Nog geen boekingsregels.")).toBeInTheDocument();
    expect(screen.getByLabelText("Bedrag excl.")).toHaveValue("");
    expect(screen.getByLabelText("Bedrag incl.")).toHaveValue("121,00");
  });

  it("een opgeslagen afwijkend percentage (6%) blijft bij Opslaan ongewijzigd, maar is geen keuze: goedkeuren blijft dicht", async () => {
    state.invoice = { ...baseInvoice, amount_excl: 100, btw_amount: 6, amount_incl: 106, btw_percentage: 6, remaining_amount: 106 };
    state.storedLines = [{ ...baseLine, amount_excl: 100, btw_percentage: 6 }];
    await ready();
    expect(approveBtn()).toBeDisabled();
    expect(actionBar().getByText(/Goedkeuren nog niet mogelijk/).parentElement).toHaveTextContent("BTW niet herkend");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    const { headerUpdates, lines } = atomicMutateAsync.mock.calls[0][0];
    expect(headerUpdates.btw_percentage).toBe(6);
    expect(lines[0].btw_percentage).toBe(6);
  });

  it("een nieuwe regel begint zonder percentage zolang de kop er geen heeft", async () => {
    state.invoice = { ...baseInvoice, ...ZERO_AS_STORED };
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /regel toevoegen/i }));
    expect(linePcts()).toHaveLength(2);
    for (const s of linePcts()) expect(s).not.toHaveTextContent(/21%|9%|0%/);
  });
});

// ── FD-N2: gemengde tarieven ────────────────────────────────────────────────

describe("FD-N2 — een ontbrekend kop-percentage wordt bij gemengde tarieven nooit 21", () => {
  const mixedUbl = {
    ...baseInvoice, amount_excl: 200, btw_amount: 30, amount_incl: 230, btw_percentage: null, remaining_amount: 230,
    ocr_data: { source: "ubl", mixed_vat_rates: true, invoice_lines: [
      { description: "Lunch", amount_excl: 100, btw_percentage: 9 },
      { description: "Zaalhuur", amount_excl: 100, btw_percentage: 21 },
    ] },
  };

  it("de regels houden 9% en 21%, de kop toont geen 21% en Opslaan bewaart geen 21", async () => {
    state.invoice = { ...mixedUbl };
    await ready();
    expect(linePcts().map((s) => s.textContent)).toEqual(["9%", "21%"]);
    expect(headerPct()).not.toHaveTextContent("21%");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    expect(atomicMutateAsync.mock.calls[0][0].headerUpdates).toMatchObject({
      amount_excl: 200, btw_amount: 30, amount_incl: 230, btw_percentage: null,
    });
  });

  it("goedkeuren vraagt 'Gemengd'; dat wordt als NULL bewaard", async () => {
    state.invoice = { ...mixedUbl };
    await ready();
    for (const input of screen.getAllByLabelText("Grootboek").slice(1)) {
      fireEvent.change(input, { target: { value: "4400 - Kantoorkosten" } });
    }
    expect(approveBtn()).toBeDisabled();
    expect(actionBar().getByText(/Goedkeuren nog niet mogelijk/).parentElement).toHaveTextContent("Gemengd");
    await choose(headerPct(), "Gemengd");
    await waitFor(() => expect(approveBtn()).toBeEnabled());
    fireEvent.click(approveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    expect(atomicMutateAsync.mock.calls[0][0].headerUpdates).toMatchObject({ btw_percentage: null, status: "gecontroleerd" });
  });

  it("een opgeslagen kop-percentage dat niet bij de regels past, blokkeert goedkeuren", async () => {
    state.invoice = { ...mixedUbl, btw_percentage: 21 };
    state.storedLines = [
      { ...baseLine, id: "l-1", omschrijving: "Lunch", amount_excl: 100, btw_percentage: 9 },
      { ...baseLine, id: "l-2", omschrijving: "Zaalhuur", amount_excl: 100, btw_percentage: 21, sort_order: 1 },
    ];
    await ready();
    expect(approveBtn()).toBeDisabled();
    expect(actionBar().getByText(/Goedkeuren nog niet mogelijk/).parentElement)
      .toHaveTextContent("Het btw-percentage van de factuur (21%) past niet bij de boekingsregels (9%, 21%); kies Gemengd.");
  });
});

// ── F1c-N1: btw-vrijgestelde administratie ──────────────────────────────────

describe("F1c-N1 — bij een btw-vrijgestelde administratie valt de btw nooit stil weg", () => {
  beforeEach(() => {
    state.clients = [{ id: "client-1", name: "Klant Een BV", btw_vrijgesteld: true }];
  });

  it("OCR 100 + 21 = 121: de werkbank toont de btw, maakt incl niet gelijk aan excl en blokkeert goedkeuren en boeken", async () => {
    state.invoice = { ...baseInvoice, amount_excl: 100, btw_amount: 21, amount_incl: 121, btw_percentage: 21 };
    await ready();
    expect(screen.getByLabelText("Bedrag excl.")).toHaveValue("100,00");
    expect(screen.getByLabelText("BTW-bedrag")).toHaveValue("21,00");
    expect(screen.getByLabelText("Bedrag incl.")).toHaveValue("121,00");
    expect(screen.getByTestId("vrijgesteld-btw-blocker")).toHaveTextContent(/btw-vrijgesteld/i);
    expect(screen.getByTestId("vrijgesteld-btw-blocker")).toHaveTextContent("21,00");
    expect(totals()).not.toHaveAttribute("data-totals-state", "green");
    chooseLineAccount();
    expect(approveBtn()).toBeDisabled();
    expect(actionBar().getByText(/Goedkeuren nog niet mogelijk/).parentElement).toHaveTextContent(/btw-vrijgesteld/i);
    expect(screen.getByTestId("purchase-posting-button")).toBeDisabled();
  });

  it("H4-1: met een opgeslagen regel van 21% die op de kop aansluit, blijft goedkeuren dicht (alleen de vrijgesteld-blokkade houdt dit tegen)", async () => {
    state.invoice = { ...baseInvoice, amount_excl: 100, btw_amount: 21, amount_incl: 121, btw_percentage: 21 };
    state.storedLines = [{ ...baseLine }];
    await ready();
    expect(screen.getByTestId("vrijgesteld-btw-blocker")).toHaveTextContent(/btw-vrijgesteld/i);
    expect(totals()).not.toHaveAttribute("data-totals-state", "green");
    expect(approveBtn()).toBeDisabled();
    expect(actionBar().getByText(/Goedkeuren nog niet mogelijk/).parentElement).toHaveTextContent(/btw-vrijgesteld/i);
  });

  it("Opslaan bewaart de btw die op de factuur staat in plaats van haar weg te gooien", async () => {
    state.invoice = { ...baseInvoice, amount_excl: 100, btw_amount: 21, amount_incl: 121, btw_percentage: 21 };
    await ready();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    expect(atomicMutateAsync.mock.calls[0][0].headerUpdates).toMatchObject({ amount_excl: 100, btw_amount: 21, amount_incl: 121 });
  });

  it("controle: zonder btw op de factuur blijft de vrijgestelde flow werken (0%, btw 0,00, goedkeurbaar)", async () => {
    state.invoice = { ...baseInvoice, amount_excl: 250, btw_amount: null, amount_incl: 250, btw_percentage: 21 };
    await ready();
    expect(headerPct()).toBeDisabled();
    expect(screen.getByLabelText("BTW-bedrag")).toHaveValue("0,00");
    expect(linePcts()[0]).toHaveTextContent("0%");
    expect(screen.queryByTestId("vrijgesteld-btw-blocker")).not.toBeInTheDocument();
    chooseLineAccount();
    await waitFor(() => expect(approveBtn()).toBeEnabled());
  });

  it("alleen incl. bekend: het brutobedrag wordt de kostenpost (er valt geen btw weg)", async () => {
    state.invoice = { ...baseInvoice, amount_excl: null, btw_amount: null, amount_incl: 121, btw_percentage: null };
    await ready();
    expect(screen.getByLabelText("Bedrag excl.")).toHaveValue("121,00");
    expect(screen.getByLabelText("Bedrag incl.")).toHaveValue("121,00");
    expect(screen.getByLabelText("Bedrag excl. regel")).toHaveValue("121,00");
  });

  it("alleen excl. bekend: incl. wordt NIET gelijkgesteld aan excl. (dat zou mogelijke btw laten wegvallen)", async () => {
    state.invoice = { ...baseInvoice, amount_excl: 100, btw_amount: null, amount_incl: null, btw_percentage: null };
    await ready();
    expect(screen.getByLabelText("Bedrag incl.")).toHaveValue("");
    chooseLineAccount();
    expect(approveBtn()).toBeDisabled();
  });
});

// ── D-02: de administratie wisselt niet per toetsaanslag ────────────────────

describe("D-02 — administratie wijzigen vraagt een expliciete, bevestigde keuze", () => {
  const adminTrigger = () => screen.getByRole("combobox", { name: "Administratie" });

  it("typen op de gesloten keuzelijst wijzigt de administratie niet; Opslaan houdt de oorspronkelijke", async () => {
    await ready();
    await waitFor(() => expect(adminTrigger()).toBeEnabled());
    adminTrigger().focus();
    fireEvent.keyDown(adminTrigger(), { key: "T" });
    await new Promise((r) => setTimeout(r, 0));
    expect(adminTrigger()).toHaveTextContent("Klant Een BV");
    expect(adminTrigger()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    expect(atomicMutateAsync.mock.calls[0][0].headerUpdates.client_id).toBe("client-1");
  });

  it("een andere administratie kiezen vraagt bevestiging; annuleren laat alles staan", async () => {
    await ready();
    await waitFor(() => expect(adminTrigger()).toBeEnabled());
    await choose(adminTrigger(), "Tweede Klant BV");
    const dialog = await screen.findByTestId("client-move-dialog");
    expect(dialog).toHaveTextContent("Klant Een BV");
    expect(dialog).toHaveTextContent("Tweede Klant BV");
    fireEvent.click(within(dialog).getByRole("button", { name: "Annuleren" }));
    await waitFor(() => expect(screen.queryByTestId("client-move-dialog")).not.toBeInTheDocument());
    expect(adminTrigger()).toHaveTextContent("Klant Een BV");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    expect(atomicMutateAsync.mock.calls[0][0].headerUpdates.client_id).toBe("client-1");
  });

  it("na bevestigen gaat de nieuwe administratie bij Opslaan mee", async () => {
    await ready();
    await waitFor(() => expect(adminTrigger()).toBeEnabled());
    await choose(adminTrigger(), "Tweede Klant BV");
    const dialog = await screen.findByTestId("client-move-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Verplaatsen" }));
    await waitFor(() => expect(adminTrigger()).toHaveTextContent("Tweede Klant BV"));
    expect(screen.getByTestId("client-move-pending")).toHaveTextContent("Tweede Klant BV");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    expect(atomicMutateAsync.mock.calls[0][0].headerUpdates.client_id).toBe("client-2");
  });

  it("een geboekte factuur kan niet van administratie wisselen", async () => {
    state.posting = { purchase_invoice_id: "inv-1", posting_group_id: "grp-1", created_at: "2026-07-21T00:00:00Z" };
    await ready();
    await waitFor(() => expect(screen.getByTestId("client-move-blocked")).toHaveTextContent(/geboekt/i));
    expect(adminTrigger()).toBeDisabled();
  });

  it("een factuur met een bankkoppeling kan niet van administratie wisselen (A2-22)", async () => {
    state.allocations = [{ id: "alloc-1" }];
    await ready();
    await waitFor(() => expect(screen.getByTestId("client-move-blocked")).toHaveTextContent(/gekoppeld/i));
    expect(adminTrigger()).toBeDisabled();
  });

  it("is de koppelcontrole niet te lezen, dan blijft wisselen dicht (fail-closed)", async () => {
    state.allocations = "fout";
    await ready();
    await waitFor(() => expect(screen.getByTestId("client-move-blocked")).toBeInTheDocument());
    expect(adminTrigger()).toBeDisabled();
  });
});

// ── A3-16: subcenten worden half-up afgerond, gelijk aan de database ─────────

describe("A3-16 — regel- en kopbedragen worden als hele centen half-up verstuurd, zoals PostgreSQL ze opslaat", () => {
  it("1,005 wordt 1,01 (niet 1,00): regel en kop sluiten ook na opslag op elkaar aan", async () => {
    state.invoice = { ...baseInvoice, amount_excl: null, btw_amount: 0, amount_incl: null, btw_percentage: 0 };
    state.storedLines = [{ ...baseLine, amount_excl: 1.005, btw_percentage: 0 }];
    await ready();
    fireEvent.change(screen.getByLabelText("Bedrag excl."), { target: { value: "1,005" } });
    fireEvent.change(screen.getByLabelText("Bedrag incl."), { target: { value: "1,005" } });
    fireEvent.change(screen.getByLabelText("Bedrag excl. regel"), { target: { value: "1,005" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    const { headerUpdates, lines } = atomicMutateAsync.mock.calls[0][0];
    expect(lines[0].amount_excl).toBe(1.01);
    expect(headerUpdates.amount_excl).toBe(1.01);
    expect(headerUpdates.amount_incl).toBe(1.01);
  });
});
