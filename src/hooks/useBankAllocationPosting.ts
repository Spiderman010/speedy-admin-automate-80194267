import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Bankkoppeling (aflettering) boeken (fase 6C-b5b).
 *
 * De volledige boeking wordt server-side door public.post_bank_allocation()
 * gemaakt: richting (bank ↔ debiteuren / crediteuren ↔ bank), bedrag,
 * rekeningen, datum en boekjaar komen allemaal uit de database. De frontend
 * berekent geen bedragen, kiest geen rekeningen en schrijft nooit rechtstreeks
 * in ledger_postings: het enige dat hier de deur uit gaat is de koppeling-id.
 *
 * TIJDELIJK: bank_allocation_postings en post_bank_allocation bestaan nog niet
 * in src/integrations/supabase/types.ts, omdat de migratie pas na review op
 * productie wordt toegepast. Dat bestand wordt nooit met de hand aangepast,
 * dus de twee aanroepen lopen via een smalle cast. Verwijder die zodra de
 * types opnieuw gegenereerd zijn — net als bij PR #146/#148/#150.
 */
type UntypedPostingApi = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{
          data: { allocation_id: string; posting_group_id: string; created_at: string } | null;
          error: { message?: string } | null;
        }>;
      };
    };
  };
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{
    data: unknown;
    error: { message?: string } | null;
  }>;
};

const postingApi = supabase as unknown as UntypedPostingApi;

/** Of deze bankkoppeling al geboekt is (en zo ja, in welke boekingsgroep). */
export function useBankAllocationPosting(allocationId: string | undefined) {
  return useQuery({
    queryKey: ["bank-allocation-posting", allocationId],
    enabled: !!allocationId,
    queryFn: async () => {
      const { data, error } = await postingApi
        .from("bank_allocation_postings")
        .select("allocation_id, posting_group_id, created_at")
        .eq("allocation_id", allocationId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * De database geeft nette Nederlandse meldingen terug (geen rekeningnummers,
 * geen PostgreSQL-internals). Alleen wanneer er tóch iets onverwachts
 * doorkomt, tonen we een neutrale fallback in plaats van een ruwe driverfout.
 */
function toUserMessage(error: unknown): string {
  const message = (error as { message?: string } | null)?.message?.trim();
  if (!message) return "Boeken is niet gelukt. Probeer het opnieuw.";
  if (/^[A-Z]{2}\d{3}/.test(message) || message.includes("stack depth")) {
    return "Boeken is niet gelukt. Probeer het opnieuw.";
  }
  return message;
}

export function usePostBankAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (allocationId: string) => {
      const { data, error } = await postingApi.rpc("post_bank_allocation", {
        _allocation_id: allocationId,
      });
      if (error) throw new Error(toUserMessage(error));
      return data as string;
    },
    onSuccess: (_postingGroupId, allocationId) => {
      queryClient.invalidateQueries({ queryKey: ["bank-allocation-posting", allocationId] });
      queryClient.invalidateQueries({ queryKey: ["bank_transaction_allocations"] });
      queryClient.invalidateQueries({ queryKey: ["bank_transactions"] });
      queryClient.invalidateQueries({ queryKey: ["ledger-postings"] });
    },
  });
}
