/**
 * Bankafschrift importeren — de blokkades en de suggesties (nulmeting A1-11,
 * A1-13, A1-14, F1a-N3, D-05, B2-10). De echte dialoog, met echte parser en
 * echte veilige-matchpoort; geen netwerk.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import { BankStatementUploadDialog, type MatchedTransaction } from "@/components/BankStatementUploadDialog";

type Client = { id: string; name: string; ibans?: string[] | null };

const A: Client = { id: "client-a", name: "Klant A", ibans: ["NL91RABO0123456789"] };
const B: Client = { id: "client-b", name: "Klant B", ibans: [] };

const statement = (lines: string[], closing: string, opts: { account?: string; currency?: string } = {}) =>
  [
    ":20:STARTUMS",
    `:25:${opts.account ?? "NL91RABO0123456789"}`,
    ":28C:00001",
    `:60F:C261001${opts.currency ?? "EUR"}1000,00`,
    ...lines,
    `:62F:C261002${opts.currency ?? "EUR"}${closing}`,
    "-",
  ].join("\n");

function file(text: string) {
  const f = new File([text], "afschrift.sta", { type: "text/plain" });
  Object.defineProperty(f, "text", { value: () => Promise.resolve(text) });
  return f;
}

function renderDialog(opts: {
  text: string;
  clients?: Client[];
  clientId?: string;
  purchases?: any[];
  sales?: any[];
  loadInvoices?: (clientId: string) => Promise<{ purchases: any[]; sales: any[] }>;
}) {
  const onImport = vi.fn<(clientId: string, rows: MatchedTransaction[]) => Promise<void>>().mockResolvedValue(undefined);
  const load = vi.fn().mockResolvedValue([]);
  // De dialoog laadt zelf de facturen van de importadministratie (review P2-5).
  const loadInvoices = opts.loadInvoices ?? vi.fn(async () => ({ purchases: opts.purchases ?? [], sales: opts.sales ?? [] }));
  render(
    <BankStatementUploadDialog
      open
      onOpenChange={() => {}}
      clients={opts.clients ?? [A, B]}
      loadInvoices={loadInvoices}
      onImport={onImport}
      loadExistingTransactions={load}
      defaultClientId={opts.clientId ?? A.id}
    />,
  );
  fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file(opts.text)] } });
  return { onImport, load, loadInvoices };
}

const blockers = () => screen.findByTestId("import-blockers");

describe("blokkades: niets importeren wat niet klopt", () => {
  it("een onleesbare :61:-regel blokkeert en de melding toont de ruwe regel", async () => {
    const { onImport, load } = renderDialog({
      text: statement([":61:2610021002X12,00NTRFNONREF//X1", ":86:onleesbaar"], "1000,00"),
    });
    const panel = await blockers();
    expect(panel).toHaveTextContent("Importeren geblokkeerd");
    expect(within(panel).getByText(/:61:2610021002X12,00NTRFNONREF\/\/X1/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /transacties importeren/ })).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
  });

  it("een saldoverschil blokkeert, met het verschil", async () => {
    renderDialog({ text: statement([":61:261002D12,50N544NONREF", ":86:Parkeren"], "1000,00") });
    const panel = await blockers();
    expect(panel).toHaveTextContent(/De saldocontrole klopt niet/);
    expect(panel).toHaveTextContent(/verschil €\s12,50/);
    expect(screen.queryByRole("button", { name: /transacties importeren/ })).toBeNull();
  });

  it("een storno (RC) met boekdatum wordt als afschrijving gelezen: het afschrift sluit en is importeerbaar", async () => {
    const { onImport } = renderDialog({
      text: statement([":61:2610021002RC100,00NTRFNONREF//B4", ":86:Storno incasso"], "900,00"),
    });
    fireEvent.click(await screen.findByRole("button", { name: /1 transacties importeren/ }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][1].map((r) => [r.amount, r.isReversal])).toEqual([[-100, true]]);
  });

  it("een afschrift in een andere valuta blokkeert", async () => {
    renderDialog({ text: statement([":61:261002C99,99N544NONREF", ":86:USD"], "1099,99", { currency: "USD" }) });
    expect(await blockers()).toHaveTextContent(/alleen EUR/);
  });

  it("een IBAN van een andere administratie in de organisatie blokkeert en noemt die administratie", async () => {
    const { onImport, load } = renderDialog({
      text: statement([":61:261002D12,50N544NONREF", ":86:Parkeren"], "987,50"),
      clientId: B.id,
    });
    expect(await blockers()).toHaveTextContent("Rekening NL91RABO0123456789 hoort bij Klant A, niet bij Klant B");
    expect(load).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
  });

  it("geen IBAN vastgelegd en het IBAN is onbekend: pas importeren na een expliciete bevestiging", async () => {
    const { onImport } = renderDialog({
      text: statement([":61:261002D12,50N544NONREF", ":86:Parkeren"], "987,50", { account: "NL55INGB0007654321" }),
      clientId: B.id,
    });
    const importButton = await screen.findByRole("button", { name: /1 transacties importeren/ });
    expect(screen.getByTestId("import-target")).toHaveTextContent("Klant B");
    expect(screen.getByTestId("account-confirm")).toHaveTextContent(/Klant B heeft geen IBAN vastgelegd/);
    expect(importButton).toBeDisabled();
    fireEvent.click(importButton);
    expect(onImport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /Ik heb gecontroleerd dat dit afschrift bij Klant B hoort/ }));
    expect(importButton).toBeEnabled();
    fireEvent.click(importButton);
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][0]).toBe(B.id);
  });

  it("met het vastgelegde IBAN van de gekozen administratie is geen bevestiging nodig", async () => {
    renderDialog({ text: statement([":61:261002D12,50N544NONREF", ":86:Parkeren"], "987,50") });
    expect(await screen.findByRole("button", { name: /1 transacties importeren/ })).toBeEnabled();
    expect(screen.queryByTestId("account-confirm")).toBeNull();
    expect(screen.getByText(/Rekening NL91RABO0123456789 hoort bij Klant A/)).toBeInTheDocument();
  });

  it("een voorgekozen administratie die niet in de lijst staat (vorige organisatie) telt niet: geen bestandskeuze, geen import", async () => {
    const onImport = vi.fn();
    const load = vi.fn().mockResolvedValue([]);
    render(
      <BankStatementUploadDialog open onOpenChange={() => {}} clients={[B]} onImport={onImport}
        loadExistingTransactions={load} defaultClientId="client-van-andere-org" />,
    );
    expect(screen.getByRole("button", { name: /Bestand selecteren/ })).toBeDisabled();
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file(statement([":61:261002D12,50N544NONREF", ":86:x"], "987,50"))] },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(load).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /transacties importeren/ })).toBeNull();
  });
});

const purchase = (over: any) => ({
  client_id: A.id, organization_id: "org-1", status: "gecontroleerd", amount_excl: null, invoice_date: "2026-09-01", ...over,
});
const sale = (over: any) => ({
  client_id: A.id, organization_id: "org-1", status: "verzonden", amount_excl: null, invoice_date: "2026-09-01", ...over,
});

describe("suggesties bij de import: nooit 'gematcht', alleen via de veilige-matchpoort (A1-11)", () => {
  const purchases = [
    purchase({ id: "p-bouw", supplier: "Bouwmarkt Groothandel", invoice_number: "INK-77", amount_incl: 121, remaining_amount: 121 }),
    purchase({ id: "p-betaald", supplier: "Iemand Anders", invoice_number: "INK-88", amount_incl: 99.99, remaining_amount: 0 }),
    purchase({ id: "p-kpn", supplier: "KPN", invoice_number: "INK-90", amount_incl: 50, remaining_amount: 50 }),
    purchase({ id: "p-andere-klant", client_id: B.id, supplier: "KPN", invoice_number: "INK-91", amount_incl: 50, remaining_amount: 50 }),
  ];
  const sales = [
    sale({ id: "s-bakker", customer_name: "Bakkerij Jansen", invoice_number: "V-2026-01", amount_incl: 250, remaining_amount: 250 }),
  ];

  async function importAll(lines: string[], closing: string) {
    const { onImport } = renderDialog({ text: statement(lines, closing), purchases, sales });
    fireEvent.click(await screen.findByRole("button", { name: /transacties importeren/ }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    return Object.fromEntries(onImport.mock.calls[0][1].map((r) => [r.amount, [r.matchStatus, r.matchedInvoiceId]]));
  }

  it("richting, openstaand bedrag en administratie bepalen de suggestie; 'gematcht' komt niet voor", async () => {
    const byAmount = await importAll(
      [
        ":61:2610021002C121,00NTRFNONREF//R1", ":86:/NAME/Bouwmarkt Groothandel/REMI/terugbetaling INK-77",
        ":61:2610021002D99,99NTRFNONREF//R2", ":86:/NAME/Iemand Anders/REMI/INK-88",
        ":61:2610021002C250,00NTRFNONREF//R3", ":86:/NAME/Bakkerij Jansen/REMI/V-2026-01",
        ":61:2610021002D50,00NTRFNONREF//R4", ":86:/NAME/KPN/REMI/INK-90",
      ],
      "1221,01",
    );
    expect(byAmount).toEqual({
      121: ["niet_gematcht", null], // geld in hoort niet bij een inkoopfactuur
      [-99.99]: ["niet_gematcht", null], // al betaald: niets open
      250: ["suggestie", "s-bakker"], // geld in ↔ verkoop
      [-50]: ["suggestie", "p-kpn"], // geld uit ↔ inkoop, van deze administratie
    });
    expect(Object.values(byAmount).map(([status]) => status)).not.toContain("gematcht");
  });

  it("bij een gelijke topscore geen voorselectie", async () => {
    const tied = [
      purchase({ id: "jan", supplier: "Vodafone Libertel", invoice_number: "VF-01", amount_incl: 121, remaining_amount: 121 }),
      purchase({ id: "feb", supplier: "Vodafone Libertel", invoice_number: "VF-02", amount_incl: 121, remaining_amount: 121 }),
    ];
    const { onImport } = renderDialog({
      text: statement([":61:2610021002D121,00NTRFNONREF//V1", ":86:/NAME/Vodafone Libertel/REMI/maandtermijn"], "879,00"),
      purchases: tied,
    });
    fireEvent.click(await screen.findByRole("button", { name: /1 transacties importeren/ }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][1][0]).toMatchObject({ matchStatus: "niet_gematcht", matchedInvoiceId: null });
  });

  it("een storno krijgt nooit een factuursuggestie", async () => {
    const byAmount = await importAll([":61:2610021002RD250,00NTRFNONREF//S1", ":86:/NAME/Bakkerij Jansen/REMI/V-2026-01 retour"], "1250,00");
    expect(byAmount).toEqual({ 250: ["niet_gematcht", null] });
  });
});

describe("suggesties komen van de importadministratie zelf, niet van de selectie op de bankpagina (review P2-5)", () => {
  const kpn = purchase({ id: "p-kpn-b", client_id: B.id, supplier: "KPN", invoice_number: "INK-90", amount_incl: 50, remaining_amount: 50 });
  const lines = [":61:2610021002D50,00NTRFNONREF//R4", ":86:/NAME/KPN/REMI/INK-90"];

  it("import in een andere administratie dan op de bankpagina gekozen: de facturen van die administratie worden geladen en voorgesteld", async () => {
    const loadInvoices = vi.fn(async (clientId: string) => ({ purchases: clientId === B.id ? [kpn] : [], sales: [] }));
    const { onImport } = renderDialog({
      text: statement(lines, "950,00", { account: "NL55INGB0007654321" }),
      clientId: B.id,
      loadInvoices,
    });
    const importButton = await screen.findByRole("button", { name: /1 transacties importeren/ });
    expect(loadInvoices).toHaveBeenCalledWith(B.id);
    fireEvent.click(screen.getByRole("checkbox", { name: /Ik heb gecontroleerd dat dit afschrift bij Klant B hoort/ }));
    fireEvent.click(importButton);
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][1].map((r) => [r.matchStatus, r.matchedInvoiceId])).toEqual([["suggestie", "p-kpn-b"]]);
  });

  it("laden mislukt: wel importeren, geen suggesties, en dat staat er", async () => {
    const { onImport } = renderDialog({
      text: statement(lines, "950,00"),
      loadInvoices: vi.fn(async () => { throw new Error("netwerk"); }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /1 transacties importeren/ }));
    expect(screen.getByTestId("import-suggestions-unavailable")).toBeInTheDocument();
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][1].map((r) => [r.matchStatus, r.matchedInvoiceId])).toEqual([["niet_gematcht", null]]);
  });
});
