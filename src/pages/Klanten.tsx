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
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { useIsMobile } from "@/hooks/use-mobile";

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
  // Accounting foundation: FK id plus the label GrootboekCombobox displays.
  debiteuren_rekening_id: string;
  debiteuren_rekening_label: string;
  crediteuren_rekening_id: string;
  crediteuren_rekening_label: string;
  btw_te_vorderen_rekening_id: string;
  btw_te_vorderen_rekening_label: string;
  btw_te_betalen_rekening_id: string;
  btw_te_betalen_rekening_label: string;
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
  debiteuren_rekening_id: "",
  debiteuren_rekening_label: "",
  crediteuren_rekening_id: "",
  crediteuren_rekening_label: "",
  btw_te_vorderen_rekening_id: "",
  btw_te_vorderen_rekening_label: "",
  btw_te_betalen_rekening_id: "",
  btw_te_betalen_rekening_label: "",
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
  const isMobile = useIsMobile();
  const { toast } = useToast();
  const { activeOrganizationId, isReady } = useActiveOrganization();

  const { data: clients, isLoading } = useClients(
    activeOrganizationId ?? undefined,
    isReady && activeOrganizationId !== null,
  );
  const { data: invoices } = usePurchaseInvoices({
    organizationId: activeOrganizationId ?? undefined,
    enabled: isReady && activeOrganizationId !== null,
  });
  // All accounts (not just active ones): an account that was configured earlier
  // and later deactivated must still be recognisable as the current selection,
  // instead of silently rendering as "no account linked". The dropdown itself
  // still offers only active accounts — GrootboekCombobox handles that.
  const { data: grootboekrekeningen } = useGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: isReady && activeOrganizationId !== null,
  });
  const addClient = useAddClient();
  const updateClient = useUpdateClient();
  const deleteClient = useDeleteClient();

  /**
   * Resolve a stored ledger FK to the label GrootboekCombobox displays.
   * Resolves against ALL accounts so a deactivated-but-configured account keeps
   * showing its number and description; the FK is never cleared implicitly.
   */
  const accountLabelById = (id: string | null | undefined): string => {
    if (!id) return "";
    const account = grootboekrekeningen?.find((a) => a.id === id);
    return account ? `${account.nummer} - ${account.omschrijving}` : "";
  };

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

  /** Sorteerbare kolomkop: toetsenbordbedienbaar en met aria-sort. */
  const SortableHead = ({
    col, children, className,
  }: { col: SortKey; children: React.ReactNode; className?: string }) => (
    <TableHead
      className={className}
      aria-sort={sortKey === col ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => toggleSort(col)}
        className="inline-flex select-none items-center rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {children}
        <SortArrow col={col} />
      </button>
    </TableHead>
  );

  /** Statuslabel: kleur én tekst, nooit kleur alleen. */
  const StatusBadge = ({ openTasks }: { openTasks: number }) => (
    <Badge
      variant={openTasks === 0 ? "secondary" : openTasks > 3 ? "destructive" : "default"}
      className="whitespace-nowrap font-medium tabular-nums"
    >
      {openTasks === 0 ? "Bijgewerkt" : `${openTasks} taken`}
    </Badge>
  );

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
      debiteuren_rekening_id: client.debiteuren_rekening_id ?? "",
      debiteuren_rekening_label: accountLabelById(client.debiteuren_rekening_id),
      crediteuren_rekening_id: client.crediteuren_rekening_id ?? "",
      crediteuren_rekening_label: accountLabelById(client.crediteuren_rekening_id),
      btw_te_vorderen_rekening_id: client.btw_te_vorderen_rekening_id ?? "",
      btw_te_vorderen_rekening_label: accountLabelById(client.btw_te_vorderen_rekening_id),
      btw_te_betalen_rekening_id: client.btw_te_betalen_rekening_id ?? "",
      btw_te_betalen_rekening_label: accountLabelById(client.btw_te_betalen_rekening_id),
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
        debiteuren_rekening_id: form.debiteuren_rekening_id || null,
        crediteuren_rekening_id: form.crediteuren_rekening_id || null,
        btw_te_vorderen_rekening_id: form.btw_te_vorderen_rekening_id || null,
        btw_te_betalen_rekening_id: form.btw_te_betalen_rekening_id || null,
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

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Zoek op naam, KvK of BTW-nummer..."
            className="w-full sm:max-w-sm"
          />
          {!isLoading && (
            <p className="text-xs text-muted-foreground tabular-nums" data-testid="klanten-count">
              {sorted.length} van {clients?.length ?? 0} klanten
            </p>
          )}
        </div>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-4 sm:p-6">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="hidden h-4 w-24 sm:block" />
                  <Skeleton className="h-6 w-20 rounded-full" />
                </div>
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <EmptyState
              icon={Building2}
              message={clients?.length === 0 ? "Nog geen klanten. Voeg je eerste klant toe!" : "Geen resultaten gevonden."}
            />
          ) : (
            <>
              {/* Mobiel: kaartweergave met de primaire kolommen. */}
              {isMobile ? (
              <ul className="divide-y">
                {sorted.map((client) => {
                  const openTasks = getOpenTasks(client.id);
                  const btwLabel = client.btw_type === "vrijgesteld" ? "Vrijgesteld" : client.btw_type === "mix" ? "Mix" : null;
                  return (
                    <li key={client.id} className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <Building2 className="h-4 w-4 text-primary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium" title={client.name}>{client.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{client.email || "—"}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <StatusBadge openTasks={openTasks} />
                            {btwLabel && <Badge variant="outline" className="text-[10px]">{btwLabel}</Badge>}
                            <Badge variant="outline" className="text-[10px]">
                              {verwerkingsLabels[(client as any).verwerkingsfrequentie] || "Kwartaal"}
                            </Badge>
                          </div>
                          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <div className="min-w-0">
                              <dt className="sr-only">KvK</dt>
                              <dd className="truncate font-mono tabular-nums">KvK {client.kvk_number || "—"}</dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="sr-only">BTW-nummer</dt>
                              <dd className="truncate font-mono">{client.btw_number || "—"}</dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="sr-only">Rechtsvorm</dt>
                              <dd className="truncate">{client.rechtsvorm || "—"}</dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="sr-only">Contactpersoon</dt>
                              <dd className="truncate">{client.contact_person || "—"}</dd>
                            </div>
                          </dl>
                          <div className="mt-3 flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-9"
                              onClick={() => openEdit(client)}
                              aria-label={`Bewerk ${client.name}`}
                            >
                              <Pencil className="mr-1 h-4 w-4" />Bewerken
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleteTarget({ id: client.id, name: client.name })}
                              aria-label={`Verwijder ${client.name}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>

              ) : (
              /* Tablet en desktop: volledige tabel, scrollt binnen de eigen container. */
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <SortableHead col="name">Bedrijf</SortableHead>
                      <TableHead>KvK</TableHead>
                      <TableHead>BTW-nummer</TableHead>
                      <SortableHead col="rechtsvorm">Rechtsvorm</SortableHead>
                      <TableHead>Contactpersoon</TableHead>
                      <TableHead>Frequentie</TableHead>
                      <SortableHead col="status">Status</SortableHead>
                      <TableHead className="w-32 text-right">
                        <span className="sr-only">Acties</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map((client) => {
                      const openTasks = getOpenTasks(client.id);
                      const btwLabel = client.btw_type === "vrijgesteld" ? "Vrijgesteld" : client.btw_type === "mix" ? "Mix" : null;
                      return (
                        <TableRow key={client.id} className="group">
                          <TableCell className="max-w-[260px]">
                            <div className="flex items-center gap-3">
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                                <Building2 className="h-4 w-4 text-primary" />
                              </div>
                              <div className="min-w-0">
                                <p className="truncate font-medium" title={client.name}>{client.name}</p>
                                <p className="truncate text-xs text-muted-foreground" title={client.email || undefined}>
                                  {client.email || "—"}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-sm tabular-nums">{client.kvk_number || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-sm">
                            {client.btw_number || "—"}
                            {btwLabel && <Badge variant="outline" className="ml-2 text-[10px]">{btwLabel}</Badge>}
                          </TableCell>
                          <TableCell className="text-sm">{client.rechtsvorm || "—"}</TableCell>
                          <TableCell className="max-w-[180px] truncate text-sm" title={client.contact_person || undefined}>
                            {client.contact_person || "—"}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                            {verwerkingsLabels[(client as any).verwerkingsfrequentie] || "Kwartaal"}
                          </TableCell>
                          <TableCell>
                            <StatusBadge openTasks={openTasks} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-9 px-2 text-muted-foreground hover:text-foreground"
                                onClick={() => openEdit(client)}
                                title="Klant bewerken"
                                aria-label={`Bewerk ${client.name}`}
                              >
                                <Pencil className="mr-1 h-4 w-4" />Bewerken
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
                                onClick={() => setDeleteTarget({ id: client.id, name: client.name })}
                                title="Klant verwijderen"
                                aria-label={`Verwijder ${client.name}`}
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
              </div>
              )}
            </>
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
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="debiteuren_rekening" className="text-xs font-normal">Debiteurenrekening</Label>
                  <GrootboekCombobox
                    value={form.debiteuren_rekening_label}
                    onValueChange={(v) => setForm((prev) => ({ ...prev, debiteuren_rekening_label: v }))}
                    onIdChange={(id) => setForm((prev) => ({ ...prev, debiteuren_rekening_id: id || "" }))}
                    placeholder="bv. 1300 - Debiteuren"
                    noneOption
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="crediteuren_rekening" className="text-xs font-normal">Crediteurenrekening</Label>
                  <GrootboekCombobox
                    value={form.crediteuren_rekening_label}
                    onValueChange={(v) => setForm((prev) => ({ ...prev, crediteuren_rekening_label: v }))}
                    onIdChange={(id) => setForm((prev) => ({ ...prev, crediteuren_rekening_id: id || "" }))}
                    placeholder="bv. 1600 - Crediteuren"
                    noneOption
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="btw_te_vorderen_rekening" className="text-xs font-normal">BTW te vorderen (voorbelasting)</Label>
                  <GrootboekCombobox
                    value={form.btw_te_vorderen_rekening_label}
                    onValueChange={(v) => setForm((prev) => ({ ...prev, btw_te_vorderen_rekening_label: v }))}
                    onIdChange={(id) => setForm((prev) => ({ ...prev, btw_te_vorderen_rekening_id: id || "" }))}
                    placeholder="Kies een grootboekrekening"
                    noneOption
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="btw_te_betalen_rekening" className="text-xs font-normal">BTW te betalen (af te dragen BTW)</Label>
                  <GrootboekCombobox
                    value={form.btw_te_betalen_rekening_label}
                    onValueChange={(v) => setForm((prev) => ({ ...prev, btw_te_betalen_rekening_label: v }))}
                    onIdChange={(id) => setForm((prev) => ({ ...prev, btw_te_betalen_rekening_id: id || "" }))}
                    placeholder="Kies een grootboekrekening"
                    noneOption
                  />
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
