import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCentsEuro, type OpeningBalanceTotals } from "@/lib/opening-balance-utils";

/**
 * Fase 6C-b8 (PR 2) — totalen van een beginbalans: totaal debet, totaal
 * credit en het getekende verschil, doorlopend zichtbaar. Alles in hele
 * centen; "In balans" alleen bij gelijke, niet-nul totalen zonder ongeldige
 * bedragen. Er wordt hier niets aangevuld of rechtgetrokken.
 */

export interface OpeningBalanceSummaryProps {
  totals: OpeningBalanceTotals;
}

function differenceLabel(cents: number): string {
  if (cents === 0) return "in balans";
  return cents > 0 ? "debet is hoger" : "credit is hoger";
}

export function OpeningBalanceSummary({ totals }: OpeningBalanceSummaryProps) {
  const debit = formatCentsEuro(totals.debitCents);
  const credit = formatCentsEuro(totals.creditCents);
  const difference = formatCentsEuro(totals.differenceCents);
  const summary = `Totaal debet ${debit}, totaal credit ${credit}, verschil ${difference} (${differenceLabel(totals.differenceCents)}).`;

  return (
    <div className="border-t pt-3" data-testid="beginbalans-summary">
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {summary}
      </p>
      <dl className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 text-sm" aria-hidden="true">
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">Totaal debet</dt>
          <dd className="font-mono tabular-nums" data-testid="beginbalans-total-debit">{debit}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">Totaal credit</dt>
          <dd className="font-mono tabular-nums" data-testid="beginbalans-total-credit">{credit}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">Verschil</dt>
          <dd
            className={cn("font-mono tabular-nums", totals.differenceCents === 0 ? "text-foreground" : "text-destructive")}
            data-testid="beginbalans-difference"
          >
            {difference}
            {totals.differenceCents !== 0 && (
              <span className="ml-1 font-sans text-xs text-muted-foreground">({differenceLabel(totals.differenceCents)})</span>
            )}
          </dd>
        </div>
        {totals.isBalanced && (
          <Badge variant="outline" data-testid="beginbalans-balanced">
            In balans
          </Badge>
        )}
      </dl>
      {totals.invalidLineCount > 0 && (
        <p className="mt-1 text-right text-xs text-destructive" role="alert" data-testid="beginbalans-invalid-count">
          {totals.invalidLineCount} regel(s) met een ongeldig bedrag; die tellen niet mee in de totalen.
        </p>
      )}
    </div>
  );
}
