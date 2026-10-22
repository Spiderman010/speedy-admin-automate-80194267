import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fetchAllExportablePurchaseInvoices,
  fetchPurchaseInvoiceDuplicateCandidates,
  computeDuplicateIds,
  markPurchaseInvoicesExported,
  EXPORT_BATCH_SIZE,
  DUPLICATE_LOOKUP_BATCH_SIZE,
  STATUS_UPDATE_BATCH_SIZE,
  STATUS_UPDATE_CAS_BATCH_SIZE,
  type DuplicateCandidate,
} from "@/hooks/usePurchaseInvoices";

type QueryCall = { method: string; args: unknown[] };

const state = {
  calls: [] as QueryCall[],
  // one response per executed query, consumed in order
  responses: [] as Array<{ data: unknown[]; error: unknown }>,
};

function makeQueryMock() {
  const query: Record<string, unknown> = {};
  let isUpdate = false;
  let idFilter: string[] = [];
  const chain = (method: string) =>
    vi.fn((...args: unknown[]) => {
      state.calls.push({ method, args });
      if (method === "update") isUpdate = true;
      if (method === "in" && args[0] === "id") idFilter = args[1] as string[];
      return query;
    });
  // Without a queued response, an UPDATE matched every requested id and returns
  // those rows (RETURNING via .select("id")); a read returns no rows.
  const defaultResponse = () =>
    isUpdate ? { data: idFilter.map(id => ({ id })), error: null } : { data: [], error: null };
  query.select = chain("select");
  query.update = chain("update");
  query.eq = chain("eq");
  query.in = chain("in");
  query.order = chain("order");
  query.lte = chain("lte");
  query.or = chain("or");
  query.range = vi.fn((...args: unknown[]) => {
    state.calls.push({ method: "range", args });
    return Promise.resolve(state.responses.shift() ?? defaultResponse());
  });
  // duplicate-candidate and update queries resolve without .range(): make the builder thenable
  (query as { then?: unknown }).then = (
    onFulfilled: (v: { data: unknown[]; error: unknown }) => unknown,
  ) => Promise.resolve(state.responses.shift() ?? defaultResponse()).then(onFulfilled);
  return query;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => makeQueryMock()),
  },
}));

const callsFor = (method: string) => state.calls.filter(c => c.method === method);

beforeEach(() => {
  state.calls = [];
  state.responses = [];
});

const invoiceRow = (id: number) => ({ id: `inv-${id}`, status: "gecontroleerd" });

describe("fetchAllExportablePurchaseInvoices", () => {
  it("fetches more than 1000 rows in deterministic id-ordered batches until exhausted", async () => {
    state.responses = [
      { data: Array.from({ length: 1000 }, (_, i) => invoiceRow(i)), error: null },
      { data: Array.from({ length: 1000 }, (_, i) => invoiceRow(1000 + i)), error: null },
      { data: Array.from({ length: 300 }, (_, i) => invoiceRow(2000 + i)), error: null },
    ];

    const result = await fetchAllExportablePurchaseInvoices({ organizationId: "org-1" });

    expect(result).toHaveLength(2300);
    expect(callsFor("range").map(c => c.args)).toEqual([
      [0, EXPORT_BATCH_SIZE - 1],
      [EXPORT_BATCH_SIZE, 2 * EXPORT_BATCH_SIZE - 1],
      [2 * EXPORT_BATCH_SIZE, 3 * EXPORT_BATCH_SIZE - 1],
    ]);
    // deterministic ordering + status scoping applied on every batch
    const orderCalls = callsFor("order").map(c => c.args);
    expect(orderCalls).toHaveLength(3);
    orderCalls.forEach(args => expect(args).toEqual(["id", { ascending: true }]));
    const inCalls = callsFor("in").map(c => c.args);
    inCalls.forEach(args => expect(args).toEqual(["status", ["gecontroleerd", "betaald"]]));
  });

  it("stops after one batch when fewer rows than the batch size are returned", async () => {
    state.responses = [{ data: [invoiceRow(1), invoiceRow(2)], error: null }];
    const result = await fetchAllExportablePurchaseInvoices({});
    expect(result).toHaveLength(2);
    expect(callsFor("range")).toHaveLength(1);
  });
});

describe("duplicate detection across pages", () => {
  const pageInvoice: DuplicateCandidate = {
    id: "inv-page",
    client_id: "client-1",
    invoice_number: "F-2026-001",
    supplier: "Acme B.V.",
    supplier_btw_number: null,
    leverancier_id: null,
  };

  it("detects a duplicate that lives on another page", async () => {
    const offPageDuplicate: DuplicateCandidate = {
      ...pageInvoice,
      id: "inv-elsewhere",
    };
    state.responses = [{ data: [pageInvoice, offPageDuplicate], error: null }];

    const candidates = await fetchPurchaseInvoiceDuplicateCandidates([pageInvoice], {
      organizationId: "org-1",
    });
    const ids = computeDuplicateIds(candidates);

    expect(ids.has("inv-page")).toBe(true);
    expect(ids.has("inv-elsewhere")).toBe(true);
  });

  it("queries only the required columns, scoped to page invoice numbers and clients", async () => {
    state.responses = [{ data: [], error: null }];
    await fetchPurchaseInvoiceDuplicateCandidates([pageInvoice], { organizationId: "org-1" });

    expect(callsFor("select")[0].args[0]).toBe(
      "id, client_id, invoice_number, supplier, supplier_btw_number, leverancier_id",
    );
    const inCalls = callsFor("in").map(c => c.args);
    expect(inCalls).toContainEqual(["invoice_number", ["F-2026-001"]]);
    expect(inCalls).toContainEqual(["client_id", ["client-1"]]);
    expect(callsFor("eq").map(c => c.args)).toContainEqual(["organization_id", "org-1"]);
  });

  it("splits large pages into lookup batches", async () => {
    const many = Array.from({ length: DUPLICATE_LOOKUP_BATCH_SIZE + 5 }, (_, i) => ({
      ...pageInvoice,
      id: `inv-${i}`,
      invoice_number: `F-${i}`,
    }));
    state.responses = [
      { data: [], error: null },
      { data: [], error: null },
    ];
    await fetchPurchaseInvoiceDuplicateCandidates(many, {});

    const numberBatches = callsFor("in").filter(c => c.args[0] === "invoice_number");
    expect(numberBatches).toHaveLength(2);
    expect((numberBatches[0].args[1] as string[]).length).toBe(DUPLICATE_LOOKUP_BATCH_SIZE);
    expect((numberBatches[1].args[1] as string[]).length).toBe(5);
  });

  it("does not flag distinct suppliers with the same invoice number", () => {
    const other: DuplicateCandidate = {
      id: "inv-other",
      client_id: "client-1",
      invoice_number: "F-2026-001",
      supplier: "Totally Different Corp",
      supplier_btw_number: "NL999999999B99",
      leverancier_id: null,
    };
    const withBtw = { ...pageInvoice, supplier_btw_number: "NL111111111B11" };
    const ids = computeDuplicateIds([withBtw, other]);
    expect(ids.size).toBe(0);
  });
});

describe("markPurchaseInvoicesExported", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

  it("updates 2300 invoices in batched requests, not 2300 requests", async () => {
    await expect(
      markPurchaseInvoicesExported({ organizationId: "org-1", clientId: "c-1", invoiceIds: ids(2300) }),
    ).resolves.toEqual({ marked: 2300 });

    const expectedBatches = Math.ceil(2300 / STATUS_UPDATE_BATCH_SIZE);
    const updateCalls = callsFor("update");
    expect(updateCalls).toHaveLength(expectedBatches);
    expect(updateCalls.length).toBeLessThan(20);
    updateCalls.forEach(c => expect(c.args[0]).toEqual({ status: "geexporteerd" }));

    const idBatches = callsFor("in").filter(c => c.args[0] === "id");
    expect(idBatches).toHaveLength(expectedBatches);
    const sizes = idBatches.map(c => (c.args[1] as string[]).length);
    // all full batches except the remainder, batch size within the safe range
    expect(STATUS_UPDATE_BATCH_SIZE).toBeGreaterThanOrEqual(100);
    expect(STATUS_UPDATE_BATCH_SIZE).toBeLessThanOrEqual(200);
    sizes.slice(0, -1).forEach(s => expect(s).toBe(STATUS_UPDATE_BATCH_SIZE));
    expect(sizes[sizes.length - 1]).toBe(2300 % STATUS_UPDATE_BATCH_SIZE || STATUS_UPDATE_BATCH_SIZE);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(2300);
  });

  it("scopes every update batch to the organization", async () => {
    await markPurchaseInvoicesExported({ organizationId: "org-1", clientId: "c-1", invoiceIds: ids(400) });

    const expectedBatches = Math.ceil(400 / STATUS_UPDATE_BATCH_SIZE);
    const orgScopes = callsFor("eq").filter(
      c => c.args[0] === "organization_id" && c.args[1] === "org-1",
    );
    expect(orgScopes).toHaveLength(expectedBatches);
  });

  it("scopes every batch to the administratie and to still-exportable statuses, and writes only the export status (D1)", async () => {
    await markPurchaseInvoicesExported({ organizationId: "org-1", clientId: "c-1", invoiceIds: ids(400) });

    const expectedBatches = Math.ceil(400 / STATUS_UPDATE_BATCH_SIZE);
    expect(callsFor("eq").filter(c => c.args[0] === "client_id" && c.args[1] === "c-1")).toHaveLength(expectedBatches);
    expect(callsFor("in").filter(c => c.args[0] === "status").map(c => c.args[1])).toEqual(
      Array.from({ length: expectedBatches }, () => ["gecontroleerd", "betaald"]),
    );
    // Nooit remaining_amount en nooit een betaalstatus in de markering.
    callsFor("update").forEach(c => expect(c.args[0]).toEqual({ status: "geexporteerd" }));
    // RETURNING, zodat een stil gereduceerde update opvalt.
    expect(callsFor("select").map(c => c.args[0])).toEqual(Array.from({ length: expectedBatches }, () => "id"));
  });

  it("refuses to run without an organizationId and performs no requests", async () => {
    await expect(
      markPurchaseInvoicesExported({ organizationId: "", clientId: "c-1", invoiceIds: ids(3) }),
    ).rejects.toThrow(/organisatie/i);
    expect(callsFor("update")).toHaveLength(0);
  });

  it("refuses to run without a single administratie and performs no requests", async () => {
    for (const clientId of ["", "all"]) {
      await expect(
        markPurchaseInvoicesExported({ organizationId: "org-1", clientId, invoiceIds: ids(3) }),
      ).rejects.toThrow(/administratie/i);
    }
    expect(callsFor("update")).toHaveLength(0);
  });

  it("rejects when a batch fails so callers cannot report success early", async () => {
    state.responses = [
      { data: ids(STATUS_UPDATE_BATCH_SIZE).map(id => ({ id })), error: null },
      { data: [], error: { message: "rls denied" } },
    ];
    await expect(
      markPurchaseInvoicesExported({
        organizationId: "org-1",
        clientId: "c-1",
        invoiceIds: ids(STATUS_UPDATE_BATCH_SIZE + 1),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("rls denied"),
      marked: STATUS_UPDATE_BATCH_SIZE,
      expected: STATUS_UPDATE_BATCH_SIZE + 1,
      unmarkedIds: [`id-${STATUS_UPDATE_BATCH_SIZE}`],
    });
  });

  it("H6-02: probeert na een mislukte reeks ook de volgende reeksen, en noemt precies de niet-gemarkeerde id's", async () => {
    const all = ids(3 * STATUS_UPDATE_BATCH_SIZE);
    const second = all.slice(STATUS_UPDATE_BATCH_SIZE, 2 * STATUS_UPDATE_BATCH_SIZE);
    state.responses = [
      { data: all.slice(0, STATUS_UPDATE_BATCH_SIZE).map(id => ({ id })), error: null },
      { data: second.slice(1).map(id => ({ id })), error: null }, // één factuur uit reeks 2 niet geraakt
      { data: [], error: { message: "timeout" } },                  // reeks 3 faalt
    ];
    const err: any = await markPurchaseInvoicesExported({ organizationId: "org-1", clientId: "c-1", invoiceIds: all }).catch(e => e);
    expect(callsFor("update")).toHaveLength(3); // alle reeksen geprobeerd
    expect(err.marked).toBe(2 * STATUS_UPDATE_BATCH_SIZE - 1);
    expect(err.unmarkedIds).toEqual([second[0], ...all.slice(2 * STATUS_UPDATE_BATCH_SIZE)]);
    expect(err.message).toMatch(new RegExp(`${2 * STATUS_UPDATE_BATCH_SIZE - 1} van ${3 * STATUS_UPDATE_BATCH_SIZE}.*timeout`));
  });

  it("H6-03 / Codex #299: per rij compare-and-set op de exact opgehaalde updated_at, in één verzoek per reeks; nooit een gedeelde grens", async () => {
    const [a, b, c] = ids(3);
    const t1 = "2026-10-20T08:00:00.123456+00:00";
    const t2 = "2026-10-20T09:00:00+00:00";
    await markPurchaseInvoicesExported({
      organizationId: "org-1", clientId: "c-1", invoiceIds: [a, b, c],
      fetchedUpdatedAt: new Map([[a, t1], [b, t2], [c, t1]]),
    });
    expect(callsFor("lte")).toHaveLength(0);
    expect(callsFor("eq").filter(x => x.args[0] === "updated_at")).toHaveLength(0);
    expect(callsFor("update")).toHaveLength(1);
    expect(callsFor("in").filter(x => x.args[0] === "id").map(x => x.args[1])).toEqual([[a, b, c]]);
    expect(callsFor("or").map(x => x.args[0])).toEqual([
      `and(id.eq."${a}",updated_at.eq."${t1}"),and(id.eq."${b}",updated_at.eq."${t2}"),and(id.eq."${c}",updated_at.eq."${t1}")`,
    ]);
  });

  it("Codex #299-2: 2300 facturen met elk een eigen updated_at → hooguit ceil(2300/N) verzoeken", async () => {
    const all = ids(2300);
    const ts = new Map(all.map((id, i) => [id, `2026-10-20T08:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(i).padStart(6, "0")}+00:00`]));
    expect(new Set(ts.values()).size).toBe(2300);
    await markPurchaseInvoicesExported({ organizationId: "org-1", clientId: "c-1", invoiceIds: all, fetchedUpdatedAt: ts });
    // Vaste bovengrens (N ≥ 25), los van de constante: f9e4cad deed hier 2300 verzoeken.
    expect(callsFor("update").length).toBeLessThanOrEqual(Math.ceil(2300 / 25));
    expect(callsFor("update").length).toBe(Math.ceil(2300 / STATUS_UPDATE_CAS_BATCH_SIZE));
  });

  it("H6-03: een factuur zonder opgehaalde updated_at wordt niet gemarkeerd (fail-closed) en wel gemeld", async () => {
    const [a, b] = ids(2);
    const err: any = await markPurchaseInvoicesExported({
      organizationId: "org-1", clientId: "c-1", invoiceIds: [a, b],
      fetchedUpdatedAt: new Map([[b, "2026-10-20T09:00:00+00:00"]]),
    }).catch(e => e);
    expect(callsFor("in").filter(x => x.args[0] === "id").map(x => x.args[1])).toEqual([[b]]);
    expect(err).toMatchObject({ marked: 1, expected: 2, unmarkedIds: [a] });
  });

  it("rejects when an update silently touches fewer rows (RLS, changed status) instead of reporting success", async () => {
    state.responses = [{ data: [{ id: "id-0" }], error: null }];
    await expect(
      markPurchaseInvoicesExported({ organizationId: "org-1", clientId: "c-1", invoiceIds: ids(3) }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/1 van 3/), marked: 1, expected: 3 });
  });
});

describe("export completion flow source guarantees", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/pages/Facturen.tsx"),
    "utf-8",
  );
  // Anchor on the handler itself so unrelated JSX below it cannot shift the window.
  const handlerStart = source.indexOf("const handleExportSnelstart");
  const handler = source.slice(handlerStart, handlerStart + 3000);

  it("aborts before fetching when no organization is active", () => {
    const guardIdx = handler.indexOf("if (!activeOrganizationId)");
    const fetchIdx = handler.indexOf("fetchAllExportablePurchaseInvoices");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });

  it("awaits all status batches before the success toast and invalidates once", () => {
    const awaitIdx = handler.indexOf("await markPurchaseInvoicesExported");
    const successToastIdx = handler.indexOf("geëxporteerd voor Snelstart");
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(successToastIdx).toBeGreaterThan(awaitIdx);
    // no fire-and-forget per-invoice updates remain
    expect(source).not.toContain('ids.forEach(id => updateInvoice.mutateAsync');
    // partial-failure message exists for the CSV-downloaded-but-update-failed case
    expect(handler).toContain("CSV gedownload, maar status bijwerken mislukt");
  });
});

describe("Facturen overview source guarantees", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/pages/Facturen.tsx"),
    "utf-8",
  );
  const hookSource = readFileSync(
    resolve(process.cwd(), "src/hooks/usePurchaseInvoices.ts"),
    "utf-8",
  );

  it("mounts without a full-list query: only the paginated hook is called", () => {
    // No call site of the unpaginated hook may remain (the word only appears
    // in the import path / derived hook names).
    expect(source).not.toMatch(/\busePurchaseInvoices\(/);
    expect(source).toMatch(/usePaginatedPurchaseInvoices\(/);
    // The batched full fetch may only run from the export click handler
    // (either inline or via a named handler that contains the call).
    const hasInlineClick = /onClick=\{async \(\) => \{[\s\S]*?fetchAllExportablePurchaseInvoices/.test(source);
    const hasNamedHandler = /const \w+\s*=\s*async[\s\S]*?fetchAllExportablePurchaseInvoices[\s\S]*?onClick=\{\w+/.test(source) ||
      (/onClick=\{\w+/.test(source) && /=\s*async \(\) =>[\s\S]*?fetchAllExportablePurchaseInvoices/.test(source));
    expect(hasInlineClick || hasNamedHandler).toBe(true);
  });

  it("no longer offers status as a sortable column", () => {
    expect(source).not.toContain('toggleSort("status")');
    expect(source).not.toContain('SortIcon field="status"');
    expect(source).toMatch(/type SortField = "supplier" \| "invoice_number" \| "date" \| "amount" \| "btw";/);
    expect(hookSource).toMatch(/PurchaseInvoiceSortField = "supplier" \| "invoice_number" \| "date" \| "amount" \| "btw";/);
    expect(hookSource).not.toMatch(/status:\s*"status"/);
  });

  it("shows no per-page chip counts", () => {
    expect(source).not.toContain("forPaymentCounts");
    expect(source).not.toContain("forWorkflowCounts");
    expect(source).not.toContain("forRouteCounts");
  });
});
