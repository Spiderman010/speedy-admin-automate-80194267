import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20261022190000_bank_reversal_marker.sql", "utf8");

describe("storno migration safety contract", () => {
  it("keeps historical classification UNKNOWN, never defaults to false", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS is_reversal boolean;/);
    expect(migration).not.toMatch(/is_reversal boolean\s+NOT NULL\s+DEFAULT\s+false/i);
  });
  it("blocks known reversals at the bank match row", () => {
    expect(migration).toContain("bank_reversal_cannot_be_invoice_match");
    expect(migration).toContain("matched_invoice_id IS NULL");
  });
  it("blocks unknown and reversal rows at the allocation writer boundary", () => {
    expect(migration).toContain("CREATE TRIGGER reject_unverified_bank_payment_allocation");
    expect(migration).toContain("bt.is_reversal IS FALSE");
    expect(migration).toContain("BEFORE INSERT OR UPDATE ON public.bank_transaction_allocations");
  });
  it("never changes the protected bank_transactions trigger set", () => {
    expect(migration).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER[^;]*\bON\s+public\.bank_transactions\b/i);
  });
});
