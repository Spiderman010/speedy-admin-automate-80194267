// UBL 2.x Invoice extraction after namespace-aware XML parsing.
// No booking or storage mutations occur here. The incoming document must be
// parsed with entity expansion disabled and external DTD resolution blocked.
type Node = Record<string, unknown>;
const object = (value: unknown): Node | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Node : null;
const child = (node: unknown, key: string): unknown => object(node)?.[key];
const first = (value: unknown): unknown => Array.isArray(value) ? value[0] : value;
const text = (value: unknown): string | null => {
  const v = first(value);
  const raw = typeof v === "string" || typeof v === "number"
    ? String(v) : object(v)?.["#text"];
  return typeof raw === "string" || typeof raw === "number"
    ? String(raw).trim() || null : null;
};
const field = (node: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((acc, key) => child(first(acc), key), node);
const money = (v: unknown): number | null => {
  const raw = text(v);
  if (raw === null || !/^-?\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};
export interface UblExtractedLine {
  description: string;
  amount_excl: number;
  btw_percentage: number | null;
}
export interface UblExtractedInvoice {
  invoice_lines: UblExtractedLine[];
  mixed_vat_rates: boolean;
  supplier: string;
  invoice_number: string;
  invoice_date: string | null;
  amount_excl: number | null;
  btw_amount: number | null;
  amount_incl: number;
  btw_percentage: number | null;
  supplier_btw_number: string | null;
  supplier_iban: string | null;
  source: "ubl";
}
export function extractUblInvoice(parsed: unknown): UblExtractedInvoice {
  const invoice = child(parsed, "Invoice");
  if (!object(invoice)) throw new Error("UBL Invoice-root ontbreekt");
  const number = text(child(invoice, "ID"));
  const supplier = text(field(invoice, "AccountingSupplierParty", "Party", "PartyName", "Name"))
    ?? text(field(invoice, "AccountingSupplierParty", "Party", "PartyLegalEntity", "RegistrationName"));
  const issueDate = text(child(invoice, "IssueDate"));
  const total = money(field(invoice, "LegalMonetaryTotal", "PayableAmount"));
  if (!supplier || !number || total === null || total < 0)
    throw new Error("UBL mist leverancier, factuurnummer of geldig te betalen bedrag");
  if (issueDate && !/^\d{4}-\d{2}-\d{2}$/.test(issueDate))
    throw new Error("UBL bevat ongeldige factuurdatum");
  const tax = first(child(field(invoice, "TaxTotal"), "TaxAmount"));
  const subtotal = field(invoice, "LegalMonetaryTotal", "TaxExclusiveAmount");
  const rawLines = child(invoice, "InvoiceLine");
  const lineNodes = rawLines === undefined ? [] : Array.isArray(rawLines) ? rawLines : [rawLines];
  const invoiceLines: UblExtractedLine[] = lineNodes.map((node) => {
    const amount = money(child(node, "LineExtensionAmount"));
    if (amount === null) throw new Error("UBL-factuurregel mist geldig bedrag excl. btw");
    const description = text(field(node, "Item", "Description"))
      ?? text(field(node, "Item", "Name")) ?? "Factuurregel";
    const rateRaw = field(node, "Item", "ClassifiedTaxCategory", "Percent");
    const rate = rateRaw === undefined ? null : money(rateRaw);
    if (rateRaw !== undefined && (rate === null || rate < 0 || rate > 100))
      throw new Error("UBL-factuurregel heeft ongeldig btw-percentage");
    return { description, amount_excl: amount, btw_percentage: rate };
  });
  const rates = [...new Set(invoiceLines.map((line) => line.btw_percentage))];
  const mixedVatRates = rates.length > 1;
  const percent = !mixedVatRates && rates.length === 1 ? rates[0] : null;
  const vat = money(tax);
  const rate = percent;
  const supplierVat = text(field(invoice, "AccountingSupplierParty", "Party", "PartyTaxScheme", "CompanyID"));
  const iban = text(field(invoice, "PaymentMeans", "PayeeFinancialAccount", "ID"));
  return {
    supplier, invoice_number: number, invoice_date: issueDate,
    amount_excl: money(subtotal), btw_amount: vat,
    amount_incl: total, btw_percentage: rate,
    supplier_btw_number: supplierVat, supplier_iban: iban,
    invoice_lines: invoiceLines, mixed_vat_rates: mixedVatRates,
    source: "ubl",
  };
}
