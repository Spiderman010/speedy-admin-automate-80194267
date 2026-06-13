import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, FileText, Landmark, AlertCircle, CheckCircle2, HelpCircle } from "lucide-react";
import { useClients } from "@/hooks/useClients";
import { usePurchaseInvoices } from "@/hooks/usePurchaseInvoices";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { useVraagposten } from "@/hooks/useVraagposten";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { Skeleton } from "@/components/ui/skeleton";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
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
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;

  const { data: clients, isLoading: loadingClients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const { data: invoices, isLoading: loadingInvoices } = usePurchaseInvoices({ organizationId: activeOrganizationId ?? undefined, enabled: orgEnabled });
  const { data: transactions, isLoading: loadingBank } = useBankTransactions({ organizationId: activeOrganizationId ?? undefined, enabled: orgEnabled });
  const { data: vraagposten, isLoading: loadingVraagposten } = useVraagposten({ organizationId: activeOrganizationId ?? undefined, enabled: orgEnabled });
  const { data: grootboekrekeningen, isLoading: loadingGrootboek } = useGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });

  const pendingInvoices = invoices?.filter((i) => i.status === "te_controleren").length ?? 0;
  const unmatchedTx = transactions?.filter((t) => t.match_status === "niet_gematcht" || t.match_status === "suggestie").length ?? 0;
  const openVraagposten = vraagposten?.filter((vp) => vp.status === "open" || vp.status === "in_behandeling").length ?? 0;

  const isLoading = loadingClients || loadingInvoices || loadingBank || loadingVraagposten || loadingGrootboek;

  const teVerwerkenItems = useMemo(() => {
    type WorkItem = {
      id: string;
      type: "inkoop" | "vraagpost";
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
  }, [invoices, vraagposten]);

  const handleClientClick = (clientId: string) => {
    setSelectedClientId(clientId);
    navigate(`/bank?client=${clientId}`);
  };

  return (
    <>
      <PageHeader title="Dagelijkse cockpit" description="Overzicht van alle openstaande werkzaamheden" />

      {/* ── Stat cards ── */}
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
              <StatCard title="Facturen te controleren" value={pendingInvoices} icon={FileText} />
            </div>
            <div className="cursor-pointer" onClick={() => navigate("/bank")}>
              <StatCard title="Open banktransacties" value={unmatchedTx} icon={Landmark} />
            </div>
            <div className="cursor-pointer" onClick={() => navigate("/vraagposten")}>
              <StatCard title="Open vraagposten" value={openVraagposten} icon={HelpCircle} />
            </div>
          </>
        )}
      </div>

      {/* ── Snelle acties ── */}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => navigate("/bank")}>
          <Landmark className="mr-2 h-4 w-4" />Bankafschriften
        </Button>
        <Button variant="outline" size="sm" onClick={() => navigate("/facturen")}>
          <FileText className="mr-2 h-4 w-4" />Facturen
        </Button>
        <Button variant="outline" size="sm" onClick={() => navigate("/vraagposten")}>
          <HelpCircle className="mr-2 h-4 w-4" />Vraagposten
        </Button>
        <Button variant="outline" size="sm" onClick={() => navigate("/klanten")}>
          <Users className="mr-2 h-4 w-4" />Klanten
        </Button>
      </div>

      {/* ── Main content ── */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
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
                      {item.type === "inkoop" ? "Inkoopfactuur" : "Vraagpost"}
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
                    [],
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
