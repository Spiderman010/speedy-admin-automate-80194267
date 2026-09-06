import { useEffect, useMemo, useRef, useState } from "react";
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
import { AlertTriangle, CheckCircle2, ClipboardList, RotateCcw, Search, Trash2, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/hooks/useClients";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
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
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import { formatMT940Title, formatMT940Detail } from "@/lib/mt940-description-parser";

const STATUS_ORDER = ["open", "in_behandeling", "opgelost", "genegeerd"] as const;

const STATUS_CHIP_LABELS: Record<string, string> = {
  open: "Open",
  in_behandeling: "In behandeling",
  opgelost: "Opgelost",
  genegeerd: "Genegeerd",
};

const EMPTY_STATUS_TITLES: Record<string, string> = {
  open: "Geen open vraagposten",
  in_behandeling: "Geen vraagposten in behandeling",
  opgelost: "Geen opgeloste vraagposten",
  genegeerd: "Geen genegeerde vraagposten",
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
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const [searchParams] = useSearchParams();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const { data: vraagposten, isLoading, isError, refetch } = useVraagposten({
    organizationId: activeOrganizationId ?? undefined,
    clientId: selectedClientId !== "all" ? selectedClientId : undefined,
    enabled: orgEnabled,
  });
  const updateStatus = useUpdateVraagpostStatus();
  const deleteVraagpost = useDeleteVraagpost();
  const deleteConfirm = useDeleteConfirm();
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
    if (!deleteConfirm.pendingId) return;
    try {
      await deleteVraagpost.mutateAsync(deleteConfirm.pendingId);
      toast({ title: "Vraagpost verwijderd" });
    } catch (e: any) {
      toast({ title: "Fout bij verwijderen", description: e.message, variant: "destructive" });
    } finally {
      deleteConfirm.cancel();
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

  const emptyTitle = searchQuery.trim()
    ? "Geen zoekresultaten"
    : statusFilter !== "all"
    ? EMPTY_STATUS_TITLES[statusFilter] ?? "Geen vraagposten gevonden"
    : "Geen vraagposten";

  const emptyDescription = searchQuery.trim()
    ? "Pas je zoekterm aan om meer resultaten te zien."
    : statusFilter !== "all"
    ? "Kies een andere status om meer vraagposten te zien."
    : "Er zijn nog geen openstaande punten voor de geselecteerde klant.";

  return (
    <>
      <h1 className="sr-only">Vraagposten</h1>
      <div className="mb-4 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-md flex-1 min-w-[12rem]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Zoeken op titel, bron, categorie of klant..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              aria-label="Zoeken in vraagposten"
            />
          </div>
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {filteredSorted.length} {filteredSorted.length === 1 ? "vraagpost" : "vraagposten"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <FilterChip
            label="Alle"
            active={statusFilter === "all"}
            count={searchFiltered.length}
            onClick={() => setStatusFilter("all")}
          />
          {STATUS_ORDER.map(s => (
            <FilterChip
              key={s}
              label={STATUS_CHIP_LABELS[s]}
              active={statusFilter === s}
              count={searchFiltered.filter(vp => vp.status === s).length}
              onClick={() => setStatusFilter(statusFilter === s ? "all" : s)}
            />
          ))}
        </div>
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-4 sm:p-6">
          {isLoading ? (
            <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10 mb-4">
                <AlertTriangle className="h-8 w-8 text-destructive" />
              </div>
              <h2 className="font-display text-lg font-semibold">Vraagposten laden mislukt</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Er ging iets mis bij het ophalen van de vraagposten.
              </p>
              <Button className="mt-4" variant="outline" onClick={() => refetch()}>
                Opnieuw proberen
              </Button>
            </div>
          ) : !filteredSorted.length ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                <ClipboardList className="h-8 w-8 text-primary" />
              </div>
              <h2 className="font-display text-lg font-semibold">{emptyTitle}</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">{emptyDescription}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[8rem]">Status</TableHead>
                  <TableHead>Titel</TableHead>
                  <TableHead className="hidden sm:table-cell">Klant</TableHead>
                  <TableHead className="hidden lg:table-cell">Bron</TableHead>
                  <TableHead className="hidden lg:table-cell">Categorie</TableHead>
                  <TableHead className="hidden md:table-cell">Datum</TableHead>
                  <TableHead className="text-right">Actie</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSorted.map(vp => {
                  const isHighlighted = vp.id === highlightedId;
                  const highlightClass = isHighlighted
                    ? "bg-amber-50/80 border-y border-amber-300 first:border-l first:border-l-amber-300 last:border-r last:border-r-amber-300"
                    : "";
                  const detail = formatMT940Detail(vp.omschrijving);
                  const sourceLabel = VRAAGPOST_SOURCE_LABELS[vp.source_type] ?? vp.source_type;
                  const categorieLabel = VRAAGPOST_CATEGORIE_LABELS[vp.categorie] ?? vp.categorie;

                  return (
                  <TableRow
                    key={vp.id}
                    ref={(element) => {
                      if (element) rowRefs.current.set(vp.id, element);
                      else rowRefs.current.delete(vp.id);
                    }}
                    className="scroll-mt-24 transition-colors duration-300"
                  >
                    <TableCell className={highlightClass}>{statusBadge(vp.status)}</TableCell>
                    <TableCell className={`${highlightClass} font-medium`}>
                      <span className="block max-w-[14rem] sm:max-w-xs lg:max-w-md truncate" title={vp.titel ?? undefined}>{formatMT940Title(vp.titel)}</span>
                      {detail && (
                        <div
                          className="text-xs text-muted-foreground mt-0.5 line-clamp-2"
                          title={vp.omschrijving ?? undefined}
                        >
                          {detail}
                        </div>
                      )}
                      <div className="mt-1 text-xs text-muted-foreground lg:hidden">
                        <span className="sm:hidden">{getClientName(vp.client_id)} · </span>
                        {sourceLabel} · {categorieLabel}
                        <span className="md:hidden">
                          {vp.created_at ? ` · ${new Date(vp.created_at).toLocaleDateString("nl-NL")}` : ""}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className={`${highlightClass} hidden sm:table-cell text-sm`}>{getClientName(vp.client_id)}</TableCell>
                    <TableCell className={`${highlightClass} hidden lg:table-cell text-sm`}>{sourceLabel}</TableCell>
                    <TableCell className={`${highlightClass} hidden lg:table-cell text-sm`}>{categorieLabel}</TableCell>
                    <TableCell className={`${highlightClass} hidden md:table-cell text-sm text-muted-foreground`}>
                      {vp.created_at ? new Date(vp.created_at).toLocaleDateString("nl-NL") : "—"}
                    </TableCell>
                    <TableCell className={`${highlightClass} text-right`}>
                      <div className="inline-flex gap-1.5 items-center whitespace-nowrap">
                        {(vp.status === "open" || vp.status === "in_behandeling") && (
                          <>
                            <Button size="sm" variant="outline" className="h-9" onClick={() => handleStatus(vp.id, "opgelost")}>
                              <CheckCircle2 className="h-3.5 w-3.5 sm:mr-1" />
                              <span className="hidden sm:inline">Oplossen</span>
                            </Button>
                            <Button size="sm" variant="ghost" className="h-9" onClick={() => handleStatus(vp.id, "genegeerd")}>
                              <XCircle className="h-3.5 w-3.5 sm:mr-1" />
                              <span className="hidden sm:inline">Negeren</span>
                            </Button>
                          </>
                        )}
                        {(vp.status === "opgelost" || vp.status === "genegeerd") && (
                          <Button size="sm" variant="ghost" className="h-9" onClick={() => handleStatus(vp.id, "open")}>
                            <RotateCcw className="h-3.5 w-3.5 sm:mr-1" />
                            <span className="hidden sm:inline">Heropenen</span>
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Vraagpost verwijderen"
                          className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => deleteConfirm.request(vp.id)}
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
      <AlertDialog open={deleteConfirm.open} onOpenChange={(open) => { if (!open) deleteConfirm.cancel(); }}>
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
