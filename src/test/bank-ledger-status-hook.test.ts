import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * fetchBankLedgerFacts — welke markers er gelezen worden, en dat elke fout de
 * hele status laat falen (dan toont de lijst "onbekend", nooit "geboekt").
 */

const calls: { table: string; column: string; values: readonly string[] }[] = [];
const responses: Record<string, { data: unknown[] | null; error: { message: string } | null }> = {};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        in: (column: string, values: readonly string[]) => {
          calls.push({ table, column, values });
          return Promise.resolve(responses[table] ?? { data: [], error: null });
        },
      }),
    }),
  },
}));

import { fetchBankLedgerFacts } from "@/hooks/useBankLedgerStatus";
import { resolveBankLedgerState } from "@/lib/bank-ledger-status";

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(responses)) delete responses[k];
});

describe("fetchBankLedgerFacts", () => {
  it("leest directe en factuurmarkers voor precies deze id's, en de tegenboekingen van hun groepen", async () => {
    responses.bank_transaction_postings = { data: [{ bank_transaction_id: "tx-1", posting_group_id: "g-direct" }], error: null };
    responses.bank_allocation_postings = { data: [{ bank_transaction_id: "tx-2", posting_group_id: "g-alloc", amount: 40 }], error: null };
    responses.ledger_reversal_postings = { data: [{ original_posting_group_id: "g-direct" }], error: null };

    const facts = await fetchBankLedgerFacts(["tx-1", "tx-2"]);

    expect(calls).toEqual([
      { table: "bank_transaction_postings", column: "bank_transaction_id", values: ["tx-1", "tx-2"] },
      { table: "bank_allocation_postings", column: "bank_transaction_id", values: ["tx-1", "tx-2"] },
      { table: "ledger_reversal_postings", column: "original_posting_group_id", values: ["g-direct", "g-alloc"] },
    ]);
    expect(resolveBankLedgerState({ id: "tx-1", amount: -100 }, facts)).toBe("teruggedraaid");
    expect(resolveBankLedgerState({ id: "tx-2", amount: -100 }, facts)).toBe("deels_geboekt");
  });

  it("zonder boekingsgroepen wordt er niet naar tegenboekingen gevraagd", async () => {
    await fetchBankLedgerFacts(["tx-1"]);
    expect(calls.map((c) => c.table)).toEqual(["bank_transaction_postings", "bank_allocation_postings"]);
  });

  it.each(["bank_transaction_postings", "bank_allocation_postings", "ledger_reversal_postings"])(
    "een fout bij %s laat de hele status falen",
    async (table) => {
      responses.bank_transaction_postings = { data: [{ bank_transaction_id: "tx-1", posting_group_id: "g" }], error: null };
      responses[table] = { data: null, error: { message: "permission denied" } };
      await expect(fetchBankLedgerFacts(["tx-1"])).rejects.toBeTruthy();
    },
  );
});
