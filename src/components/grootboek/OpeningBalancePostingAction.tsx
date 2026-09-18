import { useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  useCanAssertOpeningBalance,
  useOpeningBalanceMarker,
  usePostOpeningBalance,
} from "@/hooks/useOpeningBalancePosting";
import {
  firstPostingBlockingReason,
  isCompetingStateError,
  POST_CONFIRM_POINTS,
  POST_CONFIRM_TITLE,
  POSTED_FINAL_NOTICE,
  type OpeningBalanceAccountRef,
  type OpeningBalanceErrorKind,
  type OpeningBalanceHeaderForm,
  type OpeningBalanceLineRow,
} from "@/lib/opening-balance-utils";

/**
 * Fase 6C-b8 (PR 2) — "Boeken in grootboek" voor een beginbalans.
 *
 * De component stuurt uitsluitend de id naar public.post_opening_balance().
 * Alle hints zijn UX: de RPC controleert alles opnieuw (rechten, balans,
 * rekeningbereik, niet-actieve rekeningen, afgesloten boekjaar, eerdere
 * grootboekfeiten) en is de enige autoriteit. De knop wordt alleen aan een
 * accountant aangeboden; een onbekende rol telt als "niet toegestaan".
 *
 * Er wordt nooit gemeld dat er geboekt is zolang de claimtabel dat niet
 * bevestigt: na de RPC wordt de marker opnieuw opgehaald en pas dán volgt de
 * bevestiging. Een competerende toestand (al geboekt, nihil verklaard,
 * tussentijds gewijzigd) leidt tot opnieuw ophalen, nooit tot een tweede
 * poging uit zichzelf.
 */

export interface OpeningBalancePostingActionProps {
  openingBalanceId: string | null;
  clientId: string;
  header: OpeningBalanceHeaderForm;
  lines: OpeningBalanceLineRow[];
  accountsById: ReadonlyMap<string, OpeningBalanceAccountRef>;
  /** Niet-opgeslagen wijzigingen: boeken zou een verouderde toestand boeken. */
  isDirty: boolean;
  isSaving: boolean;
  /** Overzicht van de administratie nog aan het laden of niet bevraagbaar. */
  stateUncertain: boolean;
  stateUnavailable: boolean;
  /** Wordt aangeroepen zodra de boeking bevestigd geboekt is. */
  onPosted?: () => void;
  /** Iemand anders was eerder (geboekt, nihil, gewijzigd): de pagina laadt de waarheid opnieuw. */
  onCompetingState?: () => void;
}

export function OpeningBalancePostingAction({
  openingBalanceId,
  clientId,
  header,
  lines,
  accountsById,
  isDirty,
  isSaving,
  stateUncertain,
  stateUnavailable,
  onPosted,
  onCompetingState,
}: OpeningBalancePostingActionProps) {
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const {
    data: marker,
    isPending: markerPending,
    isError: markerError,
    refetch: refetchMarker,
  } = useOpeningBalanceMarker(openingBalanceId ?? undefined);
  const { data: canPost } = useCanAssertOpeningBalance();
  const post = usePostOpeningBalance();

  if (marker) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="beginbalans-posting-done">
        {POSTED_FINAL_NOTICE}
      </p>
    );
  }

  // "Weet ik niet" is niet hetzelfde als "niet geboekt": zolang de claimtabel
  // nog niet bevraagd is of niet bevraagd kán worden, blijft de knop uit.
  const hint = firstPostingBlockingReason({
    openingBalanceId,
    markerUnavailable: markerError || stateUnavailable,
    stateUncertain: stateUncertain || (!!openingBalanceId && markerPending),
    canPost,
    isDirty,
    isSaving,
    header,
    lines,
    accountsById,
    clientId,
  });

  // De rol is de enige poort die de knop helemaal verbergt: alleen een
  // accountant krijgt de boekactie aangeboden. Onbekend ("nog aan het laden")
  // telt als niet toegestaan — dan is er ook geen knop.
  if (canPost !== true) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="beginbalans-posting-hint">
        {canPost === undefined ? "Rechten worden gecontroleerd…" : "Alleen een accountant kan een beginbalans boeken."}
      </p>
    );
  }

  const handleConfirm = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!openingBalanceId || post.isPending) return;
    try {
      await post.mutateAsync(openingBalanceId);
      const confirmed = await refetchMarker();
      setConfirmOpen(false);
      if (confirmed.data) {
        toast({ title: "Beginbalans geboekt" });
        onPosted?.();
      } else {
        // De RPC gaf geen fout, maar de claimrij is (nog) niet zichtbaar.
        // Dan melden we geen succes.
        toast({
          title: "Boeking niet bevestigd",
          description: "Ververs de pagina en controleer de status voordat je opnieuw boekt.",
          variant: "destructive",
        });
      }
    } catch (e) {
      setConfirmOpen(false);
      const kind = (e as { kind?: OpeningBalanceErrorKind })?.kind ?? "unknown";
      const description = e instanceof Error ? e.message : undefined;
      if (isCompetingStateError(kind)) {
        // Iemand anders was eerder, of de toestand is veranderd: eerst de
        // waarheid opnieuw ophalen, dan pas iets zeggen.
        const confirmed = await refetchMarker();
        onCompetingState?.();
        if (confirmed.data) {
          toast({ title: "Deze beginbalans is al geboekt." });
          onPosted?.();
        } else {
          toast({ title: "Boeken niet gelukt", description, variant: "destructive" });
        }
        return;
      }
      // 40P01 en al het andere: melden, nooit automatisch opnieuw boeken.
      toast({ title: "Boeken niet gelukt", description, variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        className="h-11 sm:h-9"
        data-testid="beginbalans-posting-button"
        disabled={!!hint || post.isPending}
        onClick={() => setConfirmOpen(true)}
      >
        {post.isPending ? "Bezig met boeken…" : "Boeken in grootboek"}
      </Button>
      {hint && (
        <p className="text-xs text-muted-foreground" data-testid="beginbalans-posting-hint">
          {hint}
        </p>
      )}

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !post.isPending) setConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{POST_CONFIRM_TITLE}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <ul className="list-disc space-y-1 pl-5" data-testid="beginbalans-post-confirm-points">
                  {POST_CONFIRM_POINTS.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={post.isPending}>Annuleren</AlertDialogCancel>
            <AlertDialogAction
              disabled={post.isPending}
              onClick={handleConfirm}
              data-testid="beginbalans-post-confirm"
            >
              {post.isPending ? "Bezig met boeken…" : "Ja, boeken"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
