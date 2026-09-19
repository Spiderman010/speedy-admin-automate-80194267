import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useLedgerIntegrity } from "@/hooks/useLedgerIntegrity";
import {
  INTEGRITY_TITLES,
  type IntegrityFinding,
  type IntegrityKind,
} from "@/lib/ledger-integrity";

/**
 * Grootboekintegriteit (/grootboek/integriteit).
 *
 * Een leesscherm: het toont wat er niet klopt en waar het zit. Er is geen
 * herstelknop, geen bulkactie en geen backfill — elke bevinding vraagt om een
 * menselijke beslissing, en een knop die "het even oplost" zou precies het
 * soort stille correctie zijn waar een grootboek niet tegen kan.
 */

export const INTEGRITEIT_SCHOON = "Geen integriteitsproblemen gevonden in deze administratie.";

/** De volgorde waarin de controles worden getoond; ernst eerst. */
const KIND_ORDER: IntegrityKind[] = [
  "boekingsgroep_niet_in_balans",
  "marker_zonder_boekingsgroep",
  "factuur_zonder_regels",
  "legacy_tekst_zonder_rekening",
];

function FindingRow({ finding }: { finding: IntegrityFinding }) {
  const isError = finding.severity === "error";
  return (
    <TableRow data-testid="integriteit-row" data-kind={finding.kind} data-severity={finding.severity}>
      <TableCell className="py-2 align-top">
        <Badge
          variant={isError ? "destructive" : "outline"}
          className="whitespace-nowrap text-[11px] font-normal"
          data-testid="integriteit-severity"
        >
          {isError ? "Fout" : "Waarschuwing"}
        </Badge>
      </TableCell>
      <TableCell className="py-2 align-top text-sm font-medium">{INTEGRITY_TITLES[finding.kind]}</TableCell>
      <TableCell className="py-2 align-top text-sm">
        {finding.reference.soort === "inkoopfactuur" ? (
          <Link
            to={`/facturen/inkoop/${finding.reference.id}`}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {finding.subject}
          </Link>
        ) : (
          <span className="break-all font-mono text-xs">{finding.subject}</span>
        )}
      </TableCell>
      <TableCell className="py-2 align-top text-sm text-muted-foreground">{finding.detail}</TableCell>
    </TableRow>
  );
}

export default function GrootboekIntegriteit() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const integriteit = useLedgerIntegrity(clientId);
  const selectedClient = clients?.find((c) => c.id === selectedClientId);

  const renderBody = () => {
    if (integriteit.isPending) {
      return (
        <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Integriteitscontrole laden…</span>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      );
    }
    if (integriteit.isError) {
      return (
        <Alert variant="destructive" data-testid="integriteit-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Controle kan niet worden uitgevoerd</AlertTitle>
          <AlertDescription>
            <p>{(integriteit.error as { message?: string } | null)?.message ?? "Onbekende fout"}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => integriteit.refetch()}>
              Opnieuw proberen
            </Button>
          </AlertDescription>
        </Alert>
      );
    }

    const report = integriteit.data!;
    if (report.findings.length === 0) {
      return (
        <Alert data-testid="integriteit-schoon">
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Alles sluit</AlertTitle>
          <AlertDescription>{INTEGRITEIT_SCHOON}</AlertDescription>
        </Alert>
      );
    }

    // Ernst eerst, en binnen een soort de volgorde die de engine al bepaalde.
    const gesorteerd = KIND_ORDER.flatMap((kind) => report.findings.filter((f) => f.kind === kind));

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="destructive" data-testid="integriteit-errors">
            {report.errorCount} {report.errorCount === 1 ? "fout" : "fouten"}
          </Badge>
          <Badge variant="outline" data-testid="integriteit-warnings">
            {report.warningCount} {report.warningCount === 1 ? "waarschuwing" : "waarschuwingen"}
          </Badge>
        </div>

        <div className="-mx-1 overflow-x-auto px-1">
          <Table className="min-w-[820px]">
            <caption className="sr-only">
              Gevonden integriteitsproblemen, met ernst, onderwerp en toelichting.
            </caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="w-32">Ernst</TableHead>
                <TableHead scope="col" className="min-w-[220px]">Controle</TableHead>
                <TableHead scope="col" className="min-w-[200px]">Onderwerp</TableHead>
                <TableHead scope="col" className="min-w-[280px]">Toelichting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {gesorteerd.map((f) => (
                <FindingRow key={`${f.kind}-${f.reference.id}`} finding={f} />
              ))}
            </TableBody>
          </Table>
        </div>

        <p className="text-xs text-muted-foreground">
          Dit scherm herstelt niets. Elke bevinding vraagt om een beslissing: een factuur afmaken en boeken,
          of een boekingsgroep laten onderzoeken. Er wordt hier nooit iets automatisch gecorrigeerd.
        </p>
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title="Grootboekintegriteit"
        description="Controleert per administratie of documenten, boekingsmarkers en grootboekregels met elkaar kloppen. Alleen lezen — er wordt niets gewijzigd of hersteld."
      />

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om de integriteit te controleren." />
      ) : (
        <div className="space-y-4">
          <section aria-label="Administratiekeuze" className="rounded-lg border bg-card p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                <SelectTrigger className="h-9 w-full min-w-0 sm:w-56" aria-label="Administratie">
                  <span className="truncate">{selectedClient ? selectedClient.name : "Alle administraties"}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle administraties</SelectItem>
                  {clients?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <Card>
            <CardContent className="p-4 sm:p-6">{renderBody()}</CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
