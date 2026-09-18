import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

/**
 * Historische grootboekvulling — de datalaag en de bulkactie.
 *
 * De Supabase-client is vervangen door een tabelgestuurde nepclient die de
 * echte filters toepast (eq/in/gte/lt/range). Daardoor bewijzen deze tests het
 * werkelijke querypad, inclusief administratiescheiding, in plaats van een
 * vooraf geprepareerd antwoord.
 *
 * De RPC's worden geteld en kunnen weigeren, zodat we kunnen vastleggen dat er
 * NOOIT rechtstreeks in ledger_postings wordt geschreven: de enige manier
 * waarop een boeking ontstaat is een aanroep van de bestaande writer.
 */

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {};
const rpcCalls: { fn: string; args: Row }[] = [];
const rpcFailures = new Map<string, string>();
/** Elke tabel waar een schrijfpoging op gedaan zou worden. */
const writeAttempts: string[] = [];

function applyFilters(rows: Row[], filters: ((r: Row) => boolean)[]) {
  return rows.filter((r) => filters.every((f) => f(r)));
}

function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let from = 0;
  let to = Number.MAX_SAFE_INTEGER;

  const resolve = () => {
    const rows = applyFilters(db[table] ?? [], filters);
    return { data: rows.slice(from, to + 1), error: null };
  };

  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, value: unknown) => {
      filters.push((r) => r[col] === value);
      return api;
    },
    in: (col: string, values: unknown[]) => {
      filters.push((r) => values.includes(r[col]));
      return api;
    },
    gte: (col: string, value: string) => {
      filters.push((r) => typeof r[col] === "string" && (r[col] as string) >= value);
      return api;
    },
    lt: (col: string, value: string) => {
      filters.push((r) => typeof r[col] === "string" && (r[col] as string) < value);
      return api;
    },
    order: () => api,
    range: (a: number, b: number) => {
      from = a;
      to = b;
      return api;
    },
    maybeSingle: () => Promise.resolve({ data: resolve().data[0] ?? null, error: null }),
    then: (onOk: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onOk),
    // Elke mutatiemethode wordt geregistreerd maar doet niets: als de
    // implementatie ooit zelf zou gaan schrijven, valt dat hier door de mand.
    insert: () => { writeAttempts.push(table); return api; },
    update: () => { writeAttempts.push(table); return api; },
    upsert: () => { writeAttempts.push(table); return api; },
    delete: () => { writeAttempts.push(table); return api; },
  };
  return api;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => builder(table),
    rpc: (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      const id = String(args._invoice_id ?? "");
      const failure = rpcFailures.get(id);
      if (failure) return Promise.resolve({ data: null, error: { message: failure } });
      // De echte writer schrijft de marker; dat bootsen we na, zodat een
      // tweede ronde dezelfde factuur als "geboekt" ziet.
      const marker = fn === "post_purchase_invoice"
        ? { table: "purchase_invoice_postings", key: "purchase_invoice_id" }
        : { table: "sales_invoice_postings", key: "sales_invoice_id" };
      db[marker.table] = [...(db[marker.table] ?? []), {
        [marker.key]: id, posting_group_id: `pg-${id}`, client_id: "client-1",
      }];
      return Promise.resolve({ data: `pg-${id}`, error: null });
    },
  },
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));

import { useLedgerCatchup, useRunLedgerCatchup } from "@/hooks/useLedgerCatchup";

const CLIENT = "client-1";
const ANDER = "client-2";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const client = (over: Row = {}) => ({
  id: CLIENT, afgesloten_boekjaar: null, crediteuren_rekening_id: "cred", debiteuren_rekening_id: "deb",
  btw_te_vorderen_rekening_id: "btwv", btw_te_betalen_rekening_id: "btwb", ...over,
});

const pi = (over: Row = {}) => ({
  id: "pi-1", client_id: CLIENT, status: "gecontroleerd", invoice_date: "2026-03-01",
  invoice_number: "F-1", supplier: "Lev", amount_excl: 100, amount_incl: 121, btw_amount: 21, ...over,
});

const line = (invoiceId: string, over: Row = {}) => ({
  id: `l-${invoiceId}`, purchase_invoice_id: invoiceId, amount_excl: 100, grootboekrekening_id: "kosten", ...over,
});

const si = (over: Row = {}) => ({
  id: "si-1", client_id: CLIENT, status: "gecontroleerd", invoice_date: "2026-04-01",
  invoice_number: "V-1", customer_name: "Klant", amount_excl: 200, amount_incl: 242, btw_amount: 42,
  btw_verlegd: false, grootboekrekening_id: "omzet", ...over,
});

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.clients = [client(), { ...client(), id: ANDER }];
  db.purchase_invoices = [];
  db.purchase_invoice_lines = [];
  db.sales_invoices = [];
  db.purchase_invoice_postings = [];
  db.sales_invoice_postings = [];
  rpcCalls.length = 0;
  writeAttempts.length = 0;
  rpcFailures.clear();
});

const laad = async (year: number | null = null) => {
  const hook = renderHook(() => useLedgerCatchup(CLIENT, { year }), { wrapper });
  await waitFor(() => expect(hook.result.current.data).toBeDefined());
  return hook;
};

// ─────────────────────────────────────────────────────────────────────────────
describe("administratiescheiding", () => {
  it("1. records van een andere administratie verschijnen nooit", () => {
    db.purchase_invoices = [pi(), pi({ id: "pi-vreemd", client_id: ANDER, invoice_number: "F-VREEMD" })];
    db.purchase_invoice_lines = [line("pi-1"), line("pi-vreemd")];
    db.sales_invoices = [si(), si({ id: "si-vreemd", client_id: ANDER })];

    return laad().then(({ result }) => {
      const ids = result.current.data!.records.map((r) => r.id);
      expect(ids).toEqual(["pi-1", "si-1"]);
      expect(result.current.data!.purchase.totaal).toBe(1);
      expect(result.current.data!.sales.totaal).toBe(1);
    });
  });

  it("2. een marker van een andere administratie maakt onze factuur niet 'geboekt'", () => {
    db.purchase_invoices = [pi()];
    db.purchase_invoice_lines = [line("pi-1")];
    // Zelfde factuur-id, maar geclaimd onder een andere administratie: de
    // query filtert op client_id, dus deze marker mag niet meetellen.
    db.purchase_invoice_postings = [{ purchase_invoice_id: "pi-1", posting_group_id: "pg-x", client_id: ANDER }];

    return laad().then(({ result }) => {
      expect(result.current.data!.records[0].state).toBe("klaar");
    });
  });
});

describe("overzicht en telling", () => {
  it("3. geboekt, klaar en geblokkeerd worden apart geteld met echte data", async () => {
    db.purchase_invoices = [
      pi({ id: "pi-klaar" }),
      pi({ id: "pi-geboekt" }),
      pi({ id: "pi-blok", status: "te_controleren" }),
    ];
    db.purchase_invoice_lines = [line("pi-klaar"), line("pi-geboekt"), line("pi-blok")];
    db.purchase_invoice_postings = [
      { purchase_invoice_id: "pi-geboekt", posting_group_id: "pg-1", client_id: CLIENT },
    ];

    const { result } = await laad();
    expect(result.current.data!.purchase).toEqual({ totaal: 3, geboekt: 1, klaar: 1, geblokkeerd: 1 });
    const blok = result.current.data!.records.find((r) => r.id === "pi-blok")!;
    expect(blok.blocks.map((b) => b.code)).toContain("status_niet_postbaar");
  });

  it("4. het boekjaarfilter gebruikt de echte brondatum", async () => {
    db.purchase_invoices = [pi({ id: "pi-2025", invoice_date: "2025-05-01" }), pi({ id: "pi-2026" })];
    db.purchase_invoice_lines = [line("pi-2025"), line("pi-2026")];

    const { result } = await laad(2026);
    expect(result.current.data!.records.map((r) => r.id)).toEqual(["pi-2026"]);
  });
});

describe("bulkactie", () => {
  async function run(records: readonly unknown[], blocked = 0) {
    const hook = renderHook(() => useRunLedgerCatchup(), { wrapper });
    return hook.result.current.mutateAsync({ records: records as never, blocked });
  }

  it("5. alleen 'klaar' wordt aangeboden; geblokkeerd en geboekt nooit", async () => {
    db.purchase_invoices = [
      pi({ id: "pi-klaar" }),
      pi({ id: "pi-blok", status: "te_controleren" }),
      pi({ id: "pi-geboekt" }),
    ];
    db.purchase_invoice_lines = [line("pi-klaar"), line("pi-blok"), line("pi-geboekt")];
    db.purchase_invoice_postings = [
      { purchase_invoice_id: "pi-geboekt", posting_group_id: "pg-0", client_id: CLIENT },
    ];
    const { result } = await laad();
    const alle = result.current.data!.records;

    // Bewust ALLE records meegeven, ook de geblokkeerde: de hook moet zelf
    // filteren, zodat een vergissing in de aanroeper niets kan boeken.
    const uitkomst = await run(alle, 1);
    expect(uitkomst).toMatchObject({ attempted: 1, posted: 1, blocked: 1 });
    expect(rpcCalls.map((c) => c.args._invoice_id)).toEqual(["pi-klaar"]);
  });

  it("6. één weigering beschadigt de andere records niet en wordt per record gemeld", async () => {
    db.purchase_invoices = [pi({ id: "pi-a" }), pi({ id: "pi-b" }), pi({ id: "pi-c" })];
    db.purchase_invoice_lines = [line("pi-a"), line("pi-b"), line("pi-c")];
    rpcFailures.set("pi-b", "Boekjaar 2026 is afgesloten voor deze administratie");

    const { result } = await laad();
    const uitkomst = await run(result.current.data!.records);

    expect(uitkomst.attempted).toBe(3);
    expect(uitkomst.posted).toBe(2);
    expect(uitkomst.failures).toHaveLength(1);
    expect(uitkomst.failures[0]).toMatchObject({ id: "pi-b", source: "inkoop", reference: "F-1" });
    expect(uitkomst.failures[0].message).toContain("afgesloten");
    // Geen retrylus: precies drie pogingen, niet meer.
    expect(rpcCalls).toHaveLength(3);
  });

  it("7. inkoop wordt vóór verkoop aangeboden", async () => {
    db.purchase_invoices = [pi({ id: "pi-1", invoice_date: "2026-08-01" })];
    db.purchase_invoice_lines = [line("pi-1")];
    db.sales_invoices = [si({ id: "si-1", invoice_date: "2026-01-01" })];

    const { result } = await laad();
    await run(result.current.data!.records);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["post_purchase_invoice", "post_sales_invoice"]);
  });

  it("8. er wordt uitsluitend via de bestaande RPC's geboekt, nooit met een insert", async () => {
    db.purchase_invoices = [pi()];
    db.purchase_invoice_lines = [line("pi-1")];
    db.sales_invoices = [si()];

    const { result } = await laad();
    await run(result.current.data!.records);

    expect(rpcCalls.map((c) => c.fn).sort()).toEqual(["post_purchase_invoice", "post_sales_invoice"]);
    // Geen enkele tabel is beschreven — al helemaal niet ledger_postings.
    expect(writeAttempts).toEqual([]);
  });
});

describe("idempotentie", () => {
  it("9. een tweede ronde boekt niets opnieuw en toont alles als 'Geboekt'", async () => {
    db.purchase_invoices = [pi()];
    db.purchase_invoice_lines = [line("pi-1")];
    db.sales_invoices = [si()];

    const eerste = await laad();
    const runHook = renderHook(() => useRunLedgerCatchup(), { wrapper });
    const ronde1 = await runHook.result.current.mutateAsync({
      records: eerste.result.current.data!.records, blocked: 0,
    });
    expect(ronde1).toMatchObject({ attempted: 2, posted: 2 });
    expect(rpcCalls).toHaveLength(2);

    // Opnieuw laden: de writers hebben markers geschreven, dus beide records
    // staan nu op "geboekt" en er valt niets meer aan te bieden.
    const tweede = await laad();
    const records = tweede.result.current.data!.records;
    expect(records.map((r) => r.state)).toEqual(["geboekt", "geboekt"]);
    expect(records.map((r) => r.postingGroupId)).toEqual(["pg-pi-1", "pg-si-1"]);

    const ronde2 = await runHook.result.current.mutateAsync({ records, blocked: 0 });
    expect(ronde2).toMatchObject({ attempted: 0, posted: 0, failures: [] });
    // Nog steeds maar twee RPC-aanroepen in totaal: niets dubbel geboekt.
    expect(rpcCalls).toHaveLength(2);
  });
});

describe("rapportage vernieuwt", () => {
  it("10. na een ronde worden de grootboek- en volledigheidsqueries geïnvalideerd", async () => {
    db.purchase_invoices = [pi()];
    db.purchase_invoice_lines = [line("pi-1")];

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidated: unknown[] = [];
    const origineel = queryClient.invalidateQueries.bind(queryClient);
    queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
      invalidated.push(filters?.queryKey);
      return origineel(filters as never);
    }) as typeof queryClient.invalidateQueries;

    const eigenWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const laden = renderHook(() => useLedgerCatchup(CLIENT, { year: null }), { wrapper: eigenWrapper });
    await waitFor(() => expect(laden.result.current.data).toBeDefined());

    const runHook = renderHook(() => useRunLedgerCatchup(), { wrapper: eigenWrapper });
    await runHook.result.current.mutateAsync({ records: laden.result.current.data!.records, blocked: 0 });

    const platgeslagen = invalidated.map((k) => JSON.stringify(k));
    expect(platgeslagen.some((k) => k.includes("ledger-postings"))).toBe(true);
    expect(platgeslagen.some((k) => k.includes("ledger-completeness"))).toBe(true);
    expect(platgeslagen.some((k) => k.includes("ledger-catchup"))).toBe(true);
  });
});
