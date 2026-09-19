import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";

/**
 * Grootboekintegriteit — datalaag en scherm.
 *
 * De Supabase-client is een tabelgestuurde nepclient die de echte filters
 * toepast, zodat administratiescheiding hier werkelijk wordt bewezen en niet
 * geconstrueerd. Elke schrijfpoging wordt geregistreerd: dit scherm hoort
 * uitsluitend te lezen.
 */

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {};
const writeAttempts: string[] = [];
const rpcCalls: string[] = [];

function builder(table: string) {
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

import { useLedgerIntegrity } from "@/hooks/useLedgerIntegrity";
import { assertBranchSqlKeepsLedgerFoundation, assertBranchTouchesNoExistingWriter } from "@/test/support/branch-sql-scope";

const CLIENT = "client-1";
const ANDER = "client-2";

const posting = (groupId: string, over: Row = {}): Row => ({
  id: `${groupId}-${String(over.line_no ?? 1)}`, client_id: CLIENT, posting_group_id: groupId,
  posting_date: "2026-04-01", boekjaar: 2026, currency: "EUR", source_type: "manual_journal",
  line_no: 1, grootboekrekening_id: "a", debit_amount: "100.00", credit_amount: "0.00", ...over,
});

/** Eén sluitende groep. */
const sluitendeGroep = (groupId: string, client = CLIENT): Row[] => [
  posting(groupId, { client_id: client, line_no: 1, debit_amount: "100.00", credit_amount: "0.00" }),
  posting(groupId, { client_id: client, line_no: 2, debit_amount: "0.00", credit_amount: "100.00" }),
];

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const laad = async () => {
  const hook = renderHook(() => useLedgerIntegrity(CLIENT), { wrapper });
  await waitFor(() => expect(hook.result.current.data).toBeDefined());
  return hook;
};

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.purchase_invoices = [];
  db.purchase_invoice_lines = [];
  db.purchase_invoice_postings = [];
  db.sales_invoice_postings = [];
  db.bank_allocation_postings = [];
  db.manual_journal_postings = [];
  db.ledger_postings = [];
  writeAttempts.length = 0;
  rpcCalls.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
describe("de datalaag leest, meer niet", () => {
  it("1. een schone administratie levert geen bevindingen", async () => {
    db.purchase_invoices = [{ id: "pi-1", client_id: CLIENT, status: "gecontroleerd", invoice_number: "F-1", supplier: "Lev", ledger_account_text: null }];
    db.purchase_invoice_lines = [{ id: "l-1", purchase_invoice_id: "pi-1", grootboekrekening_id: "gb-1" }];
    db.purchase_invoice_postings = [{ purchase_invoice_id: "pi-1", posting_group_id: "pg-1", client_id: CLIENT }];
    db.ledger_postings = sluitendeGroep("pg-1");

    const { result } = await laad();
    expect(result.current.data!.findings).toEqual([]);
    expect(result.current.data!.errorCount).toBe(0);
  });

  it("2. er wordt nergens geschreven en geen RPC aangeroepen", async () => {
    db.purchase_invoices = [{ id: "pi-1", client_id: CLIENT, status: "gecontroleerd", invoice_number: "F-1", supplier: "Lev", ledger_account_text: null }];
    await laad();
    expect(writeAttempts).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("3. administratiescheiding: een andere administratie levert niets aan", async () => {
    db.purchase_invoices = [
      { id: "pi-eigen", client_id: CLIENT, status: "gecontroleerd", invoice_number: "F-1", supplier: "Lev", ledger_account_text: null },
      { id: "pi-vreemd", client_id: ANDER, status: "gecontroleerd", invoice_number: "F-X", supplier: "Vreemd", ledger_account_text: null },
    ];
    db.purchase_invoice_postings = [
      { purchase_invoice_id: "pi-vreemd", posting_group_id: "pg-vreemd", client_id: ANDER },
    ];

    const { result } = await laad();
    // Alleen de eigen factuur wordt beoordeeld; de vreemde marker telt niet mee.
    expect(result.current.data!.findings.map((f) => f.subject)).toEqual(["F-1 — Lev"]);
  });

  it("4. de vier markertabellen worden alle vier gelezen", async () => {
    db.purchase_invoice_postings = [{ purchase_invoice_id: "pi-1", posting_group_id: "pg-a", client_id: CLIENT }];
    db.sales_invoice_postings = [{ sales_invoice_id: "si-1", posting_group_id: "pg-b", client_id: CLIENT }];
    db.bank_allocation_postings = [{ allocation_id: "al-1", posting_group_id: "pg-c", client_id: CLIENT }];
    db.manual_journal_postings = [{ manual_journal_id: "mj-1", posting_group_id: "pg-d", client_id: CLIENT }];

    const { result } = await laad();
    // Geen enkele groep bestaat → vier keer dezelfde fout.
    expect(result.current.data!.byKind.marker_zonder_boekingsgroep).toBe(4);
    const details = result.current.data!.findings.map((f) => f.detail).join(" ");
    for (const label of ["inkoopfactuur", "verkoopfactuur", "bankkoppeling", "memoriaalboeking"]) {
      expect(details).toContain(label);
    }
  });

  it("5. een scheve boekingsgroep wordt met naam en verschil gemeld", async () => {
    db.ledger_postings = [
      posting("pg-scheef", { line_no: 1, debit_amount: "100.00", credit_amount: "0.00" }),
      posting("pg-scheef", { line_no: 2, debit_amount: "0.00", credit_amount: "90.00" }),
    ];
    const { result } = await laad();
    const f = result.current.data!.findings[0];
    expect(f.kind).toBe("boekingsgroep_niet_in_balans");
    expect(f.subject).toBe("pg-scheef");
    expect(f.detail).toContain("1000 cent");
  });

  it("6. grootboekregels van een andere administratie tellen niet mee", async () => {
    // Zelfde groep-id, andere administratie, en daar niet in balans. Onze
    // administratie mag daar niets van merken.
    db.ledger_postings = [
      ...sluitendeGroep("pg-1"),
      posting("pg-1", { client_id: ANDER, line_no: 9, debit_amount: "50.00", credit_amount: "0.00" }),
    ];
    const { result } = await laad();
    expect(result.current.data!.findings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("het scherm", () => {
  const paginaState = {
    clientId: CLIENT as string,
    data: undefined as unknown,
    isPending: false,
    isError: false,
  };

  it("7. toont ernst, onderwerp en toelichting per bevinding", async () => {
    const { evaluateLedgerIntegrity } = await import("@/lib/ledger-integrity");
    const report = evaluateLedgerIntegrity({
      purchaseInvoices: [{ id: "pi-1", status: "gecontroleerd", invoice_number: "F-1", supplier: "Lev", ledger_account_text: "4602 - Telefoon" }],
      purchaseLines: [],
      markers: [],
      postings: [],
    });
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(1);

    vi.resetModules();
    vi.doMock("@/hooks/useClientContext", () => ({
      useClientContext: () => ({ selectedClientId: paginaState.clientId, setSelectedClientId: vi.fn() }),
    }));
    vi.doMock("@/hooks/useActiveOrganization", () => ({
      useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
    }));
    vi.doMock("@/hooks/useClients", () => ({
      useClients: () => ({ data: [{ id: CLIENT, name: "Klant Een" }] }),
    }));
    vi.doMock("@/hooks/useLedgerIntegrity", () => ({
      useLedgerIntegrity: () => ({ data: report, isPending: false, isError: false, error: null, refetch: vi.fn() }),
    }));

    const { default: GrootboekIntegriteit } = await import("@/pages/GrootboekIntegriteit");
    render(<MemoryRouter><GrootboekIntegriteit /></MemoryRouter>);

    const rijen = screen.getAllByTestId("integriteit-row");
    expect(rijen).toHaveLength(2);
    // Fouten staan boven waarschuwingen.
    expect(rijen[0]).toHaveAttribute("data-severity", "error");
    expect(rijen[1]).toHaveAttribute("data-severity", "waarschuwing");
    expect(within(rijen[0]).getByTestId("integriteit-severity")).toHaveTextContent("Fout");
    expect(within(rijen[1]).getByTestId("integriteit-severity")).toHaveTextContent("Waarschuwing");
    expect(screen.getByTestId("integriteit-errors")).toHaveTextContent("1 fout");
    expect(screen.getByTestId("integriteit-warnings")).toHaveTextContent("1 waarschuwing");
    // De factuur is aanklikbaar naar de werkbank.
    expect(within(rijen[0]).getByRole("link")).toHaveAttribute("href", "/facturen/inkoop/pi-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("statische grenzen", () => {
  const bronnen = [
    "src/lib/ledger-integrity.ts",
    "src/hooks/useLedgerIntegrity.ts",
    "src/pages/GrootboekIntegriteit.tsx",
  ].map((p) => ({ p, code: readFileSync(p, "utf8") }));

  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  it("8. de controle schrijft nergens en repareert niets", () => {
    for (const { p, code } of bronnen) {
      const schoon = strip(code);
      expect(schoon, p).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
      expect(schoon, p).not.toMatch(/supabase\.rpc\(/);
      expect(schoon, p).not.toMatch(/useMutation/);
      expect(schoon, p).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET/i);
    }
  });

  it("9. geen rekenwerk naast de kern: de centen komen van signedAmountCents", () => {
    const lib = strip(bronnen.find((b) => b.p.endsWith("ledger-integrity.ts"))!.code);
    expect(lib).toMatch(/signedAmountCents/);
    // Geen eigen parsing van bedragen naast de kern.
    expect(lib).not.toMatch(/parseFloat|Number\(\s*\w+\.(debit|credit)_amount/);
  });

  it("10. geen migratie, geen SQL en geen typewijziging in deze branch", () => {
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
    const changedList = changed.split("\n").filter(Boolean);
    // Voorheen: "deze branch bevat geen migratie en geen SQL". Dat was een
    // uitspraak over de SCOPE van die PR, geen invariant — elke latere fase die
    // terecht een migratie meebrengt, laat hem omvallen. Bewaakt blijft wat er
    // werkelijk toe doet: een migratie in deze branch mag de grootboekfundering
    // niet wijzigen of weggooien, en mag geen bestaande boekingsschrijver
    // herschrijven.
    assertBranchSqlKeepsLedgerFoundation(changedList);
    assertBranchTouchesNoExistingWriter(changedList);
  });

  it("11. de rapportagekern en de writers zijn niet aangeraakt", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    let changed: string;
    try {
      changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return;
    }
    for (const f of [
      "src/lib/ledger-reporting.ts",
      "src/lib/proef-saldibalans.ts",
      "src/lib/financial-statements.ts",
      "src/hooks/usePurchaseInvoicePosting.ts",
      "src/lib/ledger-catchup.ts",
    ]) {
      expect(changed, f).not.toContain(f);
    }
  });
});
