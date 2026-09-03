import type { Tables } from "@/integrations/supabase/types";

type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;
type JournalEntry = Tables<"journal_entries">;
type BankTransaction = Tables<"bank_transactions">;
type Grootboek = { id: string; nummer: number; omschrijving: string };

/**
 * Build the SnelStart omschrijving for a bank transaction.
 *
 * Uses the stored description, but when it is empty or the generic
 * "Geen omschrijving" placeholder, falls back to the captured CAMT.053
 * fields (AddtlNtryInf → Ustrd → tegenpartijnaam) and finally to
 * reference / tegenrekening so SnelStart never receives a blank line.
 */
function buildBankOmschrijving(t: BankTransaction): string {
  const candidates = [
    t.description,
    t.camt_addtl_ntry_inf,
    t.camt_ustrd,
    t.camt_counterparty_name,
    t.reference,
    t.counter_account,
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && v.toLowerCase() !== "geen omschrijving") return v;
  }
  return "Geen omschrijving";
}

export type BankExportResolutionSource =
  | "own"                    // transaction has a resolvable grootboekrekening_id
  | "1799"                   // gematcht, no own ledger, 1799 fallback used
  | "blocked_manual_invalid" // handmatig_geboekt with missing or stale ledger id
  | "blocked_missing_1799"   // gematcht needing 1799 fallback, but 1799 absent
  | "blocked_unconfirmed"    // suggestie — not yet confirmed by user
  | "blocked_unprocessed";   // niet_gematcht / any other unprocessed status

export type BankExportMeta = {
  exportedTransactions: number;
  exportedCsvRows: number;
  bookedTo1799: number;
  skippedTransactions: number;
  skippedManualInvalidLedger: number;
  skippedMissingFallback1799: number;
  skippedUnconfirmed: number;
  skippedUnprocessed: number;
};

// Tolerant 1799 lookup: handles both number 1799 and string "1799" returned at
// runtime despite the TypeScript type saying nummer is a number.
function find1799(grootboekrekeningen: Grootboek[]): Grootboek | null {
  return grootboekrekeningen.find(
    g => String(g.nummer ?? (g as any).code ?? "").trim() === "1799"
  ) ?? null;
}

/**
 * Single source of truth for resolving which grootboekrekening a bank
 * transaction should be exported to.
 *
 * match_status is checked before grootboekrekening_id so that unconfirmed /
 * unprocessed statuses always block — even when a ledger id happens to exist.
 *
 * Rules (in priority order):
 * 1. suggestie                                     → blocked_unconfirmed (always)
 * 2. niet_gematcht / unknown status                → blocked_unprocessed (always)
 * 3. handmatig_geboekt, own id resolves            → source "own"
 * 4. handmatig_geboekt, no/stale id               → blocked_manual_invalid
 * 5. gematcht, own id resolves                     → source "own"
 * 6. gematcht, no/stale id, 1799 present           → source "1799"
 * 7. gematcht, no/stale id, 1799 absent            → blocked_missing_1799
 */
export function resolveBankExportGrootboek(
  transaction: BankTransaction,
  grootboekrekeningen: Grootboek[],
): { grootboek: Grootboek | null; source: BankExportResolutionSource } {
  if (transaction.match_status === "suggestie") {
    return { grootboek: null, source: "blocked_unconfirmed" };
  }

  if (transaction.match_status !== "gematcht" && transaction.match_status !== "handmatig_geboekt") {
    return { grootboek: null, source: "blocked_unprocessed" };
  }

  const resolvedGb = transaction.grootboekrekening_id
    ? (grootboekrekeningen.find(g => g.id === transaction.grootboekrekening_id) ?? null)
    : null;

  if (transaction.match_status === "handmatig_geboekt") {
    return resolvedGb
      ? { grootboek: resolvedGb, source: "own" }
      : { grootboek: null, source: "blocked_manual_invalid" };
  }

  // gematcht
  if (resolvedGb) return { grootboek: resolvedGb, source: "own" };
  const fallback = find1799(grootboekrekeningen);
  return fallback
    ? { grootboek: fallback, source: "1799" }
    : { grootboek: null, source: "blocked_missing_1799" };
}

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
  const bom = "﻿";
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

export function exportPurchaseInvoicesCSV(invoices: PurchaseInvoice[], clientName?: string, year?: number) {
  const rows = invoices.map(inv =>
    toStandardRow(inv.invoice_date, inv.supplier + (inv.invoice_number ? ` - ${inv.invoice_number}` : ""), inv.ledger_account_text, inv.amount_incl, inv.btw_percentage)
  );
  const prefix = clientName ? `${clientName.replace(/\s+/g, "_")}_` : "";
  const yearSuffix = year != null ? `_${year}` : "";
  downloadCSV(buildStandardCSV(rows), `${prefix}inkoopfacturen_snelstart${yearSuffix}.csv`);
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

/**
 * Pure SnelStart 12 bank row builder — shared by exportBankTransactionsCSV
 * (standalone download) and exportAllForClient (ZIP entry) so both paths
 * produce identical CSV content and cannot diverge.
 *
 * Uses resolveBankExportGrootboek to determine exportability; blocked
 * transactions are silently skipped. Does not produce a BOM (SnelStart 12
 * rejects BOM).
 *
 * Exported so it can be unit-tested without a browser.
 */
export function buildBankSnelstartRows(
  transactions: BankTransaction[],
  grootboekrekeningen: Grootboek[],
  bankDagboek: number,
): {
  rows: string[];
  exportedTransactions: number;
  bookedTo1799: number;
  skippedTransactions: number;
  skippedManualInvalidLedger: number;
  skippedMissingFallback1799: number;
  skippedUnconfirmed: number;
  skippedUnprocessed: number;
} {
  const rows: string[] = [];
  let boekingcode = 1;
  let exportedTransactions = 0;
  let bookedTo1799 = 0;
  let skippedTransactions = 0;
  let skippedManualInvalidLedger = 0;
  let skippedMissingFallback1799 = 0;
  let skippedUnconfirmed = 0;
  let skippedUnprocessed = 0;

  for (const t of transactions) {
    const { grootboek: gb, source } = resolveBankExportGrootboek(t, grootboekrekeningen);

    if (!gb) {
      skippedTransactions++;
      if (source === "blocked_manual_invalid") skippedManualInvalidLedger++;
      if (source === "blocked_missing_1799") skippedMissingFallback1799++;
      if (source === "blocked_unconfirmed") skippedUnconfirmed++;
      if (source === "blocked_unprocessed") skippedUnprocessed++;
      continue;
    }

    const datum = formatDate(t.transaction_date);
    const omschrijving = buildBankOmschrijving(t).substring(0, 100).replace(/[\r\n;]/g, " ");
    const bedrag = Math.abs(t.amount);
    const isPositief = t.amount >= 0;

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

    rows.push(snelstartRow([
      bankDagboek,
      boekingcode,
      datum,
      gb.nummer,
      isPositief ? "0" : formatAmount(bedrag),
      isPositief ? formatAmount(bedrag) : "0",
      omschrijving,
    ]));

    exportedTransactions++;
    if (source === "1799") bookedTo1799++;
    boekingcode++;
  }

  return {
    rows,
    exportedTransactions,
    bookedTo1799,
    skippedTransactions,
    skippedManualInvalidLedger,
    skippedMissingFallback1799,
    skippedUnconfirmed,
    skippedUnprocessed,
  };
}

export function exportBankTransactionsCSV(
  transactions: BankTransaction[],
  grootboekrekeningen: Grootboek[],
  clientName?: string,
  bankDagboek: number = 1100
): BankExportMeta {
  const result = buildBankSnelstartRows(transactions, grootboekrekeningen, bankDagboek);
  const prefix = clientName ? `${clientName.replace(/\s+/g, "_")}_` : "";
  downloadSnelstartCSV(buildSnelstartCSV(result.rows), `${prefix}banktransacties_snelstart.csv`);
  return {
    exportedTransactions: result.exportedTransactions,
    exportedCsvRows: result.rows.length,
    bookedTo1799: result.bookedTo1799,
    skippedTransactions: result.skippedTransactions,
    skippedManualInvalidLedger: result.skippedManualInvalidLedger,
    skippedMissingFallback1799: result.skippedMissingFallback1799,
    skippedUnconfirmed: result.skippedUnconfirmed,
    skippedUnprocessed: result.skippedUnprocessed,
  };
}

export async function exportAllForClient(
  clientName: string,
  invoices: PurchaseInvoice[],
  entries: JournalEntry[],
  transactions: BankTransaction[],
  grootboekrekeningen: Grootboek[],
  bankDagboek: number = 1100,
) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const prefix = clientName.replace(/\s+/g, "_");
  const bom = "﻿";

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
    const { rows } = buildBankSnelstartRows(transactions, grootboekrekeningen, bankDagboek);
    if (rows.length > 0) {
      // SnelStart 12 verwacht GEEN BOM marker
      zip.file(`${prefix}_banktransacties.csv`, buildSnelstartCSV(rows));
    }
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${prefix}_snelstart_export.zip`;
  a.click();
  URL.revokeObjectURL(url);
}
