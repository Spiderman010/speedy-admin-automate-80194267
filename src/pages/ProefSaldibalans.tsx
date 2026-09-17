import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger,
} from "@/components/ui/select";
import { AlertTriangle, Download, FileBarChart } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { FilterChip } from "@/components/FilterChip";
import { ProefSaldibalansTable } from "@/components/overzichten/ProefSaldibalansTable";
import { LedgerCompletenessNotice } from "@/components/grootboek/LedgerCompletenessNotice";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useLedgerPostings } from "@/hooks/useLedgerPostings";
import { useLedgerCompleteness } from "@/hooks/useLedgerCompleteness";
import {
  buildAccountReport,
  LedgerReportingError,
  type LedgerAccountReport,
} from "@/lib/ledger-reporting";
import {
  CATEGORY_LABELS,
  periodFromSelection,
  periodLabel,
  recentYears,
  type PeriodSelection,
} from "@/lib/grootboek-saldi-utils";
import {
  buildTrialBalance,
  trialBalanceCsvFilename,
  trialBalanceToCsv,
  type TrialBalance,
} from "@/lib/proef-saldibalans";

/**
 * Fase 6C-b7 PR 3 — proef- en saldibalans (/overzichten/proef-saldibalans).
 *
 * Enige boekhoudbron: ledger_postings via useLedgerPostings; alle bedragen via
 * buildAccountReport() (PR 1) en daarna alleen de presentatiesplitsing van
 * buildTrialBalance(). Deze pagina telt zelf niets op en leest geen
 * journal_entries, factuur- of banktotalen.
 *
 * Fail-closed: faalt de zelfcontrole van de kern OF sluiten de zes
 * kolomtotalen niet paarsgewijs, dan verschijnen er geen cijfers en is de
 * export uitgeschakeld. Er wordt nooit teruggevallen op brondocumenttotalen.
 */

export const SELF_CHECK_MESSAGE =
  "Het grootboekrapport kan niet veilig worden opgebouwd omdat de boekingscontrole niet sluit.";
export const EMPTY_LEDGER_MESSAGE = "Nog geen geboekte grootboekmutaties voor deze periode.";

function ReportSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Proef- en saldibalans laden…</span>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-16 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-20 shrink-0" />
          <Skeleton className="h-4 w-20 shrink-0" />
          <Skeleton className="h-4 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export default function ProefSaldibalans() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;

  const [selection, setSelection] = useState<PeriodSelection>({ kind: "year", year: new Date().getFullYear() });
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [toonNul, setToonNul] = useState(false);
  const period = useMemo(() => periodFromSelection(selection), [selection]);

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  // Bewust ALLE rekeningen, ook inactieve: die kunnen saldo dragen.
  const accountsQuery = useGrootboekrekeningen({ organizationId: activeOrganizationId ?? undefined, enabled: orgEnabled });
  const accounts = accountsQuery.data;
  const postingsQuery = useLedgerPostings({ clientId, period, enabled: orgEnabled });
  const completenessQuery = useLedgerCompleteness(clientId);

  const built = useMemo<
    { kind: "ok"; report: LedgerAccountReport } | { kind: "error"; message: string } | null
  >(() => {
    if (!clientId || !postingsQuery.data) return null;
    try {
      // includeZeroAccounts op de kern blijft true: het weglaten van nulrijen
      // is een beslissing van dit rapport, niet van de kern.
      return {
        kind: "ok",
        report: buildAccountReport({ rows: postingsQuery.data, clientId, period, accounts }),
      };
    } catch (e) {
      return { kind: "error", message: e instanceof LedgerReportingError ? e.message : "Onbekende rapportagefout" };
    }
  }, [clientId, postingsQuery.data, period, accounts]);

  const balans = useMemo<TrialBalance | null>(() => {
    if (built?.kind !== "ok") return null;
    return buildTrialBalance({
      report: built.report,
      accounts,
      clientId,
      includeZeroAccounts: toonNul,
    });
  }, [built, accounts, clientId, toonNul]);

  const selectedClient = clients?.find((c) => c.id === selectedClientId);
  const years = recentYears();

  // De exportpoort moet PRECIES dezelfde toestand volgen als het scherm.
  // React Query houdt `data` vast wanneer een achtergrondverversing faalt, dus
  // `balans` kan best geldig zijn terwijl de pagina een laadfout toont — zonder
  // `isError` hierin zou de knop dan de cijfers van vóór de fout exporteren.
  // Een leeg rapport levert niets exporteerbaars op en telt ook als ongeldig.
  const geldig =
    !postingsQuery.isError &&
    !accountsQuery.isError &&
    !accountsQuery.isPending &&
    built?.kind === "ok" &&
    balans?.ok === true &&
    balans.rows.length > 0;

  const applyRange = () => {
    if (rangeFrom && rangeTo && rangeFrom <= rangeTo) {
      setSelection({ kind: "range", from: rangeFrom, toInclusive: rangeTo });
    }
  };

  const exporteer = () => {
    // Dezelfde poort als de knop, zodat een toetsenbord- of scriptpad er niet
    // omheen kan wanneer de knop zelf al uit staat.
    if (!geldig || !balans || balans.ok !== true) return;
    const inhoud = trialBalanceToCsv({
      rows: balans.rows,
      totals: balans.totals,
      categoryLabel: (c) => CATEGORY_LABELS[c],
    });
    const bestand = trialBalanceCsvFilename(selectedClient?.name ?? "administratie", periodLabel(selection));
    // Expliciete escape, geen onzichtbaar teken in de bron: een BOM die bij
    // een bewerking wegvalt zou Excel de CSV als Latin-1 laten openen.
    const bom = "\uFEFF";
    const blob = new Blob([bom + inhoud], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = bestand;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderBody = () => {
    if (postingsQuery.isError) {
      const err = postingsQuery.error as { message?: string } | null;
      return (
        <Alert variant="destructive" data-testid="psb-error">
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
    // Zonder rekeningschema is elke rij "Onbekende rekening" en elk
    // rekeningnummer leeg: een rapport dat er gezaghebbend uitziet en het niet
    // is. Dat weigeren we liever dan het te tonen.
    if (accountsQuery.isError) {
      return (
        <Alert variant="destructive" data-testid="psb-accounts-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Rekeningschema laden is mislukt</AlertTitle>
          <AlertDescription>
            <p>
              Zonder het rekeningschema zijn de rekeningnummers en categorieën niet te bepalen.
              Het rapport wordt daarom niet getoond.
            </p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => accountsQuery.refetch()}>
              Opnieuw proberen
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    if (accountsQuery.isPending) return <ReportSkeleton />;
    // Let op de volgorde: een rapportagefout moet VOOR de skeletoncontrole
    // komen. Bij een fout is `balans` null, dus een gecombineerde
    // `!built || !balans`-poort zou een harde weigering als eeuwig laden tonen.
    if (built?.kind === "error") {
      return (
        <Alert variant="destructive" data-testid="psb-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Rapport kan niet worden opgebouwd</AlertTitle>
          <AlertDescription>{built.message}</AlertDescription>
        </Alert>
      );
    }
    if (postingsQuery.isPending || !built || !balans) return <ReportSkeleton />;
    if (balans.ok === false) {
      return (
        <Alert variant="destructive" data-testid="psb-self-check-failed">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Boekingscontrole sluit niet</AlertTitle>
          <AlertDescription>
            <p>{SELF_CHECK_MESSAGE}</p>
            <ul className="mt-2 list-disc pl-5 text-xs">
              {balans.failures.map((f, i) => (
                <li key={i}>
                  {f.kind === "kernel" && "De zelfcontrole van de rapportagekern is niet doorstaan."}
                  {f.kind === "opening_unbalanced" && "De beginsaldi debet en credit zijn ongelijk."}
                  {f.kind === "period_unbalanced" && "De periodemutaties debet en credit zijn ongelijk."}
                  {f.kind === "closing_unbalanced" && "De eindsaldi debet en credit zijn ongelijk."}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      );
    }
    // De lege staat gaat NIET voor wanneer de gebruiker juist om het volledige
    // rekeningschema heeft gevraagd en dat er ook is.
    if (built.report.ok === true && built.report.totals.rowCount === 0 && balans.rows.length === 0) {
      return <EmptyState icon={FileBarChart} message={EMPTY_LEDGER_MESSAGE} />;
    }
    if (balans.rows.length === 0) {
      return (
        <EmptyState
          icon={FileBarChart}
          message="Geen rekeningen met saldo of beweging in deze periode. Zet “Toon nulrekeningen” aan om het volledige rekeningschema te zien."
        />
      );
    }
    return <ProefSaldibalansTable rows={balans.rows} totals={balans.totals} />;
  };

  return (
    <>
      <PageHeader
        title="Proef- en saldibalans"
        description="Beginsaldo, periodemutaties en eindsaldo per grootboekrekening, uitsluitend uit geboekte grootboekmutaties. Bedragen in euro."
      >
        <Button type="button" variant="outline" onClick={exporteer} disabled={!geldig} data-testid="psb-export">
          <Download className="mr-2 h-4 w-4" />CSV exporteren
        </Button>
      </PageHeader>

      <div className="mb-4 space-y-3 rounded-lg border bg-card p-3 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Select value={selectedClientId} onValueChange={(v) => setSelectedClientId(v)}>
            <SelectTrigger className="w-full sm:w-64" aria-label="Administratie">
              <span className="truncate">{selectedClient ? selectedClient.name : "Alle administraties"}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle administraties</SelectItem>
              {clients?.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap items-center gap-1.5" data-testid="psb-period-filters">
            <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground">Periode</span>
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
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="psb-from" className="text-xs">Van</Label>
            <Input id="psb-from" type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} className="h-8 w-40" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="psb-to" className="text-xs">Tot en met</Label>
            <Input id="psb-to" type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} className="h-8 w-40" />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={applyRange} disabled={!rangeFrom || !rangeTo || rangeFrom > rangeTo}>
            Periode toepassen
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="psb-period-label">
            Geselecteerd: {periodLabel(selection)}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Switch id="psb-toon-nul" checked={toonNul} onCheckedChange={setToonNul} />
            <Label htmlFor="psb-toon-nul" className="text-xs">Toon nulrekeningen</Label>
          </div>
        </div>
      </div>

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om de proef- en saldibalans te bekijken." />
      ) : (
        <div className="space-y-4">
          <LedgerCompletenessNotice
            completeness={completenessQuery.data}
            isLoading={completenessQuery.isPending}
            isError={completenessQuery.isError}
          />
          <Card>
            <CardContent className="p-4 sm:p-6">{renderBody()}</CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
