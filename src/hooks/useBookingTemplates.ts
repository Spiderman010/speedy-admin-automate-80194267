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
  grootboekrekening_id: string | null;
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
  organization_id?: string | null;
}

export interface UseBookingTemplatesOptions {
  organizationId?: string;
  enabled?: boolean;
}

function stripLegacyWriteFields(template: Partial<BookingTemplate>) {
  const {
    id: _id,
    user_id: _userId,
    created_at: _createdAt,
    ledger_account_id: _legacyLedgerAccountId,
    ...rest
  } = template;

  return rest;
}

export function buildBookingTemplateInsertPayload(template: Partial<BookingTemplate>) {
  return {
    ...stripLegacyWriteFields(template),
    name: template.name ?? template.zoekterm ?? "Regel",
  };
}

export function buildBookingTemplateUpdatePayload(template: Partial<BookingTemplate>) {
  return stripLegacyWriteFields(template);
}

export function useBookingTemplates(options: UseBookingTemplatesOptions = {}) {
  const { organizationId, enabled = true } = options;
  const { user } = useAuth();
  return useQuery({
    queryKey: ["booking_templates", organizationId ?? "all"],
    queryFn: async () => {
      let query = supabase
        .from("booking_templates")
        .select("*")
        .order("prioriteit", { ascending: false });
      if (organizationId) query = query.eq("organization_id", organizationId);
      const { data, error } = await query;
      if (error) throw error;
      return data as BookingTemplate[];
    },
    enabled: !!user && enabled,
  });
}

export function useAddBookingTemplate() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (template: Partial<BookingTemplate>) => {
      if (!user) throw new Error("Niet ingelogd");
      const payload = buildBookingTemplateInsertPayload(template);
      const { error } = await supabase
        .from("booking_templates")
        .insert({ ...payload, user_id: user.id } as any);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["booking_templates"] }),
  });
}

export function useUpdateBookingTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<BookingTemplate> & { id: string }) => {
      const payload = buildBookingTemplateUpdatePayload(updates);
      const { error } = await supabase
        .from("booking_templates")
        .update(payload as any)
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
