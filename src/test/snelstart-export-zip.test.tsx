import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import JSZip from "jszip";

/**
 * Herstelpakket P6 — de ZIP-export "Export alles (Snelstart)" op Rapportages
 * (`exportAllForClient`).
 *
 * - A2-04: de inkoop in de ZIP gaat per boekingsregel, met dezelfde weigeringen
 *   als de inkoopexport; structuur en bestandsnamen blijven gelijk.
 * - A2-05: alle rijen horen bij de gekozen administratie, anders geen ZIP.
 * - C-11: het bankdagboek is verplicht; geen 1100-fallback.
 *
 * Verse ophaling van facturen, regels en rekeningen loopt via de echte
 * exportfuncties tegen een in-memory databron; boekingen, bankregels en de
 * actieve rekeningen komen uit (gemockte) paginahooks.
 */

const h = vi.hoisted(() => ({
  toasts: [] as any[],
  clients: [] as any[],
  entries: [] as any[],
  transactions: [] as any[],
  activeAccounts: [] as any[],
}));

vi.mock("@/integrations/supabase/client", async () => {
  const { fakeSupabase } = await import("./support/snelstart-export-fakes");
  return { supabase: fakeSupabase };
});
const ok = (data: any[]) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({ useClients: () => ok(h.clients) }));
vi.mock("@/hooks/usePurchaseInvoices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/usePurchaseInvoices")>();
  return { ...actual, usePurchaseInvoices: () => ok([]) };
});
vi.mock("@/hooks/useJournalEntries", () => ({ useJournalEntries: () => ok(h.entries) }));
vi.mock("@/hooks/useBankTransactions", () => ({ useBankTransactions: () => ok(h.transactions) }));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({ useActiveGrootboekrekeningen: () => ok(h.activeAccounts) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: (t: any) => { h.toasts.push(t); } }) }));

import Overzichten from "@/pages/Overzichten";
import {
  A204_CSV,
  CLIENT_EEN,
  accountRow,
  csvLinesFromBytes,
  downloads,
  fakeDb,
  installDownloadCapture,
  lineRow,
  purchaseRow,
  readBlobBytes,
  seedA204,
} from "./support/snelstart-export-fakes";

const bankTx = (id: string, over: Record<string, any> = {}) => ({
  id,
  client_id: "c1",
  organization_id: "org-1",
  user_id: "user-1",
  transaction_date: "2026-10-05",
  description: "Betaling leverancier",
  amount: -121,
  match_status: "handmatig_geboekt",
  grootboekrekening_id: "gb-4400",
  ...over,
});

const entry = (id: string, over: Record<string, any> = {}) => ({
  id,
  client_id: "c1",
  organization_id: "org-1",
  entry_date: "2026-03-01",
  description: "Memoriaal oud",
  ledger_account_text: "4000",
  amount: -121,
  btw_percentage: null,
  ...over,
});

async function unzip(): Promise<Record<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(await readBlobBytes(downloads[0].blob));
  const out: Record<string, Uint8Array> = {};
  for (const name of Object.keys(zip.files)) out[name] = await zip.files[name].async("uint8array");
  return out;
}

function renderOverzichten() {
  render(<MemoryRouter><Overzichten /></MemoryRouter>);
}

const zipButton = () => screen.getByRole("button", { name: /Export alles \(Snelstart\)/ });

beforeEach(() => {
  fakeDb.reset();
  h.toasts.length = 0;
  h.clients = [CLIENT_EEN, { id: "c2", name: "Garage Twee VOF", organization_id: "org-1", bank_dagboek: 1300 }];
  h.entries = [];
  h.transactions = [];
  h.activeAccounts = [accountRow("gb-4400", 4400)];
  installDownloadCapture();
  fakeDb.tables.grootboekrekeningen = [accountRow("gb-4400", 4400), accountRow("gb-4600", 4600)];
  seedA204("c1");
  fakeDb.tables.purchase_invoices.push(purchaseRow("p-leeg", "c1", { supplier: "Zonder Regels BV", invoice_number: "Z-1" }));
  fakeDb.tables.purchase_invoices.push(purchaseRow("p-twee", "c2", { supplier: "Andere BV", invoice_number: "X-1" }));
  fakeDb.tables.purchase_invoice_lines.push(lineRow("l-twee", "p-twee"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ZIP-export (exportAllForClient) — per boekingsregel, één administratie, verplicht dagboek", () => {
  it("de inkoop in de ZIP gaat per boekingsregel; structuur en bestandsnamen blijven gelijk; de bank gebruikt het ingestelde dagboek", async () => {
    h.entries = [entry("je-1")];
    h.transactions = [bankTx("t-1")];
    renderOverzichten();
    fireEvent.click(zipButton());
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].name).toBe("Bakkerij_Een_BV_snelstart_export.zip");
    const files = await unzip();
    expect(Object.keys(files).sort()).toEqual([
      "Bakkerij_Een_BV_banktransacties.csv",
      "Bakkerij_Een_BV_boekingen.csv",
      "Bakkerij_Een_BV_inkoopfacturen.csv",
    ]);
    const inkoop = csvLinesFromBytes(files["Bakkerij_Een_BV_inkoopfacturen.csv"]);
    expect(inkoop.bom).toBe(true);
    expect(inkoop.lines).toEqual(A204_CSV);
    const boekingen = csvLinesFromBytes(files["Bakkerij_Een_BV_boekingen.csv"]);
    expect(boekingen.bom).toBe(true);
    expect(boekingen.lines[1]).toBe('"01-03-2026";"Memoriaal oud";"4000";"-121,00";""');
    const bank = csvLinesFromBytes(files["Bakkerij_Een_BV_banktransacties.csv"]);
    expect(bank.bom).toBe(false);
    expect(bank.lines).toEqual([
      "fldDagboek;fldBoekingcode;fldDatum;fldGrootboeknummer;fldDebet;fldCredit;fldOmschrijving",
      "1200;1;05-10-2026;1200;0;121,00;Betaling leverancier",
      "1200;1;05-10-2026;4400;121,00;0;Betaling leverancier",
    ]);
    // De factuur zonder regels staat met reden in de lijst; de ZIP markeert niets.
    const list = await screen.findByRole("list", { name: /Niet geëxporteerde facturen/ });
    expect(within(list).getByText(/Zonder Regels BV - Z-1/).closest("li")).toHaveTextContent(/geen boekingsregels/);
    expect(fakeDb.calls.filter((c) => c.op === "update")).toHaveLength(0);
  });

  it("zonder ingesteld bankdagboek is er geen ZIP en een duidelijke melding (geen 1100)", async () => {
    h.clients = [{ ...CLIENT_EEN, bank_dagboek: null }];
    h.transactions = [bankTx("t-1")];
    renderOverzichten();
    fireEvent.click(zipButton());
    await waitFor(() => expect(h.toasts.some((t) => t.title === "Exportfout")).toBe(true));
    expect(String(h.toasts.find((t) => t.title === "Exportfout").description)).toMatch(/bankdagboek/i);
    expect(downloads).toHaveLength(0);
  });

  it("zonder bankdagboek maar ook zonder exporteerbare bankregels gaat de ZIP gewoon (er is geen bankbestand nodig)", async () => {
    h.clients = [{ ...CLIENT_EEN, bank_dagboek: null }];
    h.transactions = [bankTx("t-open", { match_status: "niet_gematcht", grootboekrekening_id: null })];
    renderOverzichten();
    fireEvent.click(zipButton());
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(Object.keys(await unzip())).toEqual(["Bakkerij_Een_BV_inkoopfacturen.csv"]);
  });

  it("de verdedigingslaag weigert de ZIP als de server rijen van een andere administratie teruggeeft", async () => {
    fakeDb.ignoreClientFilter = true;
    renderOverzichten();
    fireEvent.click(zipButton());
    await waitFor(() => expect(h.toasts.some((t) => t.title === "Exportfout")).toBe(true));
    expect(String(h.toasts.find((t) => t.title === "Exportfout").description)).toMatch(/administratie/i);
    expect(downloads).toHaveLength(0);
  });

  it("bankregels of boekingen van een andere administratie in de paginadata: geen ZIP", async () => {
    h.transactions = [bankTx("t-1"), bankTx("t-vreemd", { client_id: "c2" })];
    renderOverzichten();
    fireEvent.click(zipButton());
    await waitFor(() => expect(h.toasts.some((t) => t.title === "Exportfout")).toBe(true));
    expect(downloads).toHaveLength(0);
  });
});
