import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type SalesInvoice = Tables<"sales_invoices">;
type SalesInvoiceInsert = TablesInsert<"sales_invoices">;

export function useSalesInvoices(clientId?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["sales_invoices", clientId],
    queryFn: async () => {
      let query = supabase.from("sales_invoices").select("*").order("invoice_date", { ascending: false });
      if (clientId) query = query.eq("client_id", clientId);
      const { data, error } = await query;
      if (error) throw error;
      return data as SalesInvoice[];
    },
    enabled: !!user,
  });
}

export function useAddSalesInvoice() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (inv: Omit<SalesInvoiceInsert, "user_id">) => {
      if (!user) throw new Error("Not authenticated");
      const remainingAmount = inv.remaining_amount ?? inv.amount_incl ?? inv.amount_excl ?? null;
      const { data, error } = await supabase
        .from("sales_invoices")
        .insert({ ...inv, user_id: user.id, remaining_amount: remainingAmount })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sales_invoices"] }),
  });
}

export function useUpdateSalesInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<SalesInvoice> & { id: string }) => {
      const { data, error } = await supabase
        .from("sales_invoices")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sales_invoices"] }),
  });
}

export function useDeleteSalesInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invoice: { id: string; pdf_path?: string | null }) => {
      await supabase
        .from("vraagposten")
        .delete()
        .eq("source_type", "sales_invoice")
        .eq("source_id", invoice.id);

      if (invoice.pdf_path) {
        try {
          await supabase.storage.from("invoices").remove([invoice.pdf_path]);
        } catch {
          // ignore missing file
        }
      }

      const { error } = await supabase.from("sales_invoices").delete().eq("id", invoice.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales_invoices"] });
      qc.invalidateQueries({ queryKey: ["vraagposten"] });
    },
  });
}
