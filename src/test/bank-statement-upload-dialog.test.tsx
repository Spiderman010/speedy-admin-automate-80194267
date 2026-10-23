import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  BankStatementUploadDialog,
  DUPLICATE_CHECK_FAILED_MESSAGE,
} from "@/components/BankStatementUploadDialog";
import type { ExistingBankTransactionForDuplicates } from "@/lib/bank-statement-parser";

/**
 * Bankafschrift importeren — de duplicaatcontrole is fail-closed, kijkt naar
 * exact de importklant, en wordt vlak voor het wegschrijven herhaald.
 */

const CLIENT = { id: "client-a", name: "Klant A", ibans: ["NL91RABO0123456789"] };

const STATEMENT = `:20:STARTUMS
:25:NL91RABO0123456789
:28C:00001
:60F:C260301EUR1000,00
:61:260302D12,50N544NONREF
:86:Parkeren Centrum
:61:260303D23,99N544NONREF
:86:Bol.com bestelling 1234
:62F:C963,51
`;

const PARKEREN: ExistingBankTransactionForDuplicates = {
  transaction_date: "2026-03-02",
  amount: -12.5,
  description: "Parkeren Centrum",
  counter_account: null,
  reference: "NONREF",
};

function file(text: string) {
  const f = new File([text], "afschrift.sta", { type: "text/plain" });
  // jsdom's File has no text(); the dialog reads the file with it.
  Object.defineProperty(f, "text", { value: () => Promise.resolve(text) });
  return f;
}

function renderDialog(loadExistingTransactions: (clientId: string) => Promise<ExistingBankTransactionForDuplicates[]>) {
  const onImport = vi.fn().mockResolvedValue(undefined);
  render(
    <BankStatementUploadDialog
      open
      onOpenChange={() => {}}
      clients={[CLIENT]}
      invoices={[]}
      onImport={onImport}
      loadExistingTransactions={loadExistingTransactions}
      defaultClientId={CLIENT.id}
    />,
  );
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file(STATEMENT)] } });
  return { onImport };
}

describe("BankStatementUploadDialog — storno-invariant", () => {
  it("bewaart een MT940 RC-storno en geeft nooit een factuurmatch mee", async () => {
    const reversalStatement = `:20:REVERSAL
:25:NL91RABO0123456789
:61:260302RC12,50N544RETURN
:86:Terugboeking leverancier
`;
    const onImport = vi.fn().mockResolvedValue(undefined);
    render(
      <BankStatementUploadDialog
        open
        onOpenChange={() => {}}
        clients={[CLIENT]}
        invoices={[{ id: "invoice-a", client_id: CLIENT.id, supplier: "leverancier", amount_incl: 12.5, invoice_number: "REVERSAL" } as any]}
        onImport={onImport}
        loadExistingTransactions={vi.fn().mockResolvedValue([])}
        defaultClientId={CLIENT.id}
      />,
    );
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file(reversalStatement)] },
    });
    fireEvent.click(await screen.findByRole("button", { name: /1 transacties importeren/ }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const rows = onImport.mock.calls[0][1];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      isReversal: true,
      matchedInvoiceId: null,
      matchStatus: "niet_gematcht",
    });
  });
});

describe("BankStatementUploadDialog — duplicaatcontrole", () => {
  it("controleert tegen precies de importklant", async () => {
    const load = vi.fn().mockResolvedValue([]);
    renderDialog(load);
    await screen.findByRole("button", { name: /2 transacties importeren/ });
    expect(load).toHaveBeenCalledWith("client-a");
  });

  it("fail-closed: kunnen de bestaande transacties niet worden geladen, dan wordt er niets aangeboden", async () => {
    const { onImport } = renderDialog(vi.fn().mockRejectedValue(new Error("netwerk")));
    expect(await screen.findByRole("alert")).toHaveTextContent(DUPLICATE_CHECK_FAILED_MESSAGE);
    expect(screen.queryByRole("button", { name: /importeren/ })).toBeNull();
    expect(onImport).not.toHaveBeenCalled();
  });

  it("NONREF maakt een nieuwe regel geen duplicaat: alleen de echte dubbele is uitgevinkt", async () => {
    renderDialog(vi.fn().mockResolvedValue([PARKEREN]));
    expect(await screen.findByRole("button", { name: /1 transacties importeren/ })).toBeEnabled();
    expect(screen.getByText(/1 duplicaten/)).toBeInTheDocument();
  });

  it("hercontrole vlak voor het wegschrijven: wat intussen al is geïmporteerd, wordt niet ongezien nog eens geschreven", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce([]) // preview: nog niets opgeslagen
      .mockResolvedValueOnce([PARKEREN]); // een collega importeerde intussen dezelfde regel
    const { onImport } = renderDialog(load);
    fireEvent.click(await screen.findByRole("button", { name: /2 transacties importeren/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/1 transactie is intussen al geïmporteerd/);
    expect(onImport).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /1 transacties importeren/ })).toBeEnabled();
  });

  it("zonder wijziging sinds de preview importeert hij precies de geselecteerde regels voor de importklant", async () => {
    const load = vi.fn().mockResolvedValue([PARKEREN]);
    const { onImport } = renderDialog(load);
    fireEvent.click(await screen.findByRole("button", { name: /1 transacties importeren/ }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const [clientId, rows] = onImport.mock.calls[0];
    expect(clientId).toBe("client-a");
    expect(rows.map((r: { description: string }) => r.description)).toEqual(["Bol.com bestelling 1234"]);
    // Elke regel draagt de vingerafdruk die over het hele afschrift is berekend.
    expect(rows[0].importFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("import niet gestart (onImport geeft false): de preview blijft open en het dialoog sluit niet", async () => {
    const onOpenChange = vi.fn();
    const onImport = vi.fn().mockResolvedValue(false);
    render(
      <BankStatementUploadDialog
        open
        onOpenChange={onOpenChange}
        clients={[CLIENT]}
        invoices={[]}
        onImport={onImport}
        loadExistingTransactions={vi.fn().mockResolvedValue([])}
        defaultClientId={CLIENT.id}
      />,
    );
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file(STATEMENT)] } });
    fireEvent.click(await screen.findByRole("button", { name: /2 transacties importeren/ }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: /2 transacties importeren/ })).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("tijdens de controle kan de klant niet worden gewisseld (de preview hoort bij één klant)", async () => {
    let resolve!: (rows: ExistingBankTransactionForDuplicates[]) => void;
    renderDialog(() => new Promise((r) => { resolve = r; }));
    expect(await screen.findByRole("status")).toHaveTextContent(/controleren op duplicaten/);
    expect(screen.getByRole("combobox")).toBeDisabled();
    resolve([]);
    await screen.findByRole("button", { name: /2 transacties importeren/ });
  });

  it("de klant staat al vast terwijl het bestand nog wordt gelezen", async () => {
    let release!: (text: string) => void;
    const slow = new File([STATEMENT], "afschrift.sta", { type: "text/plain" });
    Object.defineProperty(slow, "text", { value: () => new Promise<string>((r) => { release = r; }) });
    const load = vi.fn().mockResolvedValue([]);
    render(
      <BankStatementUploadDialog
        open
        onOpenChange={() => {}}
        clients={[CLIENT]}
        invoices={[]}
        onImport={vi.fn()}
        loadExistingTransactions={load}
        defaultClientId={CLIENT.id}
      />,
    );
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [slow] } });
    expect(screen.getByRole("combobox")).toBeDisabled();
    release(STATEMENT);
    await screen.findByRole("button", { name: /2 transacties importeren/ });
    expect(load).toHaveBeenCalledWith("client-a");
  });

  it("een bestand zonder transacties toont de fout en laat klantkeuze en bestandskeuze weer open", async () => {
    const empty = file(":20:LEEG\n:25:NL91RABO0123456789\n:62F:C0,00\n");
    render(
      <BankStatementUploadDialog
        open
        onOpenChange={() => {}}
        clients={[CLIENT]}
        invoices={[]}
        onImport={vi.fn()}
        loadExistingTransactions={vi.fn().mockResolvedValue([])}
        defaultClientId={CLIENT.id}
      />,
    );
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [empty] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Geen transacties gevonden/);
    expect(screen.getByRole("combobox")).toBeEnabled();
    expect(screen.getByRole("button", { name: /Bestand selecteren/ })).toBeEnabled();
  });

  it("sluiten terwijl het bestand nog wordt gelezen: het oude bestand verschijnt daarna niet alsnog", async () => {
    let release!: (text: string) => void;
    const slow = new File([STATEMENT], "afschrift.sta", { type: "text/plain" });
    Object.defineProperty(slow, "text", { value: () => new Promise<string>((r) => { release = r; }) });
    const load = vi.fn().mockResolvedValue([]);
    render(
      <BankStatementUploadDialog
        open
        onOpenChange={() => {}}
        clients={[CLIENT]}
        invoices={[]}
        onImport={vi.fn()}
        loadExistingTransactions={load}
        defaultClientId={CLIENT.id}
      />,
    );
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [slow] } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    release(STATEMENT);
    await new Promise((r) => setTimeout(r, 50));
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /transacties importeren/ })).toBeNull();
  });

  it("een bewust aangevinkte duplicaat blijft de keuze van de gebruiker", async () => {
    const load = vi.fn().mockResolvedValue([PARKEREN]);
    const { onImport } = renderDialog(load);
    await screen.findByRole("button", { name: /1 transacties importeren/ });
    const checkboxes = screen.getAllByRole("checkbox");
    const unchecked = checkboxes.find((c) => c.getAttribute("data-state") === "unchecked");
    fireEvent.click(unchecked!);
    fireEvent.click(screen.getByRole("button", { name: /2 transacties importeren/ }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][1]).toHaveLength(2);
  });
});
