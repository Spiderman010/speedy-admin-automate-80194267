import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { usePostPurchaseInvoice } from "./usePurchaseInvoicePosting";
import { usePostSalesInvoice } from "./useSalesInvoicePosting";
import {
  catchupRunOrder,
  evaluatePurchaseInvoice,
  evaluateSalesInvoice,
  summarize,
  type CatchupClientConfig,
  type CatchupLineAggregate,
  type CatchupPurchaseInvoice,
  type CatchupRecord,
  type CatchupRunFailure,
  type CatchupRunResult,
  type CatchupSalesInvoice,
  type CatchupSummary,
} from "@/lib/ledger-catchup";

/**
 * Historische grootboekvulling — de datalaag.
 *
 * Leest brondocumenten en de MARKER-tabellen (purchase_invoice_postings,
 * sales_invoice_postings) en laat `ledger-catchup.ts` er een oordeel over
 * vellen. Er wordt nooit uit ledger_postings gelezen om te bepalen of iets
 * geboekt is — de markers zijn daarvoor de autoriteit, precies zoals de
 * writers ze zelf schrijven.
 *
 * Boeken gebeurt uitsluitend via de BESTAANDE mutatiehooks, die op hun beurt
 * niets anders doen dan de bestaande RPC aanroepen. In dit bestand staat geen
 * enkele INSERT, en het woord ledger_postings komt hier niet voor als
 * schrijfdoel.
 *
 * Alles is per administratie (`client_id`). Elke query draagt dat predicaat
 * expliciet; RLS is organisatiebreed en vervangt het niet.
 */

const BATCH = 1000;
/** Id's per `in(...)`-filter, zodat de query-URL hanteerbaar blijft. */
const ID_CHUNK = 100;

export const LEDGER_CATCHUP_QUERY_KEY = "ledger-catchup" as const;

export interface CatchupPeriodFilter {
  /** `null` = alle jaren. */
  year: number | null;
}

function yearRange(year: number | null): { from: string; toExclusive: string } | null {
  if (year === null) return null;
  return { from: `${year}-01-01`, toExclusive: `${year + 1}-01-01` };
}

async function fetchAll<T>(
  // PostgREST-builders zijn thenable, geen echte Promise; PromiseLike laat ze
  // rechtstreeks doorgeven zonder een overbodige wrapper.
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

/**
 * De regelgegevens waar de writer op controleert: aantal regels, som exclusief
 * BTW, het aantal regels zonder grootboekrekening en het aantal regels met een
 * bedrag van nul of lager. Dat laatste is een controle PER REGEL — de writer
 * weigert elke individuele regel met `amount_excl <= 0`, en dat is niet uit de
 * som af te leiden.
 */
async function fetchLineAggregates(invoiceIds: readonly string[]): Promise<Map<string, CatchupLineAggregate>> {
  const perInvoice = new Map<string, CatchupLineAggregate>();
  for (const ids of chunk(invoiceIds, ID_CHUNK)) {
    const rows = await fetchAll<{ purchase_invoice_id: string; amount_excl: number; grootboekrekening_id: string | null; id: string }>(
      (offset) =>
        supabase
          .from("purchase_invoice_lines")
          .select("id, purchase_invoice_id, amount_excl, grootboekrekening_id")
          .in("purchase_invoice_id", [...ids])
          .order("id", { ascending: true })
          .range(offset, offset + BATCH - 1),
      (r) => r.id,
    );
    for (const row of rows) {
      const current = perInvoice.get(row.purchase_invoice_id)
        ?? { count: 0, sumExcl: 0, withoutAccount: 0, nonPositiveAmountCount: 0 };
      const amount = row.amount_excl ?? 0;
      current.count += 1;
      current.sumExcl += amount;
      if (!row.grootboekrekening_id) current.withoutAccount += 1;
      // Exact de drempel van de writer: nul telt mee, niet alleen negatief.
      if (amount <= 0) current.nonPositiveAmountCount += 1;
      perInvoice.set(row.purchase_invoice_id, current);
    }
  }
  return perInvoice;
}

export interface LedgerCatchupData {
  records: CatchupRecord[];
  purchase: CatchupSummary;
  sales: CatchupSummary;
}

export async function fetchLedgerCatchup(opts: {
  clientId: string;
  period: CatchupPeriodFilter;
}): Promise<LedgerCatchupData> {
  const { clientId, period } = opts;
  if (!clientId) throw new Error("Historische grootboekvulling vereist een administratie (client_id)");
  const range = yearRange(period.year);

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

  const [purchaseInvoices, salesInvoices, purchaseMarkers, salesMarkers] = await Promise.all([
    fetchAll<CatchupPurchaseInvoice>(
      (offset) => {
        let q = supabase
          .from("purchase_invoices")
          .select("id, client_id, status, invoice_date, invoice_number, supplier, amount_excl, amount_incl, btw_amount")
          .eq("client_id", clientId);
        if (range) q = q.gte("invoice_date", range.from).lt("invoice_date", range.toExclusive);
        return q.order("id", { ascending: true }).range(offset, offset + BATCH - 1);
      },
      (r) => r.id,
    ),
    fetchAll<CatchupSalesInvoice>(
      (offset) => {
        let q = supabase
          .from("sales_invoices")
          .select(
            "id, client_id, status, invoice_date, invoice_number, customer_name, amount_excl, amount_incl, btw_amount, btw_verlegd, grootboekrekening_id",
          )
          .eq("client_id", clientId);
        if (range) q = q.gte("invoice_date", range.from).lt("invoice_date", range.toExclusive);
        return q.order("id", { ascending: true }).range(offset, offset + BATCH - 1);
      },
      (r) => r.id,
    ),
    fetchAll<{ purchase_invoice_id: string; posting_group_id: string }>(
      (offset) =>
        supabase
          .from("purchase_invoice_postings")
          .select("purchase_invoice_id, posting_group_id")
          .eq("client_id", clientId)
          .order("purchase_invoice_id", { ascending: true })
          .range(offset, offset + BATCH - 1),
      (r) => r.purchase_invoice_id,
    ),
    fetchAll<{ sales_invoice_id: string; posting_group_id: string }>(
      (offset) =>
        supabase
          .from("sales_invoice_postings")
          .select("sales_invoice_id, posting_group_id")
          .eq("client_id", clientId)
          .order("sales_invoice_id", { ascending: true })
          .range(offset, offset + BATCH - 1),
      (r) => r.sales_invoice_id,
    ),
  ]);

  const postedPurchase = new Map(purchaseMarkers.map((m) => [m.purchase_invoice_id, m.posting_group_id]));
  const postedSales = new Map(salesMarkers.map((m) => [m.sales_invoice_id, m.posting_group_id]));

  // Regels alleen ophalen voor facturen die nog niet geboekt zijn: voor een
  // geboekte factuur verandert het oordeel er toch niet meer door.
  const lineAggregates = await fetchLineAggregates(
    purchaseInvoices.filter((i) => !postedPurchase.has(i.id)).map((i) => i.id),
  );

  const purchaseRecords = purchaseInvoices.map((invoice) =>
    evaluatePurchaseInvoice({
      invoice,
      config,
      lines: lineAggregates.get(invoice.id),
      postingGroupId: postedPurchase.get(invoice.id) ?? null,
    }),
  );
  const salesRecords = salesInvoices.map((invoice) =>
    evaluateSalesInvoice({
      invoice,
      config,
      postingGroupId: postedSales.get(invoice.id) ?? null,
    }),
  );

  return {
    records: [...purchaseRecords, ...salesRecords],
    purchase: summarize(purchaseRecords),
    sales: summarize(salesRecords),
  };
}

export function useLedgerCatchup(clientId: string | undefined, period: CatchupPeriodFilter) {
  const { user } = useAuth();
  return useQuery<LedgerCatchupData>({
    queryKey: [LEDGER_CATCHUP_QUERY_KEY, clientId ?? "", period.year ?? "alle"],
    enabled: !!user && !!clientId,
    queryFn: () => fetchLedgerCatchup({ clientId: clientId!, period }),
  });
}

/**
 * De bulkactie. Biedt records één voor één aan de BESTAANDE writers aan, in
 * de volgorde inkoop → verkoop.
 *
 * Per record apart, bewust: elke writeraanroep is server-side atomair (een
 * halve boekingsgroep bestaat niet), en een weigering op het ene record mag
 * het volgende niet raken. Er wordt niets opnieuw geprobeerd — een writer die
 * weigert, weigert om een reden, en een retrylus zou die reden alleen maar
 * herhalen.
 */
export function useRunLedgerCatchup() {
  const queryClient = useQueryClient();
  const postPurchase = usePostPurchaseInvoice();
  const postSales = usePostSalesInvoice();

  return useMutation<CatchupRunResult, Error, { records: readonly CatchupRecord[]; blocked: number }>({
    mutationFn: async ({ records, blocked }) => {
      // Dubbele bodem: ook als de aanroeper zich vergist, gaat er nooit een
      // geblokkeerd of reeds geboekt record naar een writer.
      const teBoeken = catchupRunOrder(records.filter((r) => r.state === "klaar"));
      const failures: CatchupRunFailure[] = [];
      let posted = 0;

      for (const record of teBoeken) {
        try {
          if (record.source === "inkoop") await postPurchase.mutateAsync(record.id);
          else await postSales.mutateAsync(record.id);
          posted++;
        } catch (e) {
          failures.push({
            id: record.id,
            source: record.source,
            reference: record.reference,
            message: e instanceof Error ? e.message : "Boeken is niet gelukt",
          });
        }
      }

      return { attempted: teBoeken.length, posted, failures, blocked };
    },
    onSettled: () => {
      // Ook na een gedeeltelijk mislukte run: wat wél geboekt is, moet meteen
      // in het grootboek en in de rapportages zichtbaar zijn.
      queryClient.invalidateQueries({ queryKey: [LEDGER_CATCHUP_QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: ["ledger-postings"] });
      queryClient.invalidateQueries({ queryKey: ["ledger-completeness"] });
    },
  });
}
