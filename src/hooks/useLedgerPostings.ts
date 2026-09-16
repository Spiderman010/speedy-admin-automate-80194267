import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Tables } from "@/integrations/supabase/types";
import {
  assertLedgerPeriod,
  assertReportingCurrency,
  assertSingleClient,
  LedgerReportingError,
  type LedgerPeriod,
} from "@/lib/ledger-reporting";

/**
 * Fase 6C-b7 PR 1 — de eerste lezer van public.ledger_postings.
 *
 * Gewone SELECT onder RLS (leesvloer read_only), geen view, geen RPC, geen
 * SECURITY DEFINER. RLS is organisatiebreed en vervangt het klantpredicaat
 * niet: client_id is hier verplicht en wordt altijd server-side meegegeven.
 *
 * Wat deze hook bewust NIET doet:
 *   • journal_entries, factuur- of banktotalen lezen — de cijfers komen
 *     uitsluitend uit ledger_postings;
 *   • filteren op reversal_of_posting_id — een tegenboeking is een rij;
 *   • filteren op actief van de rekening — dat is een join-zorg van de
 *     rapportage, en inactieve rekeningen dragen saldo;
 *   • filteren op currency — een niet-EUR-rij wordt niet weggelaten maar
 *     maakt het rapport hard ongeldig (assertReportingCurrency).
 *
 * Periode: half-open [from, toExclusive) op posting_date. De query haalt alles
 * vóór toExclusive op, zodat de rapportagekern het beginsaldo (vóór from) en
 * de periode (vanaf from) uit dezelfde set kan afleiden. boekjaar filtert niet.
 *
 * Query key ["ledger-postings", …]: de vier boek-hooks invalideren deze familie
 * al sinds 6C-b3; vanaf deze hook hebben die invalidaties effect.
 */

export type LedgerPosting = Tables<"ledger_postings">;

export const LEDGER_POSTINGS_QUERY_KEY = "ledger-postings" as const;

/** PostgREST kapt af op 1000 rijen; batchen zoals fetchAllBankTransactions. */
export const LEDGER_FETCH_BATCH_SIZE = 1000;

export interface UseLedgerPostingsOptions {
  /** Verplicht. Zonder administratie draait er geen query. */
  clientId: string | undefined;
  /** Optioneel; zonder periode wordt alles van de administratie opgehaald. */
  period?: LedgerPeriod;
  enabled?: boolean;
}

export async function fetchLedgerPostings(opts: {
  clientId: string;
  period?: LedgerPeriod;
}): Promise<LedgerPosting[]> {
  const { clientId, period } = opts;
  if (!clientId) throw new LedgerReportingError("client", "Rapportage vereist een administratie (client_id)");
  if (period) assertLedgerPeriod(period);

  const all: LedgerPosting[] = [];
  for (let offset = 0; ; offset += LEDGER_FETCH_BATCH_SIZE) {
    let query = supabase.from("ledger_postings").select("*").eq("client_id", clientId);
    if (period) query = query.lt("posting_date", period.toExclusive);
    // Dezelfde volledige volgorde als compareLedgerRows, zodat batchvensters
    // elkaar nooit overlappen of rijen overslaan.
    const { data, error } = await query
      .order("posting_date", { ascending: true })
      .order("posting_group_id", { ascending: true })
      .order("line_no", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + LEDGER_FETCH_BATCH_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as LedgerPosting[];
    all.push(...batch);
    if (batch.length < LEDGER_FETCH_BATCH_SIZE) break;
  }

  // Verdediging in de diepte: de query filtert al op client_id, maar een
  // andere administratie of valuta in de set mag nooit stilzwijgend meetellen.
  assertSingleClient(all, clientId);
  assertReportingCurrency(all);
  return all;
}

export function useLedgerPostings(options: UseLedgerPostingsOptions) {
  const { clientId, period, enabled = true } = options;
  const { user } = useAuth();
  return useQuery({
    queryKey: [
      LEDGER_POSTINGS_QUERY_KEY,
      clientId ?? "",
      period?.from ?? "",
      period?.toExclusive ?? "",
    ],
    queryFn: () => fetchLedgerPostings({ clientId: clientId!, period }),
    enabled: !!user && enabled && !!clientId,
  });
}
