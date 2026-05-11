import type { Tables } from "@/integrations/supabase/types";

type PurchaseInvoice = Tables<"purchase_invoices">;
type Client = Tables<"clients">;
type PurchaseInvoiceLine = Tables<"purchase_invoice_lines">;

const REQUIRED_FIELDS: { key: keyof PurchaseInvoice; label: string }[] = [
  { key: "invoice_number", label: "Factuurnummer" },
  { key: "invoice_date", label: "Factuurdatum" },
  { key: "supplier", label: "Leverancier" },
  { key: "amount_excl", label: "Bedrag excl. BTW" },
  { key: "amount_incl", label: "Bedrag incl. BTW" },
  { key: "btw_percentage", label: "BTW-percentage" },
];

export function validatePurchaseInvoiceForUbl(invoice: PurchaseInvoice): string[] {
  const missing: string[] = [];
  for (const f of REQUIRED_FIELDS) {
    const v = invoice[f.key];
    if (v === null || v === undefined || v === "") missing.push(f.label);
  }
  return missing;
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const fmt = (n: number) => n.toFixed(2);

const sanitizeFilename = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");

export function generatePurchaseInvoiceUbl(
  invoice: PurchaseInvoice,
  client?: Client | null,
  lines?: PurchaseInvoiceLine[] | null,
): string {
  const amountExcl = Number(invoice.amount_excl ?? 0);
  const amountIncl = Number(invoice.amount_incl ?? 0);
  const btwAmount = invoice.btw_amount != null
    ? Number(invoice.btw_amount)
    : Math.max(0, amountIncl - amountExcl);
  const btwPct = Number(invoice.btw_percentage ?? 0);

  const supplierName = xmlEscape(invoice.supplier ?? "");
  const supplierVat = (invoice as any).supplier_btw_number || (invoice.ocr_data as any)?.supplier_btw_number || null;

  const buyerName = xmlEscape(client?.name ?? "Onbekende klant");
  const buyerStreet = xmlEscape(client?.address ?? "");
  const buyerCity = xmlEscape(client?.city ?? "");
  const buyerZip = xmlEscape(client?.postal_code ?? "");

  const supplierTaxScheme = supplierVat
    ? `\n    <cac:PartyTaxScheme>
      <cbc:CompanyID>${xmlEscape(String(supplierVat))}</cbc:CompanyID>
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
    </cac:PartyTaxScheme>`
    : "";

  const dueDateLine = invoice.invoice_date && (invoice as any).due_date
    ? `\n  <cbc:DueDate>${(invoice as any).due_date}</cbc:DueDate>`
    : "";

  // Build invoice lines: multi-line mode if lines exist, otherwise fallback to single generic line.
  const useLines = Array.isArray(lines) && lines.length > 0;
  const invoiceLinesXml = useLines
    ? lines!.map((l, idx) => {
        const lineExcl = Number(l.amount_excl ?? 0);
        const linePct = Number(l.btw_percentage ?? 0);
        const desc = xmlEscape(l.omschrijving || `Regel ${idx + 1}`);
        return `  <cac:InvoiceLine>
    <cbc:ID>${idx + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="ZZ">1.00</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">${fmt(lineExcl)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Description>${desc}</cbc:Description>
      <cbc:Name>${desc}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${fmt(linePct)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">${fmt(lineExcl)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
      }).join("\n")
    : `  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="ZZ">1.00</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">${fmt(amountExcl)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Description>Inkoopfactuur</cbc:Description>
      <cbc:Name>Inkoopfactuur</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${fmt(btwPct)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">${fmt(amountExcl)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;

  const lineExtensionTotal = useLines
    ? lines!.reduce((s, l) => s + Number(l.amount_excl ?? 0), 0)
    : amountExcl;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:nen.nl:nlcius:v1.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${xmlEscape(invoice.invoice_number ?? "")}</cbc:ID>
  <cbc:IssueDate>${invoice.invoice_date}</cbc:IssueDate>${dueDateLine}
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>NA</cbc:BuyerReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${supplierName}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cac:Country><cbc:IdentificationCode>NL</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>${supplierTaxScheme}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${supplierName}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${buyerName}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        ${buyerStreet ? `<cbc:StreetName>${buyerStreet}</cbc:StreetName>\n        ` : ""}${buyerCity ? `<cbc:CityName>${buyerCity}</cbc:CityName>\n        ` : ""}${buyerZip ? `<cbc:PostalZone>${buyerZip}</cbc:PostalZone>\n        ` : ""}<cac:Country><cbc:IdentificationCode>NL</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${buyerName}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>57</cbc:PaymentMeansCode>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">${fmt(btwAmount)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">${fmt(amountExcl)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">${fmt(btwAmount)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${fmt(btwPct)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">${fmt(lineExtensionTotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">${fmt(amountExcl)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">${fmt(amountIncl)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">${fmt(amountIncl)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${invoiceLinesXml}
</Invoice>
`;
}

export function downloadPurchaseInvoiceUbl(
  invoice: PurchaseInvoice,
  client?: Client | null,
  lines?: PurchaseInvoiceLine[] | null,
) {
  const xml = generatePurchaseInvoiceUbl(invoice, client, lines);
  const filename = `UBL-${sanitizeFilename(invoice.invoice_number ?? "factuur")}-${sanitizeFilename(invoice.supplier ?? "leverancier")}.xml`;
  const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
