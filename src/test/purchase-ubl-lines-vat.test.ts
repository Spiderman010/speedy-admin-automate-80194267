import { describe, expect, it } from "vitest";
import { extractUblInvoice } from "../../supabase/functions/process-invoice/ubl-extract";

const invoice = {
  ID: "INV-0004", IssueDate: "2026-10-20",
  AccountingSupplierParty: { Party: { PartyName: { Name: "Leverancier BV" } } },
  LegalMonetaryTotal: { PayableAmount: "130.00", TaxExclusiveAmount: "119.00" },
  TaxTotal: { TaxAmount: "11.00" },
};
describe("UBL invoice line and VAT extraction", () => {
  it("keeps distinct VAT rates per line and never invents one header rate", () => {
    const parsed = extractUblInvoice({ Invoice: { ...invoice, InvoiceLine: [
      { Item: { Name: "Dienst", ClassifiedTaxCategory: { Percent: "21" } }, LineExtensionAmount: "100.00" },
      { Item: { Name: "Product", ClassifiedTaxCategory: { Percent: "9" } }, LineExtensionAmount: "19.00" },
    ] } });
    expect(parsed.invoice_lines).toEqual([
      { description: "Dienst", amount_excl: 100, btw_percentage: 21 },
      { description: "Product", amount_excl: 19, btw_percentage: 9 },
    ]);
    expect(parsed.mixed_vat_rates).toBe(true);
    expect(parsed.btw_percentage).toBeNull();
  });
  it("accepts a single UBL line and retains its percentage", () => {
    const parsed = extractUblInvoice({ Invoice: { ...invoice, InvoiceLine: {
      Item: { Name: "Werk", ClassifiedTaxCategory: { Percent: "21" } },
      LineExtensionAmount: "100.00",
    } } });
    expect(parsed.invoice_lines).toHaveLength(1);
    expect(parsed.btw_percentage).toBe(21);
    expect(parsed.mixed_vat_rates).toBe(false);
  });
  it("rejects malformed monetary amounts and VAT rate in UBL lines", () => {
    expect(() => extractUblInvoice({ Invoice: { ...invoice, InvoiceLine: {
      Item: { Name: "Werk" }, LineExtensionAmount: "not-a-number",
    } } })).toThrow(/bedrag/);
    expect(() => extractUblInvoice({ Invoice: { ...invoice, InvoiceLine: {
      Item: { ClassifiedTaxCategory: { Percent: "150" } }, LineExtensionAmount: "10.00",
    } } })).toThrow(/btw-percentage/);
  });
});
