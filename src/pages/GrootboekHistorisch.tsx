import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle, History, Info } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { FilterChip } from "@/components/FilterChip";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useLedgerCatchup, useRunLedgerCatchup } from "@/hooks/useLedgerCatchup";
import { postableRecords, type CatchupRecord, type CatchupRunResult, type CatchupSummary } from "@/lib/ledger-catchup";
import { recentYears } from "@/lib/grootboek-saldi-utils";
import { formatCents } from "@/lib/financial-statements-presentation";

/**
 * Historische grootboekvulling (/grootboek/historisch).
 *
 * De ledger is leeg omdat bestaande facturen nooit naar het grootboek zijn
 * geboekt — er is bewust geen backfill gedraaid. Deze pagina maakt dat
 * zichtbaar en laat het inlopen, maar boekt uitsluitend via de BESTAANDE
 * writers. Er wordt hier geen bedrag berekend, geen rekening gekozen en geen
 * documentstatus gewijzigd.
 *
 * Een factuur op 'te_controleren' blijft geblokkeerd. Goedkeuren is een
 * menselijke handeling in de inkoopwerkplek en gebeurt nooit als bijeffect van
 * een bulkactie.
 */

export const HISTORISCH_EMPTY_MESSAGE = "Geen historische bronrecords in deze selectie.";

const STATE_BADGE: Record<CatchupRecord["state"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  geboekt: { label: "Geboekt", variant: "secondary" },
  klaar: { label: "Klaar", variant: "default" },
  geblokkeerd: { label: "Geblokkeerd", variant: "outline" },
};

function euro(amount: number | null) {
  // Eén formatter voor de hele app; deze pagina rekent niets uit en zet
  // alleen het bedrag uit de bron om naar hele centen voor de weergave.
  if (amount === null) return "—";
  return formatCents(Math.round(amount * 100));
}

function SummaryCard({ titel, summary, testId }: { titel: string; summary: CatchupSummary; testId: string }) {
  return (
    <div className="rounded-lg border p-3" data-testid={testId}>
      <h3 className="text-sm font-semibold">{titel}</h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Totaal</dt>
        <dd className="text-right font-mono tabular-nums" data-testid={`${testId}-totaal`}>{summary.totaal}</dd>
        <dt className="text-muted-foreground">Geboekt</dt>
        <dd className="text-right font-mono tabular-nums" data-testid={`${testId}-geboekt`}>{summary.geboekt}</dd>
        <dt className="text-muted-foreground">Klaar om te boeken</dt>
        <dd className="text-right font-mono tabular-nums" data-testid={`${testId}-klaar`}>{summary.klaar}</dd>
        <dt className="text-muted-foreground">Geblokkeerd</dt>
        <dd className="text-right font-mono tabular-nums" data-testid={`${testId}-geblokkeerd`}>{summary.geblokkeerd}</dd>
      </dl>
    </div>
  );
}

export default function GrootboekHistorisch() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;

  const [year, setYear] = useState<number | null>(null);
  const [bevestig, setBevestig] = useState(false);
  const [resultaat, setResultaat] = useState<CatchupRunResult | null>(null);

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const catchup = useLedgerCatchup(clientId, { year });
  const run = useRunLedgerCatchup();

  const selectedClient = clients?.find((c) => c.id === selectedClientId);
  const years = recentYears();

  const teBoeken = useMemo(() => postableRecords(catchup.data?.records ?? []), [catchup.data]);
  const geblokkeerd = useMemo(
    () => (catchup.data?.records ?? []).filter((r) => r.state === "geblokkeerd").length,
    [catchup.data],
  );

  const start = async () => {
    setBevestig(false);
    const uitkomst = await run.mutateAsync({ records: teBoeken, blocked: geblokkeerd });
    setResultaat(uitkomst);
  };

  const renderBody = () => {
    if (catchup.isPending) {
      return (
        <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Historische bronnen laden…</span>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      );
    }
    if (catchup.isError) {
      return (
        <Alert variant="destructive" data-testid="historisch-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Historische bronnen laden is mislukt</AlertTitle>
          <AlertDescription>
            <p>{(catchup.error as { message?: string } | null)?.message ?? "Onbekende fout"}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => catchup.refetch()}>
              Opnieuw proberen
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    const records = catchup.data?.records ?? [];
    if (records.length === 0) {
      return <EmptyState icon={History} message={HISTORISCH_EMPTY_MESSAGE} />;
    }

    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <SummaryCard titel="Inkoop" summary={catchup.data!.purchase} testId="historisch-inkoop" />
          <SummaryCard titel="Verkoop" summary={catchup.data!.sales} testId="historisch-verkoop" />
        </div>

        <div className="-mx-1 overflow-x-auto px-1">
          <Table className="min-w-[760px]">
            <caption className="sr-only">
              Historische inkoop- en verkoopfacturen met hun grootboekstatus en, bij een blokkade, de reden.
            </caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="w-28">Datum</TableHead>
                <TableHead scope="col" className="w-20">Soort</TableHead>
                <TableHead scope="col" className="min-w-[150px]">Nummer</TableHead>
                <TableHead scope="col" className="min-w-[160px]">Omschrijving</TableHead>
                <TableHead scope="col" className="w-28 text-right">Bedrag</TableHead>
                <TableHead scope="col" className="w-28">Status</TableHead>
                <TableHead scope="col" className="min-w-[220px]">Grootboek</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r) => (
                <TableRow key={`${r.source}-${r.id}`} data-testid="historisch-row" data-state-label={r.state} data-source={r.source}>
                  <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">{r.date ?? "—"}</TableCell>
                  <TableCell className="capitalize">{r.source}</TableCell>
                  <TableCell className="break-words">{r.reference}</TableCell>
                  <TableCell className="break-words">{r.description}</TableCell>
                  <TableCell className="whitespace-nowrap text-right font-mono text-sm tabular-nums">
                    {euro(r.amountInclusive)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.documentStatus}</TableCell>
                  <TableCell>
                    <Badge variant={STATE_BADGE[r.state].variant} data-testid="historisch-state">
                      {STATE_BADGE[r.state].label}
                    </Badge>
                    {r.blocks.length > 0 && (
                      <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                        {r.blocks.map((b) => (
                          <li key={b.code} data-block-code={b.code}>
                            {b.label}
                            {b.configuratie && (
                              <>
                                {" "}
                                <Link to="/klanten" className="underline underline-offset-4">
                                  Naar de instellingen
                                </Link>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title="Historische boekingen"
        description="Bestaande facturen die nog niet in het grootboek staan, alsnog boeken via de bestaande boekingsfuncties. Er worden geen statussen gewijzigd en geen bedragen herrekend."
      />

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om de historische boekingen te bekijken." />
      ) : (
        <div className="space-y-4">
          <section aria-label="Selectie en actie" className="rounded-lg border bg-card p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
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

              <FilterChip label="Alle jaren" active={year === null} onClick={() => setYear(null)} />
              {years.map((y) => (
                <FilterChip key={y} label={String(y)} active={year === y} onClick={() => setYear(y)} />
              ))}

              <Button
                type="button"
                className="ml-auto"
                disabled={teBoeken.length === 0 || run.isPending}
                onClick={() => setBevestig(true)}
                data-testid="historisch-bulk"
              >
                {run.isPending ? "Bezig met boeken…" : `Boek alle beschikbare (${teBoeken.length})`}
              </Button>
            </div>
          </section>

          {resultaat && (
            <Alert data-testid="historisch-resultaat">
              <Info className="h-4 w-4" />
              <AlertTitle>Resultaat van de historische boekingsronde</AlertTitle>
              <AlertDescription>
                <p>
                  {resultaat.attempted} aangeboden · {resultaat.posted} geboekt ·{" "}
                  {resultaat.failures.length} geweigerd · {resultaat.blocked} vooraf geblokkeerd.
                </p>
                {resultaat.failures.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-xs">
                    {resultaat.failures.map((f) => (
                      <li key={`${f.source}-${f.id}`} data-testid="historisch-failure">
                        {f.source} {f.reference}: {f.message}
                      </li>
                    ))}
                  </ul>
                )}
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardContent className="p-4 sm:p-6">{renderBody()}</CardContent>
          </Card>
        </div>
      )}

      <AlertDialog open={bevestig} onOpenChange={setBevestig}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Beschikbare records boeken?</AlertDialogTitle>
            <AlertDialogDescription>
              {teBoeken.length === 1
                ? "1 record wordt aangeboden aan de bestaande grootboekwriters."
                : `${teBoeken.length} records worden aangeboden aan de bestaande grootboekwriters.`}{" "}
              {geblokkeerd === 1
                ? "1 geblokkeerd record wordt overgeslagen."
                : `${geblokkeerd} geblokkeerde records worden overgeslagen.`}{" "}
              Elke boeking wordt server-side opnieuw gevalideerd; documentstatussen worden niet gewijzigd.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuleren</AlertDialogCancel>
            <AlertDialogAction onClick={start} data-testid="historisch-bevestig">Boeken</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
