import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useActiveOrganization } from "./useActiveOrganization";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type SalesInvoice = Tables<"sales_invoices">;
type SalesInvoiceInsert = TablesInsert<"sales_invoices">;

export function useSalesInvoices(clientId?: string) {
  const { user } = useAuth();
  const { activeOrganizationId } = useActiveOrganization();
  return useQuery({
    queryKey: ["sales_invoices", activeOrganizationId ?? "none", clientId ?? "all"],
    queryFn: async () => {
      let query = supabase
        .from("sales_invoices")
        .select("*")
        .eq("organization_id", activeOrganizationId!)
        .order("invoice_date", { ascending: false });
      if (clientId) query = query.eq("client_id", clientId);
      const { data, error } = await query;
      if (error) throw error;
      return data as SalesInvoice[];
    },
    enabled: !!user && !!activeOrganizationId,
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
    mutationFn: async (invoiceId: string) => {
      const { error } = await supabase.from("sales_invoices").delete().eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sales_invoices"] }),
  });
}
