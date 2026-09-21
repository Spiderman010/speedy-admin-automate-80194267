import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { ChevronRight, ClipboardCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { AccountingAmount } from "@/components/platform/AccountingAmount";
import { AccountingNotice } from "@/components/platform/AccountingNotice";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useDiagnosticSources } from "@/hooks/useDiagnosticSources";
import { periodFromSelection, periodLabel, recentYears, type PeriodSelection } from "@/lib/grootboek-saldi-utils";
import type { DiagnosticSeverity } from "@/lib/accounting-diagnostics";
import {
  DIAGNOSTIC_SEVERITY_ORDER,
  checksBySeverity,
  runDiagnostics,
  type DiagnosticCheck,
  type DiagnosticRun,
} from "@/lib/diagnostic-report";

/**
 * Controle administratie — het controlerapport van één administratie over één
 * periode.
 *
 * ALLEEN LEZEN. Geen mutatie, geen RPC, geen statuswijziging, geen
 * achtergrondtaak. De gebruiker start de controle zelf; er draait niets
 * vanzelf behalve het laden van de bronnen.
 *
 * DEZE PAGINA REKENT NIET. Elke uitspraak komt uit `runDiagnostics()`, dat op
 * zijn beurt alleen bestaande oordelen samenvat — de kern, de kolommenbalans,
 * de integriteitscontrole, de jaarrekeningmotor, de volledigheidslagen. Hier
 * wordt alleen getoond wat daaruit komt.
 *
 * De uitkomst is een MOMENTOPNAME: bij de klik wordt het rapport vastgezet, en
 * het verandert daarna niet meer mee met de cache. Een controle die onder je
 * handen verandert, is geen controle.
 */

/** De woorden van dit scherm bovenop de ene ernstladder — geen tweede indeling. */
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

function Bevinding({ check }: { check: DiagnosticCheck }) {
  return (
    <li
      className="rounded-md border px-3 py-2"
      data-testid="controle-bevinding"
      data-check={check.id}
      data-severity={check.severity}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">{check.title}</span>
        <Badge variant={SEVERITY_VARIANT[check.severity]} className="font-normal">
          {SEVERITY_LABEL[check.severity]}
        </Badge>
        {check.count !== undefined && (
          <span className="font-mono text-xs tabular-nums text-muted-foreground" data-testid="controle-aantal">
            {check.count}×
          </span>
        )}
        {check.amountCents !== undefined && (
          <AccountingAmount
            cents={check.amountCents}
            className="ml-auto text-sm"
            data-testid="controle-bedrag"
          />
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{check.summary}</p>
      {check.drilldown && (
        <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-xs" asChild>
          <Link to={check.drilldown.to} data-testid="controle-drilldown">
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

function Rapport({ run, kop }: { run: DiagnosticRun; kop: string }) {
  return (
    <div className="space-y-4" data-testid="controle-rapport">
      <div>
        <h2 className="text-sm font-semibold">Controle administratie</h2>
        <p className="text-sm text-muted-foreground" data-testid="controle-context">{kop}</p>
      </div>

      {/* Een onvolledige controle mag nooit als "alles akkoord" lezen. Daarom
          staat deze melding BOVEN de telling, niet eronder. */}
      {run.ok === false && (
        <AccountingNotice
          severity="blocking"
          title="Controle kon niet volledig worden uitgevoerd"
          data-testid="controle-onvolledig"
        >
          <p>
            De volgende bronnen konden niet worden geladen: {run.unavailable.join(", ")}. Dit is een
            technische storing, geen boekhoudkundige bevinding — over wat hier niet is gecontroleerd,
            is dus niets vastgesteld.
          </p>
        </AccountingNotice>
      )}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="controle-telling">
        <Telling label="Uitgevoerd" value={run.summary.executed} testId="controle-uitgevoerd" />
        <Telling label="Akkoord" value={run.summary.passed} testId="controle-akkoord" />
        <Telling label="Waarschuwingen" value={run.summary.warnings} testId="controle-waarschuwingen" />
        <Telling label="Blokkades" value={run.summary.blocking} testId="controle-blokkades" />
      </dl>

      {run.ok === true && run.summary.warnings === 0 && run.summary.blocking === 0 && (
        <AccountingNotice severity="info" title="Alles akkoord" data-testid="controle-alles-akkoord">
          Alle {run.summary.executed} controles zijn doorstaan voor deze administratie en periode.
        </AccountingNotice>
      )}

      {DIAGNOSTIC_SEVERITY_ORDER.map((severity) => {
        const groep = checksBySeverity(run.checks, severity);
        if (groep.length === 0) return null;
        return (
          <section key={severity} aria-labelledby={`controle-${severity}`} data-testid={`controle-groep-${severity}`}>
            <h3 id={`controle-${severity}`} className="mb-2 text-sm font-semibold">
              {SEVERITY_HEADING[severity]} ({groep.length})
            </h3>
            <ul className="space-y-2">
              {groep.map((check) => <Bevinding key={check.id} check={check} />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export default function Controle() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;

  const [selection, setSelection] = useState<PeriodSelection>({ kind: "year", year: new Date().getFullYear() });
  const period = useMemo(() => periodFromSelection(selection), [selection]);

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const selectedClient = clients?.find((c) => c.id === selectedClientId);

  const sources = useDiagnosticSources({
    clientId,
    period,
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled && hasSpecificClient,
  });

  /**
   * De vastgezette uitkomst. `null` = er is nog geen controle gedraaid; het
   * scherm zegt dan niets over de boekhouding, want er is niets vastgesteld.
   */
  const [run, setRun] = useState<{ run: DiagnosticRun; kop: string } | null>(null);

  const kop = `${selectedClient?.name ?? "—"} · ${periodLabel(selection)}`;

  const voerUit = () => {
    setRun({ run: runDiagnostics(sources.input), kop });
  };

  return (
    <>
      <PageHeader
        title="Controle"
        description="Een controle op één administratie over één periode: wat klopt, waar staat nog werk open en wat blokkeert. De controle draait pas wanneer u erom vraagt en wijzigt niets."
      />

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om een controle uit te voeren." />
      ) : (
        <div className="space-y-4">
          <section aria-label="Administratie en periode" className="rounded-lg border bg-card p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ClipboardCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                <SelectTrigger className="h-9 w-full min-w-0 sm:w-56" aria-label="Administratie">
                  <span className="truncate">{selectedClient ? selectedClient.name : "Alle administraties"}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle administraties</SelectItem>
                  {clients?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>

              <Select
                value={selection.kind === "year" ? String(selection.year) : "all"}
                onValueChange={(v) =>
                  setSelection(v === "all" ? { kind: "all" } : { kind: "year", year: Number(v) })
                }
              >
                <SelectTrigger className="h-9 w-full min-w-0 sm:w-40" aria-label="Periode">
                  <span className="truncate">{periodLabel(selection)}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle jaren</SelectItem>
                  {recentYears().map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>

              <Button
                type="button"
                className="ml-auto h-9"
                onClick={voerUit}
                disabled={sources.isPending}
                data-testid="controle-uitvoeren"
              >
                {sources.isPending ? "Bronnen laden…" : "Controle uitvoeren"}
              </Button>
            </div>
          </section>

          <Card>
            <CardContent className="p-4 sm:p-6">
              {run === null ? (
                <EmptyState
                  icon={ClipboardCheck}
                  message="Er is nog geen controle uitgevoerd. Kies een administratie en periode en start de controle."
                />
              ) : (
                <Rapport run={run.run} kop={run.kop} />
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Deze controle wijzigt niets. Alle uitspraken komen uit opgeslagen grootboekmutaties en de
            bestaande boekhoudregels; de boekingsfunctie in de database blijft de autoriteit.
          </p>
        </div>
      )}
    </>
  );
}
