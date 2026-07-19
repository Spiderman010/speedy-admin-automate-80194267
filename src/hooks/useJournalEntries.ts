import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { JournalEntryInsertPayload, JournalEntryRecord } from "@/lib/journal-entry-utils";

export interface UseJournalEntriesOptions {
  organizationId?: string;
  clientId?: string;
  enabled?: boolean;
}

export function useJournalEntries(options: UseJournalEntriesOptions = {}) {
  const { organizationId, clientId, enabled = true } = options;
  const { user } = useAuth();
  return useQuery({
    queryKey: ["journal_entries", organizationId ?? "all", clientId ?? "all"],
    queryFn: async () => {
      let query = supabase.from("journal_entries").select("*").order("entry_date", { ascending: false });
      if (organizationId) query = query.eq("organization_id", organizationId);
      if (clientId && clientId !== "all") query = query.eq("client_id", clientId);
      const { data, error } = await query;
      if (error) throw error;
      return data as JournalEntryRecord[];
    },
    enabled: !!user && enabled,
  });
}

export function useAddJournalEntry() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (entry: JournalEntryInsertPayload) => {
      if (!user) throw new Error("Not authenticated");
      const { data, error } = await supabase
        .from("journal_entries")
        .insert({ ...entry, user_id: user.id } as any)
        .select()
        .single();
      if (error) throw error;
      return data as JournalEntryRecord;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["journal_entries"] }),
  });
}
