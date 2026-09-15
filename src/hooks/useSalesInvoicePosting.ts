import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Verkoopfactuur boeken (fase 6C-b4).
 *
 * De volledige boeking wordt server-side door public.post_sales_invoice()
 * gemaakt. De frontend berekent geen bedragen, kiest geen rekeningen en
 * schrijft nooit rechtstreeks in ledger_postings: het enige dat hier de deur
 * uit gaat is de factuur-id.
 *
 * TIJDELIJK: sales_invoice_postings en post_sales_invoice bestaan nog niet in
 * src/integrations/supabase/types.ts, omdat de migratie pas na review op
 * productie wordt toegepast. Dat bestand wordt nooit met de hand aangepast,
 * dus de twee aanroepen lopen via een smalle cast. Verwijder die zodra de
 * types opnieuw gegenereerd zijn — net als bij PR #146/#148.
 */
type UntypedPostingApi = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{
          data: { sales_invoice_id: string; posting_group_id: string; created_at: string } | null;
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

/** Of deze verkoopfactuur al geboekt is (en zo ja, in welke boekingsgroep). */
export function useSalesInvoicePosting(invoiceId: string | undefined) {
  return useQuery({
    queryKey: ["sales-invoice-posting", invoiceId],
    enabled: !!invoiceId,
    queryFn: async () => {
      const { data, error } = await postingApi
        .from("sales_invoice_postings")
        .select("sales_invoice_id, posting_group_id, created_at")
        .eq("sales_invoice_id", invoiceId!)
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

export function usePostSalesInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { data, error } = await postingApi.rpc("post_sales_invoice", {
        _invoice_id: invoiceId,
      });
      if (error) throw new Error(toUserMessage(error));
      return data as string;
    },
    onSuccess: (_postingGroupId, invoiceId) => {
      queryClient.invalidateQueries({ queryKey: ["sales-invoice-posting", invoiceId] });
      queryClient.invalidateQueries({ queryKey: ["ledger-postings"] });
    },
  });
}
