import { useMemo } from "react";
import { useClients } from "@/hooks/useClients";
import { useLedgerPostings } from "@/hooks/useLedgerPostings";
import { useDiagnosticSources } from "@/hooks/useDiagnosticSources";
import { yearPeriod } from "@/lib/ledger-reporting";
import { available, unavailable, runDiagnostics, type Source } from "@/lib/diagnostic-report";
import { useUnpostedSourceWork } from "@/hooks/useUnpostedSourceWork";
import { activityByBoekjaar, type UnpostedWorkItem, type YearCloseInput } from "@/lib/year-close-readiness";

/**
 * De bronnen voor de gereedheidscontrole — UITSLUITEND LEZEN.
 *
 * Er komt geen enkele query bij die de app niet al doet:
 *
 *   • de controle zelf is `useDiagnosticSources` over `yearPeriod(boekjaar)` —
 *     maar let op: NIET elke controle daarin is jaargebonden. Welke wel en
 *     welke niet staat in `CHECK_SCOPE` in `year-close-readiness.ts`;
 *   • het afsluitwatermerk zit al in `useClients` (dat `select("*")` doet);
 *   • de boekingen per boekjaar komen uit `useLedgerPostings({ clientId })`
 *     zónder periode — dezelfde cachesleutel die de tegenboekingscontrole uit
 *     v1.1 al gebruikt, dus react-query deelt hem.
 *
 * BOEKJAAR = KALENDERJAAR, want dat is wat het product doet: elke schrijver
 * leidt `boekjaar` af als `EXTRACT(YEAR FROM <datum>)` en er bestaat nergens
 * een begin van een boekjaar. `yearPeriod()` is daarom de juiste periode, en
 * geen benadering.
 */

export interface UseYearCloseSourcesOptions {
  clientId: string | undefined;
  fiscalYear: number;
  organizationId: string | undefined;
  enabled?: boolean;
}

export interface YearCloseSourcesState {
  isPending: boolean;
  input: Omit<YearCloseInput, "clientId" | "fiscalYear"> | null;
}

export function useYearCloseSources({
  clientId,
  fiscalYear,
  organizationId,
  enabled = true,
}: UseYearCloseSourcesOptions): YearCloseSourcesState {
  const period = useMemo(() => yearPeriod(fiscalYear), [fiscalYear]);

  const diagnostics = useDiagnosticSources({ clientId, period, organizationId, enabled });
  const clientsQuery = useClients(organizationId, enabled);
  // Zonder periode: alle jaren, om te zien welke boekjaren nog open staan.
  const allPostings = useLedgerPostings({ clientId, enabled });
  const unposted = useUnpostedSourceWork(clientId, enabled);

  const closedThrough = useMemo<Source<number | null>>(() => {
    if (clientsQuery.isError || !clientsQuery.data) return unavailable("Administratiegegevens");
    const client = clientsQuery.data.find((c) => c.id === clientId);
    if (!client) return unavailable("Administratiegegevens");
    return available(client.afgesloten_boekjaar ?? null);
  }, [clientsQuery.isError, clientsQuery.data, clientId]);

  const activityByYear = useMemo<Source<ReadonlyMap<number, number>>>(() => {
    if (allPostings.isError || !allPostings.data) return unavailable("Grootboekmutaties (alle jaren)");
    return available(activityByBoekjaar(allPostings.data));
  }, [allPostings.isError, allPostings.data]);

  const unpostedWork = useMemo<Source<readonly UnpostedWorkItem[]>>(() => {
    if (unposted.isError || !unposted.data) return unavailable("Openstaand bronwerk");
    return available(unposted.data);
  }, [unposted.isError, unposted.data]);

  const isPending =
    diagnostics.isPending || clientsQuery.isPending || allPostings.isPending || unposted.isPending;

  const input = useMemo(() => {
    if (!clientId) return null;
    return {
      diagnostics: runDiagnostics(diagnostics.input),
      closedThrough,
      activityByYear,
      unpostedWork,
    };
  }, [clientId, diagnostics.input, closedThrough, activityByYear, unpostedWork]);

  return { isPending, input };
}
