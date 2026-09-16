import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import {
  computeLedgerCompleteness,
  PURCHASE_POSTABLE_STATUSES,
  SALES_POSTABLE_STATUSES,
  type LedgerCompleteness,
  type LedgerCompletenessCounts,
} from "@/lib/ledger-completeness";

/**
 * Fase 6C-b7 PR 2 — tellingen voor de volledigheidsmelding.
 *
 * Leest uitsluitend AANTALLEN (count, head) en id-lijsten uit de document- en
 * claimtabellen; nooit een bedrag. Alles is per administratie (client_id).
 * De uitkomst is metadata naast het rapport en raakt de grootboektotalen
 * nergens — die komen alleen uit useLedgerPostings.
 */

const BATCH = 1000;

async function countRows(
  table: "purchase_invoices" | "sales_invoices" | "purchase_invoice_postings" | "sales_invoice_postings" | "bank_allocation_postings" | "manual_journals" | "manual_journal_postings",
  clientId: string,
  refine?: (q: ReturnType<ReturnType<typeof supabase.from>["select"]>) => typeof q,
): Promise<number> {
  let query = supabase.from(table).select("*", { count: "exact", head: true }).eq("client_id", clientId);
  if (refine) query = refine(query);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

/** Id-lijsten in batches van 1000 (PostgREST-limiet), alleen de genoemde kolommen. */
async function fetchIds<T extends Record<string, unknown>>(
  table: "bank_transaction_allocations" | "purchase_invoice_postings" | "sales_invoice_postings",
  columns: string,
  clientId: string,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; ) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq("client_id", clientId)
      .order("created_at", { ascending: true })
      .range(offset, offset + BATCH - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as T[];
    all.push(...batch);
    if (batch.length === 0) break;
    offset += batch.length;
  }
  return all;
}

export async function fetchLedgerCompletenessCounts(clientId: string): Promise<LedgerCompletenessCounts> {
  if (!clientId) throw new Error("Volledigheid vereist een administratie (client_id)");

  const [
    purchaseEligible,
    purchasePosted,
    salesEligible,
    salesRefused,
    salesPosted,
    bankPosted,
    manualTotal,
    manualPosted,
    allocations,
    purchaseMarkers,
    salesMarkers,
  ] = await Promise.all([
    countRows("purchase_invoices", clientId, (q) => q.in("status", [...PURCHASE_POSTABLE_STATUSES])),
    countRows("purchase_invoice_postings", clientId),
    countRows("sales_invoices", clientId, (q) => q.in("status", [...SALES_POSTABLE_STATUSES]).eq("btw_verlegd", false)),
    countRows("sales_invoices", clientId, (q) => q.in("status", [...SALES_POSTABLE_STATUSES]).eq("btw_verlegd", true)),
    countRows("sales_invoice_postings", clientId),
    countRows("bank_allocation_postings", clientId),
    countRows("manual_journals", clientId),
    countRows("manual_journal_postings", clientId),
    fetchIds<{ id: string; invoice_id: string; invoice_type: string }>(
      "bank_transaction_allocations",
      "id, invoice_id, invoice_type",
      clientId,
    ),
    fetchIds<{ purchase_invoice_id: string }>("purchase_invoice_postings", "purchase_invoice_id, created_at", clientId),
    fetchIds<{ sales_invoice_id: string }>("sales_invoice_postings", "sales_invoice_id, created_at", clientId),
  ]);

  // Een koppeling is pas postbaar als de factuur zelf geboekt is (6C-b5b eist dat).
  const postedPurchase = new Set(purchaseMarkers.map((m) => m.purchase_invoice_id));
  const postedSales = new Set(salesMarkers.map((m) => m.sales_invoice_id));
  let bankEligible = 0;
  for (const a of allocations) {
    const invoicePosted = a.invoice_type === "inkoop" ? postedPurchase.has(a.invoice_id) : postedSales.has(a.invoice_id);
    if (invoicePosted) bankEligible++;
  }

  return {
    purchase: { eligible: purchaseEligible, posted: purchasePosted },
    sales: { eligible: salesEligible, posted: salesPosted, refusedVerlegd: salesRefused },
    bank: { eligible: bankEligible, posted: bankPosted, awaitingInvoice: allocations.length - bankEligible },
    manual: { total: manualTotal, posted: manualPosted },
  };
}

export function useLedgerCompleteness(clientId: string | undefined) {
  const { user } = useAuth();
  return useQuery<LedgerCompleteness>({
    queryKey: ["ledger-completeness", clientId ?? ""],
    enabled: !!user && !!clientId,
    queryFn: async () => computeLedgerCompleteness(await fetchLedgerCompletenessCounts(clientId!)),
  });
}
