import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Download, Landmark } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import { FinancialReportHeader } from "@/components/overzichten/FinancialReportHeader";
import { FinancialStatementTable } from "@/components/overzichten/FinancialStatementTable";
import { FinancialCompletenessBadge } from "@/components/overzichten/FinancialCompletenessBadge";
import {
  NothingClassifiedNotice,
  OpeningBalanceCarryForwardNotice,
  StatementCompletenessNotice,
  StatementFailureNotice,
  UnclassifiedSection,
} from "@/components/overzichten/FinancialReportNotices";
import { unclassifiedRelevanceFor } from "@/lib/unclassified-attribution";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useFinancialStatements } from "@/hooks/useFinancialStatements";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { subgroupSectionsForGroups } from "@/lib/financial-statements-subgroups";
import { ReportDrilldownSheet } from "@/components/overzichten/ReportDrilldownSheet";
import { groupView, type DrilldownTarget } from "@/lib/report-drilldown";
import { LedgerCompletenessNotice } from "@/components/grootboek/LedgerCompletenessNotice";
import { useLedgerCompleteness, useOpeningBalanceCompleteness } from "@/hooks/useLedgerCompleteness";
import { periodFromSelection, periodLabel, type PeriodSelection } from "@/lib/grootboek-saldi-utils";
import {
  balanceSheetToCsv,
  formatCents,
  statementCsvFilename,
} from "@/lib/financial-statements-presentation";

/**
 * Balans/W&V PR 4 — de balans (/grootboek/balans).
 *
 * Deze pagina rekent niets uit. De datastroom is
 * ledger_postings → buildAccountReport() → buildFinancialStatements() → hier;
 * elk bedrag op het scherm is een veld uit die engine. Er wordt geen totaal
 * opgeteld, geen teken omgeklapt en geen verschil berekend in React.
 *
 * Fail-closed: sluit de boekingscontrole niet, dan verschijnen er geen cijfers
 * en is de export uit.
 */

export const BALANS_EMPTY_MESSAGE = "Nog geen geboekte grootboekmutaties voor deze periode.";

function BalansSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Balans laden…</span>
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

export default function Balans() {
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
  // De beginbalans is hier uitsluitend volledigheidsinformatie: hij bepaalt
  // NOOIT of er cijfers verschijnen, alleen of de overloop uit eerdere jaren
  // is vastgesteld.
  const openingBalance = useOpeningBalanceCompleteness(clientId, period);

  const selectedClient = clients?.find((c) => c.id === selectedClientId);
  const ready = state.kind === "ready" && state.result.ok === true ? state.result : null;
  /*
   * De doorklik draagt alleen een AANWIJZING: welke categorie, groep of
   * rekening de gebruiker wil zien. Elk bedrag in het paneel komt uit de
   * engine of uit de kern — hier wordt niets herrekend en geen periode
   * gewisseld.
   */
  const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null);
  /*
   * Het tweede taxonomieniveau (report_subgroup), uitsluitend presentatie.
   * De rekeningen komen uit dezelfde query die `useFinancialStatements` al
   * doet — react-query deelt de cache op dezelfde sleutel, dus dit is geen
   * tweede verzoek. Er wordt hier niets opgeteld: `subgroupSectionsForGroups`
   * deelt de regels van de engine op en geeft elk groepstotaal ongewijzigd
   * door.
   */
  const { data: rekeningenVoorIndeling } = useGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });
  const activaSecties = useMemo(
    () =>
      ready
        ? subgroupSectionsForGroups(ready.balanceSheet.assetGroups, rekeningenVoorIndeling ?? [])
        : undefined,
    [ready, rekeningenVoorIndeling],
  );
  const passivaSecties = useMemo(
    () =>
      ready
        ? subgroupSectionsForGroups(ready.balanceSheet.liabilityEquityGroups, rekeningenVoorIndeling ?? [])
        : undefined,
    [ready, rekeningenVoorIndeling],
  );


  /** Rekeningnamen voor het boekingspaneel; puur presentatie. */
  const drilldownAccountsById = useMemo(
    () =>
      new Map(
        (rekeningenVoorIndeling ?? []).map((r) => [
          r.id,
          { id: r.id, nummer: r.nummer, omschrijving: r.omschrijving },
        ]),
      ),
    [rekeningenVoorIndeling],
  );
  /** De aangeklikte categorie, opgedeeld zoals het rapport haar toont. */
  const drilldownView = useMemo(() => {
    if (!drilldown || !ready) return null;
    const alleGroepen = [...ready.balanceSheet.assetGroups, ...ready.balanceSheet.liabilityEquityGroups];
    const alleSecties = [...(activaSecties ?? []), ...(passivaSecties ?? [])];
    const groep = alleGroepen.find((g) => g.key === drilldown.groupKey);
    if (!groep) return null;
    return groupView(groep, alleSecties.find((s) => s.group.key === drilldown.groupKey));
  }, [drilldown, ready, activaSecties, passivaSecties]);

  // Is er activiteit maar geen enkele geclassificeerde balansregel, dan zegt de
  // specifieke melding het al; de generieke volledigheidsmelding zou hetzelfde
  // nog eens herhalen.
  //
  // De telling is per overzicht. Een globale telling over álle
  // niet-geclassificeerde rekeningen zou de balans laten beweren dat zíj leeg
  // is door ontbrekende classificatie, terwijl die activiteit aantoonbaar aan
  // de W&V-kant hoort.
  const relevance = ready
    ? unclassifiedRelevanceFor(ready.unclassified.accounts, "balans")
    : { relevantCount: 0, undeterminedCount: 0, any: false };
  const nothingClassified =
    ready !== null &&
    relevance.any &&
    ![...ready.balanceSheet.assetGroups, ...ready.balanceSheet.liabilityEquityGroups].some(
      (g) => g.lines.length > 0,
    );
  const exportable = ready !== null;

  // Alleen nodig om een LEEG rapport te kunnen duiden: zijn er documenten die
  // nog niet in het grootboek staan? Raakt geen enkel bedrag — en draait dus
  // pas zodra ná het laden vaststaat dát het rapport leeg is. Op een gevuld
  // scherm blijft die (zware) telquery uit.
  const reportIsEmpty = ready !== null && isEmpty && ready.unclassified.accounts.length === 0;
  const documents = useLedgerCompleteness(clientId, { enabled: reportIsEmpty });

  const exporteer = () => {
    if (!ready) return;
    const inhoud = balanceSheetToCsv({
      balanceSheet: ready.balanceSheet,
      unclassified: ready.unclassified.accounts,
    });
    const bestand = statementCsvFilename("balans", selectedClient?.name ?? "administratie", periodLabel(selection));
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
    if (state.kind === "loading") return <BalansSkeleton />;

    if (state.kind === "error") {
      return (
        <Alert variant="destructive" data-testid="balans-error">
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

    // Engine faalt → geen cijfers. Nooit een balans die betrouwbaar oogt.
    if (state.result.ok !== true) return <StatementFailureNotice failures={state.result.failures} />;

    const { balanceSheet, unclassified } = state.result;
    if (reportIsEmpty) {
      return (
        <div className="space-y-4">
          <EmptyState icon={Landmark} message={BALANS_EMPTY_MESSAGE} />
          {/* Leeg kan óók betekenen: documenten bestaan wel, maar zijn nog niet
              in het grootboek geboekt. Dat is hier de enige overgebleven
              oorzaak, dus tonen we de bestaande volledigheidsmeter. */}
          <LedgerCompletenessNotice
            completeness={documents.data}
            isLoading={documents.isPending}
            isError={documents.isError}
          />
        </div>
      );
    }

    // Geen enkele geclassificeerde regel terwijl er wél activiteit is: dan is
    // het overzicht leeg om één reden, en die hoort bovenaan te staan.
    return (
      <div className="space-y-6">
        {nothingClassified && <NothingClassifiedNotice accounts={unclassified.accounts} what="balans" />}
        {/* Twee kolommen naast elkaar op een breed scherm, onder elkaar op een
            smal — elk met een eigen omkadering zodat Activa en Passiva ook
            gestapeld duidelijk twee kanten van dezelfde balans blijven. */}
        <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
          <section aria-labelledby="balans-activa" className="min-w-0 rounded-lg border">
            <h2
              id="balans-activa"
              className="border-b bg-muted/30 px-3 py-2 text-sm font-semibold uppercase tracking-wide"
            >
              Activa
            </h2>
            <div className="p-2 sm:p-3">
              <FinancialStatementTable
                caption="Activa"
                groups={balanceSheet.assetGroups}
                sections={activaSecties}
                onDrilldown={setDrilldown}
                totalLabel="Totaal activa"
                totalCents={balanceSheet.totalAssetsCents}
                testId="balans-activa-table"
              />
            </div>
          </section>
          <section aria-labelledby="balans-passiva" className="min-w-0 rounded-lg border">
            <h2
              id="balans-passiva"
              className="border-b bg-muted/30 px-3 py-2 text-sm font-semibold uppercase tracking-wide"
            >
              Passiva
            </h2>
            <div className="p-2 sm:p-3">
              <FinancialStatementTable
                caption="Passiva"
                groups={balanceSheet.liabilityEquityGroups}
                sections={passivaSecties}
                onDrilldown={setDrilldown}
                systemLines={balanceSheet.systemLines}
                totalLabel="Totaal passiva"
                totalCents={balanceSheet.totalLiabilitiesEquityCents}
                testId="balans-passiva-table"
              />
            </div>
          </section>
        </div>

        {/* Sluit de balans, dan is dit een rustige bevestiging; sluit hij niet,
            dan moet het onmogelijk zijn eroverheen te lezen. Nooit kleur
            alleen: de tekst zegt het ook. */}
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3",
            balanceSheet.differenceCents === 0
              ? "bg-muted/40"
              : "border-destructive/60 bg-destructive/10",
          )}
          data-testid="balans-difference"
          data-difference={balanceSheet.differenceCents}
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            {balanceSheet.differenceCents !== 0 && (
              <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
            )}
            Verschil activa − passiva
          </span>
          <span
            className={cn(
              "font-mono text-base font-bold tabular-nums",
              // Massieve chip met de bijbehorende foreground: dat contrast is
              // per constructie goed, ook in donker thema. `text-destructive`
              // op een destructive-tint haalde daar de 4,5:1 niet.
              balanceSheet.differenceCents !== 0 &&
                "rounded-md bg-destructive px-2 py-0.5 text-destructive-foreground",
            )}
          >
            {formatCents(balanceSheet.differenceCents)}
          </span>
        </div>

        {balanceSheet.differenceCents !== 0 && (
          <Alert variant="destructive" data-testid="balans-difference-warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>De balans sluit niet</AlertTitle>
            <AlertDescription>
              Het verschil is {formatCents(balanceSheet.differenceCents)}. Dat is precies het deel van het
              grootboek dat nog geen plaats in de balans heeft; classificeer de rekeningen hieronder.
            </AlertDescription>
          </Alert>
        )}

        <UnclassifiedSection
          accounts={unclassified.accounts}
          amountOf={(a) => a.rawSignedClosingCents}
          testId="balans-unclassified"
        />
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title="Balans"
        description="De stand van bezittingen, schulden en eigen vermogen op de einddatum van de periode, uitsluitend uit geboekte grootboekmutaties. Bedragen in euro."
      />

      {/* Eén balk: waarover, welke periode, hoe volledig, en de export. */}
      <FinancialReportHeader
        clients={clients}
        selectedClientId={selectedClientId}
        onSelectClient={setSelectedClientId}
        selection={selection}
        onSelectionChange={setSelection}
        idPrefix="balans"
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
            data-testid="balans-export"
          >
            <Download className="mr-2 h-4 w-4" />CSV exporteren
          </Button>
        }
      />

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om de balans te bekijken." />
      ) : (
        <div className="space-y-4">
          {ready && !nothingClassified && <StatementCompletenessNotice completeness={ready.completeness} />}
          {ready && <OpeningBalanceCarryForwardNotice completeness={openingBalance.data} />}
          <Card>
            <CardContent className="p-4 sm:p-6">{renderBody()}</CardContent>
          </Card>
        </div>
      )}

      {/* Doorklikken zonder het rapport te verlaten: dezelfde administratie,
          dezelfde periode, en onderin het bestaande boekingspaneel. */}
      {clientId && (
        <ReportDrilldownSheet
          target={drilldown}
          onTargetChange={setDrilldown}
          view={drilldownView}
          clientId={clientId}
          period={period}
          periodLabel={periodLabel(selection)}
          clientName={selectedClient?.name ?? "administratie"}
          accountsById={drilldownAccountsById}
          accounts={rekeningenVoorIndeling ?? []}
          reportLabel="Balans"
        />
      )}
    </>
  );
}
