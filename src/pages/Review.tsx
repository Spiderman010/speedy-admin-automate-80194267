import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ExternalLink,
  FileText,
  History,
  Info,
  Paperclip,
  RotateCcw,
  Search,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { AccountingAmount } from "@/components/platform/AccountingAmount";
import { AccountingNotice, type AccountingNoticeSeverity } from "@/components/platform/AccountingNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  REVIEW_EXAMPLE_ADMINISTRATION,
  REVIEW_EXAMPLE_ITEMS,
  REVIEW_EXAMPLE_PERIOD,
  REVIEW_STATUS_LABELS,
  REVIEW_TYPE_LABELS,
  countByStatus,
  filterReviewItems,
  proposalTotals,
  type ReviewItem,
  type ReviewStatus,
} from "@/lib/review-workspace-mock";

/**
 * Review — VISUEEL PROTOTYPE.
 *
 * Deze pagina toont uitsluitend lokale voorbeelddata
 * (`src/lib/review-workspace-mock.ts`). Er wordt niets opgehaald en niets
 * geschreven: geen Supabase-client, geen query, geen RPC, geen mutatie. De
 * actieknoppen zijn uitgeschakeld en dragen de tekst "Voorbeeld — geen
 * boeking". Alleen selecteren, zoeken en filteren werken, en die blijven
 * binnen deze pagina.
 */

const NO_BOOKING = "Voorbeeld — geen boeking";

interface StatusPresentation {
  icon: LucideIcon;
  /** Tekst- en achtergrondtint op de tokens van het ontwerpsysteem. */
  tone: string;
  /** Alleen de teksttint, voor een los icoon. */
  text: string;
  notice: AccountingNoticeSeverity;
}

const STATUS_PRESENTATION: Readonly<Record<ReviewStatus, StatusPresentation>> = {
  klaar: { icon: CheckCircle2, tone: "bg-success/10 text-success", text: "text-success", notice: "info" },
  aandacht: { icon: AlertTriangle, tone: "bg-warning/10 text-warning", text: "text-warning", notice: "warning" },
  geblokkeerd: { icon: XCircle, tone: "bg-destructive/10 text-destructive", text: "text-destructive", notice: "blocking" },
};

const STATUS_ORDER: readonly ReviewStatus[] = ["klaar", "aandacht", "geblokkeerd"];

function formatDatum(iso: string): string {
  const [jaar, maand, dag] = iso.split("-");
  return `${dag}-${maand}-${jaar}`;
}

function StatusBadge({ status, compact = false }: { status: ReviewStatus; compact?: boolean }) {
  const { icon: Icon, tone } = STATUS_PRESENTATION[status];
  return (
    <Badge variant="outline" className={cn("border-transparent", tone, compact && "px-1.5 sm:px-2")} data-status={status}>
      <Icon aria-hidden="true" />
      {/* Compact: op de kleinste schermen alleen het icoon (vorm verschilt per status), het label blijft voor schermlezers. */}
      <span className={cn(compact && "sr-only sm:not-sr-only")}>{REVIEW_STATUS_LABELS[status]}</span>
    </Badge>
  );
}

function StatusCounter({
  status,
  count,
  active,
  onToggle,
}: {
  status: ReviewStatus;
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  const { icon: Icon, tone, text } = STATUS_PRESENTATION[status];
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      data-testid={`review-counter-${status}`}
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-none bg-card px-2.5 py-1.5 text-left sm:px-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active && "bg-primary/[0.06] shadow-[inset_0_-2px_0_hsl(var(--primary))]",
      )}
    >
      <span className={cn("hidden h-7 w-7 shrink-0 items-center justify-center rounded-sm sm:flex", tone)}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block break-words text-[11px] font-semibold leading-tight text-muted-foreground sm:text-xs">
          {REVIEW_STATUS_LABELS[status]}
        </span>
        <span className={cn("block font-mono text-base font-semibold leading-tight tabular-nums", text, "sm:text-foreground")}>{count}</span>
      </span>
    </button>
  );
}

function ReviewToolbar({ search, onSearch }: { search: string; onSearch: (value: string) => void }) {
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
      data-testid="review-toolbar"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-xs text-muted-foreground">Administratie</span>
        <span className="truncate font-medium">{REVIEW_EXAMPLE_ADMINISTRATION}</span>
      </div>
      <Separator orientation="vertical" className="hidden h-5 sm:block" />
      <div className="flex items-center gap-1.5">
        <Calendar className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs text-muted-foreground">Periode</span>
        <span className="font-medium">{REVIEW_EXAMPLE_PERIOD}</span>
      </div>
      <div className="relative order-last w-full sm:order-none sm:ml-auto sm:w-64">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Zoek relatie, omschrijving of kenmerk"
          aria-label="Zoeken in voorbeeldregels"
          className="h-8 pl-8 text-sm"
        />
      </div>
      <Badge variant="info" className="shrink-0">
        Voorbeelddata
      </Badge>
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
        aria-label="Gebruiker (voorbeeld)"
        role="img"
      >
        AF
      </span>
    </div>
  );
}

function ReviewTable({
  items,
  selectedId,
  onSelect,
}: {
  items: readonly ReviewItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="min-w-0 overflow-hidden rounded-none border-0 bg-transparent shadow-none">
      <Table data-testid="review-table" className="text-[13px] [&_thead_tr]:bg-muted/40">
        <caption className="sr-only">Voorbeeldregels om te beoordelen: datum, type, relatie, omschrijving, bedrag en status.</caption>
        <TableHeader>
          <TableRow>
            <TableHead className="hidden h-8 px-2.5 md:table-cell">Datum</TableHead>
            <TableHead className="hidden h-8 px-2.5 md:table-cell">Type</TableHead>
            <TableHead className="hidden h-8 px-2.5 md:table-cell">Relatie</TableHead>
            <TableHead className="h-8 px-2.5">Omschrijving</TableHead>
            <TableHead className="h-8 px-2.5 text-right">Bedrag</TableHead>
            <TableHead className="h-8 px-2.5">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="h-24 px-2.5 text-center text-muted-foreground">
                Geen voorbeeldregels voor deze zoekopdracht of dit filter.
              </TableCell>
            </TableRow>
          ) : (
            items.map((item) => {
              const selected = item.id === selectedId;
              return (
                <TableRow
                  key={item.id}
                  data-state={selected ? "selected" : undefined}
                  data-testid={`review-row-${item.id}`}
                  aria-selected={selected}
                  onClick={() => onSelect(item.id)}
                  className={cn("cursor-pointer", selected && "shadow-[inset_2px_0_0_hsl(var(--primary))]")}
                >
                  <TableCell className="hidden whitespace-nowrap px-2.5 py-1 font-mono text-xs tabular-nums md:table-cell">{formatDatum(item.datum)}</TableCell>
                  <TableCell className="hidden whitespace-nowrap px-2.5 py-1 text-muted-foreground md:table-cell">
                    {REVIEW_TYPE_LABELS[item.type]}
                  </TableCell>
                  <TableCell className="hidden max-w-[130px] truncate px-2.5 py-1 font-medium md:table-cell">{item.relatie}</TableCell>
                  <TableCell className="px-2.5 py-1 md:max-w-[150px] 2xl:max-w-[180px]">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(item.id);
                      }}
                      aria-pressed={selected}
                      className="block w-full text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:truncate"
                    >
                      {item.omschrijving}
                    </button>
                    <span className="block text-xs text-muted-foreground md:hidden">
                      {formatDatum(item.datum)} · {item.relatie} · {REVIEW_TYPE_LABELS[item.type]}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-2.5 py-1 text-right">
                    <AccountingAmount cents={item.bedragCents} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-2.5 py-1 [&_[data-status]>span]:whitespace-nowrap">
                    <StatusBadge status={item.status} compact />
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </Card>
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

function ReviewDetailPanel({ item }: { item: ReviewItem | null }) {
  if (!item) {
    return (
      <Card className="rounded-none border-0 border-t bg-transparent shadow-none xl:sticky xl:top-16 xl:border-l xl:border-t-0" data-testid="review-detail">
        <CardContent className="flex h-24 items-center justify-center p-4 text-sm text-muted-foreground">Kies een regel om de details te bekijken.</CardContent>
      </Card>
    );
  }
  const totals = proposalTotals(item.voorstel);
  return (
    <Card className="rounded-none border-0 border-t bg-transparent shadow-none xl:sticky xl:top-16 xl:border-l xl:border-t-0" data-testid="review-detail" aria-label={`Details: ${item.omschrijving}`}>
      <CardHeader className="space-y-1 bg-muted/30 px-4 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {REVIEW_TYPE_LABELS[item.type]} · {formatDatum(item.datum)} · {item.referentie}
            </p>
            <CardTitle className="mt-0.5 truncate text-sm font-semibold">{item.relatie}</CardTitle>
            <p className="truncate text-[13px] text-muted-foreground">{item.omschrijving}</p>
          </div>
          <div className="shrink-0 text-right">
            <AccountingAmount cents={item.bedragCents} emphasis className="text-base" />
            <div className="mt-1">
              <StatusBadge status={item.status} />
            </div>
          </div>
        </div>
      </CardHeader>
      <Separator />
      <CardContent className="p-0">
        <AccountingNotice className="m-4 mt-3 w-auto py-2.5" severity={STATUS_PRESENTATION[item.status].notice} title={REVIEW_STATUS_LABELS[item.status]}>
          {item.reden}
        </AccountingNotice>

        <DetailSection icon={FileText} title="Boekingsvoorstel (voorbeeld)">
          <div className="overflow-hidden rounded-sm border">
            <Table className="text-xs [&_thead_tr]:bg-muted/40" data-testid="review-proposal">
              <TableHeader>
                <TableRow>
                  <TableHead className="h-7 px-2">Rekening</TableHead>
                  <TableHead className="h-7 px-2 text-right">Debet</TableHead>
                  <TableHead className="h-7 px-2 text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {item.voorstel.map((line, index) => (
                  <TableRow key={`${line.rekening}-${index}`}>
                    <TableCell className="px-2 py-1">
                      <span className="block font-medium">{line.rekening}</span>
                      <span className="block text-muted-foreground">{line.omschrijving}</span>
                    </TableCell>
                    <TableCell className="px-2 py-1 text-right">
                      <AccountingAmount cents={line.debetCents} blankWhenZero />
                    </TableCell>
                    <TableCell className="px-2 py-1 text-right">
                      <AccountingAmount cents={line.creditCents} blankWhenZero />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="px-2 py-1">Totaal</TableCell>
                  <TableCell className="px-2 py-1 text-right">
                    <AccountingAmount cents={totals.debetCents} emphasis />
                  </TableCell>
                  <TableCell className="px-2 py-1 text-right">
                    <AccountingAmount cents={totals.creditCents} emphasis />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </DetailSection>

        <DetailSection icon={Info} title="Toelichting">
          <p className="text-[13px] leading-snug">{item.toelichting}</p>
        </DetailSection>

        <DetailSection icon={Paperclip} title="Bijlagen">
          <div className="rounded-sm border border-dashed px-2.5 py-2 text-xs text-muted-foreground" data-testid="review-attachments">
            {item.bijlagen.length === 0 ? (
              <p>Geen bijlage bij dit voorbeeld.</p>
            ) : (
              <ul className="space-y-1">
                {item.bijlagen.map((naam) => (
                  <li key={naam} className="flex items-center gap-1.5">
                    <Paperclip className="h-3 w-3" aria-hidden="true" />
                    <span className="font-medium text-foreground">{naam}</span>
                    <span>— voorbeeld, geen document</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DetailSection>

        <DetailSection icon={History} title="Activiteit">
          <ol className="space-y-1.5 border-l pl-3 text-xs" data-testid="review-activity">
            {item.activiteit.map((regel) => (
              <li key={`${regel.moment}-${regel.tekst}`}>
                <span className="font-mono tabular-nums text-muted-foreground">{regel.moment}</span>
                <span className="ml-2">{regel.tekst}</span>
              </li>
            ))}
          </ol>
        </DetailSection>

        <Separator />

        <div className="space-y-2 bg-muted/20 px-4 py-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled title={NO_BOOKING}>
              <CheckCircle2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Goedkeuren
            </Button>
            <Button size="sm" variant="outline" disabled title={NO_BOOKING}>
              <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Terugzetten
            </Button>
            <Button size="sm" variant="ghost" disabled title={NO_BOOKING}>
              <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Openen
            </Button>
          </div>
          <p className="text-xs font-medium text-muted-foreground" data-testid="review-no-booking">
            {NO_BOOKING}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Review() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ReviewStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(REVIEW_EXAMPLE_ITEMS[0]?.id ?? null);

  const counts = useMemo(() => countByStatus(REVIEW_EXAMPLE_ITEMS), []);
  const visible = useMemo(() => filterReviewItems(REVIEW_EXAMPLE_ITEMS, search, statusFilter), [search, statusFilter]);
  // Het paneel toont alleen een regel die in de gefilterde tabel zichtbaar is.
  // Valt de selectie weg door zoeken of een statusfilter, dan wordt de eerste
  // zichtbare regel gekozen; zonder zichtbare regels blijft het paneel leeg.
  const selected = visible.find((item) => item.id === selectedId) ?? visible[0] ?? null;
  if (selected !== null && selected.id !== selectedId) setSelectedId(selected.id);

  return (
    <div>
      <ReviewToolbar search={search} onSearch={setSearch} />

      <PageHeader
        title="Review"
        description="Beoordeel inkoop, verkoop, bank en memoriaal op één plek. Prototype met voorbeelddata — er wordt niets opgehaald of geboekt."
      >
        <div className="grid w-full grid-cols-3 gap-px overflow-hidden rounded-md border bg-border shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:w-auto" role="group" aria-label="Filter op status">
          {STATUS_ORDER.map((status) => (
            <StatusCounter
              key={status}
              status={status}
              count={counts[status]}
              active={statusFilter === status}
              onToggle={() => setStatusFilter((huidig) => (huidig === status ? null : status))}
            />
          ))}
        </div>
      </PageHeader>

      <div className="grid rounded-md border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)] xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_440px]">
        <ReviewTable items={visible} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
        <ReviewDetailPanel item={selected} />
      </div>
    </div>
  );
}
