import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Geen stille BTW bij het coderen van bankregels.
 *
 * post_bank_transaction() leest bank_transactions.btw_percentage en behandelt
 * NULL als 0%. Daarom moet de BTW bij elke codeer-ingang een expliciete,
 * verplichte keuze zijn (voorgevuld wanneer de rij er al een heeft).
 *
 * Radix Select is in jsdom niet goed te bedienen; BtwKeuzeSelect wordt hier
 * vervangen door een native <select>. De helpers worden daarom apart getest.
 */

const { rpcSpy, updateSpy, toastSpy } = vi.hoisted(() => ({
  rpcSpy: vi.fn(async () => ({ data: "group-1", error: null as { message?: string } | null })),
  updateSpy: vi.fn(async (_call: { table: string; values: Record<string, unknown> }) => ({
    error: null as { message?: string } | null,
  })),
  toastSpy: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }), toast: toastSpy }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
      update: (values: Record<string, unknown>) => ({
        eq: async () => updateSpy({ table, values }),
      }),
    }),
    rpc: rpcSpy,
  },
}));
vi.mock("@/components/GrootboekCombobox", () => ({
  GrootboekCombobox: ({ value, onValueChange, onIdChange }: any) => (
    <input
      data-testid="grootboek-input"
      value={value}
      onChange={(e) => {
        onValueChange(e.target.value);
        onIdChange?.(e.target.value ? "gb-" + e.target.value : "");
      }}
    />
  ),
}));
vi.mock("@/components/bank/BtwKeuzeSelect", async () => {
  const { BTW_KEUZE_OPTIES } = await import("@/lib/btw-keuze");
  return {
    BtwKeuzeSelect: ({ id, value, onValueChange, disabled }: any) => (
      <select
        id={id}
        data-testid="btw-keuze-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
      >
        <option value="">Kies BTW</option>
        {BTW_KEUZE_OPTIES.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    ),
  };
});

import { btwKeuzeFromPercentage, btwKeuzeToPercentage, BTW_KEUZE_OPTIES } from "@/lib/btw-keuze";
import { BankTransactionPostingAction } from "@/components/bank/BankTransactionPostingAction";
import { BankMatchDialog } from "@/components/BankMatchDialog";
import { VerwerkingsScherm } from "@/components/VerwerkingsScherm";

const makeTransaction = (over: Partial<any> = {}) => ({
  id: "tx-1",
  user_id: "u-1",
  client_id: "c-1",
  organization_id: "org-1",
  amount: -121,
  transaction_date: "2027-04-15",
  description: "Betaling kantoorartikelen",
  reference: null,
  counter_account: null,
  camt_ustrd: null,
  camt_addtl_ntry_inf: null,
  camt_counterparty_name: null,
  match_status: "handmatig_geboekt",
  match_confidence: null,
  matched_invoice_id: null,
  grootboekrekening_id: "gb-4000",
  ledger_account_id: null,
  btw_percentage: null,
  created_at: "2027-04-15T00:00:00Z",
  updated_at: "2027-04-15T00:00:00Z",
  ...over,
});

const btwSelect = () => screen.getByTestId("btw-keuze-select") as HTMLSelectElement;
const chooseBtw = (value: string) => fireEvent.change(btwSelect(), { target: { value } });

beforeEach(() => {
  rpcSpy.mockClear();
  rpcSpy.mockImplementation(async () => ({ data: "group-1", error: null }));
  updateSpy.mockClear();
  updateSpy.mockImplementation(async () => ({ error: null }));
  toastSpy.mockClear();
});

describe("BtwKeuzeSelect helpers", () => {
  it("biedt precies Geen BTW / 9% / 21%", () => {
    expect(BTW_KEUZE_OPTIES.map((o) => o.value)).toEqual(["0", "9", "21"]);
  });

  it("btwKeuzeFromPercentage: null/undefined/onbekend → '' (geen stille keuze)", () => {
    expect(btwKeuzeFromPercentage(null)).toBe("");
    expect(btwKeuzeFromPercentage(undefined)).toBe("");
    expect(btwKeuzeFromPercentage(6)).toBe("");
    expect(btwKeuzeFromPercentage(NaN)).toBe("");
    expect(btwKeuzeFromPercentage(0)).toBe("0");
    expect(btwKeuzeFromPercentage(9)).toBe("9");
    expect(btwKeuzeFromPercentage(21)).toBe("21");
  });

  it("btwKeuzeToPercentage: '' → null, '0' → 0 (expliciet), '21' → 21", () => {
    expect(btwKeuzeToPercentage("")).toBeNull();
    expect(btwKeuzeToPercentage("0")).toBe(0);
    expect(btwKeuzeToPercentage("9")).toBe(9);
    expect(btwKeuzeToPercentage("21")).toBe(21);
    expect(btwKeuzeToPercentage("foo")).toBeNull();
  });
});

describe("BankTransactionPostingAction", () => {
  function renderAction(transaction: any) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BankTransactionPostingAction transaction={transaction} allocationCount={0} />
      </QueryClientProvider>,
    );
  }
  const button = () => screen.getByRole("button", { name: /Boeken in grootboek/ }) as HTMLButtonElement;

  it("btw NULL → knop uit en hint 'kies BTW'; na 'Geen BTW' wordt expliciet 0 geboekt", async () => {
    renderAction(makeTransaction({ btw_percentage: null }));
    await waitFor(() => expect(screen.getByTestId("bank-transaction-posting-action")).toBeInTheDocument());
    expect(button().disabled).toBe(true);
    expect(screen.getByTestId("bank-transaction-posting-choose-vat")).toBeInTheDocument();
    expect(btwSelect().value).toBe("");

    chooseBtw("0");
    expect(screen.queryByTestId("bank-transaction-posting-choose-vat")).toBeNull();
    expect(button().disabled).toBe(false);
    fireEvent.click(button());

    await waitFor(() => expect(rpcSpy).toHaveBeenCalledWith("post_bank_transaction", { _transaction_id: "tx-1" }));
    expect(updateSpy).toHaveBeenCalledWith({ table: "bank_transactions", values: { btw_percentage: 0 } });
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Geboekt in het grootboek" }));
  });

  it("btw 21 opgeslagen → voorgevuld en knop aan", async () => {
    renderAction(makeTransaction({ btw_percentage: 21 }));
    await waitFor(() => expect(screen.getByTestId("bank-transaction-posting-action")).toBeInTheDocument());
    expect(btwSelect().value).toBe("21");
    expect(screen.queryByTestId("bank-transaction-posting-choose-vat")).toBeNull();
    expect(button().disabled).toBe(false);
  });
});

describe("BankMatchDialog — handmatig coderen", () => {
  function renderDialog(transaction: any, onManualBook = vi.fn()) {
    render(
      <BankMatchDialog
        open
        onOpenChange={vi.fn()}
        transaction={transaction}
        purchaseInvoices={[]}
        salesInvoices={[]}
        onConfirm={vi.fn()}
        onManualBook={onManualBook}
        rejectionIndex={new Set()}
      />,
    );
    // Radix Tabs activate on pointer/mouse down, not on click.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Handmatig coderen" }), { button: 0 });
    return onManualBook;
  }
  const submit = () => screen.getByTestId("manual-book-submit") as HTMLButtonElement;

  it("Coderen pas actief met rekening én BTW; onManualBook krijgt de BTW als 5e argument", async () => {
    const onManualBook = renderDialog(makeTransaction({ match_status: "niet_gematcht", grootboekrekening_id: null, description: null }));
    await waitFor(() => expect(submit()).toBeInTheDocument());
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByTestId("grootboek-input"), { target: { value: "4000 Kantoor" } });
    expect(submit().disabled).toBe(true); // rekening alleen is niet genoeg

    chooseBtw("21");
    expect(submit().disabled).toBe(false);

    // Zonder bankomschrijving mag een eigen omschrijving worden ingevuld.
    fireEvent.change(screen.getByPlaceholderText(/De bank gaf geen omschrijving/), { target: { value: "Pennen" } });
    fireEvent.click(submit());
    expect(onManualBook).toHaveBeenCalledWith("tx-1", "4000 Kantoor", "Pennen", "gb-4000 Kantoor", 21);
  });

  it("met bankomschrijving: geen invoerveld, omschrijving alleen-lezen en '' doorgegeven", async () => {
    const onManualBook = renderDialog(makeTransaction({ match_status: "niet_gematcht", grootboekrekening_id: null, btw_percentage: 0 }));
    await waitFor(() => expect(submit()).toBeInTheDocument());
    expect(screen.getByTestId("manual-book-bank-description")).toHaveTextContent("Betaling kantoorartikelen");
    expect(screen.queryByPlaceholderText(/De bank gaf geen omschrijving/)).toBeNull();
    // Voorgevuld uit de rij: een bewuste 0 blijft een bewuste 0.
    expect(btwSelect().value).toBe("0");

    fireEvent.change(screen.getByTestId("grootboek-input"), { target: { value: "4000 Kantoor" } });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    expect(onManualBook).toHaveBeenCalledWith("tx-1", "4000 Kantoor", "", "gb-4000 Kantoor", 0);
  });
});

describe("VerwerkingsScherm — grootboek", () => {
  const txs = [
    makeTransaction({ id: "tx-1", match_status: "niet_gematcht", grootboekrekening_id: null, btw_percentage: null }),
    makeTransaction({ id: "tx-2", match_status: "niet_gematcht", grootboekrekening_id: null, amount: -50, description: "Tweede" }),
  ];
  function renderScherm(onBookLedger: (...args: any[]) => Promise<void>) {
    render(
      <VerwerkingsScherm
        open
        onOpenChange={vi.fn()}
        transactions={txs as any}
        purchaseInvoices={[]}
        salesInvoices={[]}
        rejectionIndex={new Set()}
        onBookPrivate={vi.fn(async () => {})}
        onBookLedger={onBookLedger}
        onMatchInvoice={vi.fn(async () => {})}
        onSkip={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Grootboek/ }));
  }
  const submit = () => screen.getByTestId("verwerking-ledger-submit") as HTMLButtonElement;

  it("Coderen pas actief met rekening én BTW; onBookLedger krijgt de BTW en er wordt doorgegaan", async () => {
    const onBookLedger = vi.fn(async () => {});
    renderScherm(onBookLedger);
    expect(screen.getByText("1 van 2 transacties")).toBeInTheDocument();
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("grootboek-input"), { target: { value: "4000 Kantoor" } });
    expect(submit().disabled).toBe(true);
    chooseBtw("9");
    expect(submit().disabled).toBe(false);

    fireEvent.click(submit());
    await waitFor(() => expect(onBookLedger).toHaveBeenCalledWith("tx-1", "4000 Kantoor", "gb-4000 Kantoor", 9));
    await waitFor(() => expect(screen.getByText("2 van 2 transacties")).toBeInTheDocument());
  });

  it("onBookLedger weigert → blijft op dezelfde transactie", async () => {
    const onBookLedger = vi.fn(async () => { throw new Error("nee"); });
    renderScherm(onBookLedger);
    fireEvent.change(screen.getByTestId("grootboek-input"), { target: { value: "4000 Kantoor" } });
    chooseBtw("21");
    fireEvent.click(submit());
    await waitFor(() => expect(onBookLedger).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(submit().disabled).toBe(false)); // loading afgelopen
    expect(screen.getByText("1 van 2 transacties")).toBeInTheDocument();
    expect(screen.getByTestId("verwerking-ledger-submit")).toBeInTheDocument(); // nog in grootboek-modus
  });
});
