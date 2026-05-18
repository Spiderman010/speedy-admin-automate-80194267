import type { Tables } from "@/integrations/supabase/types";

type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;
type JournalEntry = Tables<"journal_entries">;
type BankTransaction = Tables<"bank_transactions">;

const SEP = ";";
const STANDARD_HEADERS = ["Datum", "Omschrijving", "Grootboekrekening", "Bedrag", "Btw-code"];

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const parts = dateStr.substring(0, 10).split("-");
  if (parts.length === 3) {
    const dd = parts[2].padStart(2, "0");
    const mm = parts[1].padStart(2, "0");
    return `${dd}-${mm}-${parts[0]}`;
  }
  return "";
}

function formatAmount(amount: number | null): string {
  if (amount == null) return "";
  return amount.toFixed(2).replace(".", ",");
}

function btwCode(percentage: number | null): string {
  if (percentage === 21) return "1";
  if (percentage === 9) return "2";
  if (percentage === 0) return "0";
  return "";
}

function csvRow(fields: string[]): string {
  return fields.map(f => `"${(f ?? "").replace(/"/g, '""')}"`).join(SEP);
}

function downloadCSV(content: string, filename: string) {
  const bom = "\uFEFF";
  const blob = new Blob([bom + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toStandardRow(datum: string | null, omschrijving: string | null, grootboek: string | null, bedrag: number | null, btwPerc: number | null): string {
  return csvRow([
    formatDate(datum),
    omschrijving ?? "",
    grootboek ?? "",
    formatAmount(bedrag),
    btwCode(btwPerc),
  ]);
}

function buildStandardCSV(rows: string[]): string {
  return [csvRow(STANDARD_HEADERS), ...rows].join("\r\n");
}

export function exportPurchaseInvoicesCSV(invoices: PurchaseInvoice[], clientName?: string) {
  const rows = invoices.map(inv =>
    toStandardRow(inv.invoice_date, inv.supplier + (inv.invoice_number ? ` - ${inv.invoice_number}` : ""), inv.ledger_account_text, inv.amount_incl, inv.btw_percentage)
  );
  const prefix = clientName ? `${clientName.replace(/\s+/g, "_")}_` : "";
  downloadCSV(buildStandardCSV(rows), `${prefix}inkoopfacturen_snelstart.csv`);
  return invoices.map(i => i.id);
}

export function exportJournalEntriesCSV(entries: JournalEntry[], clientName?: string) {
  const rows = entries.map(e =>
    toStandardRow(e.entry_date, e.description, e.ledger_account_text, e.amount, e.btw_percentage)
  );
  const prefix = clientName ? `${clientName.replace(/\s+/g, "_")}_` : "";
  downloadCSV(buildStandardCSV(rows), `${prefix}boekingen_snelstart.csv`);
}

export function exportSalesInvoicesCSV(invoices: SalesInvoice[], clientName?: string) {
  const rows = invoices.map(inv =>
    toStandardRow(inv.invoice_date, inv.customer_name + (inv.invoice_number ? ` - ${inv.invoice_number}` : ""), inv.ledger_account_text, inv.amount_incl, inv.btw_percentage)
  );
  const prefix = clientName ? `${clientName.replace(/\s+/g, "_")}_` : "";
  downloadCSV(buildStandardCSV(rows), `${prefix}verkoopfacturen_snelstart.csv`);
  return invoices.map(i => i.id);
}

// SnelStart 12 boekingen import formaat
const SNELSTART_HEADERS = [
  "fldDagboek",
  "fldBoekingcode",
  "fldDatum",
  "fldGrootboeknummer",
  "fldDebet",
  "fldCredit",
  "fldOmschrijving",
];

function snelstartRow(fields: (string | number)[]): string {
  return fields.map(f => String(f ?? "")).join(SEP);
}

function buildSnelstartCSV(rows: string[]): string {
  return [SNELSTART_HEADERS.join(SEP), ...rows].join("\r\n");
}

function downloadSnelstartCSV(content: string, filename: string) {
  // SnelStart 12 verwacht GEEN BOM marker
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportBankTransactionsCSV(
  transactions: BankTransaction[],
  grootboekrekeningen: Array<{ id: string; nummer: number; omschrijving: string }>,
  clientName?: string,
  bankDagboek: number = 1100
) {
  const rows: string[] = [];
  let boekingcode = 1;

  const fallback1799 = grootboekrekeningen.find(g => g.nummer === 1799) ?? null;

  for (const t of transactions) {
    const resolvedGb = t.grootboekrekening_id
      ? grootboekrekeningen.find(g => g.id === t.grootboekrekening_id)
      : null;
    const gb = resolvedGb ?? (t.match_status === "gematcht" ? fallback1799 : null);
    if (!gb) continue;

    const datum = formatDate(t.transaction_date);
    const omschrijving = (t.description ?? "").substring(0, 100).replace(/[\r\n;]/g, " ");
    const bedrag = Math.abs(t.amount);
    const isPositief = t.amount >= 0;

    // Regel 1: bank rekening
    // Positief bedrag (inkomend) → bank debet, tegenrekening credit
    // Negatief bedrag (uitgaand) → bank credit, tegenrekening debet
    rows.push(snelstartRow([
      bankDagboek,
      boekingcode,
      datum,
      bankDagboek,
      isPositief ? formatAmount(bedrag) : "0",
      isPositief ? "0" : formatAmount(bedrag),
      omschrijving,
    ]));

    // Regel 2: tegenrekening (grootboek)
    rows.push(snelstartRow([
      bankDagboek,
      boekingcode,
      datum,
      gb.nummer,
      isPositief ? "0" : formatAmount(bedrag),
      isPositief ? formatAmount(bedrag) : "0",
      omschrijving,
    ]));

    boekingcode++;
  }

  const prefix = clientName ? `${clientName.replace(/\s+/g, "_")}_` : "";
  downloadSnelstartCSV(buildSnelstartCSV(rows), `${prefix}banktransacties_snelstart.csv`);
}

export async function exportAllForClient(
  clientName: string,
  invoices: PurchaseInvoice[],
  entries: JournalEntry[],
  transactions: BankTransaction[],
) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const prefix = clientName.replace(/\s+/g, "_");
  const bom = "\uFEFF";

  if (invoices.length) {
    const rows = invoices.map(inv =>
      toStandardRow(inv.invoice_date, inv.supplier + (inv.invoice_number ? ` - ${inv.invoice_number}` : ""), inv.ledger_account_text, inv.amount_incl, inv.btw_percentage)
    );
    zip.file(`${prefix}_inkoopfacturen.csv`, bom + buildStandardCSV(rows));
  }

  if (entries.length) {
    const rows = entries.map(e =>
      toStandardRow(e.entry_date, e.description, e.ledger_account_text, e.amount, e.btw_percentage)
    );
    zip.file(`${prefix}_boekingen.csv`, bom + buildStandardCSV(rows));
  }

  if (transactions.length) {
    const rows = transactions.map(t =>
      toStandardRow(t.transaction_date, t.description, null, t.amount, null)
    );
    zip.file(`${prefix}_banktransacties.csv`, bom + buildStandardCSV(rows));
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${prefix}_snelstart_export.zip`;
  a.click();
  URL.revokeObjectURL(url);
}
