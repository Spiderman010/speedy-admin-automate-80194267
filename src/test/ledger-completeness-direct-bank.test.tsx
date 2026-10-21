import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Herstel P7 — A3-02 aan de app-kant: de volledigheidsmeter en het
 * openstaande bronwerk van de jaarafsluiting tellen ook de directe
 * bankschrijver (post_bank_transaction).
 *
 * Gedrag, geen tekst: de nep-client hieronder VOERT de filters uit die de
 * hooks meesturen (eq, neq, not is null, in), zodat een verkeerd of vergeten
 * filter een verkeerde telling oplevert in plaats van een groene test. De
 * fixture is de matrix van supabase/tests/close-bank-completeness, zodat app
 * en database aantoonbaar hetzelfde tellen.
 */

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const calls: Array<{ table: string; columns: string; head: boolean; filters: Array<[string, string, unknown]> }> = [];

function matches(row: Row, [col, op, val]: [string, string, unknown]): boolean {
  const v = row[col];
  switch (op) {
    case "eq":
      return v === val;
    case "neq":
      return typeof val === "number" ? Number(v) !== val : v !== val;
    case "in":
      return (val as unknown[]).includes(v);
    case "not.is":
      return val === null ? v !== null && v !== undefined : v !== val;
    default:
      return true;
  }
}

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u-1" } }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, columns: "", head: false, filters: [] as Array<[string, string, unknown]> };
      calls.push(call);
      let orderKey: string | null = null;
      const rows = () => (tables[table] ?? []).filter((r) => call.filters.every((f) => matches(r, f)));
      const b: Record<string, unknown> = {
        select: (columns: string, opts?: { head?: boolean }) => {
          call.columns = columns;
          call.head = !!opts?.head;
          return b;
        },
        eq: (c: string, v: unknown) => (call.filters.push([c, "eq", v]), b),
        neq: (c: string, v: unknown) => (call.filters.push([c, "neq", v]), b),
        not: (c: string, op: string, v: unknown) => (call.filters.push([c, `not.${op}`, v]), b),
        in: (c: string, v: unknown) => (call.filters.push([c, "in", v]), b),
        order: (c: string) => ((orderKey = c), b),
        range: async (from: number, to: number) => {
          const sorted = orderKey ? [...rows()].sort((x, y) => String(x[orderKey!]).localeCompare(String(y[orderKey!]))) : rows();
          // Alleen de geselecteerde kolommen terug: wie een kolom niet vraagt, krijgt haar niet.
          const cols = call.columns.split(",").map((c) => c.trim());
          return { data: sorted.slice(from, to + 1).map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))), error: null };
        },
        then: (res: (v: unknown) => unknown) => Promise.resolve({ count: rows().length, error: null }).then(res),
      };
      return b;
    },
  },
}));

import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  fetchRefusedSourceWork,
  fetchUnpostedSourceWork,
  useReportDocumentCompleteness,
} from "@/hooks/useUnpostedSourceWork";
import { fetchLedgerCompletenessCounts } from "@/hooks/useLedgerCompleteness";
import { computeLedgerCompleteness } from "@/lib/ledger-completeness";
import { LedgerCompletenessNotice } from "@/components/grootboek/LedgerCompletenessNotice";
import { bucketUnpostedWork, unpostedWorkThroughYear } from "@/lib/year-close-readiness";

const C = "c-1";
const tx = (id: string, o: Partial<Row>): Row => ({
  id,
  client_id: C,
  transaction_date: "2026-06-01",
  match_status: "handmatig_geboekt",
  grootboekrekening_id: "gb-4400",
  amount: -1210,
  ...o,
});

function seed() {
  for (const k of Object.keys(tables)) delete tables[k];
  calls.length = 0;
  tables.bank_transactions = [
    tx("t-open", {}), // K1: gecodeerd, ongeboekt → telt
    tx("t-geboekt", {}), // gecodeerd én geboekt (marker) → geboekt
    tx("t-zonder-rekening", { grootboekrekening_id: null }), // K3 → telt niet
    tx("t-nul", { amount: 0 }), // K4 → telt niet
    tx("t-suggestie", { match_status: "suggestie" }), // K5 → telt niet
    tx("t-ongecodeerd", { match_status: "niet_gematcht", grootboekrekening_id: null }), // K5/K11 → telt niet
    tx("t-gekoppeld", {}), // K6: gecodeerd met koppeling → afletteringstak
    tx("t-gematcht", { match_status: "gematcht", grootboekrekening_id: null, amount: 605 }), // K2 FD-N3 → telt niet (D7)
    tx("t-2027", { transaction_date: "2027-01-15" }), // K7: later jaar
    tx("t-ander", { client_id: "c-2" }), // andere administratie
  ];
  tables.bank_transaction_postings = [{ bank_transaction_id: "t-geboekt", client_id: C }];
  tables.bank_transaction_allocations = [
    { id: "a-1", client_id: C, bank_transaction_id: "t-gekoppeld", invoice_id: "pi-x", invoice_type: "inkoop" },
  ];
}

describe("A3-02 — het openstaande bronwerk van de jaarafsluiting telt de directe bankschrijver", () => {
  beforeEach(seed);

  it("1. alleen de gecodeerde, ongeboekte, ongekoppelde bankregels met rekening en bedrag ≠ 0 tellen — met hun eigen boekjaar", async () => {
    const items = await fetchUnpostedSourceWork(C);
    const bank = items.filter((i) => i.source === "bank_transaction");
    expect(bank).toEqual([
      { source: "bank_transaction", id: "t-2027", boekjaar: 2027 },
      { source: "bank_transaction", id: "t-open", boekjaar: 2026 },
    ]);
    // De gekoppelde regel staat er niet als directe regel; de aflettering telt
    // pas als haar factuur geboekt is (die is hier niet geboekt): niets dubbel.
    expect(items.some((i) => i.id === "t-gekoppeld" || i.id === "a-1")).toBe(false);
  });

  it("2. FD-N3 (ontwerpvraag D7): 'gematcht' zonder koppeling telt — net als in de database — niet mee", async () => {
    const items = await fetchUnpostedSourceWork(C);
    expect(items.map((i) => i.id)).not.toContain("t-gematcht");
  });

  it("3. de gereedheid blokkeert 2026 op de open bankregel, en 2025 niet; de regel van 2027 telt alleen 'later'", async () => {
    const items = await fetchUnpostedSourceWork(C);
    const b2026 = bucketUnpostedWork(items, 2026);
    expect(b2026).toEqual({ throughYear: 1, afterYear: 1, unknownYear: 0 });
    const check = unpostedWorkThroughYear(2026, b2026);
    expect(check.severity).toBe("error");
    expect(check.summary).toMatch(/1 postbaar brondocument is nog niet geboekt met boekjaar t\/m 2026/);
    expect(unpostedWorkThroughYear(2025, bucketUnpostedWork(items, 2025)).severity).toBe("ok");
  });

  it("4. de queries lezen geen bedragkolom: het bedrag is uitsluitend een filter (neq 0) in de database", async () => {
    await fetchUnpostedSourceWork(C);
    const bankList = calls.filter((c) => c.table === "bank_transactions" && c.filters.some((f) => f[0] === "match_status"));
    expect(bankList.length).toBeGreaterThan(0);
    for (const c of bankList) {
      expect(c.columns).not.toMatch(/amount/);
      expect(c.filters).toContainEqual(["match_status", "eq", "handmatig_geboekt"]);
      expect(c.filters).toContainEqual(["grootboekrekening_id", "not.is", null]);
      expect(c.filters).toContainEqual(["amount", "neq", 0]);
      expect(c.filters).toContainEqual(["client_id", "eq", C]);
    }
  });
});

describe("A3-02 — de volledigheidsmeter heeft een vijfde bron: gecodeerde bankregels", () => {
  beforeEach(seed);

  it("5. fetchLedgerCompletenessCounts telt postbaar = gecodeerd zonder koppeling, geboekt = met marker", async () => {
    const c = await fetchLedgerCompletenessCounts(C);
    // t-open, t-geboekt en t-2027 zijn postbaar; t-geboekt heeft een marker.
    expect(c.bankDirect).toEqual({ eligible: 3, posted: 1 });
    for (const call of calls) expect(call.columns).not.toMatch(/amount|total|bedrag/);
  });

  it("6. de meter zegt 'mogelijk onvolledig' en noemt de bankregels met hun aantal", async () => {
    const counts = await fetchLedgerCompletenessCounts(C);
    const completeness = computeLedgerCompleteness(counts);
    const bron = completeness.sources.find((s) => s.key === "bank_transaction")!;
    expect(bron).toMatchObject({ label: "Gecodeerde bankregels", eligible: 3, posted: 1, outstanding: 2, status: "incomplete" });
    expect(completeness.mayBeIncomplete).toBe(true);

    render(<LedgerCompletenessNotice completeness={completeness} />);
    const meter = screen.getByTestId("ledger-completeness");
    expect(meter).toHaveAttribute("data-status", "incomplete");
    expect(meter).toHaveTextContent("mogelijk onvolledig");
    const rij = screen.getByTestId("completeness-bank_transaction");
    expect(rij).toHaveTextContent("Gecodeerde bankregels");
    expect(rij).toHaveTextContent("1 / 3");
    expect(rij).toHaveTextContent("2 nog niet geboekt");
  });

  it("7. zijn alle gecodeerde regels geboekt, dan is die bron volledig — en zonder enige regel 'geen'", async () => {
    tables.bank_transaction_postings = [
      { bank_transaction_id: "t-geboekt", client_id: C },
      { bank_transaction_id: "t-open", client_id: C },
      { bank_transaction_id: "t-2027", client_id: C },
    ];
    const vol = computeLedgerCompleteness(await fetchLedgerCompletenessCounts(C));
    expect(vol.sources.find((s) => s.key === "bank_transaction")!.status).toBe("complete");

    tables.bank_transactions = [];
    tables.bank_transaction_postings = [];
    const leeg = computeLedgerCompleteness(await fetchLedgerCompletenessCounts(C));
    expect(leeg.sources.find((s) => s.key === "bank_transaction")!.status).toBe("empty");
  });

  it("8. een marker zonder postbare regel maakt de bron 'onbekend', nooit 'volledig'", () => {
    const c = computeLedgerCompleteness({
      purchase: { eligible: 0, posted: 0 },
      sales: { eligible: 0, posted: 0, refusedVerlegd: 0 },
      bank: { eligible: 0, posted: 0, awaitingInvoice: 0 },
      bankDirect: { eligible: 1, posted: 2 },
      manual: { total: 0, posted: 0 },
    });
    expect(c.sources.find((s) => s.key === "bank_transaction")!.status).toBe("unknown");
    expect(c.mayBeIncomplete).toBe(true);
  });
});

describe("A3-11 — het bronwerk per rapport, door de echte hooks", () => {
  beforeEach(() => {
    seed();
    tables.sales_invoices = [
      { id: "si-verlegd", client_id: C, status: "gecontroleerd", btw_verlegd: true, invoice_date: "2026-05-01" },
      { id: "si-verlegd-concept", client_id: C, status: "concept", btw_verlegd: true, invoice_date: "2026-05-02" },
      { id: "si-gewoon", client_id: C, status: "gecontroleerd", btw_verlegd: false, invoice_date: "2026-05-03" },
    ];
    tables.sales_invoice_postings = [{ sales_invoice_id: "si-gewoon", client_id: C }];
  });

  it("9. fetchRefusedSourceWork: alleen postbare verkoopfacturen met verlegde btw, mét boekjaar, zonder bedrag", async () => {
    const items = await fetchRefusedSourceWork(C);
    expect(items).toEqual([{ source: "sales_invoice", id: "si-verlegd", boekjaar: 2026, reason: "btw_verlegd" }]);
    const call = calls.find((c) => c.table === "sales_invoices")!;
    expect(call.filters).toContainEqual(["btw_verlegd", "eq", true]);
    expect(call.columns).not.toMatch(/amount/);
  });

  it("10. useReportDocumentCompleteness: balans 2026 telt de open bankregel en de verlegde factuur; 2025 niets", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result: r2026 } = renderHook(
      () => useReportDocumentCompleteness(C, { from: "2026-01-01", toExclusive: "2027-01-01" }, "balans"),
      { wrapper },
    );
    await waitFor(() => expect(r2026.current.data).toBeDefined());
    expect(r2026.current.isError).toBe(false);
    expect(r2026.current.data!.summary).toBe("1 bankregel nog niet geboekt; 1 verkoopfactuur met verlegde btw kan niet worden geboekt");

    const { result: r2025 } = renderHook(
      () => useReportDocumentCompleteness(C, { from: "2025-01-01", toExclusive: "2026-01-01" }, "balans"),
      { wrapper },
    );
    await waitFor(() => expect(r2025.current.data).toBeDefined());
    expect(r2025.current.data!.status).toBe("complete");
  });
});
