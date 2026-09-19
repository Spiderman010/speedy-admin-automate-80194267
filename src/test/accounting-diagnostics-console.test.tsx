import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";

/**
 * Accounting Diagnostics — datalaag en console.
 *
 * De Supabase-client is een tabelgestuurde nepclient die de echte filters
 * toepast, zodat administratiescheiding hier werkelijk wordt bewezen. Elke
 * schrijfpoging wordt geregistreerd: deze console hoort uitsluitend te lezen.
 */

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {};
const writeAttempts: string[] = [];
const rpcCalls: string[] = [];
const queriedTables: string[] = [];

function builder(table: string) {
  queriedTables.push(table);
  const filters: ((r: Row) => boolean)[] = [];
  let from = 0;
  let to = Number.MAX_SAFE_INTEGER;
  const resolve = () => ({
    data: (db[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(from, to + 1),
    error: null,
  });
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, value: unknown) => { filters.push((r) => r[col] === value); return api; },
    in: (col: string, values: unknown[]) => { filters.push((r) => values.includes(r[col])); return api; },
    or: () => api,
    lt: (col: string, value: string) => { filters.push((r) => String(r[col]) < value); return api; },
    order: () => api,
    range: (a: number, b: number) => { from = a; to = b; return api; },
    maybeSingle: () => Promise.resolve({ data: resolve().data[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve(resolve()).then(ok),
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
    rpc: (fn: string) => { rpcCalls.push(fn); return Promise.resolve({ data: null, error: null }); },
  },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));

import { useAccountingDiagnostics } from "@/hooks/useAccountingDiagnostics";

const CLIENT = "client-1";
const ANDER = "client-2";

const client = (over: Row = {}) => ({
  id: CLIENT, afgesloten_boekjaar: null, crediteuren_rekening_id: "cred", debiteuren_rekening_id: "deb",
  btw_te_vorderen_rekening_id: "btwv", btw_te_betalen_rekening_id: "btwb", ...over,
});

const pi = (over: Row = {}) => ({
  id: "pi-1", client_id: CLIENT, status: "gecontroleerd", invoice_date: "2026-03-01",
  invoice_number: "F-1", supplier: "Lev BV", amount_excl: 100, amount_incl: 121, btw_amount: 21, ...over,
});

const si = (over: Row = {}) => ({
  id: "si-1", client_id: CLIENT, status: "gecontroleerd", invoice_date: "2026-03-01",
  invoice_number: "V-1", customer_name: "Klant BV", amount_excl: 200, amount_incl: 242,
  btw_amount: 42, btw_verlegd: false, grootboekrekening_id: "gb-omzet", ...over,
});

const line = (invoiceId: string, over: Row = {}) => ({
  id: `l-${invoiceId}`, purchase_invoice_id: invoiceId, amount_excl: 100, grootboekrekening_id: "gb-1", ...over,
});

const groep = (id: string, client_id = CLIENT, credit = "100.00") => [
  { id: `${id}-1`, client_id, posting_group_id: id, posting_date: "2026-04-01", boekjaar: 2026,
    currency: "EUR", source_type: "manual_journal", line_no: 1, grootboekrekening_id: "gb-1",
    debit_amount: "100.00", credit_amount: "0.00" },
  { id: `${id}-2`, client_id, posting_group_id: id, posting_date: "2026-04-01", boekjaar: 2026,
    currency: "EUR", source_type: "manual_journal", line_no: 2, grootboekrekening_id: "gb-1",
    debit_amount: "0.00", credit_amount: credit },
];

const GB = [
  { id: "gb-1", nummer: 4400, omschrijving: "Kantoorkosten", client_id: null, statement_type: "winst_verlies", report_group: "overige_bedrijfskosten" },
  { id: "gb-omzet", nummer: 8000, omschrijving: "Omzet", client_id: null, statement_type: "winst_verlies", report_group: "netto_omzet" },
];

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Radix schakelt van tabblad op mouseDown, niet op click. */
function openTab(naam: string) {
  const trigger = screen.getByRole("tab", { name: naam });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
}

const laad = async () => {
  const hook = renderHook(() => useAccountingDiagnostics(CLIENT), { wrapper });
  await waitFor(() => expect(hook.result.current.data).toBeDefined());
  return hook;
};

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.clients = [client(), { ...client(), id: ANDER }];
  db.purchase_invoices = [];
  db.purchase_invoice_lines = [];
  db.sales_invoices = [];
  db.purchase_invoice_postings = [];
  db.sales_invoice_postings = [];
  db.bank_allocation_postings = [];
  db.manual_journal_postings = [];
  db.ledger_postings = [];
  db.grootboekrekeningen = [...GB];
  writeAttempts.length = 0;
  rpcCalls.length = 0;
  queriedTables.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
describe("datalaag", () => {
  it("1. leest alleen: geen enkele schrijfpoging of RPC", async () => {
    db.purchase_invoices = [pi()];
    db.purchase_invoice_lines = [line("pi-1")];
    await laad();
    expect(writeAttempts).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("2. administratiescheiding: documenten van een andere administratie tellen niet mee", async () => {
    db.purchase_invoices = [pi(), pi({ id: "pi-vreemd", client_id: ANDER, invoice_number: "F-X" })];
    db.sales_invoices = [si(), si({ id: "si-vreemd", client_id: ANDER })];
    db.purchase_invoice_lines = [line("pi-1"), line("pi-vreemd")];

    const { result } = await laad();
    expect(result.current.data!.purchase.summary.total).toBe(1);
    expect(result.current.data!.sales.summary.total).toBe(1);
    const refs = result.current.data!.purchase.items.map((i) => i.reference);
    expect(refs).not.toContain("F-X");
  });

  it("3. grootboekregels van een andere administratie beïnvloeden de balans niet", async () => {
    db.ledger_postings = [...groep("pg-1"), ...groep("pg-1", ANDER, "50.00")];
    const { result } = await laad();
    expect(result.current.data!.ledger.summary.unbalancedGroups).toBe(0);
    expect(result.current.data!.ledger.summary.balancedGroups).toBe(1);
  });

  it("4. geen N+1: elke tabel wordt in batches bevraagd, niet per document", async () => {
    db.purchase_invoices = [pi({ id: "pi-1" }), pi({ id: "pi-2" }), pi({ id: "pi-3" })];
    db.purchase_invoice_lines = [line("pi-1"), line("pi-2"), line("pi-3")];
    await laad();
    // Drie facturen, maar de regeltabel wordt niet drie keer per factuur
    // bevraagd: één id-blok, dat doorpagineert tot een lege batch.
    const lineQueries = queriedTables.filter((t) => t === "purchase_invoice_lines").length;
    expect(lineQueries).toBeLessThanOrEqual(4);
    expect(queriedTables.filter((t) => t === "purchase_invoices").length).toBeLessThanOrEqual(4);
  });

  it("5. de vier domeinvragen worden beantwoord uit opgeslagen gegevens", async () => {
    db.purchase_invoices = [
      pi({ id: "pi-kapot" }),                                   // geen regels → fout
      pi({ id: "pi-klaar" }),                                   // klaar
      pi({ id: "pi-geboekt" }),                                 // geboekt
    ];
    db.purchase_invoice_lines = [line("pi-klaar"), line("pi-geboekt")];
    db.purchase_invoice_postings = [{ purchase_invoice_id: "pi-geboekt", posting_group_id: "pg-1", client_id: CLIENT }];
    db.sales_invoices = [si({ id: "si-klaar" }), si({ id: "si-kapot", grootboekrekening_id: null })];
    db.ledger_postings = groep("pg-1");

    const { result } = await laad();
    const d = result.current.data!;
    expect(d.purchase.summary).toMatchObject({ total: 3, posted: 1, ready: 1, blocked: 1 });
    expect(d.sales.summary).toMatchObject({ total: 2, ready: 1, blocked: 1 });
    expect(d.ledger.summary.postingGroups).toBe(1);
    expect(d.ledger.summary.balancedGroups).toBe(1);
    expect(d.ledger.summary.orphanMarkers).toBe(0);
  });

  it("6. wees-marker en onbalans komen in het grootboekdomein terecht", async () => {
    db.purchase_invoice_postings = [{ purchase_invoice_id: "pi-x", posting_group_id: "pg-weg", client_id: CLIENT }];
    db.ledger_postings = groep("pg-scheef", CLIENT, "90.00");

    const { result } = await laad();
    const codes = result.current.data!.ledger.items.map((i) => i.code);
    expect(codes).toContain("marker_zonder_boekingsgroep");
    expect(codes).toContain("boekingsgroep_niet_in_balans");
    expect(result.current.data!.ledger.summary.unbalancedGroups).toBe(1);
  });

  it("7. rekening met activiteit zonder classificatie → waarschuwing", async () => {
    db.grootboekrekeningen = [{ ...GB[0], statement_type: null, report_group: null }, GB[1]];
    db.ledger_postings = groep("pg-1");

    const { result } = await laad();
    const item = result.current.data!.ledger.items.find((i) => i.code === "activiteit_zonder_classificatie")!;
    expect(item.severity).toBe("warning");
    expect(item.reference).toBe("4400 - Kantoorkosten");
    expect(result.current.data!.ledger.summary.accountsMissingClassification).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("de console", () => {
  async function renderConsole(data: unknown) {
    vi.resetModules();
    vi.doMock("@/hooks/useClientContext", () => ({
      useClientContext: () => ({ selectedClientId: CLIENT, setSelectedClientId: vi.fn() }),
    }));
    vi.doMock("@/hooks/useActiveOrganization", () => ({
      useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
    }));
    vi.doMock("@/hooks/useClients", () => ({
      useClients: () => ({ data: [{ id: CLIENT, name: "Klant Een" }] }),
    }));
    const refetch = vi.fn();
    vi.doMock("@/hooks/useAccountingDiagnostics", () => ({
      useAccountingDiagnostics: () => ({ data, isPending: false, isError: false, isFetching: false, error: null, refetch }),
    }));
    const { default: DiagnosticsAccounting } = await import("@/pages/DiagnosticsAccounting");
    render(<MemoryRouter><DiagnosticsAccounting /></MemoryRouter>);
    return { refetch };
  }

  /** Echte diagnostiek, via de échte evaluatoren — geen verzonnen toestanden. */
  async function echteData() {
    const { evaluatePurchaseInvoice, evaluateSalesInvoice, aggregateInvoiceLines } =
      await import("@/lib/ledger-catchup");
    const { diagnosticsForDocument, summarizeDiagnostics, summarizeLedger, diagnosticsForLedger, postingGroupBalances } =
      await import("@/lib/accounting-diagnostics");
    const config = {
      id: CLIENT, afgesloten_boekjaar: null, crediteuren_rekening_id: "cred", debiteuren_rekening_id: "deb",
      btw_te_vorderen_rekening_id: "btwv", btw_te_betalen_rekening_id: "btwb",
    };
    const records = [
      evaluatePurchaseInvoice({ invoice: pi() as never, config, lines: aggregateInvoiceLines([]), postingGroupId: null }),
      evaluatePurchaseInvoice({ invoice: pi({ id: "pi-2" }) as never, config, lines: aggregateInvoiceLines([{ amount_excl: 100, grootboekrekening_id: "gb-1" }]), postingGroupId: null }),
    ];
    const ctx = { existingPostingGroups: new Set<string>(), balancedPostingGroups: new Set<string>() };
    const items = records.flatMap((r) => diagnosticsForDocument(r, ctx));
    const salesRecords = [evaluateSalesInvoice({ invoice: si() as never, config, postingGroupId: null })];
    const salesItems = salesRecords.flatMap((r) => diagnosticsForDocument(r, ctx));
    return {
      purchase: { items, summary: summarizeDiagnostics(items, records) },
      sales: { items: salesItems, summary: summarizeDiagnostics(salesItems, salesRecords) },
      ledger: { items: diagnosticsForLedger({ integrityFindings: [], postings: [], accounts: [], clientId: CLIENT, markerClaimsPerGroup: new Map() }), summary: summarizeLedger([], postingGroupBalances([])) },
    };
  }

  it("8. het overzicht toont dezelfde aantallen als de detailtabbladen", async () => {
    const data = await echteData();
    await renderConsole(data);

    expect(within(screen.getByTestId("inkoop-totaal")).getByText("2")).toBeInTheDocument();
    expect(within(screen.getByTestId("inkoop-klaar")).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByTestId("inkoop-zonder-regels")).getByText("1")).toBeInTheDocument();

    // En het detailtabblad toont exact die items.
    openTab("Inkoop");
    const rijen = await screen.findAllByTestId("diagnostic-row");
    expect(rijen).toHaveLength(data.purchase.items.length);
    expect(rijen[0]).toHaveAttribute("data-severity", "error");
    expect(rijen[0]).toHaveAttribute("data-code", "geen_boekingsregels");
  });

  it("9. fouten staan boven waarschuwingen en het onderwerp linkt naar de bron", async () => {
    await renderConsole(await echteData());
    openTab("Inkoop");
    const rijen = await screen.findAllByTestId("diagnostic-row");
    const ernst = rijen.map((r) => r.getAttribute("data-severity"));
    expect(ernst.indexOf("error")).toBeLessThan(ernst.lastIndexOf("warning"));
    expect(within(rijen[0]).getByRole("link")).toHaveAttribute("href", "/facturen/inkoop/pi-1");
  });

  it("10. de verversknop is de enige actie", async () => {
    const { refetch } = await renderConsole(await echteData());
    fireEvent.click(screen.getByTestId("diagnostics-refresh"));
    expect(refetch).toHaveBeenCalledTimes(1);
    // Geen enkele andere knop die iets zou wijzigen.
    const knoppen = screen.getAllByRole("button").map((b) => b.textContent?.toLowerCase() ?? "");
    for (const tekst of knoppen) {
      expect(tekst).not.toMatch(/boek|herstel|repareer|corrigeer|verwijder/);
    }
  });

  it("11. een schoon domein zegt dat ook", async () => {
    const leeg = await echteData();
    await renderConsole({ ...leeg, ledger: { items: [], summary: leeg.ledger.summary } });
    openTab("Grootboek");
    expect(await screen.findByTestId("tabel-grootboek-clean")).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("statische grenzen", () => {
  const bronnen = [
    "src/lib/accounting-diagnostics.ts",
    "src/hooks/useAccountingDiagnostics.ts",
    "src/pages/DiagnosticsAccounting.tsx",
  ].map((p) => ({ p, code: readFileSync(p, "utf8") }));

  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  it("12. geen schrijfpad, geen mutatie, geen RPC", () => {
    for (const { p, code } of bronnen) {
      const schoon = strip(code);
      expect(schoon, p).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
      expect(schoon, p).not.toMatch(/supabase\.rpc\(/);
      expect(schoon, p).not.toMatch(/useMutation/);
      expect(schoon, p).not.toMatch(/ledger_postings["']\s*\)\s*\.\s*(insert|update|delete)/);
    }
  });

  it("13. geen tweede regelset: de beoordeling komt uit de bestaande lagen", () => {
    const lib = strip(bronnen.find((b) => b.p.endsWith("accounting-diagnostics.ts"))!.code);
    expect(lib).toMatch(/from "\.\/ledger-catchup"/);
    expect(lib).toMatch(/from "\.\/ledger-integrity"/);
    expect(lib).toMatch(/isClassified/);
    expect(lib).toMatch(/signedAmountCents/);
    // Geen eigen statuslijsten of eigen bedragparsing naast de bestaande.
    expect(lib).not.toMatch(/\["gecontroleerd",\s*"betaald"/);
    expect(lib).not.toMatch(/parseFloat|Number\(\s*\w+\.(debit|credit)_amount/);
  });

  it("14. geen classificatie uit rekeningnummer of categorie", () => {
    for (const { p, code } of bronnen) {
      const schoon = strip(code);
      expect(schoon, p).not.toMatch(/\bcategorie\b/);
      expect(schoon, p).not.toMatch(/nummer\s*[<>]=?\s*\d/);
      expect(schoon, p).not.toMatch(/\b(1100|1300|1520|1600|1799)\b/);
    }
  });

  it("15. geen periodefilter op de invariantcontroles", () => {
    const hook = strip(bronnen.find((b) => b.p.endsWith("useAccountingDiagnostics.ts"))!.code);
    // fetchLedgerPostings wordt zonder period aangeroepen.
    expect(hook).toMatch(/fetchLedgerPostings\(\{\s*clientId\s*\}\)/);
    expect(hook).not.toMatch(/period:/);
  });

  it("16. geen migratie, geen SQL, geen typewijziging", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    let changed: string;
    try {
      changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return;
    }
    expect(changed).not.toMatch(/integrations\/supabase\/types\.ts/);
    expect(changed.split("\n").filter((f) => f.startsWith("supabase/") || f.endsWith(".sql"))).toEqual([]);
    // De bestaande regel- en rapportagelagen blijven ongemoeid.
    for (const f of [
      "src/lib/ledger-catchup.ts", "src/lib/ledger-integrity.ts", "src/lib/ledger-reporting.ts",
      "src/lib/reporting-classification.ts", "src/pages/GrootboekIntegriteit.tsx",
    ]) {
      expect(changed, f).not.toContain(f);
    }
  });
});
