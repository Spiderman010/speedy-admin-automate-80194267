import type { Tables } from "@/integrations/supabase/types";
import type { BankTransactionAllocation } from "@/hooks/useBankTransactionAllocations";
import { resolveBankExportGrootboek } from "@/lib/snelstart-export";
import { getInvoiceTotalAmount, getInvoiceRemainingAmount } from "@/lib/invoice-balances";
import { getDisplayDescription } from "@/lib/mt940-description-parser";

type BankTransaction = Tables<"bank_transactions">;
type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;
type Grootboek = { id: string; nummer: number; omschrijving: string };

const SEP = ";";

const HEADERS = [
  "Klant",
  "Bankdatum",
  "Bankomschrijving",
  "Bankbedrag",
  "Bank export grootboek",
  "Bank export grootboek naam",
  "Afletterstatus",
  "Factuurtype",
  "Factuurnummer",
  "Relatie",
  "Factuurdatum",
  "Factuurbedrag",
  "Afgeletterd bedrag",
  "Factuur openstaand",
  "Allocatiedatum",
  "Opmerking",
];

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const parts = dateStr.substring(0, 10).split("-");
  if (parts.length === 3) {
    const dd = parts[2].padStart(2, "0");
    const mm = parts[1].padStart(2, "0");
    return `${dd}-${mm}-${parts[0]}`;
  }
  return "";
}

function formatAmount(amount: number | null | undefined): string {
  if (amount == null) return "";
  return amount.toFixed(2).replace(".", ",");
}

function csvField(value: string | null | undefined): string {
  return `"${(value ?? "").replace(/"/g, '""')}"`;
}

function csvRow(fields: (string | null | undefined)[]): string {
  return fields.map(csvField).join(SEP);
}

/**
 * Exports a reconciliation (afletterrapport) CSV for SnelStart control.
 * One row per bank_transaction_allocations row for definitively matched/booked
 * transactions (gematcht or handmatig_geboekt with an invoice allocation).
 *
 * Returns the number of data rows written (0 = nothing to export).
 */
export function exportAfletterrapportCSV(
  allocations: BankTransactionAllocation[],
  transactions: BankTransaction[],
  purchaseInvoices: PurchaseInvoice[],
  salesInvoices: SalesInvoice[],
  grootboekrekeningen: Grootboek[],
  clientName?: string,
): number {
  const txById = new Map<string, BankTransaction>(transactions.map(t => [t.id, t]));
  const purchaseById = new Map<string, PurchaseInvoice>(purchaseInvoices.map(i => [i.id, i]));
  const salesById = new Map<string, SalesInvoice>(salesInvoices.map(i => [i.id, i]));

  // Count allocations per bank transaction for status / remarks
  const allocCountByTxId = new Map<string, number>();
  for (const a of allocations) {
    allocCountByTxId.set(a.bank_transaction_id, (allocCountByTxId.get(a.bank_transaction_id) ?? 0) + 1);
  }

  const dataRows: string[] = [];
  const klant = clientName ?? "";

  for (const alloc of allocations) {
    const tx = txById.get(alloc.bank_transaction_id);
    if (!tx) continue;

    // Only definitively matched or manually booked transactions with invoice allocations
    if (tx.match_status !== "gematcht" && tx.match_status !== "handmatig_geboekt") continue;

    const purchaseInv = alloc.invoice_type === "inkoop" ? purchaseById.get(alloc.invoice_id) : undefined;
    const salesInv = alloc.invoice_type === "verkoop" ? salesById.get(alloc.invoice_id) : undefined;
    const inv = purchaseInv ?? salesInv;
    if (!inv) continue;

    // Bank export grootboek
    const { grootboek: gb, source } = resolveBankExportGrootboek(tx, grootboekrekeningen);
    const gbNummer = gb ? String(gb.nummer) : "";
    const gbNaam = source === "1799" ? "Onbekende betalingen" : (gb?.omschrijving ?? "");

    // Afletterstatus: multi-invoice takes priority over paid/partial
    const allocCount = allocCountByTxId.get(alloc.bank_transaction_id) ?? 1;
    const remaining = getInvoiceRemainingAmount(inv);
    const isFullyPaid = remaining != null && remaining < 0.01;
    const afletterstatus =
      allocCount > 1 ? "Meerdere facturen"
      : isFullyPaid   ? "Volledig afgeletterd"
                      : "Deelbetaling";

    // Invoice fields
    const factuurtype = alloc.invoice_type === "inkoop" ? "Inkoop" : "Verkoop";
    const factuurnummer = (purchaseInv?.invoice_number ?? salesInv?.invoice_number) ?? "";
    const relatie = (purchaseInv?.supplier ?? salesInv?.customer_name) ?? "";
    const factuurdatum = formatDate(purchaseInv?.invoice_date ?? salesInv?.invoice_date);
    const factuurbedrag = formatAmount(getInvoiceTotalAmount(inv));
    const openstaand = remaining != null ? formatAmount(remaining) : "";
    const allocatiedatum = formatDate(alloc.created_at.substring(0, 10));

    // Opmerking: collect all applicable notes
    const opmerkingen: string[] = [];
    if (allocCount > 1) opmerkingen.push("Meerdere facturen gekoppeld aan één bankbetaling.");
    if (source === "1799") opmerkingen.push("Bankregel geboekt op 1799; afletteren in SnelStart met factuurreferentie.");
    if (remaining != null && remaining > 0.01) opmerkingen.push("Deelbetaling; factuur staat nog deels open.");

    dataRows.push(csvRow([
      klant,
      formatDate(tx.transaction_date),
      getDisplayDescription(tx.description),
      formatAmount(tx.amount),
      gbNummer,
      gbNaam,
      afletterstatus,
      factuurtype,
      factuurnummer,
      relatie,
      factuurdatum,
      factuurbedrag,
      formatAmount(alloc.amount),
      openstaand,
      allocatiedatum,
      opmerkingen.join(" | "),
    ]));
  }

  if (dataRows.length === 0) return 0;

  const content = [csvRow(HEADERS), ...dataRows].join("\r\n");
  const bom = "﻿";
  const blob = new Blob([bom + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const prefix = clientName ? `${clientName.replace(/\s+/g, "_")}_` : "";
  a.download = `${prefix}afletterrapport_snelstart.csv`;
  a.click();
  URL.revokeObjectURL(url);

  return dataRows.length;
}
