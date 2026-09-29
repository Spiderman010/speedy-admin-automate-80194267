import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ArrowRight, Download, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/hooks/useClients";
import { useJournalEntries } from "@/hooks/useJournalEntries";
import { exportJournalEntriesCSV } from "@/lib/snelstart-export";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { formatGetal } from "@/lib/format";
import { NoClientBanner } from "@/components/NoClientBanner";
import { resolveJournalEntryLedgerLabel } from "@/lib/journal-entry-utils";

/**
 * Snelle invoer — ALLEEN-LEZEN.
 *
 * `ledger_postings` is de enige financiële waarheid. De oude snelle invoer
 * schreef één bedrag op één rekening in `journal_entries`: geen tegenrekening,
 * geen debet/credit, geen jaarafsluiting of boekingsblokkade — en niets ervan
 * kwam ooit in het grootboek, de balans of de winst-en-verliesrekening.
 *
 * Nieuwe boekingen lopen daarom via het memoriaal (`/grootboek/memoriaal`),
 * dat uitsluitend via `post_manual_journal()` in het grootboek boekt. Deze
 * pagina toont de historische regels, ongewijzigd en exporteerbaar naar
 * SnelStart, en kan ze niet meer aanmaken of verwijderen. Wat er met die
 * historische regels gebeurt, is een aparte beslissing ná een productie-audit.
 */

const MEMORIAAL_ROUTE = "/grootboek/memoriaal";

function BoekingenTableSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Boekingen laden…</span>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-20 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-24 shrink-0 md:block" />
          <Skeleton className="hidden h-4 w-12 shrink-0 md:block" />
          <Skeleton className="h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export default function Boekingen() {
  const { toast } = useToast();
  const { selectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const { data: grootboekrekeningen } = useActiveGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });

  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";

  const {
    data: journalEntries,
    isLoading: entriesLoading,
    isError: entriesError,
    refetch: refetchEntries,
  } = useJournalEntries({
    organizationId: activeOrganizationId ?? undefined,
    clientId: hasSpecificClient ? selectedClientId : undefined,
    enabled: orgEnabled && hasSpecificClient,
  });

  const handleExportSnelstart = () => {
    if (!journalEntries?.length) {
      toast({ title: "Geen boekingen om te exporteren", variant: "destructive" });
      return;
    }
    const clientName = hasSpecificClient ? clients?.find((c) => c.id === selectedClientId)?.name : undefined;
    exportJournalEntriesCSV(journalEntries, clientName);
    toast({ title: `${journalEntries.length} boekingen geëxporteerd` });
  };

  const formatBedrag = (n: number | null | undefined) =>
    typeof n === "number" ? formatGetal(n) : "-";
  const formatDatum = (d: string) => {
    const [y, m, day] = d.split("-");
    return `${day}-${m}-${y}`;
  };

  return (
    <>
      {/* Shell header shows "Snelle invoer"; keep h1 for a11y only */}
      <h1 className="sr-only">Snelle invoer</h1>

      <div className="mb-4 flex items-center justify-end">
        <Button variant="outline" onClick={handleExportSnelstart} disabled={!hasSpecificClient}>
          <Download className="mr-2 h-4 w-4" />Export Snelstart
        </Button>
      </div>

      <div className="space-y-6">
        <Card>
          <CardContent className="p-4">
            <div
              className="flex items-start gap-3 text-sm text-muted-foreground"
              data-testid="snelle-invoer-alleen-lezen"
            >
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-2">
                <p className="font-medium text-foreground">Nieuwe boekingen maakt u in het memoriaal</p>
                <p>
                  Snelle invoer is alleen nog te raadplegen. De regels hieronder staan niet in het
                  grootboek en tellen niet mee in de balans, de winst-en-verliesrekening of de
                  proef- en saldibalans. Ze blijven zichtbaar en exporteerbaar naar SnelStart.
                </p>
                <p>
                  Een boeking die in het grootboek moet komen, legt u vast als memoriaalboeking.
                </p>
                <Button asChild size="sm">
                  <Link to={MEMORIAAL_ROUTE}>
                    Naar memoriaal<ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-lg">Historische snelle invoer</CardTitle>
          </CardHeader>
          <CardContent>
            {!hasSpecificClient ? (
              <NoClientBanner message="Kies een specifieke administratie om de boekingen te zien." />
            ) : entriesLoading ? (
              <BoekingenTableSkeleton />
            ) : entriesError ? (
              <div className="flex flex-col items-start gap-3 py-6">
                <p className="text-sm text-muted-foreground">Boekingen laden is mislukt.</p>
                <Button variant="outline" size="sm" onClick={() => refetchEntries()}>
                  Opnieuw proberen
                </Button>
              </div>
            ) : !journalEntries?.length ? (
              <p className="text-sm text-muted-foreground">
                Geen historische snelle invoer voor deze administratie.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Datum</TableHead>
                      <TableHead>Grootboek</TableHead>
                      <TableHead>Omschrijving</TableHead>
                      <TableHead className="hidden md:table-cell">Factuurnummer</TableHead>
                      <TableHead className="hidden text-right md:table-cell">BTW</TableHead>
                      <TableHead className="text-right">Bedrag</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {journalEntries.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="whitespace-nowrap">{formatDatum(e.entry_date)}</TableCell>
                        <TableCell className="max-w-[200px] truncate">
                          {resolveJournalEntryLedgerLabel(e, grootboekrekeningen) || "-"}
                        </TableCell>
                        <TableCell className="max-w-[220px] truncate">{e.description ?? "-"}</TableCell>
                        <TableCell className="hidden md:table-cell">{e.invoice_number ?? "-"}</TableCell>
                        <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">
                          {e.btw_percentage ?? 0}%
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{formatBedrag(Number(e.amount))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
