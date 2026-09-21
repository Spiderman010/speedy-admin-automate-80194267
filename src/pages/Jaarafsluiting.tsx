import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { CalendarCheck, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { AccountingAmount } from "@/components/platform/AccountingAmount";
import { AccountingNotice } from "@/components/platform/AccountingNotice";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useYearCloseSources } from "@/hooks/useYearCloseSources";
import { recentYears } from "@/lib/grootboek-saldi-utils";
import type { DiagnosticSeverity } from "@/lib/accounting-diagnostics";
import {
  READINESS_SEVERITY_ORDER,
  evaluateYearClose,
  readinessChecksBySeverity,
  type ReadinessCheck,
  type YearCloseReadiness,
  type YearCloseStatus,
} from "@/lib/year-close-readiness";

/**
 * Jaarafsluiting — gereedheid (PR 1).
 *
 * ALLEEN LEZEN. Er wordt hier geen boekjaar afgesloten, geen resultaat geboekt
 * en geen beginbalans doorgerold; die motor bestaat nog niet. Dit scherm
 * beantwoordt één vraag — *kan dit boekjaar verantwoord worden afgesloten?* —
 * en doet dat met de oordelen die er al zijn.
 *
 * DEZE PAGINA REKENT NIET. Elke uitspraak komt uit `evaluateYearClose()`, dat
 * op zijn beurt de bestaande controle over dit boekjaar samenvat en er alleen
 * de boekjaar-specifieke vragen bij zet.
 *
 * De uitkomst is een MOMENTOPNAME: bij de klik wordt zij vastgezet en beweegt
 * daarna niet meer mee met de cache.
 */

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  ok: "Akkoord",
  warning: "Waarschuwing",
  error: "Blokkade",
};

const SEVERITY_HEADING: Record<DiagnosticSeverity, string> = {
  error: "Blokkades",
  warning: "Waarschuwingen",
  ok: "Akkoord",
};

const SEVERITY_VARIANT: Record<DiagnosticSeverity, "destructive" | "warning" | "secondary"> = {
  error: "destructive",
  warning: "warning",
  ok: "secondary",
};

/** De vier statussen in woorden. Geen tweede ernstladder: een samenvatting. */
const STATUS_PRESENTATION: Record<
  YearCloseStatus,
  { label: string; severity: DiagnosticSeverity; uitleg: string }
> = {
  ready: {
    label: "Gereed voor afsluiten",
    severity: "ok",
    uitleg: "Elke controle is doorstaan. Er staat niets open dat het afsluiten in de weg zit.",
  },
  warning: {
    label: "Nog niet gereed",
    severity: "warning",
    uitleg:
      "Er staat open werk. Dit product kent geen regel die zegt dat een boekjaar met open werk toch mag worden afgesloten, dus dat wordt hier niet beweerd.",
  },
  blocked: {
    label: "Afsluiten geblokkeerd",
    severity: "error",
    uitleg: "Er is iets aan de hand dat afsluiten onverantwoord maakt. Los dat eerst op.",
  },
  incomplete: {
    label: "Controle niet volledig uitgevoerd",
    severity: "error",
    uitleg:
      "Niet elke bron kon worden gelezen. Dit is een technische storing en geen boekhoudkundige bevinding — over wat hier niet is gecontroleerd, is dus niets vastgesteld.",
  },
};

function Bevinding({ check }: { check: ReadinessCheck }) {
  return (
    <li
      className="rounded-md border px-3 py-2"
      data-testid="jaar-bevinding"
      data-check={check.id}
      data-severity={check.severity}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">{check.title}</span>
        <Badge variant={SEVERITY_VARIANT[check.severity]} className="font-normal">
          {SEVERITY_LABEL[check.severity]}
        </Badge>
        {check.count !== undefined && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{check.count}×</span>
        )}
        {check.amountCents !== undefined && (
          <AccountingAmount cents={check.amountCents} className="ml-auto text-sm" />
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{check.summary}</p>
      {check.drilldown && (
        <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-xs" asChild>
          <Link to={check.drilldown.to} data-testid="jaar-drilldown">
            {check.drilldown.label}
            <ChevronRight className="ml-0.5 h-3 w-3" aria-hidden="true" />
          </Link>
        </Button>
      )}
    </li>
  );
}

function Telling({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="rounded-md border px-3 py-2" data-testid={testId}>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Rapport({ readiness, clientName }: { readiness: YearCloseReadiness; clientName: string }) {
  const presentatie = STATUS_PRESENTATION[readiness.status];
  return (
    <div className="space-y-4" data-testid="jaar-rapport">
      <div>
        <h2 className="text-sm font-semibold">Jaarafsluiting {readiness.fiscalYear}</h2>
        <p className="text-sm text-muted-foreground" data-testid="jaar-context">{clientName}</p>
      </div>

      <AccountingNotice
        severity={presentatie.severity === "error" ? "blocking" : presentatie.severity === "warning" ? "warning" : "info"}
        title={presentatie.label}
        data-testid="jaar-status"
        data-status={readiness.status}
      >
        <p>{presentatie.uitleg}</p>
        {readiness.unavailable.length > 0 && (
          <p className="mt-1">Niet geladen: {readiness.unavailable.join(", ")}.</p>
        )}
      </AccountingNotice>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="jaar-telling">
        <Telling label="Uitgevoerd" value={readiness.summary.executed} testId="jaar-uitgevoerd" />
        <Telling label="Akkoord" value={readiness.summary.passed} testId="jaar-akkoord" />
        <Telling label="Waarschuwingen" value={readiness.summary.warnings} testId="jaar-waarschuwingen" />
        <Telling label="Blokkades" value={readiness.summary.blocking} testId="jaar-blokkades" />
      </dl>

      {READINESS_SEVERITY_ORDER.map((severity) => {
        const groep = readinessChecksBySeverity(readiness.checks, severity);
        if (groep.length === 0) return null;
        return (
          <section key={severity} aria-labelledby={`jaar-${severity}`} data-testid={`jaar-groep-${severity}`}>
            <h3 id={`jaar-${severity}`} className="mb-2 text-sm font-semibold">
              {SEVERITY_HEADING[severity]} ({groep.length})
            </h3>
            <ul className="space-y-2">
              {groep.map((check) => <Bevinding key={check.id} check={check} />)}
            </ul>
          </section>
        );
      })}

      {readiness.administrationWide.length > 0 && (
        <section aria-labelledby="jaar-breed" data-testid="jaar-groep-administratiebreed">
          <h3 id="jaar-breed" className="mb-1 text-sm font-semibold">
            Administratiebreed ({readiness.administrationWide.length})
          </h3>
          <p className="mb-2 text-xs text-muted-foreground" data-testid="jaar-breed-uitleg">
            Deze bevindingen gelden voor de hele administratie en dragen geen boekjaar. Zij zijn
            daarom niet meegewogen in de gereedheid van {readiness.fiscalYear} — een bevinding uit een
            ander boekjaar bewijst niets over dit boekjaar — maar ze staan hier wel, want verzwijgen
            zou erger zijn.
          </p>
          <ul className="space-y-2">
            {readiness.administrationWide.map((check) => <Bevinding key={check.id} check={check} />)}
          </ul>
        </section>
      )}

      {/* Geen knop die niets doet: wát er nog moet gebeuren voordat afsluiten
          kan, staat er gewoon als zin. */}
      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" data-testid="jaar-nog-niet">
        Definitief afsluiten kan nog niet: de afsluitmotor — het resultaat naar het eigen vermogen en de
        beginbalans van het volgende boekjaar — bestaat nog niet. Deze pagina stelt alleen de gereedheid vast.
      </p>
    </div>
  );
}

export default function Jaarafsluiting() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;

  const [fiscalYear, setFiscalYear] = useState(() => new Date().getFullYear() - 1);

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const selectedClient = clients?.find((c) => c.id === selectedClientId);

  const sources = useYearCloseSources({
    clientId,
    fiscalYear,
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled && hasSpecificClient,
  });

  const [snapshot, setSnapshot] = useState<{ readiness: YearCloseReadiness; clientName: string } | null>(null);

  const jaren = useMemo(() => recentYears(), []);

  const voerUit = () => {
    if (!clientId || !sources.input) return;
    setSnapshot({
      readiness: evaluateYearClose({ ...sources.input, clientId, fiscalYear }),
      clientName: selectedClient?.name ?? "—",
    });
  };

  return (
    <>
      <PageHeader
        title="Jaarafsluiting"
        description="Vaststellen of een boekjaar verantwoord kan worden afgesloten. De controle draait pas wanneer u erom vraagt en wijzigt niets."
      />

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om de gereedheid te bepalen." />
      ) : (
        <div className="space-y-4">
          <section aria-label="Administratie en boekjaar" className="rounded-lg border bg-card p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <CalendarCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                <SelectTrigger className="h-9 w-full min-w-0 sm:w-56" aria-label="Administratie">
                  <span className="truncate">{selectedClient ? selectedClient.name : "Alle administraties"}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle administraties</SelectItem>
                  {clients?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>

              <Select value={String(fiscalYear)} onValueChange={(v) => setFiscalYear(Number(v))}>
                <SelectTrigger className="h-9 w-full min-w-0 sm:w-40" aria-label="Boekjaar">
                  <span className="truncate">{fiscalYear}</span>
                </SelectTrigger>
                <SelectContent>
                  {jaren.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>

              <Button
                type="button"
                className="ml-auto h-9"
                onClick={voerUit}
                disabled={sources.isPending || !sources.input}
                data-testid="jaar-uitvoeren"
              >
                {sources.isPending ? "Bronnen laden…" : "Gereedheid controleren"}
              </Button>
            </div>
          </section>

          <Card>
            <CardContent className="p-4 sm:p-6">
              {snapshot === null ? (
                <EmptyState
                  icon={CalendarCheck}
                  message="Er is nog geen gereedheidscontrole uitgevoerd. Kies een administratie en boekjaar en start de controle."
                />
              ) : (
                <Rapport readiness={snapshot.readiness} clientName={snapshot.clientName} />
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Deze pagina wijzigt niets. Alle uitspraken komen uit opgeslagen grootboekmutaties en de bestaande
            boekhoudregels; de boekingsfunctie in de database blijft de autoriteit.
          </p>
        </div>
      )}
    </>
  );
}
