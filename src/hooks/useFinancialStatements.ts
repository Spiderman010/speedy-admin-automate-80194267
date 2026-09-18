import { useMemo } from "react";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useLedgerPostings } from "@/hooks/useLedgerPostings";
import { buildAccountReport, LedgerReportingError, type LedgerPeriod } from "@/lib/ledger-reporting";
import {
  buildFinancialStatements,
  movementOnPeriodStartFromRows,
  openingBalanceContributionFromRows,
  type FinancialStatementsResult,
} from "@/lib/financial-statements";

/**
 * Balans/W&V PR 4 — één datastroom voor beide jaarrekeningrapporten.
 *
 *   ledger_postings → useLedgerPostings
 *                   → buildAccountReport()   (rapportagekern, 6C-b7 PR 1)
 *                   → buildFinancialStatements()  (engine, PR 3)
 *                   → Balans / W&V
 *
 * Deze hook rekent zelf niets uit: hij haalt dezelfde rijen op die de proef- en
 * saldibalans gebruikt en geeft ze ongewijzigd door. De administratie is
 * verplicht — zonder `clientId` wordt er niets opgehaald en niets opgebouwd, zodat
 * er nooit cijfers van meerdere administraties door elkaar kunnen lopen.
 */

export type FinancialStatementsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string; source: "postings" | "accounts" | "reporting" }
  | { kind: "ready"; result: FinancialStatementsResult };

export interface UseFinancialStatementsOptions {
  clientId: string | undefined;
  period: LedgerPeriod;
  enabled?: boolean;
}

export function useFinancialStatements({ clientId, period, enabled = true }: UseFinancialStatementsOptions) {
  // Bewust ALLE rekeningen, ook inactieve: die kunnen saldo dragen én een
  // classificatie. Met dezelfde organisatiescope als de proef- en
  // saldibalans, zodat de cache wordt gedeeld in plaats van gedupliceerd en
  // een organisatiewissel de query opnieuw sleutelt.
  const { activeOrganizationId } = useActiveOrganization();
  const accountsQuery = useGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled,
  });
  const postingsQuery = useLedgerPostings({ clientId, period, enabled });

  const state = useMemo<FinancialStatementsState>(() => {
    if (!clientId) return { kind: "idle" };
    if (postingsQuery.isError) {
      const err = postingsQuery.error as { message?: string } | null;
      return { kind: "error", message: err?.message ?? "Onbekende fout", source: "postings" };
    }
    // Zonder rekeningschema is er geen classificatie en geen rekeningnummer:
    // dan zou het rapport gezaghebbend lijken zonder het te zijn.
    if (accountsQuery.isError) {
      const err = accountsQuery.error as { message?: string } | null;
      return { kind: "error", message: err?.message ?? "Onbekende fout", source: "accounts" };
    }
    if (accountsQuery.isPending || postingsQuery.isPending || !postingsQuery.data) return { kind: "loading" };

    try {
      const report = buildAccountReport({
        rows: postingsQuery.data,
        clientId,
        period,
        accounts: accountsQuery.data,
      });
      const result = buildFinancialStatements({
        report,
        period,
        accounts: accountsQuery.data ?? [],
        // Diagnose uit dezelfde rijen; verandert geen enkel bedrag.
        openingBalanceContribution: openingBalanceContributionFromRows(postingsQuery.data, period),
        movementOnPeriodStart: movementOnPeriodStartFromRows(postingsQuery.data, period),
      });
      return { kind: "ready", result };
    } catch (e) {
      return {
        kind: "error",
        message: e instanceof LedgerReportingError ? e.message : "Onbekende rapportagefout",
        source: "reporting",
      };
    }
  }, [
    clientId,
    period,
    postingsQuery.data,
    postingsQuery.isError,
    postingsQuery.error,
    postingsQuery.isPending,
    accountsQuery.data,
    accountsQuery.isError,
    accountsQuery.error,
    accountsQuery.isPending,
  ]);

  return {
    state,
    refetchPostings: postingsQuery.refetch,
    refetchAccounts: accountsQuery.refetch,
    /** Er zijn in het geheel geen grootboekmutaties in deze periode. */
    isEmpty: postingsQuery.data?.length === 0,
  };
}
