import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

export type Vraagpost = Tables<"vraagposten">;
export type VraagpostInsert = TablesInsert<"vraagposten">;
export type VraagpostStatus = "open" | "in_behandeling" | "opgelost" | "genegeerd";

export interface UseVraagpostenOptions {
  organizationId?: string;
  clientId?: string;
  /** Beperk de query server-side tot deze klant-IDs. Leeg = geen resultaten. */
  clientIds?: string[];
  enabled?: boolean;
}

export function useVraagposten(options: UseVraagpostenOptions = {}) {
  const { organizationId, clientId, clientIds, enabled = true } = options;
  const { user } = useAuth();
  const clientIdsKey = clientIds ? [...clientIds].sort().join(",") : "";
  return useQuery({
    queryKey: ["vraagposten", organizationId ?? "all", clientId ?? "all", clientIdsKey],
    queryFn: async () => {
      let q = supabase.from("vraagposten").select("*").order("created_at", { ascending: false });
      if (organizationId) q = q.eq("organization_id", organizationId);
      if (clientId && clientId !== "all") q = q.eq("client_id", clientId);
      if (clientIds) {
        if (clientIds.length === 0) return [] as Vraagpost[];
        q = q.in("client_id", clientIds);
      }
      const { data, error } = await q;
      if (error) throw error;
      return data as Vraagpost[];
    },
    enabled: !!user && enabled,
  });
}

export function useCreateVraagpost() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: Omit<VraagpostInsert, "user_id">) => {
      if (!user) throw new Error("Niet ingelogd");
      const { data, error } = await supabase
        .from("vraagposten")
        .insert({ ...input, user_id: user.id })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vraagposten"] }),
  });
}

export function useUpdateVraagpostStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: VraagpostStatus }) => {
      const updates: Partial<Vraagpost> = { status };
      if (status === "opgelost" || status === "genegeerd") {
        (updates as any).resolved_at = new Date().toISOString();
      } else {
        (updates as any).resolved_at = null;
      }
      const { data, error } = await supabase
        .from("vraagposten")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vraagposten"] }),
  });
}

export const VRAAGPOST_CATEGORIE_LABELS: Record<string, string> = {
  leverancier_kvk_ontbreekt: "Leverancier KVK ontbreekt",
  leverancier_adres_ontbreekt: "Leverancier adres ontbreekt",
  btw_nummer_ontbreekt: "BTW-nummer ontbreekt",
  bedrag_klopt_niet: "Bedrag klopt niet",
  dubbele_factuur: "Dubbele factuur",
  bank_zonder_factuur: "Bank zonder factuur",
  kassabon_geen_ubl: "Kassabon zonder UBL",
  klant_bewijs_nodig: "Bewijs van klant nodig",
  overig: "Overig",
};

export const VRAAGPOST_CATEGORIE_OPTIONS = Object.entries(VRAAGPOST_CATEGORIE_LABELS).map(
  ([value, label]) => ({ value, label })
);

export function useDeleteVraagpost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("vraagposten").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vraagposten"] }),
  });
}

export const VRAAGPOST_SOURCE_LABELS: Record<string, string> = {
  purchase_invoice: "Inkoopfactuur",
  bank_transaction: "Banktransactie",
  sales_invoice: "Verkoopfactuur",
  handmatig: "Handmatig",
};
