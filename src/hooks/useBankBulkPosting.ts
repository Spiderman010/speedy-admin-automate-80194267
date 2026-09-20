import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import {
  BANK_BULK_MAX_BATCH,
  bulkErrorMessage,
  chunkTransactionIds,
  isDeployWindowError,
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
interface BankBulkApi {
  rpc(
    fn: "bank_bulk_posting_candidates",
    args: { _client_id: string; _boekjaar: number | null },
  ): PromiseLike<{ data: BankBulkCandidate[] | null; error: { code?: string; message?: string } | null }>;
  rpc(
    fn: "post_bank_transactions_bulk",
    args: { _transaction_ids: string[] },
  ): PromiseLike<{ data: BankBulkResult[] | null; error: { code?: string; message?: string } | null }>;
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
      const { data, error } = await bulkApi().rpc("bank_bulk_posting_candidates", {
        _client_id: clientId!,
        _boekjaar: boekjaar,
      });
      if (error) {
        if (isDeployWindowError(error)) return null;
        throw new Error(bulkErrorMessage(error));
      }
      return data ?? [];
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
      for (const chunk of chunkTransactionIds(transactionIds, BANK_BULK_MAX_BATCH)) {
        const { data, error } = await bulkApi().rpc("post_bank_transactions_bulk", {
          _transaction_ids: chunk,
        });
        if (error) throw new Error(bulkErrorMessage(error));
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
