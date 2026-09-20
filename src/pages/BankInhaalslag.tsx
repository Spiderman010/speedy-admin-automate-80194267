import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Landmark, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { FilterChip } from "@/components/FilterChip";
import { BankBulkCandidateSheet } from "@/components/bank/BankBulkCandidateSheet";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useBankBulkCandidates, usePostBankTransactionsBulk } from "@/hooks/useBankBulkPosting";
import {
  filterCandidates,
  reconcileSelection,
  rejectedResults,
  resultsFromError,
  selectableCandidates,
  selectionBreakdown,
  submittableIds,
  summariseBulkResults,
  summariseCandidates,
  BankBulkPartialError,
  WORKFLOW_BADGE_VARIANT,
  WORKFLOW_LABELS,
  type BankBulkCandidate,
  type BankBulkResult,
  type BankBulkWorkflowState,
} from "@/lib/bank-bulk-posting";
import { formatCents, formatDatumNL, recentYears } from "@/lib/grootboek-saldi-utils";

/**
 * Bank inhaalslag (/bank/inhaalslag).
 *
 * Een administratie kan honderden gecodeerde bankregels hebben die nog niet in
 * het grootboek staan. Dit scherm maakt dat zichtbaar en laat het in één keer
 * inlopen — maar boekt uitsluitend via de bestaande server-RPC's:
 *
 *   useBankBulkCandidates()          leest de werkstroomtoestand per regel
 *   usePostBankTransactionsBulk()    de ENIGE schrijfactie van deze pagina
 *
 * Er wordt hier geen BTW gesplitst, geen debet/credit bepaald, geen rekening
 * gekozen, geen boekjaar afgeleid en geen dubbele boeking beoordeeld. De
 * toestanden `ready`/`review_needed`/`blocked`/`posted` komen ongewijzigd van
 * de server; deze pagina hangt er alleen een Nederlands label aan. Zegt de
 * server `ready` en weigert de database alsnog, dan blijft de regel ongeboekt
 * en toont het resultaat de reden van de database.
 */

export const INHAALSLAG_EMPTY_MESSAGE = "Geen bankregels in deze selectie.";
export const INHAALSLAG_DEPLOY_MESSAGE = "Bulkboeken is nog niet beschikbaar voor deze omgeving.";

const STATE_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "Alle toestanden" },
  { value: "ready", label: WORKFLOW_LABELS.ready },
  { value: "review_needed", label: WORKFLOW_LABELS.review_needed },
  { value: "blocked", label: WORKFLOW_LABELS.blocked },
  { value: "posted", label: WORKFLOW_LABELS.posted },
];

function euro(amount: number | string): string {
  const getal = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(getal)) return "—";
  return formatCents(Math.round(getal * 100));
}

function TelCel({ label, waarde, testId }: { label: string; waarde: number; testId: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono text-lg tabular-nums" data-testid={testId}>{waarde}</dd>
    </div>
  );
}

export default function BankInhaalslag() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;

  const [year, setYear] = useState<number | null>(null);
  const [zoek, setZoek] = useState("");
  const [toestand, setToestand] = useState<string>("all");
  const [alleenAfwijkingen, setAlleenAfwijkingen] = useState(false);
  const [selectie, setSelectie] = useState<string[]>([]);
  const [bevestig, setBevestig] = useState(false);
  const [detail, setDetail] = useState<BankBulkCandidate | null>(null);
  const [resultaat, setResultaat] = useState<BankBulkResult[] | null>(null);
  const [afgebroken, setAfgebroken] = useState<
    { message: string; outcomeUnknown: number; notSubmitted: number } | null
  >(null);
  const [alleenGeweigerd, setAlleenGeweigerd] = useState(false);

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const { data: rekeningen } = useGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });
  const candidates = useBankBulkCandidates({ clientId, boekjaar: year });
  const boeken = usePostBankTransactionsBulk();

  const selectedClient = clients?.find((c) => c.id === selectedClientId);
  const years = recentYears();

  /** `null` = "kon het niet weten" (deploy-venster), nooit "er is niets". */
  const rows: BankBulkCandidate[] | null = candidates.data ?? null;
  const zichtbaar = useMemo(
    () =>
      filterCandidates(rows ?? [], {
        search: zoek,
        state: toestand === "all" ? null : (toestand as BankBulkWorkflowState),
        onlyDeviations: alleenAfwijkingen,
      }),
    [rows, zoek, toestand, alleenAfwijkingen],
  );

  const totalen = useMemo(() => summariseCandidates(rows ?? []), [rows]);
  const verdeling = useMemo(() => selectionBreakdown(rows ?? [], selectie), [rows, selectie]);
  const aanTeBieden = useMemo(() => submittableIds(rows ?? [], selectie), [rows, selectie]);

  const rekeningLabel = (id: string | null): string | null => {
    if (!id) return null;
    const r = rekeningen?.find((g) => g.id === id);
    // Uitsluitend weergave: het nummer wordt getoond, nooit uitgelegd.
    return r ? `${r.nummer} · ${r.omschrijving}` : null;
  };

  const zichtbaarSelecteerbaar = selectableCandidates(zichtbaar);
  const selectieSet = new Set(selectie);

  const toggle = (id: string) =>
    setSelectie((huidig) =>
      huidig.includes(id) ? huidig.filter((x) => x !== id) : [...huidig, id],
    );

  const selecteerZichtbaarGereed = () =>
    setSelectie((huidig) => [
      ...new Set([...huidig, ...zichtbaarSelecteerbaar.map((r) => r.transaction_id)]),
    ]);

  const start = async () => {
    setBevestig(false);
    setAfgebroken(null);
    setAlleenGeweigerd(false);
    try {
      const uitkomst = await boeken.mutateAsync({ transactionIds: aanTeBieden });
      setResultaat(uitkomst);
    } catch (error) {
      // Een afgebroken ronde is geen "er is niets gebeurd": de partijen die al
      // terugkwamen, staan vast. Er wordt niets automatisch opnieuw geprobeerd.
      //
      // Kent de fout de drie groepen niet, dan wordt de hele ronde als
      // ONBEKEND geteld en niet als "niet aangeboden": bij een onverwachte
      // fout is nu juist niet vast te stellen of het verzoek de database heeft
      // bereikt, en "niet aangeboden" zou dat wél beweren.
      setResultaat(resultsFromError(error));
      setAfgebroken(
        error instanceof BankBulkPartialError
          ? {
              message: error.message,
              outcomeUnknown: error.outcomeUnknown,
              notSubmitted: error.notSubmitted,
            }
          : {
              message: (error as Error).message,
              outcomeUnknown: aanTeBieden.length,
              notSubmitted: 0,
            },
      );
    }
    // De selectie opnieuw naast de server leggen zodra de nieuwe gegevens er
    // zijn; geboekte regels zijn dan niet langer `ready` en vallen eruit.
    const vers = await candidates.refetch();
    setSelectie((huidig) => reconcileSelection(huidig, vers.data ?? []));
  };

  const samenvatting = resultaat ? summariseBulkResults(resultaat) : null;
  const geweigerd = resultaat ? rejectedResults(resultaat) : [];

  const renderBody = () => {
    if (candidates.isPending) {
      return (
        <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Bankregels laden…</span>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      );
    }

    if (candidates.isError) {
      return (
        <Alert variant="destructive" data-testid="inhaalslag-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Bankregels laden is mislukt</AlertTitle>
          <AlertDescription>
            <p>{(candidates.error as Error | null)?.message ?? "Onbekende fout"}</p>
            <Button variant="outline" size="sm" className="mt-3 h-11" onClick={() => candidates.refetch()}>
              Opnieuw proberen
            </Button>
          </AlertDescription>
        </Alert>
      );
    }

    // Deploy-venster: de RPC's bestaan nog niet. Dat is iets anders dan leeg.
    if (rows === null) {
      return (
        <Alert data-testid="inhaalslag-deploy">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Nog niet beschikbaar</AlertTitle>
          <AlertDescription>{INHAALSLAG_DEPLOY_MESSAGE}</AlertDescription>
        </Alert>
      );
    }

    if (rows.length === 0) {
      return <EmptyState icon={Landmark} message={INHAALSLAG_EMPTY_MESSAGE} />;
    }

    return (
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="inhaalslag-totalen">
          <TelCel label="Totaal" waarde={totalen.total} testId="inhaalslag-totaal" />
          <TelCel label={WORKFLOW_LABELS.ready} waarde={totalen.ready} testId="inhaalslag-gereed" />
          <TelCel label={WORKFLOW_LABELS.review_needed} waarde={totalen.reviewNeeded} testId="inhaalslag-controle" />
          <TelCel label={WORKFLOW_LABELS.blocked} waarde={totalen.blocked} testId="inhaalslag-geblokkeerd" />
          <TelCel label={WORKFLOW_LABELS.posted} waarde={totalen.posted} testId="inhaalslag-geboekt" />
        </dl>

        {zichtbaar.length === 0 ? (
          <EmptyState icon={Landmark} message="Geen bankregels die aan dit filter voldoen." />
        ) : (
          <div className="-mx-1 overflow-x-auto px-1">
            <Table className="min-w-[820px]">
              <caption className="sr-only">
                Bankregels van deze administratie met hun werkstroomtoestand volgens de server.
                Alleen regels met de toestand Gereed kunnen worden aangeboden.
              </caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className="w-10">
                    <span className="sr-only">Selectie</span>
                  </TableHead>
                  <TableHead scope="col" className="w-28">Datum</TableHead>
                  <TableHead scope="col" className="min-w-[200px]">Omschrijving</TableHead>
                  <TableHead scope="col" className="hidden min-w-[160px] md:table-cell">Grootboekrekening</TableHead>
                  <TableHead scope="col" className="hidden w-16 text-right lg:table-cell">BTW</TableHead>
                  <TableHead scope="col" className="w-28 text-right">Bedrag</TableHead>
                  <TableHead scope="col" className="w-32">Status</TableHead>
                  <TableHead scope="col" className="w-20">
                    <span className="sr-only">Detail</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {zichtbaar.map((r) => {
                  const selecteerbaar = r.workflow_state === "ready";
                  return (
                    <TableRow
                      key={r.transaction_id}
                      data-testid="inhaalslag-row"
                      data-state-label={r.workflow_state}
                      data-transaction-id={r.transaction_id}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selectieSet.has(r.transaction_id)}
                          disabled={!selecteerbaar}
                          onCheckedChange={() => toggle(r.transaction_id)}
                          data-testid="inhaalslag-checkbox"
                          aria-label={`Bankregel van ${formatDatumNL(r.transaction_date)} voor ${euro(r.amount)} selecteren`}
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
                        {formatDatumNL(r.transaction_date)}
                      </TableCell>
                      <TableCell className="break-words">
                        <span>{r.description || "—"}</span>
                        {r.counter_account && (
                          <span className="block text-xs text-muted-foreground">{r.counter_account}</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden break-words text-sm md:table-cell">
                        {rekeningLabel(r.grootboekrekening_id) ?? "—"}
                      </TableCell>
                      <TableCell className="hidden text-right font-mono text-xs tabular-nums lg:table-cell">
                        {r.btw_percentage === null || r.btw_percentage === undefined ? "—" : `${r.btw_percentage}%`}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono text-sm tabular-nums">
                        {euro(r.amount)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={WORKFLOW_BADGE_VARIANT[r.workflow_state]}
                          data-testid="inhaalslag-state"
                        >
                          {WORKFLOW_LABELS[r.workflow_state]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-11"
                          onClick={() => setDetail(r)}
                          data-testid="inhaalslag-detail"
                          aria-label={`Details van de bankregel van ${formatDatumNL(r.transaction_date)}`}
                        >
                          Details
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title="Bank inhaalslag"
        description="Gecodeerde bankregels die nog niet in het grootboek staan, in één keer boeken via de bestaande boekingsfunctie. Er worden geen bedragen herrekend en geen statussen gewijzigd."
      />

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om de inhaalslag te bekijken." />
      ) : (
        <div className="space-y-4 pb-24">
          <section aria-label="Selectie en filters" className="rounded-lg border bg-card p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                <SelectTrigger className="h-11 w-full min-w-0 sm:w-56" aria-label="Administratie">
                  <span className="truncate">{selectedClient ? selectedClient.name : "Alle administraties"}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle administraties</SelectItem>
                  {clients?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                value={zoek}
                onChange={(e) => setZoek(e.target.value)}
                placeholder="Zoek op omschrijving, tegenrekening of bedrag"
                className="h-11 w-full min-w-0 sm:w-72"
                aria-label="Zoeken in bankregels"
                data-testid="inhaalslag-zoek"
              />

              <Select value={toestand} onValueChange={setToestand}>
                <SelectTrigger className="h-11 w-full min-w-0 sm:w-44" aria-label="Werkstroomtoestand">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATE_FILTERS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-11"
                onClick={() => candidates.refetch()}
                data-testid="inhaalslag-ververs"
              >
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                Verversen
              </Button>

              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-11 sm:ml-auto"
                disabled={zichtbaarSelecteerbaar.length === 0}
                onClick={selecteerZichtbaarGereed}
                data-testid="inhaalslag-selecteer-zichtbaar"
              >
                Zichtbare {WORKFLOW_LABELS.ready.toLowerCase()} selecteren ({zichtbaarSelecteerbaar.length})
              </Button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <FilterChip label="Alle jaren" active={year === null} onClick={() => setYear(null)} />
              {years.map((y) => (
                <FilterChip key={y} label={String(y)} active={year === y} onClick={() => setYear(y)} />
              ))}
              <FilterChip
                label="Alleen afwijkingen"
                active={alleenAfwijkingen}
                onClick={() => setAlleenAfwijkingen((v) => !v)}
              />
            </div>
          </section>

          {afgebroken && (
            <Alert variant="destructive" data-testid="inhaalslag-afgebroken">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>De boekingsronde is halverwege afgebroken</AlertTitle>
              <AlertDescription>
                <p>{afgebroken.message}</p>
                {afgebroken.outcomeUnknown > 0 && (
                  <p className="mt-1" data-testid="afgebroken-onbekend">
                    De uitkomst van {afgebroken.outcomeUnknown} bankregel(s) kon niet worden
                    bevestigd. Dat verzoek was al verstuurd; of de database het heeft verwerkt,
                    is hier niet vast te stellen.
                  </p>
                )}
                {afgebroken.notSubmitted > 0 && (
                  <p className="mt-1" data-testid="afgebroken-niet-aangeboden">
                    {afgebroken.notSubmitted} bankregel(s) zijn daarna niet meer aangeboden.
                  </p>
                )}
                <p className="mt-1">
                  Wat hieronder staat, is bevestigd. Er wordt niets automatisch opnieuw geprobeerd:
                  ververs eerst de actuele status voordat je opnieuw boekt.
                </p>
              </AlertDescription>
            </Alert>
          )}

          {samenvatting && (
            <Alert data-testid="inhaalslag-resultaat">
              <AlertTitle>Resultaat</AlertTitle>
              <AlertDescription>
                <p>
                  <span data-testid="resultaat-geboekt">{samenvatting.posted}</span> geboekt ·{" "}
                  <span data-testid="resultaat-al-geboekt">{samenvatting.alreadyPosted}</span> al geboekt ·{" "}
                  <span data-testid="resultaat-geweigerd">{samenvatting.rejected}</span> geweigerd.
                </p>
                {geweigerd.length > 0 && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 h-11"
                      onClick={() => setAlleenGeweigerd((v) => !v)}
                      data-testid="inhaalslag-toon-geweigerd"
                    >
                      {alleenGeweigerd ? "Alle resultaten tonen" : "Alleen geweigerde tonen"}
                    </Button>
                    <ul className="mt-2 space-y-1 text-xs">
                      {(alleenGeweigerd ? geweigerd : resultaat ?? []).map((r) => (
                        <li
                          key={r.transaction_id}
                          data-testid="inhaalslag-resultaatregel"
                          data-outcome={r.outcome}
                        >
                          <span className="font-mono">{r.transaction_id.slice(0, 8)}</span>{" "}
                          — {r.outcome === "posted" ? "geboekt" : r.outcome === "already_posted" ? "al geboekt" : "geweigerd"}
                          {r.message ? `: ${r.message}` : ""}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardContent className="p-4 sm:p-6">{renderBody()}</CardContent>
          </Card>
        </div>
      )}

      {hasSpecificClient && verdeling.selected > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 p-3 shadow-lg backdrop-blur"
          role="region"
          aria-label="Bulkactie"
          data-testid="inhaalslag-bulkbalk"
        >
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
            <p className="text-sm">
              <span data-testid="bulkbalk-geselecteerd">{verdeling.selected}</span> geselecteerd ·{" "}
              <span data-testid="bulkbalk-gereed">{verdeling.ready}</span> {WORKFLOW_LABELS.ready.toLowerCase()}
              {verdeling.reviewNeeded > 0 && ` · ${verdeling.reviewNeeded} ${WORKFLOW_LABELS.review_needed.toLowerCase()}`}
              {verdeling.blocked > 0 && ` · ${verdeling.blocked} ${WORKFLOW_LABELS.blocked.toLowerCase()}`}
              {verdeling.posted > 0 && ` · ${verdeling.posted} ${WORKFLOW_LABELS.posted.toLowerCase()}`}
            </p>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                onClick={() => setSelectie([])}
                data-testid="inhaalslag-selectie-wissen"
              >
                Selectie wissen
              </Button>
              <Button
                type="button"
                className="h-11"
                disabled={aanTeBieden.length === 0 || boeken.isPending}
                onClick={() => setBevestig(true)}
                data-testid="inhaalslag-bulk"
              >
                {boeken.isPending ? "Bezig met boeken…" : `${aanTeBieden.length} bankregels boeken`}
              </Button>
            </div>
          </div>
        </div>
      )}

      <BankBulkCandidateSheet
        candidate={detail}
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
        accountLabel={detail ? rekeningLabel(detail.grootboekrekening_id) : null}
      />

      <AlertDialog open={bevestig} onOpenChange={setBevestig}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="inhaalslag-dialog-titel">
              {aanTeBieden.length} bankregels boeken?
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="inhaalslag-dialog-tekst">
              Van de {verdeling.selected} geselecteerde regel(s) worden er {aanTeBieden.length}{" "}
              aangeboden. Elke bankregel wordt opnieuw door de database gevalideerd. Regels die
              niet kunnen worden geboekt, blijven ongeboekt; geslaagde regels blijven geboekt.
              Een regel die al geboekt is, wordt nooit een tweede keer geboekt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuleren</AlertDialogCancel>
            <AlertDialogAction onClick={start} data-testid="inhaalslag-bevestig">
              {aanTeBieden.length} regels boeken
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
