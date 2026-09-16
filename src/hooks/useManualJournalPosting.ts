import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useActiveOrganization } from "./useActiveOrganization";
import { classifyManualJournalError } from "@/lib/manual-journal-utils";

/**
 * Fase 6C-b6 (PR 2) — memoriaalboeking boeken.
 *
 * De volledige boeking wordt server-side gemaakt door public.post_manual_journal():
 * regels, bedragen, rekeningen, datum, boekjaar en rechten komen allemaal uit de
 * database. Het enige dat hier de deur uit gaat is de id van de boeking. De
 * frontend schrijft nooit rechtstreeks in ledger_postings en berekent geen
 * boekingsregels.
 */

/** Of deze memoriaalboeking al geboekt is (en zo ja, in welke boekingsgroep). */
export function useManualJournalPosting(journalId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["manual-journal-posting", journalId ?? ""],
    enabled: !!user && !!journalId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("manual_journal_postings")
        .select("manual_journal_id, posting_group_id, posting_date, line_count, total_amount, created_at")
        .eq("manual_journal_id", journalId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Mag de ingelogde gebruiker boeken? De rollenladder blijft in de database:
 * dit is één aanroep van public.has_min_role(), geen client-side herimplementatie
 * van de rangorde. `undefined` = nog onbekend; de knop blijft dan uit.
 * post_manual_journal() controleert het recht hoe dan ook opnieuw.
 */
export function useCanPostManualJournal() {
  const { user } = useAuth();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  return useQuery({
    queryKey: ["manual-journal-can-post", user?.id ?? "", activeOrganizationId ?? ""],
    enabled: !!user && isReady && !!activeOrganizationId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("has_min_role", {
        _user_id: user!.id,
        _organization_id: activeOrganizationId!,
        _min: "accountant",
      });
      if (error) throw error;
      return data === true;
    },
  });
}

export function usePostManualJournal() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (journalId: string) => {
      const { data, error } = await supabase.rpc("post_manual_journal", {
        _journal_id: journalId,
      });
      if (error) {
        const classified = classifyManualJournalError(error);
        // De soort blijft beschikbaar voor de aanroeper (bv. 23505 → opnieuw
        // ophalen en naar de geboekte weergave), de tekst is toonbaar.
        throw Object.assign(new Error(classified.message), { kind: classified.kind });
      }
      return data;
    },
    onSuccess: (_postingGroupId, journalId) => {
      queryClient.invalidateQueries({ queryKey: ["manual-journal-posting", journalId] });
      queryClient.invalidateQueries({ queryKey: ["manual_journal", journalId] });
      queryClient.invalidateQueries({ queryKey: ["manual_journals"] });
      queryClient.invalidateQueries({ queryKey: ["ledger-postings"] });
    },
  });
}
