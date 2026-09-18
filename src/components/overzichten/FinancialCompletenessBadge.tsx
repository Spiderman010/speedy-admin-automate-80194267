import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { COMPLETENESS_PRESENTATION } from "@/lib/financial-statements-presentation";
import type { StatementCompleteness } from "@/lib/financial-statements";

/**
 * Balans/W&V PR 4 — de volledigheidsstatus van een jaarrekeningrapport.
 *
 * De tekst staat altijd in de badge (nooit alleen kleur) en "Controle vereist"
 * krijgt bewust géén groen: een periode die geen volledig boekjaar is, mag er
 * niet uitzien als een afgerond rapport.
 */

const TONE_CLASS: Record<"success" | "warning" | "neutral", string> = {
  success: "border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200",
  warning: "border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  neutral: "border-border bg-muted text-muted-foreground",
};

export function FinancialCompletenessBadge({ completeness }: { completeness: StatementCompleteness }) {
  const presentation = COMPLETENESS_PRESENTATION[completeness];
  return (
    <Badge
      variant="outline"
      data-testid="statement-completeness"
      data-completeness={completeness}
      className={cn("font-normal", TONE_CLASS[presentation.tone])}
      title={presentation.description}
    >
      {presentation.label}
    </Badge>
  );
}
