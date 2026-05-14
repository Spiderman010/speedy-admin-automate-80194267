import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type PurchaseInvoice = Tables<"purchase_invoices">;
type PurchaseInvoiceInsert = TablesInsert<"purchase_invoices">;

export function usePurchaseInvoices(clientId?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["purchase_invoices", clientId],
    queryFn: async () => {
      let query = supabase.from("purchase_invoices").select("*").order("invoice_date", { ascending: false });
      if (clientId) query = query.eq("client_id", clientId);
      const { data, error } = await query;
      if (error) throw error;
      return data as PurchaseInvoice[];
    },
    enabled: !!user,
  });
}

export function useAddPurchaseInvoice() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (invoice: Omit<PurchaseInvoiceInsert, "user_id">) => {
      if (!user) throw new Error("Not authenticated");
      const remainingAmount = invoice.remaining_amount ?? invoice.amount_incl ?? invoice.amount_excl ?? null;
      const { data, error } = await supabase
        .from("purchase_invoices")
        .insert({ ...invoice, user_id: user.id, remaining_amount: remainingAmount })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase_invoices"] }),
  });
}

export function useUpdatePurchaseInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<PurchaseInvoice> & { id: string }) => {
      const { data, error } = await supabase
        .from("purchase_invoices")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase_invoices"] }),
  });
}

export function useDeletePurchaseInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invoice: { id: string; file_path?: string | null }) => {
      const { error: linesErr } = await supabase
        .from("purchase_invoice_lines")
        .delete()
        .eq("purchase_invoice_id", invoice.id);
      if (linesErr) throw linesErr;

      await supabase
        .from("vraagposten")
        .delete()
        .eq("source_type", "purchase_invoice")
        .eq("source_id", invoice.id);

      if (invoice.file_path) {
        try {
          await supabase.storage.from("invoices").remove([invoice.file_path]);
        } catch {
          // ignore missing file
        }
      }

      const { error } = await supabase.from("purchase_invoices").delete().eq("id", invoice.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase_invoices"] });
      qc.invalidateQueries({ queryKey: ["purchase_invoice_lines"] });
      qc.invalidateQueries({ queryKey: ["vraagposten"] });
    },
  });
}
