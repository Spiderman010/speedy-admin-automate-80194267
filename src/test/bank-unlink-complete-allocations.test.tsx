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
 * Het schrijfpad zelf (de herberekening in de client en de losse factuurwrites)
 * is van P5 en blijft hier ongewijzigd; deze test bewijst alleen dat de lijst
 * waarop het rekent compleet is.
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
  emu = createPostgrestEmulator({ maxRows: CAP, tables: { bank_transaction_allocations: [...filler, ...recent] } });
  h.client = emu.client;
  h.sales = [sale("S1", 100), sale("S2", 50)];
  h.transactions = [tx({}), tx({ id: "tx-other", amount: 30, transaction_date: "2026-09-30" })];
}

beforeEach(() => {
  h.updateSalesCalls = [];
  h.updateTxCalls = [];
  seed();
});

describe("ontkoppelen bij meer dan 1000 koppelingen (F3-scenario, echte hook)", () => {
  it("de server kapt een verzoek zonder range af: de nieuwste koppelingen zouden ontbreken", async () => {
    const { data } = await (emu.client.from("bank_transaction_allocations").select("*").order("created_at") as any);
    expect(data).toHaveLength(CAP);
    expect(data.some((a: Row) => a.bank_transaction_id === "tx-new")).toBe(false);
  });

  it("de koppelingenlijst is volledig, en de herberekening na ontkoppelen ziet daardoor alle overgebleven koppelingen", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/bank"]}><Bank /></MemoryRouter>
      </QueryClientProvider>,
    );
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
    await waitFor(() => expect(h.updateSalesCalls).toHaveLength(2));

    // De server verwijderde beide koppelingen van tx-new …
    expect(emu.tables.bank_transaction_allocations.filter((a) => a.bank_transaction_id === "tx-new")).toEqual([]);
    // … en de herberekening rekent met de volledige lijst: S1 houdt de € 30 van tx-other, S2 heeft niets meer.
    expect(h.updateSalesCalls).toEqual(expect.arrayContaining([
      { id: "S1", status: "gecontroleerd", remaining_amount: 70 },
      { id: "S2", status: "gecontroleerd", remaining_amount: 50 },
    ]));
  });
});
