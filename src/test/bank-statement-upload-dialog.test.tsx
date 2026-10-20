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
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("tijdens de controle kan de klant niet worden gewisseld (de preview hoort bij één klant)", async () => {
    let resolve!: (rows: ExistingBankTransactionForDuplicates[]) => void;
    renderDialog(() => new Promise((r) => { resolve = r; }));
    expect(await screen.findByRole("status")).toHaveTextContent(/controleren op duplicaten/);
    expect(screen.getByRole("combobox")).toBeDisabled();
    resolve([]);
    await screen.findByRole("button", { name: /2 transacties importeren/ });
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
