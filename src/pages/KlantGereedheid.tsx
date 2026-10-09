import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleHelp,
  Info,
  Loader2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { FilterChip } from "@/components/FilterChip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useClients } from "@/hooks/useClients";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useLedgerCompleteness, useOpeningBalanceCompleteness } from "@/hooks/useLedgerCompleteness";
import { useLedgerCatchup } from "@/hooks/useLedgerCatchup";
import { usePaginatedBankTransactions } from "@/hooks/useBankTransactions";
import { recentYears } from "@/lib/grootboek-saldi-utils";
import { summarize } from "@/lib/ledger-catchup";
import {
  EVIDENCE_STATUS_LABELS,
  bankRow,
  beginbalansRow,
  countByStatus,
  historischRow,
  instellingenRow,
  rekeningschemaRow,
  volledigheidRow,
  type EvidenceRow,
  type EvidenceStatus,
  type SourceRead,
} from "@/lib/client-readiness-overview";
import { cn } from "@/lib/utils";

/**
 * Administratie-gereedheid (/klanten/:clientId/gereedheid) — ALLEEN LEZEN.
 *
 * Elke regel komt uit een bestaand leesmodel; zie `client-readiness-overview.ts`
 * voor welke bron welke regel voedt. Deze pagina berekent zelf geen gereedheid,
 * geeft geen totaaloordeel en schrijft niets: geen mutatie, geen RPC, geen
 * databaseclient. Een bron die niet gelezen kon worden, staat op "Niet te
 * bepalen" — nooit op "In orde".
 */

export const READINESS_NO_VERDICT_NOTE =
  "Er is bewust geen totaaloordeel: elke regel staat op zichzelf en zegt alleen wat de bestaande controle vaststelt.";

interface StatusPresentation {
  icon: LucideIcon;
  tone: string;
}

const STATUS_PRESENTATION: Readonly<Record<EvidenceStatus, StatusPresentation>> = {
  in_orde: { icon: CheckCircle2, tone: "bg-success/10 text-success" },
  aandacht: { icon: AlertTriangle, tone: "bg-warning/10 text-warning" },
  geblokkeerd: { icon: XCircle, tone: "bg-destructive/10 text-destructive" },
  niet_te_bepalen: { icon: CircleHelp, tone: "bg-muted text-foreground" },
  informatief: { icon: Info, tone: "bg-info/10 text-info" },
  laden: { icon: Loader2, tone: "bg-muted text-muted-foreground" },
};

const STATUS_ORDER: readonly EvidenceStatus[] = ["geblokkeerd", "aandacht", "niet_te_bepalen", "in_orde", "informatief"];

function StatusBadge({ status }: { status: EvidenceStatus }) {
  const { icon: Icon, tone } = STATUS_PRESENTATION[status];
  return (
    <Badge variant="outline" className={cn("shrink-0 whitespace-nowrap border-transparent", tone)} data-status={status}>
      <Icon className={cn(status === "laden" && "animate-spin")} aria-hidden="true" />
      <span>{EVIDENCE_STATUS_LABELS[status]}</span>
    </Badge>
  );
}

function errorMessage(error: unknown): string | undefined {
  return (error as { message?: string } | null)?.message ?? undefined;
}

function toRead<T>(q: { isPending: boolean; isError: boolean; error?: unknown }, value: T | undefined): SourceRead<T> {
  if (q.isError) return { kind: "error", message: errorMessage(q.error) };
  if (q.isPending || value === undefined) return { kind: "loading" };
  return { kind: "ok", value };
}

function EvidenceItem({ row, onRetry }: { row: EvidenceRow; onRetry?: () => void }) {
  return (
    <li
      className="grid gap-x-4 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-start sm:px-4"
      data-testid={`readiness-row-${row.key}`}
      data-status={row.status}
    >
      <div className="flex items-center justify-between gap-2 sm:block">
        <h2 className="text-[13px] font-semibold leading-5">{row.title}</h2>
        <div className="sm:mt-1">
          <StatusBadge status={row.status} />
        </div>
      </div>
      <div className="min-w-0 text-[13px] leading-5">
        <p>{row.summary}</p>
        {row.details.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground" data-testid={`readiness-details-${row.key}`}>
            {row.details.map((d) => (
              <li key={d} className="break-words">{d}</li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          Bron: <span className="font-mono">{row.source}</span>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:flex-col sm:items-end">
        {row.links.map((l) => (
          <Link key={l.to} to={l.to} className="whitespace-nowrap text-[13px] font-medium text-primary underline-offset-4 hover:underline">
            {l.label}
          </Link>
        ))}
        {row.retryable && onRetry && (
          <Button type="button" variant="outline" size="sm" className="h-7" onClick={onRetry}>
            Opnieuw proberen
          </Button>
        )}
      </div>
    </li>
  );
}

export default function KlantGereedheid() {
  const { clientId: routeClientId = "" } = useParams<{ clientId: string }>();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const [year, setYear] = useState(() => new Date().getFullYear());

  const clientsQuery = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const client = clientsQuery.data?.find((c) => c.id === routeClientId);
  // Pas lezen zodra vaststaat dat deze administratie in de actieve organisatie bestaat.
  const clientId = client ? client.id : undefined;

  const accountsQuery = useGrootboekrekeningen({ organizationId: activeOrganizationId ?? undefined, enabled: orgEnabled });
  const period = useMemo(() => ({ from: `${year}-01-01`, toExclusive: `${year + 1}-01-01` }), [year]);
  const openingBalance = useOpeningBalanceCompleteness(clientId, period);
  const completeness = useLedgerCompleteness(clientId);
  const catchup = useLedgerCatchup(clientId, { year });
  const bankNewest = usePaginatedBankTransactions({ clientId, page: 1, pageSize: 1, sortField: "date", sortDir: "desc", enabled: !!clientId });
  const bankOldest = usePaginatedBankTransactions({ clientId, page: 1, pageSize: 1, sortField: "date", sortDir: "asc", enabled: !!clientId });

  const rows = useMemo<EvidenceRow[]>(() => {
    if (!client) return [];
    const accounts = accountsQuery.data;
    const bankError = bankNewest.isError ? bankNewest.error : bankOldest.isError ? bankOldest.error : null;
    const bankRead: Parameters<typeof bankRow>[0] = bankError
      ? { kind: "error", message: errorMessage(bankError) }
      : !bankNewest.data || !bankOldest.data
        ? { kind: "loading" }
        : {
            kind: "ok",
            value: {
              total: bankNewest.data.total,
              lastDate: bankNewest.data.transactions[0]?.transaction_date ?? null,
              firstDate: bankOldest.data.transactions[0]?.transaction_date ?? null,
              ibans: (client.ibans ?? []).filter(Boolean),
            },
          };
    return [
      rekeningschemaRow(toRead(accountsQuery, accounts), client.id),
      instellingenRow(toRead(accountsQuery, accounts ? { client, accounts } : undefined)),
      beginbalansRow(
        openingBalance.isError
          ? { kind: "error" }
          : openingBalance.data
            ? { kind: "ok", value: openingBalance.data }
            : { kind: "loading" },
      ),
      volledigheidRow(toRead(completeness, completeness.data)),
      historischRow(toRead(catchup, catchup.data ? summarize(catchup.data.records) : undefined), `boekjaar ${year}`),
      bankRow(bankRead),
    ];
  }, [client, accountsQuery, openingBalance, completeness, catchup, bankNewest, bankOldest, year]);

  const retry: Partial<Record<EvidenceRow["key"], () => void>> = {
    rekeningschema: () => accountsQuery.refetch(),
    instellingen: () => accountsQuery.refetch(),
    volledigheid: () => completeness.refetch(),
    historisch: () => catchup.refetch(),
    bank: () => {
      bankNewest.refetch();
      bankOldest.refetch();
    },
  };

  const counts = countByStatus(rows);

  const back = (
    <Button size="sm" variant="outline" asChild>
      <Link to="/klanten">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Naar Administraties
      </Link>
    </Button>
  );

  if (clientsQuery.isPending || !isReady) {
    return (
      <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">Administratie laden…</span>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (clientsQuery.isError || !client) {
    return (
      <>
        <PageHeader title="Administratie-gereedheid">{back}</PageHeader>
        <div className="rounded-md border bg-card" data-testid="readiness-client-missing">
          <EmptyState
            icon={CircleHelp}
            message={
              clientsQuery.isError
                ? "De administraties konden niet worden gelezen; de gereedheid is niet te bepalen."
                : "Deze administratie bestaat niet in de actieve organisatie."
            }
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={client.name}
        description="Administratie-gereedheid: wat de bestaande controles over deze administratie vaststellen. Alleen lezen."
      >
        {back}
      </PageHeader>

      <div className="mb-3 flex flex-col gap-2 rounded-md border bg-card px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="readiness-year-filters">
          <span className="mr-0.5 text-xs font-medium text-muted-foreground">Boekjaar</span>
          {recentYears().map((y) => (
            <FilterChip key={y} label={String(y)} active={year === y} onClick={() => setYear(y)} />
          ))}
        </div>
        <p className="text-xs text-muted-foreground sm:ml-auto">
          Het boekjaar geldt voor de beginbalans en de historische boekingen; de overige regels gelden voor de hele administratie.
        </p>
      </div>

      <div className="overflow-hidden rounded-md border bg-card" data-testid="readiness-workspace">
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground sm:px-4"
          data-testid="readiness-counts"
        >
          {STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <span key={s} className="whitespace-nowrap">
              {EVIDENCE_STATUS_LABELS[s]}: <span className="font-mono font-semibold text-foreground">{counts[s]}</span>
            </span>
          ))}
          {counts.laden > 0 && <span>Nog {counts.laden} aan het laden…</span>}
        </div>
        <ul className="divide-y" aria-label="Bewijsregels">
          {rows.map((row) => (
            <EvidenceItem key={row.key} row={row} onRetry={retry[row.key]} />
          ))}
        </ul>
        <p className="border-t bg-muted/20 px-3 py-2 text-xs text-muted-foreground sm:px-4" data-testid="readiness-no-verdict">
          {READINESS_NO_VERDICT_NOTE} Op deze pagina wordt niets geboekt, geïmporteerd of gewijzigd.
        </p>
      </div>
    </>
  );
}
