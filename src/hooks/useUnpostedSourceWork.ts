import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { PURCHASE_POSTABLE_STATUSES, SALES_POSTABLE_STATUSES } from "@/lib/ledger-completeness";
import type { UnpostedWorkItem } from "@/lib/year-close-readiness";

/**
 * Postbaar, nog niet geboekt bronwerk — mét het boekjaar uit de ECHTE
 * boekhoudkundige datum. UITSLUITEND LEZEN.
 *
 * WAAROM DIT BESTAAT. `computeLedgerCompleteness()` telt hetzelfde werk al,
 * maar zonder datum, en een jaarafsluiting moet nu juist kunnen onderscheiden
 * wat vóór, in of ná het gekozen boekjaar ligt. Zonder dat onderscheid maakte
 * een openstaande factuur uit 2027 het afsluiten van 2026 onterecht onmogelijk.
 *
 * ER WORDT GEEN REGEL BIJ VERZONNEN. Wat "postbaar maar nog niet geboekt" is,
 * komt uit dezelfde bronnen en dezelfde constanten als
 * `fetchLedgerCompletenessCounts()`:
 *
 *   inkoop     status ∈ PURCHASE_POSTABLE_STATUSES, geen marker  → invoice_date
 *   verkoop    status ∈ SALES_POSTABLE_STATUSES, btw_verlegd=false,
 *              geen marker                                       → invoice_date
 *   bank       een aflettering waarvan de factuur geboekt is en
 *              die zelf nog geen marker heeft                     → transaction_date
 *   memoriaal  een memoriaalboeking zonder marker                 → posting_date
 *
 * NOOIT `created_at`. Wanneer een rij is aangemaakt zegt niets over het jaar
 * waarin zij boekhoudkundig hoort; elke schrijver leidt `boekjaar` af uit de
 * brondatum, en dat doet deze hook ook. Ontbreekt die datum, dan is het
 * boekjaar `null` en niet geraden — de gereedheid wordt daar onvolledig van.
 */

export const UNPOSTED_SOURCE_WORK_QUERY_KEY = "unposted-source-work" as const;

const BATCH = 1000;

type Tabel =
  | "purchase_invoices"
  | "sales_invoices"
  | "purchase_invoice_postings"
  | "sales_invoice_postings"
  | "bank_transaction_allocations"
  | "bank_allocation_postings"
  | "bank_transactions"
  | "manual_journals"
  | "manual_journal_postings";

/** Gepagineerd, gesorteerd op een unieke sleutel en daarop ontdubbeld. */
async function fetchAll<T extends Record<string, unknown>>(
  table: Tabel,
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

/** Boekjaar uit een ISO-datum, exact zoals `EXTRACT(YEAR FROM …)` in de schrijvers. */
function boekjaarVan(date: string | null | undefined): number | null {
  if (!date) return null;
  const jaar = Number(String(date).slice(0, 4));
  return Number.isInteger(jaar) && jaar > 0 ? jaar : null;
}

export async function fetchUnpostedSourceWork(clientId: string): Promise<UnpostedWorkItem[]> {
  if (!clientId) throw new Error("Openstaand bronwerk vereist een administratie (client_id)");

  const [
    purchaseEligible, purchaseMarkers,
    salesEligible, salesMarkers,
    allocations, allocationMarkers, bankTransactions,
    manualJournals, manualMarkers,
  ] = await Promise.all([
    fetchAll<{ id: string; invoice_date: string | null }>(
      "purchase_invoices", "id, invoice_date", "id", clientId,
      (q) => q.in("status", [...PURCHASE_POSTABLE_STATUSES]),
    ),
    fetchAll<{ purchase_invoice_id: string }>(
      "purchase_invoice_postings", "purchase_invoice_id", "purchase_invoice_id", clientId,
    ),
    fetchAll<{ id: string; invoice_date: string | null }>(
      "sales_invoices", "id, invoice_date", "id", clientId,
      (q) => q.in("status", [...SALES_POSTABLE_STATUSES]).eq("btw_verlegd", false),
    ),
    fetchAll<{ sales_invoice_id: string }>(
      "sales_invoice_postings", "sales_invoice_id", "sales_invoice_id", clientId,
    ),
    fetchAll<{ id: string; bank_transaction_id: string; invoice_id: string; invoice_type: string }>(
      "bank_transaction_allocations", "id, bank_transaction_id, invoice_id, invoice_type", "id", clientId,
    ),
    fetchAll<{ allocation_id: string }>(
      "bank_allocation_postings", "allocation_id", "allocation_id", clientId,
    ),
    fetchAll<{ id: string; transaction_date: string | null }>(
      "bank_transactions", "id, transaction_date", "id", clientId,
    ),
    fetchAll<{ id: string; posting_date: string | null }>(
      "manual_journals", "id, posting_date", "id", clientId,
    ),
    fetchAll<{ manual_journal_id: string }>(
      "manual_journal_postings", "manual_journal_id", "manual_journal_id", clientId,
    ),
  ]);

  const geboekteInkoop = new Set(purchaseMarkers.map((m) => m.purchase_invoice_id));
  const geboekteVerkoop = new Set(salesMarkers.map((m) => m.sales_invoice_id));
  const geboekteAfletteringen = new Set(allocationMarkers.map((m) => m.allocation_id));
  const geboekteMemoriaal = new Set(manualMarkers.map((m) => m.manual_journal_id));
  const transactieDatum = new Map(bankTransactions.map((t) => [t.id, t.transaction_date]));

  const items: UnpostedWorkItem[] = [];

  for (const invoice of purchaseEligible) {
    if (geboekteInkoop.has(invoice.id)) continue;
    items.push({ source: "purchase_invoice", id: invoice.id, boekjaar: boekjaarVan(invoice.invoice_date) });
  }
  for (const invoice of salesEligible) {
    if (geboekteVerkoop.has(invoice.id)) continue;
    items.push({ source: "sales_invoice", id: invoice.id, boekjaar: boekjaarVan(invoice.invoice_date) });
  }
  for (const allocation of allocations) {
    if (geboekteAfletteringen.has(allocation.id)) continue;
    // Een aflettering is pas postbaar zodra de factuur zelf geboekt is — exact
    // de regel die `fetchLedgerCompletenessCounts()` ook hanteert (6C-b5b).
    const factuurGeboekt =
      allocation.invoice_type === "inkoop"
        ? geboekteInkoop.has(allocation.invoice_id)
        : geboekteVerkoop.has(allocation.invoice_id);
    if (!factuurGeboekt) continue;
    // De boekhoudkundige datum van een aflettering is die van de banktransactie;
    // dat is ook wat de schrijver gebruikt.
    items.push({
      source: "bank_allocation",
      id: allocation.id,
      boekjaar: boekjaarVan(transactieDatum.get(allocation.bank_transaction_id) ?? null),
    });
  }
  for (const journal of manualJournals) {
    if (geboekteMemoriaal.has(journal.id)) continue;
    items.push({ source: "manual_journal", id: journal.id, boekjaar: boekjaarVan(journal.posting_date) });
  }

  return items;
}

export function useUnpostedSourceWork(clientId: string | undefined, enabled = true) {
  const { user } = useAuth();
  return useQuery<UnpostedWorkItem[]>({
    queryKey: [UNPOSTED_SOURCE_WORK_QUERY_KEY, clientId ?? ""],
    enabled: enabled && !!user && !!clientId,
    queryFn: () => fetchUnpostedSourceWork(clientId!),
  });
}
