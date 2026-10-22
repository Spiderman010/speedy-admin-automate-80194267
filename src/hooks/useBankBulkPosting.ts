import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { useAuth } from "./useAuth";
import {
  BANK_BULK_MAX_BATCH,
  bulkErrorMessage,
  chunkTransactionIds,
  isDeployWindowError,
  partialErrorForChunk,
  type BankBulkCandidate,
  type BankBulkResult,
} from "@/lib/bank-bulk-posting";

/**
 * De datalaag van de bank-inhaalslag.
 *
 * Er wordt hier NOOIT in `ledger_postings` of `bank_transaction_postings`
 * geschreven, en er wordt geen enkel bedrag, geen BTW en geen rekening
 * berekend of gekozen. Er gaan precies twee soorten aanroepen de deur uit:
 *
 *   public.bank_bulk_posting_candidates(_client_id, _boekjaar)   alleen lezen
 *   public.post_bank_transactions_bulk(_transaction_ids)         id's, meer niet
 *
 * De tweede biedt elke id binnen de database aan
 * `public.post_bank_transaction()` aan — de bestaande, geharde schrijver, die
 * de autoriteit blijft. Honderden regels gaan in één browserverzoek; pas
 * boven de bovengrens van de database wordt de lijst in opeenvolgende partijen
 * aangeboden, elke id precies één keer.
 */

export const BANK_BULK_CANDIDATES_QUERY_KEY = "bank-bulk-candidates" as const;

/**
 * TIJDELIJKE SHIM — weghalen zodra 20260922120000 is toegepast en
 * `src/integrations/supabase/types.ts` opnieuw is gegenereerd (nooit met de
 * hand bijwerken, zie AGENTS.md en patterns §11). De cast is bewust zo smal
 * mogelijk: precies deze twee aanroepen, met echte parameter- en
 * resultaattypes — geen brede `any`-laag.
 */
type BulkRpcError = { code?: string; message?: string };

/**
 * De preflight is een set-returning RPC: PostgREST kapt haar resultaat net zo
 * af op de rijgrens als een tabel, en pagineert het met order/range.
 */
interface BankBulkCandidatesQuery {
  order(column: "transaction_date" | "transaction_id", options: { ascending: boolean }): BankBulkCandidatesQuery;
  range(from: number, to: number): PromiseLike<{ data: BankBulkCandidate[] | null; error: BulkRpcError | null }>;
}

interface BankBulkApi {
  rpc(
    fn: "bank_bulk_posting_candidates",
    args: { _client_id: string; _boekjaar: number | null },
  ): BankBulkCandidatesQuery;
  rpc(
    fn: "post_bank_transactions_bulk",
    args: { _transaction_ids: string[] },
  ): PromiseLike<{ data: BankBulkResult[] | null; error: BulkRpcError | null }>;
}

const bulkApi = () => supabase as unknown as BankBulkApi;

/**
 * De werkstroomtoestand per bankregel van één administratie.
 *
 * `null` betekent "kon het niet weten" (deploy-venster) en is nadrukkelijk
 * iets anders dan een lege lijst: er wordt nooit "niets te doen" gemeld op
 * grond van gegevens die niet konden worden opgehaald.
 */
export function useBankBulkCandidates(options: {
  clientId: string | undefined;
  boekjaar?: number | null;
  enabled?: boolean;
}) {
  const { user } = useAuth();
  const { clientId, boekjaar = null, enabled = true } = options;

  return useQuery<BankBulkCandidate[] | null>({
    queryKey: [BANK_BULK_CANDIDATES_QUERY_KEY, clientId ?? "", boekjaar ?? "alle"],
    enabled: !!user && !!clientId && enabled,
    queryFn: async () => {
      // Volledig voorbij de rijgrens: pagina voor pagina. De functie sorteert
      // zelf op (transaction_date, id); dezelfde totale volgorde gaat hier
      // expliciet mee, zodat de paginavensters ook deterministisch blijven als
      // de functie ooit anders gaat sorteren.
      try {
        return await fetchAllRows<BankBulkCandidate>(
          (from, to) =>
            bulkApi()
              .rpc("bank_bulk_posting_candidates", { _client_id: clientId!, _boekjaar: boekjaar })
              .order("transaction_date", { ascending: true })
              .order("transaction_id", { ascending: true })
              .range(from, to),
          { key: (c) => c.transaction_id },
        );
      } catch (error) {
        if (isDeployWindowError(error)) return null;
        throw new Error(bulkErrorMessage(error));
      }
    },
  });
}

export interface PostBankTransactionsBulkInput {
  /** Uitsluitend id's. Nooit een bedrag, een rekening of een percentage. */
  transactionIds: string[];
}

/**
 * De enige schrijfactie van deze laag. Geen automatische herkansing: een
 * geweigerde regel blijft geweigerd en wordt binnen deze aanroep niet opnieuw
 * aangeboden.
 */
export function usePostBankTransactionsBulk() {
  const queryClient = useQueryClient();

  return useMutation<BankBulkResult[], Error, PostBankTransactionsBulkInput>({
    mutationFn: async ({ transactionIds }) => {
      if (transactionIds.length === 0) {
        throw new Error("Geen banktransacties geselecteerd.");
      }

      const results: BankBulkResult[] = [];
      const chunks = chunkTransactionIds(transactionIds, BANK_BULK_MAX_BATCH);
      for (const [index, chunk] of chunks.entries()) {
        const { data, error } = await bulkApi().rpc("post_bank_transactions_bulk", {
          _transaction_ids: chunk,
        });
        if (error) {
          // DRIE groepen, nooit op één hoop. `results` staat vast. DEZE partij
          // is al verstuurd: een transportfout zegt niets over wat de database
          // ermee heeft gedaan, dus haar uitkomst is ONBEKEND — niet "niet
          // aangeboden". Alleen de partijen hierná zijn met zekerheid nooit
          // verstuurd. De indeling zelf staat in de pure laag, zodat zij
          // toetsbaar is. Er wordt niets opnieuw geprobeerd.
          throw partialErrorForChunk(chunks, index, results, bulkErrorMessage(error));
        }
        results.push(...(data ?? []));
      }
      return results;
    },
    onSettled: () => {
      // Ook na een fout: een gedeeltelijk geslaagde partij mag niet als oude
      // toestand in de cache blijven staan.
      queryClient.invalidateQueries({ queryKey: [BANK_BULK_CANDIDATES_QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: ["bank-transaction-posting"] });
      queryClient.invalidateQueries({ queryKey: ["bank_transactions"] });
      queryClient.invalidateQueries({ queryKey: ["ledger-postings"] });
      queryClient.invalidateQueries({ queryKey: ["ledger-catchup"] });
      queryClient.invalidateQueries({ queryKey: ["ledger-completeness"] });
    },
  });
}
