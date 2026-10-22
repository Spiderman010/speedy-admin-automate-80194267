import { describe, expect, it } from "vitest";
import { assertOrdinaryBankPayment, canAutomaticallyMatchBankTransaction } from "@/lib/bank-reversal-policy";

describe("bank reversal policy", () => {
  it("blocks reversals", () => {
    expect(canAutomaticallyMatchBankTransaction({ is_reversal: true })).toBe(false);
    expect(() => assertOrdinaryBankPayment({ is_reversal: true })).toThrow(/storno/);
  });
  it("fails closed for unknown or legacy classifications", () => {
    for (const row of [{}, { is_reversal: null }]) {
      expect(canAutomaticallyMatchBankTransaction(row)).toBe(false);
      expect(() => assertOrdinaryBankPayment(row)).toThrow(/onbekend/);
    }
  });
  it("permits confirmed ordinary transactions", () => {
    expect(canAutomaticallyMatchBankTransaction({ is_reversal: false })).toBe(true);
    expect(() => assertOrdinaryBankPayment({ is_reversal: false })).not.toThrow();
  });
});
