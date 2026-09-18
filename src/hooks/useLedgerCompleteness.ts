import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useOpeningBalanceOverview } from "./useOpeningBalances";
import {
  computeLedgerCompleteness,
  computeOpeningBalanceCompleteness,
  PURCHASE_POSTABLE_STATUSES,
  reportYearForPeriod,
  SALES_POSTABLE_STATUSES,
  unknownOpeningBalanceCompleteness,
  type LedgerCompleteness,
  type LedgerCompletenessCounts,
  type OpeningBalanceCompleteness,
} from "@/lib/ledger-completeness";
import type { LedgerPeriod } from "@/lib/ledger-reporting";

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
  table: "sales_invoices" | "bank_allocation_postings" | "manual_journals" | "manual_journal_postings",
  clientId: string,
  refine?: (q: ReturnType<ReturnType<typeof supabase.from>["select"]>) => typeof q,
): Promise<number> {
  let query = supabase.from(table).select("*", { count: "exact", head: true }).eq("client_id", clientId);
  if (refine) query = refine(query);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

/**
 * Id-lijsten in batches van 1000 (PostgREST-limiet), alleen de genoemde
 * kolommen. Gesorteerd op de sleutelkolom (uniek) en ontdubbeld op die
 * sleutel: op een niet-unieke kolom als created_at is de paginavolgorde niet
 * stabiel, waardoor een rij kon worden overgeslagen of dubbel geteld.
 */
async function fetchIds<T extends Record<string, unknown>>(
  table:
    | "bank_transaction_allocations"
    | "purchase_invoice_postings"
    | "sales_invoice_postings"
    | "purchase_invoices"
    | "sales_invoices",
  columns: string,
  keyColumn: string,
  clientId: string,
  refine?: (q: ReturnType<ReturnType<typeof supabase.from>["select"]>) => typeof q,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<unknown>();
  for (let offset = 0; ; ) {
    let query = supabase.from(table).select(columns).eq("client_id", clientId);
    if (refine) query = refine(query);
    const { data, error } = await query.order(keyColumn, { ascending: true }).range(offset, offset + BATCH - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as T[];
    for (const row of batch) {
      const key = row[keyColumn];
      if (!seen.has(key)) {
        seen.add(key);
        all.push(row);
      }
    }
    if (batch.length === 0) break;
    offset += batch.length;
  }
  return all;
}

export async function fetchLedgerCompletenessCounts(clientId: string): Promise<LedgerCompletenessCounts> {
  if (!clientId) throw new Error("Volledigheid vereist een administratie (client_id)");

  // "Geboekt" telt alleen als de factuur op dit moment óók postbaar is: de
  // inkoopstatus wordt na het boeken NIET bevroren (anders dan bij verkoop),
  // dus een teruggezette factuur zou anders een marker zonder postbaar
  // document opleveren en de melding "volledig" laten zeggen terwijl een
  // andere factuur nog niet geboekt is. Daarom: doorsnede van id-lijsten,
  // geen aftrekken van twee tellingen.
  const [
    purchaseEligibleIds,
    purchaseMarkers,
    salesEligibleIds,
    salesRefused,
    salesMarkers,
    bankPosted,
    manualTotal,
    manualPosted,
    allocations,
  ] = await Promise.all([
    fetchIds<{ id: string }>("purchase_invoices", "id", "id", clientId, (q) =>
      q.in("status", [...PURCHASE_POSTABLE_STATUSES]),
    ),
    fetchIds<{ purchase_invoice_id: string }>("purchase_invoice_postings", "purchase_invoice_id", "purchase_invoice_id", clientId),
    fetchIds<{ id: string }>("sales_invoices", "id", "id", clientId, (q) =>
      q.in("status", [...SALES_POSTABLE_STATUSES]).eq("btw_verlegd", false),
    ),
    countRows("sales_invoices", clientId, (q) => q.in("status", [...SALES_POSTABLE_STATUSES]).eq("btw_verlegd", true)),
    fetchIds<{ sales_invoice_id: string }>("sales_invoice_postings", "sales_invoice_id", "sales_invoice_id", clientId),
    countRows("bank_allocation_postings", clientId),
    countRows("manual_journals", clientId),
    countRows("manual_journal_postings", clientId),
    fetchIds<{ id: string; invoice_id: string; invoice_type: string }>(
      "bank_transaction_allocations",
      "id, invoice_id, invoice_type",
      "id",
      clientId,
    ),
  ]);

  const postedPurchase = new Set(purchaseMarkers.map((m) => m.purchase_invoice_id));
  const postedSales = new Set(salesMarkers.map((m) => m.sales_invoice_id));
  const purchasePostedEligible = purchaseEligibleIds.filter((r) => postedPurchase.has(r.id)).length;
  const salesPostedEligible = salesEligibleIds.filter((r) => postedSales.has(r.id)).length;

  // Een koppeling is pas postbaar als de factuur zelf geboekt is (6C-b5b eist dat).
  let bankEligible = 0;
  for (const a of allocations) {
    const invoicePosted = a.invoice_type === "inkoop" ? postedPurchase.has(a.invoice_id) : postedSales.has(a.invoice_id);
    if (invoicePosted) bankEligible++;
  }

  return {
    purchase: { eligible: purchaseEligibleIds.length, posted: purchasePostedEligible },
    sales: { eligible: salesEligibleIds.length, posted: salesPostedEligible, refusedVerlegd: salesRefused },
    bank: { eligible: bankEligible, posted: bankPosted, awaitingInvoice: allocations.length - bankEligible },
    manual: { total: manualTotal, posted: manualPosted },
  };
}

export interface UseLedgerCompletenessOptions {
  /**
   * Standaard `true`, zodat elke bestaande aanroeper (de saldischermen en de
   * proef- en saldibalans, waar deze meter altijd zichtbaar is) ongewijzigd
   * blijft werken.
   *
   * De jaarrekeningrapporten hebben hem alleen nodig zodra vaststaat dát het
   * rapport leeg is — en dat is pas na het laden bekend. `fetchLedgerCompleteness
   * Counts` is geen goedkope query: negen parallelle tellingen en id-lijsten
   * met paginering per administratie. Die hoort niet mee te draaien op een
   * gevulde balans die er niets mee doet. Vandaar een schakelaar en géén
   * voorwaardelijke hook-aanroep: de hook draait altijd, de query niet.
   */
  enabled?: boolean;
}

export function useLedgerCompleteness(clientId: string | undefined, options?: UseLedgerCompletenessOptions) {
  const { user } = useAuth();
  const wanted = options?.enabled ?? true;
  return useQuery<LedgerCompleteness>({
    queryKey: ["ledger-completeness", clientId ?? ""],
    enabled: !!user && !!clientId && wanted,
    queryFn: async () => computeLedgerCompleteness(await fetchLedgerCompletenessCounts(clientId!)),
  });
}

/**
 * Fase 6C-b8 PR 3 — beginbalans-dimensie van de volledigheid. Eén query per
 * administratie (dezelfde als de beginbalanspagina: koppen + claim, dus na
 * elke mutatie daar ook hier vers), zuiver afgeleid per rapportjaar. Geen
 * bedragen, geen ledger_postings.
 */
export function useOpeningBalanceCompleteness(clientId: string | undefined, period: LedgerPeriod) {
  const overview = useOpeningBalanceOverview(clientId);
  const year = reportYearForPeriod(period);
  const data = useMemo<OpeningBalanceCompleteness | undefined>(() => {
    if (overview.isError) return unknownOpeningBalanceCompleteness(year);
    if (!overview.data) return undefined;
    return computeOpeningBalanceCompleteness({
      headers: overview.data.headers,
      marker: overview.data.marker,
      year,
    });
  }, [overview.data, overview.isError, year]);
  return { data, isPending: overview.isPending, isError: overview.isError };
}
