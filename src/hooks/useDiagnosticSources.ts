import { useMemo } from "react";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useLedgerPostings } from "@/hooks/useLedgerPostings";
import { useLedgerIntegrity } from "@/hooks/useLedgerIntegrity";
import { useLedgerCompleteness, useOpeningBalanceCompleteness } from "@/hooks/useLedgerCompleteness";
import { useFinancialStatements } from "@/hooks/useFinancialStatements";
import { buildAccountReport, type LedgerPeriod } from "@/lib/ledger-reporting";
import { buildTrialBalance } from "@/lib/proef-saldibalans";
import { subgroupSectionsForGroups, type StatementGroupSections } from "@/lib/financial-statements-subgroups";
import { available, unavailable, type DiagnosticRunInput, type Source } from "@/lib/diagnostic-report";

/**
 * De bronnen voor de controle — UITSLUITEND LEZEN.
 *
 * Er wordt hier geen enkele query bijgemaakt: elke bron komt uit een hook die
 * de app al gebruikt, met dezelfde sleutel, zodat react-query de cache deelt
 * met de rapporten zelf. Er wordt ook niets berekend dat elders al berekend
 * wordt; `buildAccountReport` en `buildTrialBalance` zijn dezelfde aanroepen
 * als op /overzichten/proef-saldibalans.
 *
 * FAIL CLOSED. Een bron die niet geladen kon worden komt terug als
 * `unavailable(...)`, nooit als lege lijst. Het verschil tussen "er is niets
 * gevonden" en "we konden niet kijken" mag in een controlerapport nooit
 * verdwijnen.
 */

export interface UseDiagnosticSourcesOptions {
  clientId: string | undefined;
  period: LedgerPeriod;
  organizationId: string | undefined;
  enabled?: boolean;
}

export interface DiagnosticSourcesState {
  /** Er wordt nog geladen; de controle kan nog niet volledig draaien. */
  isPending: boolean;
  input: DiagnosticRunInput;
}

export function useDiagnosticSources({
  clientId,
  period,
  organizationId,
  enabled = true,
}: UseDiagnosticSourcesOptions): DiagnosticSourcesState {
  const accountsQuery = useGrootboekrekeningen({ organizationId, enabled });
  const postingsQuery = useLedgerPostings({ clientId, period, enabled });
  const integrityQuery = useLedgerIntegrity(enabled ? clientId : undefined);
  const completenessQuery = useLedgerCompleteness(clientId, { enabled });
  const openingBalance = useOpeningBalanceCompleteness(clientId, period);
  const statements = useFinancialStatements({ clientId, period, enabled });

  const accounts = useMemo(
    () => (accountsQuery.data ?? []).filter((a) => a.client_id === null || a.client_id === clientId),
    [accountsQuery.data, clientId],
  );

  /** Kolommenbalans: exact dezelfde twee aanroepen als de rapportpagina. */
  const trialBalance = useMemo<Source<ReturnType<typeof buildTrialBalance>>>(() => {
    if (accountsQuery.isError || postingsQuery.isError) return unavailable("Grootboekmutaties");
    if (!clientId || !postingsQuery.data) return unavailable("Grootboekmutaties");
    const report = buildAccountReport({ rows: postingsQuery.data, clientId, period, accounts });
    return available(buildTrialBalance({ report, accounts, clientId }));
  }, [accountsQuery.isError, postingsQuery.isError, postingsQuery.data, clientId, period, accounts]);

  const integrity = useMemo(() => {
    if (integrityQuery.isError || !integrityQuery.data) return unavailable<never>("Integriteitscontrole");
    return available(integrityQuery.data);
  }, [integrityQuery.isError, integrityQuery.data]);

  const completeness = useMemo(() => {
    if (completenessQuery.isError || !completenessQuery.data) return unavailable<never>("Volledigheid per bron");
    return available(completenessQuery.data);
  }, [completenessQuery.isError, completenessQuery.data]);

  const opening = useMemo(() => {
    if (openingBalance.isError || !openingBalance.data) return unavailable<never>("Beginbalans");
    return available(openingBalance.data);
  }, [openingBalance.isError, openingBalance.data]);

  const statementsSource = useMemo(() => {
    if (statements.state.kind !== "ready") return unavailable<never>("Balans en winst-en-verliesrekening");
    return available(statements.state.result);
  }, [statements.state]);

  /**
   * Het tweede taxonomieniveau over beide overzichten heen. Alleen te bepalen
   * wanneer de motor een uitkomst gaf; faalt die, dan wordt hier niets beweerd.
   */
  const subgroupSections = useMemo<Source<readonly StatementGroupSections[]>>(() => {
    if (statements.state.kind !== "ready" || statements.state.result.ok !== true) {
      return unavailable("Groepsindeling");
    }
    const { balanceSheet, profitLoss } = statements.state.result;
    const groups = [
      ...balanceSheet.assetGroups,
      ...balanceSheet.liabilityEquityGroups,
      ...profitLoss.groups,
    ];
    return available(subgroupSectionsForGroups(groups, accounts));
  }, [statements.state, accounts]);

  const isPending =
    accountsQuery.isPending ||
    postingsQuery.isPending ||
    integrityQuery.isPending ||
    completenessQuery.isPending ||
    openingBalance.isPending ||
    statements.state.kind === "loading";

  const input: DiagnosticRunInput = {
    trialBalance,
    integrity,
    statements: statementsSource,
    openingBalance: opening,
    completeness,
    subgroupSections,
  };

  return { isPending, input };
}
