import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger,
} from "@/components/ui/select";
import { AlertTriangle, ArrowLeft, BookOpen } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { FilterChip } from "@/components/FilterChip";
import { GrootboekSaldiTable } from "@/components/grootboek/GrootboekSaldiTable";
import { GrootboekAccountMutations } from "@/components/grootboek/GrootboekAccountMutations";
import { LedgerCompletenessNotice } from "@/components/grootboek/LedgerCompletenessNotice";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useLedgerPostings } from "@/hooks/useLedgerPostings";
import { useLedgerCompleteness, useOpeningBalanceCompleteness } from "@/hooks/useLedgerCompleteness";
import {
  buildAccountReport,
  buildRunningBalance,
  LedgerReportingError,
  type LedgerAccountReport,
  type LedgerRunningBalance,
} from "@/lib/ledger-reporting";
import {
  periodFromSelection,
  periodLabel,
  recentYears,
  type PeriodSelection,
} from "@/lib/grootboek-saldi-utils";

/**
 * Fase 6C-b7 PR 2 — het eerste echte grootboek (/grootboek/saldi en
 * /grootboek/saldi/:accountId).
 *
 * Enige boekhoudbron: ledger_postings via useLedgerPostings; alle rekenwerk
 * via ledger-reporting.ts (PR 1). Deze pagina telt zelf niets op en leest
 * geen journal_entries, factuur- of banktotalen. De volledigheidsmelding is
 * metadata ernaast, nooit een onderdeel van de cijfers.
 */

export const SELF_CHECK_MESSAGE =
  "Het grootboekrapport kan niet veilig worden opgebouwd omdat de boekingscontrole niet sluit.";
export const EMPTY_LEDGER_MESSAGE = "Nog geen geboekte grootboekmutaties voor deze periode.";

function ReportSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Grootboek laden…</span>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-16 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24 shrink-0" />
          <Skeleton className="h-4 w-24 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export default function GrootboekSaldi() {
  const { accountId } = useParams<{ accountId?: string }>();
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;

  const [selection, setSelection] = useState<PeriodSelection>({ kind: "year", year: new Date().getFullYear() });
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const period = useMemo(() => periodFromSelection(selection), [selection]);

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  // Bewust ALLE rekeningen, ook inactieve: die kunnen saldo dragen.
  const { data: accounts } = useGrootboekrekeningen({ organizationId: activeOrganizationId ?? undefined, enabled: orgEnabled });
  // Alleen om een rekening bij naam te kunnen tonen in het boekingspaneel;
  // geen rekenwerk, geen classificatie.
  const accountsById = useMemo(
    () => new Map((accounts ?? []).map((a) => [a.id, { id: a.id, nummer: a.nummer, omschrijving: a.omschrijving }])),
    [accounts],
  );
  const postingsQuery = useLedgerPostings({ clientId, period, enabled: orgEnabled });
  const completenessQuery = useLedgerCompleteness(clientId);
  // 6C-b8 PR 3: beginbalansstatus voor het rapportjaar — metadata, geen cijfers.
  const openingBalanceCompleteness = useOpeningBalanceCompleteness(clientId, period);

  // Rapport bouwen: een LedgerReportingError (valuta/administratie) wordt als
  // blokkerende fout getoond, nooit als lege of halve cijfers.
  const built = useMemo<
    { kind: "ok"; report: LedgerAccountReport } | { kind: "error"; message: string } | null
  >(() => {
    if (!clientId || !postingsQuery.data) return null;
    try {
      return { kind: "ok", report: buildAccountReport({ rows: postingsQuery.data, clientId, period, accounts }) };
    } catch (e) {
      return { kind: "error", message: e instanceof LedgerReportingError ? e.message : "Onbekende rapportagefout" };
    }
  }, [clientId, postingsQuery.data, period, accounts]);

  const running = useMemo<LedgerRunningBalance | null>(() => {
    if (!accountId || !clientId || !postingsQuery.data || built?.kind !== "ok" || !built.report.ok) return null;
    return buildRunningBalance({ rows: postingsQuery.data, clientId, accountId, period, accounts });
  }, [accountId, clientId, postingsQuery.data, built, period, accounts]);

  const selectedClient = clients?.find((c) => c.id === selectedClientId);
  const years = recentYears();

  const applyRange = () => {
    if (rangeFrom && rangeTo && rangeFrom <= rangeTo) {
      setSelection({ kind: "range", from: rangeFrom, toInclusive: rangeTo });
    }
  };

  const renderBody = () => {
    if (postingsQuery.isError) {
      const err = postingsQuery.error as { message?: string } | null;
      return (
        <Alert variant="destructive" data-testid="ledger-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Grootboek laden is mislukt</AlertTitle>
          <AlertDescription>
            <p>{err?.message ?? "Onbekende fout"}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => postingsQuery.refetch()}>
              Opnieuw proberen
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    if (postingsQuery.isPending || !built) return <ReportSkeleton />;
    if (built.kind === "error") {
      return (
        <Alert variant="destructive" data-testid="ledger-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Grootboek kan niet worden opgebouwd</AlertTitle>
          <AlertDescription>{built.message}</AlertDescription>
        </Alert>
      );
    }
    const report = built.report;
    if (report.ok === false) {
      return (
        <Alert variant="destructive" data-testid="ledger-self-check-failed">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Boekingscontrole sluit niet</AlertTitle>
          <AlertDescription>
            <p>{SELF_CHECK_MESSAGE}</p>
            <ul className="mt-2 list-disc pl-5 text-xs">
              {report.failures.map((f, i) => (
                <li key={i}>
                  {f.kind === "group_unbalanced" && `Boekingsgroep ${f.postingGroupId} is niet in balans.`}
                  {f.kind === "period_unbalanced" && "Debet en credit van de periode zijn ongelijk."}
                  {f.kind === "opening_unbalanced" && "De beginsaldi tellen niet op tot nul."}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      );
    }
    if (accountId) {
      if (!running) return <ReportSkeleton />;
      return (
        <GrootboekAccountMutations
          running={running}
          periodLabel={periodLabel(selection)}
          clientId={clientId!}
          accountsById={accountsById}
        />
      );
    }
    if (report.totals.rowCount === 0) {
      return <EmptyState icon={BookOpen} message={EMPTY_LEDGER_MESSAGE} />;
    }
    return <GrootboekSaldiTable rollups={report.rollups} totals={report.totals} />;
  };

  return (
    <>
      <PageHeader
        title={accountId ? "Grootboekrekening" : "Grootboeksaldi"}
        description={
          accountId
            ? "Mutaties en lopend saldo van één rekening, uit het grootboek."
            : "Saldilijst per rekening, uitsluitend uit geboekte grootboekmutaties. Debet-positief: een creditsaldo is negatief."
        }
      >
        {accountId && (
          <Button size="sm" variant="outline" asChild>
            <Link to="/grootboek/saldi">
              <ArrowLeft className="mr-2 h-4 w-4" />Naar saldilijst
            </Link>
          </Button>
        )}
      </PageHeader>

      {/* Eén compacte toolbarband: administratie en periode, daaronder het datumbereik. */}
      <div className="mb-3 divide-y rounded-md border bg-card">
        <div className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
          <Select value={selectedClientId} onValueChange={(v) => setSelectedClientId(v)}>
            <SelectTrigger className="h-8 w-full text-[13px] sm:w-60" aria-label="Administratie">
              <span className="truncate">{selectedClient ? selectedClient.name : "Alle administraties"}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle administraties</SelectItem>
              {clients?.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap items-center gap-1.5" data-testid="period-filters">
            <span className="mr-0.5 shrink-0 text-xs font-medium text-muted-foreground">Periode</span>
            {years.map((y) => (
              <FilterChip
                key={y}
                label={String(y)}
                active={selection.kind === "year" && selection.year === y}
                onClick={() => setSelection({ kind: "year", year: y })}
              />
            ))}
            <FilterChip label="Alle jaren" active={selection.kind === "all"} onClick={() => setSelection({ kind: "all" })} />
          </div>
          <span className="text-xs text-muted-foreground sm:ml-auto" data-testid="period-label">
            Geselecteerd: {periodLabel(selection)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 px-3 py-2 sm:flex sm:flex-wrap sm:items-center sm:gap-x-3">
          <div className="grid min-w-0 gap-1 sm:flex sm:items-center sm:gap-1.5">
            <Label htmlFor="saldi-from" className="text-xs font-medium text-muted-foreground">Van</Label>
            <Input id="saldi-from" type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} className="h-8 min-w-0 text-[13px] sm:w-40" />
          </div>
          <div className="grid min-w-0 gap-1 sm:flex sm:items-center sm:gap-1.5">
            <Label htmlFor="saldi-to" className="text-xs font-medium text-muted-foreground">Tot en met</Label>
            <Input id="saldi-to" type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} className="h-8 min-w-0 text-[13px] sm:w-40" />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="col-span-2 h-8"
            onClick={applyRange}
            disabled={!rangeFrom || !rangeTo || rangeFrom > rangeTo}
          >
            Periode toepassen
          </Button>
        </div>
      </div>

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om het grootboek te bekijken." />
      ) : (
        <div className="space-y-3">
          <LedgerCompletenessNotice
            completeness={completenessQuery.data}
            isLoading={completenessQuery.isPending}
            isError={completenessQuery.isError}
            openingBalance={openingBalanceCompleteness.data}
            openingBalanceLoading={openingBalanceCompleteness.isPending}
            openingBalanceError={openingBalanceCompleteness.isError}
          />
          <Card className="overflow-hidden rounded-md shadow-none">
            <CardContent className="p-3 sm:p-4">{renderBody()}</CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
