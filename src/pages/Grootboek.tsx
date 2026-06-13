import { useState, useEffect } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { Plus, Pencil, Trash2, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { SearchInput } from "@/components/SearchInput";
import { EmptyState } from "@/components/EmptyState";
import {
  useGrootboekrekeningen,
  useAddGrootboekrekening,
  useUpdateGrootboekrekening,
  useDeleteGrootboekrekening,
  useSeedGrootboekrekeningen,
} from "@/hooks/useGrootboekrekeningen";
import type { Grootboekrekening } from "@/hooks/useGrootboekrekeningen";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";

const CATEGORIEEN = ["activa", "passiva", "omzet", "kosten", "privé"];

const categorieColor: Record<string, string> = {
  activa: "default",
  passiva: "secondary",
  omzet: "default",
  kosten: "destructive",
  privé: "outline",
};

export default function Grootboek() {
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [seedConfirmOpen, setSeedConfirmOpen] = useState(false);
  const [editing, setEditing] = useState<Grootboekrekening | null>(null);
  const [form, setForm] = useState({ nummer: "", omschrijving: "", categorie: "kosten", actief: true });
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

  const filtered = (rekeningen ?? []).filter((r) => {
    const q = search.toLowerCase();
    return (
      r.nummer.toString().includes(q) ||
      r.omschrijving.toLowerCase().includes(q) ||
      r.categorie.toLowerCase().includes(q)
    );
  });

  const openNew = () => {
    setEditing(null);
    setForm({ nummer: "", omschrijving: "", categorie: "kosten", actief: true });
    setDialogOpen(true);
  };

  const openEdit = (r: Grootboekrekening) => {
    setEditing(r);
    setForm({ nummer: r.nummer.toString(), omschrijving: r.omschrijving, categorie: r.categorie, actief: r.actief });
    setDialogOpen(true);
  };

  const handleSave = async () => {
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
    }
  };

  return (
    <>
      <PageHeader title="Grootboekrekeningen" description="Beheer het globale rekeningschema">
        <Button
          variant="outline"
          onClick={() => setSeedConfirmOpen(true)}
          disabled={seedRek.isPending}
        >
          <Download className="mr-2 h-4 w-4" />
          {seedRek.isPending ? "Bezig..." : "Import standaard schema"}
        </Button>
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" />Nieuwe grootboekrekening
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="p-6">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Zoek op nummer of omschrijving..."
            className="mb-4 max-w-sm"
          />

          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground">Laden...</div>
          ) : filtered.length === 0 ? (
            <EmptyState message="Geen grootboekrekeningen gevonden. De standaardrekeningen worden automatisch toegevoegd." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Nummer</TableHead>
                  <TableHead>Omschrijving</TableHead>
                  <TableHead className="w-32">Categorie</TableHead>
                  <TableHead className="w-24">Actief</TableHead>
                  <TableHead className="w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono font-medium">{r.nummer}</TableCell>
                    <TableCell>{r.omschrijving}</TableCell>
                    <TableCell>
                      <Badge variant={categorieColor[r.categorie] as any ?? "secondary"}>
                        {r.categorie}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={r.actief}
                        onCheckedChange={(checked) => updateRek.mutate({ id: r.id, actief: checked })}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleDelete(r.id)}>
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Grootboekrekening bewerken" : "Nieuwe grootboekrekening"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Nummer *</Label>
              <Input
                type="number"
                value={form.nummer}
                onChange={(e) => setForm((p) => ({ ...p, nummer: e.target.value }))}
                placeholder="bijv. 4753"
              />
            </div>
            <div>
              <Label>Omschrijving *</Label>
              <Input
                value={form.omschrijving}
                onChange={(e) => setForm((p) => ({ ...p, omschrijving: e.target.value }))}
                placeholder="bijv. Bankkosten"
              />
            </div>
            <div>
              <Label>Categorie</Label>
              <Select value={form.categorie} onValueChange={(v) => setForm((p) => ({ ...p, categorie: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIEEN.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label>Actief</Label>
              <Switch checked={form.actief} onCheckedChange={(v) => setForm((p) => ({ ...p, actief: v }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Annuleren</Button>
            <Button onClick={handleSave}>{editing ? "Opslaan" : "Toevoegen"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
