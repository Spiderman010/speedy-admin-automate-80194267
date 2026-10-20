import { describe, expect, it } from "vitest";
import { getUblWorkspaceLines } from "@/lib/ubl-workspace-prefill";

const header = { amount_excl: 100, btw_amount: 21, amount_incl: 121 };
const valid = { source: "ubl", invoice_lines: [
  { description: "Dienst", amount_excl: 100, btw_percentage: 21 },
] };
describe("UBL draft invoice workbench prefill", () => {
  it("prefills matching UBL lines", () => {
    expect(getUblWorkspaceLines(valid, header)).toEqual([
      { omschrijving: "Dienst", amount_excl: 100, btw_percentage: 21 },
    ]);
  });
  it("rejects mismatched invoice totals and missing header amounts", () => {
    expect(getUblWorkspaceLines(valid, { ...header, btw_amount: 9 })).toBeNull();
    expect(getUblWorkspaceLines(valid, { ...header, amount_excl: null })).toBeNull();
  });
  it("rejects unknown source, invalid rates and malformed line data", () => {
    expect(getUblWorkspaceLines({ ...valid, source: "ocr" }, header)).toBeNull();
    expect(getUblWorkspaceLines({ ...valid, invoice_lines: [{ description: "x", amount_excl: 100, btw_percentage: 200 }] }, header)).toBeNull();
    expect(getUblWorkspaceLines({ ...valid, invoice_lines: [{ description: "x", amount_excl: "100", btw_percentage: 21 }] }, header)).toBeNull();
  });
});
