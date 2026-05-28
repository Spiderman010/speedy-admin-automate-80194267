import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, FileText, Landmark, Receipt, AlertCircle, CheckCircle2 } from "lucide-react";
import { useClients } from "@/hooks/useClients";
import { usePurchaseInvoices } from "@/hooks/usePurchaseInvoices";
import { useSalesInvoices } from "@/hooks/useSalesInvoices";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { useVraagposten } from "@/hooks/useVraagposten";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { Skeleton } from "@/components/ui/skeleton";
import { useClientContext } from "@/hooks/useClientContext";
import { computeClientReadiness } from "@/lib/client-readiness";
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

  const unmatchedTx = transactions?.filter((t) => t.match_status === "niet_gematcht").length ?? 0;
  const totalInvoices = (invoices?.length ?? 0) + (salesInvoices?.length ?? 0);

  const isLoading =
    loadingClients ||
    loadingInvoices ||
    loadingBank ||
    loadingSales ||
    loadingVraagposten ||
    loadingGrootboek;

  // Combined recent invoices (purchase + sales), sorted by created_at desc, max 5
  const recentItems = (() => {
    const items: Array<{
      id: string;
      type: "purchase" | "sales";
      label: string;
      sub: string;
      status: string;
      created_at: string;
    }> = [];
    invoices?.forEach((inv) => {
      items.push({
        id: inv.id,
        type: "purchase",
        label: `${inv.supplier} — ${inv.invoice_number || "Geen nr."}`,
        sub: `${inv.amount_incl ? `€ ${inv.amount_incl.toFixed(2)}` : ""} · ${inv.status.replace("_", " ")}`,
        status: inv.status,
        created_at: inv.created_at,
      });
    });
    salesInvoices?.forEach((inv) => {
      items.push({
        id: inv.id,
        type: "sales",
        label: `${inv.customer_name} — ${inv.invoice_number}`,
        sub: `${inv.amount_incl ? `€ ${inv.amount_incl.toFixed(2)}` : ""} · ${inv.status}`,
        status: inv.status,
        created_at: inv.created_at,
      });
    });
    items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return items.slice(0, 5);
  })();

  const isGoodStatus = (s: string) =>
    s === "gecontroleerd" || s === "geexporteerd" || s === "betaald" || s === "verzonden";

  const handleClientClick = (clientId: string) => {
    setSelectedClientId(clientId);
    navigate(`/bank?client=${clientId}`);
  };

  return (
    <>
      <PageHeader title="Dashboard" description="Overzicht van alle administraties" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
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
              <StatCard title="Ongematchte transacties" value={unmatchedTx} icon={Landmark} />
            </div>
            <div className="cursor-pointer" onClick={() => navigate("/facturen")}>
              <StatCard title="Totaal facturen" value={totalInvoices} icon={Receipt} />
            </div>
          </>
        )}
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-lg">Recente facturen</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : recentItems.length > 0 ? (
              <div className="space-y-4">
                {recentItems.map((item) => (
                  <div key={item.id} className="flex items-start gap-3">
                    {isGoodStatus(item.status) ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    ) : (
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{item.label}</p>
                      <p className="text-xs text-muted-foreground">{item.sub}</p>
                    </div>
                    <Badge variant="outline" className="text-xs shrink-0">
                      {item.type === "purchase" ? "Inkoop" : "Verkoop"}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Nog geen facturen. Upload je eerste facturen via het Inkoopfacturen-scherm.</p>
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
