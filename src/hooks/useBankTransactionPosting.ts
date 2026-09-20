import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Direct gecodeerde bankregels boeken in het grootboek.
 *
 * De volledige boeking wordt server-side door public.post_bank_transaction()
 * gemaakt: richting (bank ↔ gekozen rekening), bedrag, BTW-splitsing, datum en
 * boekjaar komen allemaal uit de database. De frontend rekent niets uit en
 * schrijft nooit rechtstreeks in ledger_postings: het enige dat hier de deur
 * uit gaat is de transactie-id (en, los daarvan, het gekozen BTW-percentage op
 * de bankregel zelf).
 */

/** Of deze bankregel al rechtstreeks geboekt is (en zo ja, in welke groep). */
export function useBankTransactionPosting(transactionId: string | undefined) {
  return useQuery({
    queryKey: ["bank-transaction-posting", transactionId],
    enabled: !!transactionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bank_transaction_postings")
        .select("bank_transaction_id, posting_group_id, created_at")
        .eq("bank_transaction_id", transactionId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * De database geeft nette Nederlandse meldingen terug. Alleen wanneer er tóch
 * iets onverwachts doorkomt, tonen we een neutrale fallback in plaats van een
 * ruwe driverfout.
 */
function toUserMessage(error: unknown): string {
  const message = (error as { message?: string } | null)?.message?.trim();
  if (!message) return "Boeken is niet gelukt. Probeer het opnieuw.";
  if (/^[A-Z]{2}\d{3}/.test(message) || message.includes("stack depth")) {
    return "Boeken is niet gelukt. Probeer het opnieuw.";
  }
  return message;
}

export interface PostBankTransactionInput {
  transactionId: string;
  /** Optioneel: eerst het BTW-percentage op de bankregel vastleggen. */
  btwPercentage?: number | null;
}

export function usePostBankTransaction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ transactionId, btwPercentage }: PostBankTransactionInput) => {
      if (btwPercentage !== undefined) {
        const { error: updateError } = await supabase
          .from("bank_transactions")
          .update({ btw_percentage: btwPercentage })
          .eq("id", transactionId);
        if (updateError) throw new Error(toUserMessage(updateError));
      }

      const { data, error } = await supabase.rpc("post_bank_transaction", {
        _transaction_id: transactionId,
      });
      if (error) throw new Error(toUserMessage(error));
      return data;
    },
    onSuccess: (_postingGroupId, { transactionId }) => {
      queryClient.invalidateQueries({ queryKey: ["bank-transaction-posting", transactionId] });
      queryClient.invalidateQueries({ queryKey: ["bank_transactions"] });
      queryClient.invalidateQueries({ queryKey: ["ledger-postings"] });
    },
  });
}
