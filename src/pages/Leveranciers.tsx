import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Building2, Plus, Pencil, Search, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import {
  useLeveranciers,
  useAddLeverancier,
  useUpdateLeverancier,
  useDeleteLeverancier,
  normalizeBtwNummer,
} from "@/hooks/useLeveranciers";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { NoClientBanner } from "@/components/NoClientBanner";
import { FilterChip } from "@/components/FilterChip";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";

type Leverancier = Tables<"leveranciers">;

interface LeverancierForm {
  naam: string;
  btw_nummer: string;
  kvk_nummer: string;
  adres: string;
  postcode: string;
  plaats: string;
  land: string;
  iban: string;
  standaard_grootboekrekening_id: string;
  actief: boolean;
}

const emptyForm: LeverancierForm = {
  naam: "",
  btw_nummer: "",
  kvk_nummer: "",
  adres: "",
  postcode: "",
  plaats: "",
  land: "NL",
  iban: "",
  standaard_grootboekrekening_id: "",
  actief: true,
};

export default function Leveranciers() {
  const { toast } = useToast();
  const { selectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const { data: leveranciers, isLoading, isError, refetch } = useLeveranciers({
    organizationId: activeOrganizationId ?? undefined,
    clientId: selectedClientId !== "all" ? selectedClientId : undefined,
    enabled: isReady && activeOrganizationId !== null,
  });
  const { data: grootboekrekeningen } = useActiveGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });
  const addMut = useAddLeverancier();
  const updateMut = useUpdateLeverancier();
  const deleteMut = useDeleteLeverancier();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<LeverancierForm>(emptyForm);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "actief" | "inactief">("all");
  const deleteConfirm = useDeleteConfirm();

  const grootboekById = useMemo(() => {
    const m = new Map<string, string>();
    grootboekrekeningen?.forEach((g) => m.set(g.id, `${g.nummer} - ${g.omschrijving}`));
    return m;
  }, [grootboekrekeningen]);

  const noClientSelected = !selectedClientId || selectedClientId === "all";

  const searchFiltered = useMemo(() => {
    const list = leveranciers ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((l) =>
      [l.naam, l.btw_nummer, l.kvk_nummer, l.plaats, l.iban]
        .some((v) => (v ?? "").toLowerCase().includes(q))
    );
  }, [leveranciers, searchQuery]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return searchFiltered;
    return searchFiltered.filter((l) => (statusFilter === "actief" ? l.actief : !l.actief));
  }, [searchFiltered, statusFilter]);

  const activeCount = searchFiltered.filter((l) => l.actief).length;
  const inactiveCount = searchFiltered.length - activeCount;

  const openNew = () => {
    setEditingId(null);
    setForm(emptyForm);
    setOpen(true);
  };

  const openEdit = (l: Leverancier) => {
    setEditingId(l.id);
    setForm({
      naam: l.naam,
      btw_nummer: l.btw_nummer ?? "",
      kvk_nummer: l.kvk_nummer ?? "",
      adres: l.adres ?? "",
      postcode: l.postcode ?? "",
      plaats: l.plaats ?? "",
      land: l.land ?? "NL",
      iban: l.iban ?? "",
      standaard_grootboekrekening_id: l.standaard_grootboekrekening_id ?? "",
      actief: l.actief,
    });
    setOpen(true);
  };

  const handleSave = async () => {
    if (!form.naam.trim()) {
      toast({ title: "Naam is verplicht", variant: "destructive" });
      return;
    }
    if (noClientSelected) {
      toast({ title: "Kies eerst een klant", variant: "destructive" });
      return;
    }

    const payload = {
      client_id: selectedClientId,
      naam: form.naam.trim(),
      btw_nummer: form.btw_nummer ? normalizeBtwNummer(form.btw_nummer) : null,
      kvk_nummer: form.kvk_nummer.trim() || null,
      adres: form.adres.trim() || null,
      postcode: form.postcode.trim() || null,
      plaats: form.plaats.trim() || null,
      land: form.land.trim() || "NL",
      iban: form.iban.trim() || null,
      standaard_grootboekrekening_id: form.standaard_grootboekrekening_id || null,
      actief: form.actief,
    };

    try {
      if (editingId) {
        await updateMut.mutateAsync({ id: editingId, ...payload });
        toast({ title: "Leverancier bijgewerkt" });
      } else {
        await addMut.mutateAsync(payload);
        toast({ title: "Leverancier toegevoegd" });
      }
      setOpen(false);
    } catch (e: any) {
      toast({ title: "Opslaan mislukt", description: e.message, variant: "destructive" });
    }
  };

  const set = <K extends keyof LeverancierForm>(k: K, v: LeverancierForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleDeleteConfirm = async () => {
    if (!deleteConfirm.pendingId) return;
    try {
      const { count, error: countError } = await supabase
        .from("purchase_invoices")
        .select("*", { count: "exact", head: true })
        .eq("leverancier_id", deleteConfirm.pendingId);
      if (countError) throw countError;

      if (count && count > 0) {
        await updateMut.mutateAsync({ id: deleteConfirm.pendingId, actief: false });
        toast({ title: "Leverancier is gekoppeld aan facturen en is daarom op inactief gezet." });
      } else {
        await deleteMut.mutateAsync(deleteConfirm.pendingId);
        toast({ title: "Leverancier verwijderd" });
      }
      deleteConfirm.cancel();
    } catch (e: any) {
      toast({ title: "Verwijderen mislukt", description: e.message, variant: "destructive" });
    }
  };

  const saving = addMut.isPending || updateMut.isPending;

  const emptyTitle = searchQuery.trim()
    ? "Geen zoekresultaten"
    : statusFilter === "actief"
    ? "Geen actieve leveranciers"
    : statusFilter === "inactief"
    ? "Geen inactieve leveranciers"
    : "Nog geen leveranciers";

  const emptyDescription = searchQuery.trim()
    ? "Pas je zoekterm aan om meer leveranciers te zien."
    : statusFilter !== "all"
    ? "Kies een andere status om meer leveranciers te zien."
    : "Voeg de eerste leverancier van deze klant toe.";

  return (
    <>
      <h1 className="sr-only">Leveranciers</h1>

      {noClientSelected ? (
        <NoClientBanner message="Kies links in de zijbalk een specifieke klant om diens leveranciers te beheren." />
      ) : (
        <>
          <div className="mb-4 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full max-w-md flex-1 min-w-[12rem]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Zoeken op naam, BTW, KvK, plaats of IBAN..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  aria-label="Zoeken in leveranciers"
                />
              </div>
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {filtered.length} {filtered.length === 1 ? "leverancier" : "leveranciers"}
              </span>
              <Button className="ml-auto" onClick={openNew} disabled={noClientSelected}>
                <Plus className="h-4 w-4 mr-2" />
                Nieuwe leverancier
              </Button>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <FilterChip
                label="Alle"
                active={statusFilter === "all"}
                count={searchFiltered.length}
                onClick={() => setStatusFilter("all")}
              />
              <FilterChip
                label="Actief"
                active={statusFilter === "actief"}
                count={activeCount}
                onClick={() => setStatusFilter(statusFilter === "actief" ? "all" : "actief")}
              />
              <FilterChip
                label="Inactief"
                active={statusFilter === "inactief"}
                count={inactiveCount}
                onClick={() => setStatusFilter(statusFilter === "inactief" ? "all" : "inactief")}
              />
            </div>
          </div>

          <Card>
            <CardContent className="overflow-x-auto p-4 sm:p-6">
              {isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : isError ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10 mb-4">
                    <AlertTriangle className="h-8 w-8 text-destructive" />
                  </div>
                  <h2 className="font-display text-lg font-semibold">Leveranciers laden mislukt</h2>
                  <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                    Er ging iets mis bij het ophalen van de leveranciers.
                  </p>
                  <Button className="mt-4" variant="outline" onClick={() => refetch()}>
                    Opnieuw proberen
                  </Button>
                </div>
              ) : !filtered.length ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                    <Building2 className="h-8 w-8 text-primary" />
                  </div>
                  <h2 className="font-display text-lg font-semibold">{emptyTitle}</h2>
                  <p className="mt-1 max-w-sm text-sm text-muted-foreground">{emptyDescription}</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Naam</TableHead>
                      <TableHead className="hidden md:table-cell">BTW-nummer</TableHead>
                      <TableHead className="hidden lg:table-cell">KvK-nummer</TableHead>
                      <TableHead className="hidden sm:table-cell">Plaats</TableHead>
                      <TableHead className="hidden lg:table-cell">IBAN</TableHead>
                      <TableHead className="hidden lg:table-cell">Standaard grootboek</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actie</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((l) => {
                      const grootboekLabel = l.standaard_grootboekrekening_id
                        ? grootboekById.get(l.standaard_grootboekrekening_id) ?? "—"
                        : "—";
                      const secundair = [l.btw_nummer, l.kvk_nummer, l.iban].filter(Boolean).join(" · ");
                      return (
                        <TableRow key={l.id}>
                          <TableCell className="font-medium">
                            {l.naam}
                            <div className="mt-0.5 text-xs text-muted-foreground lg:hidden">
                              <span className="sm:hidden">{l.plaats ? `${l.plaats}${secundair ? " · " : ""}` : ""}</span>
                              <span className="md:hidden">{secundair}</span>
                              <span className="hidden md:inline">
                                {[l.kvk_nummer, l.iban].filter(Boolean).join(" · ")}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">{l.btw_nummer ?? "—"}</TableCell>
                          <TableCell className="hidden lg:table-cell">{l.kvk_nummer ?? "—"}</TableCell>
                          <TableCell className="hidden sm:table-cell">{l.plaats ?? "—"}</TableCell>
                          <TableCell className="hidden lg:table-cell">{l.iban ?? "—"}</TableCell>
                          <TableCell className="hidden lg:table-cell">{grootboekLabel}</TableCell>
                          <TableCell>
                            {l.actief ? (
                              <Badge variant="secondary">Actief</Badge>
                            ) : (
                              <Badge variant="outline">Inactief</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Leverancier ${l.naam} bewerken`}
                                onClick={() => openEdit(l)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Leverancier ${l.naam} verwijderen`}
                                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => deleteConfirm.request(l.id)}
                              >
                                <Trash2 className="h-4 w-4" />
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
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "Leverancier bewerken" : "Nieuwe leverancier"}</DialogTitle>
            <DialogDescription>Velden met * zijn verplicht.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="lev-naam">Naam *</Label>
              <Input id="lev-naam" value={form.naam} onChange={(e) => set("naam", e.target.value)} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="lev-btw">BTW-nummer</Label>
                <Input
                  id="lev-btw"
                  value={form.btw_nummer}
                  onChange={(e) => set("btw_nummer", e.target.value)}
                  placeholder="NL123456789B01"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lev-kvk">KvK-nummer</Label>
                <Input id="lev-kvk" value={form.kvk_nummer} onChange={(e) => set("kvk_nummer", e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="lev-adres">Adres</Label>
              <Input id="lev-adres" value={form.adres} onChange={(e) => set("adres", e.target.value)} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="lev-postcode">Postcode</Label>
                <Input id="lev-postcode" value={form.postcode} onChange={(e) => set("postcode", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lev-plaats">Plaats</Label>
                <Input id="lev-plaats" value={form.plaats} onChange={(e) => set("plaats", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lev-land">Land</Label>
                <Input id="lev-land" value={form.land} onChange={(e) => set("land", e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="lev-iban">IBAN</Label>
                <Input id="lev-iban" value={form.iban} onChange={(e) => set("iban", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Standaard grootboekrekening</Label>
                <GrootboekCombobox
                  value={form.standaard_grootboekrekening_id ? (grootboekById.get(form.standaard_grootboekrekening_id) ?? "") : ""}
                  onValueChange={() => {}}
                  onIdChange={(id) => set("standaard_grootboekrekening_id", id || "")}
                  noneOption
                  placeholder="Geen"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Switch
                id="actief"
                checked={form.actief}
                onCheckedChange={(v) => set("actief", v)}
              />
              <Label htmlFor="actief" className="cursor-pointer">
                Actief
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Annuleren
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Bezig met opslaan..." : "Opslaan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteConfirm.open} onOpenChange={(o) => { if (!o) deleteConfirm.cancel(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leverancier verwijderen?</AlertDialogTitle>
            <AlertDialogDescription>
              Als deze leverancier al aan facturen gekoppeld is, wordt hij veilig op inactief gezet in
              plaats van verwijderd. Anders wordt de leverancier definitief verwijderd.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => deleteConfirm.cancel()}>Annuleren</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} disabled={deleteMut.isPending || updateMut.isPending}>
              Verwijderen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
