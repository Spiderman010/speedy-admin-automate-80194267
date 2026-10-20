import { describe, expect, it } from "vitest";
import { extractUblInvoice } from "../../supabase/functions/process-invoice/ubl-extract";
import { getUblWorkspaceLines } from "@/lib/ubl-workspace-prefill";
import { suggestExistingSupplier } from "@/lib/purchase-supplier-suggestion";
import { suggestSupplierLedger } from "@/lib/supplier-ledger-suggestion";
import { validatePurchaseLines } from "@/lib/purchase-line-validation";

const supplier = {
  id: "supplier-a", naam: "Leverancier BV", btw_nummer: "NL123456789B01",
  iban: "NL91ABNA0417164300", client_id: "client-a", actief: true,
  standaard_grootboekrekening_id: "ledger-a",
};
const ledger = {
  id: "ledger-a", nummer: 4400, omschrijving: "Inkoopkosten",
  client_id: "client-a", actief: true,
};
const ubl = {
  Invoice: {
    ID: "000123", IssueDate: "2026-10-20",
    AccountingSupplierParty: { Party: {
      PartyName: { Name: "Leverancier BV" },
      PartyTaxScheme: { CompanyID: "NL123456789B01" },
    } },
    PaymentMeans: { PayeeFinancialAccount: { ID: "NL91ABNA0417164300" } },
    InvoiceLine: [
      { Item: { Name: "Onderhoud", ClassifiedTaxCategory: { Percent: "21" } }, LineExtensionAmount: "100.00" },
      { Item: { Name: "Materiaal", ClassifiedTaxCategory: { Percent: "9" } }, LineExtensionAmount: "100.00" },
    ],
    LegalMonetaryTotal: { TaxExclusiveAmount: "200.00", PayableAmount: "230.00" },
    TaxTotal: { TaxAmount: "30.00" },
  },
};
describe("offline purchase intake contract journey (no DB writes)", () => {
  it("UBL → mixed VAT lines → same-client supplier → confirmable ledger proposal", () => {
    const extracted = extractUblInvoice(ubl);
    expect(extracted.invoice_number).toBe("000123");
    expect(extracted.btw_percentage).toBeNull();
    expect(extracted.mixed_vat_rates).toBe(true);
    const header = {
      amount_excl: extracted.amount_excl,
      btw_amount: extracted.btw_amount,
      amount_incl: extracted.amount_incl,
    };
    const lines = getUblWorkspaceLines(extracted, header);
    expect(lines).toHaveLength(2);
    expect(validatePurchaseLines(lines!, header)).toBeNull();
    const matched = suggestExistingSupplier({
      supplier: extracted.supplier, supplier_btw_number: extracted.supplier_btw_number,
      supplier_iban: extracted.supplier_iban,
    }, [supplier], "client-a");
    expect(matched?.id).toBe("supplier-a");
    const proposed = suggestSupplierLedger(matched?.id, "client-a", [supplier], [ledger]);
    expect(proposed).toEqual({ id: "ledger-a", label: "4400 - Inkoopkosten" });
    // Proposals are not ledger assignments or postings.
    expect(lines!.every((line) => !("grootboekrekening_id" in line))).toBe(true);
  });
  it("rejects invoice totals inconsistent with individual VAT lines", () => {
    const extracted = extractUblInvoice(ubl);
    expect(getUblWorkspaceLines(extracted, {
      amount_excl: 200, btw_amount: 29, amount_incl: 229,
    })).toBeNull();
  });
  it("fails closed for a different administration and a nonbookable ledger", () => {
    const extracted = extractUblInvoice(ubl);
    const matched = suggestExistingSupplier({
      supplier: extracted.supplier, supplier_btw_number: extracted.supplier_btw_number,
      supplier_iban: extracted.supplier_iban,
    }, [supplier], "client-b");
    expect(matched).toBeNull();
    expect(suggestSupplierLedger("supplier-a", "client-a", [supplier], [
      { ...ledger, client_id: "client-b" },
    ])).toBeNull();
  });
  it("does not resolve conflicting supplier identities", () => {
    const other = {
      ...supplier, id: "supplier-b", naam: "Andere BV",
      btw_nummer: "NL999999999B01", iban: "NL12RABO0123456789",
    };
    expect(suggestExistingSupplier({
      supplier: "Leverancier BV", supplier_btw_number: supplier.btw_nummer,
      supplier_iban: other.iban,
    }, [supplier, other], "client-a")).toBeNull();
  });
});
