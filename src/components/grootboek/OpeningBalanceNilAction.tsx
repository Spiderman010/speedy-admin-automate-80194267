import { useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useOpeningBalance } from "@/hooks/useOpeningBalances";
import {
  useCanAssertOpeningBalance,
  useDeclareOpeningBalanceNil,
  useOpeningBalanceMarker,
} from "@/hooks/useOpeningBalancePosting";
import {
  firstNilBlockingReason,
  isCompetingStateError,
  isNilHeader,
  NIL_CONFIRM_POINTS,
  NIL_CONFIRM_TITLE,
  type OpeningBalanceErrorKind,
  type OpeningBalanceHeaderForm,
  type OpeningBalanceLineRow,
} from "@/lib/opening-balance-utils";

/**
 * Fase 6C-b8 (PR 2) — "Geen beginbalans nodig".
 *
 * Geen checkbox maar een aparte, bevestigde bewering: één aanroep van
 * public.declare_opening_balance_nil() met alleen de id. Alleen een accountant
 * krijgt de actie te zien. Succes wordt pas gemeld nadat de kop opnieuw is
 * opgehaald en nil_declaration = true én nil_declared_at gevuld is.
 */

export interface OpeningBalanceNilActionProps {
  openingBalanceId: string | null;
  header: OpeningBalanceHeaderForm;
  lines: OpeningBalanceLineRow[];
  /** Regels zoals opgeslagen in de database — die telt de RPC. */
  savedLineCount: number;
  isHeaderDirty: boolean;
  isSaving: boolean;
  stateUncertain: boolean;
  stateUnavailable: boolean;
  onDeclared?: () => void;
  onCompetingState?: () => void;
}

export function OpeningBalanceNilAction({
  openingBalanceId,
  header,
  lines,
  savedLineCount,
  isHeaderDirty,
  isSaving,
  stateUncertain,
  stateUnavailable,
  onDeclared,
  onCompetingState,
}: OpeningBalanceNilActionProps) {
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { data: marker, isPending: markerPending, isError: markerError } = useOpeningBalanceMarker(
    openingBalanceId ?? undefined,
  );
  const { refetch: refetchHeader } = useOpeningBalance(openingBalanceId ?? undefined);
  const { data: canDeclare } = useCanAssertOpeningBalance();
  const declare = useDeclareOpeningBalanceNil();

  // Een niet-accountant krijgt de bewering niet aangeboden; een geboekte
  // beginbalans kan niet meer op nihil.
  if (canDeclare !== true || marker) return null;

  const hint = firstNilBlockingReason({
    openingBalanceId,
    markerUnavailable: markerError || stateUnavailable,
    stateUncertain: stateUncertain || (!!openingBalanceId && markerPending),
    canDeclare,
    isHeaderDirty,
    isSaving,
    header,
    savedLineCount,
    lines,
  });

  const handleConfirm = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!openingBalanceId || declare.isPending) return;
    try {
      await declare.mutateAsync(openingBalanceId);
      const fresh = await refetchHeader();
      setConfirmOpen(false);
      if (fresh.data && isNilHeader(fresh.data)) {
        toast({ title: "Vastgelegd: geen beginbalans nodig" });
        onDeclared?.();
      } else {
        toast({
          title: "Nihil-verklaring niet bevestigd",
          description: "Ververs de pagina en controleer de status.",
          variant: "destructive",
        });
      }
    } catch (e) {
      setConfirmOpen(false);
      const kind = (e as { kind?: OpeningBalanceErrorKind })?.kind ?? "unknown";
      const description = e instanceof Error ? e.message : undefined;
      if (isCompetingStateError(kind)) {
        const fresh = await refetchHeader();
        onCompetingState?.();
        if (fresh.data && isNilHeader(fresh.data)) {
          toast({ title: "Deze beginbalans is al op nihil verklaard." });
          onDeclared?.();
        } else {
          toast({ title: "Nihil-verklaring niet gelukt", description, variant: "destructive" });
        }
        return;
      }
      toast({ title: "Nihil-verklaring niet gelukt", description, variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        className="h-11 sm:h-9"
        data-testid="beginbalans-nil-button"
        disabled={!!hint || declare.isPending}
        onClick={() => setConfirmOpen(true)}
      >
        {declare.isPending ? "Bezig…" : "Geen beginbalans nodig"}
      </Button>
      {hint && (
        <p className="text-xs text-muted-foreground" data-testid="beginbalans-nil-hint">
          {hint}
        </p>
      )}

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !declare.isPending) setConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{NIL_CONFIRM_TITLE}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <ul className="list-disc space-y-1 pl-5" data-testid="beginbalans-nil-confirm-points">
                  {NIL_CONFIRM_POINTS.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={declare.isPending}>Annuleren</AlertDialogCancel>
            <AlertDialogAction
              disabled={declare.isPending}
              onClick={handleConfirm}
              data-testid="beginbalans-nil-confirm"
            >
              {declare.isPending ? "Bezig…" : "Ja, vastleggen"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
