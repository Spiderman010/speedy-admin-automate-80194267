import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { fetchLedgerPostings } from "./useLedgerPostings";
import {
  evaluateLedgerIntegrity,
  type IntegrityLine,
  type IntegrityMarker,
  type IntegrityPurchaseInvoice,
  type LedgerIntegrityReport,
} from "@/lib/ledger-integrity";

/**
 * Grootboekintegriteit — de datalaag. UITSLUITEND LEZEN.
 *
 * Geen enkele mutatie, geen RPC, geen reparatie. Deze hook haalt op wat de
 * vier controles nodig hebben en laat `ledger-integrity.ts` er een oordeel
 * over vellen; wat daaruit komt is een lijst bevindingen voor een mens.
 *
 * Alles is per administratie (`client_id`). Elke query draagt dat predicaat
 * expliciet — RLS is organisatiebreed en vervangt het niet.
 *
 * De grootboekregels komen via de BESTAANDE `fetchLedgerPostings()`, zonder
 * periode: een boekingsgroep die niet in balans is, is dat ongeacht welk jaar
 * je bekijkt, en een periodefilter zou een groep doormidden kunnen snijden en
 * zo een onbalans verzinnen die er niet is.
 */

const BATCH = 1000;

export const LEDGER_INTEGRITY_QUERY_KEY = "ledger-integrity" as const;

async function fetchAll<T>(
  run: (offset: number) => PromiseLike<{ data: unknown; error: unknown }>,
  key: (row: T) => string,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; ) {
    const { data, error } = await run(offset);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    for (const row of batch) {
      const k = key(row);
      if (!seen.has(k)) {
        seen.add(k);
        all.push(row);
      }
    }
    if (batch.length === 0) break;
    offset += batch.length;
  }
  return all;
}

/** De vier markertabellen, elk met hun eigen sleutelkolom. */
const MARKER_SOURCES = [
  { soort: "inkoop", table: "purchase_invoice_postings", key: "purchase_invoice_id" },
  { soort: "verkoop", table: "sales_invoice_postings", key: "sales_invoice_id" },
  { soort: "bank", table: "bank_allocation_postings", key: "allocation_id" },
  { soort: "memoriaal", table: "manual_journal_postings", key: "manual_journal_id" },
] as const;

export async function fetchLedgerIntegrity(clientId: string): Promise<LedgerIntegrityReport> {
  if (!clientId) throw new Error("Integriteitscontrole vereist een administratie (client_id)");

  const [purchaseInvoices, postings, ...markerSets] = await Promise.all([
    fetchAll<IntegrityPurchaseInvoice>(
      (offset) =>
        supabase
          .from("purchase_invoices")
          .select("id, status, invoice_number, supplier, ledger_account_text")
          .eq("client_id", clientId)
          .order("id", { ascending: true })
          .range(offset, offset + BATCH - 1),
      (r) => r.id,
    ),
    fetchLedgerPostings({ clientId }),
    ...MARKER_SOURCES.map((src) =>
      fetchAll<{ posting_group_id: string; sleutel: string }>(
        (offset) =>
          supabase
            .from(src.table)
            .select(`posting_group_id, ${src.key}`)
            .eq("client_id", clientId)
            .order(src.key, { ascending: true })
            .range(offset, offset + BATCH - 1),
        (r) => String((r as unknown as Record<string, unknown>)[src.key]),
      ).then((rows) =>
        rows.map<IntegrityMarker>((r) => ({ soort: src.soort, posting_group_id: r.posting_group_id })),
      ),
    ),
  ]);

  // Regels alleen voor de facturen van deze administratie; de regeltabel draagt
  // zelf geen client_id, dus de factuur-id's zijn het enige juiste filter.
  const purchaseLines: IntegrityLine[] = [];
  const ids = purchaseInvoices.map((i) => i.id);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (chunk.length === 0) break;
    const rows = await fetchAll<{ id: string; purchase_invoice_id: string; grootboekrekening_id: string | null }>(
      (offset) =>
        supabase
          .from("purchase_invoice_lines")
          .select("id, purchase_invoice_id, grootboekrekening_id")
          .in("purchase_invoice_id", chunk)
          .order("id", { ascending: true })
          .range(offset, offset + BATCH - 1),
      (r) => r.id,
    );
    for (const r of rows) {
      purchaseLines.push({ purchase_invoice_id: r.purchase_invoice_id, grootboekrekening_id: r.grootboekrekening_id });
    }
  }

  return evaluateLedgerIntegrity({
    purchaseInvoices,
    purchaseLines,
    markers: markerSets.flat(),
    postings,
  });
}

export function useLedgerIntegrity(clientId: string | undefined) {
  const { user } = useAuth();
  return useQuery<LedgerIntegrityReport>({
    queryKey: [LEDGER_INTEGRITY_QUERY_KEY, clientId ?? ""],
    enabled: !!user && !!clientId,
    queryFn: () => fetchLedgerIntegrity(clientId!),
  });
}
