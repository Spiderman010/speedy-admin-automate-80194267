import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Info } from "lucide-react";
import type { LedgerCompleteness, LedgerSourceCompleteness } from "@/lib/ledger-completeness";

/**
 * Fase 6C-b7 PR 2 — volledigheidsmelding boven het grootboek.
 *
 * Het grootboek bevat alleen wat expliciet geboekt is. Deze melding toont per
 * bronsoort geboekt/postbaar, telt geweigerde documenten apart (die zijn géén
 * "nog niet geboekt") en is eerlijk wanneer een telling niet mogelijk is.
 * Het is metadata: er staat hier nooit een bedrag en niets hiervan raakt de
 * grootboektotalen.
 */

export interface LedgerCompletenessNoticeProps {
  completeness: LedgerCompleteness | undefined;
  isLoading?: boolean;
  isError?: boolean;
}

function statusText(s: LedgerSourceCompleteness): string {
  switch (s.status) {
    case "complete":
      return "volledig";
    case "incomplete":
      return `${s.outstanding} nog niet geboekt`;
    case "empty":
      return "geen";
    case "unknown":
      return "onbekend";
  }
}

export function LedgerCompletenessNotice({ completeness, isLoading, isError }: LedgerCompletenessNoticeProps) {
  if (isLoading) {
    return (
      <div role="status" aria-live="polite" aria-busy="true" className="rounded-lg border p-4">
        <span className="sr-only">Volledigheid wordt bepaald…</span>
        <Skeleton className="h-4 w-64" />
      </div>
    );
  }

  if (isError || !completeness) {
    return (
      <Alert data-testid="ledger-completeness" data-status="unknown">
        <Info className="h-4 w-4" />
        <AlertTitle>Volledigheid onbekend</AlertTitle>
        <AlertDescription>
          De tellingen van geboekte documenten konden niet worden opgehaald. Het grootboek bevat alleen
          expliciet geboekte mutaties; dit overzicht kan onvolledig zijn.
        </AlertDescription>
      </Alert>
    );
  }

  const incomplete = completeness.mayBeIncomplete;
  return (
    <Alert
      data-testid="ledger-completeness"
      data-status={incomplete ? "incomplete" : "complete"}
      className={incomplete ? "border-amber-500/50" : undefined}
    >
      {incomplete ? <Info className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
      <AlertTitle>
        {incomplete
          ? "Let op: dit grootboek is mogelijk onvolledig (alle jaren)"
          : "Alle postbare documenten zijn geboekt (alle jaren)"}
      </AlertTitle>
      <AlertDescription>
        <p className="mb-2">
          Het grootboek bevat alleen expliciet geboekte mutaties.
          {incomplete && completeness.totalOutstanding > 0 && (
            <>
              {" "}
              {completeness.totalOutstanding} postba{completeness.totalOutstanding === 1 ? "ar document is" : "re documenten zijn"}{" "}
              nog niet geboekt.
            </>
          )}
        </p>
        <ul className="grid gap-1 sm:grid-cols-2">
          {completeness.sources.map((s) => (
            <li key={s.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm" data-testid={`completeness-${s.key}`}>
              <span className="font-medium">{s.label}</span>
              <span className="font-mono tabular-nums">
                {s.status === "unknown" ? "—" : `${s.posted} / ${s.eligible}`}
              </span>
              <Badge variant="outline" className="font-normal">
                {statusText(s)}
              </Badge>
              {s.refused !== null && s.refused > 0 && (
                <Badge variant="secondary" className="font-normal" data-testid={`completeness-${s.key}-refused`}>
                  {s.refused} {s.refusedLabel}
                </Badge>
              )}
              {s.note && <span className="basis-full text-xs text-muted-foreground">{s.note}</span>}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
