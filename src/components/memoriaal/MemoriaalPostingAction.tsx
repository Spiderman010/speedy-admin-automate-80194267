import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  useCanPostManualJournal,
  useManualJournalPosting,
  usePostManualJournal,
} from "@/hooks/useManualJournalPosting";
import {
  firstBlockingReason,
  POSTED_NOTICE,
  type ManualJournalHeaderForm,
  type ManualJournalLineRow,
} from "@/lib/manual-journal-utils";

/**
 * Fase 6C-b6 (PR 2) — "Boeken in grootboek" voor een memoriaalboeking.
 *
 * De component stuurt uitsluitend de id van de boeking naar
 * public.post_manual_journal(). Alle hints zijn UX: de RPC controleert alles
 * opnieuw (rechten, balans, rekeningbereik, niet-actieve rekeningen, afgesloten
 * boekjaar) en is de enige autoriteit.
 *
 * Er wordt nooit gemeld dat er geboekt is zolang de claimtabel dat niet
 * bevestigt: na de RPC wordt de marker opnieuw opgehaald en pas dán volgt de
 * bevestiging.
 */

export interface MemoriaalPostingActionProps {
  journalId: string | null;
  header: ManualJournalHeaderForm;
  lines: ManualJournalLineRow[];
  /** Niet-opgeslagen wijzigingen: boeken zou een verouderde toestand boeken. */
  isDirty: boolean;
  /** Wordt aangeroepen zodra de boeking bevestigd geboekt is. */
  onPosted?: () => void;
}

export function MemoriaalPostingAction({
  journalId,
  header,
  lines,
  isDirty,
  onPosted,
}: MemoriaalPostingActionProps) {
  const { toast } = useToast();
  const {
    data: marker,
    isPending: markerPending,
    isError: markerError,
    refetch: refetchMarker,
  } = useManualJournalPosting(journalId ?? undefined);
  const { data: canPost } = useCanPostManualJournal();
  const postJournal = usePostManualJournal();

  if (marker) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="memoriaal-posting-done">
        {POSTED_NOTICE}
      </p>
    );
  }

  // "Weet ik niet" is niet hetzelfde als "niet geboekt": zolang de claimtabel
  // nog niet bevraagd is of niet bevraagd kán worden (deploy-venster), blijft
  // de knop uit met een neutrale uitleg in plaats van een rauwe schemafout.
  const hint = firstBlockingReason({
    journalId,
    markerUnavailable: !!markerError,
    markerPending: !!journalId && markerPending,
    canPost,
    isDirty,
    header,
    lines,
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        data-testid="memoriaal-posting-button"
        disabled={!!hint || postJournal.isPending}
        onClick={async () => {
          if (!journalId) return;
          try {
            await postJournal.mutateAsync(journalId);
            const confirmed = await refetchMarker();
            if (confirmed.data) {
              toast({ title: "Memoriaalboeking geboekt" });
              onPosted?.();
            } else {
              // De RPC gaf geen fout, maar de claimrij is (nog) niet zichtbaar.
              // Dan melden we geen succes.
              toast({
                title: "Boeking niet bevestigd",
                description: "Ververs de pagina en controleer de status.",
                variant: "destructive",
              });
            }
          } catch (e) {
            const kind = (e as { kind?: string })?.kind;
            const description = e instanceof Error ? e.message : undefined;
            if (kind === "duplicate") {
              // Iemand anders was eerder. Geen fout voor de gebruiker: opnieuw
              // ophalen en de geboekte weergave tonen.
              const confirmed = await refetchMarker();
              toast({ title: "Deze memoriaalboeking is al geboekt." });
              if (confirmed.data) onPosted?.();
              return;
            }
            toast({ title: "Boeken niet gelukt", description, variant: "destructive" });
          }
        }}
      >
        {postJournal.isPending ? "Bezig met boeken…" : "Boeken in grootboek"}
      </Button>
      {hint && (
        <p className="text-xs text-muted-foreground" data-testid="memoriaal-posting-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
