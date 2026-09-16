import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Json, Tables, TablesInsert } from "@/integrations/supabase/types";
import type {
  ManualJournalHeaderForm,
  ManualJournalLinePayload,
} from "@/lib/manual-journal-utils";
import { buildHeaderPayload } from "@/lib/manual-journal-utils";

/**
 * Fase 6C-b6 (PR 2) — concept-kant van memoriaalboekingen.
 *
 * De kop is een gewone enkele PostgREST-rij (insert/update/delete). De REGELS
 * gaan uitsluitend via public.save_manual_journal_lines(): die vervangt de hele
 * set in één transactie, met dezelfde kopgrendel als de boeker. Een
 * client-side "UPDATE kop → DELETE regels → INSERT regels" zou half kunnen
 * slagen en een boeking op een mengsel van oude en nieuwe regels mogelijk maken.
 *
 * organization_id gaat nooit mee vanuit de client: public.set_organization_id()
 * leidt hem af uit client_id.
 */

export type ManualJournal = Tables<"manual_journals">;
export type ManualJournalLine = Tables<"manual_journal_lines">;
export type ManualJournalPosting = Tables<"manual_journal_postings">;

export interface UseManualJournalsOptions {
  organizationId?: string;
  clientId?: string;
  enabled?: boolean;
}

/** Eén rij in het memoriaal-overzicht, met afgeleide status. */
export interface ManualJournalListItem {
  journal: ManualJournal;
  marker: ManualJournalPosting | null;
  lines: ManualJournalLine[];
  /** Afgeleid uit het bestaan van een claimrij — er is geen statuskolom. */
  posted: boolean;
}

export function useManualJournals(options: UseManualJournalsOptions = {}) {
  const { organizationId, clientId, enabled = true } = options;
  const { user } = useAuth();

  return useQuery({
    queryKey: ["manual_journals", organizationId ?? "all", clientId ?? "all"],
    enabled: !!user && enabled,
    queryFn: async (): Promise<ManualJournalListItem[]> => {
      let query = supabase
        .from("manual_journals")
        .select("*")
        .order("posting_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (organizationId) query = query.eq("organization_id", organizationId);
      if (clientId && clientId !== "all") query = query.eq("client_id", clientId);

      const { data: journals, error } = await query;
      if (error) throw error;
      const ids = (journals ?? []).map((j) => j.id);
      if (ids.length === 0) return [];

      // Twee gebundelde vervolgqueries in plaats van N+1 per boeking.
      const [markersResult, linesResult] = await Promise.all([
        supabase.from("manual_journal_postings").select("*").in("manual_journal_id", ids),
        supabase
          .from("manual_journal_lines")
          .select("*")
          .in("manual_journal_id", ids)
          .order("sort_order", { ascending: true }),
      ]);
      if (markersResult.error) throw markersResult.error;
      if (linesResult.error) throw linesResult.error;

      const markerByJournal = new Map<string, ManualJournalPosting>();
      for (const m of markersResult.data ?? []) markerByJournal.set(m.manual_journal_id, m);
      const linesByJournal = new Map<string, ManualJournalLine[]>();
      for (const l of linesResult.data ?? []) {
        const bucket = linesByJournal.get(l.manual_journal_id);
        if (bucket) bucket.push(l);
        else linesByJournal.set(l.manual_journal_id, [l]);
      }

      return (journals ?? []).map((journal) => {
        const marker = markerByJournal.get(journal.id) ?? null;
        return {
          journal,
          marker,
          lines: linesByJournal.get(journal.id) ?? [],
          posted: !!marker,
        };
      });
    },
  });
}

/** Eén kop, opnieuw uit de database — nooit uit de lijstcache afgeleid. */
export function useManualJournal(journalId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["manual_journal", journalId ?? ""],
    enabled: !!user && !!journalId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("manual_journals")
        .select("*")
        .eq("id", journalId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useManualJournalLines(journalId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["manual_journal_lines", journalId ?? ""],
    enabled: !!user && !!journalId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("manual_journal_lines")
        .select("*")
        .eq("manual_journal_id", journalId!)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreateManualJournal() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (form: ManualJournalHeaderForm) => {
      if (!user) throw new Error("Niet ingelogd");
      const { data, error } = await supabase
        .from("manual_journals")
        // organization_id staat in de gegenereerde types als verplicht, maar
        // wordt server-side door public.set_organization_id() afgeleid uit
        // client_id. De client hoort hem niet mee te sturen; vandaar één
        // gerichte assertie in plaats van een kolom invullen die hier niet
        // bekend is (en die het INSERT-beleid toch opnieuw toetst).
        .insert({ ...buildHeaderPayload(form), user_id: user.id } as TablesInsert<"manual_journals">)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manual_journals"] });
    },
  });
}

export function useUpdateManualJournal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, form }: { id: string; form: ManualJournalHeaderForm }) => {
      const { data, error } = await supabase
        .from("manual_journals")
        .update(buildHeaderPayload(form))
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["manual_journal", variables.id] });
      qc.invalidateQueries({ queryKey: ["manual_journals"] });
    },
  });
}

/**
 * De enige schrijfweg voor regels. Precies één RPC-aanroep; de database doet
 * DELETE + INSERT atomair achter de kopgrendel.
 */
export function useSaveManualJournalLines() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      journalId,
      lines,
    }: {
      journalId: string;
      lines: ManualJournalLinePayload[];
    }) => {
      const { error } = await supabase.rpc("save_manual_journal_lines", {
        _journal_id: journalId,
        _lines: lines as unknown as Json,
      });
      if (error) throw error;
      return journalId;
    },
    onSuccess: (journalId) => {
      qc.invalidateQueries({ queryKey: ["manual_journal_lines", journalId] });
      qc.invalidateQueries({ queryKey: ["manual_journals"] });
    },
  });
}

export function useDeleteManualJournal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (journalId: string) => {
      const { error } = await supabase.from("manual_journals").delete().eq("id", journalId);
      if (error) throw error;
      return journalId;
    },
    onSuccess: (journalId) => {
      qc.invalidateQueries({ queryKey: ["manual_journals"] });
      qc.invalidateQueries({ queryKey: ["manual_journal", journalId] });
      qc.invalidateQueries({ queryKey: ["manual_journal_lines", journalId] });
    },
  });
}
