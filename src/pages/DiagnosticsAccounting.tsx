import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, RefreshCw, Stethoscope } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useAccountingDiagnostics } from "@/hooks/useAccountingDiagnostics";
import type { DiagnosticItem, DiagnosticSeverity } from "@/lib/accounting-diagnostics";

/**
 * Accounting Diagnostics — interne console (/diagnostics/accounting).
 *
 * Geen klantfunctie: dit is het scherm waarmee wij een kapotte boekhoudketen
 * vinden zonder er een code-audit voor te hoeven doen. Alleen lezen — er is
 * geen herstelknop, geen bulkactie en geen backfill; de enige actie is
 * verversen.
 *
 * Het overzicht en de detailtabbladen komen uit DEZELFDE items. Er is geen
 * tweede telling die kan gaan afwijken.
 */

export const DIAGNOSTICS_CLEAN = "Geen bevindingen in dit domein.";

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  error: "Fout",
  warning: "Waarschuwing",
  ok: "In orde",
};

const SEVERITY_VARIANT: Record<DiagnosticSeverity, "destructive" | "outline" | "secondary"> = {
  error: "destructive",
  warning: "outline",
  ok: "secondary",
};

/** Fouten eerst, dan waarschuwingen, dan wat in orde is. */
const SEVERITY_ORDER: DiagnosticSeverity[] = ["error", "warning", "ok"];

function SeverityBadge({ severity }: { severity: DiagnosticSeverity }) {
  return (
    <Badge
      variant={SEVERITY_VARIANT[severity]}
      className="whitespace-nowrap text-[11px] font-normal"
      data-testid="diagnostic-severity"
    >
      {SEVERITY_LABEL[severity]}
    </Badge>
  );
}

function Stat({ label, value, testId, tone }: { label: string; value: number; testId: string; tone?: "error" | "warning" }) {
  return (
    <div className="rounded-md border px-3 py-2" data-testid={testId}>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={
          "mt-0.5 font-mono text-lg font-semibold tabular-nums" +
          (tone === "error" && value > 0 ? " text-destructive" : "")
        }
      >
        {value}
      </dd>
    </div>
  );
}

function ItemsTable({ items, testId }: { items: readonly DiagnosticItem[]; testId: string }) {
  if (items.length === 0) {
    return (
      <Alert data-testid={`${testId}-clean`}>
        <CheckCircle2 className="h-4 w-4" />
        <AlertTitle>Niets gevonden</AlertTitle>
        <AlertDescription>{DIAGNOSTICS_CLEAN}</AlertDescription>
      </Alert>
    );
  }
  const gesorteerd = SEVERITY_ORDER.flatMap((s) => items.filter((i) => i.severity === s));
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <Table className="min-w-[820px]" data-testid={testId}>
        <caption className="sr-only">Bevindingen met ernst, onderwerp, code en toelichting.</caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="w-32">Ernst</TableHead>
            <TableHead scope="col" className="min-w-[180px]">Onderwerp</TableHead>
            <TableHead scope="col" className="min-w-[200px]">Code</TableHead>
            <TableHead scope="col" className="min-w-[300px]">Toelichting</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {gesorteerd.map((item, idx) => (
            <TableRow
              key={`${item.code}-${item.recordId ?? idx}`}
              data-testid="diagnostic-row"
              data-code={item.code}
              data-severity={item.severity}
              data-domain={item.domain}
            >
              <TableCell className="py-2 align-top"><SeverityBadge severity={item.severity} /></TableCell>
              <TableCell className="py-2 align-top text-sm">
                {item.targetUrl ? (
                  <Link
                    to={item.targetUrl}
                    className="rounded-sm break-words underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {item.reference ?? item.recordId ?? "—"}
                  </Link>
                ) : (
                  <span className="break-words">{item.reference ?? item.recordId ?? "—"}</span>
                )}
              </TableCell>
              <TableCell className="py-2 align-top font-mono text-xs text-muted-foreground">{item.code}</TableCell>
              <TableCell className="py-2 align-top text-sm text-muted-foreground">{item.message}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function DiagnosticsAccounting() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;
  const [tab, setTab] = useState("overzicht");

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const diagnostics = useAccountingDiagnostics(clientId);
  const selectedClient = clients?.find((c) => c.id === selectedClientId);

  const renderBody = () => {
    if (diagnostics.isPending) {
      return (
        <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Diagnostiek laden…</span>
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
        </div>
      );
    }
    if (diagnostics.isError) {
      return (
        <Alert variant="destructive" data-testid="diagnostics-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Diagnostiek kan niet worden uitgevoerd</AlertTitle>
          <AlertDescription>
            <p>{(diagnostics.error as { message?: string } | null)?.message ?? "Onbekende fout"}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => diagnostics.refetch()}>
              Opnieuw proberen
            </Button>
          </AlertDescription>
        </Alert>
      );
    }

    const { purchase, sales, ledger } = diagnostics.data!;

    return (
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 flex flex-wrap">
          <TabsTrigger value="overzicht">Overzicht</TabsTrigger>
          <TabsTrigger value="inkoop">Inkoop</TabsTrigger>
          <TabsTrigger value="verkoop">Verkoop</TabsTrigger>
          <TabsTrigger value="grootboek">Grootboek</TabsTrigger>
        </TabsList>

        <TabsContent value="overzicht" className="space-y-5">
          <section aria-labelledby="ov-inkoop" data-testid="overzicht-inkoop">
            <h3 id="ov-inkoop" className="mb-2 text-sm font-semibold">Inkoop</h3>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              <Stat label="Totaal" value={purchase.summary.total} testId="inkoop-totaal" />
              <Stat label="Geboekt" value={purchase.summary.posted} testId="inkoop-geboekt" />
              <Stat label="Klaar" value={purchase.summary.ready} testId="inkoop-klaar" />
              <Stat label="Geblokkeerd" value={purchase.summary.blocked} testId="inkoop-geblokkeerd" />
              <Stat label="Zonder regels" value={purchase.summary.byCode.geen_boekingsregels ?? 0} testId="inkoop-zonder-regels" tone="error" />
              <Stat label="Regel zonder rekening" value={purchase.summary.byCode.regel_zonder_rekening ?? 0} testId="inkoop-regel-zonder-rekening" tone="error" />
              <Stat
                label="Configuratie"
                value={(purchase.summary.byCode.geen_crediteurenrekening ?? 0) + (purchase.summary.byCode.geen_btw_rekening ?? 0)}
                testId="inkoop-configuratie"
              />
            </dl>
          </section>

          <section aria-labelledby="ov-verkoop" data-testid="overzicht-verkoop">
            <h3 id="ov-verkoop" className="mb-2 text-sm font-semibold">Verkoop</h3>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
              <Stat label="Totaal" value={sales.summary.total} testId="verkoop-totaal" />
              <Stat label="Geboekt" value={sales.summary.posted} testId="verkoop-geboekt" />
              <Stat label="Klaar" value={sales.summary.ready} testId="verkoop-klaar" />
              <Stat label="Geblokkeerd" value={sales.summary.blocked} testId="verkoop-geblokkeerd" />
              <Stat
                label="Configuratie"
                value={(sales.summary.byCode.geen_debiteurenrekening ?? 0) + (sales.summary.byCode.geen_btw_rekening ?? 0)}
                testId="verkoop-configuratie"
              />
            </dl>
          </section>

          <section aria-labelledby="ov-grootboek" data-testid="overzicht-grootboek">
            <h3 id="ov-grootboek" className="mb-2 text-sm font-semibold">Grootboek</h3>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Boekingsgroepen" value={ledger.summary.postingGroups} testId="grootboek-groepen" />
              <Stat label="Sluitend" value={ledger.summary.balancedGroups} testId="grootboek-sluitend" />
              <Stat label="Niet sluitend" value={ledger.summary.unbalancedGroups} testId="grootboek-niet-sluitend" tone="error" />
              <Stat label="Wees-markers" value={ledger.summary.orphanMarkers} testId="grootboek-wezen" tone="error" />
              <Stat
                label="Zonder classificatie"
                value={ledger.summary.accountsMissingClassification}
                testId="grootboek-classificatie"
              />
            </dl>
          </section>
        </TabsContent>

        <TabsContent value="inkoop"><ItemsTable items={purchase.items} testId="tabel-inkoop" /></TabsContent>
        <TabsContent value="verkoop"><ItemsTable items={sales.items} testId="tabel-verkoop" /></TabsContent>
        <TabsContent value="grootboek"><ItemsTable items={ledger.items} testId="tabel-grootboek" /></TabsContent>
      </Tabs>
    );
  };

  return (
    <>
      <PageHeader
        title="Accounting diagnostics"
        description="Interne controle op de boekhoudketen van één administratie: welke documenten zijn kapot, welke staan klaar maar zijn niet geboekt, en klopt het grootboek met zichzelf. Alleen lezen."
      />

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om de diagnostiek te bekijken." />
      ) : (
        <div className="space-y-4">
          <section aria-label="Administratie en verversen" className="rounded-lg border bg-card p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Stethoscope className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                <SelectTrigger className="h-9 w-full min-w-0 sm:w-56" aria-label="Administratie">
                  <span className="truncate">{selectedClient ? selectedClient.name : "Alle administraties"}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle administraties</SelectItem>
                  {clients?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto h-9"
                onClick={() => diagnostics.refetch()}
                disabled={diagnostics.isFetching}
                data-testid="diagnostics-refresh"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {diagnostics.isFetching ? "Bezig…" : "Verversen"}
              </Button>
            </div>
          </section>

          <Card>
            <CardContent className="p-4 sm:p-6">{renderBody()}</CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Deze console wijzigt niets. Alle uitspraken komen uit opgeslagen gegevens en de bestaande
            boekhoudregels; de boekingsfunctie in de database blijft de autoriteit.
          </p>
        </div>
      )}
    </>
  );
}
