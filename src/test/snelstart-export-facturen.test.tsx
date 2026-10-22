import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

/**
 * Herstelpakket P6 — SnelStart-inkoopexport vanuit de pagina Inkoop.
 *
 * Alleen de databron (supabase-client) is vervangen door een in-memory
 * nabootsing met twee administraties. De exportfuncties van
 * `usePurchaseInvoices.ts` en `snelstart-export.ts` zijn ECHT: wat hier wordt
 * vastgesteld, is wat een gebruiker na een klik als bestand en als markering
 * krijgt.
 *
 * - A2-05 / D-04 / B2-12 / C-11: één administratie per export.
 * - A2-04: per factuurregel, met rekeningnummer en btw-code per regel.
 * - Punt 3: markeren pas na de download, precies de geëxporteerde id's, en een
 *   markering die stil niets raakt is een fout. Het markeren raakt nooit de
 *   betaalstatus of het restant (D1).
 */

const h = vi.hoisted(() => ({
  selectedClientId: "all",
  activeOrganizationId: "org-1" as string | null,
  toasts: [] as any[],
}));

vi.mock("@/integrations/supabase/client", async () => {
  const { fakeSupabase } = await import("./support/snelstart-export-fakes");
  return { supabase: fakeSupabase };
});
vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => vi.fn() };
});
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: h.selectedClientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: h.activeOrganizationId, isReady: true }),
}));
vi.mock("@/hooks/useClients", async () => {
  const f = await import("./support/snelstart-export-fakes");
  return { useClients: () => ({ data: [f.CLIENT_EEN, f.CLIENT_TWEE] }) };
});
vi.mock("@/hooks/usePurchaseInvoices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/usePurchaseInvoices")>();
  return {
    ...actual,
    usePaginatedPurchaseInvoices: () => ({
      data: { invoices: [], total: 0 },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    }),
    usePurchaseInvoiceDuplicates: () => ({ data: null }),
    useResetPageOnChange: vi.fn(),
    useUpdatePurchaseInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeletePurchaseInvoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});
vi.mock("@/hooks/useVraagposten", () => ({ useVraagposten: () => ({ data: [] }) }));
vi.mock("@/hooks/useBankTransactionAllocations", () => ({
  useBankTransactionAllocations: () => ({ data: [] }),
  useUpsertBankTransactionAllocation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useBankTransactions", () => ({
  useBankTransactions: () => ({ data: [] }),
  useUpdateBankTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { access_token: "tok" }, user: { id: "user-1" } }),
}));
vi.mock("@tanstack/react-query", async (orig) => {
  const actual = await orig<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) };
});
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (t: any) => { h.toasts.push(t); } }),
}));
vi.mock("@/components/PurchaseInvoiceCreateDialog", () => ({ PurchaseInvoiceCreateDialog: () => null }));
vi.mock("@/components/InvoiceNumberCopyButton", () => ({ InvoiceNumberCopyButton: () => null }));

import Facturen from "@/pages/Facturen";
import {
  A204_CSV,
  accountRow,
  csvLines,
  downloads,
  fakeDb,
  installDownloadCapture,
  lineRow,
  purchaseRow,
  seedA204,
  selectsOn,
  updatesOn,
} from "./support/snelstart-export-fakes";

function renderFacturen() {
  render((<MemoryRouter initialEntries={["/facturen"]}><Facturen /></MemoryRouter>) as ReactNode as any);
}

const exportButton = () => screen.getByRole("button", { name: /Export Snelstart/ });
const settle = () => new Promise((r) => setTimeout(r, 30));
const invoice = (id: string) => fakeDb.tables.purchase_invoices.find((r) => r.id === id)!;
const statusOf = (id: string) => invoice(id)?.status;
const toastTitled = (re: RegExp) => h.toasts.find((t) => re.test(String(t.title)));

beforeEach(() => {
  fakeDb.reset();
  h.toasts.length = 0;
  h.selectedClientId = "all";
  h.activeOrganizationId = "org-1";
  installDownloadCapture();
  fakeDb.tables.grootboekrekeningen = [accountRow("gb-4400", 4400), accountRow("gb-4600", 4600)];
  // Administratie Een: de A2-04-factuur (twee regels, twee tarieven) en een
  // goedgekeurde factuur zonder boekingsregels.
  seedA204("c1");
  fakeDb.tables.purchase_invoices.push(
    purchaseRow("p-leeg", "c1", { supplier: "Zonder Regels BV", invoice_number: "Z-1" }),
  );
  // Administratie Twee: een complete, exporteerbare factuur.
  fakeDb.tables.purchase_invoices.push(
    purchaseRow("p-twee", "c2", { supplier: "Andere BV", invoice_number: "X-1" }),
  );
  fakeDb.tables.purchase_invoice_lines.push(lineRow("l-twee", "p-twee"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Inkoop — SnelStart-export alleen per administratie (A2-05, D-04, B2-12, C-11)", () => {
  it("bij 'Alle klanten' staat de knop uit met uitleg; een klik levert geen CSV, geen query en geen markering", async () => {
    h.selectedClientId = "all";
    renderFacturen();
    expect(exportButton()).toBeDisabled();
    expect(screen.getByText(/Kies één administratie/)).toBeInTheDocument();
    expect(exportButton()).toHaveAccessibleDescription(/Kies één administratie/);
    fireEvent.click(exportButton());
    await settle();
    expect(downloads).toHaveLength(0);
    expect(fakeDb.calls.filter((c) => c.table === "purchase_invoices")).toHaveLength(0);
    expect(updatesOn("purchase_invoices")).toHaveLength(0);
    expect(["p-a204", "p-leeg", "p-twee"].map(statusOf)).toEqual(["gecontroleerd", "gecontroleerd", "gecontroleerd"]);
  });

  it("met één administratie bevat het bestand alleen haar facturen, per factuurregel (A2-04)", async () => {
    h.selectedClientId = "c1";
    renderFacturen();
    expect(exportButton()).toBeEnabled();
    expect(screen.queryByText(/Kies één administratie/)).toBeNull();
    fireEvent.click(exportButton());
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].name).toBe("Bakkerij_Een_BV_inkoopfacturen_snelstart.csv");
    const { bom, lines } = await csvLines(downloads[0]);
    expect(bom).toBe(true);
    expect(lines).toEqual(A204_CSV);
    expect(lines.join("\n")).not.toContain("Andere BV");
    // De server kreeg het administratiefilter mee.
    const invoiceSelect = fakeDb.calls.find((c) => c.table === "purchase_invoices" && c.op === "select");
    expect(invoiceSelect?.filters).toContain("client_id=eq.c1");
    expect(invoiceSelect?.filters).toContain("organization_id=eq.org-1");
  });

  it("markeert precies de geëxporteerde factuur; de geweigerde staat met reden in de lijst", async () => {
    h.selectedClientId = "c1";
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(statusOf("p-a204")).toBe("geexporteerd"));
    expect(statusOf("p-leeg")).toBe("gecontroleerd");
    expect(statusOf("p-twee")).toBe("gecontroleerd");
    const [update] = updatesOn("purchase_invoices");
    expect(update.filters).toContain("id=in.(p-a204)");
    const list = await screen.findByRole("list", { name: /Niet geëxporteerde facturen/ });
    const item = within(list).getByText(/Zonder Regels BV - Z-1/).closest("li") as HTMLElement;
    expect(item).toHaveTextContent(/niet geëxporteerd, reden: .*geen boekingsregels/i);
    expect(within(list).queryByText(/Leverancier BV - 000123/)).toBeNull();
    const ok = toastTitled(/geëxporteerd voor Snelstart/);
    expect(ok?.title).toBe("1 facturen geëxporteerd voor Snelstart");
    expect(String(ok?.description)).toMatch(/1 niet geëxporteerd/);
  });

  it("de verdedigingslaag weigert de export als de server rijen van een andere administratie teruggeeft", async () => {
    h.selectedClientId = "c1";
    fakeDb.ignoreClientFilter = true; // de server negeert client_id: rijen van c1 én c2
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(h.toasts.some((t) => t.title === "Export mislukt")).toBe(true));
    const failure = h.toasts.find((t) => t.title === "Export mislukt");
    expect(String(failure.description)).toMatch(/administratie/i);
    expect(downloads).toHaveLength(0);
    expect(updatesOn("purchase_invoices")).toHaveLength(0);
    expect(["p-a204", "p-leeg", "p-twee"].map(statusOf)).toEqual(["gecontroleerd", "gecontroleerd", "gecontroleerd"]);
  });

  it("zonder actieve organisatie start er niets: geen query, geen CSV", async () => {
    h.selectedClientId = "c1";
    h.activeOrganizationId = null;
    renderFacturen();
    fireEvent.click(exportButton());
    await settle();
    expect(toastTitled(/Geen actieve organisatie/)).toBeTruthy();
    expect(fakeDb.calls).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });

  it("Codex #299: een factuur die na het lezen bewerkt is, wordt niet gemarkeerd — ook niet als een later gelezen factuur een nieuwere updated_at heeft", async () => {
    h.selectedClientId = "c1";
    // >1000 facturen, dus twee leesverzoeken. A (p-0000) zit in het eerste,
    // B (p-a204) in het tweede. B is vóór het tweede verzoek bewerkt (09:00);
    // A wordt na het eerste verzoek bewerkt (08:30), dus NA het lezen maar
    // vóór B's tijdstempel. De CSV bevat A's oude kop: A mag niet op
    // 'geëxporteerd'.
    for (let i = 0; i < 1000; i++) {
      const id = `p-${String(i).padStart(4, "0")}`;
      fakeDb.tables.purchase_invoices.push(purchaseRow(id, "c1", { supplier: `Massa ${i} BV`, invoice_number: `M-${i}` }));
      fakeDb.tables.purchase_invoice_lines.push(lineRow(`l-${id}`, id));
    }
    invoice("p-a204").updated_at = "2026-10-20T09:00:00+00:00";
    let pages = 0;
    fakeDb.afterSelect = (table) => {
      if (table !== "purchase_invoices" || ++pages !== 1) return;
      Object.assign(invoice("p-0000"), { amount_excl: 500, btw_amount: 105, amount_incl: 605, updated_at: "2026-10-20T08:30:00+00:00" });
    };
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(toastTitled(/status bijwerken mislukt/)).toBeTruthy());
    expect(selectsOn("purchase_invoices").map((c) => c.returned)).toEqual([1000, 2]);
    const { lines } = await csvLines(downloads[0]);
    expect(lines.some((l) => l.includes("\"Massa 0 BV - M-0 - ") && l.includes(";\"121,00\";"))).toBe(true); // oude kop
    expect(statusOf("p-0000")).toBe("gecontroleerd");
    expect(statusOf("p-a204")).toBe("geexporteerd");
    expect(statusOf("p-0001")).toBe("geexporteerd");
    expect(String(toastTitled(/status bijwerken mislukt/)?.description)).toMatch(/Niet gemarkeerd: Massa 0 BV - M-0\./);
  });

  it("leest meer dan 1000 boekingsregels volledig, in pagina's (PostgREST db-max-rows 1000)", async () => {
    h.selectedClientId = "c1";
    fakeDb.tables.purchase_invoices.push(
      purchaseRow("p-groot", "c1", { supplier: "Groothandel BV", invoice_number: "G-1", amount_excl: 10.01, btw_amount: 0, amount_incl: 10.01, btw_percentage: 0, remaining_amount: 10.01 }),
    );
    for (let i = 0; i < 1001; i++) {
      fakeDb.tables.purchase_invoice_lines.push(
        lineRow(`l-groot-${String(i).padStart(4, "0")}`, "p-groot", { omschrijving: `Artikel ${i}`, amount_excl: 0.01, btw_percentage: 0, sort_order: i }),
      );
    }
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(downloads).toHaveLength(1));
    const { lines } = await csvLines(downloads[0]);
    expect(lines.filter((l) => l.includes("Groothandel BV - G-1"))).toHaveLength(1001);
    expect(selectsOn("purchase_invoice_lines").map((c) => c.returned)).toEqual([1000, 3]);
    await waitFor(() => expect(statusOf("p-groot")).toBe("geexporteerd"));
  });

  it("een server die minder regels geeft dan gevraagd, levert nooit een halve factuur op", async () => {
    h.selectedClientId = "c1";
    fakeDb.maxRows = 1; // elk verzoek levert hooguit één rij: de tweede A2-04-regel ontbreekt
    renderFacturen();
    fireEvent.click(exportButton());
    const list = await screen.findByRole("list", { name: /Niet geëxporteerde facturen/ });
    expect(within(list).getByText(/Leverancier BV - 000123/).closest("li")).toHaveTextContent(/sluiten niet aan/);
    expect(downloads).toHaveLength(0);
    expect(updatesOn("purchase_invoices")).toHaveLength(0);
  });
});

describe("Inkoop — markering pas na een geslaagde export (punt 3)", () => {
  it("markeert pas nadat de download is gestart", async () => {
    h.selectedClientId = "c1";
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(updatesOn("purchase_invoices")).toHaveLength(1));
    const downloadAt = fakeDb.events.findIndex((e) => e.startsWith("download:"));
    const updateAt = fakeDb.events.findIndex((e) => e.startsWith("update:purchase_invoices"));
    expect(downloadAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(downloadAt);
  });

  it("mislukt het starten van de download, dan wordt er niets gemarkeerd", async () => {
    h.selectedClientId = "c1";
    (URL as any).createObjectURL = vi.fn(() => {
      throw new Error("download geblokkeerd door de browser");
    });
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(h.toasts.some((t) => t.title === "Export mislukt")).toBe(true));
    expect(updatesOn("purchase_invoices")).toHaveLength(0);
    expect(statusOf("p-a204")).toBe("gecontroleerd");
  });

  it("mislukt het ophalen van de boekingsregels, dan geen bestand en geen markering", async () => {
    h.selectedClientId = "c1";
    fakeDb.failWith = (table) => (table === "purchase_invoice_lines" ? { message: "permission denied for table purchase_invoice_lines" } : null);
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(h.toasts.some((t) => t.title === "Export mislukt")).toBe(true));
    expect(downloads).toHaveLength(0);
    expect(updatesOn("purchase_invoices")).toHaveLength(0);
  });

  it("een markering die stil 0 rijen raakt (zoals RLS), geeft een duidelijke foutmelding en geen succes", async () => {
    h.selectedClientId = "c1";
    fakeDb.updateFilter = () => []; // de UPDATE slaagt zonder fout, maar raakt niets
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(h.toasts.length).toBeGreaterThan(0));
    await settle();
    expect(downloads).toHaveLength(1);
    expect(h.toasts.some((t) => /geëxporteerd voor Snelstart/.test(String(t.title)))).toBe(false);
    const failure = h.toasts.find((t) => /status bijwerken mislukt/.test(String(t.title)));
    expect(failure?.variant).toBe("destructive");
    expect(String(failure?.description)).toMatch(/0 van 1/);
  });

  it("een geweigerde markering (fout van de server) geeft de foutmelding, geen succes", async () => {
    h.selectedClientId = "c1";
    fakeDb.failWith = (table, op) => (table === "purchase_invoices" && op === "update" ? { message: "new row violates row-level security policy" } : null);
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(toastTitled(/status bijwerken mislukt/)).toBeTruthy());
    expect(downloads).toHaveLength(1);
    expect(toastTitled(/geëxporteerd voor Snelstart/)).toBeUndefined();
    expect(String(toastTitled(/status bijwerken mislukt/)?.description)).toMatch(/row-level security/);
  });

  it("het markeren raakt alleen de exportstatus: restant en betaalstatus blijven (D1)", async () => {
    h.selectedClientId = "c1";
    invoice("p-a204").remaining_amount = 30; // deels betaald
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(statusOf("p-a204")).toBe("geexporteerd"));
    const updates = updatesOn("purchase_invoices");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({ status: "geexporteerd" });
    expect(updates[0].filters).toEqual(
      expect.arrayContaining(["organization_id=eq.org-1", "client_id=eq.c1", "status=in.(gecontroleerd,betaald)"]),
    );
    expect(invoice("p-a204").remaining_amount).toBe(30);
  });

  it("een 'betaald'-factuur met een openstaand bedrag ≠ 0 gaat niet mee: markeren zou de betaalstatus veranderen (D1)", async () => {
    h.selectedClientId = "c1";
    Object.assign(invoice("p-a204"), { status: "betaald", remaining_amount: 230 });
    renderFacturen();
    fireEvent.click(exportButton());
    const list = await screen.findByRole("list", { name: /Niet geëxporteerde facturen/ });
    expect(within(list).getByText(/Leverancier BV - 000123/).closest("li")).toHaveTextContent(/betaalstatus/);
    expect(downloads).toHaveLength(0);
    expect(updatesOn("purchase_invoices")).toHaveLength(0);
    expect(statusOf("p-a204")).toBe("betaald");
  });

  it("een 'betaald'-factuur met restant 0 gaat wel mee en wordt gemarkeerd", async () => {
    h.selectedClientId = "c1";
    Object.assign(invoice("p-a204"), { status: "betaald", remaining_amount: 0 });
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(statusOf("p-a204")).toBe("geexporteerd"));
    expect(invoice("p-a204").remaining_amount).toBe(0);
    const { lines } = await csvLines(downloads[0]);
    expect(lines).toEqual(A204_CSV);
  });

  it("zonder één exporteerbare factuur: geen download en geen markering, wel de lijst", async () => {
    h.selectedClientId = "c1";
    fakeDb.tables.purchase_invoice_lines = fakeDb.tables.purchase_invoice_lines.filter((l) => l.purchase_invoice_id !== "p-a204");
    renderFacturen();
    fireEvent.click(exportButton());
    const list = await screen.findByRole("list", { name: /Niet geëxporteerde facturen/ });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(downloads).toHaveLength(0);
    expect(updatesOn("purchase_invoices")).toHaveLength(0);
    expect(toastTitled(/Geen facturen geëxporteerd/)?.variant).toBe("destructive");
  });
});

describe("Inkoop — export per boekingsregel via de pagina (A2-04)", () => {
  it("weigert fail-closed: regel zonder rekening, onbekende btw (NULL), rekening van een andere administratie; 0% blijft code 0", async () => {
    h.selectedClientId = "c1";
    fakeDb.tables.grootboekrekeningen.push(
      accountRow("gb-7000", 7000),
      accountRow("gb-andere", 4500, { client_id: "c2" }),
    );
    fakeDb.tables.purchase_invoices.push(
      purchaseRow("p-nul", "c1", { supplier: "Verzekeraar NV", invoice_number: "V-0", amount_excl: 50, btw_amount: 0, amount_incl: 50, btw_percentage: 0, remaining_amount: 50 }),
      purchaseRow("p-zonder-rek", "c1", { supplier: "Geen Rekening BV", invoice_number: "R-1" }),
      purchaseRow("p-null-btw", "c1", { supplier: "Onbekende Btw BV", invoice_number: "B-1" }),
      purchaseRow("p-vreemd", "c1", { supplier: "Vreemde Rekening BV", invoice_number: "A-1" }),
    );
    fakeDb.tables.purchase_invoice_lines.push(
      lineRow("l-nul", "p-nul", { omschrijving: "Premie", amount_excl: 50, btw_percentage: 0, grootboekrekening_id: "gb-7000" }),
      lineRow("l-zonder-rek", "p-zonder-rek", { grootboekrekening_id: null }),
      lineRow("l-null-btw", "p-null-btw", { btw_percentage: null }),
      lineRow("l-vreemd", "p-vreemd", { grootboekrekening_id: "gb-andere" }),
    );
    renderFacturen();
    fireEvent.click(exportButton());
    await waitFor(() => expect(downloads).toHaveLength(1));
    const { lines } = await csvLines(downloads[0]);
    expect(lines).toEqual([...A204_CSV, '"20-10-2026";"Verzekeraar NV - V-0 - Premie";"7000";"50,00";"0"']);
    const list = await screen.findByRole("list", { name: /Niet geëxporteerde facturen/ });
    const reason = (label: RegExp) => within(list).getByText(label).closest("li")?.textContent ?? "";
    expect(reason(/Geen Rekening BV - R-1/)).toMatch(/zonder grootboekrekening/);
    expect(reason(/Onbekende Btw BV - B-1/)).toMatch(/zonder btw-percentage \(onbekende btw\)/);
    expect(reason(/Vreemde Rekening BV - A-1/)).toMatch(/niet bij deze administratie hoort/);
    await waitFor(() => expect(statusOf("p-nul")).toBe("geexporteerd"));
    expect(["p-a204", "p-nul"].map(statusOf)).toEqual(["geexporteerd", "geexporteerd"]);
    expect(["p-leeg", "p-zonder-rek", "p-null-btw", "p-vreemd"].map(statusOf)).toEqual(
      ["gecontroleerd", "gecontroleerd", "gecontroleerd", "gecontroleerd"],
    );
  });
});
