import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ChevronLeft, ChevronRight, CheckCircle2, Clock, Download } from "lucide-react";
import { formatEuro } from "@/lib/format";

/**
 * Presentational header for the purchase-invoice processing workspace.
 * Owns no state: everything is passed in from the workspace page.
 *
 * Row 1: back · supplier + invoice number · workflow status · prev/next.
 * Row 2 (metadata): date · administratie · total incl. (when available).
 */
export interface PurchaseInvoiceWorkspaceHeaderProps {
  supplier: string;
  invoiceNumber: string;
  invoiceDate: string;
  /** Stored workflow status: te_controleren | gecontroleerd | geexporteerd | … */
  status: string;
  isBtwVrijgesteld: boolean;
  clientName: string | null;
  /** Header total incl. BTW as currently entered; null when not (yet) known. */
  totalIncl: number | null;
  hasPrev: boolean;
  hasNext: boolean;
  /** 0-based index within the navigable set, or -1 when unknown. */
  currentIndex: number;
  totalCount: number;
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
}

function WorkflowStatusBadge({ status }: { status: string }) {
  // Same three labels the workspace always showed — no new status values.
  if (status === "gecontroleerd") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200"
      >
        <CheckCircle2 className="h-3 w-3" /> Gecontroleerd
      </Badge>
    );
  }
  if (status === "geexporteerd") {
    return (
      <Badge variant="outline" className="gap-1">
        <Download className="h-3 w-3" /> Geëxporteerd
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Clock className="h-3 w-3" /> Te controleren
    </Badge>
  );
}

export function PurchaseInvoiceWorkspaceHeader({
  supplier,
  invoiceNumber,
  invoiceDate,
  status,
  isBtwVrijgesteld,
  clientName,
  totalIncl,
  hasPrev,
  hasNext,
  currentIndex,
  totalCount,
  onBack,
  onPrev,
  onNext,
}: PurchaseInvoiceWorkspaceHeaderProps) {
  const dateLabel = invoiceDate ? new Date(invoiceDate).toLocaleDateString("nl-NL") : "geen datum";
  const position = currentIndex >= 0 ? `${currentIndex + 1} / ${totalCount}` : "—";

  return (
    <header className="space-y-1.5">
      {/* Shell header already shows the "Inkoop › Details" breadcrumb; keep an sr-only h1 for a11y. */}
      <h1 className="sr-only">Inkoopfactuur verwerken</h1>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="-ml-2 shrink-0" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 sm:mr-2" />
          <span className="hidden sm:inline">Inkoopoverzicht</span>
          <span className="sr-only sm:hidden">Terug naar inkoopoverzicht</span>
        </Button>

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-base font-semibold leading-tight">
            {supplier || "Onbekende leverancier"}
          </span>
          <span className="font-mono text-sm text-muted-foreground">
            {invoiceNumber || "geen nummer"}
          </span>
          <WorkflowStatusBadge status={status} />
          {isBtwVrijgesteld && <Badge variant="secondary">BTW-vrijgesteld</Badge>}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={onPrev}
            disabled={!hasPrev}
            title="Vorige factuur"
            aria-label="Vorige factuur"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="w-14 text-center font-mono text-xs tabular-nums text-muted-foreground">
            {position}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={onNext}
            disabled={!hasNext}
            title="Volgende factuur"
            aria-label="Volgende factuur"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <dl className="flex flex-wrap items-center gap-x-4 gap-y-0.5 pl-1 text-xs text-muted-foreground sm:pl-0">
        <div className="flex items-center gap-1">
          <dt className="sr-only">Factuurdatum</dt>
          <dd>{dateLabel}</dd>
        </div>
        {clientName && (
          <div className="flex items-center gap-1">
            <dt className="sr-only">Administratie</dt>
            <dd className="truncate">{clientName}</dd>
          </div>
        )}
        {totalIncl != null && (
          <div className="flex items-center gap-1">
            <dt className="sr-only">Totaal incl. BTW</dt>
            <dd className="font-mono tabular-nums text-foreground">{formatEuro(totalIncl)}</dd>
          </div>
        )}
      </dl>
    </header>
  );
}
