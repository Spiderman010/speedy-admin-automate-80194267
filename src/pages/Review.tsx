import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  ExternalLink,
  FileText,
  ListChecks,
  Lock,
  Search,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { FilterChip } from "@/components/FilterChip";
import { AccountingAmount } from "@/components/platform/AccountingAmount";
import { AccountingNotice, type AccountingNoticeSeverity } from "@/components/platform/AccountingNotice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useClientContext } from "@/hooks/useClientContext";
import { useClients } from "@/hooks/useClients";
import { useLedgerCatchup } from "@/hooks/useLedgerCatchup";
import { recentYears } from "@/lib/grootboek-saldi-utils";
import { summarize, type CatchupRecord, type CatchupSource, type CatchupState } from "@/lib/ledger-catchup";
import { resolveLedgerSource } from "@/lib/ledger-reporting";
import {
  REVIEW_SOURCE_LABELS,
  REVIEW_STATE_LABELS,
  REVIEW_STATE_ORDER,
  countBySource,
  filterReviewQueue,
  orderReviewQueue,
  reviewKey,
} from "@/lib/review-queue";
import { cn } from "@/lib/utils";

/**
 * Review — de echte beoordelingswachtrij, ALLEEN LEZEN.
 *
 * Bron: `useLedgerCatchup` (de bestaande catch-up-leeslaag). De toestand van
 * elk record — klaar, geblokkeerd, onbekend, geboekt — en de blokkaderedenen
 * komen ongewijzigd uit `ledger-catchup.ts`; deze pagina leidt zelf geen
 * boekbaarheid af. `onbekend` is géén `geblokkeerd` en wordt nergens als
 * boekbaar aangeboden.
 *
 * Er wordt hier niets geboekt, goedgekeurd of gewijzigd: geen mutatie, geen
 * RPC, geen bulkactie en geen databaseclient. Boeken blijft op de bestaande
 * schermen met hun eigen bevestiging.
 */

export const REVIEW_EMPTY_MESSAGE = "Geen inkoop- of verkoopfacturen om te beoordelen voor deze administratie en periode.";
export const REVIEW_NO_MATCH_MESSAGE = "Geen documenten voor deze zoekopdracht of dit filter.";
export const REVIEW_READ_ONLY_NOTE = "Alleen lezen: op deze pagina wordt niets geboekt, goedgekeurd of gewijzigd.";

interface StatePresentation {
  icon: LucideIcon;
  tone: string;
  text: string;
  notice: AccountingNoticeSeverity;
  title: string;
  explanation: string;
}

const STATE_PRESENTATION: Readonly<Record<CatchupState, StatePresentation>> = {
  klaar: {
    icon: CheckCircle2,
    tone: "bg-success/10 text-success",
    text: "text-success",
    notice: "info",
    title: "Klaar om te boeken",
    explanation:
      "Er is geen bekend beletsel. De boekingsfunctie controleert bij het boeken alles opnieuw en blijft de autoriteit.",
  },
  geblokkeerd: {
    icon: XCircle,
    tone: "bg-destructive/10 text-destructive",
    text: "text-destructive",
    notice: "blocking",
    title: "Geblokkeerd",
    explanation: "Dit document kan niet worden geboekt zolang de onderstaande redenen gelden.",
  },
  onbekend: {
    icon: CircleHelp,
    tone: "bg-warning/10 text-warning",
    text: "text-warning",
    notice: "warning",
    title: "Niet te bepalen",
    explanation:
      "De boekbaarheid kon niet worden vastgesteld. Dit is geen blokkade, maar het document wordt ook niet aangeboden om te boeken.",
  },
  geboekt: {
    icon: Lock,
    tone: "bg-muted text-muted-foreground",
    text: "text-foreground",
    notice: "info",
    title: "Geboekt",
    explanation: "Dit document staat al in het grootboek.",
  },
};

function formatDatum(iso: string | null): string {
  if (!iso) return "—";
  const [jaar, maand, dag] = iso.split("-");
  return `${dag}-${maand}-${jaar}`;
}

/** Het bronbedrag naar hele centen voor de weergave; er wordt niets berekend. */
function Bedrag({ amount, emphasis, className }: { amount: number | null; emphasis?: boolean; className?: string }) {
  if (amount === null) return <span className="text-muted-foreground">—</span>;
  return <AccountingAmount cents={Math.round(amount * 100)} emphasis={emphasis} className={className} />;
}

function StateBadge({ state, compact = false }: { state: CatchupState; compact?: boolean }) {
  const { icon: Icon, tone } = STATE_PRESENTATION[state];
  return (
    <Badge variant="outline" className={cn("border-transparent", tone, compact && "px-1.5 sm:px-2")} data-state={state}>
      <Icon aria-hidden="true" />
      <span className={cn(compact && "sr-only sm:not-sr-only")}>{REVIEW_STATE_LABELS[state]}</span>
    </Badge>
  );
}

function StateCounter({
  state,
  count,
  active,
  onToggle,
}: {
  state: CatchupState;
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  const { icon: Icon, tone, text } = STATE_PRESENTATION[state];
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      data-testid={`review-counter-${state}`}
      className={cn(
        "flex min-w-0 items-center gap-2.5 bg-card px-2.5 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-3",
        active && "bg-primary/[0.06] shadow-[inset_0_-2px_0_hsl(var(--primary))]",
      )}
    >
      <span className={cn("hidden h-7 w-7 shrink-0 items-center justify-center rounded-sm sm:flex", tone)}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block break-words text-[11px] font-semibold leading-tight text-muted-foreground sm:text-xs">
          {REVIEW_STATE_LABELS[state]}
        </span>
        <span className={cn("block font-mono text-base font-semibold leading-tight tabular-nums", text, "sm:text-foreground")}>
          {count}
        </span>
      </span>
    </button>
  );
}

function ReviewTable({
  items,
  selectedKey,
  onSelect,
}: {
  items: readonly CatchupRecord[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="min-w-0">
      <Table data-testid="review-table" className="text-[13px] [&_thead_tr]:bg-muted/40">
        <caption className="sr-only">
          Inkoop- en verkoopfacturen om te beoordelen: datum, soort, nummer, relatie, bedrag en grootboekstatus.
        </caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="hidden h-8 px-2.5 md:table-cell">Datum</TableHead>
            <TableHead scope="col" className="hidden h-8 px-2.5 md:table-cell">Soort</TableHead>
            <TableHead scope="col" className="hidden h-8 px-2.5 md:table-cell">Nummer</TableHead>
            <TableHead scope="col" className="h-8 px-2.5">Relatie</TableHead>
            <TableHead scope="col" className="h-8 px-2.5 text-right">Bedrag</TableHead>
            <TableHead scope="col" className="h-8 px-2.5">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={6} className="h-12 px-2.5 py-3 text-center text-sm text-muted-foreground" data-testid="review-no-match">
                {REVIEW_NO_MATCH_MESSAGE}
              </TableCell>
            </TableRow>
          ) : (
            items.map((item) => {
              const key = reviewKey(item);
              const selected = key === selectedKey;
              return (
                <TableRow
                  key={key}
                  data-state={selected ? "selected" : undefined}
                  data-testid={`review-row-${key}`}
                  data-review-state={item.state}
                  aria-selected={selected}
                  onClick={() => onSelect(key)}
                  className={cn("cursor-pointer", selected && "shadow-[inset_2px_0_0_hsl(var(--primary))]")}
                >
                  <TableCell className="hidden whitespace-nowrap px-2.5 py-1 font-mono text-xs tabular-nums md:table-cell">
                    {formatDatum(item.date)}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap px-2.5 py-1 text-muted-foreground md:table-cell">
                    {REVIEW_SOURCE_LABELS[item.source]}
                  </TableCell>
                  <TableCell className="hidden max-w-[140px] truncate px-2.5 py-1 font-mono text-xs md:table-cell">
                    {item.reference}
                  </TableCell>
                  <TableCell className="px-2.5 py-1 md:max-w-[160px]">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(key);
                      }}
                      aria-pressed={selected}
                      aria-label={`${item.description} — ${item.reference}`}
                      className="block w-full text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:truncate"
                    >
                      {item.description}
                    </button>
                    <span className="block text-xs text-muted-foreground md:hidden">
                      {formatDatum(item.date)} · {REVIEW_SOURCE_LABELS[item.source]} ·{" "}
                      <span className="whitespace-nowrap">{item.reference}</span>
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-2.5 py-1 text-right">
                    <Bedrag amount={item.amountInclusive} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-2.5 py-1 [&_[data-state]>span]:whitespace-nowrap">
                    <StateBadge state={item.state} compact />
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function DetailSection({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5 border-t px-4 py-3">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const DETAIL_CARD =
  "rounded-none border-0 border-t bg-transparent shadow-none xl:sticky xl:top-16 xl:border-l xl:border-t-0";

function ReviewDetailPanel({ item }: { item: CatchupRecord | null }) {
  if (!item) {
    return (
      <Card className={DETAIL_CARD} data-testid="review-detail">
        <CardContent className="flex h-24 items-center justify-center p-4 text-sm text-muted-foreground">
          Kies een document om de details te bekijken.
        </CardContent>
      </Card>
    );
  }
  const presentation = STATE_PRESENTATION[item.state];
  const bron = resolveLedgerSource(item.source === "inkoop" ? "purchase_invoice" : "sales_invoice", item.id);
  return (
    <Card className={DETAIL_CARD} data-testid="review-detail" aria-label={`Details: ${item.description} ${item.reference}`}>
      <CardHeader className="space-y-1 bg-muted/30 px-4 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {REVIEW_SOURCE_LABELS[item.source]} · {formatDatum(item.date)} ·{" "}
              <span className="whitespace-nowrap">{item.reference}</span>
            </p>
            <CardTitle className="mt-0.5 break-words text-sm font-semibold">{item.description}</CardTitle>
          </div>
          <div className="shrink-0 text-right">
            <Bedrag amount={item.amountInclusive} emphasis className="text-base" />
            <div className="mt-1">
              <StateBadge state={item.state} />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <AccountingNotice
          className="m-4 mt-3 w-auto py-2.5"
          severity={presentation.notice}
          title={presentation.title}
          data-testid="review-state-notice"
        >
          <p>{presentation.explanation}</p>
          {item.blocks.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4" data-testid="review-blocks">
              {item.blocks.map((b) => (
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
        </AccountingNotice>

        <DetailSection icon={FileText} title="Brondocument">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]" data-testid="review-source">
            <Field label="Soort">{REVIEW_SOURCE_LABELS[item.source]}factuur</Field>
            <Field label="Nummer">
              <span className="font-mono text-xs">{item.reference}</span>
            </Field>
            <Field label="Relatie">{item.description}</Field>
            <Field label="Factuurdatum">
              <span className="font-mono text-xs tabular-nums">{formatDatum(item.date)}</span>
            </Field>
            <Field label="Bedrag incl. BTW">
              <Bedrag amount={item.amountInclusive} />
            </Field>
            <Field label="Documentstatus">{item.documentStatus}</Field>
            {item.postingGroupId && (
              <Field label="Boekingsgroep">
                <span className="break-all font-mono text-xs" data-testid="review-posting-group">
                  {item.postingGroupId}
                </span>
              </Field>
            )}
          </dl>
          {bron.kind === "resolved" && (
            <Link
              to={bron.path}
              className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-primary underline-offset-4 hover:underline"
              data-testid="review-source-link"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Brondocument openen
            </Link>
          )}
        </DetailSection>

        <p className="border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground" data-testid="review-read-only">
          {REVIEW_READ_ONLY_NOTE}
        </p>
      </CardContent>
    </Card>
  );
}

export default function Review() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const clientId = hasSpecificClient ? selectedClientId : undefined;

  const [year, setYear] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<CatchupState | null>(null);
  const [sourceFilter, setSourceFilter] = useState<CatchupSource | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const catchup = useLedgerCatchup(clientId, { year });
  const selectedClient = clients?.find((c) => c.id === selectedClientId);
  const years = recentYears();

  const records = useMemo(() => orderReviewQueue(catchup.data?.records ?? []), [catchup.data]);
  const counts = useMemo(() => summarize(records), [records]);
  const sourceCounts = useMemo(() => countBySource(records), [records]);
  const visible = useMemo(
    () => filterReviewQueue(records, { search, state: stateFilter, source: sourceFilter }),
    [records, search, stateFilter, sourceFilter],
  );
  // Het paneel toont alleen een document dat in de gefilterde wachtrij zichtbaar
  // is. Valt de selectie weg (zoeken, filter, ander jaar of andere
  // administratie), dan wordt het eerste zichtbare document gekozen; zonder
  // zichtbare documenten blijft het paneel leeg.
  const selected = visible.find((r) => reviewKey(r) === selectedKey) ?? visible[0] ?? null;
  const shownKey = selected ? reviewKey(selected) : null;
  if (shownKey !== selectedKey) setSelectedKey(shownKey);

  const renderBody = () => {
    if (catchup.isPending) {
      return (
        <div className="space-y-2 p-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Wachtrij laden…</span>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      );
    }
    if (catchup.isError) {
      return (
        <div className="p-3">
          <Alert variant="destructive" data-testid="review-error">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>De wachtrij kon niet worden geladen</AlertTitle>
            <AlertDescription>
              <p>{(catchup.error as { message?: string } | null)?.message ?? "Onbekende fout"}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => catchup.refetch()}>
                Opnieuw proberen
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      );
    }
    if (records.length === 0) {
      return (
        <div data-testid="review-empty">
          <EmptyState icon={ClipboardCheck} message={REVIEW_EMPTY_MESSAGE} />
        </div>
      );
    }
    return (
      <div className="grid xl:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <ReviewTable items={visible} selectedKey={shownKey} onSelect={setSelectedKey} />
        <ReviewDetailPanel item={selected} />
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        title="Review"
        description="Inkoop- en verkoopfacturen met hun grootboekstatus, uit de bestaande boekingscontrole. Alleen lezen."
      >
        {hasSpecificClient && catchup.data && records.length > 0 && (
          <div
            className="grid w-full grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:w-auto sm:grid-cols-4"
            role="group"
            aria-label="Filter op grootboekstatus"
          >
            {REVIEW_STATE_ORDER.map((state) => (
              <StateCounter
                key={state}
                state={state}
                count={counts[state]}
                active={stateFilter === state}
                onToggle={() => setStateFilter((huidig) => (huidig === state ? null : state))}
              />
            ))}
          </div>
        )}
      </PageHeader>

      <div className="mb-3 flex flex-col gap-2 rounded-md border bg-card px-3 py-2 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-4" data-testid="review-toolbar">
        <Select value={selectedClientId} onValueChange={setSelectedClientId}>
          <SelectTrigger className="h-8 w-full text-[13px] lg:w-56" aria-label="Administratie">
            <span className="truncate">{selectedClient ? selectedClient.name : "Alle administraties"}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle administraties</SelectItem>
            {clients?.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="review-year-filters">
          <span className="mr-0.5 text-xs font-medium text-muted-foreground">Jaar</span>
          <FilterChip label="Alle jaren" active={year === null} onClick={() => setYear(null)} />
          {years.map((y) => (
            <FilterChip key={y} label={String(y)} active={year === y} onClick={() => setYear(y)} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="review-source-filters">
          <span className="mr-0.5 text-xs font-medium text-muted-foreground">Soort</span>
          <FilterChip label="Alles" active={sourceFilter === null} count={records.length} onClick={() => setSourceFilter(null)} />
          {(["inkoop", "verkoop"] as const).map((s) => (
            <FilterChip
              key={s}
              label={REVIEW_SOURCE_LABELS[s]}
              active={sourceFilter === s}
              count={sourceCounts[s]}
              onClick={() => setSourceFilter((huidig) => (huidig === s ? null : s))}
            />
          ))}
        </div>
        <div className="relative w-full lg:ml-auto lg:w-64">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Zoek op nummer, relatie, status"
            aria-label="Zoeken in de wachtrij"
            className="h-8 pl-8 text-[13px]"
          />
        </div>
      </div>

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om de wachtrij te bekijken." />
      ) : (
        <div className="overflow-hidden rounded-md border bg-card" data-testid="review-workspace">
          <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs text-muted-foreground">
            <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {catchup.data ? `${visible.length} van ${records.length} documenten` : "Wachtrij"}
            </span>
          </div>
          {renderBody()}
        </div>
      )}
    </div>
  );
}
