import { useMemo } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, RotateCcw, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import {
  useVraagposten,
  useUpdateVraagpostStatus,
  VRAAGPOST_CATEGORIE_LABELS,
  VRAAGPOST_SOURCE_LABELS,
  type VraagpostStatus,
} from "@/hooks/useVraagposten";

const statusBadge = (status: string) => {
  switch (status) {
    case "open":
      return <Badge className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Open</Badge>;
    case "in_behandeling":
      return <Badge className="bg-orange-500 text-white hover:bg-orange-500/90">In behandeling</Badge>;
    case "opgelost":
      return <Badge className="bg-green-600 text-white hover:bg-green-600/90">Opgelost</Badge>;
    case "genegeerd":
      return <Badge variant="secondary">Genegeerd</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
};

export default function Vraagposten() {
  const { toast } = useToast();
  const { selectedClientId } = useClientContext();
  const { data: clients } = useClients();
  const { data: vraagposten, isLoading } = useVraagposten(selectedClientId);
  const updateStatus = useUpdateVraagpostStatus();

  const getClientName = (id: string | null) =>
    id ? clients?.find(c => c.id === id)?.name ?? "—" : "—";

  const sorted = useMemo(() => {
    if (!vraagposten) return [];
    const order: Record<string, number> = { open: 0, in_behandeling: 1, opgelost: 2, genegeerd: 3 };
    return [...vraagposten].sort((a, b) => {
      const so = (order[a.status] ?? 99) - (order[b.status] ?? 99);
      if (so !== 0) return so;
      return (b.created_at || "").localeCompare(a.created_at || "");
    });
  }, [vraagposten]);

  const handleStatus = async (id: string, status: VraagpostStatus) => {
    await updateStatus.mutateAsync({ id, status });
    const titleMap: Record<string, string> = {
      opgelost: "Vraagpost opgelost",
      genegeerd: "Vraagpost genegeerd",
      open: "Vraagpost heropend",
    };
    toast({ title: titleMap[status] ?? "Status gewijzigd" });
  };

  return (
    <>
      <PageHeader title="Vraagposten" description="Open punten bij facturen, bank en klanten" />
      <Card>
        <CardContent className="p-6">
          {isLoading ? (
            <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : !sorted.length ? (
            <div className="py-12 text-center text-muted-foreground">Geen vraagposten.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Klant</TableHead>
                  <TableHead>Bron</TableHead>
                  <TableHead>Categorie</TableHead>
                  <TableHead>Titel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Datum</TableHead>
                  <TableHead className="text-right">Actie</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map(vp => (
                  <TableRow key={vp.id}>
                    <TableCell className="text-sm">{getClientName(vp.client_id)}</TableCell>
                    <TableCell className="text-sm">{VRAAGPOST_SOURCE_LABELS[vp.source_type] ?? vp.source_type}</TableCell>
                    <TableCell className="text-sm">{VRAAGPOST_CATEGORIE_LABELS[vp.categorie] ?? vp.categorie}</TableCell>
                    <TableCell className="font-medium">
                      {vp.titel}
                      {vp.omschrijving && (
                        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{vp.omschrijving}</div>
                      )}
                    </TableCell>
                    <TableCell>{statusBadge(vp.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {vp.created_at ? new Date(vp.created_at).toLocaleDateString("nl-NL") : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {(vp.status === "open" || vp.status === "in_behandeling") && (
                        <div className="inline-flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => handleStatus(vp.id, "opgelost")}>
                            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />Opgelost
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleStatus(vp.id, "genegeerd")}>
                            <XCircle className="h-3.5 w-3.5 mr-1" />Negeren
                          </Button>
                        </div>
                      )}
                      {(vp.status === "opgelost" || vp.status === "genegeerd") && (
                        <div className="inline-flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => handleStatus(vp.id, "open")}>
                            <RotateCcw className="h-3.5 w-3.5 mr-1" />Heropenen
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
