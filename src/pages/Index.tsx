import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, FileText, Landmark, Receipt, AlertCircle, CheckCircle2, TrendingUp } from "lucide-react";
import { useClients } from "@/hooks/useClients";
import { usePurchaseInvoices } from "@/hooks/usePurchaseInvoices";
import { useSalesInvoices } from "@/hooks/useSalesInvoices";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { useVraagposten } from "@/hooks/useVraagposten";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { Skeleton } from "@/components/ui/skeleton";
import { useClientContext } from "@/hooks/useClientContext";
import { computeClientReadiness } from "@/lib/client-readiness";
import { getInvoicePaymentState, getInvoiceRemainingAmount, getInvoiceTotalAmount } from "@/lib/invoice-balances";
import { formatEuro } from "@/lib/format";
import type { ReadinessStatus } from "@/lib/client-readiness";

function statusLabel(s: ReadinessStatus): string {
  if (s === "klaar") return "Klaar voor export";
  if (s === "config_ontbreekt") return "Config ontbreekt";
  return "Niet klaar";
}

function statusVariant(s: ReadinessStatus): "default" | "destructive" | "outline" {
  if (s === "klaar") return "default";
  if (s === "config_ontbreekt") return "outline";
  return "destructive";
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { setSelectedClientId } = useClientContext();
  const { data: clients, isLoading: loadingClients } = useClients();
  const { data: invoices, isLoading: loadingInvoices } = usePurchaseInvoices();
  const { data: salesInvoices, isLoading: loadingSales } = useSalesInvoices();
  const { data: transactions, isLoading: loadingBank } = useBankTransactions();
  const { data: vraagposten, isLoading: loadingVraagposten } = useVraagposten();
  const { data: grootboekrekeningen, isLoading: loadingGrootboek } = useGrootboekrekeningen();

  const pendingInvoices = invoices?.filter((i) => i.status === "te_controleren").length ?? 0;

  const unmatchedTx = transactions?.filter((t) => t.match_status === "niet_gematcht" || t.match_status === "suggestie").length ?? 0;
  const totalInvoices = (invoices?.length ?? 0) + (salesInvoices?.length ?? 0);

  const openSalesStats = useMemo(() => {
    let amount = 0;
    let countOpen = 0;
    let countPartial = 0;
    for (const inv of salesInvoices ?? []) {
      const state = getInvoicePaymentState(inv);
      if (state === "paid") continue;
      if (state === "partial") {
        countPartial++;
        amount += getInvoiceRemainingAmount(inv) ?? 0;
      } else {
        countOpen++;
        amount += getInvoiceRemainingAmount(inv) ?? getInvoiceTotalAmount(inv) ?? 0;
      }
    }
    return { amount, countOpen, countPartial };
  }, [salesInvoices]);

  const isLoading =
    loadingClients ||
    loadingInvoices ||
    loadingBank ||
    loadingSales ||
    loadingVraagposten ||
    loadingGrootboek;

  const teVerwerkenItems = (() => {
    type WorkItem = {
      id: string;
      type: "inkoop" | "verkoop" | "vraagpost";
      label: string;
      sub: string;
      date: string;
      path: string;
    };
    const items: WorkItem[] = [];

    invoices?.filter(i => i.status === "te_controleren").forEach(inv => {
      items.push({
        id: inv.id,
        type: "inkoop",
        label: inv.supplier || inv.invoice_number || "Inkoopfactuur",
        sub: inv.invoice_number ? `Factuurnr. ${inv.invoice_number}` : "Te controleren",
        date: inv.invoice_date || inv.created_at || "",
        path: "/facturen",
      });
    });

    salesInvoices?.filter(i => i.status === "concept").forEach(inv => {
      items.push({
        id: inv.id,
        type: "verkoop",
        label: inv.customer_name || inv.invoice_number || "Verkoopfactuur",
        sub: inv.invoice_number ? `Factuurnr. ${inv.invoice_number}` : "Concept",
        date: inv.invoice_date || inv.created_at || "",
        path: "/verkoop",
      });
    });

    vraagposten?.filter(vp => vp.status === "open").forEach(vp => {
      items.push({
        id: vp.id,
        type: "vraagpost",
        label: vp.titel || "Vraagpost",
        sub: "Open vraagpost",
        date: vp.created_at || "",
        path: "/vraagposten",
      });
    });

    items.sort((a, b) => a.date.localeCompare(b.date));
    return items.slice(0, 5);
  })();

  const handleClientClick = (clientId: string) => {
    setSelectedClientId(clientId);
    navigate(`/bank?client=${clientId}`);
  };

  return (
    <>
      <PageHeader title="Dashboard" description="Overzicht van alle administraties" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}><CardContent className="p-6"><Skeleton className="h-16 w-full" /></CardContent></Card>
          ))
        ) : (
          <>
            <div className="cursor-pointer" onClick={() => navigate("/klanten")}>
              <StatCard title="Actieve klanten" value={clients?.length ?? 0} icon={Users} />
            </div>
            <div className="cursor-pointer" onClick={() => navigate("/facturen")}>
              <StatCard title="Te verwerken facturen" value={pendingInvoices} icon={FileText} />
            </div>
            <div className="cursor-pointer" onClick={() => navigate("/bank")}>
              <StatCard title="Open banktransacties" value={unmatchedTx} icon={Landmark} />
            </div>
            <div className="cursor-pointer" onClick={() => navigate("/facturen")}>
              <StatCard title="Totaal facturen" value={totalInvoices} icon={Receipt} />
            </div>
            <div className="cursor-pointer" onClick={() => navigate("/verkoop")}>
              <StatCard
                title="Openstaande verkoop"
                value={formatEuro(openSalesStats.amount)}
                icon={TrendingUp}
                trend={
                  openSalesStats.countOpen === 0 && openSalesStats.countPartial === 0
                    ? "Geen open verkoopfacturen"
                    : [
                        openSalesStats.countOpen > 0 ? `${openSalesStats.countOpen} open facturen` : null,
                        openSalesStats.countPartial > 0 ? `${openSalesStats.countPartial} deelbetalingen` : null,
                      ].filter(Boolean).join(" · ")
                }
              />
            </div>
          </>
        )}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-lg">Te verwerken</CardTitle>
            <p className="text-sm text-muted-foreground">Items die nog controle of actie nodig hebben</p>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : teVerwerkenItems.length > 0 ? (
              <div className="space-y-3">
                {teVerwerkenItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-3 cursor-pointer rounded-md hover:bg-muted/50 -mx-1 px-1 py-1 transition-colors"
                    onClick={() => navigate(item.path)}
                  >
                    {item.type === "vraagpost" ? (
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    ) : (
                      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.sub}{item.date ? ` · ${new Date(item.date).toLocaleDateString("nl-NL")}` : ""}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-xs shrink-0">
                      {item.type === "inkoop" ? "Inkoopfactuur" : item.type === "verkoop" ? "Verkoopfactuur" : "Vraagpost"}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center">
                <CheckCircle2 className="mx-auto h-8 w-8 text-muted-foreground/40 mb-2" />
                <p className="text-sm font-medium">Geen open werk</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Er zijn op dit moment geen facturen of vraagposten die aandacht nodig hebben.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-lg">Export-gereedheid per klant</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : clients && clients.length > 0 ? (
              <div className="space-y-2">
                {clients.map((client) => {
                  const readiness = computeClientReadiness(
                    client,
                    transactions ?? [],
                    invoices ?? [],
                    salesInvoices ?? [],
                    vraagposten ?? [],
                    grootboekrekeningen ?? [],
                  );
                  return (
                    <div
                      key={client.id}
                      className="rounded-md border px-3 py-2 cursor-pointer hover:bg-muted/50 -mx-1"
                      onClick={() => handleClientClick(client.id)}
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium">{client.name}</p>
                        <Badge variant={statusVariant(readiness.status)}>
                          {statusLabel(readiness.status)}
                        </Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <span>Inkoop: {readiness.inkoopTeControleren}</span>
                        <span>Bank: {readiness.bankGeblokkeerd}</span>
                        <span>Vragen: {readiness.openVraagposten}</span>
                        {readiness.verkoopConcept > 0 && (
                          <span>Concept: {readiness.verkoopConcept}</span>
                        )}
                      </div>
                      {(readiness.configMissingBankDagboek ||
                        readiness.configMissingInkoopDagboek ||
                        readiness.configMissingVerkoopDagboek ||
                        readiness.configMissing1799) && (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {readiness.configMissingBankDagboek && (
                            <span className="inline-flex items-center gap-0.5 text-xs text-warning">
                              <AlertCircle className="h-3 w-3" />
                              Bank dagboek
                            </span>
                          )}
                          {readiness.configMissingInkoopDagboek && (
                            <span className="inline-flex items-center gap-0.5 text-xs text-warning">
                              <AlertCircle className="h-3 w-3" />
                              Inkoop dagboek
                            </span>
                          )}
                          {readiness.configMissingVerkoopDagboek && (
                            <span className="inline-flex items-center gap-0.5 text-xs text-warning">
                              <AlertCircle className="h-3 w-3" />
                              Verkoop dagboek
                            </span>
                          )}
                          {readiness.configMissing1799 && (
                            <span className="inline-flex items-center gap-0.5 text-xs text-warning">
                              <AlertCircle className="h-3 w-3" />
                              1799 ontbreekt
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Voeg je eerste klant toe via het Klanten-scherm.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
