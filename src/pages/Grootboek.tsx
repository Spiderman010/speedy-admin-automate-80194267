import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, Download, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { SearchInput } from "@/components/SearchInput";
import { EmptyState } from "@/components/EmptyState";
import { FilterChip } from "@/components/FilterChip";
import { cn } from "@/lib/utils";
import {
  useGrootboekrekeningen,
  useAddGrootboekrekening,
  useUpdateGrootboekrekening,
  useDeleteGrootboekrekening,
  useSeedGrootboekrekeningen,
} from "@/hooks/useGrootboekrekeningen";
import type { Grootboekrekening } from "@/hooks/useGrootboekrekeningen";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";

// Existing categorie values — leading, unchanged.
const CATEGORIEEN = ["activa", "passiva", "omzet", "kosten", "privé"];

const CATEGORIE_LABELS: Record<string, string> = {
  activa: "Activa",
  passiva: "Passiva",
  omzet: "Omzet",
  kosten: "Kosten",
  "privé": "Privé",
};

const CATEGORIE_BADGE_CLASS: Record<string, string> = {
  activa: "border-blue-500/60 bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:text-blue-200",
  passiva: "border-purple-500/60 bg-purple-50 text-purple-900 dark:bg-purple-950/40 dark:text-purple-200",
  omzet: "border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200",
  kosten: "border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  "privé": "border-slate-400/60 bg-slate-50 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
};

type StatusFilter = "alle" | "actief" | "inactief";
type CategorieFilter = "alle" | string;

function GrootboekTableSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Rekeningschema laden…</span>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-12 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-5 w-20 shrink-0 md:block" />
          <Skeleton className="h-5 w-24 shrink-0" />
          <Skeleton className="h-7 w-14 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export default function Grootboek() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("alle");
  const [categorieFilter, setCategorieFilter] = useState<CategorieFilter>("alle");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [seedConfirmOpen, setSeedConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Grootboekrekening | null>(null);
  const [editing, setEditing] = useState<Grootboekrekening | null>(null);
  const [form, setForm] = useState({ nummer: "", omschrijving: "", categorie: "kosten", actief: true });
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const { toast } = useToast();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;

  const { data: rekeningen, isLoading } = useGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });
  const addRek = useAddGrootboekrekening();
  const updateRek = useUpdateGrootboekrekening();
  const deleteRek = useDeleteGrootboekrekening();
  const seedRek = useSeedGrootboekrekeningen();

  // Auto-seed on first load if no records exist
  useEffect(() => {
    if (rekeningen && rekeningen.length === 0) {
      seedRek.mutate(false);
    }
  }, [rekeningen]);

  const totalCount = rekeningen?.length ?? 0;
  const trimmedSearch = search.trim();
  const hasSearch = trimmedSearch !== "";
  const hasStatusFilter = statusFilter !== "alle";
  const hasCategorieFilter = categorieFilter !== "alle";

  const filtered = useMemo(() => {
    const q = trimmedSearch.toLowerCase();
    return (rekeningen ?? []).filter((r) => {
      if (statusFilter === "actief" && !r.actief) return false;
      if (statusFilter === "inactief" && r.actief) return false;
      if (hasCategorieFilter && r.categorie !== categorieFilter) return false;
      if (!q) return true;
      return (
        r.nummer.toString().includes(q) ||
        r.omschrijving.toLowerCase().includes(q) ||
        r.categorie.toLowerCase().includes(q)
      );
    });
  }, [rekeningen, trimmedSearch, statusFilter, categorieFilter, hasCategorieFilter]);

  const emptyMessage = (): string => {
    if (totalCount === 0) {
      return "Nog geen grootboekrekeningen. De standaardrekeningen worden automatisch toegevoegd.";
    }
    if (hasSearch) {
      return `Geen rekeningen gevonden voor “${trimmedSearch}”.`;
    }
    if (hasStatusFilter && hasCategorieFilter) {
      return "Geen rekeningen binnen deze status- en categoriefilter.";
    }
    if (hasStatusFilter) {
      return statusFilter === "actief" ? "Geen actieve rekeningen gevonden." : "Geen inactieve rekeningen gevonden.";
    }
    if (hasCategorieFilter) {
      return `Geen rekeningen gevonden in categorie ${CATEGORIE_LABELS[categorieFilter] ?? categorieFilter}.`;
    }
    return "Geen grootboekrekeningen gevonden.";
  };

  const openNew = () => {
    setEditing(null);
    setForm({ nummer: "", omschrijving: "", categorie: "kosten", actief: true });
    setSubmitAttempted(false);
    setDialogOpen(true);
  };

  const openEdit = (r: Grootboekrekening) => {
    setEditing(r);
    setForm({ nummer: r.nummer.toString(), omschrijving: r.omschrijving, categorie: r.categorie, actief: r.actief });
    setSubmitAttempted(false);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSubmitAttempted(true);
    if (!form.nummer || !form.omschrijving) {
      toast({ title: "Vul alle verplichte velden in", variant: "destructive" });
      return;
    }

    try {
      if (editing) {
        await updateRek.mutateAsync({
          id: editing.id,
          nummer: parseInt(form.nummer),
          omschrijving: form.omschrijving,
          categorie: form.categorie,
          actief: form.actief,
        });
        toast({ title: "Grootboekrekening bijgewerkt" });
      } else {
        await addRek.mutateAsync({
          nummer: parseInt(form.nummer),
          omschrijving: form.omschrijving,
          categorie: form.categorie,
          actief: form.actief,
        });
        toast({ title: "Grootboekrekening toegevoegd" });
      }
      setDialogOpen(false);
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteRek.mutateAsync(id);
      toast({ title: "Grootboekrekening verwijderd" });
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <>
      {/* Shell header shows "Grootboek"; keep h1 for a11y + to name the page correctly. */}
      <h1 className="sr-only">Rekeningschema</h1>

      {/* Compact action bar: search left, actions right, wraps on mobile. */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Zoek op nummer, omschrijving of categorie…"
          className="w-full sm:max-w-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" asChild>
            <Link to="/grootboek/mutaties">
              <ArrowUpRight className="mr-2 h-4 w-4" />Mutaties bekijken
            </Link>
          </Button>
          {/* Fase 6C-b6: memoriaal hangt onder Grootboek, zonder eigen nav-item. */}
          <Button variant="outline" asChild>
            <Link to="/grootboek/memoriaal">
              <ArrowUpRight className="mr-2 h-4 w-4" />Memoriaalboekingen
            </Link>
          </Button>
          <Button
            variant="outline"
            onClick={() => setSeedConfirmOpen(true)}
            disabled={seedRek.isPending}
          >
            <Download className="mr-2 h-4 w-4" />
            {seedRek.isPending ? "Bezig…" : "Import standaard schema"}
          </Button>
          <Button onClick={openNew}>
            <Plus className="mr-2 h-4 w-4" />Nieuwe grootboekrekening
          </Button>
        </div>
      </div>

      {/* Summarising filter chips — client-side only, stamgegevens don't need a query rework. */}
      <div className="mb-4 space-y-2">
        <div data-testid="status-filters" className="flex flex-wrap items-center gap-1.5">
          <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Status</span>
          <FilterChip label="Alle" active={statusFilter === "alle"} onClick={() => setStatusFilter("alle")} />
          <FilterChip
            label="Actief"
            active={statusFilter === "actief"}
            onClick={() => setStatusFilter(statusFilter === "actief" ? "alle" : "actief")}
          />
          <FilterChip
            label="Inactief"
            active={statusFilter === "inactief"}
            onClick={() => setStatusFilter(statusFilter === "inactief" ? "alle" : "inactief")}
          />
        </div>
        <div data-testid="categorie-filters" className="flex flex-wrap items-center gap-1.5">
          <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Categorie</span>
          <FilterChip label="Alle" active={categorieFilter === "alle"} onClick={() => setCategorieFilter("alle")} />
          {CATEGORIEEN.map((c) => (
            <FilterChip
              key={c}
              label={CATEGORIE_LABELS[c]}
              active={categorieFilter === c}
              onClick={() => setCategorieFilter(categorieFilter === c ? "alle" : c)}
            />
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-6">
          {isLoading ? (
            <GrootboekTableSkeleton />
          ) : filtered.length === 0 ? (
            <EmptyState message={emptyMessage()} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Nummer</TableHead>
                    <TableHead>Omschrijving</TableHead>
                    <TableHead className="hidden w-32 md:table-cell" data-testid="categorie-column-header">
                      Categorie
                    </TableHead>
                    <TableHead className="w-40">Status</TableHead>
                    <TableHead className="w-20 text-right">Acties</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => {
                    const togglePending = updateRek.isPending && updateRek.variables?.id === r.id;
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono font-medium tabular-nums">{r.nummer}</TableCell>
                        <TableCell>{r.omschrijving}</TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Badge
                            variant="outline"
                            className={cn(CATEGORIE_BADGE_CLASS[r.categorie] ?? "border-border bg-muted text-muted-foreground")}
                          >
                            {CATEGORIE_LABELS[r.categorie] ?? r.categorie}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={r.actief}
                              onCheckedChange={(checked) => updateRek.mutate({ id: r.id, actief: checked })}
                              disabled={togglePending}
                              aria-label={`${r.omschrijving} ${r.actief ? "actief" : "inactief"}`}
                              title="Wijziging wordt direct opgeslagen"
                            />
                            <Badge
                              variant="outline"
                              className={cn(
                                r.actief
                                  ? "border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200"
                                  : "border-border bg-muted text-muted-foreground",
                              )}
                            >
                              {r.actief ? "Actief" : "Inactief"}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openEdit(r)}
                              aria-label={`${r.omschrijving} bewerken`}
                              title="Bewerken"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDeleteTarget(r)}
                              aria-label={`${r.omschrijving} verwijderen`}
                              title="Verwijderen"
                            >
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Standaard schema import — existing seed mutation and warning, unchanged semantics. */}
      <AlertDialog open={seedConfirmOpen} onOpenChange={setSeedConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Standaard grootboekrekeningen importeren?</AlertDialogTitle>
            <AlertDialogDescription>
              Weet je zeker dat je de standaard grootboekrekeningen wilt importeren? Dit kan bestaande
              grootboekrekeningen aanpassen of vervangen. Deze actie kan niet automatisch ongedaan worden gemaakt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={seedRek.isPending}>Annuleren</AlertDialogCancel>
            <AlertDialogAction
              disabled={seedRek.isPending}
              onClick={(e) => {
                e.preventDefault();
                seedRek.mutate(true as any, {
                  onSuccess: () => {
                    toast({ title: "190 grootboekrekeningen geïmporteerd ✅" });
                    setSeedConfirmOpen(false);
                  },
                  onError: (err: any) => {
                    toast({ title: "Fout bij importeren", description: err.message, variant: "destructive" });
                    setSeedConfirmOpen(false);
                  },
                });
              }}
            >
              Importeren
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation — new safety gate in front of the existing delete mutation. */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Grootboekrekening verwijderen?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `Rekening ${deleteTarget.nummer} — ${deleteTarget.omschrijving} kan in bestaande boekingen worden gebruikt. Verwijderen kan mislukken als er nog verwijzingen bestaan.`
                : "Deze rekening kan in bestaande boekingen worden gebruikt. Verwijderen kan mislukken als er nog verwijzingen bestaan."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteRek.isPending}>Annuleren</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteRek.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) handleDelete(deleteTarget.id);
              }}
            >
              {deleteRek.isPending ? "Bezig…" : "Verwijderen"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Grootboekrekening bewerken" : "Nieuwe grootboekrekening"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="gb-nummer">Nummer *</Label>
              <Input
                id="gb-nummer"
                type="number"
                value={form.nummer}
                onChange={(e) => setForm((p) => ({ ...p, nummer: e.target.value }))}
                placeholder="bijv. 4753"
                aria-invalid={submitAttempted && !form.nummer}
                className={cn(submitAttempted && !form.nummer && "border-destructive focus-visible:ring-destructive")}
              />
              {submitAttempted && !form.nummer && (
                <p className="text-xs text-destructive">Rekeningnummer is verplicht.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gb-omschrijving">Omschrijving *</Label>
              <Input
                id="gb-omschrijving"
                value={form.omschrijving}
                onChange={(e) => setForm((p) => ({ ...p, omschrijving: e.target.value }))}
                placeholder="bijv. Bankkosten"
                aria-invalid={submitAttempted && !form.omschrijving}
                className={cn(submitAttempted && !form.omschrijving && "border-destructive focus-visible:ring-destructive")}
              />
              {submitAttempted && !form.omschrijving && (
                <p className="text-xs text-destructive">Omschrijving is verplicht.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gb-categorie">Categorie</Label>
              <Select value={form.categorie} onValueChange={(v) => setForm((p) => ({ ...p, categorie: v }))}>
                <SelectTrigger id="gb-categorie"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIEEN.map((c) => (
                    <SelectItem key={c} value={c}>{CATEGORIE_LABELS[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <Label htmlFor="gb-actief" className="cursor-pointer">Actief</Label>
              <Switch id="gb-actief" checked={form.actief} onCheckedChange={(v) => setForm((p) => ({ ...p, actief: v }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Annuleren</Button>
            <Button onClick={handleSave} disabled={addRek.isPending || updateRek.isPending}>
              {addRek.isPending || updateRek.isPending ? "Bezig…" : editing ? "Opslaan" : "Toevoegen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
