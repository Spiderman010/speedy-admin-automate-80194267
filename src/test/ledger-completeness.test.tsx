import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeLedgerCompleteness,
  unknownLedgerCompleteness,
  PURCHASE_POSTABLE_STATUSES,
  SALES_POSTABLE_STATUSES,
} from "@/lib/ledger-completeness";
import { LedgerCompletenessNotice } from "@/components/grootboek/LedgerCompletenessNotice";
import { inclusiveEndToExclusive, exclusiveEndToInclusive, periodFromSelection, periodLabel } from "@/lib/grootboek-saldi-utils";

/**
 * Fase 6C-b7 PR 2 — volledigheid: pure tellingen, de melding, en de
 * telhook (gemockte supabase). Nooit een bedrag.
 */

const base = () => ({
  purchase: { eligible: 10, posted: 7 },
  sales: { eligible: 5, posted: 5, refusedVerlegd: 2 },
  bank: { eligible: 4, posted: 4, awaitingInvoice: 3 },
  manual: { total: 2, posted: 1 },
});

describe("computeLedgerCompleteness", () => {
  it("24. inkoop: geboekt / postbaar, met eerlijke kanttekening over verlegde BTW", () => {
    const c = computeLedgerCompleteness(base());
    const s = c.sources.find((x) => x.key === "purchase_invoice")!;
    expect(s).toMatchObject({ posted: 7, eligible: 10, outstanding: 3, status: "incomplete", refused: null });
    expect(s.note).toMatch(/Verlegde BTW op inkoop is niet herkenbaar/);
    expect(c.mayBeIncomplete).toBe(true);
    expect(c.totalOutstanding).toBe(3 + 0 + 0 + 1);
  });

  it("25. verkoop: geboekt / postbaar", () => {
    const s = computeLedgerCompleteness(base()).sources.find((x) => x.key === "sales_invoice")!;
    expect(s).toMatchObject({ posted: 5, eligible: 5, outstanding: 0, status: "complete" });
  });

  it("26. bank: alleen koppelingen met een geboekte factuur zijn postbaar; wachtende apart benoemd", () => {
    const s = computeLedgerCompleteness(base()).sources.find((x) => x.key === "bank_allocation")!;
    expect(s).toMatchObject({ posted: 4, eligible: 4, status: "complete" });
    expect(s.note).toBe("3 koppelingen wachten op het boeken van de factuur.");
  });

  it("27. memoriaal: geboekt / totaal", () => {
    const s = computeLedgerCompleteness(base()).sources.find((x) => x.key === "manual_journal")!;
    expect(s).toMatchObject({ posted: 1, eligible: 2, outstanding: 1, status: "incomplete" });
  });

  it("28. geweigerde verkoopfacturen (BTW verlegd) tellen niet als 'nog niet geboekt'", () => {
    const s = computeLedgerCompleteness(base()).sources.find((x) => x.key === "sales_invoice")!;
    expect(s.refused).toBe(2);
    expect(s.refusedLabel).toBe("geweigerd (BTW verlegd)");
    expect(s.eligible).toBe(5); // de 2 geweigerde zitten er niet bij
    expect(s.outstanding).toBe(0);
    expect(s.status).toBe("complete");
  });

  it("29. de uitkomst bevat uitsluitend gehele aantallen — nooit een bedrag", () => {
    const c = computeLedgerCompleteness(base());
    for (const s of c.sources) {
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === "number") expect(Number.isInteger(v), `${s.key}.${k}`).toBe(true);
      }
      expect(Object.keys(s)).not.toContain("amount");
      expect(Object.keys(s)).not.toContain("total_amount");
    }
    expect(Number.isInteger(c.totalOutstanding)).toBe(true);
  });

  it("alles leeg → status 'empty', niet 'incomplete'", () => {
    const c = computeLedgerCompleteness({
      purchase: { eligible: 0, posted: 0 },
      sales: { eligible: 0, posted: 0, refusedVerlegd: 0 },
      bank: { eligible: 0, posted: 0, awaitingInvoice: 0 },
      manual: { total: 0, posted: 0 },
    });
    expect(c.sources.every((s) => s.status === "empty")).toBe(true);
    expect(c.mayBeIncomplete).toBe(false);
  });

  it("onbekend → elke bron 'unknown' en mayBeIncomplete", () => {
    const c = unknownLedgerCompleteness();
    expect(c.sources.every((s) => s.status === "unknown")).toBe(true);
    expect(c.mayBeIncomplete).toBe(true);
  });

  it("de postbare statussen spiegelen de schrijvers uit 6C-b3/6C-b4", () => {
    expect([...PURCHASE_POSTABLE_STATUSES]).toEqual(["gecontroleerd", "betaald", "geexporteerd"]);
    expect([...SALES_POSTABLE_STATUSES]).toEqual(["gecontroleerd", "betaald"]);
  });
});

describe("LedgerCompletenessNotice", () => {
  it("onvolledig → waarschuwing met tellingen, geweigerde apart, geen kleur-only status", () => {
    render(<LedgerCompletenessNotice completeness={computeLedgerCompleteness(base())} />);
    const el = screen.getByTestId("ledger-completeness");
    expect(el).toHaveAttribute("data-status", "incomplete");
    expect(el).toHaveAttribute("role", "alert");
    expect(el).toHaveTextContent("mogelijk onvolledig");
    expect(el).toHaveTextContent("4 postbare documenten zijn nog niet geboekt");
    expect(screen.getByTestId("completeness-purchase_invoice")).toHaveTextContent("7 / 10");
    expect(screen.getByTestId("completeness-purchase_invoice")).toHaveTextContent("3 nog niet geboekt");
    expect(screen.getByTestId("completeness-sales_invoice-refused")).toHaveTextContent("2 geweigerd (BTW verlegd)");
    expect(screen.getByTestId("completeness-bank_allocation")).toHaveTextContent("3 koppelingen wachten");
    expect(el).not.toHaveTextContent("€");
  });

  it("volledig → bevestiging", () => {
    render(
      <LedgerCompletenessNotice
        completeness={computeLedgerCompleteness({
          purchase: { eligible: 3, posted: 3 },
          sales: { eligible: 1, posted: 1, refusedVerlegd: 0 },
          bank: { eligible: 0, posted: 0, awaitingInvoice: 0 },
          manual: { total: 0, posted: 0 },
        })}
      />,
    );
    expect(screen.getByTestId("ledger-completeness")).toHaveAttribute("data-status", "complete");
    expect(screen.getByTestId("ledger-completeness")).toHaveTextContent("Alle postbare documenten zijn geboekt");
  });

  it("fout of ontbrekend → eerlijk 'onbekend'", () => {
    render(<LedgerCompletenessNotice completeness={undefined} isError />);
    expect(screen.getByTestId("ledger-completeness")).toHaveAttribute("data-status", "unknown");
    expect(screen.getByTestId("ledger-completeness")).toHaveTextContent("Volledigheid onbekend");
  });
});

// ── De telhook: alleen counts en id's, per administratie ─────────────────

const calls: Array<{ table: string; head: boolean; columns: string; filters: Array<[string, string, unknown]> }> = [];
const counts: Record<string, number> = {};
const lists: Record<string, Array<Record<string, unknown>>> = {};

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u-1" } }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, head: false, columns: "", filters: [] as Array<[string, string, unknown]> };
      calls.push(call);
      const key = () => `${table}:${call.filters.map((f) => f.join("=")).join("&")}`;
      const b: Record<string, unknown> = {
        select: (columns: string, opts?: { head?: boolean }) => {
          call.columns = columns;
          call.head = !!opts?.head;
          return b;
        },
        eq: (c: string, v: unknown) => (call.filters.push([c, "eq", v]), b),
        in: (c: string, v: unknown) => (call.filters.push([c, "in", v]), b),
        order: () => b,
        range: async (from: number, to: number) => ({ data: (lists[table] ?? []).slice(from, to + 1), error: null }),
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ count: counts[key()] ?? 0, error: null }).then(res),
      };
      return b;
    },
  },
}));

import { fetchLedgerCompletenessCounts } from "@/hooks/useLedgerCompleteness";

describe("fetchLedgerCompletenessCounts", () => {
  beforeEach(() => {
    calls.length = 0;
    for (const k of Object.keys(counts)) delete counts[k];
    for (const k of Object.keys(lists)) delete lists[k];
  });

  it("telt per administratie met head-counts, en leest alleen id-kolommen", async () => {
    counts["purchase_invoices:client_id=eq=c-1&status=in=gecontroleerd,betaald,geexporteerd"] = 10;
    counts["purchase_invoice_postings:client_id=eq=c-1"] = 7;
    counts["sales_invoices:client_id=eq=c-1&status=in=gecontroleerd,betaald&btw_verlegd=eq=false"] = 5;
    counts["sales_invoices:client_id=eq=c-1&status=in=gecontroleerd,betaald&btw_verlegd=eq=true"] = 2;
    counts["sales_invoice_postings:client_id=eq=c-1"] = 5;
    counts["bank_allocation_postings:client_id=eq=c-1"] = 1;
    counts["manual_journals:client_id=eq=c-1"] = 2;
    counts["manual_journal_postings:client_id=eq=c-1"] = 1;
    lists["bank_transaction_allocations"] = [
      { id: "a1", invoice_id: "pi-1", invoice_type: "inkoop" },
      { id: "a2", invoice_id: "pi-9", invoice_type: "inkoop" },
      { id: "a3", invoice_id: "si-1", invoice_type: "verkoop" },
    ];
    lists["purchase_invoice_postings"] = [{ purchase_invoice_id: "pi-1" }];
    lists["sales_invoice_postings"] = [{ sales_invoice_id: "si-1" }];

    const c = await fetchLedgerCompletenessCounts("c-1");
    expect(c).toEqual({
      purchase: { eligible: 10, posted: 7 },
      sales: { eligible: 5, posted: 5, refusedVerlegd: 2 },
      bank: { eligible: 2, posted: 1, awaitingInvoice: 1 },
      manual: { total: 2, posted: 1 },
    });
    // Elke aanroep draagt het klantpredicaat.
    for (const call of calls) expect(call.filters).toContainEqual(["client_id", "eq", "c-1"]);
    // Geen bedragkolommen, nergens.
    for (const call of calls) expect(call.columns).not.toMatch(/amount|total|bedrag/);
    expect(calls.filter((c) => c.head)).toHaveLength(8);
    expect(calls.every((c) => c.table !== "journal_entries" && c.table !== "ledger_postings")).toBe(true);
  });

  it("zonder administratie wordt er niets geteld", async () => {
    await expect(fetchLedgerCompletenessCounts("")).rejects.toThrow(/administratie/);
    expect(calls).toHaveLength(0);
  });
});

describe("grootboek-saldi-utils — periode", () => {
  it("'tot en met' → exclusieve dag erna, ook over maand- en jaargrenzen", () => {
    expect(inclusiveEndToExclusive("2027-02-28")).toBe("2027-03-01");
    expect(inclusiveEndToExclusive("2027-12-31")).toBe("2028-01-01");
    expect(inclusiveEndToExclusive("2028-02-28")).toBe("2028-02-29");
    expect(exclusiveEndToInclusive("2028-01-01")).toBe("2027-12-31");
  });

  it("selectie → half-open periode en label", () => {
    expect(periodFromSelection({ kind: "year", year: 2027 })).toEqual({ from: "2027-01-01", toExclusive: "2028-01-01" });
    expect(periodFromSelection({ kind: "all" })).toEqual({ from: "2000-01-01", toExclusive: "2101-01-01" });
    expect(periodFromSelection({ kind: "range", from: "2027-02-01", toInclusive: "2027-02-28" })).toEqual({ from: "2027-02-01", toExclusive: "2027-03-01" });
    expect(periodLabel({ kind: "range", from: "2027-02-01", toInclusive: "2027-02-28" })).toBe("01-02-2027 t/m 28-02-2027");
    expect(periodLabel({ kind: "all" })).toBe("Alle jaren");
  });
});
