import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useLedgerPostings } from "@/hooks/useLedgerPostings";
import { fetchReversalMarkers } from "@/hooks/useAccountingDiagnostics";
import {
  evaluateReversalIntegrity,
  type ReversalIntegrityReport,
  type ReversalMarkerLike,
} from "@/lib/reversal-integrity";

/**
 * De tegenboekingslineage van één administratie — UITSLUITEND LEZEN.
 *
 * Er wordt hier niets nieuws opgehaald en niets nieuws beoordeeld: de markers
 * komen uit de bestaande `fetchReversalMarkers()` en de grootboekregels uit de
 * bestaande `useLedgerPostings`; het oordeel komt onveranderd uit
 * `evaluateReversalIntegrity()`.
 *
 * GEEN PERIODEFILTER, met opzet. `evaluateReversalIntegrity()` eist "alle
 * grootboekregels van de administratie; nooit een periodeselectie": een
 * tegenboeking mag in een ander jaar landen dan haar origineel, en met een
 * periodefilter zou elk paar dat de grens kruist er als een kapotte lineage
 * uitzien. Daarom `useLedgerPostings({ clientId })` zónder periode — dezelfde
 * hook, een eigen cachesleutel.
 *
 * DEPLOY-VENSTER. `fetchReversalMarkers()` geeft `null` terug wanneer
 * PostgREST de markertabel niet kent. Dat is nadrukkelijk niet "er zijn geen
 * tegenboekingen": het is "we konden niet kijken". Deze hook geeft dat door
 * als `isUnavailable`, zodat de controle het als technische storing meldt en
 * niet als schone uitslag.
 */

export const REVERSAL_MARKERS_QUERY_KEY = "reversal-markers" as const;

export interface UseReversalIntegrityResult {
  data: ReversalIntegrityReport | undefined;
  isPending: boolean;
  /** De bron kon niet worden gelezen: een fout, of de tabel bestaat nog niet. */
  isUnavailable: boolean;
}

export function useReversalIntegrity(
  clientId: string | undefined,
  enabled = true,
): UseReversalIntegrityResult {
  const { user } = useAuth();
  const wanted = enabled && !!user && !!clientId;

  const markersQuery = useQuery<ReversalMarkerLike[] | null>({
    queryKey: [REVERSAL_MARKERS_QUERY_KEY, clientId ?? ""],
    enabled: wanted,
    queryFn: () => fetchReversalMarkers(clientId!),
  });

  // Zonder periode: alles van deze administratie, zoals de evaluator eist.
  const postingsQuery = useLedgerPostings({ clientId, enabled: wanted });

  const isUnavailable =
    markersQuery.isError ||
    postingsQuery.isError ||
    // `null` = de markertabel is niet leesbaar; geen uitspraak mogelijk.
    (markersQuery.isSuccess && markersQuery.data === null);

  const data = useMemo<ReversalIntegrityReport | undefined>(() => {
    if (isUnavailable) return undefined;
    if (!markersQuery.data || !postingsQuery.data) return undefined;
    return evaluateReversalIntegrity({
      markers: markersQuery.data,
      postings: postingsQuery.data,
    });
  }, [isUnavailable, markersQuery.data, postingsQuery.data]);

  return {
    data,
    isPending: markersQuery.isPending || postingsQuery.isPending,
    isUnavailable,
  };
}
