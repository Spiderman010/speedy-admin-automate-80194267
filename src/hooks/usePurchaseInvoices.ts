import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type PurchaseInvoice = Tables<"purchase_invoices">;
type PurchaseInvoiceInsert = TablesInsert<"purchase_invoices">;

export interface UsePurchaseInvoicesOptions {
  organizationId?: string;
  clientId?: string;
  enabled?: boolean;
}

export function usePurchaseInvoices(options: UsePurchaseInvoicesOptions = {}) {
  const { organizationId, clientId, enabled = true } = options;
  const { user } = useAuth();
  return useQuery({
    queryKey: ["purchase_invoices", organizationId ?? "all", clientId ?? "all"],
    queryFn: async () => {
      let query = supabase.from("purchase_invoices").select("*").order("invoice_date", { ascending: false });
      if (organizationId) query = query.eq("organization_id", organizationId);
      if (clientId) query = query.eq("client_id", clientId);
      const { data, error } = await query;
      if (error) throw error;
      return data as PurchaseInvoice[];
    },
    enabled: !!user && enabled,
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
    mutationFn: async (invoiceId: string) => {
      const { error: linesErr } = await supabase
        .from("purchase_invoice_lines")
        .delete()
        .eq("purchase_invoice_id", invoiceId);
      if (linesErr) throw linesErr;

      const { error } = await supabase.from("purchase_invoices").delete().eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase_invoices"] });
      qc.invalidateQueries({ queryKey: ["purchase_invoice_lines"] });
    },
  });
}
