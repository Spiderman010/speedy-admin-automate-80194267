import { describe, expect, it } from "vitest";
import { rankCandidates } from "@/components/BankMatchDialog";
import type { Tables } from "@/integrations/supabase/types";

type Tx = Tables<"bank_transactions">;
type Purchase = Tables<"purchase_invoices">;
const tx = (description: string, amount: number): Tx =>
  ({ id: "tx1", description, amount, reference: "", match_status: "niet_gematcht" } as Tx);
const invoice = (supplier: string, amount: number, invoice_number = "FACT-2026-123"): Purchase =>
  ({ id: "inv1", supplier, invoice_number, amount_incl: amount, remaining_amount: amount,
     status: "te_controleren" } as Purchase);

describe("Bank suggestions require counterparty evidence", () => {
  it.each([
    ["ACTION 1273", -46.97, "Klimbos Nederland", 58.50],
    ["ALBERT HEIJN 1324", -25.98, "Pathé De Kuip", 31.00],
    ["BCK*ALMINA PATISSERIE", -9.45, "THE PADELLERS EXPLO", 22.66],
    ["BCK*INTERPARKING NEDER", -7, "THE PADELLERS EXPLO", 22.66],
  ])("refuses unrelated amount-only part payment %s", (description, amount, supplier, total) => {
    const matches = rankCandidates(tx(description, amount), [invoice(supplier, total)], []);
    expect(matches[0].score).toBe(0);
    expect(matches[0].reasons).toEqual([]);
  });
  it("still proposes a part payment when the full supplier name matches", () => {
    const matches = rankCandidates(tx("Klimbos Nederland factuurbetaling", -46.97),
      [invoice("Klimbos Nederland", 58.50)], []);
    expect(matches[0].score).toBeGreaterThan(0);
    expect(matches[0].isPartialPayment).toBe(true);
  });
  it("does not infer identity from short invoice tokens", () => {
    expect(rankCandidates(tx("abc 2026", -46.97),
      [invoice("Different supplier", 58.50, "abc")], [])[0].score).toBe(0);
  });
});
