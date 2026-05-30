import JSZip from "jszip";
import type { Tables } from "@/integrations/supabase/types";

type SalesInvoice = Tables<"sales_invoices">;
type Client = Tables<"clients">;

export const SALES_UBL_TEST_HELPER_TEXT =
  "Testpakket: verkoop-UBL is gebaseerd op beschikbare gegevens. Controleer import en bijlage handmatig in SnelStart.";

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");

const fmt = (n: number) => n.toFixed(2);

const sanitizeFilename = (s: string) =>
  s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");

const trimOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

function supplierPartyFromClient(client?: Client | null) {
  return {
    name: trimOrNull(client?.name),
    street: trimOrNull(client?.address),
    postalCode: trimOrNull(client?.postal_code),
    city: trimOrNull(client?.city),
    country: trimOrNull(client?.country) || "NL",
    kvk: trimOrNull(client?.kvk_number),
    btw: trimOrNull(client?.btw_number),
  };
}

function customerPartyFromInvoice(invoice: SalesInvoice) {
  return {
    name: trimOrNull(invoice.customer_name) || "Onbekende klant",
    country: "NL",
  };
}

function buildSupplierPartyXml(client?: Client | null) {
  const supplier = supplierPartyFromClient(client);
  const name = xmlEscape(supplier.name || "Onbekende leverancier");
  const endpoint = supplier.kvk
    ? `      <cbc:EndpointID schemeID="0106">${xmlEscape(supplier.kvk)}</cbc:EndpointID>\n`
    : "";
  const taxScheme = supplier.btw
    ? `      <cac:PartyTaxScheme>
        <cbc:CompanyID>${xmlEscape(supplier.btw)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
`
    : "";
  const legalCompanyId = supplier.kvk
    ? `        <cbc:CompanyID schemeID="0106">${xmlEscape(supplier.kvk)}</cbc:CompanyID>\n`
    : "";

  return `    <cac:Party>
${endpoint}      <cac:PartyName><cbc:Name>${name}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        ${supplier.street ? `<cbc:StreetName>${xmlEscape(supplier.street)}</cbc:StreetName>\n        ` : ""}${supplier.city ? `<cbc:CityName>${xmlEscape(supplier.city)}</cbc:CityName>\n        ` : ""}${supplier.postalCode ? `<cbc:PostalZone>${xmlEscape(supplier.postalCode)}</cbc:PostalZone>\n        ` : ""}<cac:Country><cbc:IdentificationCode>${xmlEscape(supplier.country)}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
${taxScheme}      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${name}</cbc:RegistrationName>
${legalCompanyId}      </cac:PartyLegalEntity>
    </cac:Party>`;
}

function buildCustomerPartyXml(invoice: SalesInvoice) {
  const customer = customerPartyFromInvoice(invoice);
  const name = xmlEscape(customer.name);

  return `    <cac:Party>
      <cac:PartyName><cbc:Name>${name}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cac:Country><cbc:IdentificationCode>${xmlEscape(customer.country)}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
    </cac:Party>`;
}

function buildTaxCategory(invoice: SalesInvoice) {
  const pct = Number(invoice.btw_percentage ?? 0);

  if (invoice.btw_verlegd) {
    return {
      id: "AE",
      percent: 0,
      exemptionReason: "VAT reverse charge",
    };
  }

  if (pct === 0) {
    return {
      id: "Z",
      percent: 0,
      exemptionReason: null,
    };
  }

  return {
    id: "S",
    percent: pct,
    exemptionReason: null,
  };
}

export function generateSalesInvoiceUbl(invoice: SalesInvoice, client?: Client | null): string {
  const amountExcl = Number(invoice.amount_excl ?? 0);
  const amountIncl = Number(invoice.amount_incl ?? 0);
  const btwAmount = invoice.btw_amount != null
    ? Number(invoice.btw_amount)
    : Math.max(0, amountIncl - amountExcl);
  const taxCategory = buildTaxCategory(invoice);
  const dueDateLine = invoice.due_date ? `\n  <cbc:DueDate>${invoice.due_date}</cbc:DueDate>` : "";
  const customerName = xmlEscape(invoice.customer_name || "Onbekende klant");
  const noteLines = [
    SALES_UBL_TEST_HELPER_TEXT,
    invoice.ledger_account_text ? `Referentie grootboekrekening: ${invoice.ledger_account_text}` : null,
    invoice.btw_verlegd ? "BTW-verlegging is gebaseerd op het veld btw_verlegd in BoekAssist." : null,
  ].filter(Boolean) as string[];

  const notesXml = noteLines
    .map((line) => `  <cbc:Note>${xmlEscape(line)}</cbc:Note>`)
    .join("\n");

  const taxExemptionReasonXml = taxCategory.exemptionReason
    ? `\n        <cbc:TaxExemptionReason>${xmlEscape(taxCategory.exemptionReason)}</cbc:TaxExemptionReason>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:nen.nl:nlcius:v1.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${xmlEscape(invoice.invoice_number)}</cbc:ID>
  <cbc:IssueDate>${invoice.invoice_date}</cbc:IssueDate>${dueDateLine}
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${customerName}</cbc:BuyerReference>
${notesXml}
  <cac:AccountingSupplierParty>
${buildSupplierPartyXml(client)}
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
${buildCustomerPartyXml(invoice)}
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">${fmt(btwAmount)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">${fmt(amountExcl)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">${fmt(btwAmount)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${taxCategory.id}</cbc:ID>
        <cbc:Percent>${fmt(taxCategory.percent)}</cbc:Percent>${taxExemptionReasonXml}
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">${fmt(amountExcl)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">${fmt(amountExcl)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">${fmt(amountIncl)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">${fmt(amountIncl)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="ZZ">1.00</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">${fmt(amountExcl)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Description>Verkoopfactuur ${xmlEscape(invoice.invoice_number)}</cbc:Description>
      <cbc:Name>Verkoopfactuur ${xmlEscape(invoice.invoice_number)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${taxCategory.id}</cbc:ID>
        <cbc:Percent>${fmt(taxCategory.percent)}</cbc:Percent>${taxExemptionReasonXml}
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">${fmt(amountExcl)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
</Invoice>
`;
}

export function buildSalesInvoiceTestPackage(
  invoice: SalesInvoice,
  pdfBlob: Blob,
  client?: Client | null,
) {
  const invoicePart = sanitizeFilename(invoice.invoice_number || invoice.id);
  const customerPart = sanitizeFilename(invoice.customer_name || "klant");
  const baseName = `VERKOOP-TEST-${invoicePart}-${customerPart}`;
  const xmlFilename = `${baseName}.xml`;
  const pdfFilename = `${baseName}.pdf`;
  const zipFilename = `${baseName}.zip`;
  const xml = generateSalesInvoiceUbl(invoice, client);
  const zip = new JSZip();
  zip.file(xmlFilename, xml);
  zip.file(pdfFilename, pdfBlob);

  return {
    baseName,
    xml,
    xmlFilename,
    pdfFilename,
    zipFilename,
    zipBlobPromise: zip.generateAsync({ type: "blob" }),
  };
}
