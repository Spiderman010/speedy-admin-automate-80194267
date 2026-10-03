import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Building2,
  CheckCircle2,
  ChevronRight,
  FileText,
  HelpCircle,
  Landmark,
  Receipt,
} from "lucide-react";
import { useClients } from "@/hooks/useClients";
import { usePurchaseInvoices } from "@/hooks/usePurchaseInvoices";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { useVraagposten } from "@/hooks/useVraagposten";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { computeClientReadiness, type ReadinessStatus } from "@/lib/client-readiness";
import { getInvoicePaymentState, getInvoiceRemainingAmount, isClosedInvoiceStatus } from "@/lib/invoice-balances";

const fmtEur = (n: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

function statusLabel(s: ReadinessStatus): string {
  if (s === "klaar") return "Klaar voor export";
  if (s === "config_ontbreekt") return "Config ontbreekt";
  return "Niet klaar";
}

// Semantic, restrained color use: destructive only for a real export blockade,
// warning styling for missing configuration, neutral for done.
function StatusBadge({ status }: { status: ReadinessStatus }) {
  if (status === "niet_klaar") {
    return (
      <Badge variant="destructive" className="whitespace-nowrap">
        {statusLabel(status)}
      </Badge>
    );
  }
  if (status === "config_ontbreekt") {
    return (
      <Badge variant="outline" className="whitespace-nowrap border-warning/60 text-warning">
        {statusLabel(status)}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="whitespace-nowrap">
      {statusLabel(status)}
    </Badge>
  );
}

// Compact operational KPI cell for the horizontal strip: title, current value,
// one context line and a real link to the module where the work happens.
function KpiCell({
  title,
  value,
  context,
  to,
  icon: Icon,
  loading,
  className = "",
}: {
  title: string;
  value: string | number;
  context: string;
  to: string;
  icon: typeof FileText;
  loading: boolean;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={`group block rounded-md border bg-card px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-primary/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      {loading ? (
        <Skeleton className="h-[4.25rem] w-full" />
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{title}</p>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </div>
          <p className="mt-2 font-mono text-2xl font-semibold leading-none tabular-nums">{value}</p>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">{context}</p>
        </>
      )}
    </Link>
  );
}

function EmptyState({ icon: Icon, title, sub }: { icon: typeof CheckCircle2; title: string; sub?: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <Icon className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
      <p className="text-sm font-medium">{title}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

const READINESS_ORDER: Record<ReadinessStatus, number> = {
  niet_klaar: 0,
  config_ontbreekt: 1,
  klaar: 2,
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;

  const { data: clients, isLoading: loadingClients, isError: errClients, refetch: refetchClients } =
    useClients(activeOrganizationId ?? undefined, orgEnabled);
  const { data: invoices, isLoading: loadingInvoices, isError: errInvoices, refetch: refetchInvoices } =
    usePurchaseInvoices({ organizationId: activeOrganizationId ?? undefined, enabled: orgEnabled });
  const { data: transactions, isLoading: loadingBank, isError: errBank, refetch: refetchBank } =
    useBankTransactions({ organizationId: activeOrganizationId ?? undefined, enabled: orgEnabled });
  const { data: vraagposten, isLoading: loadingVraagposten, isError: errVraagposten, refetch: refetchVraagposten } =
    useVraagposten({ organizationId: activeOrganizationId ?? undefined, enabled: orgEnabled });
  const { data: grootboekrekeningen, isLoading: loadingGrootboek } = useGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });

  const hasError = errClients || errInvoices || errBank || errVraagposten;
  const retryFailed = () => {
    if (errClients) refetchClients();
    if (errInvoices) refetchInvoices();
    if (errBank) refetchBank();
    if (errVraagposten) refetchVraagposten();
  };

  // ── KPIs — all derived from data the dashboard already loads ──
  const pendingInvoices = invoices?.filter(i => i.status === "te_controleren").length ?? 0;
  const openBank = transactions?.filter(
    t => t.match_status === "niet_gematcht" || t.match_status === "suggestie",
  ).length ?? 0;
  const openVraagposten = vraagposten?.filter(
    vp => vp.status === "open" || vp.status === "in_behandeling",
  ).length ?? 0;

  const outstandingPurchase = useMemo(() => {
    let count = 0;
    let total = 0;
    for (const inv of invoices ?? []) {
      if (isClosedInvoiceStatus(inv.status)) continue;
      const state = getInvoicePaymentState(inv);
      if (state !== "open" && state !== "partial") continue;
      count++;
      total += Math.max(0, getInvoiceRemainingAmount(inv) ?? 0);
    }
    return { count, total };
  }, [invoices]);

  // ── Werkvoorraad per administratie (existing readiness lib, attention first) ──
  const workRows = useMemo(() => {
    if (!clients) return [];
    return clients
      .map(client => ({
        client,
        readiness: computeClientReadiness(
          client,
          transactions ?? [],
          invoices ?? [],
          [],
          vraagposten ?? [],
          grootboekrekeningen ?? [],
        ),
      }))
      .sort(
        (a, b) =>
          READINESS_ORDER[a.readiness.status] - READINESS_ORDER[b.readiness.status] ||
          a.client.name.localeCompare(b.client.name, "nl"),
      );
  }, [clients, transactions, invoices, vraagposten, grootboekrekeningen]);

  // ── Aandacht vereist: oldest open items from existing data ──
  const attentionItems = useMemo(() => {
    type Item = { id: string; kind: "vraagpost" | "inkoop"; label: string; sub: string; date: string; to: string };
    const items: Item[] = [];
    invoices?.filter(i => i.status === "te_controleren").forEach(inv => {
      items.push({
        id: inv.id,
        kind: "inkoop",
        label: inv.supplier || inv.invoice_number || "Inkoopfactuur",
        sub: inv.invoice_number ? `Factuurnr. ${inv.invoice_number}` : "Te controleren",
        date: inv.invoice_date || inv.created_at || "",
        to: "/facturen",
      });
    });
    vraagposten?.filter(vp => vp.status === "open" || vp.status === "in_behandeling").forEach(vp => {
      items.push({
        id: vp.id,
        kind: "vraagpost",
        label: vp.titel || "Vraagpost",
        sub: vp.status === "in_behandeling" ? "In behandeling" : "Open vraagpost",
        date: vp.created_at || "",
        to: "/vraagposten",
      });
    });
    items.sort((a, b) => a.date.localeCompare(b.date));
    return items.slice(0, 6);
  }, [invoices, vraagposten]);

  const openWorkArea = (clientId: string) => {
    setSelectedClientId(clientId);
    navigate(`/bank?client=${clientId}`);
  };

  const loadingWork = loadingClients || loadingInvoices || loadingBank || loadingVraagposten || loadingGrootboek;
  const loadingAttention = loadingInvoices || loadingVraagposten;

  // Sectiekader in dezelfde stijl voor het werkvlak en de zijsecties rechts.
  const panel = "overflow-hidden rounded-md border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]";

  return (
    <>
      <h1 className="mb-4 font-display text-2xl font-semibold tracking-tight">Dashboard</h1>

      {hasError && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <p className="min-w-0 flex-1 break-words text-sm text-destructive">
            Een deel van de dashboardgegevens kon niet worden geladen.
          </p>
          <Button variant="outline" size="sm" className="h-9 shrink-0 whitespace-nowrap" onClick={retryFailed}>
            Opnieuw laden
          </Button>
        </div>
      )}

      {/* ── Operationele KPI's: vier gelijke werkkaarten op één rij ── */}
      <section aria-labelledby="dash-kerncijfers">
        <h2 id="dash-kerncijfers" className="sr-only">
          Kerncijfers
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCell
            title="Nog te verwerken"
            value={pendingInvoices}
            context="inkoopfacturen te controleren"
            to="/facturen"
            icon={FileText}
            loading={loadingInvoices}
          />
          <KpiCell
            title="Bank"
            value={openBank}
            context="transacties nog af te letteren"
            to="/bank"
            icon={Landmark}
            loading={loadingBank}
          />
          <KpiCell
            title="Vraagposten"
            value={openVraagposten}
            context="open of in behandeling"
            to="/vraagposten"
            icon={HelpCircle}
            loading={loadingVraagposten}
          />
          <KpiCell
            title="Openstaand inkoop"
            value={outstandingPurchase.count}
            context={`${fmtEur(outstandingPurchase.total)} nog te betalen`}
            to="/facturen"
            icon={Receipt}
            loading={loadingInvoices}
          />
        </div>
      </section>

      {/* ── 70/30: werkvoorraad links, aandacht en navigatie rechts ── */}
      <section aria-labelledby="dash-werkvoorraad" className="mt-4">
        <h2 id="dash-werkvoorraad" className="sr-only">
          Werkvoorraad en aandacht
        </h2>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        <div className={panel}>
          <div className="border-b px-4 py-3">
            <h3 className="font-display text-[15px] font-semibold">Werkvoorraad per administratie</h3>
            <p className="text-xs text-muted-foreground">
              Openstaand werk en exportgereedheid, administraties met aandacht eerst
            </p>
          </div>
          <div>
            {loadingWork ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : workRows.length > 0 ? (
              <div className="overflow-x-auto">
                <Table className="text-[13px] [&_th]:h-9 [&_td]:py-1 [&_thead_tr]:bg-muted/50">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Administratie</TableHead>
                      <TableHead className="text-right">Inkoop</TableHead>
                      <TableHead className="text-right">Bank</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Vragen</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {workRows.map(({ client, readiness }) => (
                      <TableRow key={client.id} className="h-10">
                        <TableCell className="max-w-[10rem] sm:max-w-[14rem] lg:max-w-[280px]">
                          <p className="truncate text-sm font-medium" title={client.name}>
                            {client.name}
                          </p>
                          {(readiness.configMissingReasons.length > 0 ||
                            readiness.configMissing1799) && (
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 break-words text-xs text-warning">
                              <AlertCircle className="h-3 w-3 shrink-0" />
                              {/* configMissingReasons is the single source for
                                  blocking config gaps (dagboeken + debiteuren/
                                  crediteurenrekening), so nothing is listed
                                  twice. 1799 is informational and not part of
                                  that list, so it is appended separately. */}
                              {[
                                ...readiness.configMissingReasons,
                                readiness.configMissing1799 && "Rekening 1799 ontbreekt",
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {readiness.inkoopTeControleren}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {readiness.bankGeblokkeerd}
                        </TableCell>
                        <TableCell className="hidden text-right font-mono text-sm tabular-nums sm:table-cell">
                          {readiness.openVraagposten}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={readiness.status} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-9 whitespace-nowrap"
                            onClick={() => openWorkArea(client.id)}
                          >
                            Openen
                            <ArrowRight className="ml-1 h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState
                icon={Building2}
                title="Nog geen administraties"
                sub="Voeg je eerste klant toe via Administraties."
              />
            )}
          </div>
        </div>

        <div className="grid gap-4">
          <div className={panel}>
            <div className="border-b px-4 py-3">
              <h3 className="font-display text-[15px] font-semibold">Aandacht vereist</h3>
              <p className="text-xs text-muted-foreground">Oudste openstaande acties eerst</p>
            </div>
            <div>
              {loadingAttention ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                </div>
              ) : attentionItems.length > 0 ? (
                <div className="divide-y">
                  {attentionItems.map(item => (
                    <Link
                      key={item.id}
                      to={item.to}
                      className="flex items-start gap-3 px-4 py-2 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      {item.kind === "vraagpost" ? (
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                      ) : (
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{item.label}</p>
                        <p className="break-words text-xs text-muted-foreground">
                          {item.sub}
                          {item.date ? ` · ${new Date(item.date).toLocaleDateString("nl-NL")}` : ""}
                        </p>
                      </div>
                      <Badge variant="outline" className="shrink-0 whitespace-nowrap text-xs">
                        {item.kind === "inkoop" ? "Inkoop" : "Vraagpost"}
                      </Badge>
                    </Link>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={CheckCircle2}
                  title="Geen openstaande acties"
                  sub="Er zijn geen facturen of vraagposten die aandacht nodig hebben."
                />
              )}
            </div>
          </div>

          {/* ── Snelle navigatie ── */}
          <section aria-labelledby="dash-navigatie" className={panel}>
            <div className="border-b px-4 py-3">
              <h2 id="dash-navigatie" className="font-display text-[15px] font-semibold">
                Snelle navigatie
              </h2>
            </div>
            <nav aria-label="Snelle navigatie" className="divide-y">
              {[
                { to: "/bank", icon: Landmark, label: "Bank" },
                { to: "/facturen", icon: FileText, label: "Inkoop" },
                { to: "/verkoop", icon: Receipt, label: "Verkoop" },
                { to: "/vraagposten", icon: HelpCircle, label: "Vraagposten" },
                { to: "/klanten", icon: Building2, label: "Administraties" },
                { to: "/overzichten", icon: BarChart3, label: "Rapportages" },
              ].map(({ to, icon: Icon, label }) => (
                <Link
                  key={to}
                  to={to}
                  className="flex h-9 items-center gap-2.5 px-4 text-[13px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="flex-1">{label}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                </Link>
              ))}
            </nav>
          </section>
        </div>
      </div>
      </section>
    </>
  );
}
