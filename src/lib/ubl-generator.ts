import type { Tables } from "@/integrations/supabase/types";

type PurchaseInvoice = Tables<"purchase_invoices">;
type Client = Tables<"clients">;
type PurchaseInvoiceLine = Tables<"purchase_invoice_lines">;
type Leverancier = Tables<"leveranciers">;

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const fmt = (n: number) => n.toFixed(2);

const sanitizeFilename = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");

const trimOrNull = (v: any): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** Extract supplier party data with priority: linked leverancier > invoice snapshot > ocr_data fallback. */
function extractSupplierParty(invoice: PurchaseInvoice, leverancier?: Leverancier | null) {
  const ocr = (invoice.ocr_data as any) || {};
  const lev = leverancier ?? null;
  return {
    name: trimOrNull(lev?.naam) || trimOrNull(invoice.supplier),
    btw: trimOrNull(lev?.btw_nummer) || trimOrNull(invoice.supplier_btw_number) || trimOrNull(ocr.supplier_btw_number),
    street: trimOrNull(lev?.adres) || trimOrNull(ocr.supplier_address) || trimOrNull(ocr.supplier_street),
    postal_code: trimOrNull(lev?.postcode) || trimOrNull(ocr.supplier_postal_code) || trimOrNull(ocr.supplier_zip),
    city: trimOrNull(lev?.plaats) || trimOrNull(ocr.supplier_city),
    country: trimOrNull(lev?.land) || trimOrNull(ocr.supplier_country) || "NL",
    kvk: trimOrNull(lev?.kvk_nummer) || trimOrNull(ocr.supplier_kvk) || trimOrNull(ocr.supplier_kvk_number),
    iban: trimOrNull(lev?.iban) || trimOrNull(ocr.supplier_iban) || trimOrNull(ocr.iban),
  };
}

function extractBuyerParty(client?: Client | null) {
  if (!client) {
    return { name: null, street: null, postal_code: null, city: null, country: "NL", kvk: null, btw: null };
  }
  return {
    name: trimOrNull(client.name),
    street: trimOrNull(client.address),
    postal_code: trimOrNull(client.postal_code),
    city: trimOrNull(client.city),
    country: "NL",
    kvk: trimOrNull(client.kvk_number),
    btw: trimOrNull(client.btw_number),
  };
}

const REQUIRED_INVOICE_FIELDS: { key: keyof PurchaseInvoice; label: string }[] = [
  { key: "invoice_number", label: "factuurnummer" },
  { key: "invoice_date", label: "factuurdatum" },
  { key: "amount_excl", label: "bedrag excl. BTW" },
  { key: "amount_incl", label: "bedrag incl. BTW" },
  { key: "btw_percentage", label: "BTW-percentage" },
];

export function validatePurchaseInvoiceForUbl(
  invoice: PurchaseInvoice,
  client?: Client | null,
  leverancier?: Leverancier | null,
): string[] {
  const missing: string[] = [];

  for (const f of REQUIRED_INVOICE_FIELDS) {
    const v = invoice[f.key];
    if (v === null || v === undefined || v === "") missing.push(f.label);
  }

  const supplier = extractSupplierParty(invoice, leverancier);
  if (!supplier.name) missing.push("leverancier naam");
  if (Number(invoice.btw_percentage ?? 0) > 0 && !supplier.btw) {
    missing.push("leverancier BTW-nummer (verplicht bij facturen met BTW)");
  }
  if (!supplier.street) missing.push("leverancier adres");
  if (!supplier.postal_code) missing.push("leverancier postcode");
  if (!supplier.city) missing.push("leverancier plaats");
  if (!supplier.country) missing.push("leverancier land");
  if (!supplier.kvk) missing.push("leverancier KVK-nummer");

  const buyer = extractBuyerParty(client);
  if (!buyer.name) missing.push("klant naam");
  if (!buyer.street) missing.push("klant adres");
  if (!buyer.postal_code) missing.push("klant postcode");
  if (!buyer.city) missing.push("klant plaats");
  if (!buyer.country) missing.push("klant land");
  if (!buyer.kvk) missing.push("klant KVK-nummer");

  return missing;
}

function partyXml(p: ReturnType<typeof extractSupplierParty> | ReturnType<typeof extractBuyerParty>) {
  const name = xmlEscape(p.name ?? "");
  const endpoint = p.kvk
    ? `      <cbc:EndpointID schemeID="0106">${xmlEscape(p.kvk)}</cbc:EndpointID>\n`
    : "";
  const taxScheme = (p as any).btw
    ? `      <cac:PartyTaxScheme>
        <cbc:CompanyID>${xmlEscape(String((p as any).btw))}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>\n`
    : "";
  const legalCompanyId = p.kvk
    ? `        <cbc:CompanyID schemeID="0106">${xmlEscape(p.kvk)}</cbc:CompanyID>\n`
    : "";

  return `    <cac:Party>
${endpoint}      <cac:PartyName><cbc:Name>${name}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        ${p.street ? `<cbc:StreetName>${xmlEscape(p.street)}</cbc:StreetName>\n        ` : ""}${p.city ? `<cbc:CityName>${xmlEscape(p.city)}</cbc:CityName>\n        ` : ""}${p.postal_code ? `<cbc:PostalZone>${xmlEscape(p.postal_code)}</cbc:PostalZone>\n        ` : ""}<cac:Country><cbc:IdentificationCode>${xmlEscape(p.country ?? "NL")}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
${taxScheme}      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${name}</cbc:RegistrationName>
${legalCompanyId}      </cac:PartyLegalEntity>
    </cac:Party>`;
}

export function generatePurchaseInvoiceUbl(
  invoice: PurchaseInvoice,
  client?: Client | null,
  lines?: PurchaseInvoiceLine[] | null,
  leverancier?: Leverancier | null,
): string {
  const amountExcl = Number(invoice.amount_excl ?? 0);
  const amountIncl = Number(invoice.amount_incl ?? 0);
  const btwAmount = invoice.btw_amount != null
    ? Number(invoice.btw_amount)
    : Math.max(0, amountIncl - amountExcl);
  const btwPct = Number(invoice.btw_percentage ?? 0);

  const supplier = extractSupplierParty(invoice, leverancier);
  const buyer = extractBuyerParty(client);

  const dueDateLine = invoice.invoice_date && (invoice as any).due_date
    ? `\n  <cbc:DueDate>${(invoice as any).due_date}</cbc:DueDate>`
    : "";

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

  const paymentMeansXml = supplier.iban
    ? `  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>${xmlEscape(supplier.iban)}</cbc:ID>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>`
    : `  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>57</cbc:PaymentMeansCode>
  </cac:PaymentMeans>`;

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
${partyXml(supplier)}
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
${partyXml(buyer)}
  </cac:AccountingCustomerParty>
${paymentMeansXml}
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
