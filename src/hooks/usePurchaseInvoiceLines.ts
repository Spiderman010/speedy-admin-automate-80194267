import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Tables } from "@/integrations/supabase/types";

export type PurchaseInvoiceLine = Tables<"purchase_invoice_lines">;

export function usePurchaseInvoiceLines(invoiceId?: string | null) {
  return useQuery({
    queryKey: ["purchase_invoice_lines", invoiceId],
    queryFn: async () => {
      if (!invoiceId) return [] as PurchaseInvoiceLine[];
      const { data, error } = await supabase
        .from("purchase_invoice_lines")
        .select("*")
        .eq("purchase_invoice_id", invoiceId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as PurchaseInvoiceLine[];
    },
    enabled: !!invoiceId,
  });
}

export interface InvoiceLineInput {
  omschrijving: string;
  amount_excl: number;
  btw_percentage: number | null;
  grootboekrekening_id: string | null;
}

export function useReplacePurchaseInvoiceLines() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ invoiceId, lines }: { invoiceId: string; lines: InvoiceLineInput[] }) => {
      if (!user) throw new Error("Not authenticated");
      const { error: delErr } = await supabase
        .from("purchase_invoice_lines")
        .delete()
        .eq("purchase_invoice_id", invoiceId);
      if (delErr) throw delErr;
      if (lines.length === 0) return;
      const rows = lines.map((l, idx) => ({
        purchase_invoice_id: invoiceId,
        user_id: user.id,
        omschrijving: l.omschrijving,
        amount_excl: l.amount_excl,
        btw_percentage: l.btw_percentage,
        grootboekrekening_id: l.grootboekrekening_id,
        sort_order: idx,
      }));
      const { error } = await supabase.from("purchase_invoice_lines").insert(rows);
      if (error) throw error;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["purchase_invoice_lines", vars.invoiceId] });
    },
  });
}
