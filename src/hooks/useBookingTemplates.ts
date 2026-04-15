import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export interface BookingTemplate {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  default_amount: number | null;
  btw_percentage: number | null;
  ledger_account_text: string | null;
  ledger_account_id: string | null;
  client_id: string | null;
  zoekterm: string | null;
  zoek_in: string | null;
  actie: string | null;
  geldt_voor: string | null;
  client_id_filter: string | null;
  prioriteit: number | null;
  actief: boolean;
  created_at: string;
}

export function useBookingTemplates() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["booking_templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("booking_templates")
        .select("*")
        .order("prioriteit", { ascending: false });
      if (error) throw error;
      return data as BookingTemplate[];
    },
    enabled: !!user,
  });
}

export function useAddBookingTemplate() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (template: Partial<BookingTemplate>) => {
      if (!user) throw new Error("Niet ingelogd");
      const { error } = await supabase
        .from("booking_templates")
        .insert({ ...template, user_id: user.id, name: template.zoekterm || "Regel" } as any);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["booking_templates"] }),
  });
}

export function useUpdateBookingTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<BookingTemplate> & { id: string }) => {
      const { error } = await supabase
        .from("booking_templates")
        .update(updates as any)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["booking_templates"] }),
  });
}

export function useDeleteBookingTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("booking_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["booking_templates"] }),
  });
}
