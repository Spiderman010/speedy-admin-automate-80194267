import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom polyfills Radix primitives expect (same as the atomic-save test).
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

// ── Fixtures & mutable state ─────────────────────────────────────────────────
const toastSpy = vi.fn();
const navigateSpy = vi.fn();
const atomicMutateAsync = vi.fn();

const baseInvoice = {
  id: "inv-2",
  client_id: "client-1",
  supplier: "Test Leverancier BV",
  invoice_number: "F-2026-002",
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
  file_path: null as string | null,
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

const baseLine = {
  id: "line-1",
  purchase_invoice_id: "inv-2",
  user_id: "user-1",
  organization_id: "org-1",
  omschrijving: "Consultancy",
  amount_excl: 100,
  btw_percentage: 21,
  grootboekrekening_id: "gb-1",
  sort_order: 0,
  created_at: "2026-07-20T08:00:00Z",
};

const state = {
  invoiceId: "inv-2" as string | undefined,
  invoice: { ...baseInvoice } as typeof baseInvoice | null,
  storedLines: [{ ...baseLine }] as Array<typeof baseLine>,
  clients: [{ id: "client-1", name: "Klant Een", btw_vrijgesteld: false }],
  // Three invoices for the same client; sorted desc by date the current one
  // (inv-2, 07-20) sits in the middle → both prev (inv-1) and next (inv-3).
  allInvoices: [
    { id: "inv-1", invoice_date: "2026-07-25" },
    { id: "inv-2", invoice_date: "2026-07-20" },
    { id: "inv-3", invoice_date: "2026-07-10" },
  ],
  signedUrl: "https://files.example/invoice.pdf" as string | null,
};

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ invoiceId: state.invoiceId }),
    useNavigate: () => navigateSpy,
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "purchase_invoices") throw new Error(`Unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.invoice, error: null }),
          }),
        }),
      };
    },
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: state.signedUrl ? { signedUrl: state.signedUrl } : null,
          error: null,
        }),
      }),
    },
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
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({ data: state.allInvoices }),
}));
vi.mock("@/hooks/usePurchaseInvoiceLines", () => ({
  usePurchaseInvoiceLines: () => ({ data: state.storedLines, isLoading: false }),
  useSavePurchaseInvoiceWithLines: () => ({ mutateAsync: atomicMutateAsync }),
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: ({ value, onValueChange, onIdChange }: any) => (
    <input
      aria-label="Grootboek"
      value={value ?? ""}
      onChange={(e) => { onValueChange?.(e.target.value); onIdChange?.("gb-1"); }}
    />
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

/** Render and wait until the form is initialised (header supplier input present). */
async function renderReady() {
  const utils = renderWorkspace();
  const supplierInput = await screen.findByLabelText("Leveranciersnaam");
  expect(supplierInput).toHaveValue(state.invoice?.supplier ?? "");
  return utils;
}

const saveBtn = () => screen.getByRole("button", { name: /^opslaan$/i });
const approveBtn = () => screen.getByRole("button", { name: /goedkeuren/i });
const descInputs = () => screen.getAllByPlaceholderText("Omschrijving");
const actionBar = () => within(screen.getByTestId("action-bar"));

beforeEach(() => {
  toastSpy.mockReset();
  navigateSpy.mockReset();
  atomicMutateAsync.mockReset();
  atomicMutateAsync.mockResolvedValue(baseInvoice);
  state.invoiceId = "inv-2";
  state.invoice = { ...baseInvoice };
  state.storedLines = [{ ...baseLine }];
  state.clients = [{ id: "client-1", name: "Klant Een", btw_vrijgesteld: false }];
  state.allInvoices = [
    { id: "inv-1", invoice_date: "2026-07-25" },
    { id: "inv-2", invoice_date: "2026-07-20" },
    { id: "inv-3", invoice_date: "2026-07-10" },
  ];
  state.signedUrl = "https://files.example/invoice.pdf";
});

// ── 1–8: shell, header, navigation, document ────────────────────────────────
describe("PurchaseInvoiceWorkspace — header & navigation", () => {
  it("1. laadt de workspace en toont de kernonderdelen", async () => {
    await renderReady();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Inkoopfactuur verwerken");
    expect(screen.getByRole("heading", { level: 2, name: "Factuurgegevens" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Boekingsregels" })).toBeInTheDocument();
    expect(screen.getByTestId("document-panel")).toBeInTheDocument();
    expect(screen.getByTestId("action-bar")).toBeInTheDocument();
  });

  it("2. Terug naar Inkoop navigeert naar /facturen", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: /inkoopoverzicht/i }));
    expect(navigateSpy).toHaveBeenCalledWith("/facturen");
  });

  it("3. leverancier, factuurnummer en datum zijn zichtbaar in de header", async () => {
    await renderReady();
    const header = screen.getByRole("banner");
    expect(within(header).getByText("Test Leverancier BV")).toBeInTheDocument();
    expect(within(header).getByText("F-2026-002")).toBeInTheDocument();
    expect(within(header).getByText(new Date("2026-07-20").toLocaleDateString("nl-NL"))).toBeInTheDocument();
    // Metadata row: administratie + totaal incl.
    expect(within(header).getByText("Klant Een")).toBeInTheDocument();
    expect(within(header).getByText(/121,00/)).toBeInTheDocument();
  });

  it("4. workflow-statusbadge is zichtbaar met bestaande semantiek", async () => {
    await renderReady();
    expect(within(screen.getByRole("banner")).getByText("Te controleren")).toBeInTheDocument();
  });

  it("4b. gecontroleerde factuur toont Gecontroleerd", async () => {
    state.invoice = { ...baseInvoice, status: "gecontroleerd" };
    await renderReady();
    expect(within(screen.getByRole("banner")).getByText("Gecontroleerd")).toBeInTheDocument();
  });

  it("5. BTW-vrijgesteld badge alleen wanneer de administratie vrijgesteld is", async () => {
    await renderReady();
    expect(screen.queryByText("BTW-vrijgesteld")).not.toBeInTheDocument();
  });

  it("5b. BTW-vrijgesteld badge zichtbaar bij vrijgestelde administratie", async () => {
    state.clients = [{ id: "client-1", name: "Klant Een", btw_vrijgesteld: true }];
    await renderReady();
    expect(within(screen.getByRole("banner")).getByText("BTW-vrijgesteld")).toBeInTheDocument();
  });

  it("6. vorige/volgende navigatie werkt binnen dezelfde klant (positie 2 / 3)", async () => {
    await renderReady();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    const prev = screen.getByRole("button", { name: "Vorige factuur" });
    const next = screen.getByRole("button", { name: "Volgende factuur" });
    expect(prev).toBeEnabled();
    expect(next).toBeEnabled();
    fireEvent.click(next);
    expect(navigateSpy).toHaveBeenCalledWith("/facturen/inkoop/inv-3");
    fireEvent.click(prev);
    expect(navigateSpy).toHaveBeenCalledWith("/facturen/inkoop/inv-1");
  });

  it("6b. vorige is uitgeschakeld op de eerste factuur", async () => {
    state.invoiceId = "inv-1";
    state.invoice = { ...baseInvoice, id: "inv-1", invoice_date: "2026-07-25" };
    await renderReady();
    expect(screen.getByRole("button", { name: "Vorige factuur" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Volgende factuur" })).toBeEnabled();
  });

  it("7. documentpreview toont lege staat zonder bestand", async () => {
    await renderReady();
    expect(within(screen.getByTestId("document-panel")).getByText("Geen bestand beschikbaar")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open in nieuw tabblad" })).not.toBeInTheDocument();
  });

  it("8. externe-document knop verschijnt zodra de signed URL geladen is", async () => {
    state.invoice = { ...baseInvoice, file_path: "org-1/invoice.pdf" };
    await renderReady();
    const open = await screen.findByRole("button", { name: "Open in nieuw tabblad" });
    expect(open).toBeInTheDocument();
    expect(screen.getByTitle("Factuur PDF")).toHaveAttribute("src", "https://files.example/invoice.pdf");
  });
});

// ── 9–15: fields & lines ────────────────────────────────────────────────────
describe("PurchaseInvoiceWorkspace — factuurgegevens & boekingsregels", () => {
  it("9. alle factuurvelden zijn behouden met hun waarden", async () => {
    await renderReady();
    expect(screen.getByDisplayValue("Test Leverancier BV")).toBeInTheDocument();
    expect(screen.getByDisplayValue("F-2026-002")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2026-07-20")).toBeInTheDocument();
    expect(screen.getByLabelText("Bedrag excl.")).toHaveValue("100,00");
    expect(screen.getByLabelText("BTW-bedrag")).toHaveValue("21,00");
    expect(screen.getByLabelText("Bedrag incl.")).toHaveValue("121,00");
    expect(screen.getByLabelText("Bedrag excl. regel")).toHaveValue("100,00");
    expect(screen.getByDisplayValue("Bestaande notitie")).toBeInTheDocument();
    // Standaard grootboek (header) + the stored line's grootboek both resolve to this label.
    expect(screen.getAllByDisplayValue("4400 - Kantoorkosten")).toHaveLength(2);
    expect(screen.getByLabelText("BTW-percentage")).toBeInTheDocument();
    // Supplier hint: no leverancier_id → "vrije invoer" state is spelled out.
    expect(screen.getByText(/niet gekoppeld aan een leverancier/i)).toBeInTheDocument();
  });

  it("10. boekingsregels zijn zichtbaar", async () => {
    await renderReady();
    expect(screen.getByDisplayValue("Consultancy")).toBeInTheDocument();
    expect(descInputs()).toHaveLength(1);
  });

  it("11. regel toevoegen voegt een lege regel toe", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: /regel toevoegen/i }));
    expect(descInputs()).toHaveLength(2);
  });

  it("12. regel verwijderen verwijdert de regel (zonder bevestiging)", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Regel verwijderen" }));
    expect(screen.queryByDisplayValue("Consultancy")).not.toBeInTheDocument();
    expect(screen.getByText("Nog geen boekingsregels.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /eerste boekingsregel toevoegen/i })).toBeInTheDocument();
  });

  it("13. incomplete regel blijft gedetecteerd via bestaande partial-line logica", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: /regel toevoegen/i }));
    fireEvent.change(descInputs()[1], { target: { value: "Alleen omschrijving" } });
    // Gericht op de waarschuwing bij de regels: sinds het boekbaarheidspaneel
    // erbij staat is `getByRole("alert")` niet meer eenduidig.
    expect(screen.getByTestId("partial-line-warning")).toHaveTextContent(/niet compleet/i);
  });

  it("14. partial row krijgt de visuele waarschuwingsstaat", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: /regel toevoegen/i }));
    const input = descInputs()[1];
    fireEvent.change(input, { target: { value: "Alleen omschrijving" } });
    const row = input.closest("tr")!;
    expect(row).toHaveAttribute("data-partial", "true");
    expect(within(row).getByLabelText("Regel niet compleet")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    // The complete row has no such state.
    expect(descInputs()[0].closest("tr")).not.toHaveAttribute("data-partial");
  });

  it("15. BTW-vrijgestelde regel houdt 0% en BTW-velden zijn uitgeschakeld", async () => {
    state.clients = [{ id: "client-1", name: "Klant Een", btw_vrijgesteld: true }];
    state.storedLines = [];
    state.invoice = { ...baseInvoice, amount_excl: 250, btw_amount: null as any, amount_incl: 250, btw_percentage: 21 };
    await renderReady();
    // Header coherence: pct locked, BTW-bedrag 0 and disabled, incl = excl.
    expect(screen.getByLabelText("BTW-percentage")).toBeDisabled();
    expect(screen.getByLabelText("BTW-bedrag")).toBeDisabled();
    expect(screen.getByLabelText("BTW-bedrag")).toHaveValue("0,00");
    // Prefilled line: 250 @ 0% → BTW € 0,00, incl € 250,00; line select locked.
    expect(screen.getByLabelText("BTW-percentage regel")).toBeDisabled();
    const row = descInputs()[0].closest("tr")!;
    expect(within(row).getByText(/^€\s?0,00$/)).toBeInTheDocument();
    expect(within(row).getByText(/250,00/)).toBeInTheDocument();
    // Adding a line under BTW-vrijgesteld also starts at 0%.
    fireEvent.click(screen.getByRole("button", { name: /regel toevoegen/i }));
    const selects = screen.getAllByLabelText("BTW-percentage regel");
    expect(selects).toHaveLength(2);
    selects.forEach((s) => expect(s).toBeDisabled());
    expect(screen.getByText("BTW-vrijgesteld")).toBeInTheDocument();
  });
});

// ── 16–19: totalencontrole ──────────────────────────────────────────────────
describe("PurchaseInvoiceWorkspace — totalencontrole", () => {
  it("16. groen wanneer de regels exact aansluiten", async () => {
    await renderReady();
    const summary = screen.getByTestId("totals-summary");
    expect(summary).toHaveAttribute("data-totals-state", "green");
    expect(within(summary).getByRole("status")).toHaveTextContent("De boekingsregels sluiten aan op de factuur.");
    expect(screen.getByText("Sluit aan")).toBeInTheDocument();
  });

  it("17. amber bij een verschil", async () => {
    state.storedLines = [{ ...baseLine, amount_excl: 90 }];
    await renderReady();
    const summary = screen.getByTestId("totals-summary");
    expect(summary).toHaveAttribute("data-totals-state", "amber");
    expect(within(summary).getByRole("status")).toHaveTextContent(/verschil van/);
    expect(screen.getByText("Nog niet sluitend")).toBeInTheDocument();
  });

  it("18. rood wanneer de factuurtotalen ontbreken", async () => {
    state.invoice = { ...baseInvoice, amount_excl: null as any, btw_amount: null as any, amount_incl: null as any };
    await renderReady();
    const summary = screen.getByTestId("totals-summary");
    expect(summary).toHaveAttribute("data-totals-state", "red");
    expect(within(summary).getByRole("status")).toHaveTextContent("Factuurtotalen ontbreken.");
    expect(screen.getByText("Totalen ontbreken")).toBeInTheDocument();
  });

  it("19. verschilbedrag blijft correct (regels 90 vs factuur 100 → -10,00 excl., -12,10 incl.)", async () => {
    state.storedLines = [{ ...baseLine, amount_excl: 90 }];
    await renderReady();
    const summary = screen.getByTestId("totals-summary");
    const verschil = within(summary).getByRole("row", { name: /verschil/i });
    const cells = within(verschil).getAllByRole("cell").map((c) => c.textContent);
    expect(cells[0]).toMatch(/-10,00/);   // excl: 90 - 100
    expect(cells[1]).toMatch(/-2,10/);    // btw: 18.90 - 21
    expect(cells[2]).toMatch(/-12,10/);   // incl: 108.90 - 121
    expect(within(summary).getByRole("status")).toHaveTextContent(/12,10/);
  });
});

// ── 20–26: save/approve gates & explanation ─────────────────────────────────
describe("PurchaseInvoiceWorkspace — opslaan / goedkeuren gates", () => {
  it("20. Opslaan is enabled bij complete regels en disabled bij een partial regel", async () => {
    await renderReady();
    expect(saveBtn()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /regel toevoegen/i }));
    fireEvent.change(descInputs()[1], { target: { value: "half" } });
    expect(saveBtn()).toBeDisabled();
  });

  it("21. Goedkeuren disabled bij incomplete header, met uitleg", async () => {
    state.invoice = { ...baseInvoice, invoice_number: "" };
    await renderReady();
    expect(approveBtn()).toBeDisabled();
    expect(actionBar().getByText(/factuurgegevens zijn nog niet compleet/i)).toBeInTheDocument();
  });

  it("22. Goedkeuren disabled bij een partial regel, met uitleg", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: /regel toevoegen/i }));
    fireEvent.change(descInputs()[1], { target: { value: "half" } });
    expect(approveBtn()).toBeDisabled();
    expect(actionBar().getByText(/boekingsregel is niet compleet/i)).toBeInTheDocument();
  });

  it("23. Goedkeuren disabled bij mismatch, met uitleg", async () => {
    state.storedLines = [{ ...baseLine, amount_excl: 90 }];
    await renderReady();
    expect(approveBtn()).toBeDisabled();
    expect(actionBar().getByText(/sluiten niet aan op de factuur/i)).toBeInTheDocument();
  });

  it("24. Goedkeuren disabled zonder betekenisvolle regels, met uitleg", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Regel verwijderen" }));
    expect(approveBtn()).toBeDisabled();
    // Scoped to the action bar: the lines card shows its own empty state.
    expect(actionBar().getByText(/er is nog geen boekingsregel/i)).toBeInTheDocument();
  });

  it("25. Goedkeuren enabled wanneer canApprove waar is; geen uitleg getoond", async () => {
    await renderReady();
    expect(approveBtn()).toBeEnabled();
    expect(screen.queryByText(/goedkeuren nog niet mogelijk/i)).not.toBeInTheDocument();
  });

  it("26. uitleg correspondeert met de bestaande state en is aan de knop gekoppeld", async () => {
    state.invoice = { ...baseInvoice, invoice_number: "" };
    state.storedLines = [{ ...baseLine, amount_excl: 90 }];
    await renderReady();
    const note = actionBar().getByText(/goedkeuren nog niet mogelijk/i).closest("p")!;
    expect(note).toHaveAttribute("id", "approve-blockers");
    expect(note).toHaveTextContent(/factuurgegevens zijn nog niet compleet/i);
    expect(note).toHaveTextContent(/sluiten niet aan op de factuur/i);
    // No partial line and lines exist → those two reasons must be absent.
    expect(note).not.toHaveTextContent(/boekingsregel is niet compleet/i);
    expect(note).not.toHaveTextContent(/er is nog geen boekingsregel/i);
    expect(approveBtn()).toHaveAttribute("aria-describedby", "approve-blockers");
  });
});

// ── 27–30: save & approve flows ─────────────────────────────────────────────
describe("PurchaseInvoiceWorkspace — save/approve flows", () => {
  it("27. Opslaan roept de bestaande atomic save-flow aan zonder status", async () => {
    await renderReady();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    const call = atomicMutateAsync.mock.calls[0][0];
    expect(call.invoiceId).toBe("inv-2");
    expect(call.headerUpdates).not.toHaveProperty("status");
    expect(call.headerUpdates).not.toHaveProperty("ledger_account_id");
    expect(call.headerUpdates.ledger_account_text).toBe("4400 - Kantoorkosten");
    expect(call.lines).toEqual([
      { omschrijving: "Consultancy", amount_excl: 100, btw_percentage: 21, grootboekrekening_id: "gb-1" },
    ]);
    expect(toastSpy).toHaveBeenCalledWith({ title: "Factuur opgeslagen" });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("28. Goedkeuren gebruikt dezelfde flow met status gecontroleerd", async () => {
    await renderReady();
    fireEvent.click(approveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    expect(atomicMutateAsync.mock.calls[0][0].headerUpdates.status).toBe("gecontroleerd");
    expect(toastSpy).toHaveBeenCalledWith({ title: "Factuur goedgekeurd" });
  });

  it("29. succesvolle approve gaat door naar de volgende factuur", async () => {
    await renderReady();
    fireEvent.click(approveBtn());
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/facturen/inkoop/inv-3"));
  });

  it("29b. approve zonder volgende factuur blijft op de huidige pagina", async () => {
    state.invoiceId = "inv-3";
    state.invoice = { ...baseInvoice, id: "inv-3", invoice_date: "2026-07-10" };
    await renderReady();
    fireEvent.click(approveBtn());
    await waitFor(() => expect(atomicMutateAsync).toHaveBeenCalledTimes(1));
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("30. save error toont de bestaande rollback-veilige foutmelding", async () => {
    atomicMutateAsync.mockRejectedValue(new Error("constraint failure"));
    await renderReady();
    fireEvent.click(saveBtn());
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Opslaan mislukt",
        description: "Opslaan mislukt. De bestaande factuur en boekingsregels zijn niet gewijzigd. (constraint failure)",
        variant: "destructive",
      });
    });
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

// ── 31–32: layout ───────────────────────────────────────────────────────────
describe("PurchaseInvoiceWorkspace — layout", () => {
  it("31. twee-pane layout is responsive: één kolom, twee kolommen vanaf lg, sticky documentpaneel", async () => {
    await renderReady();
    const grid = screen.getByTestId("workspace-grid");
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toMatch(/lg:grid-cols-\[minmax\(0,3fr\)_minmax\(0,2fr\)\]/);
    const doc = screen.getByTestId("document-panel");
    expect(doc.className).toContain("lg:sticky");
    expect(doc.className).toContain("h-[70vh]");
  });

  it("32. sticky action bar bevat alle acties en overlapt de sidebar niet (sticky, niet fixed)", async () => {
    await renderReady();
    const bar = screen.getByTestId("action-bar");
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("bottom-0");
    expect(bar.className).not.toContain("fixed");
    expect(within(bar).getByRole("button", { name: /annuleren/i })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /^opslaan$/i })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /goedkeuren/i })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /volgende/i })).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole("button", { name: /annuleren/i }));
    expect(navigateSpy).toHaveBeenCalledWith("/facturen");
  });

  it("32b. Volgende in de action bar verdwijnt op de laatste factuur", async () => {
    state.invoiceId = "inv-3";
    state.invoice = { ...baseInvoice, id: "inv-3", invoice_date: "2026-07-10" };
    await renderReady();
    expect(within(screen.getByTestId("action-bar")).queryByRole("button", { name: /volgende/i })).not.toBeInTheDocument();
  });
});

// ── Loading / not found ─────────────────────────────────────────────────────
describe("PurchaseInvoiceWorkspace — loading & not found", () => {
  it("toont een laadstatus voordat de factuur geïnitialiseerd is", () => {
    renderWorkspace();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  });

  it("toont 'Factuur niet gevonden' met terugknop wanneer de query klaar is en null oplevert (regressie)", async () => {
    state.invoice = null;
    renderWorkspace();
    // Loader first …
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    // … then, once the query settles with no record, the not-found state.
    const notFound = await screen.findByText("Factuur niet gevonden.");
    expect(notFound).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Factuurgegevens" })).not.toBeInTheDocument();
    const back = screen.getByRole("button", { name: /terug naar inkoopoverzicht/i });
    fireEvent.click(back);
    expect(navigateSpy).toHaveBeenCalledWith("/facturen");
  });

  it("normale factuur: loader verdwijnt en het formulier initialiseert zoals voorheen", async () => {
    renderWorkspace();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    const supplierInput = await screen.findByLabelText("Leveranciersnaam");
    expect(supplierInput).toHaveValue("Test Leverancier BV");
    expect(screen.queryByRole("status", { busy: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Factuur niet gevonden.")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Consultancy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /goedkeuren/i })).toBeEnabled();
  });
});
