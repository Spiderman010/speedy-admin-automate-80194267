import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, BarChart3, Download } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { FinancialReportHeader } from "@/components/overzichten/FinancialReportHeader";
import { FinancialStatementTable } from "@/components/overzichten/FinancialStatementTable";
import { FinancialCompletenessBadge } from "@/components/overzichten/FinancialCompletenessBadge";
import {
  OpeningBalanceContributionNotice,
  StatementCompletenessNotice,
  StatementFailureNotice,
  UnclassifiedSection,
} from "@/components/overzichten/FinancialReportNotices";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useFinancialStatements } from "@/hooks/useFinancialStatements";
import { periodFromSelection, periodLabel, type PeriodSelection } from "@/lib/grootboek-saldi-utils";
import {
  formatCents,
  openingContributionNotice,
  profitLossToCsv,
  statementCsvFilename,
} from "@/lib/financial-statements-presentation";

/**
 * Balans/W&V PR 4 — de winst-en-verliesrekening (/grootboek/winst-verlies).
 *
 * Zelfde datastroom en zelfde belofte als de balans: elk bedrag komt uit
 * buildFinancialStatements(); deze pagina telt niets op. Het resultaat onderaan
 * is `netResultCents` van de engine, niet een eigen som van de groepen.
 */

export const WV_EMPTY_MESSAGE = "Nog geen geboekte grootboekmutaties voor deze periode.";

function WvSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Winst-en-verliesrekening laden…</span>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-16 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export default function WinstVerlies() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;

  const [selection, setSelection] = useState<PeriodSelection>({ kind: "year", year: new Date().getFullYear() });
  const period = useMemo(() => periodFromSelection(selection), [selection]);

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const { state, refetchPostings, refetchAccounts, isEmpty } = useFinancialStatements({
    clientId,
    period,
    enabled: orgEnabled,
  });

  const selectedClient = clients?.find((c) => c.id === selectedClientId);
  const ready = state.kind === "ready" && state.result.ok === true ? state.result : null;
  const exportable = ready !== null;

  const exporteer = () => {
    if (!ready) return;
    const inhoud = profitLossToCsv({
      profitLoss: ready.profitLoss,
      unclassified: ready.unclassified.accounts,
    });
    const bestand = statementCsvFilename("winst-verlies", selectedClient?.name ?? "administratie", periodLabel(selection));
    const bom = "﻿";
    const blob = new Blob([bom + inhoud], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = bestand;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderBody = () => {
    if (state.kind === "idle") return null;
    if (state.kind === "loading") return <WvSkeleton />;

    if (state.kind === "error") {
      return (
        <Alert variant="destructive" data-testid="wv-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {state.source === "accounts" ? "Rekeningschema laden is mislukt" : "Rapport kan niet worden opgebouwd"}
          </AlertTitle>
          <AlertDescription>
            <p>{state.message}</p>
            {state.source !== "reporting" && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => (state.source === "accounts" ? refetchAccounts() : refetchPostings())}
              >
                Opnieuw proberen
              </Button>
            )}
          </AlertDescription>
        </Alert>
      );
    }

    if (state.result.ok !== true) return <StatementFailureNotice failures={state.result.failures} />;

    const { profitLoss, unclassified } = state.result;
    if (isEmpty && unclassified.accounts.length === 0) {
      return <EmptyState icon={BarChart3} message={WV_EMPTY_MESSAGE} />;
    }

    return (
      <div className="space-y-6">
        <FinancialStatementTable
          caption="Winst-en-verliesrekening"
          groups={profitLoss.groups}
          totalLabel="Resultaat"
          totalCents={profitLoss.netResultCents}
          testId="wv-table"
        />

        {/* Opbrengsten en kosten zijn de opmaat; het resultaat is de conclusie
            en krijgt daarom de meeste nadruk. De duiding staat er als WOORD
            bij — kleur alleen zou niet leesbaar zijn voor iedereen. */}
        {/* `dl > div > (dt, dd)` is het geldige contentmodel; de grid staat
            daarom op de dl zelf en niet op een tussenliggende div. */}
        <dl
          className="grid overflow-hidden rounded-lg border sm:grid-cols-2"
          data-testid="wv-summary"
        >
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5 sm:border-r">
            <dt className="text-sm text-muted-foreground">Opbrengsten</dt>
            <dd className="font-mono text-sm tabular-nums" data-testid="wv-revenue">
              {formatCents(profitLoss.revenueCents)}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
            <dt className="text-sm text-muted-foreground">Kosten</dt>
            <dd className="font-mono text-sm tabular-nums" data-testid="wv-expense">
              {formatCents(profitLoss.expenseCents)}
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-foreground/20 bg-muted/40 px-4 py-3 sm:col-span-2">
            <dt className="text-sm font-semibold uppercase tracking-wide">Resultaat</dt>
            <dd
              className="flex items-baseline gap-2 font-mono text-lg font-bold tabular-nums"
              data-testid="wv-result"
              data-result={profitLoss.netResultCents}
            >
              {formatCents(profitLoss.netResultCents)}
              <span className="font-sans text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {profitLoss.netResultCents === 0 ? "neutraal" : profitLoss.netResultCents > 0 ? "winst" : "verlies"}
              </span>
            </dd>
          </div>
        </dl>

        <UnclassifiedSection
          accounts={unclassified.accounts}
          amountOf={(a) => a.rawSignedMovementCents}
          testId="wv-unclassified"
        />
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title="Winst-en-verliesrekening"
        description="Opbrengsten en kosten over de gekozen periode, uitsluitend uit geboekte grootboekmutaties. Bedragen in euro."
      />

      {/* Eén balk: waarover, welke periode, hoe volledig, en de export. */}
      <FinancialReportHeader
        clients={clients}
        selectedClientId={selectedClientId}
        onSelectClient={setSelectedClientId}
        selection={selection}
        onSelectionChange={setSelection}
        idPrefix="wv"
        status={
          ready ? (
            <span className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Volledigheid</span>
              <FinancialCompletenessBadge completeness={ready.completeness} />
            </span>
          ) : null
        }
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={exporteer}
            disabled={!exportable}
            data-testid="wv-export"
          >
            <Download className="mr-2 h-4 w-4" />CSV exporteren
          </Button>
        }
      />

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om de winst-en-verliesrekening te bekijken." />
      ) : (
        <div className="space-y-4">
          {ready && <StatementCompletenessNotice completeness={ready.completeness} />}
          {ready && (
            <OpeningBalanceContributionNotice
              notice={openingContributionNotice(
                ready.profitLoss.openingBalanceContributionCents,
                ready.diagnostics.openingBalanceInsidePeriod,
              )}
            />
          )}
          <Card>
            <CardContent className="p-4 sm:p-6">{renderBody()}</CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
