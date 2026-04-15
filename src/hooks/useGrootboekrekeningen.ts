import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export interface Grootboekrekening {
  id: string;
  user_id: string;
  client_id: string | null;
  nummer: number;
  omschrijving: string;
  categorie: string;
  actief: boolean;
  created_at: string;
  updated_at: string;
}

const DEFAULT_ACCOUNTS = [
  { nummer: 651, omschrijving: "Privé stortingen", categorie: "privé" },
  { nummer: 652, omschrijving: "Privé opnamen", categorie: "privé" },
  { nummer: 653, omschrijving: "Inkomstenbelasting", categorie: "privé" },
  { nummer: 1000, omschrijving: "Kas", categorie: "activa" },
  { nummer: 1100, omschrijving: "Rekening-courant bank", categorie: "activa" },
  { nummer: 1799, omschrijving: "Onbekende betalingen", categorie: "activa" },
  { nummer: 1300, omschrijving: "Debiteuren", categorie: "activa" },
  { nummer: 1600, omschrijving: "Crediteuren", categorie: "passiva" },
  { nummer: 1605, omschrijving: "Vraagposten inkopen", categorie: "passiva" },
  { nummer: 4210, omschrijving: "Gas water en elektra", categorie: "kosten" },
  { nummer: 4400, omschrijving: "Reclame en advertentiekosten", categorie: "kosten" },
  { nummer: 4406, omschrijving: "Reis en verblijfkosten", categorie: "kosten" },
  { nummer: 4500, omschrijving: "Brandstofkosten autos", categorie: "kosten" },
  { nummer: 4501, omschrijving: "Reparatie en onderhoud autos", categorie: "kosten" },
  { nummer: 4502, omschrijving: "Assurantiepremie autos", categorie: "kosten" },
  { nummer: 4503, omschrijving: "Motorrijtuigenbelasting autos", categorie: "kosten" },
  { nummer: 4509, omschrijving: "Kilometervergoeding", categorie: "kosten" },
  { nummer: 4510, omschrijving: "Boetes en bekeuringen", categorie: "kosten" },
  { nummer: 4518, omschrijving: "Parkeerkosten autos", categorie: "kosten" },
  { nummer: 4600, omschrijving: "Kantoorbenodigdheden", categorie: "kosten" },
  { nummer: 4601, omschrijving: "Porti", categorie: "kosten" },
  { nummer: 4602, omschrijving: "Telefoonkosten", categorie: "kosten" },
  { nummer: 4606, omschrijving: "Contributies en abonnementen", categorie: "kosten" },
  { nummer: 4610, omschrijving: "Kosten automatisering", categorie: "kosten" },
  { nummer: 4650, omschrijving: "Bedrijfsaansprakelijkheidsverzekering", categorie: "kosten" },
  { nummer: 4651, omschrijving: "Overige assurantiepremies", categorie: "kosten" },
  { nummer: 4700, omschrijving: "Accountants en advieskosten", categorie: "kosten" },
  { nummer: 4752, omschrijving: "Kasverschillen", categorie: "kosten" },
  { nummer: 4753, omschrijving: "Bankkosten", categorie: "kosten" },
  { nummer: 4756, omschrijving: "Betalingsverschillen", categorie: "kosten" },
  { nummer: 4798, omschrijving: "Algemene kosten", categorie: "kosten" },
  { nummer: 8200, omschrijving: "Omzet hoog diensten", categorie: "omzet" },
  { nummer: 8210, omschrijving: "Omzet laag diensten", categorie: "omzet" },
  { nummer: 8240, omschrijving: "Omzet nultarief diensten", categorie: "omzet" },
  { nummer: 8250, omschrijving: "Omzet verlegd diensten", categorie: "omzet" },
  { nummer: 8299, omschrijving: "Vrijgestelde omzet diensten", categorie: "omzet" },
];

export function useGrootboekrekeningen() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["grootboekrekeningen"],
    queryFn: async () => {
      const { data, error } = await supabase.from("grootboekrekeningen").select("*").order("nummer");
      if (error) throw error;
      return data as Grootboekrekening[];
    },
    enabled: !!user,
  });
}

export function useActiveGrootboekrekeningen() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["grootboekrekeningen", "actief"],
    queryFn: async () => {
      const { data, error } = await supabase.from("grootboekrekeningen").select("*").eq("actief", true).order("nummer");
      if (error) throw error;
      return data as Grootboekrekening[];
    },
    enabled: !!user,
  });
}

export function useSeedGrootboekrekeningen() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Niet ingelogd");
      // Check if already seeded globally
      const { count } = await supabase
        .from("grootboekrekeningen")
        .select("*", { count: "exact", head: true });
      if (count && count > 0) return;

      const rows = DEFAULT_ACCOUNTS.map((a) => ({
        user_id: user.id,
        client_id: null,
        ...a,
      }));
      const { error } = await supabase.from("grootboekrekeningen").insert(rows);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grootboekrekeningen"] }),
  });
}

export function useAddGrootboekrekening() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { nummer: number; omschrijving: string; categorie: string; actief: boolean }) => {
      if (!user) throw new Error("Niet ingelogd");
      const { error } = await supabase.from("grootboekrekeningen").insert({ ...data, user_id: user.id, client_id: null });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grootboekrekeningen"] }),
  });
}

export function useUpdateGrootboekrekening() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }: { id: string } & Partial<Grootboekrekening>) => {
      const { error } = await supabase.from("grootboekrekeningen").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grootboekrekeningen"] }),
  });
}

export function useDeleteGrootboekrekening() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("grootboekrekeningen").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grootboekrekeningen"] }),
  });
}
