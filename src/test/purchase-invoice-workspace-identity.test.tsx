import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * PR A — factuuridentiteit in de inkoopwerkbank.
 *
 * DE BUG DIE HIER WORDT VASTGELEGD: de route `/facturen/inkoop/:invoiceId`
 * wisselt bij "Volgende" alleen de parameter. React Router houdt hetzelfde
 * element gemonteerd, dus de query (en daarmee de documentviewer) toonde
 * factuur N+1 terwijl de kop- en regelstate nog factuur N bevatte — en een
 * druk op Opslaan schreef die oude gegevens weg onder de NIEUWE factuur-id.
 *
 * Daarom gebruikt dit bestand de ECHTE router: MemoryRouter + Routes met
 * dezelfde routedefinitie als App.tsx. `useParams`/`useNavigate` worden
 * bewust NIET gemockt — een spy op navigate zou precies het gedrag wegnemen
 * dat hier bewezen moet worden. Alleen de datalaag is gemockt.
 */

if (!(globalThis as any).ResizeObserver) {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const toastSpy = vi.fn();
const saveSpy = vi.fn();

const invoiceBase = {
  client_id: "client-1",
  amount_excl: 100,
  btw_amount: 21,
  amount_incl: 121,
  btw_percentage: 21,
  status: "te_controleren",
  ledger_account_id: null,
  ledger_account_text: "4400 - Kantoorkosten",
  leverancier_id: null,
  notes: null,
  remaining_amount: 121,
  document_route: "manual",
  route_reason: null,
  original_ubl_path: null,
  supplier_btw_number: null,
  ocr_data: null,
  organization_id: "org-1",
  user_id: "user-1",
  snelstart_package_download_count: 0,
  snelstart_package_downloaded_at: null,
  created_at: "2026-07-20T08:00:00Z",
  updated_at: "2026-07-20T08:00:00Z",
};

/** Drie facturen; gesorteerd op datum aflopend is inv-2 de middelste. */
const INVOICES: Record<string, any> = {
  "inv-1": {
    ...invoiceBase, id: "inv-1", supplier: "Alfa Leverancier BV", invoice_number: "F-001",
    invoice_date: "2026-07-25", file_path: "client-1/alfa.pdf",
  },
  "inv-2": {
    ...invoiceBase, id: "inv-2", supplier: "Beta Leverancier BV", invoice_number: "F-002",
    invoice_date: "2026-07-20", file_path: "client-1/beta.pdf",
  },
  "inv-3": {
    ...invoiceBase, id: "inv-3", supplier: "Gamma Leverancier BV", invoice_number: "F-003",
    invoice_date: "2026-07-10", file_path: "client-1/gamma.pdf",
  },
};

const LINES: Record<string, any[]> = {
  "inv-1": [{ id: "l-1", purchase_invoice_id: "inv-1", omschrijving: "Alfa-regel", amount_excl: 100, btw_percentage: 21, grootboekrekening_id: "gb-1", sort_order: 0 }],
  "inv-2": [{ id: "l-2", purchase_invoice_id: "inv-2", omschrijving: "Beta-regel", amount_excl: 100, btw_percentage: 21, grootboekrekening_id: "gb-1", sort_order: 0 }],
  "inv-3": [{ id: "l-3", purchase_invoice_id: "inv-3", omschrijving: "Gamma-regel", amount_excl: 100, btw_percentage: 21, grootboekrekening_id: "gb-1", sort_order: 0 }],
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "purchase_invoices") throw new Error(`Unexpected table ${table}`);
      let gevraagdeId: string | null = null;
      const chain: any = {
        select: () => chain,
        eq: (_col: string, value: string) => { gevraagdeId = value; return chain; },
        maybeSingle: async () => ({ data: gevraagdeId ? INVOICES[gevraagdeId] ?? null : null, error: null }),
      };
      return chain;
    },
    storage: {
      from: () => ({
        // De ondertekende URL draagt het pad, zodat de test kan zien wélk
        // document de viewer werkelijk toont.
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://files.example/${path}` }, error: null }),
      }),
    },
  },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "client-1", name: "Klant Een", btw_vrijgesteld: false }] }),
}));
vi.mock("@/hooks/useLeveranciers", () => ({ useLeveranciers: () => ({ data: [] }) }));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useActiveGrootboekrekeningen: () => ({ data: [{ id: "gb-1", nummer: 4400, omschrijving: "Kantoorkosten" }] }),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({
    data: [
      { id: "inv-1", invoice_date: "2026-07-25" },
      { id: "inv-2", invoice_date: "2026-07-20" },
      { id: "inv-3", invoice_date: "2026-07-10" },
    ],
  }),
}));
vi.mock("@/hooks/usePurchaseInvoiceLines", () => ({
  usePurchaseInvoiceLines: (invoiceId: string | null) => ({
    data: invoiceId ? LINES[invoiceId] ?? [] : [],
    isLoading: false,
  }),
  useSavePurchaseInvoiceWithLines: () => ({ mutateAsync: saveSpy }),
}));
vi.mock("@/hooks/usePurchaseInvoicePosting", () => ({
  usePurchaseInvoicePosting: () => ({ data: null }),
  usePostPurchaseInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

import PurchaseInvoiceWorkspaceRoute from "@/pages/PurchaseInvoiceWorkspace";

/** Dezelfde routedefinitie als in App.tsx — één gemonteerde routeboom. */
function renderRoute(startId = "inv-2") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/facturen/inkoop/${startId}`]}>
        <Routes>
          <Route path="/facturen/inkoop/:invoiceId" element={<PurchaseInvoiceWorkspaceRoute />} />
          <Route path="/facturen" element={<p>Inkoopoverzicht</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const supplierInput = () => screen.getByLabelText("Leveranciersnaam") as HTMLInputElement;
const nummerInput = () => screen.getByLabelText(/factuurnummer/i) as HTMLInputElement;
const nextBtn = () => screen.getByRole("button", { name: "Volgende factuur" });
const prevBtn = () => screen.getByRole("button", { name: "Vorige factuur" });
const saveBtn = () => screen.getByRole("button", { name: /^opslaan$/i });
const docFrame = () => document.querySelector("iframe[title='Factuur PDF']") as HTMLIFrameElement | null;

/** Wacht tot de werkbank voor deze factuur is geïnitialiseerd. */
async function wachtOpFactuur(supplier: string) {
  await waitFor(() => expect(supplierInput()).toHaveValue(supplier));
}

beforeEach(() => {
  toastSpy.mockReset();
  saveSpy.mockReset();
  saveSpy.mockResolvedValue(INVOICES["inv-2"]);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("de werkbank volgt de factuur uit de route", () => {
  it("1. bij 'Volgende' wisselen kop, regels én document mee", async () => {
    renderRoute("inv-2");
    await wachtOpFactuur("Beta Leverancier BV");
    expect(nummerInput()).toHaveValue("F-002");
    expect(screen.getByDisplayValue("Beta-regel")).toBeInTheDocument();
    await waitFor(() => expect(docFrame()?.src).toContain("beta.pdf"));

    // Alleen de route wisselt; dezelfde routeboom blijft gemonteerd.
    fireEvent.click(nextBtn());

    await wachtOpFactuur("Gamma Leverancier BV");
    expect(nummerInput()).toHaveValue("F-003");
    // De regels van de vorige factuur mogen niet blijven staan.
    expect(screen.getByDisplayValue("Gamma-regel")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Beta-regel")).toBeNull();
    await waitFor(() => expect(docFrame()?.src).toContain("gamma.pdf"));
    // Formulier en viewer wijzen dus naar dezelfde factuur.
    expect(docFrame()?.src).not.toContain("beta.pdf");
  });

  it("2. bij 'Vorige' gebeurt hetzelfde de andere kant op", async () => {
    renderRoute("inv-2");
    await wachtOpFactuur("Beta Leverancier BV");

    fireEvent.click(prevBtn());

    await wachtOpFactuur("Alfa Leverancier BV");
    expect(nummerInput()).toHaveValue("F-001");
    expect(screen.getByDisplayValue("Alfa-regel")).toBeInTheDocument();
    await waitFor(() => expect(docFrame()?.src).toContain("alfa.pdf"));
  });

  it("3. handmatige wijzigingen van factuur N lekken niet naar N+1", async () => {
    renderRoute("inv-2");
    await wachtOpFactuur("Beta Leverancier BV");

    // De gebruiker typt iets en navigeert dan zonder op te slaan.
    fireEvent.change(supplierInput(), { target: { value: "GETYPTE ROMMEL" } });
    expect(supplierInput()).toHaveValue("GETYPTE ROMMEL");

    fireEvent.click(nextBtn());

    // De nieuwe factuur begint met haar eigen gegevens, niet met de typefout.
    await wachtOpFactuur("Gamma Leverancier BV");
    expect(screen.queryByDisplayValue("GETYPTE ROMMEL")).toBeNull();
  });

  it("4. de vorige/volgende-grenzen blijven kloppen na navigatie", async () => {
    renderRoute("inv-2");
    await wachtOpFactuur("Beta Leverancier BV");
    expect(prevBtn()).toBeEnabled();
    expect(nextBtn()).toBeEnabled();

    fireEvent.click(nextBtn());
    await wachtOpFactuur("Gamma Leverancier BV");
    // inv-3 is de laatste (oudste) factuur.
    expect(nextBtn()).toBeDisabled();
    expect(prevBtn()).toBeEnabled();

    fireEvent.click(prevBtn());
    await wachtOpFactuur("Beta Leverancier BV");
    expect(nextBtn()).toBeEnabled();

    fireEvent.click(prevBtn());
    await wachtOpFactuur("Alfa Leverancier BV");
    // inv-1 is de eerste (nieuwste) factuur.
    expect(prevBtn()).toBeDisabled();
  });
});

describe("opslaan kan nooit de verkeerde factuur raken", () => {
  it("5. een opslag ná navigatie draagt de gegevens van de NIEUWE factuur", async () => {
    renderRoute("inv-2");
    await wachtOpFactuur("Beta Leverancier BV");

    fireEvent.click(nextBtn());
    await wachtOpFactuur("Gamma Leverancier BV");

    fireEvent.click(saveBtn());
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));

    const payload = saveSpy.mock.calls[0][0];
    expect(payload.invoiceId).toBe("inv-3");
    // Dit is de kern: de kop mag NOOIT die van inv-2 zijn onder id inv-3.
    expect(payload.headerUpdates.supplier).toBe("Gamma Leverancier BV");
    expect(payload.headerUpdates.invoice_number).toBe("F-003");
    expect(payload.headerUpdates.supplier).not.toBe("Beta Leverancier BV");
    expect(payload.lines.map((l: any) => l.omschrijving)).toEqual(["Gamma-regel"]);
  });

  it("6. getypte wijzigingen van de vorige factuur worden nooit meegestuurd", async () => {
    renderRoute("inv-2");
    await wachtOpFactuur("Beta Leverancier BV");
    fireEvent.change(supplierInput(), { target: { value: "GETYPTE ROMMEL" } });

    fireEvent.click(nextBtn());
    await wachtOpFactuur("Gamma Leverancier BV");

    fireEvent.click(saveBtn());
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    const payload = saveSpy.mock.calls[0][0];
    expect(payload.invoiceId).toBe("inv-3");
    expect(payload.headerUpdates.supplier).toBe("Gamma Leverancier BV");
  });

  it("7. zolang de nieuwe factuur nog niet geladen is, valt er niets op te slaan", async () => {
    // Tussen twee facturen in staat er geen bewerkbaar formulier: het skelet
    // heeft geen opslagknop, dus er is geen moment waarop oude state onder een
    // nieuwe id kan worden weggeschreven.
    renderRoute("inv-2");
    await wachtOpFactuur("Beta Leverancier BV");
    fireEvent.click(nextBtn());
    // Direct na de klik is de nieuwe factuur nog niet geïnitialiseerd.
    expect(screen.queryByRole("button", { name: /^opslaan$/i })).toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();

    await wachtOpFactuur("Gamma Leverancier BV");
    expect(saveBtn()).toBeInTheDocument();
  });
});

describe("de fail-closed identiteitscontrole in handleSave", () => {
  it("8. de werkbank leest de factuur-id niet zelf uit de route", () => {
    // De routewrapper is de enige useParams-lezer; de werkbank krijgt de id als
    // prop. Zo kunnen de `key` en de identiteit waarmee wordt opgeslagen per
    // constructie niet uit elkaar lopen.
    const code = readFileSync("src/pages/PurchaseInvoiceWorkspace.tsx", "utf8");
    const werkbank = code.slice(code.indexOf("export function PurchaseInvoiceWorkspace"));
    expect(werkbank).not.toMatch(/useParams\(/);
    expect(code).toMatch(/key=\{invoiceId \?\? "geen-factuur"\}/);
  });

  it("9. opslaan weigert wanneer de geladen factuur niet bij de route-id hoort", () => {
    // De remount hoort dit onmogelijk te maken; de controle staat er omdat
    // opslaan het punt is waarop een vergissing onherstelbaar wordt —
    // save_purchase_invoice_with_lines VERVANGT de regels van die factuur.
    const code = readFileSync("src/pages/PurchaseInvoiceWorkspace.tsx", "utf8");
    // `if (hasPartialLine)` komt óók in approveBlockers voor, dus dat is geen
    // bruikbaar eindpunt; `setSaving(true)` staat alleen in handleSave.
    const save = code.slice(code.indexOf("const handleSave"), code.indexOf("setSaving(true)"));
    expect(save.length).toBeGreaterThan(0);
    expect(save).toMatch(/invoice\.id !== invoiceId/);
    expect(save).toMatch(/initializedFor !== invoiceId/);
    expect(save).toMatch(/return;/);
    // En de initialisatie hangt aan de id, niet aan een kale boolean.
    expect(code).not.toMatch(/const \[initialized, setInitialized\] = useState/);
    expect(code).toMatch(/const \[initializedFor, setInitializedFor\] = useState<string \| null>/);
  });
});
