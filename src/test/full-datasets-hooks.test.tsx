/**
 * Volledige datasets (nulmeting NM-07: C-01, E-08, A1-16, D-12).
 *
 * Elke lijst die als VOLLEDIGE set wordt gebruikt, haalt meer dan 1000 rijen
 * op tegen een emulator die zich gedraagt als PostgREST met `max_rows = 1000`:
 * een verzoek zonder range wordt daar stil afgekapt (de controle per test laat
 * dat zien), en de hooks moeten dus pagineren. Echte hooks, echte QueryClient,
 * geen netwerk.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createPostgrestEmulator, readsOn, type Row } from "./support/postgrest-max-rows-emulator";

const h = vi.hoisted(() => ({ client: null as any }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: new Proxy({}, { get: (_t, prop) => (h.client as any)[prop] }),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, session: { access_token: "inert" }, loading: false }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));

import { useBankTransactionAllocations } from "@/hooks/useBankTransactionAllocations";
import { usePurchaseInvoices } from "@/hooks/usePurchaseInvoices";
import { useActiveGrootboekrekeningen, useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useManualJournals } from "@/hooks/useManualJournals";
import { useVraagposten } from "@/hooks/useVraagposten";
import { useLeveranciers } from "@/hooks/useLeveranciers";
import { useClients } from "@/hooks/useClients";
import { useBankBulkCandidates } from "@/hooks/useBankBulkPosting";

const CAP = 1000;

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const pad = (i: number) => String(i).padStart(5, "0");
const day = (i: number) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const ts = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString();
const rows = (n: number, make: (i: number) => Row) => Array.from({ length: n }, (_, i) => make(i));

let emu: ReturnType<typeof createPostgrestEmulator>;
function setup(tables: Record<string, Row[]>, rpc?: Record<string, (a: any) => Row[]>) {
  emu = createPostgrestEmulator({ maxRows: CAP, tables, rpc });
  h.client = emu.client;
}

/** Wat een verzoek zonder range van de server krijgt: de afkapping die de hooks moeten omzeilen. */
async function unpaged(table: string, filter?: (q: any) => any): Promise<number> {
  const q = filter ? filter(emu.client.from(table).select("*")) : emu.client.from(table).select("*");
  const { data } = await q;
  emu.log.pop();
  return data.length;
}

beforeEach(() => {
  h.client = null;
});

describe("volledige lijsten voorbij max_rows = 1000", () => {
  it("koppelingen (useBankTransactionAllocations): ook de nieuwste rijen, in de vorige volgorde", async () => {
    setup({
      bank_transaction_allocations: rows(1500, (i) => ({
        id: `a-${pad(i)}`, organization_id: "org-1", client_id: "c1", bank_transaction_id: `tx-${i}`,
        invoice_id: `pi-${i}`, invoice_type: "inkoop", amount: 10, created_at: ts(i),
      })),
    });
    expect(await unpaged("bank_transaction_allocations")).toBe(CAP);
    const { result } = renderHook(
      () => useBankTransactionAllocations({ organizationId: "org-1", clientId: "c1" }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1500);
    // created_at ASC: juist de recentste koppeling viel eerder weg.
    expect(result.current.data!.at(-1)!.id).toBe("a-01499");
    expect(result.current.data!.map((a) => a.created_at)).toEqual([...result.current.data!.map((a) => a.created_at)].sort());
    const reads = readsOn(emu.log, "bank_transaction_allocations");
    expect(reads.every((l) => l.range && l.order.join(",") === "created_at.asc,id.asc")).toBe(true);
  });

  it("koppelingen: een lege deelselectie vraagt niets op", async () => {
    setup({ bank_transaction_allocations: [] });
    const { result } = renderHook(() => useBankTransactionAllocations({ clientIds: [] }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
    expect(readsOn(emu.log, "bank_transaction_allocations")).toHaveLength(0);
  });

  it("inkoopfacturen (usePurchaseInvoices): ook de oudste, per gekozen administraties", async () => {
    setup({
      purchase_invoices: rows(2600, (i) => ({
        id: `pi-${pad(i)}`, organization_id: "org-1", client_id: `c${i % 3}`, invoice_date: day(i),
        status: "gecontroleerd", amount_incl: 100, remaining_amount: 100, supplier: "Leverancier", invoice_number: `F-${i}`,
      })),
    });
    expect(await unpaged("purchase_invoices")).toBe(CAP);

    const all = renderHook(() => usePurchaseInvoices({ organizationId: "org-1" }), { wrapper: wrapper() });
    await waitFor(() => expect(all.result.current.isSuccess).toBe(true));
    expect(all.result.current.data).toHaveLength(2600);
    expect(all.result.current.data!.some((r) => r.id === "pi-00000")).toBe(true); // de oudste
    expect(all.result.current.data![0].id).toBe("pi-02599"); // invoice_date DESC blijft

    const subset = renderHook(
      () => usePurchaseInvoices({ organizationId: "org-1", clientIds: ["c0", "c2"] }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(subset.result.current.isSuccess).toBe(true));
    expect(subset.result.current.data).toHaveLength(867 + 866);
    expect(new Set(subset.result.current.data!.map((r) => r.client_id))).toEqual(new Set(["c0", "c2"]));
  });

  it("rekeningschema (useGrootboekrekeningen en useActiveGrootboekrekeningen): ook de hoogste nummers", async () => {
    setup({
      grootboekrekeningen: [
        ...rows(1100, (i) => ({
          id: `gb-${pad(i)}`, organization_id: "org-1", client_id: null, nummer: 1000 + i * 8,
          omschrijving: `Rek ${i}`, categorie: "kosten", actief: i % 10 !== 0,
        })),
        { id: "gb-vreemd", organization_id: "org-2", client_id: null, nummer: 1, omschrijving: "Andere org", categorie: "kosten", actief: true },
      ],
    });
    expect(await unpaged("grootboekrekeningen")).toBe(CAP);
    const alle = renderHook(() => useGrootboekrekeningen({ organizationId: "org-1" }), { wrapper: wrapper() });
    const actief = renderHook(() => useActiveGrootboekrekeningen({ organizationId: "org-1" }), { wrapper: wrapper() });
    await waitFor(() => {
      expect(alle.result.current.isSuccess).toBe(true);
      expect(actief.result.current.isSuccess).toBe(true);
    });
    expect(alle.result.current.data).toHaveLength(1100);
    expect(Math.max(...alle.result.current.data!.map((r) => r.nummer))).toBe(1000 + 1099 * 8);
    expect(alle.result.current.data!.some((r) => r.id === "gb-vreemd")).toBe(false);
    expect(actief.result.current.data).toHaveLength(990);
    expect(actief.result.current.data!.every((r) => r.actief)).toBe(true);
  });

  it("memoriaal (useManualJournals): elke boeking houdt al haar regels en haar marker", async () => {
    setup({
      manual_journals: rows(1200, (i) => ({
        id: `mj-${pad(i)}`, organization_id: "org-1", client_id: "c1", posting_date: day(i), created_at: ts(i),
      })),
      manual_journal_postings: rows(1100, (i) => ({ manual_journal_id: `mj-${pad(i)}`, posting_group_id: `g-${i}` })),
      manual_journal_lines: rows(2400, (i) => ({
        id: `mjl-${pad(i)}`, manual_journal_id: `mj-${pad(Math.floor(i / 2))}`, sort_order: i % 2,
        debit_amount: i % 2 ? 0 : 10, credit_amount: i % 2 ? 10 : 0,
      })),
    });
    expect(await unpaged("manual_journal_lines")).toBe(CAP);
    const { result } = renderHook(() => useManualJournals({ organizationId: "org-1", clientId: "c1" }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const list = result.current.data!;
    expect(list).toHaveLength(1200);
    expect(list.filter((j) => j.lines.length !== 2)).toEqual([]);
    expect(list.every((j) => j.lines[0].sort_order === 0 && j.lines[1].sort_order === 1)).toBe(true);
    expect(list.filter((j) => j.posted)).toHaveLength(1100);
    // De .in()-filters gaan in blokken: geen URL met 1200 id's.
    const lineReads = readsOn(emu.log, "manual_journal_lines");
    expect(lineReads.every((l) => l.filters.some((f) => f === "manual_journal_id=in.(100)"))).toBe(true);
  });

  it("vraagposten, leveranciers en klanten zijn volledig", async () => {
    setup({
      vraagposten: rows(1200, (i) => ({ id: `vp-${pad(i)}`, organization_id: "org-1", client_id: "c1", created_at: ts(i), status: "open" })),
      leveranciers: rows(1300, (i) => ({ id: `lev-${pad(i)}`, organization_id: "org-1", client_id: "c1", naam: `Lev ${pad(i)}` })),
      clients: rows(1050, (i) => ({ id: `c-${pad(i)}`, organization_id: "org-1", name: `Klant ${pad(i)}` })),
    });
    expect(await unpaged("vraagposten")).toBe(CAP);
    const w = wrapper();
    const vp = renderHook(() => useVraagposten({ organizationId: "org-1" }), { wrapper: w });
    const lev = renderHook(() => useLeveranciers({ organizationId: "org-1" }), { wrapper: w });
    const kl = renderHook(() => useClients("org-1"), { wrapper: w });
    await waitFor(() => {
      expect(vp.result.current.isSuccess).toBe(true);
      expect(lev.result.current.isSuccess).toBe(true);
      expect(kl.result.current.isSuccess).toBe(true);
    });
    expect(vp.result.current.data).toHaveLength(1200);
    expect(vp.result.current.data![0].id).toBe("vp-01199"); // nieuwste eerst blijft
    expect(lev.result.current.data).toHaveLength(1300);
    expect(lev.result.current.data!.at(-1)!.naam).toBe("Lev 01299"); // op naam blijft
    expect(kl.result.current.data).toHaveLength(1050);
  });

  it("inhaalslag-kandidaten (RPC bank_bulk_posting_candidates): pagina's via range, in de volgorde van de functie", async () => {
    const candidates = rows(1500, (i) => ({
      transaction_id: `tx-${pad(i)}`, transaction_date: day(Math.floor(i / 3)), amount: -10, description: "x",
      counter_account: null, match_status: "handmatig_geboekt", grootboekrekening_id: "gb-1", btw_percentage: 21,
      is_posted: false, is_allocated: false, posting_group_id: null, workflow_state: "ready", reason: null,
    })).reverse(); // de emulator sorteert zelf; de invoervolgorde doet er niet toe
    setup({}, { bank_bulk_posting_candidates: () => candidates });
    const capped = await (emu.client.rpc("bank_bulk_posting_candidates", {}) as any);
    expect(capped.data).toHaveLength(CAP);
    const { result } = renderHook(() => useBankBulkCandidates({ clientId: "c1", boekjaar: null }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1500);
    // De nieuwste regels werden eerder nooit aangeboden.
    expect(result.current.data!.some((c) => c.transaction_id === "tx-01499")).toBe(true);
    expect(result.current.data!.map((c) => c.transaction_id)).toEqual(rows(1500, (i) => `tx-${pad(i)}` as any));
    const reads = readsOn(emu.log, "rpc:bank_bulk_posting_candidates").filter((l) => l.range);
    expect(reads.map((l) => l.order.join(","))).toEqual(reads.map(() => "transaction_date.asc,transaction_id.asc"));
  });

  it("inhaalslag-kandidaten: het deploy-venster blijft null, ook met paginering", async () => {
    setup({}, {});
    const { result } = renderHook(() => useBankBulkCandidates({ clientId: "c1", boekjaar: null }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});
