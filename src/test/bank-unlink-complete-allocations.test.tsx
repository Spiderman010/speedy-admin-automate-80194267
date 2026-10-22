/**
 * Nulmeting F3 / E-08 / C-02 — ontkoppelen bij meer dan max_rows koppelingen.
 *
 * F3 liet zien (`repro/F3/bank-unlink-truncated-allocations.test.tsx`) dat de
 * echte ontkoppelketen van Bank.tsx met een afgekapte koppelingenlijst een
 * verkeerd restant schrijft (S1 € 100 i.p.v. € 70) en S2 op "betaald" laat
 * staan. Hier draait dezelfde keten met de ECHTE `useBankTransactionAllocations`
 * tegen een emulator die net als PostgREST op 1000 rijen afkapt: de invoer van
 * de herberekening is nu volledig, en de herberekening komt daardoor uit op
 * S1 → 70 en S2 → 50.
 *
 * Het schrijfpad is sinds P5 de betaalschrijver: ontkoppelen is één aanroep van
 * unlink_bank_payment, en de database herberekent het restant uit ALLE
 * koppelingen (onder grendels). De client rekent en schrijft niets meer; deze
 * test bewijst dat de lijst compleet is én dat ontkoppelen geen eigen
 * herberekening, factuurwrite of koppelingsdelete meer doet.
 */
import { render, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createPostgrestEmulator, readsOn, type Row } from "./support/postgrest-max-rows-emulator";

const CAP = 1000;

const h = vi.hoisted(() => ({
  client: null as any,
  transactions: [] as any[],
  sales: [] as any[],
  updateSalesCalls: [] as any[],
  updateTxCalls: [] as any[],
  rpcCalls: [] as any[],
  withRpc: true,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: new Proxy({}, { get: (_t, prop) => (h.client as any)[prop] }),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" }, loading: false }) }));
vi.mock("@/hooks/useBankMatchRejections", () => ({
  assertBankMatchNotRejected: vi.fn(async () => undefined),
  useBankMatchRejections: () => ({ data: [], isSuccess: true, isError: false }),
  useRecordBankMatchRejection: () => ({ mutateAsync: vi.fn(async () => undefined) }),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c1", name: "Klant 1", organization_id: "org-1", btw_status: "btw_plichtig" }] }),
}));
vi.mock("@/hooks/useBankTransactions", () => ({
  BANK_TRANSACTIONS_PAGE_SIZE: 50,
  isServerFilterableBankStatus: () => true,
  BANK_STATUS_MATCH_VALUES: { all: undefined, open: ["niet_gematcht", "suggestie"], gematcht: ["gematcht"], handmatig: ["handmatig_geboekt"] },
  bankSanitizeSearchTerm: (raw: string) => raw.trim(),
  fetchAllBankTransactions: vi.fn(async () => []),
  useBankTransactions: () => ({ data: h.transactions, isLoading: false, isError: false, refetch: vi.fn() }),
  usePaginatedBankTransactions: () => ({
    data: { transactions: h.transactions.filter((t) => t.id === "tx-new"), total: 1 },
    isLoading: false, isFetching: false, isError: false, isPlaceholderData: false, refetch: vi.fn(),
  }),
  useAddBankTransaction: () => ({ mutateAsync: vi.fn() }),
  useUpdateBankTransaction: () => ({
    mutateAsync: vi.fn(async (args: any) => { h.updateTxCalls.push(args); return {}; }),
  }),
}));
vi.mock("@/hooks/usePurchaseInvoices", () => ({
  usePurchaseInvoices: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdatePurchaseInvoice: () => ({ mutateAsync: vi.fn(async () => ({})) }),
}));
vi.mock("@/hooks/useSalesInvoices", () => ({
  useSalesInvoices: () => ({ data: h.sales, isLoading: false, isError: false, refetch: vi.fn() }),
  useUpdateSalesInvoice: () => ({
    mutateAsync: vi.fn(async (args: any) => { h.updateSalesCalls.push(args); return {}; }),
  }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({ useActiveGrootboekrekeningen: () => ({ data: [] }) }));
vi.mock("@/hooks/useBookingTemplates", () => ({ useBookingTemplates: () => ({ data: [] }) }));
vi.mock("@/hooks/useVraagposten", () => ({
  useVraagposten: () => ({ data: [] }),
  useCreateVraagpost: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/useBankLedgerStatus", () => ({ useBankLedgerStatus: () => ({ data: undefined }) }));
vi.mock("@/components/BankMatchDialog", () => ({ BankMatchDialog: () => null, rankCandidates: () => [] }));
vi.mock("@/components/BankStatementUploadDialog", () => ({ BankStatementUploadDialog: () => null }));
vi.mock("@/components/BankAfletteringDrawer", () => ({ BankAfletteringDrawer: () => null }));
vi.mock("@/components/VerwerkingsScherm", () => ({ VerwerkingsScherm: () => null }));
vi.mock("@/components/CreateVraagpostDialog", () => ({ CreateVraagpostDialog: () => null }));
vi.mock("@/components/ClientMultiSelect", () => ({ ClientMultiSelect: () => null }));
vi.mock("@/components/GrootboekCombobox", () => ({ GrootboekCombobox: () => null }));

import Bank from "@/pages/Bank";

const tx = (over: Partial<any>) => ({
  id: "tx-new", client_id: "c1", organization_id: "org-1", transaction_date: "2026-10-01", description: "Ontvangst",
  reference: null, counter_account: null, counter_account_name: null, amount: 120, match_status: "gematcht",
  match_confidence: 100, matched_invoice_id: "S1", matched_invoice_type: null, grootboekrekening_id: null,
  ledger_account: null, notes: null, ...over,
});
const sale = (id: string, total: number) => ({
  id, client_id: "c1", organization_id: "org-1", customer_name: "Klant", invoice_number: id, invoice_date: "2026-09-01",
  amount_excl: total, btw_amount: 0, amount_incl: total, btw_percentage: 0, remaining_amount: 0, status: "betaald",
});

let emu: ReturnType<typeof createPostgrestEmulator>;

function seed() {
  const filler: Row[] = Array.from({ length: CAP }, (_, i) => ({
    id: `old-${String(i).padStart(4, "0")}`, bank_transaction_id: `tx-old-${i}`, invoice_type: "verkoop", invoice_id: `inv-old-${i}`,
    client_id: "c1", organization_id: "org-1", amount: 10, user_id: "u1",
    created_at: new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString(), updated_at: "2026-06-01T00:00:00.000Z",
  }));
  const recent: Row[] = [
    { id: "a-other-s1", bank_transaction_id: "tx-other", invoice_id: "S1", amount: 30, created_at: "2026-10-01T09:00:00.000Z" },
    { id: "a-new-s1", bank_transaction_id: "tx-new", invoice_id: "S1", amount: 70, created_at: "2026-10-02T09:00:00.000Z" },
    { id: "a-new-s2", bank_transaction_id: "tx-new", invoice_id: "S2", amount: 50, created_at: "2026-10-02T09:00:01.000Z" },
  ].map((r) => ({ ...r, invoice_type: "verkoop", client_id: "c1", organization_id: "org-1", user_id: "u1", updated_at: r.created_at }));
  h.rpcCalls = [];
  emu = createPostgrestEmulator({
    maxRows: CAP,
    tables: { bank_transaction_allocations: [...filler, ...recent] },
    rpc: h.withRpc ? {
      // Wat de database doet: alle koppelingen van de transactie weg, restant en
      // status afgeleid. Hier alleen het weghalen; de afleiding bewijst het DB-harnas.
      unlink_bank_payment: (args: any) => {
        h.rpcCalls.push({ fn: "unlink_bank_payment", args });
        const rows = emu.tables.bank_transaction_allocations;
        const removed = rows.filter((a) => a.bank_transaction_id === args._bank_transaction_id).length;
        emu.tables.bank_transaction_allocations = rows.filter((a) => a.bank_transaction_id !== args._bank_transaction_id);
        return [{ outcome: removed > 0 ? "unlinked" : "unchanged", removed_count: removed, tx_match_status: "niet_gematcht", replayed: false }];
      },
    } : undefined,
  });
  h.client = emu.client;
  h.sales = [sale("S1", 100), sale("S2", 50)];
  h.transactions = [tx({}), tx({ id: "tx-other", amount: 30, transaction_date: "2026-09-30" })];
}

beforeEach(() => {
  h.updateSalesCalls = [];
  h.updateTxCalls = [];
  h.withRpc = true;
  seed();
});

function renderBank() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/bank"]}><Bank /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ontkoppelen bij meer dan 1000 koppelingen (F3-scenario, echte hook)", () => {
  it("de server kapt een verzoek zonder range af: de nieuwste koppelingen zouden ontbreken", async () => {
    const { data } = await (emu.client.from("bank_transaction_allocations").select("*").order("created_at") as any);
    expect(data).toHaveLength(CAP);
    expect(data.some((a: Row) => a.bank_transaction_id === "tx-new")).toBe(false);
  });

  it("de koppelingenlijst is volledig, en ontkoppelen is één aanroep van de betaalschrijver — geen eigen herberekening of write", async () => {
    renderBank();
    // De lijst is binnen zodra de hook pagina voor pagina tot een lege pagina heeft gelezen.
    await waitFor(() => {
      const reads = readsOn(emu.log, "bank_transaction_allocations");
      expect(reads.at(-1)?.returned).toBe(0);
    });
    const reads = readsOn(emu.log, "bank_transaction_allocations");
    expect(reads.every((l) => l.range)).toBe(true);
    expect(reads.reduce((n, l) => n + l.returned, 0)).toBe(CAP + 3);

    await waitFor(() => expect(document.querySelector("svg.lucide-unlink")).not.toBeNull());
    fireEvent.click(document.querySelector("svg.lucide-unlink")!.closest("button")!);
    await waitFor(() => expect(h.rpcCalls).toHaveLength(1));

    expect(h.rpcCalls[0].args).toEqual({
      _bank_transaction_id: "tx-new",
      _request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      _allocation_id: null,
    });
    // De database verwijderde de koppelingen van tx-new; die van tx-other blijft.
    expect(emu.tables.bank_transaction_allocations.filter((a) => a.bank_transaction_id === "tx-new")).toEqual([]);
    expect(emu.tables.bank_transaction_allocations.some((a) => a.id === "a-other-s1")).toBe(true);
    // Geen eigen restant- of statuswrite, geen eigen match-reset, geen directe delete.
    expect(h.updateSalesCalls).toEqual([]);
    expect(h.updateTxCalls).toEqual([]);
    expect(emu.log.some((l) => l.table === "bank_transaction_allocations" && l.op === "delete")).toBe(false);
  });

  it("zonder de betaalschrijver in de database (PGRST202) wordt er niets geschreven", async () => {
    h.withRpc = false;
    seed();
    renderBank();
    await waitFor(() => expect(document.querySelector("svg.lucide-unlink")).not.toBeNull());
    fireEvent.click(document.querySelector("svg.lucide-unlink")!.closest("button")!);
    await waitFor(() => expect(emu.log.some((l) => l.table === "rpc:unlink_bank_payment")).toBe(true));
    // Fail-closed: geen enkele andere schrijfactie, de koppelingen staan er nog.
    expect(emu.tables.bank_transaction_allocations.filter((a) => a.bank_transaction_id === "tx-new")).toHaveLength(2);
    expect(h.updateSalesCalls).toEqual([]);
    expect(h.updateTxCalls).toEqual([]);
    expect(emu.log.some((l) => l.op === "delete" || l.op === "update" || l.op === "upsert" || l.op === "insert")).toBe(false);
  });
});
