/**
 * P5b — elk schrijfpad van een betaling in Bank.tsx loopt via de betaalschrijver.
 *
 * Per pad: de RPC krijgt de juiste argumenten; bij een weigering volgt één
 * zichtbare melding en GEEN enkele andere schrijfactie (geen eigen restant,
 * geen `betaald`, geen eigen matchvelden, geen koppelingsrij). De paden:
 * dialoog (koppelen en "extra factuur"), ontkoppelen (rij en bulk), codering
 * ongedaan maken, "✓ Bevestig", bulk bevestigen, automatisch voorstellen + undo,
 * Verwerken, bulk coderen van een gekoppelde regel, en een oude match
 * vastleggen. Wat de database daarmee doet, bewijst het DB-harnas.
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

const s = vi.hoisted(() => ({
  transactions: [] as any[],
  purchases: [] as any[],
  sales: [] as any[],
  allocations: [] as any[],
  updateTxCalls: [] as any[],
  updateTxError: null as Error | null,
  /** De database-toestand van de matchvelden, voor de compare-and-set (H-1/H-2). */
  db: new Map<string, { match_status: string; matched_invoice_id: string | null }>(),
  linkCalls: [] as any[],
  unlinkCalls: [] as any[],
  linkError: null as Error | null,
  unlinkErrors: new Map<string, Error>(),
  toasts: [] as any[],
  dialog: { invoiceId: "S1", invoiceType: "verkoop", amount: 30 },
  verwerk: { txId: "", invoiceId: "", invoiceType: "verkoop", outcome: "" },
}));

const makeTx = (over: Partial<any> = {}) => ({
  id: "tx-1", client_id: "c1", organization_id: "org-1", transaction_date: "2026-01-10",
  description: "Betaling factuur", reference: null, counter_account: null, counter_account_name: null,
  amount: 100, match_status: "niet_gematcht", match_confidence: null, matched_invoice_id: null,
  matched_invoice_type: null, grootboekrekening_id: null, ledger_account: null, notes: null,
  __candidate: null, ...over,
});
const makeSale = (id: string, over: Partial<any> = {}) => ({
  id, client_id: "c1", organization_id: "org-1", customer_name: "Klant", invoice_number: id, invoice_date: "2026-01-01",
  amount_excl: 100, btw_amount: 0, amount_incl: 100, btw_percentage: 0, remaining_amount: 100, status: "gecontroleerd", ...over,
});
const makePurchase = (id: string, over: Partial<any> = {}) => ({
  id, client_id: "c1", organization_id: "org-1", supplier: "Leverancier", invoice_number: id, invoice_date: "2026-01-01",
  amount_excl: 100, btw_amount: 0, amount_incl: 100, btw_percentage: 0, remaining_amount: 100, status: "gecontroleerd", ...over,
});

vi.mock("@/hooks/useBankPaymentLink", () => ({
  useBankPaymentLink: () => ({
    link: async (input: any) => {
      s.linkCalls.push(input);
      if (s.linkError) throw s.linkError;
      return { allocationId: `a-${input.bankTransactionId}`, outcome: "created", invoiceRemaining: 70,
               invoiceStatus: "gecontroleerd", txMatchStatus: "gematcht", replayed: false };
    },
    unlink: async (input: any) => {
      s.unlinkCalls.push(input);
      const e = s.unlinkErrors.get(input.bankTransactionId);
      if (e) throw e;
      return { outcome: "unlinked", removedCount: 1, txMatchStatus: "niet_gematcht", replayed: false };
    },
    refresh: async () => undefined,
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: (t: any) => { s.toasts.push(t); } }) }));
vi.mock("@/hooks/useBankMatchRejections", () => ({
  assertBankMatchNotRejected: vi.fn(async () => undefined),
  useBankMatchRejections: () => ({ data: [], isSuccess: true, isError: false }),
  useRecordBankMatchRejection: () => ({ mutateAsync: vi.fn(async () => undefined) }),
}));
vi.mock("@/hooks/useClientContext", () => ({ useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({ useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }) }));
vi.mock("@/hooks/useClients", () => ({ useClients: () => ({ data: [{ id: "c1", name: "Klant 1", btw_status: "btw_plichtig" }] }) }));
vi.mock("@/hooks/useBankTransactions", () => ({
  BANK_TRANSACTIONS_PAGE_SIZE: 50,
  isServerFilterableBankStatus: () => true,
  BANK_STATUS_MATCH_VALUES: { all: undefined, open: ["niet_gematcht", "suggestie"], gematcht: ["gematcht"], handmatig: ["handmatig_geboekt"] },
  bankSanitizeSearchTerm: (raw: string) => raw.trim(),
  fetchAllBankTransactions: vi.fn(async () => []),
  useBankTransactions: () => ({ data: s.transactions, isLoading: false, isError: false, refetch: vi.fn() }),
  usePaginatedBankTransactions: () => ({
    data: { transactions: s.transactions, total: s.transactions.length },
    isLoading: false, isFetching: false, isError: false, isPlaceholderData: false, refetch: vi.fn(),
  }),
  useAddBankTransaction: () => ({ mutateAsync: vi.fn() }),
  useUpdateBankTransaction: () => ({
    mutateAsync: async (args: any) => {
      s.updateTxCalls.push(args);
      if (s.updateTxError) throw s.updateTxError;
      // Zoals de echte hook: met `expected` alleen schrijven als de database nog
      // die toestand heeft; anders BankTransactionChangedError en niets gewijzigd.
      const row = s.db.get(args.id);
      if (row) {
        const { expected } = args;
        if (expected && (!expected.match_status.includes(row.match_status)
          || (expected.matched_invoice_id !== undefined && expected.matched_invoice_id !== row.matched_invoice_id))) {
          const { BankTransactionChangedError } = await import("@/lib/bank-transaction-cas");
          throw new BankTransactionChangedError();
        }
        if (args.match_status !== undefined) row.match_status = args.match_status;
        if (args.matched_invoice_id !== undefined) row.matched_invoice_id = args.matched_invoice_id;
      }
      return {};
    },
  }),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({ data: s.purchases, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useSalesInvoices", () => ({
  useSalesInvoices: () => ({ data: s.sales, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useBankTransactionAllocations", () => ({
  useBankTransactionAllocations: () => ({ data: s.allocations }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({ useActiveGrootboekrekeningen: () => ({ data: [] }) }));
vi.mock("@/hooks/useBookingTemplates", () => ({ useBookingTemplates: () => ({ data: [] }) }));
vi.mock("@/hooks/useVraagposten", () => ({ useVraagposten: () => ({ data: [] }), useCreateVraagpost: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/hooks/useBankLedgerStatus", () => ({ useBankLedgerStatus: () => ({ data: undefined }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/components/BankMatchDialog", async () => {
  const React = await import("react");
  return {
    BankMatchDialog: (p: any) => (p.open && p.transaction
      ? React.createElement(React.Fragment, null,
          React.createElement("button", {
            onClick: () => p.onConfirm(p.transaction.id, s.dialog.invoiceId, s.dialog.invoiceType, false, false, null, s.dialog.amount),
          }, "dialoog-koppelen"),
          React.createElement("button", {
            onClick: () => p.onManualBook(p.transaction.id, "4700 Kantoorkosten", "", "acc-4700", 21),
          }, "dialoog-coderen"))
      : null),
    rankCandidates: (tx: any) => {
      if (tx.__candidate === null || tx.__candidate === undefined) {
        if (!tx.__candidates) return [];
      }
      const overs: any[] = tx.__candidates ?? [tx.__candidate];
      return overs.map((over, i) => ({
        id: over.id ?? (i === 0 ? `inv-${tx.id}` : `inv-${tx.id}-${i}`),
        type: over.type ?? (tx.amount >= 0 ? "verkoop" : "inkoop"),
        name: "Klant 1", invoiceNumber: "F-1", amount: over.amount ?? Math.abs(tx.amount),
        score: over.score ?? 100, isPartialPayment: over.isPartialPayment ?? false,
        reasons: [], date: "2026-01-01", remainingAmount: null,
      }));
    },
  };
});
vi.mock("@/components/VerwerkingsScherm", async () => {
  const React = await import("react");
  return {
    VerwerkingsScherm: (p: any) => {
      const done = (pr: Promise<void>) => pr.then(() => { s.verwerk.outcome = "ok"; }, (e: Error) => { s.verwerk.outcome = `fout: ${e.message}`; });
      return p.open
        ? React.createElement(React.Fragment, null,
            React.createElement("button", {
              onClick: () => done(p.onMatchInvoice(s.verwerk.txId, s.verwerk.invoiceId, s.verwerk.invoiceType)),
            }, "verwerk-koppelen"),
            React.createElement("button", { onClick: () => done(p.onBookPrivate(s.verwerk.txId)) }, "verwerk-prive"),
            React.createElement("button", { onClick: () => done(p.onBookLedger(s.verwerk.txId, "4700 Kantoorkosten", "acc-4700", 21)) }, "verwerk-coderen"))
        : null;
    },
  };
});
vi.mock("@/components/GrootboekCombobox", async () => {
  const React = await import("react");
  return {
    GrootboekCombobox: (p: any) => React.createElement("button", {
      onClick: () => { p.onValueChange("4700 Kantoorkosten"); p.onIdChange?.("acc-4700"); },
    }, "kies-rekening"),
  };
});
vi.mock("@/components/bank/BtwKeuzeSelect", async () => {
  const React = await import("react");
  return { BtwKeuzeSelect: (p: any) => React.createElement("button", { onClick: () => p.onValueChange("21") }, "kies-btw") };
});
vi.mock("@/components/bank/BankTransactionDetailSheet", async () => {
  const React = await import("react");
  return {
    BankTransactionDetailSheet: (p: any) => (p.open && p.transaction
      ? React.createElement(React.Fragment, null,
          React.createElement("button", { onClick: () => p.onRejectSuggestion(p.transaction) }, "paneel-afwijzen"),
          React.createElement("button", { onClick: () => p.onUnlink(p.transaction) }, "paneel-ontkoppelen"),
          React.createElement("button", { onClick: () => p.onMaakVraagpost(p.transaction) }, "paneel-vraagpost"))
      : null),
  };
});
vi.mock("@/components/BankStatementUploadDialog", () => ({ BankStatementUploadDialog: () => null }));
vi.mock("@/components/BankAfletteringDrawer", () => ({ BankAfletteringDrawer: () => null }));
vi.mock("@/components/CreateVraagpostDialog", () => ({ CreateVraagpostDialog: () => null }));
vi.mock("@/components/ClientMultiSelect", () => ({ ClientMultiSelect: () => null }));

import Bank from "@/pages/Bank";
import { BankPaymentError } from "@/lib/bank-payment-link";
import { BANK_TX_NOT_LINKED_STATUSES } from "@/lib/bank-transaction-cas";
import { supabase } from "@/integrations/supabase/client";

function renderBank() {
  render((<MemoryRouter initialEntries={["/bank"]}><Bank /></MemoryRouter>) as ReactNode as any);
}
const unlinkIconButton = () => document.querySelector("svg.lucide-unlink")?.closest("button") as HTMLButtonElement;
const lastToast = () => s.toasts.at(-1);

beforeEach(() => {
  s.transactions = [];
  s.purchases = [];
  s.sales = [];
  s.allocations = [];
  s.updateTxCalls = [];
  s.updateTxError = null;
  s.db = new Map();
  s.linkCalls = [];
  s.unlinkCalls = [];
  s.linkError = null;
  s.unlinkErrors = new Map();
  s.toasts = [];
  s.dialog = { invoiceId: "S1", invoiceType: "verkoop", amount: 30 };
  s.verwerk = { txId: "", invoiceId: "", invoiceType: "verkoop", outcome: "" };
});

describe("Bank — koppelen via de betaalschrijver", () => {
  it("dialoog: één RPC met het gekozen bedrag; de melding komt uit het antwoord; geen eigen write", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: 100 })];
    s.sales = [makeSale("S1")];
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: "Koppel" }));
    fireEvent.click(await screen.findByRole("button", { name: "dialoog-koppelen" }));
    await waitFor(() => expect(s.linkCalls).toHaveLength(1));
    expect(s.linkCalls[0]).toEqual({ bankTransactionId: "tx-1", invoiceType: "verkoop", invoiceId: "S1", amount: 30 });
    await waitFor(() => expect(lastToast()?.title).toBe("Deelbetaling gekoppeld"));
    expect(lastToast()?.description).toMatch(/70/);
    expect(s.updateTxCalls).toEqual([]);
  });

  it("dialoog: een weigering geeft één zichtbare fout en verder niets", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: 100 })];
    s.sales = [makeSale("S1")];
    s.linkError = new BankPaymentError("Openstaand bedrag wijkt af van de koppelingen; herstel nodig", "23514");
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: "Koppel" }));
    fireEvent.click(await screen.findByRole("button", { name: "dialoog-koppelen" }));
    await waitFor(() => expect(lastToast()?.variant).toBe("destructive"));
    expect(lastToast()).toMatchObject({ title: "Fout bij koppelen", description: "Openstaand bedrag wijkt af van de koppelingen; herstel nodig" });
    expect(s.toasts.filter((t) => t.variant === "destructive")).toHaveLength(1);
    expect(s.updateTxCalls).toEqual([]);
  });

  it("✓ Bevestig: koppelt de veilige topkandidaat voor het bedrag van de bankregel", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: -100, match_status: "suggestie", matched_invoice_id: "inv-tx-1", __candidate: {} })];
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: "✓ Bevestig" }));
    await waitFor(() => expect(s.linkCalls).toHaveLength(1));
    expect(s.linkCalls[0]).toEqual({ bankTransactionId: "tx-1", invoiceType: "inkoop", invoiceId: "inv-tx-1", amount: 100 });
    expect(s.updateTxCalls).toEqual([]);
  });

  it("gelijke topscore is niet veilig (C-04): geen ✓ Bevestig, geen koppeling", async () => {
    s.transactions = [makeTx({
      id: "tx-1", amount: -100, match_status: "suggestie", matched_invoice_id: "inv-tx-1",
      __candidates: [{ score: 100 }, { score: 100 }],
    })];
    renderBank();
    expect(await screen.findByRole("button", { name: "Controleer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "✓ Bevestig" })).toBeNull();
    expect(s.linkCalls).toEqual([]);
  });

  it("bulk bevestigen: een factuur die in de reeks al een betaling kreeg, valt voor de rest af", async () => {
    s.transactions = [
      makeTx({ id: "tx-a", amount: -100, __candidate: { id: "inv-gedeeld" } }),
      makeTx({ id: "tx-b", amount: -100, transaction_date: "2026-01-11", __candidate: { id: "inv-gedeeld" } }),
    ];
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: /Selecteer alle veilige matches \(2\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Veilige matches bevestigen \(2\)/ }));
    await waitFor(() => expect(lastToast()?.title).toBe("Matches deels bevestigd"));
    expect(s.linkCalls).toHaveLength(1);
    expect(s.linkCalls[0].invoiceId).toBe("inv-gedeeld");
  });

  it("automatisch voorstellen koppelt veilig via de schrijver; undo ontkoppelt precies die koppeling", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: -100, __candidate: {} })];
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: /Automatisch voorstellen/ }));
    await waitFor(() => expect(s.linkCalls).toHaveLength(1));
    expect(s.linkCalls[0]).toEqual({ bankTransactionId: "tx-1", invoiceType: "inkoop", invoiceId: "inv-tx-1", amount: 100 });
    fireEvent.click(await screen.findByRole("button", { name: /Undo laatste batch \(1\)/ }));
    await waitFor(() => expect(s.unlinkCalls).toHaveLength(1));
    expect(s.unlinkCalls[0]).toEqual({ bankTransactionId: "tx-1", allocationId: "a-tx-1" });
    expect(s.updateTxCalls).toEqual([]);
  });

  it("Verwerken: bedrag = wat er op de transactie nog niet is verdeeld, begrensd door wat er op de factuur openstaat", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: 100 })];
    s.allocations = [{ id: "a-0", bank_transaction_id: "tx-1", invoice_type: "verkoop", invoice_id: "S0", client_id: "c1", amount: 20 }];
    s.sales = [makeSale("S1", { amount_incl: 100, remaining_amount: 50 })];
    s.verwerk = { txId: "tx-1", invoiceId: "S1", invoiceType: "verkoop", outcome: "" };
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: /^Verwerken/ }));
    fireEvent.click(await screen.findByRole("button", { name: "verwerk-koppelen" }));
    await waitFor(() => expect(s.verwerk.outcome).toBe("ok"));
    expect(s.linkCalls).toEqual([{ bankTransactionId: "tx-1", invoiceType: "verkoop", invoiceId: "S1", amount: 50 }]);
    expect(s.updateTxCalls).toEqual([]);
  });

  it("Verwerken: een weigering gaat terug naar het verwerkscherm (één melding daar), zonder andere write", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: 100 })];
    s.sales = [makeSale("S1")];
    s.verwerk = { txId: "tx-1", invoiceId: "S1", invoiceType: "verkoop", outcome: "" };
    s.linkError = new BankPaymentError("Betalingen koppelen is nog niet beschikbaar: de database-update ontbreekt. Er is niets gewijzigd.", "PGRST202", true);
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: /^Verwerken/ }));
    fireEvent.click(await screen.findByRole("button", { name: "verwerk-koppelen" }));
    await waitFor(() => expect(s.verwerk.outcome).toMatch(/^fout: Betalingen koppelen is nog niet beschikbaar/));
    expect(s.updateTxCalls).toEqual([]);
    expect(s.toasts).toEqual([]);
  });

  it("oude match vastleggen: gematcht zonder koppeling → koppelen aan de eigen match, bedrag ≤ wat de koppelingen openlaten", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: -100, match_status: "gematcht", matched_invoice_id: "P1" })];
    s.purchases = [makePurchase("P1", { amount_incl: 80, remaining_amount: 0 })];
    renderBank();
    const row = (await screen.findAllByRole("checkbox")).at(-1)!;
    fireEvent.click(row);
    fireEvent.click(await screen.findByRole("button", { name: /Oude match vastleggen \(1\)/ }));
    await waitFor(() => expect(s.linkCalls).toHaveLength(1));
    expect(s.linkCalls[0]).toEqual({ bankTransactionId: "tx-1", invoiceType: "inkoop", invoiceId: "P1", amount: 80 });
    expect(s.updateTxCalls).toEqual([]);
  });
});

describe("Bank — ontkoppelen via de betaalschrijver", () => {
  it("rij: één unlink-RPC, geen eigen restant- of matchwrite", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: 100, match_status: "gematcht", matched_invoice_id: "S1" })];
    s.allocations = [{ id: "a-1", bank_transaction_id: "tx-1", invoice_type: "verkoop", invoice_id: "S1", client_id: "c1", amount: 100 }];
    s.sales = [makeSale("S1", { remaining_amount: 0, status: "betaald" })];
    renderBank();
    await waitFor(() => expect(unlinkIconButton()).toBeTruthy());
    fireEvent.click(unlinkIconButton());
    await waitFor(() => expect(s.unlinkCalls).toEqual([{ bankTransactionId: "tx-1" }]));
    await waitFor(() => expect(lastToast()?.title).toBe("Koppeling verwijderd"));
    expect(s.updateTxCalls).toEqual([]);
  });

  it("rij: een weigering (bv. geboekte aflettering) is één zichtbare fout, verder niets", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: 100, match_status: "gematcht", matched_invoice_id: "S1" })];
    s.unlinkErrors.set("tx-1", new BankPaymentError("Deze koppeling is al als aflettering in het grootboek geboekt", "23514"));
    renderBank();
    await waitFor(() => expect(unlinkIconButton()).toBeTruthy());
    fireEvent.click(unlinkIconButton());
    await waitFor(() => expect(lastToast()?.variant).toBe("destructive"));
    expect(lastToast()).toMatchObject({ title: "Fout bij ontkoppelen", description: "Deze koppeling is al als aflettering in het grootboek geboekt" });
    expect(s.updateTxCalls).toEqual([]);
  });

  it("codering ongedaan maken: een fout wordt zichtbaar (A1-18), en het is geen betaalpad", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: 100, match_status: "handmatig_geboekt", grootboekrekening_id: "acc" })];
    s.updateTxError = new Error("Deze banktransactie is vrijgegeven");
    renderBank();
    await waitFor(() => expect(unlinkIconButton()).toBeTruthy());
    fireEvent.click(unlinkIconButton());
    await waitFor(() => expect(lastToast()?.variant).toBe("destructive"));
    expect(lastToast()?.description).toBe("Deze banktransactie is vrijgegeven");
    expect(s.unlinkCalls).toEqual([]);
  });

  it("bulk: per regel een unlink-RPC; een gedeeltelijke mislukking is één melding met de eerste fout", async () => {
    s.transactions = [
      makeTx({ id: "tx-1", amount: 100, match_status: "gematcht", matched_invoice_id: "S1" }),
      makeTx({ id: "tx-2", amount: 50, transaction_date: "2026-01-11", match_status: "gematcht", matched_invoice_id: "S2" }),
    ];
    s.unlinkErrors.set("tx-2", new BankPaymentError("herstel nodig", "23514"));
    renderBank();
    const boxes = await screen.findAllByRole("checkbox");
    fireEvent.click(boxes.at(-1)!);
    fireEvent.click(boxes.at(-2)!);
    fireEvent.click(await screen.findByRole("button", { name: /Ontkoppel geselecteerde/ }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Ontkoppelen" }));
    await waitFor(() => expect(s.unlinkCalls).toHaveLength(2));
    await waitFor(() => expect(lastToast()?.variant).toBe("destructive"));
    expect(lastToast()).toMatchObject({ title: "1 transactie(s) ontkoppeld, 1 niet ontkoppeld", description: "herstel nodig" });
    expect(s.toasts.filter((t) => /ontkoppeld/.test(t.title ?? ""))).toHaveLength(1);
    expect(s.updateTxCalls).toEqual([]);
  });

  it("bulk coderen van een gekoppelde regel: eerst bevestigen, dan ontkoppelen via de schrijver, pas dan coderen", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: 100, match_status: "gematcht", matched_invoice_id: "S1" })];
    s.allocations = [{ id: "a-1", bank_transaction_id: "tx-1", invoice_type: "verkoop", invoice_id: "S1", client_id: "c1", amount: 100 }];
    const confirm = vi.spyOn(window, "confirm");
    renderBank();
    fireEvent.click((await screen.findAllByRole("checkbox")).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: "kies-rekening" }));
    fireEvent.click(await screen.findByRole("button", { name: "kies-btw" }));

    confirm.mockReturnValueOnce(false);
    fireEvent.click(await screen.findByTestId("bulk-book-button"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(s.unlinkCalls).toEqual([]);
    expect(s.updateTxCalls).toEqual([]);

    confirm.mockReturnValueOnce(true);
    fireEvent.click(await screen.findByTestId("bulk-book-button"));
    await waitFor(() => expect(s.updateTxCalls).toHaveLength(1));
    expect(s.unlinkCalls).toEqual([{ bankTransactionId: "tx-1" }]);
    expect(s.updateTxCalls[0]).toMatchObject({ id: "tx-1", match_status: "handmatig_geboekt", btw_percentage: 21, matched_invoice_id: null });
    confirm.mockRestore();
  });

  it("bulk coderen: weigert de schrijver het ontkoppelen, dan wordt die regel ook niet gecodeerd", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: 100, match_status: "gematcht", matched_invoice_id: "S1" })];
    s.unlinkErrors.set("tx-1", new BankPaymentError("herstel nodig", "23514"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderBank();
    fireEvent.click((await screen.findAllByRole("checkbox")).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: "kies-rekening" }));
    fireEvent.click(await screen.findByRole("button", { name: "kies-btw" }));
    fireEvent.click(await screen.findByTestId("bulk-book-button"));
    await waitFor(() => expect(lastToast()?.variant).toBe("destructive"));
    expect(lastToast()).toMatchObject({ title: "Coderen is niet gelukt", description: "herstel nodig" });
    expect(s.updateTxCalls).toEqual([]);
    confirm.mockRestore();
  });
});

describe("Bank — compare-and-set op de matchvelden (review P5 H-1, H-2)", () => {
  it("H-1: undo van een suggestie die intussen is bevestigd (gekoppeld), laat de regel staan en meldt dat", async () => {
    // Een onzekere kandidaat (deelbetaling): automatisch voorstellen zet een suggestie klaar.
    s.transactions = [makeTx({ id: "tx-1", amount: -60, __candidate: { id: "P1", score: 80, isPartialPayment: true, amount: 100 } })];
    s.db.set("tx-1", { match_status: "niet_gematcht", matched_invoice_id: null });
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: /Automatisch voorstellen/ }));
    await waitFor(() => expect(s.db.get("tx-1")).toEqual({ match_status: "suggestie", matched_invoice_id: "P1" }));
    expect(s.linkCalls).toEqual([]);
    // Intussen: ✓ Bevestig (of een ander tabblad) koppelt via de betaalschrijver.
    s.db.set("tx-1", { match_status: "gematcht", matched_invoice_id: "P1" });
    fireEvent.click(await screen.findByRole("button", { name: /Undo laatste batch \(1\)/ }));
    await waitFor(() => expect(lastToast()?.title).toBe("Laatste batch teruggedraaid"));
    expect(s.updateTxCalls.at(-1)).toMatchObject({ id: "tx-1", expected: { match_status: ["suggestie"], matched_invoice_id: "P1" } });
    expect(s.db.get("tx-1")).toEqual({ match_status: "gematcht", matched_invoice_id: "P1" });
    expect(lastToast()?.description).toMatch(/0 transactie\(s\) hersteld · 1 overgeslagen: intussen gewijzigd/);
  });

  it("H-1: undo van een ongewijzigde suggestie draait haar gewoon terug", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: -60, __candidate: { id: "P1", score: 80, isPartialPayment: true, amount: 100 } })];
    s.db.set("tx-1", { match_status: "niet_gematcht", matched_invoice_id: null });
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: /Automatisch voorstellen/ }));
    await waitFor(() => expect(s.db.get("tx-1")?.match_status).toBe("suggestie"));
    fireEvent.click(await screen.findByRole("button", { name: /Undo laatste batch \(1\)/ }));
    await waitFor(() => expect(s.db.get("tx-1")).toEqual({ match_status: "niet_gematcht", matched_invoice_id: null }));
    expect(lastToast()?.description).toBe("1 transactie(s) hersteld");
  });

  it("H-2: coderen met een verouderde cache (regel is intussen gekoppeld) schrijft niets en meldt het", async () => {
    // Het scherm denkt "open"; in de database heeft een ander tabblad al gekoppeld.
    s.transactions = [makeTx({ id: "tx-1", amount: 100 })];
    s.db.set("tx-1", { match_status: "gematcht", matched_invoice_id: "S1" });
    renderBank();
    fireEvent.click((await screen.findAllByRole("checkbox")).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: "kies-rekening" }));
    fireEvent.click(await screen.findByRole("button", { name: "kies-btw" }));
    fireEvent.click(await screen.findByTestId("bulk-book-button"));
    await waitFor(() => expect(lastToast()?.variant).toBe("destructive"));
    expect(s.updateTxCalls[0].expected.match_status).not.toContain("gematcht");
    expect(s.db.get("tx-1")).toEqual({ match_status: "gematcht", matched_invoice_id: "S1" });
    expect(lastToast()?.description).toMatch(/intussen gewijzigd.*niets gewijzigd/);
  });

  it("H-2: codering ongedaan maken alleen vanuit handmatig_geboekt; afwijzen alleen van precies deze suggestie", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: 100, match_status: "handmatig_geboekt", grootboekrekening_id: "acc" })];
    s.db.set("tx-1", { match_status: "gematcht", matched_invoice_id: "S1" });
    renderBank();
    await waitFor(() => expect(unlinkIconButton()).toBeTruthy());
    fireEvent.click(unlinkIconButton());
    await waitFor(() => expect(lastToast()?.variant).toBe("destructive"));
    expect(s.updateTxCalls[0]).toMatchObject({ expected: { match_status: ["handmatig_geboekt"] } });
    expect(s.db.get("tx-1")?.match_status).toBe("gematcht");
  });
});

describe("Bank — keuzeregels van automatisch voorstellen (review P5 H-4)", () => {
  it("gelijke topscore (C-04): automatisch voorstellen koppelt niet", async () => {
    s.transactions = [makeTx({ id: "tx-1", amount: -100, __candidates: [{ id: "P1", score: 100 }, { id: "P2", score: 100 }] })];
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: /Automatisch voorstellen/ }));
    await waitFor(() => expect(lastToast()?.title).toBe("Automatisch voorstellen klaar"));
    expect(s.linkCalls).toEqual([]);
  });

  it("twee regels op één factuur: automatisch voorstellen koppelt er maar één", async () => {
    s.transactions = [
      makeTx({ id: "tx-a", amount: -100, __candidate: { id: "inv-gedeeld" } }),
      makeTx({ id: "tx-b", amount: -100, transaction_date: "2026-01-11", __candidate: { id: "inv-gedeeld" } }),
    ];
    renderBank();
    fireEvent.click(await screen.findByRole("button", { name: /Automatisch voorstellen/ }));
    await waitFor(() => expect(lastToast()?.title).toBe("Automatisch voorstellen klaar"));
    expect(s.linkCalls).toHaveLength(1);
    expect(s.linkCalls[0].invoiceId).toBe("inv-gedeeld");
  });
});

/**
 * Review P5-APP-b R-1: per handler die match_status rechtstreeks schrijft, de
 * meegestuurde verwachting (compare-and-set). In de database staat telkens een
 * andere toestand dan het scherm denkt (een ander tabblad koppelde al): de
 * verwachting moet exact kloppen én de database blijft ongemoeid. Wie bij één
 * handler de controle weghaalt, maakt die rij rood.
 */
describe("Bank — elke directe matchwrite stuurt zijn verwachte toestand mee (R-1)", () => {
  const NOT_LINKED = { match_status: BANK_TX_NOT_LINKED_STATUSES };
  const SUGGESTIE_S1 = { match_status: ["suggestie"], matched_invoice_id: "S1" };
  const CODED = { match_status: ["handmatig_geboekt"] };
  const suggestionTx = () => makeTx({ id: "tx-1", amount: 100, match_status: "suggestie", matched_invoice_id: "S1", __candidate: { id: "S1" } });
  const openTx = () => makeTx({ id: "tx-1", amount: 100 });
  const codedTx = () => makeTx({ id: "tx-1", amount: 100, match_status: "handmatig_geboekt", grootboekrekening_id: "acc" });
  const openRow = async () => {
    const row = (await screen.findAllByText("Betaling factuur")).map((el) => el.closest("tr")).find(Boolean);
    expect(row).toBeTruthy();
    fireEvent.click(row!);
  };
  const selectRow = async () => fireEvent.click((await screen.findAllByRole("checkbox")).at(-1)!);

  const cases: Array<[string, () => any, any, () => Promise<void>]> = [
    ["afwijzen (rij)", suggestionTx, SUGGESTIE_S1, async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Afwijzen" }));
    }],
    ["afwijzen (detailpaneel)", suggestionTx, SUGGESTIE_S1, async () => {
      await openRow();
      fireEvent.click(await screen.findByRole("button", { name: "paneel-afwijzen" }));
    }],
    ["suggesties afwijzen (bulk)", suggestionTx, SUGGESTIE_S1, async () => {
      await selectRow();
      fireEvent.click(await screen.findByRole("button", { name: /Suggesties afwijzen \(1\)/ }));
    }],
    ["handmatig coderen (dialoog)", openTx, NOT_LINKED, async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Koppel" }));
      fireEvent.click(await screen.findByRole("button", { name: "dialoog-coderen" }));
    }],
    ["Verwerken: privé", openTx, NOT_LINKED, async () => {
      s.verwerk.txId = "tx-1";
      fireEvent.click(await screen.findByRole("button", { name: /^Verwerken/ }));
      fireEvent.click(await screen.findByRole("button", { name: "verwerk-prive" }));
    }],
    ["Verwerken: coderen", openTx, NOT_LINKED, async () => {
      s.verwerk.txId = "tx-1";
      fireEvent.click(await screen.findByRole("button", { name: /^Verwerken/ }));
      fireEvent.click(await screen.findByRole("button", { name: "verwerk-coderen" }));
    }],
    ["bulk coderen", openTx, NOT_LINKED, async () => {
      await selectRow();
      fireEvent.click(await screen.findByRole("button", { name: "kies-rekening" }));
      fireEvent.click(await screen.findByRole("button", { name: "kies-btw" }));
      fireEvent.click(await screen.findByTestId("bulk-book-button"));
    }],
    ["vraagpost (detailpaneel)", openTx, NOT_LINKED, async () => {
      await openRow();
      fireEvent.click(await screen.findByRole("button", { name: "paneel-vraagpost" }));
    }],
    ["automatisch voorstellen: suggestie klaarzetten", () => makeTx({ id: "tx-1", amount: -60, __candidate: { id: "P1", score: 80, isPartialPayment: true, amount: 100 } }),
      { match_status: ["niet_gematcht"], matched_invoice_id: null }, async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Automatisch voorstellen/ }));
    }],
    ["codering ongedaan maken (rij)", codedTx, CODED, async () => {
      await waitFor(() => expect(unlinkIconButton()).toBeTruthy());
      fireEvent.click(unlinkIconButton());
    }],
    ["codering ongedaan maken (detailpaneel)", codedTx, CODED, async () => {
      await openRow();
      fireEvent.click(await screen.findByRole("button", { name: "paneel-ontkoppelen" }));
    }],
    ["codering ongedaan maken (bulk ontkoppelen)", codedTx, CODED, async () => {
      await selectRow();
      // Eén regel: zonder bevestigingsdialoog.
      fireEvent.click(await screen.findByRole("button", { name: /Ontkoppel geselecteerde/ }));
    }],
  ];

  it.each(cases)("%s", async (_name, makeRow, expected, act) => {
    const row = makeRow();
    s.transactions = [row];
    s.sales = [makeSale("S1")];
    // Wat de database werkelijk heeft: intussen gekoppeld (een ander tabblad).
    s.db.set(row.id, { match_status: "gematcht", matched_invoice_id: "X9" });
    const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { id: "vp-1" }, error: null }) };
    vi.mocked(supabase.from).mockReturnValue(chain);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderBank();
    await act();
    await waitFor(() => expect(s.updateTxCalls.length).toBeGreaterThan(0));
    expect(s.updateTxCalls.at(-1)).toMatchObject({ id: row.id, expected });
    expect(s.updateTxCalls.at(-1).expected).toEqual(expected);
    expect(s.db.get(row.id)).toEqual({ match_status: "gematcht", matched_invoice_id: "X9" });
    confirm.mockRestore();
  });
});
