import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Platform Kit — de schil om een bevestiging met boekhoudkundige gevolgen:
 * een tegenboeking, een periodeafsluiting, een definitieve aangifte, een
 * suppletie.
 *
 * WAT DEZE SCHIL WEL DOET: titel, uitleg, gevolgen, de plaats voor extra
 * velden, en de twee knoppen met hun vergrendeling.
 *
 * WAT ZIJ NIET DOET: boeken. Er zit geen mutatie, geen hook en geen
 * Supabase-aanroep in. `onConfirm` is van de beller, en wát er dan gebeurt
 * blijft daar staan — inclusief alle controles die daarbij horen. Deze schil
 * maakt een actie niet veiliger en ook niet gevaarlijker; ze maakt hem alleen
 * overal hetzelfde te bedienen.
 *
 * De vergrendeling is wel van hier, en bewust dubbel: zolang het loopt staat
 * de bevestigknop uit én weigert de handler alsnog. Een dubbelklik of een
 * toetsenbordpad kan zo geen tweede aanroep afvuren. Ook sluiten kan niet
 * terwijl het loopt.
 *
 * `intent` bepaalt de knopkleur en is altijd een keuze van de beller. Boeken
 * is in deze app géén destructieve handeling — een tegenboeking verwijdert
 * niets — dus de rode knop komt er alleen als de beller daar bewust om vraagt.
 */
export interface FinancialActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Eén of twee zinnen onder de titel. */
  explanation?: ReactNode;
  /** De gevolgen, als opsomming. Elke tekst is van de beller. */
  consequences?: readonly string[];
  /** Extra velden: een datum, een reden, een voorbeeld van de boeking. */
  children?: ReactNode;
  confirmLabel: string;
  /** Tekst op de bevestigknop terwijl het loopt. */
  pendingLabel?: string;
  cancelLabel?: string;
  /** Kleur van de bevestigknop. Standaard de gewone primaire knop. */
  intent?: "normal" | "destructive";
  isPending: boolean;
  /** Extra reden om nog niet te mogen bevestigen, bijvoorbeeld een leeg verplicht veld. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  /** Wat "Annuleren" doet. Standaard: sluiten. */
  onCancel?: () => void;
  contentClassName?: string;
  confirmTestId?: string;
  cancelTestId?: string;
  consequencesTestId?: string;
  "data-testid"?: string;
}

export function FinancialActionDialog({
  open,
  onOpenChange,
  title,
  explanation,
  consequences,
  children,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Annuleren",
  intent = "normal",
  isPending,
  confirmDisabled,
  onConfirm,
  onCancel,
  contentClassName,
  confirmTestId,
  cancelTestId,
  consequencesTestId,
  "data-testid": testId,
}: FinancialActionDialogProps) {
  const blocked = isPending || confirmDisabled === true;

  const handleConfirm = () => {
    if (blocked) return;
    onConfirm();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isPending) return; // niet sluiten terwijl het loopt
        onOpenChange(next);
      }}
    >
      <DialogContent
        className={cn("max-h-[90vh] gap-4 overflow-y-auto sm:max-w-lg", contentClassName)}
        data-testid={testId}
      >
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-base">{title}</DialogTitle>
          {explanation !== undefined && explanation !== null && (
            <DialogDescription className="text-xs">{explanation}</DialogDescription>
          )}
        </DialogHeader>

        {consequences !== undefined && consequences.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" data-testid={consequencesTestId}>
            {consequences.map((consequence) => (
              <li key={consequence}>{consequence}</li>
            ))}
          </ul>
        )}

        {children}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="h-11 sm:h-9"
            disabled={isPending}
            onClick={() => (onCancel ? onCancel() : onOpenChange(false))}
            data-testid={cancelTestId}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={intent === "destructive" ? "destructive" : "default"}
            className="h-11 sm:h-9"
            disabled={blocked}
            onClick={handleConfirm}
            data-testid={confirmTestId}
          >
            {isPending && pendingLabel !== undefined ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
