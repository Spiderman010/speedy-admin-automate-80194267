import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Building2, Trash2, Pencil, X, ArrowUp, ArrowDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClients, useAddClient, useUpdateClient, useDeleteClient } from "@/hooks/useClients";
import { usePurchaseInvoices } from "@/hooks/usePurchaseInvoices";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchInput } from "@/components/SearchInput";
import { EmptyState } from "@/components/EmptyState";

interface ClientForm {
  name: string;
  kvk_number: string;
  btw_number: string;
  contact_person: string;
  email: string;
  phone: string;
  address: string;
  postal_code: string;
  city: string;
  country: string;
  btw_vrijgesteld: boolean;
  rechtsvorm: string;
  btw_type: string;
  ibans: string[];
  verwerkingsfrequentie: string;
  inkoop_dagboek: string;
  verkoop_dagboek: string;
  bank_dagboek: string;
  afgesloten_boekjaar: string;
  snelstart_inkoop_mailbox: string;
}

const emptyForm: ClientForm = {
  name: "",
  kvk_number: "",
  btw_number: "",
  contact_person: "",
  email: "",
  phone: "",
  address: "",
  postal_code: "",
  city: "",
  country: "NL",
  btw_vrijgesteld: false,
  rechtsvorm: "",
  btw_type: "plichtig",
  ibans: [],
  verwerkingsfrequentie: "kwartaal",
  inkoop_dagboek: "",
  verkoop_dagboek: "",
  bank_dagboek: "",
  afgesloten_boekjaar: "",
  snelstart_inkoop_mailbox: "",
};

function validateKvk(v: string): string | null {
  if (!v) return null;
  return /^\d{8}$/.test(v) ? null : "KvK nummer moet 8 cijfers bevatten";
}

function validateBtw(v: string): string | null {
  if (!v) return null;
  return /^NL\d{9}B\d{2}$/.test(v.replace(/\s/g, "")) ? null : "Ongeldig BTW nummer formaat";
}

function validateEmail(v: string): string | null {
  if (!v) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "Ongeldig e-mailadres";
}

function validateIban(v: string): string | null {
  if (!v) return null;
  const clean = v.replace(/\s/g, "");
  return /^NL\w{16}$/.test(clean) && clean.length === 18 ? null : "Ongeldig IBAN formaat";
}

type SortKey = "name" | "rechtsvorm" | "status";
type SortDir = "asc" | "desc";

const verwerkingsLabels: Record<string, string> = {
  maandelijks: "Maandelijks",
  kwartaal: "Kwartaal",
  jaarlijks: "Jaarlijks",
};

export default function Klanten() {
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ClientForm>({ ...emptyForm });
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const { toast } = useToast();

  const { data: clients, isLoading } = useClients();
  const { data: invoices } = usePurchaseInvoices();
  const addClient = useAddClient();
  const updateClient = useUpdateClient();
  const deleteClient = useDeleteClient();

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const SortArrow = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return null;
    return sortDir === "asc" ? <ArrowUp className="inline h-3 w-3 ml-1" /> : <ArrowDown className="inline h-3 w-3 ml-1" />;
  };

  const getOpenTasks = (clientId: string) =>
    invoices?.filter((i) => i.client_id === clientId && i.status === "te_controleren").length ?? 0;

  const filtered = (clients ?? []).filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.kvk_number || "").includes(search) ||
      (c.btw_number || "").toLowerCase().includes(search.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    if (sortKey === "name") return dir * a.name.localeCompare(b.name);
    if (sortKey === "rechtsvorm") return dir * (a.rechtsvorm || "").localeCompare(b.rechtsvorm || "");
    if (sortKey === "status") {
      const aT = getOpenTasks(a.id);
      const bT = getOpenTasks(b.id);
      return dir * (aT - bT);
    }
    return 0;
  });

  const resetForm = () => {
    setForm({ ...emptyForm });
    setEditingId(null);
  };

  const openEdit = (client: any) => {
    setForm({
      name: client.name,
      kvk_number: client.kvk_number || "",
      btw_number: client.btw_number || "",
      contact_person: client.contact_person || "",
      email: client.email || "",
      phone: client.phone || "",
      address: client.address || "",
      postal_code: client.postal_code || "",
      city: client.city || "",
      country: client.country || "NL",
      btw_vrijgesteld: client.btw_vrijgesteld ?? false,
      rechtsvorm: client.rechtsvorm || "",
      btw_type: client.btw_type || "plichtig",
      ibans: client.ibans || [],
      verwerkingsfrequentie: client.verwerkingsfrequentie || "kwartaal",
      inkoop_dagboek: client.inkoop_dagboek != null ? String(client.inkoop_dagboek) : "",
      verkoop_dagboek: client.verkoop_dagboek != null ? String(client.verkoop_dagboek) : "",
      bank_dagboek: client.bank_dagboek != null ? String(client.bank_dagboek) : "",
      afgesloten_boekjaar: client.afgesloten_boekjaar != null ? String(client.afgesloten_boekjaar) : "",
      snelstart_inkoop_mailbox: client.snelstart_inkoop_mailbox || "",
    });
    setEditingId(client.id);
    setShowDialog(true);
  };

  const toIntOrNull = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast({ title: "Vul een bedrijfsnaam in", variant: "destructive" });
      return;
    }
    try {
      const payload = {
        name: form.name,
        kvk_number: form.kvk_number || null,
        btw_number: form.btw_number || null,
        contact_person: form.contact_person || null,
        email: form.email || null,
        phone: form.phone || null,
        address: form.address || null,
        postal_code: form.postal_code || null,
        city: form.city || null,
        country: form.country || "NL",
        btw_vrijgesteld: form.btw_type === "vrijgesteld",
        rechtsvorm: form.rechtsvorm || null,
        btw_type: form.btw_type,
        ibans: form.ibans.filter(Boolean),
        verwerkingsfrequentie: form.verwerkingsfrequentie,
        inkoop_dagboek: toIntOrNull(form.inkoop_dagboek),
        verkoop_dagboek: toIntOrNull(form.verkoop_dagboek),
        bank_dagboek: toIntOrNull(form.bank_dagboek),
        afgesloten_boekjaar: toIntOrNull(form.afgesloten_boekjaar),
        snelstart_inkoop_mailbox: form.snelstart_inkoop_mailbox.trim() || null,
      };
      if (editingId) {
        await updateClient.mutateAsync({ id: editingId, ...payload });
        toast({ title: "Klant bijgewerkt" });
      } else {
        await addClient.mutateAsync(payload);
        toast({ title: "Klant toegevoegd" });
      }
      setShowDialog(false);
      resetForm();
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteClient.mutateAsync(deleteTarget.id);
      toast({ title: "Klant verwijderd" });
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    } finally {
      setDeleteTarget(null);
    }
  };

  const kvkError = validateKvk(form.kvk_number);
  const btwError = validateBtw(form.btw_number);
  const emailError = validateEmail(form.email);

  return (
    <>
      <PageHeader title="Klanten" description="Beheer klantadministraties">
        <Button onClick={() => { resetForm(); setShowDialog(true); }}>
          <Plus className="mr-2 h-4 w-4" />
          Nieuwe klant
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Zoek op naam, KvK of BTW-nummer..."
              className="flex-1"
            />
          </div>

          {isLoading ? (
            <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : sorted.length === 0 ? (
            <EmptyState
              message={clients?.length === 0 ? "Nog geen klanten. Voeg je eerste klant toe!" : "Geen resultaten gevonden."}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("name")}>
                    Bedrijf<SortArrow col="name" />
                  </TableHead>
                  <TableHead>KvK</TableHead>
                  <TableHead>BTW-nummer</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("rechtsvorm")}>
                    Rechtsvorm<SortArrow col="rechtsvorm" />
                  </TableHead>
                  <TableHead>Contactpersoon</TableHead>
                  <TableHead>Frequentie</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("status")}>
                    Status<SortArrow col="status" />
                  </TableHead>
                  <TableHead className="w-28 text-right"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((client) => {
                  const openTasks = getOpenTasks(client.id);
                  const btwLabel = client.btw_type === "vrijgesteld" ? "Vrijgesteld" : client.btw_type === "mix" ? "Mix" : null;
                  return (
                    <TableRow key={client.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                            <Building2 className="h-4 w-4 text-primary" />
                          </div>
                          <div>
                            <p className="font-medium">{client.name}</p>
                            <p className="text-xs text-muted-foreground">{client.email || "—"}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{client.kvk_number || "—"}</TableCell>
                      <TableCell className="font-mono text-sm">
                        {client.btw_number || "—"}
                        {btwLabel && <Badge variant="secondary" className="ml-2 text-[10px]">{btwLabel}</Badge>}
                      </TableCell>
                      <TableCell className="text-sm">{client.rechtsvorm || "—"}</TableCell>
                      <TableCell>{client.contact_person || "—"}</TableCell>
                      <TableCell className="text-sm">{verwerkingsLabels[(client as any).verwerkingsfrequentie] || "Kwartaal"}</TableCell>
                      <TableCell>
                        <Badge variant={openTasks === 0 ? "default" : openTasks > 3 ? "destructive" : "secondary"}>
                          {openTasks === 0 ? "Bijgewerkt" : `${openTasks} taken`}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2 text-muted-foreground"
                            onClick={() => openEdit(client)}
                            title="Klant bewerken"
                            aria-label={`Bewerk ${client.name}`}
                          >
                            <Pencil className="mr-1 h-4 w-4" />Bewerken
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeleteTarget({ id: client.id, name: client.name })}
                            title="Klant verwijderen"
                            aria-label={`Verwijder ${client.name}`}
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
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

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Klant verwijderen?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                {deleteTarget && (
                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-foreground">
                    <span className="font-medium">{deleteTarget.name}</span>
                  </div>
                )}
                <p>
                  Weet je zeker dat je deze klant wilt verwijderen? Dit kan gevolgen hebben voor
                  gekoppelde facturen, banktransacties en vraagposten. Deze actie kan niet ongedaan
                  worden gemaakt.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteClient.isPending}>Annuleren</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteClient.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (e) => {
                e.preventDefault();
                await handleConfirmDelete();
              }}
            >
              Verwijderen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showDialog} onOpenChange={(o) => { if (!o) resetForm(); setShowDialog(o); }}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">{editingId ? "Klant bewerken" : "Nieuwe klant toevoegen"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {/* Bedrijfsnaam */}
            <div className="grid gap-2">
              <Label htmlFor="name">Bedrijfsnaam *</Label>
              <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Bijv. Bakkerij De Gouden Aar"
                className={!form.name.trim() && editingId ? "border-destructive" : ""}
              />
            </div>

            {/* Rechtsvorm + KvK */}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Rechtsvorm</Label>
                <Select value={form.rechtsvorm || "none"} onValueChange={(v) => setForm({ ...form, rechtsvorm: v === "none" ? "" : v })}>
                  <SelectTrigger><SelectValue placeholder="Selecteer..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— Niet ingesteld —</SelectItem>
                    <SelectItem value="eenmanszaak">Eenmanszaak</SelectItem>
                    <SelectItem value="bv">BV</SelectItem>
                    <SelectItem value="vof">VOF</SelectItem>
                    <SelectItem value="anders">Anders</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="kvk">KvK-nummer</Label>
                <Input id="kvk" value={form.kvk_number} onChange={(e) => setForm({ ...form, kvk_number: e.target.value })}
                  placeholder="12345678"
                  className={kvkError ? "border-destructive" : ""}
                />
                {kvkError && <p className="text-xs text-destructive">{kvkError}</p>}
              </div>
            </div>

            {/* BTW type + BTW nummer */}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>BTW type</Label>
                <Select value={form.btw_type} onValueChange={(v) => setForm({ ...form, btw_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plichtig">BTW plichtig</SelectItem>
                    <SelectItem value="vrijgesteld">BTW vrijgesteld</SelectItem>
                    <SelectItem value="mix">Mix</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="btw">BTW-nummer</Label>
                <Input id="btw" value={form.btw_number} onChange={(e) => setForm({ ...form, btw_number: e.target.value })}
                  placeholder="NL123456789B01"
                  className={btwError ? "border-destructive" : ""}
                />
                {btwError && <p className="text-xs text-destructive">{btwError}</p>}
              </div>
            </div>

            {/* Contact + Email */}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="contact">Contactpersoon</Label>
                <Input id="contact" value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} placeholder="Jan Jansen" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">E-mail</Label>
                <Input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="jan@bedrijf.nl"
                  className={emailError ? "border-destructive" : ""}
                />
                {emailError && <p className="text-xs text-destructive">{emailError}</p>}
              </div>
            </div>

            {/* Telefoon */}
            <div className="grid gap-2">
              <Label htmlFor="phone">Telefoon</Label>
              <Input id="phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+31 6 00000000" />
            </div>

            {/* Adres */}
            <div className="grid gap-2">
              <Label htmlFor="address">Adres</Label>
              <Input id="address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Straat 1" />
            </div>

            {/* Postcode + Plaats + Land */}
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="postal_code">Postcode</Label>
                <Input id="postal_code" value={form.postal_code} onChange={(e) => setForm({ ...form, postal_code: e.target.value })} placeholder="1234 AB" />
                {form.postal_code && !/^[1-9][0-9]{3}\s?[A-Za-z]{2}$/.test(form.postal_code.trim()) && (
                  <p className="text-xs text-muted-foreground">Tip: Nederlandse postcode is 4 cijfers + 2 letters</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="city">Plaats</Label>
                <Input id="city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Amsterdam" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="country">Land</Label>
                <Input id="country" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="NL" />
              </div>
            </div>

            {/* Verwerkingsfrequentie */}
            <div className="grid gap-2">
              <Label>Verwerkingsfrequentie</Label>
              <Select value={form.verwerkingsfrequentie} onValueChange={(v) => setForm({ ...form, verwerkingsfrequentie: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="maandelijks">Maandelijks</SelectItem>
                  <SelectItem value="kwartaal">Kwartaal</SelectItem>
                  <SelectItem value="jaarlijks">Jaarlijks</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* SnelStart instellingen */}
            <div className="grid gap-2">
              <Label className="text-sm font-semibold">SnelStart instellingen</Label>
              <div className="grid grid-cols-3 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="inkoop_dagboek" className="text-xs font-normal">Inkoop-dagboek</Label>
                  <Input id="inkoop_dagboek" inputMode="numeric" value={form.inkoop_dagboek} onChange={(e) => setForm({ ...form, inkoop_dagboek: e.target.value.replace(/[^0-9]/g, "") })} placeholder="bv. 700" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="verkoop_dagboek" className="text-xs font-normal">Verkoop-dagboek</Label>
                  <Input id="verkoop_dagboek" inputMode="numeric" value={form.verkoop_dagboek} onChange={(e) => setForm({ ...form, verkoop_dagboek: e.target.value.replace(/[^0-9]/g, "") })} placeholder="bv. 800" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="bank_dagboek" className="text-xs font-normal">Bank-dagboek</Label>
                  <Input id="bank_dagboek" inputMode="numeric" value={form.bank_dagboek} onChange={(e) => setForm({ ...form, bank_dagboek: e.target.value.replace(/[^0-9]/g, "") })} placeholder="bv. 1100" />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="afgesloten_boekjaar" className="text-xs font-normal">Afgesloten boekjaar</Label>
                <Input id="afgesloten_boekjaar" inputMode="numeric" value={form.afgesloten_boekjaar} onChange={(e) => setForm({ ...form, afgesloten_boekjaar: e.target.value.replace(/[^0-9]/g, "") })} placeholder="bv. 2024" className="max-w-[160px]" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="snelstart_inkoop_mailbox" className="text-xs font-normal">SnelStart inkoopmailbox</Label>
                <Input
                  id="snelstart_inkoop_mailbox"
                  type="email"
                  value={form.snelstart_inkoop_mailbox}
                  onChange={(e) => setForm({ ...form, snelstart_inkoop_mailbox: e.target.value })}
                  placeholder="bijvoorbeeld administratie@..."
                  className={validateEmail(form.snelstart_inkoop_mailbox) ? "border-destructive" : ""}
                />
                {validateEmail(form.snelstart_inkoop_mailbox) && (
                  <p className="text-xs text-muted-foreground">Tip: vul een geldig e-mailadres in</p>
                )}
              </div>
            </div>

            {/* Zakelijk IBAN */}
            <div className="grid gap-2">
              <Label>Zakelijk IBAN</Label>
              {form.ibans.map((iban, idx) => {
                const ibanErr = validateIban(iban);
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      value={iban}
                      onChange={(e) => {
                        const next = [...form.ibans];
                        next[idx] = e.target.value;
                        setForm({ ...form, ibans: next });
                      }}
                      placeholder="NL00BANK0123456789"
                      className={ibanErr ? "border-destructive" : ""}
                    />
                    <Button variant="ghost" size="icon" className="shrink-0" onClick={() => {
                      setForm({ ...form, ibans: form.ibans.filter((_, i) => i !== idx) });
                    }}>
                      <X className="h-4 w-4" />
                    </Button>
                    {ibanErr && <p className="text-xs text-destructive whitespace-nowrap">{ibanErr}</p>}
                  </div>
                );
              })}
              <Button variant="outline" size="sm" type="button" onClick={() => setForm({ ...form, ibans: [...form.ibans, ""] })}>
                <Plus className="mr-1 h-3 w-3" />IBAN toevoegen
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowDialog(false); resetForm(); }}>Annuleren</Button>
            <Button onClick={handleSave} disabled={addClient.isPending || updateClient.isPending}>
              {(addClient.isPending || updateClient.isPending) ? "Bezig..." : editingId ? "Opslaan" : "Toevoegen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
