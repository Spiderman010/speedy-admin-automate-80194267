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
export interface UblExtractedInvoice {
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
  const percent = field(invoice, "InvoiceLine", "Item", "ClassifiedTaxCategory", "Percent");
  const vat = money(tax);
  const rate = money(percent);
  const supplierVat = text(field(invoice, "AccountingSupplierParty", "Party", "PartyTaxScheme", "CompanyID"));
  const iban = text(field(invoice, "PaymentMeans", "PayeeFinancialAccount", "ID"));
  return {
    supplier, invoice_number: number, invoice_date: issueDate,
    amount_excl: money(subtotal), btw_amount: vat,
    amount_incl: total, btw_percentage: rate,
    supplier_btw_number: supplierVat, supplier_iban: iban,
    source: "ubl",
  };
}
