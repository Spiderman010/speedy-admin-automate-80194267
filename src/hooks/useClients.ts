import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { useAuth } from "./useAuth";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type Client = Tables<"clients">;
type ClientInsert = TablesInsert<"clients">;

export function useClients(organizationId?: string, enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["clients", user?.id ?? "", organizationId ?? "all"],
    // Volledig voorbij de rijgrens van PostgREST, in de vorige volgorde (naam)
    // met id als unieke tiebreaker.
    queryFn: () =>
      fetchAllRows<Client>(async (from, to) => {
        let query = supabase.from("clients").select("*");
        if (organizationId) query = query.eq("organization_id", organizationId);
        const { data, error } = await query
          .order("name", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to);
        return { data: data as Client[] | null, error };
      }),
    enabled: !!user && enabled,
  });
}

export function useAddClient() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (client: Omit<ClientInsert, "user_id">) => {
      if (!user) throw new Error("Not authenticated");
      const { data, error } = await supabase
        .from("clients")
        .insert({ ...client, user_id: user.id })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useUpdateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<Client> & { id: string }) => {
      const { data, error } = await supabase
        .from("clients")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["clients"] }),
  });
}

export function useDeleteClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("clients").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["clients"] }),
  });
}
