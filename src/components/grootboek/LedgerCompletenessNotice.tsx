import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Info } from "lucide-react";
import type {
  LedgerCompleteness,
  LedgerSourceCompleteness,
  OpeningBalanceCompleteness,
} from "@/lib/ledger-completeness";
import { OPENING_BALANCE_ROUTE } from "@/lib/ledger-reporting";

/**
 * Fase 6C-b7 PR 2 — volledigheidsmelding boven het grootboek.
 *
 * Het grootboek bevat alleen wat expliciet geboekt is. Deze melding toont per
 * bronsoort geboekt/postbaar, telt geweigerde documenten apart (die zijn géén
 * "nog niet geboekt") en is eerlijk wanneer een telling niet mogelijk is.
 * Het is metadata: er staat hier nooit een bedrag en niets hiervan raakt de
 * grootboektotalen.
 *
 * Fase 6C-b8 PR 3 voegt de beginbalans-dimensie toe (niet ingesteld / concept
 * / geboekt / nihil / ander boekjaar / conflict / onbekend), afgeleid uit de
 * domeintabellen. Alleen "geboekt" en "nihil" tellen als volledig; een
 * rapport wordt nooit volledig genoemd omdat er nu eenmaal grootboekregels zijn.
 */

export interface LedgerCompletenessNoticeProps {
  completeness: LedgerCompleteness | undefined;
  isLoading?: boolean;
  isError?: boolean;
  /** Beginbalansstatus voor het rapportjaar; weggelaten = niet tonen (oude aanroepers). */
  openingBalance?: OpeningBalanceCompleteness | undefined;
  openingBalanceLoading?: boolean;
  openingBalanceError?: boolean;
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

const OB_BADGE_VARIANT: Record<OpeningBalanceCompleteness["severity"], "success" | "warning" | "outline"> = {
  complete: "success",
  incomplete: "warning",
  unknown: "outline",
};

function OpeningBalanceRow({
  ob,
  loading,
  error,
}: {
  ob: OpeningBalanceCompleteness | undefined;
  loading?: boolean;
  error?: boolean;
}) {
  if (loading && !ob) {
    return (
      <li className="flex items-center gap-2 text-sm" data-testid="completeness-opening_balance" data-ob-state="loading">
        <span className="font-medium">Beginbalans</span>
        <span className="text-muted-foreground" role="status">wordt gecontroleerd…</span>
      </li>
    );
  }
  const shown: OpeningBalanceCompleteness | null =
    error || !ob
      ? {
          state: "unknown",
          year: null,
          assertionYear: null,
          draftCount: 0,
          label: "Onbekend",
          severity: "unknown",
          note: "Kon beginbalansstatus niet controleren.",
        }
      : ob;
  return (
    <li
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
      data-testid="completeness-opening_balance"
      data-ob-state={shown.state}
    >
      <span className="font-medium">Beginbalans{shown.year !== null ? ` ${shown.year}` : ""}</span>
      {/* Status als tekst én als badge: nooit alleen kleur. */}
      <Badge variant={OB_BADGE_VARIANT[shown.severity]} className="font-normal">
        {shown.label}
      </Badge>
      {(shown.state === "nil" || shown.state === "nil_prior") && (
        <span className="text-xs text-muted-foreground">(bewust op nihil gezet)</span>
      )}
      <Link
        to={OPENING_BALANCE_ROUTE}
        className="text-xs underline underline-offset-2"
        aria-label="Naar beginbalans van deze administratie"
      >
        Naar beginbalans
      </Link>
      {shown.note && <span className="basis-full text-xs text-muted-foreground">{shown.note}</span>}
    </li>
  );
}

export function LedgerCompletenessNotice({
  completeness,
  isLoading,
  isError,
  openingBalance,
  openingBalanceLoading,
  openingBalanceError,
}: LedgerCompletenessNoticeProps) {
  const showOb = openingBalance !== undefined || !!openingBalanceLoading || !!openingBalanceError;

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
          <p className="mb-2">
            De tellingen van geboekte documenten konden niet worden opgehaald. Het grootboek bevat alleen
            expliciet geboekte mutaties; dit overzicht kan onvolledig zijn.
          </p>
          {showOb && (
            <ul className="grid gap-1">
              <OpeningBalanceRow ob={openingBalance} loading={openingBalanceLoading} error={openingBalanceError} />
            </ul>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  // De beginbalans telt mee in het oordeel: alleen geboekt of nihil is
  // volledig; niet ingesteld, concept en een ander boekjaar zijn onvolledig,
  // en wat niet te controleren is blijft onbekend (nooit stilzwijgend groen).
  const obSeverity = showOb
    ? openingBalanceError || !openingBalance
      ? "unknown"
      : openingBalance.severity
    : "complete";
  const docsIncomplete = completeness.mayBeIncomplete;
  // Kon geen enkele bron worden geteld, dan is "onvolledig" al te stellig:
  // we weten het simpelweg niet. `unknownLedgerCompleteness()` levert precies
  // die toestand, en die hoort ook zo in beeld te komen. Een niet te bepalen
  // beginbalansstatus blijft óók "onbekend" in de kop — niet "onvolledig".
  const allesOnbekend = completeness.sources.every((s) => s.status === "unknown");
  const verdict: "unknown" | "incomplete" | "complete" =
    allesOnbekend ? "unknown"
      : docsIncomplete || obSeverity === "incomplete" ? "incomplete"
        : obSeverity === "unknown" ? "unknown"
          : "complete";
  const incomplete = verdict !== "complete";
  return (
    <Alert
      data-testid="ledger-completeness"
      data-status={verdict}
      className={incomplete ? "border-amber-500/50" : undefined}
    >
      {incomplete ? <Info className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
      <AlertTitle>
        {allesOnbekend
          ? "Volledigheid onbekend"
          : verdict === "incomplete"
            ? "Let op: dit grootboek is mogelijk onvolledig (alle jaren)"
            : verdict === "unknown"
              ? "Volledigheid onbekend: de beginbalansstatus is niet te bepalen"
              : showOb
                ? "Alle postbare documenten zijn geboekt (alle jaren) en de beginbalans is vastgelegd"
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
          {showOb && (
            <OpeningBalanceRow ob={openingBalance} loading={openingBalanceLoading} error={openingBalanceError} />
          )}
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
