import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const pilot = readFileSync("src/components/bank/BankTableReadOnlyPilot.tsx", "utf8");
const bank = readFileSync("src/pages/Bank.tsx", "utf8");

describe("read-only bank table pilot boundaries", () => {
  it("contains no writes, RPCs, or database client calls", () => {
    expect(pilot).not.toMatch(/supabase|\.mutate\(|\.update\(|\.insert\(|\.delete\(|\.rpc\(/);
  });
  it("only filters and sorts already loaded rows", () => {
    expect(pilot).toContain("rows.filter(");
    expect(pilot).toContain("rows: BankRow[]");
    expect(pilot).toContain("van {rows.length} geladen bankregels");
  });
  it("is behind an opt-in toggle and preserves the existing production table", () => {
    expect(bank).toContain("showReadonlyTablePilot && <BankTableReadOnlyPilot rows={tableRows} />");
    expect(bank).toContain('<Table className="text-[13px]');
  });
  it("does not copy premium template code or import Next.js", () => {
    expect(pilot).not.toMatch(/from ["']next\//);
    expect(pilot).not.toContain("shadcn-admin-2.3.0");
  });
});
