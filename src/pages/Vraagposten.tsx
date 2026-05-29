import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckCircle2, ClipboardList, RotateCcw, Search, Trash2, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import {
  useVraagposten,
  useUpdateVraagpostStatus,
  useDeleteVraagpost,
  VRAAGPOST_CATEGORIE_LABELS,
  VRAAGPOST_SOURCE_LABELS,
  type VraagpostStatus,
} from "@/hooks/useVraagposten";
import { useSearchParams } from "react-router-dom";
import { FilterChip } from "@/components/FilterChip";
import { formatMT940Title, formatMT940Detail } from "@/lib/mt940-description-parser";

const STATUS_ORDER = ["open", "in_behandeling", "opgelost", "genegeerd"] as const;

const STATUS_CHIP_LABELS: Record<string, string> = {
  open: "Open",
  in_behandeling: "In behandeling",
  opgelost: "Opgelost",
  genegeerd: "Genegeerd",
};

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
  const [searchParams] = useSearchParams();
  const { data: clients } = useClients();
  const { data: vraagposten, isLoading } = useVraagposten(selectedClientId);
  const updateStatus = useUpdateVraagpostStatus();
  const deleteVraagpost = useDeleteVraagpost();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const handledFocusIdRef = useRef<string | null>(null);
  const focusId = searchParams.get("focus");

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

  const uniqueStatuses = useMemo(() => {
    const present = new Set(sorted.map(vp => vp.status).filter(Boolean));
    return STATUS_ORDER.filter(s => present.has(s));
  }, [sorted]);

  const searchFiltered = useMemo(() => {
    if (!searchQuery.trim()) return sorted;
    const q = searchQuery.toLowerCase();
    return sorted.filter(vp =>
      (vp.titel || "").toLowerCase().includes(q) ||
      (vp.omschrijving || "").toLowerCase().includes(q) ||
      (VRAAGPOST_SOURCE_LABELS[vp.source_type] ?? vp.source_type ?? "").toLowerCase().includes(q) ||
      (VRAAGPOST_CATEGORIE_LABELS[vp.categorie] ?? vp.categorie ?? "").toLowerCase().includes(q) ||
      (vp.client_id ? clients?.find(c => c.id === vp.client_id)?.name ?? "" : "").toLowerCase().includes(q) ||
      (STATUS_CHIP_LABELS[vp.status] ?? vp.status ?? "").toLowerCase().includes(q)
    );
  }, [sorted, searchQuery, clients]);

  const filteredSorted = useMemo(() => {
    if (statusFilter === "all") return searchFiltered;
    return searchFiltered.filter(vp => vp.status === statusFilter);
  }, [searchFiltered, statusFilter]);

  useEffect(() => {
    if (!focusId) {
      handledFocusIdRef.current = null;
      setHighlightedId(null);
      return;
    }
    if (isLoading || !sorted.length || handledFocusIdRef.current === focusId) return;

    const row = rowRefs.current.get(focusId);
    if (!row) return;

    handledFocusIdRef.current = focusId;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedId(focusId);

    const timeoutId = window.setTimeout(() => {
      setHighlightedId(current => (current === focusId ? null : current));
    }, 2000);

    return () => window.clearTimeout(timeoutId);
  }, [focusId, isLoading, sorted]);

  const handleDelete = async () => {
    if (!pendingDeleteId) return;
    try {
      await deleteVraagpost.mutateAsync(pendingDeleteId);
      toast({ title: "Vraagpost verwijderd" });
    } catch (e: any) {
      toast({ title: "Fout bij verwijderen", description: e.message, variant: "destructive" });
    } finally {
      setPendingDeleteId(null);
    }
  };

  const handleStatus = async (id: string, status: VraagpostStatus) => {
    await updateStatus.mutateAsync({ id, status });
    toast({
      title:
        status === "opgelost"
          ? "Vraagpost opgelost"
          : status === "genegeerd"
          ? "Vraagpost genegeerd"
          : "Vraagpost heropend",
    });
  };

  return (
    <>
      <PageHeader title="Vraagposten" description="Open punten bij facturen, bank en klanten" />
      <div className="mb-5 space-y-2.5">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Zoeken op titel, bron, categorie of klant..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        {uniqueStatuses.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Status</span>
            <FilterChip
              label="Alle statussen"
              active={statusFilter === "all"}
              count={searchFiltered.length}
              onClick={() => setStatusFilter("all")}
            />
            {uniqueStatuses.map(s => (
              <FilterChip
                key={s}
                label={STATUS_CHIP_LABELS[s] ?? s}
                active={statusFilter === s}
                count={searchFiltered.filter(vp => vp.status === s).length}
                onClick={() => setStatusFilter(statusFilter === s ? "all" : s)}
              />
            ))}
          </div>
        )}
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-6">
          {isLoading ? (
            <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : !filteredSorted.length ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                <ClipboardList className="h-8 w-8 text-primary" />
              </div>
              <h3 className="font-display text-lg font-semibold">
                {searchQuery || statusFilter !== "all" ? "Geen vraagposten gevonden" : "Geen vraagposten"}
              </h3>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {searchQuery || statusFilter !== "all"
                  ? "Pas je zoekterm of filters aan om meer resultaten te zien."
                  : "Er zijn nog geen openstaande punten voor de geselecteerde klant."}
              </p>
            </div>
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
                {filteredSorted.map(vp => {
                  const isHighlighted = vp.id === highlightedId;
                  const highlightClass = isHighlighted
                    ? "bg-amber-50/80 border-y border-amber-300 first:border-l first:border-l-amber-300 last:border-r last:border-r-amber-300"
                    : "";

                  return (
                  <TableRow
                    key={vp.id}
                    ref={(element) => {
                      if (element) rowRefs.current.set(vp.id, element);
                      else rowRefs.current.delete(vp.id);
                    }}
                    className="scroll-mt-24 transition-colors duration-300"
                  >
                    <TableCell className={`${highlightClass} text-sm`}>{getClientName(vp.client_id)}</TableCell>
                    <TableCell className={`${highlightClass} text-sm`}>{VRAAGPOST_SOURCE_LABELS[vp.source_type] ?? vp.source_type}</TableCell>
                    <TableCell className={`${highlightClass} text-sm`}>{VRAAGPOST_CATEGORIE_LABELS[vp.categorie] ?? vp.categorie}</TableCell>
                    <TableCell className={`${highlightClass} font-medium`}>
                      <span title={vp.titel ?? undefined}>{formatMT940Title(vp.titel)}</span>
                      {(() => {
                        const detail = formatMT940Detail(vp.omschrijving);
                        if (!detail) return null;
                        return (
                          <div
                            className="text-xs text-muted-foreground mt-0.5 line-clamp-2"
                            title={vp.omschrijving ?? undefined}
                          >
                            {detail}
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell className={highlightClass}>{statusBadge(vp.status)}</TableCell>
                    <TableCell className={`${highlightClass} text-sm text-muted-foreground`}>
                      {vp.created_at ? new Date(vp.created_at).toLocaleDateString("nl-NL") : "—"}
                    </TableCell>
                    <TableCell className={`${highlightClass} text-right`}>
                      <div className="inline-flex gap-2 items-center">
                        {(vp.status === "open" || vp.status === "in_behandeling") && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => handleStatus(vp.id, "opgelost")}>
                              <CheckCircle2 className="h-3.5 w-3.5 mr-1" />Opgelost
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => handleStatus(vp.id, "genegeerd")}>
                              <XCircle className="h-3.5 w-3.5 mr-1" />Negeren
                            </Button>
                          </>
                        )}
                        {(vp.status === "opgelost" || vp.status === "genegeerd") && (
                          <Button size="sm" variant="ghost" onClick={() => handleStatus(vp.id, "open")}>
                            <RotateCcw className="h-3.5 w-3.5 mr-1" />Heropenen
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setPendingDeleteId(vp.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <AlertDialog open={!!pendingDeleteId} onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Vraagpost verwijderen</AlertDialogTitle>
            <AlertDialogDescription>
              Weet je zeker dat je deze vraagpost wilt verwijderen? Dit kan niet ongedaan worden gemaakt. De gekoppelde banktransactie of factuur blijft ongewijzigd.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuleren</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Verwijderen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
