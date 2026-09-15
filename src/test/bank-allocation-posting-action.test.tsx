import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Fase 6C-b5b — de "Boeken in grootboek"-actie per bankkoppeling.
 *
 * De component stuurt uitsluitend de koppeling-id naar public.post_bank_allocation();
 * alle hints hier zijn UX, de RPC herkeurt alles server-side.
 */

type Marker = { posting_group_id: string; created_at: string } & Record<string, string>;

// Per tabel het antwoord van from(<table>).select().eq().maybeSingle().
const state = {
  tables: {
    purchase_invoice_postings: null as Marker | null,
    sales_invoice_postings: null as Marker | null,
    bank_allocation_postings: null as Marker | null,
  } as Record<string, Marker | null>,
  clients: [] as Array<Record<string, unknown>>,
  // Per tabel een te simuleren PostgREST-fout (bv. 42P01 / PGRST205 zolang de
  // migratie nog niet op productie staat). null = geen fout.
  errors: {} as Record<string, { message: string; code?: string } | null>,
};

const { rpcSpy, toastSpy } = vi.hoisted(() => ({
  rpcSpy: vi.fn(async () => ({ data: "group-1", error: null as { message?: string } | null })),
  toastSpy: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/hooks/useClients", () => ({ useClients: () => ({ data: state.clients }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            state.errors[table]
              ? { data: null, error: state.errors[table] }
              : { data: state.tables[table] ?? null, error: null },
        }),
      }),
    }),
    rpc: rpcSpy,
  },
}));

import { BankAllocationPostingAction } from "@/components/BankAllocationPostingAction";

const fullClient = {
  id: "c-1",
  name: "Klant Een",
  organization_id: "org-1",
  bank_rekening_id: "gb-bank",
  debiteuren_rekening_id: "gb-deb",
  crediteuren_rekening_id: "gb-cred",
};

const makeAllocation = (over: Partial<any> = {}) => ({
  id: "alloc-1",
  bank_transaction_id: "tx-1",
  invoice_type: "verkoop" as const,
  invoice_id: "si-1",
  client_id: "c-1",
  amount: 1210,
  user_id: "u-1",
  created_at: "2027-04-15T00:00:00Z",
  updated_at: "2027-04-15T00:00:00Z",
  ...over,
});

const makeTransaction = (over: Partial<any> = {}) => ({
  id: "tx-1",
  user_id: "u-1",
  client_id: "c-1",
  organization_id: "org-1",
  amount: 1210,
  transaction_date: "2027-04-15",
  description: "Betaling",
  reference: null,
  counter_account: null,
  camt_ustrd: null,
  camt_addtl_ntry_inf: null,
  camt_counterparty_name: null,
  match_status: "gematcht",
  match_confidence: null,
  matched_invoice_id: null,
  grootboekrekening_id: null,
  ledger_account_id: null,
  created_at: "2027-04-15T00:00:00Z",
  updated_at: "2027-04-15T00:00:00Z",
  ...over,
});

const posted = (id: string): Marker => ({ posting_group_id: "g-" + id, created_at: "2027-04-01T00:00:00Z" });

function renderAction(allocation: any = makeAllocation(), transaction: any = makeTransaction()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <BankAllocationPostingAction allocation={allocation} transaction={transaction} />
    </QueryClientProvider>,
  );
  return { queryClient, invalidateSpy };
}

const button = () => screen.getByTestId("bank-posting-button") as HTMLButtonElement;
const hint = () => screen.getByTestId("bank-posting-hint");

beforeEach(() => {
  rpcSpy.mockClear();
  rpcSpy.mockImplementation(async () => ({ data: "group-1", error: null }));
  toastSpy.mockClear();
  state.tables.purchase_invoice_postings = null;
  state.tables.sales_invoice_postings = posted("si-1");
  state.tables.bank_allocation_postings = null;
  state.clients = [fullClient];
});

describe("BankAllocationPostingAction", () => {
  it("1. eligible verkoop-koppeling → knop ingeschakeld, geen hint", async () => {
    renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(screen.queryByTestId("bank-posting-hint")).toBeNull();
    expect(screen.queryByTestId("bank-posting-done")).toBeNull();
  });

  it("2. eligible inkoop-koppeling op uitgaande transactie → knop ingeschakeld", async () => {
    state.tables.purchase_invoice_postings = posted("pi-1");
    state.tables.sales_invoice_postings = null;
    renderAction(
      makeAllocation({ invoice_type: "inkoop", invoice_id: "pi-1" }),
      makeTransaction({ amount: -1210 }),
    );
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it("3. al geboekt → 'Geboekt in het grootboek.' en geen knop", async () => {
    state.tables.bank_allocation_postings = posted("alloc-1");
    renderAction();
    await waitFor(() => expect(screen.getByTestId("bank-posting-done")).toHaveTextContent("Geboekt in het grootboek."));
    expect(screen.queryByTestId("bank-posting-button")).toBeNull();
  });

  it("4. bronfactuur niet geboekt → hint en uitgeschakelde knop", async () => {
    state.tables.sales_invoice_postings = null;
    renderAction();
    await waitFor(() => expect(hint()).toHaveTextContent("Boek eerst de factuur in het grootboek."));
    expect(button().disabled).toBe(true);
  });

  it("5. geen bankrekening (grootboek) → hint", async () => {
    state.clients = [{ ...fullClient, bank_rekening_id: null }];
    renderAction();
    await waitFor(() =>
      expect(hint()).toHaveTextContent("Geen bankrekening (grootboek) ingesteld voor deze administratie."),
    );
    expect(button().disabled).toBe(true);
  });

  it("6. verkoop zonder debiteurenrekening → hint", async () => {
    state.clients = [{ ...fullClient, debiteuren_rekening_id: null }];
    renderAction();
    await waitFor(() => expect(hint()).toHaveTextContent("Geen debiteurenrekening ingesteld."));
    expect(button().disabled).toBe(true);
  });

  it("7. inkoop zonder crediteurenrekening → hint", async () => {
    state.tables.purchase_invoice_postings = posted("pi-1");
    state.clients = [{ ...fullClient, crediteuren_rekening_id: null }];
    renderAction(
      makeAllocation({ invoice_type: "inkoop", invoice_id: "pi-1" }),
      makeTransaction({ amount: -1210 }),
    );
    await waitFor(() => expect(hint()).toHaveTextContent("Geen crediteurenrekening ingesteld."));
    expect(button().disabled).toBe(true);
  });

  it("8. richting past niet (verkoop op uitgaande, inkoop op inkomende) → hint", async () => {
    renderAction(makeAllocation(), makeTransaction({ amount: -1210 }));
    await waitFor(() =>
      expect(hint()).toHaveTextContent("Richting van de banktransactie past niet bij dit koppelingstype."),
    );
    expect(button().disabled).toBe(true);
  });

  it("9. inkoop op inkomende transactie → hint", async () => {
    state.tables.purchase_invoice_postings = posted("pi-1");
    renderAction(
      makeAllocation({ invoice_type: "inkoop", invoice_id: "pi-1" }),
      makeTransaction({ amount: 1210 }),
    );
    await waitFor(() =>
      expect(hint()).toHaveTextContent("Richting van de banktransactie past niet bij dit koppelingstype."),
    );
  });

  it("10. klik → rpc precies één keer met alleen de koppeling-id, succes-toast", async () => {
    renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(rpcSpy).toHaveBeenCalledTimes(1));
    expect(rpcSpy).toHaveBeenCalledWith("post_bank_allocation", { _allocation_id: "alloc-1" });
    expect(rpcSpy.mock.calls[0]).toHaveLength(2);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Aflettering geboekt" }));
  });

  it("11. rpc-fout → destructieve toast met de databasemelding", async () => {
    rpcSpy.mockImplementation(async () => ({
      data: null,
      error: { message: "Een verkoopkoppeling vereist een inkomende banktransactie" },
    }));
    renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Boeken niet gelukt",
        description: "Een verkoopkoppeling vereist een inkomende banktransactie",
        variant: "destructive",
      }),
    );
  });

  it("12. succes → precies de vier query keys geïnvalideerd", async () => {
    const { invalidateSpy } = renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    invalidateSpy.mockClear();
    fireEvent.click(button());
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Aflettering geboekt" }));
    const keys = invalidateSpy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual([
      JSON.stringify(["bank-allocation-posting", "alloc-1"]),
      JSON.stringify(["bank_transaction_allocations"]),
      JSON.stringify(["bank_transactions"]),
      JSON.stringify(["ledger-postings"]),
    ]);
  });

  it("13. rendert nooit een rpc-aanroep uit zichzelf (geen auto-post)", async () => {
    renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("14. claimtabel niet bevraagbaar (migratie nog niet toegepast) → knop uit, neutrale hint, geen rpc", async () => {
    // Deploy-venster: de frontend staat live vóór de migratie. PostgREST kent
    // bank_allocation_postings dan niet. "Weet ik niet" mag nooit als "niet
    // geboekt" worden behandeld, anders leidt een klik tot een rauwe
    // schema-cache-fout.
    state.errors.bank_allocation_postings = {
      message: "Could not find the table 'public.bank_allocation_postings' in the schema cache",
      code: "PGRST205",
    };
    renderAction();
    await waitFor(() =>
      expect(screen.getByTestId("bank-posting-hint")).toHaveTextContent(
        "Boeken in het grootboek is nog niet beschikbaar voor bankkoppelingen.",
      ),
    );
    expect(button().disabled).toBe(true);
    expect(screen.queryByTestId("bank-posting-done")).not.toBeInTheDocument();
    fireEvent.click(button());
    await new Promise((r) => setTimeout(r, 0));
    expect(rpcSpy).not.toHaveBeenCalled();
    state.errors.bank_allocation_postings = null;
  });
});
