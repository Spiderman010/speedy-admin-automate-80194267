import { useMemo } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowLeft, CircleHelp, Info, Landmark, Loader2, Scale, type LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NoClientBanner } from "@/components/NoClientBanner";
import { EmptyState } from "@/components/EmptyState";
import { AccountingAmount } from "@/components/platform/AccountingAmount";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useClientContext } from "@/hooks/useClientContext";
import { useClients } from "@/hooks/useClients";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useLedgerPostings } from "@/hooks/useLedgerPostings";
import { usePaginatedBankTransactions } from "@/hooks/useBankTransactions";
import { ALL_TIME_PERIOD } from "@/lib/grootboek-saldi-utils";
import { buildAccountReport, LedgerReportingError } from "@/lib/ledger-reporting";
import {
  BANK_OVERVIEW_STATUS_LABELS,
  KRUISPOSTEN_NUMMER,
  bankImportSection,
  kruispostenSection,
  type BankImportFacts,
  type BankOverviewStatus,
  type KruispostenReportRead,
  type SourceRead,
} from "@/lib/bank-reconciliation-overview";
import { cn } from "@/lib/utils";

/**
 * Bankafstemming-overzicht (/bank/afstemming) — ALLEEN LEZEN.
 *
 * Feiten uit bestaande leesmodellen; zie `bank-reconciliation-overview.ts`.
 * Geen afstemming, geen matching, geen import, geen boeking en geen
 * databaseclient. Een onleesbare bron is "Niet te bepalen", nooit een saldo.
 */

export const BANK_OVERVIEW_READ_ONLY_NOTE =
  "Alleen lezen: dit overzicht stemt niets af, importeert niets en boekt niets.";

const STATUS_PRESENTATION: Readonly<Record<BankOverviewStatus, { icon: LucideIcon; tone: string }>> = {
  informatief: { icon: Info, tone: "bg-info/10 text-info" },
  aandacht: { icon: AlertTriangle, tone: "bg-warning/10 text-warning" },
  niet_te_bepalen: { icon: CircleHelp, tone: "bg-muted text-foreground" },
  laden: { icon: Loader2, tone: "bg-muted text-muted-foreground" },
};

function StatusBadge({ status }: { status: BankOverviewStatus }) {
  const { icon: Icon, tone } = STATUS_PRESENTATION[status];
  return (
    <Badge variant="outline" className={cn("shrink-0 whitespace-nowrap border-transparent", tone)} data-status={status}>
      <Icon className={cn(status === "laden" && "animate-spin")} aria-hidden="true" />
      <span>{BANK_OVERVIEW_STATUS_LABELS[status]}</span>
    </Badge>
  );
}

function errorMessage(error: unknown): string | undefined {
  return (error as { message?: string } | null)?.message ?? undefined;
}

function nlDatum(iso: string | null): string {
  if (!iso) return "—";
  const [j, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${j}`;
}

function Section({
  testId,
  icon: Icon,
  title,
  status,
  summary,
  onRetry,
  errorText,
  children,
}: {
  testId: string;
  icon: LucideIcon;
  title: string;
  status: BankOverviewStatus;
  summary: string;
  onRetry?: () => void;
  errorText?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-md border bg-card" data-testid={testId} data-status={status} aria-label={title}>
      <header className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-2 sm:px-4">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {title}
        </h2>
        <StatusBadge status={status} />
      </header>
      <div className="space-y-3 px-3 py-3 text-[13px] leading-5 sm:px-4">
        <p>{summary}</p>
        {errorText && <p className="text-xs text-muted-foreground">{errorText}</p>}
        {onRetry && (
          <Button type="button" variant="outline" size="sm" className="h-7" onClick={onRetry}>
            Opnieuw proberen
          </Button>
        )}
        {children}
      </div>
    </section>
  );
}

export default function BankAfstemming() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;

  const clientsQuery = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const client = clientsQuery.data?.find((c) => c.id === selectedClientId);
  // Alleen lezen voor een administratie die in de actieve organisatie bestaat.
  const clientId = client ? client.id : undefined;

  const accountsQuery = useGrootboekrekeningen({ organizationId: activeOrganizationId ?? undefined, enabled: orgEnabled });
  // Dezelfde query als Grootboeksaldi met "Alle jaren": react-query deelt de cache.
  const postingsQuery = useLedgerPostings({ clientId, period: ALL_TIME_PERIOD, enabled: !!clientId });
  const bankNewest = usePaginatedBankTransactions({ clientId, page: 1, pageSize: 1, sortField: "date", sortDir: "desc", enabled: !!clientId });
  const bankOldest = usePaginatedBankTransactions({ clientId, page: 1, pageSize: 1, sortField: "date", sortDir: "asc", enabled: !!clientId });

  const bank = useMemo(() => {
    const err = bankNewest.isError ? bankNewest.error : bankOldest.isError ? bankOldest.error : null;
    const read: SourceRead<BankImportFacts> = err
      ? { kind: "error", message: errorMessage(err) }
      : !client || !bankNewest.data || !bankOldest.data
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
    return bankImportSection(read);
  }, [client, bankNewest, bankOldest]);

  const kruisposten = useMemo(() => {
    if (!clientId) return null;
    const accountsRead: SourceRead<NonNullable<typeof accountsQuery.data>> = accountsQuery.isError
      ? { kind: "error", message: errorMessage(accountsQuery.error) }
      : accountsQuery.data
        ? { kind: "ok", value: accountsQuery.data }
        : { kind: "loading" };
    let reportRead: KruispostenReportRead;
    if (postingsQuery.isError) reportRead = { kind: "error", message: errorMessage(postingsQuery.error) };
    else if (!postingsQuery.data || !accountsQuery.data) reportRead = { kind: "loading" };
    else {
      try {
        reportRead = {
          kind: "ok",
          value: buildAccountReport({ rows: postingsQuery.data, clientId, period: ALL_TIME_PERIOD, accounts: accountsQuery.data }),
        };
      } catch (e) {
        reportRead = { kind: "error", message: e instanceof LedgerReportingError ? e.message : "Onbekende rapportagefout" };
      }
    }
    return kruispostenSection(accountsRead, reportRead, clientId);
  }, [clientId, accountsQuery, postingsQuery]);

  const clientSelect = (
    <Select value={selectedClientId} onValueChange={setSelectedClientId}>
      <SelectTrigger className="h-8 w-full text-[13px] sm:w-64" aria-label="Administratie">
        <span className="truncate">{client ? client.name : "Kies een administratie"}</span>
      </SelectTrigger>
      <SelectContent>
        {clientsQuery.data?.map((c) => (
          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const back = (
    <Button size="sm" variant="outline" asChild>
      <Link to="/bank">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Naar Bank
      </Link>
    </Button>
  );

  const renderBody = () => {
    // Zonder organisatie blijft useClients uitgeschakeld (en "pending"): een eindtoestand, geen laden.
    if (!isReady || (orgEnabled && clientsQuery.isPending)) {
      return (
        <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Administraties laden…</span>
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      );
    }
    if (!orgEnabled || clientsQuery.isError) {
      return (
        <div className="rounded-md border bg-card" data-testid="bank-overview-unavailable">
          <EmptyState
            icon={CircleHelp}
            message={
              !orgEnabled
                ? "Er is geen actieve organisatie; het overzicht is niet te bepalen."
                : "De administraties konden niet worden gelezen; het overzicht is niet te bepalen."
            }
          />
        </div>
      );
    }
    if (!client) {
      return <NoClientBanner message="Kies eerst een specifieke administratie om het bankoverzicht te bekijken." />;
    }

    return (
      <div className="grid gap-3 xl:grid-cols-2">
        <Section
          testId="bank-overview-import"
          icon={Landmark}
          title="Bankgegevens en import"
          status={bank.status}
          summary={bank.summary}
          errorText={bank.errorMessage}
          onRetry={bank.retryable ? () => { bankNewest.refetch(); bankOldest.refetch(); } : undefined}
        >
          {bank.status === "informatief" && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]" data-testid="bank-overview-facts">
              <dt className="text-muted-foreground">Vastgelegde IBAN's</dt>
              <dd className="min-w-0">
                {bank.ibans.length === 0 ? (
                  <span className="text-muted-foreground">Geen IBAN vastgelegd</span>
                ) : (
                  <ul className="space-y-0.5" data-testid="bank-overview-ibans">
                    {bank.ibans.map((iban) => (
                      <li key={iban} className="break-all font-mono text-xs">{iban}</li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt className="text-muted-foreground">Geïmporteerde transacties</dt>
              <dd className="font-mono tabular-nums" data-testid="bank-overview-count">{bank.total}</dd>
              <dt className="text-muted-foreground">Oudste transactie</dt>
              <dd className="font-mono tabular-nums" data-testid="bank-overview-first">{nlDatum(bank.firstDate)}</dd>
              <dt className="text-muted-foreground">Nieuwste transactie</dt>
              <dd className="font-mono tabular-nums" data-testid="bank-overview-last">{nlDatum(bank.lastDate)}</dd>
            </dl>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Link to="/bank" className="text-[13px] font-medium text-primary underline-offset-4 hover:underline">
              Naar Bank
            </Link>
          </div>
        </Section>

        {kruisposten && (
          <Section
            testId="bank-overview-kruisposten"
            icon={Scale}
            title={`Kruisposten (${KRUISPOSTEN_NUMMER})`}
            status={kruisposten.status}
            summary={kruisposten.summary}
            errorText={kruisposten.errorMessage}
            onRetry={
              kruisposten.retryable
                ? () => {
                    accountsQuery.refetch();
                    postingsQuery.refetch();
                  }
                : undefined
            }
          >
            {kruisposten.rows.length > 0 && (
              <div className="-mx-3 overflow-x-auto border-y sm:-mx-4">
                <Table className="min-w-[340px] text-[13px] [&_td]:py-[7px] [&_th]:h-8" data-testid="bank-overview-kruisposten-table">
                  <caption className="sr-only">
                    Rekening {KRUISPOSTEN_NUMMER}: aantal grootboekregels en eindsaldo over alle jaren (debet-positief).
                  </caption>
                  <TableHeader className="bg-muted/60">
                    <TableRow className="hover:bg-transparent">
                      <TableHead scope="col" className="w-16">Nummer</TableHead>
                      <TableHead scope="col">Omschrijving</TableHead>
                      <TableHead scope="col" className="w-16 text-right">Regels</TableHead>
                      <TableHead scope="col" className="w-28 text-right">Saldo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {kruisposten.rows.map((r) => (
                      <TableRow key={r.accountId} data-testid="bank-overview-kruisposten-row">
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{r.nummer}</TableCell>
                        <TableCell>
                          <Link
                            to={`/grootboek/saldi/${r.accountId}`}
                            className="font-medium underline-offset-4 hover:underline"
                            aria-label={`Open mutaties van ${r.nummer} - ${r.omschrijving}`}
                          >
                            {r.omschrijving}
                          </Link>
                          {!r.actief && (
                            <Badge variant="outline" className="ml-2 h-5 px-1.5 text-[11px] font-normal">Inactief</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{r.lineCount}</TableCell>
                        <TableCell className="whitespace-nowrap text-right" data-testid="bank-overview-kruisposten-saldo">
                          {r.closingCents === null ? (
                            <span className="text-muted-foreground">Geen boekingen</span>
                          ) : (
                            <AccountingAmount cents={r.closingCents} emphasis />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {kruisposten.rows.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Eindsaldo over alle jaren uit de bestaande grootboekrapportage, debet-positief — gelijk aan Grootboeksaldi met "Alle jaren".
              </p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Link to="/grootboek/saldi" className="text-[13px] font-medium text-primary underline-offset-4 hover:underline">
                Naar Grootboeksaldi
              </Link>
            </div>
          </Section>
        )}
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title="Bankafstemming"
        description={`${client ? `${client.name} · ` : ""}Feitelijk overzicht van bankgegevens, import en kruisposten. Alleen lezen.`}
      >
        {back}
      </PageHeader>
      <div className="mb-3 flex flex-col gap-2 rounded-md border bg-card px-3 py-2 sm:flex-row sm:items-center sm:gap-x-4" data-testid="bank-overview-toolbar">
        {clientSelect}
        <p className="text-xs text-muted-foreground sm:ml-auto">{BANK_OVERVIEW_READ_ONLY_NOTE}</p>
      </div>
      {renderBody()}
    </>
  );
}
