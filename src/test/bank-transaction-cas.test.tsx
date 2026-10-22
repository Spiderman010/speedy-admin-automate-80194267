/**
 * Review P5 H-1/H-2 — compare-and-set in useUpdateBankTransaction.
 *
 * Met `expected` gaat de update alleen door als de regel in de database nog de
 * verwachte match_status (en eventueel matched_invoice_id) heeft. Raakt de
 * update 0 rijen, dan is er niets geschreven: BankTransactionChangedError, en
 * de lijst wordt opnieuw opgehaald. Zonder `expected`: het oude gedrag.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, ...unknown[]]>,
  rows: [] as unknown[],
}));

vi.mock("@/integrations/supabase/client", () => {
  const builder: Record<string, unknown> = {};
  for (const m of ["update", "eq", "in", "is"]) {
    builder[m] = (...args: unknown[]) => { h.calls.push([m, ...args]); return builder; };
  }
  builder.select = (...args: unknown[]) => {
    h.calls.push(["select", ...args]);
    const result = Promise.resolve({ data: h.rows, error: null });
    return Object.assign(result, { single: () => { h.calls.push(["single"]); return Promise.resolve({ data: h.rows[0] ?? null, error: null }); } });
  };
  return { supabase: { from: (t: string) => { h.calls.push(["from", t]); return builder; } } };
});
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

import { useUpdateBankTransaction } from "@/hooks/useBankTransactions";
import { BANK_TX_NOT_LINKED_STATUSES, BankTransactionChangedError, BANK_TX_CHANGED_MESSAGE } from "@/lib/bank-transaction-cas";

function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const spy = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  const { result } = renderHook(() => useUpdateBankTransaction(), { wrapper });
  return { result, spy };
}

beforeEach(() => { h.calls = []; h.rows = []; });

describe("useUpdateBankTransaction — compare-and-set", () => {
  it("filtert op de verwachte status en factuur, en schrijft `expected` zelf niet weg", async () => {
    h.rows = [{ id: "tx-1" }];
    const { result } = setup();
    await result.current.mutateAsync({ id: "tx-1", match_status: "niet_gematcht", expected: { match_status: ["suggestie"], matched_invoice_id: "P1" } });
    expect(h.calls).toEqual([
      ["from", "bank_transactions"],
      ["update", { match_status: "niet_gematcht" }],
      ["eq", "id", "tx-1"],
      ["in", "match_status", ["suggestie"]],
      ["eq", "matched_invoice_id", "P1"],
      ["select"],
    ]);
  });

  it("matched_invoice_id null betekent: moet leeg zijn", async () => {
    h.rows = [{ id: "tx-1" }];
    const { result } = setup();
    await result.current.mutateAsync({ id: "tx-1", match_status: "suggestie", expected: { match_status: ["niet_gematcht"], matched_invoice_id: null } });
    expect(h.calls).toContainEqual(["is", "matched_invoice_id", null]);
  });

  it("0 rijen geraakt: BankTransactionChangedError met een duidelijke melding, en de lijst wordt ververst", async () => {
    h.rows = [];
    const { result, spy } = setup();
    const err = await result.current.mutateAsync({ id: "tx-1", match_status: "handmatig_geboekt", expected: { match_status: BANK_TX_NOT_LINKED_STATUSES } }).catch((e) => e);
    expect(err).toBeInstanceOf(BankTransactionChangedError);
    expect(err.message).toBe(BANK_TX_CHANGED_MESSAGE);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["bank_transactions"] });
  });

  it("coderen verwacht nooit `gematcht`: een gekoppelde regel wordt niet gecodeerd", () => {
    expect(BANK_TX_NOT_LINKED_STATUSES).not.toContain("gematcht");
    expect([...BANK_TX_NOT_LINKED_STATUSES].sort()).toEqual(["handmatig_geboekt", "niet_gematcht", "suggestie", "wacht_op_factuur"]);
  });

  it("zonder `expected`: het bestaande gedrag (één rij, .single())", async () => {
    h.rows = [{ id: "tx-1" }];
    const { result } = setup();
    await result.current.mutateAsync({ id: "tx-1", notes: "x" } as never);
    expect(h.calls.map((c) => c[0])).toEqual(["from", "update", "eq", "select", "single"]);
  });
});
