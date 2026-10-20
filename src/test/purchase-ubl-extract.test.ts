import { describe, expect, it } from "vitest";
import { extractUblInvoice } from "../../supabase/functions/process-invoice/ubl-extract";

const valid = {
  Invoice: {
    ID: "001-ABC", IssueDate: "2026-10-20",
    AccountingSupplierParty: { Party: {
      PartyName: { Name: "Leverancier BV" },
      PartyTaxScheme: { CompanyID: "NL123456789B01" },
    } },
    LegalMonetaryTotal: { TaxExclusiveAmount: "100.00", PayableAmount: "121.00" },
    TaxTotal: { TaxAmount: "21.00" },
    InvoiceLine: [{ Item: { ClassifiedTaxCategory: { Percent: "21" } } }],
  },
};
describe("UBL structured field extraction", () => {
  it("preserves invoice number and derives the correct totals without OCR", () => {
    expect(extractUblInvoice(valid)).toMatchObject({
      invoice_number: "001-ABC", supplier: "Leverancier BV",
      amount_excl: 100, btw_amount: 21, amount_incl: 121,
      btw_percentage: 21, source: "ubl",
    });
  });
  it("rejects documents without an Invoice root or invoice identity", () => {
    expect(() => extractUblInvoice({ CreditNote: {} })).toThrow();
    expect(() => extractUblInvoice({ Invoice: { ID: "1" } })).toThrow();
  });
  it("rejects amounts with extra tokens or negative payable amounts", () => {
    expect(() => extractUblInvoice({
      ...valid, Invoice: { ...valid.Invoice, LegalMonetaryTotal: { PayableAmount: "121 EUR" } },
    })).toThrow();
    expect(() => extractUblInvoice({
      ...valid, Invoice: { ...valid.Invoice, LegalMonetaryTotal: { PayableAmount: "-1.00" } },
    })).toThrow();
  });
});
