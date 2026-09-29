import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { JournalEntryRecord } from "@/lib/journal-entry-utils";

/**
 * Legacy `journal_entries` (de oude snelle invoer) — ALLEEN LEZEN.
 *
 * `ledger_postings` is de enige financiële waarheid; nieuwe boekingen lopen via
 * het memoriaal en `post_manual_journal()`. Deze hook leest de historische
 * regels voor de alleen-lezen pagina, Bronmutaties, Rapportages en de
 * SnelStart-export. Er is bewust geen aanmaak-, wijzig- of verwijderhook meer:
 * de app schrijft niet naar deze tabel.
 */

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
