import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

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

const state = {
  accounts: [
    { id: "gb-8000", nummer: 8000, omschrijving: "Omzet hoog" },
    { id: "gb-8010", nummer: 8010, omschrijving: "Omzet laag" },
  ] as any[],
};

const onSaveSpy = vi.fn();
const onApproveSpy = vi.fn();

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c-1", name: "Klant Een", btw_vrijgesteld: false }] }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }), download: async () => ({ data: null, error: null }) }) },
  },
}));
vi.mock("@/components/CreateVraagpostDialog", () => ({
  CreateVraagpostDialog: () => null,
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: ({ value, onValueChange, onIdChange }: any) => (
    <input
      aria-label="Grootboekrekening"
      value={value ?? ""}
      onChange={(e) => {
        onValueChange?.(e.target.value);
        const match = state.accounts.find(
          (a: any) => `${a.nummer} - ${a.omschrijving}` === e.target.value,
        );
        onIdChange?.(match ? match.id : "");
      }}
    />
  ),
}));

import { SalesInvoiceEditDialog } from "@/components/SalesInvoiceEditDialog";

const makeInvoice = (over: Partial<any> = {}) => ({
  id: "si-1",
  client_id: "c-1",
  organization_id: "org-1",
  user_id: "u-1",
  customer_name: "Klant X",
  invoice_number: "V-2026-001",
  invoice_date: "2026-04-01",
  due_date: "2026-05-01",
  amount_excl: 1000,
  amount_incl: 1210,
  btw_amount: 210,
  btw_percentage: 21,
  btw_verlegd: false,
  status: "concept",
  ledger_account_text: "8000 - Omzet hoog",
  grootboekrekening_id: null,
  remaining_amount: 1210,
  notes: null,
  pdf_path: null,
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
  ...over,
});

function renderDialog(invoice: any = makeInvoice()) {
  render(
    <SalesInvoiceEditDialog
      invoice={invoice}
      open
      onOpenChange={() => {}}
      onSave={onSaveSpy}
      onApprove={onApproveSpy}
    />,
  );
}

const ledgerField = () => screen.getByLabelText("Grootboekrekening") as HTMLInputElement;
const saveBtn = () => screen.getByRole("button", { name: /^opslaan$/i });

beforeEach(() => {
  onSaveSpy.mockReset().mockResolvedValue(undefined);
  onApproveSpy.mockReset().mockResolvedValue(undefined);
});

describe("Verkoopfactuur — expliciete grootboekrekening", () => {
  // 15. verkoopflow toont grootboek/omzetrekening
  it("15. toont het grootboekrekening-veld", () => {
    renderDialog();
    expect(screen.getByText("Grootboekrekening")).toBeInTheDocument();
    expect(ledgerField()).toBeInTheDocument();
  });

  // 16. bestaande FK wordt geladen
  it("16. laadt een bestaande grootboekrekening_id en behoudt die bij opslaan", async () => {
    renderDialog(makeInvoice({ grootboekrekening_id: "gb-8000" }));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSaveSpy).toHaveBeenCalledTimes(1));
    expect(onSaveSpy.mock.calls[0][1]).toEqual(
      expect.objectContaining({ grootboekrekening_id: "gb-8000" }),
    );
  });

  // 17, 18. gebruiker kan rekening selecteren → payload bevat FK
  it("17-18. neemt een nieuw gekozen rekening op als grootboekrekening_id", async () => {
    renderDialog();
    fireEvent.change(ledgerField(), { target: { value: "8010 - Omzet laag" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSaveSpy).toHaveBeenCalledTimes(1));
    expect(onSaveSpy.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        grootboekrekening_id: "gb-8010",
        ledger_account_text: "8010 - Omzet laag",
      }),
    );
  });

  // 19. null blijft mogelijk
  it("19. laat geen rekening toe als geldige staat (null)", async () => {
    renderDialog();
    fireEvent.change(ledgerField(), { target: { value: "" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSaveSpy).toHaveBeenCalledTimes(1));
    expect(onSaveSpy.mock.calls[0][1]).toEqual(
      expect.objectContaining({ grootboekrekening_id: null, ledger_account_text: null }),
    );
  });

  // 20. ledger_account_text backwards compatible
  it("20. behoudt ledger_account_text naast de nieuwe FK", async () => {
    renderDialog(makeInvoice({ grootboekrekening_id: "gb-8000" }));
    expect(ledgerField()).toHaveValue("8000 - Omzet hoog");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSaveSpy).toHaveBeenCalledTimes(1));
    const payload = onSaveSpy.mock.calls[0][1];
    expect(payload.ledger_account_text).toBe("8000 - Omzet hoog");
    expect(payload.grootboekrekening_id).toBe("gb-8000");
  });

  // 21-24. bestaande semantiek ongewijzigd
  it("21-24. laat bedrag-, BTW-, status- en betaalsemantiek ongewijzigd", async () => {
    renderDialog();
    fireEvent.change(ledgerField(), { target: { value: "8000 - Omzet hoog" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSaveSpy).toHaveBeenCalledTimes(1));
    const payload = onSaveSpy.mock.calls[0][1];
    // bedragen
    expect(payload.amount_excl).toBe(1000);
    expect(payload.amount_incl).toBe(1210);
    // BTW
    expect(payload.btw_amount).toBe(210);
    expect(payload.btw_percentage).toBe(21);
    expect(payload.btw_verlegd).toBe(false);
    // status blijft ongemoeid bij Opslaan (alleen Goedkeuren zet gecontroleerd)
    expect(payload.status).toBeUndefined();
    // betaalsemantiek: remaining_amount volgt de bestaande sync-regel
    expect(payload.remaining_amount).toBe(1210);
    expect(payload.due_date).toBe("2026-05-01");
  });

  it("24b. Goedkeuren behoudt de FK en zet alleen de status", async () => {
    renderDialog(makeInvoice({ grootboekrekening_id: "gb-8000" }));
    fireEvent.click(screen.getByRole("button", { name: /goedkeuren/i }));
    await waitFor(() => expect(onApproveSpy).toHaveBeenCalledTimes(1));
    expect(onApproveSpy.mock.calls[0][1]).toEqual(
      expect.objectContaining({ grootboekrekening_id: "gb-8000", status: "gecontroleerd" }),
    );
  });

  it("24c. verlegde BTW blijft ongewijzigd werken naast de FK", async () => {
    renderDialog(makeInvoice({ btw_verlegd: true, btw_amount: 0, btw_percentage: 0, grootboekrekening_id: "gb-8000" }));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(onSaveSpy).toHaveBeenCalledTimes(1));
    const payload = onSaveSpy.mock.calls[0][1];
    expect(payload.btw_verlegd).toBe(true);
    expect(payload.btw_amount).toBe(0);
    expect(payload.grootboekrekening_id).toBe("gb-8000");
  });
});
