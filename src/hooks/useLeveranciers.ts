import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type Leverancier = Tables<"leveranciers">;
type LeverancierInsert = TablesInsert<"leveranciers">;

export interface UseLeveranciersOptions {
  organizationId?: string;
  clientId?: string;
  enabled?: boolean;
}

export function useLeveranciers(options: UseLeveranciersOptions = {}) {
  const { organizationId, clientId, enabled = true } = options;
  const { user } = useAuth();
  return useQuery({
    queryKey: ["leveranciers", organizationId ?? "all", clientId ?? "all"],
    queryFn: async () => {
      let query = supabase.from("leveranciers").select("*").order("naam");
      if (organizationId) query = query.eq("organization_id", organizationId);
      if (clientId && clientId !== "all") query = query.eq("client_id", clientId);
      const { data, error } = await query;
      if (error) throw error;
      return data as Leverancier[];
    },
    enabled: !!user && enabled,
  });
}

export function useAddLeverancier() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (leverancier: Omit<LeverancierInsert, "user_id">) => {
      if (!user) throw new Error("Not authenticated");
      const { data, error } = await supabase
        .from("leveranciers")
        .insert({ ...leverancier, user_id: user.id })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leveranciers"] }),
  });
}

export function useUpdateLeverancier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<Leverancier> & { id: string }) => {
      const { data, error } = await supabase
        .from("leveranciers")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leveranciers"] }),
  });
}

export function useDeleteLeverancier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("leveranciers").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leveranciers"] }),
  });
}

export function normalizeBtwNummer(value: string): string {
  return value.toUpperCase().replace(/[\s.\-]/g, "");
}
