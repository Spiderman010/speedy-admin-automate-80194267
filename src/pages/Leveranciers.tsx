import { useState, useMemo } from "react";
import { PageHeader } from "@/components/PageHeader";
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
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClientContext } from "@/hooks/useClientContext";
import { useClients } from "@/hooks/useClients";
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
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { data: clients } = useClients();
  const { data: leveranciers, isLoading } = useLeveranciers(selectedClientId);
  const { data: grootboekrekeningen } = useActiveGrootboekrekeningen();
  const addMut = useAddLeverancier();
  const updateMut = useUpdateLeverancier();
  const deleteMut = useDeleteLeverancier();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<LeverancierForm>(emptyForm);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const grootboekById = useMemo(() => {
    const m = new Map<string, string>();
    grootboekrekeningen?.forEach((g) => m.set(g.id, `${g.nummer} - ${g.omschrijving}`));
    return m;
  }, [grootboekrekeningen]);

  const noClientSelected = !selectedClientId || selectedClientId === "all";

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

  const openDelete = (id: string) => {
    setDeleteId(id);
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteId) return;
    try {
      const { count, error: countError } = await supabase
        .from("purchase_invoices")
        .select("*", { count: "exact", head: true })
        .eq("leverancier_id", deleteId);
      if (countError) throw countError;

      if (count && count > 0) {
        await updateMut.mutateAsync({ id: deleteId, actief: false });
        toast({ title: "Leverancier is gekoppeld aan facturen en is daarom op inactief gezet." });
      } else {
        await deleteMut.mutateAsync(deleteId);
        toast({ title: "Leverancier verwijderd" });
      }
      setDeleteConfirmOpen(false);
      setDeleteId(null);
    } catch (e: any) {
      toast({ title: "Verwijderen mislukt", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leveranciers"
        description="Beheer leveranciers per klant voor inkoopfacturen en UBL"
      >
        <Button onClick={openNew} disabled={noClientSelected}>
          <Plus className="h-4 w-4 mr-2" />
          Nieuwe leverancier
        </Button>
      </PageHeader>

      {noClientSelected && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Kies links in de zijbalk een specifieke klant om diens leveranciers te beheren.
          </CardContent>
        </Card>
      )}

      {!noClientSelected && (
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-6 space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : !leveranciers || leveranciers.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Nog geen leveranciers voor deze klant.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Naam</TableHead>
                    <TableHead>BTW-nummer</TableHead>
                    <TableHead>KvK-nummer</TableHead>
                    <TableHead>Plaats</TableHead>
                    <TableHead>IBAN</TableHead>
                    <TableHead>Standaard grootboek</TableHead>
                    <TableHead>Actief</TableHead>
                    <TableHead className="text-right">Actie</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leveranciers.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="font-medium">{l.naam}</TableCell>
                      <TableCell>{l.btw_nummer ?? "—"}</TableCell>
                      <TableCell>{l.kvk_nummer ?? "—"}</TableCell>
                      <TableCell>{l.plaats ?? "—"}</TableCell>
                      <TableCell>{l.iban ?? "—"}</TableCell>
                      <TableCell>
                        {l.standaard_grootboekrekening_id
                          ? grootboekById.get(l.standaard_grootboekrekening_id) ?? "—"
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {l.actief ? (
                          <Badge variant="secondary">Actief</Badge>
                        ) : (
                          <Badge variant="outline">Inactief</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(l)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "Leverancier bewerken" : "Nieuwe leverancier"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Naam *</Label>
              <Input value={form.naam} onChange={(e) => set("naam", e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>BTW-nummer</Label>
                <Input
                  value={form.btw_nummer}
                  onChange={(e) => set("btw_nummer", e.target.value)}
                  placeholder="NL123456789B01"
                />
              </div>
              <div className="space-y-2">
                <Label>KvK-nummer</Label>
                <Input value={form.kvk_nummer} onChange={(e) => set("kvk_nummer", e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Adres</Label>
              <Input value={form.adres} onChange={(e) => set("adres", e.target.value)} />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label>Postcode</Label>
                <Input value={form.postcode} onChange={(e) => set("postcode", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Plaats</Label>
                <Input value={form.plaats} onChange={(e) => set("plaats", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Land</Label>
                <Input value={form.land} onChange={(e) => set("land", e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>IBAN</Label>
              <Input value={form.iban} onChange={(e) => set("iban", e.target.value)} />
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
            <Button onClick={handleSave} disabled={addMut.isPending || updateMut.isPending}>
              Opslaan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
