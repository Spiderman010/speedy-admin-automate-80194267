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
import { Skeleton } from "@/components/ui/skeleton";

export default function Dashboard() {
  const navigate = useNavigate();
  const { data: clients, isLoading: loadingClients } = useClients();
  const { data: invoices, isLoading: loadingInvoices } = usePurchaseInvoices();
  const { data: salesInvoices, isLoading: loadingSales } = useSalesInvoices();
  const { data: transactions, isLoading: loadingBank } = useBankTransactions();

  const pendingInvoices = invoices?.filter((i) => i.status === "te_controleren").length ?? 0;

  const unmatchedTx = transactions?.filter((t) => t.match_status === "niet_gematcht" || t.match_status === "wacht_op_factuur").length ?? 0;
  const totalInvoices = (invoices?.length ?? 0) + (salesInvoices?.length ?? 0);

  const isLoading = loadingClients || loadingInvoices || loadingBank || loadingSales;

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
            <CardTitle className="font-display text-lg">Klantenstatus</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : clients && clients.length > 0 ? (
              <div className="space-y-3">
                {clients.map((client) => {
                  const purchaseCount = invoices?.filter((i) => i.client_id === client.id && i.status === "te_controleren").length ?? 0;
                  const txCount = transactions?.filter((t) => t.client_id === client.id && (t.match_status === "niet_gematcht" || t.match_status === "wacht_op_factuur")).length ?? 0;
                  const totalTasks = purchaseCount + txCount;
                  return (
                    <div
                      key={client.id}
                      className="flex items-center justify-between cursor-pointer hover:bg-muted/50 rounded-md px-2 py-1 -mx-2"
                      onClick={() => navigate(`/bank?client=${client.id}`)}
                    >
                      <div>
                        <p className="text-sm font-medium">{client.name}</p>
                        {totalTasks > 0 && (
                          <p className="text-xs text-muted-foreground">{purchaseCount} facturen · {txCount} transacties</p>
                        )}
                      </div>
                      <Badge variant={totalTasks === 0 ? "default" : totalTasks > 3 ? "destructive" : "secondary"}>
                        {totalTasks === 0 ? "Bijgewerkt" : `${totalTasks} taken`}
                      </Badge>
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
