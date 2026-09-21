import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { AccountingAmount } from "@/components/platform/AccountingAmount";
import { AccountingNotice } from "@/components/platform/AccountingNotice";
import { FinancialActionDialog } from "@/components/platform/FinancialActionDialog";
import { formatCents, formatDatumNL } from "@/lib/grootboek-saldi-utils";
import {
  firstReversalFormIssue,
  MAX_REVERSAL_REASON_LENGTH,
  formatReversalAccountLabel,
  normalizeReversalReason,
  APPEND_ONLY_NOTICE,
  ORIGINAL_HEADING,
  ORIGINAL_REMAINS_NOTICE,
  REASON_LABEL,
  REVERSAL_DATE_LABEL,
  PREVIEW_NOTICE,
  REVERSAL_CONFIRM_BUTTON,
  REVERSAL_CONFIRM_TITLE,
  type PostingGroupSummary,
  type ReversalAccountRef,
  type ReversalPreviewLine,
} from "@/lib/ledger-reversal-ui";

/**
 * 6C-b9 PR 2 — de bevestiging van een tegenboeking.
 *
 * Twee dingen moeten hier waar zijn en blijven:
 *
 *   1. De gebruiker kiest de boekingsdatum ZELF. Er wordt niets voorgevuld —
 *      niet vandaag, niet de datum van het origineel, niet het eerstvolgende
 *      open jaar. In welke periode een correctie landt is een boekhoudkundige
 *      beslissing, geen gemak. De datum van het origineel staat ernaast, zodat
 *      die keuze bewust gemaakt kan worden.
 *   2. Het voorbeeld is een VOORBEELD. Het verwisselt debet en credit om uit te
 *      leggen wat er staat te gebeuren, maar geen enkel bedrag hieruit gaat
 *      naar de database: de RPC krijgt alleen een id, een datum en een
 *      toelichting en leidt haar eigen regels af uit de opgeslagen
 *      grootboekregels.
 */

export interface ReversalConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: PostingGroupSummary;
  previewLines: readonly ReversalPreviewLine[];
  accountsById: ReadonlyMap<string, ReversalAccountRef>;
  isPending: boolean;
  /** Wordt hoogstens één keer tegelijk aangeroepen; de knop blijft uit zolang het loopt. */
  onConfirm: (input: { postingDate: string; reason: string | null }) => void;
}

export function ReversalConfirmDialog({
  open,
  onOpenChange,
  summary,
  previewLines,
  accountsById,
  isPending,
  onConfirm,
}: ReversalConfirmDialogProps) {
  const [postingDate, setPostingDate] = useState("");
  const [reason, setReason] = useState("");
  const dateId = useId();
  const reasonId = useId();

  const issue = firstReversalFormIssue({ postingDate, reason });
  const reasonLength = reason.trim().length;

  const handleConfirm = () => {
    // Twee sloten op dezelfde deur: de knop staat uit terwijl het loopt, en de
    // handler weigert alsnog. Een dubbelklik of een toetsenbordpad kan zo geen
    // tweede RPC afvuren.
    if (isPending || issue) return;
    onConfirm({ postingDate: postingDate.trim(), reason: normalizeReversalReason(reason) });
  };

  return (
    /*
     * De schil (titel, uitleg, knoppen, vergrendeling) komt uit de Platform
     * Kit; de twee eisen hierboven blijven van dit bestand. De datum wordt nog
     * steeds niet voorgevuld, en de bevestigknop is nog steeds de gewone
     * primaire knop — `intent="normal"` — omdat er niets wordt verwijderd.
     */
    <FinancialActionDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPostingDate("");
          setReason("");
        }
        onOpenChange(next);
      }}
      // Annuleren sluit via de bovenliggende component, net als voorheen.
      onCancel={() => onOpenChange(false)}
      title={REVERSAL_CONFIRM_TITLE}
      explanation="De database maakt de tegenboeking en bepaalt de regels; dit scherm legt alleen uit wat er gebeurt. Er wordt niets bewerkt en niets verwijderd."
      contentClassName="sm:max-w-2xl"
      confirmLabel={REVERSAL_CONFIRM_BUTTON}
      pendingLabel="Bezig met boeken…"
      intent="normal"
      isPending={isPending}
      confirmDisabled={!!issue}
      onConfirm={handleConfirm}
      confirmTestId="reversal-confirm-button"
    >
      <AccountingNotice severity="info" data-testid="reversal-original-remains">
        {ORIGINAL_REMAINS_NOTICE}
        <span className="mt-1 block text-xs text-muted-foreground" data-testid="reversal-append-only">
          {APPEND_ONLY_NOTICE}
        </span>
      </AccountingNotice>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Datum oorspronkelijke boeking</dt>
          <dd className="font-mono tabular-nums" data-testid="reversal-original-date">
            {summary.postingDate ? formatDatumNL(summary.postingDate) : "—"}
          </dd>
        </div>
        <div className="text-right sm:text-left">
          <dt className="text-xs text-muted-foreground">Boekingstotaal</dt>
          <dd className="font-mono font-semibold tabular-nums">{formatCents(summary.debitCents)}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-muted-foreground">{ORIGINAL_HEADING}</dt>
          <dd className="font-mono break-all text-xs" data-testid="reversal-original-group">
            {summary.postingGroupId}
          </dd>
        </div>
      </dl>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={dateId}>
            {REVERSAL_DATE_LABEL} <span aria-hidden="true">*</span>
          </Label>
          <Input
            id={dateId}
            type="date"
            required
            value={postingDate}
            onChange={(e) => setPostingDate(e.target.value)}
            className="h-11 sm:h-9"
            data-testid="reversal-date-input"
          />
          <p className="text-xs text-muted-foreground">
            Kies bewust in welke periode de correctie landt. Er wordt niets voorgevuld en niets verschoven;
            een afgesloten boekjaar wordt door de database geweigerd.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={reasonId}>{REASON_LABEL} (optioneel)</Label>
          <Textarea
            id={reasonId}
            value={reason}
            rows={2}
            onChange={(e) => setReason(e.target.value)}
            data-testid="reversal-reason-input"
          />
          <p
            className={reasonLength > MAX_REVERSAL_REASON_LENGTH ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            data-testid="reversal-reason-counter"
          >
            {reasonLength} / {MAX_REVERSAL_REASON_LENGTH} tekens
          </p>
        </div>
      </div>

      <div className="rounded-md border">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2">
          <span className="text-sm font-medium">Effect van de tegenboeking</span>
          <Badge variant="outline" className="bg-background font-normal" data-testid="reversal-preview-badge">
            Voorbeeld
          </Badge>
        </div>
        <p className="px-3 pt-2 text-xs text-muted-foreground" data-testid="reversal-preview-notice">
          {PREVIEW_NOTICE}
        </p>
        <div className="overflow-x-auto px-1 pb-1">
          <table className="w-full min-w-[420px] text-sm" data-testid="reversal-preview-table">
            <caption className="sr-only">Voorbeeld van de tegenboeking per grootboekrekening</caption>
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="px-2 py-1.5 text-left font-medium">Rekening</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Debet</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody>
              {previewLines.map((line) => {
                const account = accountsById.get(line.grootboekrekeningId);
                return (
                  <tr key={line.originalRowId} className="border-b last:border-0" data-testid="reversal-preview-row">
                    <td className="px-2 py-1.5 break-words">
                      {formatReversalAccountLabel(account, line.grootboekrekeningId)}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <AccountingAmount cents={line.debitCents} blankWhenZero />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <AccountingAmount cents={line.creditCents} blankWhenZero />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>


      {issue && (
        <p className="text-sm text-destructive" role="alert" data-testid="reversal-form-issue">
          {issue}
        </p>
      )}
    </FinancialActionDialog>
  );
}
