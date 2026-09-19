import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { fetchLedgerPostings } from "./useLedgerPostings";
import { fetchLedgerIntegrity } from "./useLedgerIntegrity";
import {
  aggregateInvoiceLines,
  evaluatePurchaseInvoice,
  evaluateSalesInvoice,
  type CatchupClientConfig,
  type CatchupPurchaseInvoice,
  type CatchupRecord,
  type CatchupSalesInvoice,
} from "@/lib/ledger-catchup";
import {
  diagnosticsForDocument,
  diagnosticsForLedger,
  postingGroupBalances,
  summarizeDiagnostics,
  summarizeLedger,
  type DiagnosticItem,
  type DomainSummary,
  type LedgerDiagnosticsAccount,
  type LedgerSummary,
} from "@/lib/accounting-diagnostics";

/**
 * Accounting Diagnostics — de datalaag. UITSLUITEND LEZEN.
 *
 * Geen mutatie, geen RPC, geen reparatie. Eén ophaalronde voedt alle drie de
 * domeinen én het overzicht, zodat de tabbladen per definitie hetzelfde zeggen.
 *
 * ANTI-N+1. Elke tabel wordt in gepagineerde batches opgehaald, nooit per
 * document. De regeltabellen dragen zelf geen `client_id`; die worden gescoped
 * via de factuur-id's die al op deze administratie gefilterd zijn, in blokken
 * van 100 id's per `in(...)`.
 *
 * GEEN PERIODEFILTER op de grootboekregels. Een boekingsgroep die niet sluit,
 * sluit in elk jaar niet, en een periodefilter zou een groep doormidden kunnen
 * snijden en zo een onbalans verzinnen die er niet is.
 */

const BATCH = 1000;
const ID_CHUNK = 100;

export const ACCOUNTING_DIAGNOSTICS_QUERY_KEY = "accounting-diagnostics" as const;

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

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface AccountingDiagnosticsData {
  purchase: { items: DiagnosticItem[]; summary: DomainSummary };
  sales: { items: DiagnosticItem[]; summary: DomainSummary };
  ledger: { items: DiagnosticItem[]; summary: LedgerSummary };
}

export async function fetchAccountingDiagnostics(clientId: string): Promise<AccountingDiagnosticsData> {
  if (!clientId) throw new Error("Diagnostiek vereist een administratie (client_id)");

  const { data: clientRow, error: clientError } = await supabase
    .from("clients")
    .select(
      "id, afgesloten_boekjaar, crediteuren_rekening_id, debiteuren_rekening_id, btw_te_vorderen_rekening_id, btw_te_betalen_rekening_id",
    )
    .eq("id", clientId)
    .maybeSingle();
  if (clientError) throw clientError;
  if (!clientRow) throw new Error("Administratie niet gevonden");
  const config = clientRow as CatchupClientConfig;

  const [purchaseInvoices, salesInvoices, purchaseMarkers, salesMarkers, bankMarkers, manualMarkers, postings, accounts, integrity] =
    await Promise.all([
      fetchAll<CatchupPurchaseInvoice>(
        (offset) =>
          supabase
            .from("purchase_invoices")
            .select("id, client_id, status, invoice_date, invoice_number, supplier, amount_excl, amount_incl, btw_amount")
            .eq("client_id", clientId)
            .order("id", { ascending: true })
            .range(offset, offset + BATCH - 1),
        (r) => r.id,
      ),
      fetchAll<CatchupSalesInvoice>(
        (offset) =>
          supabase
            .from("sales_invoices")
            .select(
              "id, client_id, status, invoice_date, invoice_number, customer_name, amount_excl, amount_incl, btw_amount, btw_verlegd, grootboekrekening_id",
            )
            .eq("client_id", clientId)
            .order("id", { ascending: true })
            .range(offset, offset + BATCH - 1),
        (r) => r.id,
      ),
      fetchAll<{ purchase_invoice_id: string; posting_group_id: string }>(
        (offset) =>
          supabase.from("purchase_invoice_postings").select("purchase_invoice_id, posting_group_id")
            .eq("client_id", clientId).order("purchase_invoice_id", { ascending: true })
            .range(offset, offset + BATCH - 1),
        (r) => r.purchase_invoice_id,
      ),
      fetchAll<{ sales_invoice_id: string; posting_group_id: string }>(
        (offset) =>
          supabase.from("sales_invoice_postings").select("sales_invoice_id, posting_group_id")
            .eq("client_id", clientId).order("sales_invoice_id", { ascending: true })
            .range(offset, offset + BATCH - 1),
        (r) => r.sales_invoice_id,
      ),
      fetchAll<{ allocation_id: string; posting_group_id: string }>(
        (offset) =>
          supabase.from("bank_allocation_postings").select("allocation_id, posting_group_id")
            .eq("client_id", clientId).order("allocation_id", { ascending: true })
            .range(offset, offset + BATCH - 1),
        (r) => r.allocation_id,
      ),
      fetchAll<{ manual_journal_id: string; posting_group_id: string }>(
        (offset) =>
          supabase.from("manual_journal_postings").select("manual_journal_id, posting_group_id")
            .eq("client_id", clientId).order("manual_journal_id", { ascending: true })
            .range(offset, offset + BATCH - 1),
        (r) => r.manual_journal_id,
      ),
      fetchLedgerPostings({ clientId }),
      fetchAll<LedgerDiagnosticsAccount>(
        (offset) =>
          supabase
            .from("grootboekrekeningen")
            .select("id, nummer, omschrijving, client_id, statement_type, report_group")
            .order("id", { ascending: true })
            .range(offset, offset + BATCH - 1),
        (r) => r.id,
      ),
      // De vier integriteitsregels komen ongewijzigd uit /grootboek/integriteit.
      fetchLedgerIntegrity(clientId),
    ]);

  // Inkoopregels: gescoped via de factuur-id's, in blokken. Nooit per factuur.
  const lineRows: { purchase_invoice_id: string; amount_excl: number | null; grootboekrekening_id: string | null }[] = [];
  for (const ids of chunk(purchaseInvoices.map((i) => i.id), ID_CHUNK)) {
    const rows = await fetchAll<{ id: string; purchase_invoice_id: string; amount_excl: number; grootboekrekening_id: string | null }>(
      (offset) =>
        supabase
          .from("purchase_invoice_lines")
          .select("id, purchase_invoice_id, amount_excl, grootboekrekening_id")
          .in("purchase_invoice_id", ids)
          .order("id", { ascending: true })
          .range(offset, offset + BATCH - 1),
      (r) => r.id,
    );
    lineRows.push(...rows);
  }
  const linesPerInvoice = new Map<string, typeof lineRows>();
  for (const row of lineRows) {
    const bucket = linesPerInvoice.get(row.purchase_invoice_id) ?? [];
    bucket.push(row);
    linesPerInvoice.set(row.purchase_invoice_id, bucket);
  }

  const postedPurchase = new Map(purchaseMarkers.map((m) => [m.purchase_invoice_id, m.posting_group_id]));
  const postedSales = new Map(salesMarkers.map((m) => [m.sales_invoice_id, m.posting_group_id]));

  const purchaseRecords: CatchupRecord[] = purchaseInvoices.map((invoice) =>
    evaluatePurchaseInvoice({
      invoice,
      config,
      lines: aggregateInvoiceLines(linesPerInvoice.get(invoice.id) ?? []),
      postingGroupId: postedPurchase.get(invoice.id) ?? null,
    }),
  );
  const salesRecords: CatchupRecord[] = salesInvoices.map((invoice) =>
    evaluateSalesInvoice({ invoice, config, postingGroupId: postedSales.get(invoice.id) ?? null }),
  );

  const balances = postingGroupBalances(postings);
  const existingPostingGroups = new Set(balances.keys());
  const balancedPostingGroups = new Set([...balances].filter(([, saldo]) => saldo === 0).map(([id]) => id));

  const markerClaimsPerGroup = new Map<string, number>();
  for (const groupId of [
    ...purchaseMarkers.map((m) => m.posting_group_id),
    ...salesMarkers.map((m) => m.posting_group_id),
    ...bankMarkers.map((m) => m.posting_group_id),
    ...manualMarkers.map((m) => m.posting_group_id),
  ]) {
    markerClaimsPerGroup.set(groupId, (markerClaimsPerGroup.get(groupId) ?? 0) + 1);
  }

  const groupContext = { existingPostingGroups, balancedPostingGroups };
  const purchaseItems = purchaseRecords.flatMap((r) => diagnosticsForDocument(r, groupContext));
  const salesItems = salesRecords.flatMap((r) => diagnosticsForDocument(r, groupContext));
  const ledgerItems = diagnosticsForLedger({
    integrityFindings: integrity.findings,
    postings,
    accounts,
    clientId,
    markerClaimsPerGroup,
  });

  return {
    purchase: { items: purchaseItems, summary: summarizeDiagnostics(purchaseItems, purchaseRecords) },
    sales: { items: salesItems, summary: summarizeDiagnostics(salesItems, salesRecords) },
    ledger: { items: ledgerItems, summary: summarizeLedger(ledgerItems, balances) },
  };
}

export function useAccountingDiagnostics(clientId: string | undefined) {
  const { user } = useAuth();
  return useQuery<AccountingDiagnosticsData>({
    queryKey: [ACCOUNTING_DIAGNOSTICS_QUERY_KEY, clientId ?? ""],
    enabled: !!user && !!clientId,
    queryFn: () => fetchAccountingDiagnostics(clientId!),
  });
}
