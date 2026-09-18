import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useActiveOrganization } from "./useActiveOrganization";
import { LEDGER_POSTINGS_QUERY_KEY } from "./useLedgerPostings";
import { invalidateOpeningBalanceQueries, OPENING_BALANCE_POSTING_KEY } from "./useOpeningBalances";
import { classifyOpeningBalanceError, safeErrorMetadata } from "@/lib/opening-balance-utils";

/**
 * Fase 6C-b8 (PR 2) — de twee beweringen over een beginbalans.
 *
 * Boeken: public.post_opening_balance() maakt de volledige boeking server-side
 * (regels, bedragen, rekeningen, datum, boekjaar, rechten, eerdere
 * grootboekfeiten, serialisatie per administratie). Nihil:
 * public.declare_opening_balance_nil() legt vast dat er bewust geen beginbalans
 * is. Het enige dat hier de deur uit gaat is de id. De frontend schrijft nooit
 * rechtstreeks in ledger_postings, zet nooit zelf een nihil-kolom en berekent
 * geen boekingsregels.
 */

/** Of deze beginbalans al geboekt is (en zo ja, in welke boekingsgroep). */
export function useOpeningBalanceMarker(openingBalanceId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: [OPENING_BALANCE_POSTING_KEY, openingBalanceId ?? ""],
    enabled: !!user && !!openingBalanceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("opening_balance_postings")
        .select("*")
        .eq("opening_balance_id", openingBalanceId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Mag de ingelogde gebruiker boeken of op nihil verklaren? De rollenladder
 * blijft in de database: één aanroep van public.has_min_role(), geen
 * client-side rangorde. `undefined` = nog onbekend; de knoppen blijven dan
 * uit. Beide RPC's controleren het recht hoe dan ook opnieuw.
 */
export function useCanAssertOpeningBalance() {
  const { user } = useAuth();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  return useQuery({
    queryKey: ["opening-balance-can-assert", user?.id ?? "", activeOrganizationId ?? ""],
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

function toClassifiedError(error: unknown) {
  const classified = classifyOpeningBalanceError(error);
  // De soort blijft beschikbaar voor de aanroeper (23505/40001 → opnieuw
  // ophalen en de waarheid tonen; 40P01 → opnieuw proberen, nooit
  // automatisch), de tekst is toonbaar.
  return Object.assign(new Error(classified.message), { kind: classified.kind, code: classified.code });
}

export function usePostOpeningBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (openingBalanceId: string) => {
      const { data, error } = await supabase.rpc("post_opening_balance", {
        _opening_balance_id: openingBalanceId,
      });
      if (error) throw toClassifiedError(error);
      return data;
    },
    onError: (error) => console.warn("[beginbalans] boeken mislukt", safeErrorMetadata(error)),
    // Ook na een fout: een 23505/40001 betekent dat iemand anders de toestand
    // veranderde, en de cache mag daar niet achterlopen.
    onSettled: (_data, _error, openingBalanceId) =>
      Promise.all([
        invalidateOpeningBalanceQueries(queryClient, openingBalanceId),
        queryClient.invalidateQueries({ queryKey: [LEDGER_POSTINGS_QUERY_KEY] }),
      ]).then(() => undefined),
  });
}

export function useDeclareOpeningBalanceNil() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (openingBalanceId: string) => {
      const { error } = await supabase.rpc("declare_opening_balance_nil", {
        _opening_balance_id: openingBalanceId,
      });
      if (error) throw toClassifiedError(error);
      return openingBalanceId;
    },
    onError: (error) => console.warn("[beginbalans] nihil-verklaring mislukt", safeErrorMetadata(error)),
    onSettled: (_data, _error, openingBalanceId) => invalidateOpeningBalanceQueries(queryClient, openingBalanceId),
  });
}
