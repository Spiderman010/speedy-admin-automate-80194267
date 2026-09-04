import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Info, ArrowUpRight, AlertTriangle } from "lucide-react";
import { SearchInput } from "@/components/SearchInput";
import { EmptyState } from "@/components/EmptyState";
import { FilterChip } from "@/components/FilterChip";
import { NoClientBanner } from "@/components/NoClientBanner";
import { cn } from "@/lib/utils";
import { formatGetal } from "@/lib/format";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { usePurchaseInvoices } from "@/hooks/usePurchaseInvoices";
import { useSalesInvoices } from "@/hooks/useSalesInvoices";
import { useJournalEntries } from "@/hooks/useJournalEntries";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { useBankTransactionAllocations } from "@/hooks/useBankTransactionAllocations";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import {
  buildLedgerMutations,
  filterLedgerMutations,
  collectLedgerYears,
  LEDGER_SOURCE_LABELS,
  type LedgerMutation,
  type LedgerMutationSource,
  type LedgerYearFilter,
} from "@/lib/ledger-mutations";

const SOURCE_CHIPS: readonly LedgerMutationSource[] = ["purchase", "sales", "bank", "journal"];

/** Drill-down targets — only routes that actually exist in App.tsx. */
const SOURCE_ROUTES: Record<LedgerMutationSource, (sourceId: string) => string> = {
  purchase: (id) => `/facturen/inkoop/${id}`,
  sales: () => "/verkoop",
  bank: () => "/bank",
  journal: () => "/boekingen",
};

function formatDatum(d: string): string {
  const [y, m, day] = d.split("-");
  return y && m && day ? `${day}-${m}-${y}` : d;
}

function SourceBadge({ source }: { source: LedgerMutationSource }) {
  // Neutral styling on purpose: colour must not suggest debit/credit.
  return <Badge variant="outline">{LEDGER_SOURCE_LABELS[source]}</Badge>;
}

function MutationsSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Grootboekmutaties laden…</span>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-20 shrink-0" />
          <Skeleton className="h-5 w-16 shrink-0" />
          <Skeleton className="hidden h-4 w-32 shrink-0 md:block" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-20 shrink-0" />
          <Skeleton className="h-7 w-7 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export default function GrootboekMutaties() {
  const navigate = useNavigate();
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  // Every source below is a whole-dataset query, so it stays gated on one
  // administratie — the accountancy flow, and it keeps the fetches bounded.
  const sourcesEnabled = orgEnabled && hasSpecificClient;

  const [sourceFilter, setSourceFilter] = useState<LedgerMutationSource | "all">("all");
  const [yearFilter, setYearFilter] = useState<LedgerYearFilter>("all");
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const purchaseQuery = usePurchaseInvoices({
    organizationId: activeOrganizationId ?? undefined,
    clientId: hasSpecificClient ? selectedClientId : undefined,
    enabled: sourcesEnabled,
  });
  const salesQuery = useSalesInvoices({
    clientId: hasSpecificClient ? selectedClientId : undefined,
    enabled: sourcesEnabled,
  });
  const journalQuery = useJournalEntries({
    organizationId: activeOrganizationId ?? undefined,
    clientId: hasSpecificClient ? selectedClientId : undefined,
    enabled: sourcesEnabled,
  });
  const bankQuery = useBankTransactions({
    organizationId: activeOrganizationId ?? undefined,
    clientId: hasSpecificClient ? selectedClientId : undefined,
    enabled: sourcesEnabled,
  });
  const allocationsQuery = useBankTransactionAllocations({
    organizationId: activeOrganizationId ?? undefined,
    clientId: hasSpecificClient ? selectedClientId : undefined,
    enabled: sourcesEnabled,
  });
  const { data: accounts } = useActiveGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });

  const sourceQueries = [purchaseQuery, salesQuery, journalQuery, bankQuery, allocationsQuery];
  const isLoading = sourcesEnabled && sourceQueries.some((q) => q.isLoading);
  // Financial figures must never be shown partially: one failing source blocks
  // the whole list rather than silently under-reporting.
  const failedQueries = sourceQueries.filter((q) => q.isError);
  const hasError = failedQueries.length > 0;

  const { mutations, excludedBank } = useMemo(
    () =>
      buildLedgerMutations({
        purchaseInvoices: purchaseQuery.data ?? [],
        salesInvoices: salesQuery.data ?? [],
        journalEntries: journalQuery.data ?? [],
        bankTransactions: bankQuery.data ?? [],
        allocations: allocationsQuery.data ?? [],
        accounts: accounts ?? [],
      }),
    [purchaseQuery.data, salesQuery.data, journalQuery.data, bankQuery.data, allocationsQuery.data, accounts],
  );

  const years = useMemo(() => collectLedgerYears(mutations), [mutations]);
  const filtered = useMemo(
    () =>
      filterLedgerMutations(mutations, {
        source: sourceFilter,
        year: yearFilter,
        ledgerAccountId: accountFilter,
        search,
      }),
    [mutations, sourceFilter, yearFilter, accountFilter, search],
  );

  const accountsById = useMemo(() => {
    const m = new Map<string, { nummer: number; omschrijving: string }>();
    for (const a of accounts ?? []) m.set(a.id, a);
    return m;
  }, [accounts]);

  const selectedClient = clients?.find((c) => c.id === selectedClientId);
  const selectedAccount = accountFilter !== "all" ? accountsById.get(accountFilter) : undefined;

  const hasSearch = search.trim() !== "";
  const emptyMessage = (): string => {
    if (mutations.length === 0) return "Nog geen financiële mutaties voor deze administratie.";
    if (hasSearch) return `Geen mutaties gevonden voor “${search.trim()}”.`;
    if (accountFilter !== "all") {
      return selectedAccount
        ? `Geen mutaties op rekening ${selectedAccount.nummer} - ${selectedAccount.omschrijving}.`
        : "Geen mutaties op de gekozen rekening.";
    }
    if (sourceFilter !== "all") return `Geen mutaties uit bron ${LEDGER_SOURCE_LABELS[sourceFilter]}.`;
    if (yearFilter !== "all") return `Geen mutaties in ${yearFilter}.`;
    return "Geen mutaties gevonden.";
  };

  const openSource = (m: LedgerMutation) => navigate(SOURCE_ROUTES[m.source](m.sourceId));

  return (
    <>
      <h1 className="sr-only">Grootboekmutaties</h1>

      {/* Explainability — this is deliberately not presented as a closing ledger. */}
      <div className="mb-4 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Dit overzicht toont financiële bronmutaties zonder betalingen dubbel te tellen. Afgeletterde
          bankbetalingen worden niet nogmaals als kosten of omzet opgenomen.
        </p>
      </div>

      {/* Administratie + zoeken */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Select value={selectedClientId} onValueChange={(v) => setSelectedClientId(v)}>
          <SelectTrigger className="w-full sm:w-64" aria-label="Administratie">
            <span className="truncate">{selectedClient ? selectedClient.name : "Alle administraties"}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle administraties</SelectItem>
            {clients?.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Zoek op omschrijving, referentie of rekening…"
          className="w-full sm:max-w-sm"
        />
      </div>

      {/* Bron / jaar / rekening */}
      <div className="mb-4 space-y-2">
        <div data-testid="source-filters" className="flex flex-wrap items-center gap-1.5">
          <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Bron</span>
          <FilterChip label="Alle" active={sourceFilter === "all"} onClick={() => setSourceFilter("all")} />
          {SOURCE_CHIPS.map((s) => (
            <FilterChip
              key={s}
              label={LEDGER_SOURCE_LABELS[s]}
              active={sourceFilter === s}
              onClick={() => setSourceFilter(sourceFilter === s ? "all" : s)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Jaar</span>
          <Select
            value={String(yearFilter)}
            onValueChange={(v) => setYearFilter(v === "all" ? "all" : Number(v))}
          >
            <SelectTrigger className="w-36" aria-label="Jaar">
              <span>{yearFilter === "all" ? "Alle jaren" : yearFilter}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle jaren</SelectItem>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground sm:w-auto sm:pl-4">Rekening</span>
          <Select value={accountFilter} onValueChange={setAccountFilter}>
            <SelectTrigger className="w-full sm:w-72" aria-label="Grootboekrekening">
              <span className="truncate">
                {selectedAccount
                  ? `${selectedAccount.nummer} - ${selectedAccount.omschrijving}`
                  : "Alle rekeningen"}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle rekeningen</SelectItem>
              {(accounts ?? []).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.nummer} - {a.omschrijving}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {accountFilter !== "all" && (
          <p className="pl-20 text-xs text-muted-foreground">
            Verkoopfacturen hebben geen gekoppelde grootboekrekening en vallen daarom buiten dit filter.
          </p>
        )}
      </div>

      {!hasSpecificClient ? (
        <NoClientBanner message="Kies eerst een specifieke administratie om de grootboekmutaties te bekijken." />
      ) : (
        <Card>
          <CardContent className="p-6">
            {isLoading ? (
              <MutationsSkeleton />
            ) : hasError ? (
              <div className="flex flex-col items-start gap-3 py-6" role="alert">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <p className="text-sm font-medium">Mutaties laden is mislukt.</p>
                    <p className="text-sm text-muted-foreground">
                      Eén of meer bronnen konden niet worden geladen. Om onvolledige financiële cijfers te
                      voorkomen wordt er geen lijst getoond.
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => failedQueries.forEach((q) => q.refetch())}>
                  Opnieuw proberen
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState message={emptyMessage()} />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground" data-testid="mutation-count">
                    {filtered.length} {filtered.length === 1 ? "mutatie" : "mutaties"}
                  </p>
                  {excludedBank.total > 0 && (
                    <p className="text-xs text-muted-foreground" data-testid="excluded-bank">
                      {excludedBank.total} banktransactie{excludedBank.total === 1 ? "" : "s"} niet opgenomen
                      {" · "}
                      {excludedBank.settled} afgeletterd, {excludedBank.unmatched} niet gematcht,{" "}
                      {excludedBank.suggested} suggestie, {excludedBank.invalidManual} zonder rekening
                    </p>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-28">Datum</TableHead>
                        <TableHead className="w-24">Bron</TableHead>
                        <TableHead className="hidden w-52 md:table-cell">Rekening</TableHead>
                        <TableHead>Omschrijving</TableHead>
                        <TableHead className="hidden lg:table-cell">Referentie</TableHead>
                        <TableHead className="hidden w-24 text-right md:table-cell">BTW</TableHead>
                        <TableHead className="w-28 text-right">Bedrag</TableHead>
                        <TableHead className="w-16 text-right">Actie</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className="whitespace-nowrap">{formatDatum(m.date)}</TableCell>
                          <TableCell><SourceBadge source={m.source} /></TableCell>
                          <TableCell className="hidden max-w-[220px] md:table-cell">
                            {m.ledgerAccountLabel ? (
                              <span className="flex flex-col">
                                <span className="truncate">{m.ledgerAccountLabel}</span>
                                {!m.ledgerAccountId && (
                                  <span className="text-[11px] text-muted-foreground">Niet gekoppeld</span>
                                )}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[260px] truncate">{m.description}</TableCell>
                          <TableCell className="hidden max-w-[160px] truncate lg:table-cell">
                            {m.reference ?? "—"}
                          </TableCell>
                          <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">
                            {m.vatAmount != null ? formatGetal(m.vatAmount) : "—"}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right font-mono tabular-nums",
                              m.source === "bank" && m.amount < 0 && "text-destructive",
                            )}
                          >
                            {formatGetal(m.amount)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => openSource(m)}
                              aria-label={`Open bron voor ${m.description}`}
                              title="Open bron"
                            >
                              <ArrowUpRight className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
