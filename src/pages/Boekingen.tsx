import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Save, Download, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/hooks/useClients";
import { useAddJournalEntry, useDeleteJournalEntry, useJournalEntries } from "@/hooks/useJournalEntries";
import { exportJournalEntriesCSV } from "@/lib/snelstart-export";
import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { formatGetal } from "@/lib/format";
import { NoClientBanner } from "@/components/NoClientBanner";
import {
  buildJournalEntryInsertPayload,
  createEmptyJournalEntryFormState,
  type JournalEntryRecord,
  resolveJournalEntryLedgerLabel,
} from "@/lib/journal-entry-utils";

const btwOptions = [
  { label: "0%", value: 0 },
  { label: "9%", value: 9 },
  { label: "21%", value: 21 },
];

function BoekingenTableSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Boekingen laden…</span>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-20 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-24 shrink-0 md:block" />
          <Skeleton className="hidden h-4 w-12 shrink-0 md:block" />
          <Skeleton className="h-4 w-16 shrink-0" />
          <Skeleton className="h-7 w-7 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export default function Boekingen() {
  const { toast } = useToast();
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const orgEnabled = isReady && activeOrganizationId !== null;
  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  const { data: grootboekrekeningen } = useActiveGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: orgEnabled,
  });
  const addEntry = useAddJournalEntry();
  const deleteEntry = useDeleteJournalEntry();

  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";
  const [deleteTarget, setDeleteTarget] = useState<JournalEntryRecord | null>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState(() =>
    createEmptyJournalEntryFormState(hasSpecificClient ? selectedClientId : "")
  );

  // Sync local form client to global selected client
  useEffect(() => {
    const next = selectedClientId && selectedClientId !== "all" ? selectedClientId : "";
    setForm((prev) => {
      if (prev.client_id === next) return prev;
      const client = clients?.find((c) => c.id === next);
      return {
        ...prev,
        client_id: next,
        btw_percentage: client?.btw_vrijgesteld ? 0 : prev.btw_percentage,
      };
    });
  }, [selectedClientId, clients]);

  const {
    data: journalEntries,
    isLoading: entriesLoading,
    isError: entriesError,
    refetch: refetchEntries,
  } = useJournalEntries({
    organizationId: activeOrganizationId ?? undefined,
    clientId: form.client_id || undefined,
    enabled: orgEnabled,
  });

  const selectedClient = clients?.find((c) => c.id === form.client_id);

  const handleSave = async () => {
    if (!form.client_id) {
      toast({ title: "Kies eerst een specifieke administratie om een boeking toe te voegen.", variant: "destructive" });
      return;
    }
    if (!form.amount) {
      toast({ title: "Vul een bedrag in", variant: "destructive" });
      return;
    }
    const amountIncl = parseFloat(form.amount);
    const btwAmount = amountIncl - amountIncl / (1 + form.btw_percentage / 100);

    try {
      await addEntry.mutateAsync(
        buildJournalEntryInsertPayload(form, amountIncl, Math.round(btwAmount * 100) / 100)
      );
      toast({ title: "Boeking opgeslagen" });
      setForm((prev) => ({
        ...prev,
        amount: "",
        invoice_number: "",
        description: "",
        grootboekrekening_id: null,
        ledger_account_text: "",
      }));
      // Presentational only — return focus to the amount field for fast repeated entry.
      amountInputRef.current?.focus();
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
  };

  const handleExportSnelstart = () => {
    if (!journalEntries?.length) {
      toast({ title: "Geen boekingen om te exporteren", variant: "destructive" });
      return;
    }
    const clientName = form.client_id ? clients?.find((c) => c.id === form.client_id)?.name : undefined;
    exportJournalEntriesCSV(journalEntries, clientName);
    toast({ title: `${journalEntries.length} boekingen geëxporteerd` });
  };

  const formatBedrag = (n: number | null | undefined) =>
    typeof n === "number" ? formatGetal(n) : "-";
  const formatDatum = (d: string) => {
    const [y, m, day] = d.split("-");
    return `${day}-${m}-${y}`;
  };

  const handleDeleteConfirm = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (!deleteTarget) return;

    try {
      await deleteEntry.mutateAsync(deleteTarget.id);
      toast({ title: "Boeking verwijderd" });
      setDeleteTarget(null);
    } catch (error: any) {
      toast({
        title: "Verwijderen mislukt",
        description: error?.message,
        variant: "destructive",
      });
    }
  };

  return (
    <>
      {/* Shell header shows "Snelle invoer"; keep h1 for a11y only */}
      <h1 className="sr-only">Snelle invoer</h1>

      <div className="mb-4 flex items-center justify-end">
        <Button variant="outline" onClick={handleExportSnelstart}>
          <Download className="mr-2 h-4 w-4" />Export Snelstart
        </Button>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-lg">Nieuwe boeking</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!hasSpecificClient && (
              <NoClientBanner message="Kies eerst een specifieke administratie om een boeking toe te voegen." />
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="be-klant">Klant *</Label>
                <Select
                  value={form.client_id}
                  onValueChange={(v) => {
                    const client = clients?.find((c) => c.id === v);
                    setForm((prev) => ({
                      ...prev,
                      client_id: v,
                      btw_percentage: client?.btw_vrijgesteld ? 0 : 21,
                    }));
                    setSelectedClientId(v);
                  }}
                >
                  <SelectTrigger id="be-klant">
                    <span className="truncate">
                      {selectedClient
                        ? `${selectedClient.name}${selectedClient.btw_vrijgesteld ? " (BTW-vrij)" : ""}`
                        : "Selecteer klant"}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {clients?.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}{c.btw_vrijgesteld ? " (BTW-vrij)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="be-datum">Datum</Label>
                <Input
                  id="be-datum"
                  type="date"
                  value={form.entry_date}
                  onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="be-grootboek">Grootboekrekening</Label>
                <GrootboekCombobox
                  value={form.ledger_account_text}
                  onValueChange={(v) => setForm((prev) => ({ ...prev, ledger_account_text: v }))}
                  onIdChange={(id) => setForm((prev) => ({ ...prev, grootboekrekening_id: id || null }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="be-btw">BTW-percentage</Label>
                <Select value={String(form.btw_percentage)} onValueChange={(v) => setForm({ ...form, btw_percentage: Number(v) })}>
                  <SelectTrigger id="be-btw"><span>{form.btw_percentage}%</span></SelectTrigger>
                  <SelectContent>
                    {btwOptions.map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {selectedClient?.btw_vrijgesteld && (
                  <p className="text-xs text-muted-foreground">Deze administratie is BTW-vrijgesteld.</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="be-bedrag">Bedrag (incl. BTW) *</Label>
                <Input
                  id="be-bedrag"
                  ref={amountInputRef}
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  className="text-right font-mono text-base tabular-nums"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="be-factuurnummer">Factuurnummer</Label>
                <Input
                  id="be-factuurnummer"
                  placeholder="Optioneel"
                  value={form.invoice_number}
                  onChange={(e) => setForm({ ...form, invoice_number: e.target.value })}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="be-omschrijving">Omschrijving</Label>
              <Textarea
                id="be-omschrijving"
                placeholder="Korte omschrijving van de boeking..."
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setForm((prev) => ({
                  ...prev,
                  amount: "",
                  invoice_number: "",
                  description: "",
                  grootboekrekening_id: null,
                  ledger_account_text: "",
                }))}
              >
                Wissen
              </Button>
              <Button onClick={handleSave} disabled={addEntry.isPending || !hasSpecificClient}>
                <Save className="mr-2 h-4 w-4" />{addEntry.isPending ? "Opslaan..." : "Opslaan"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-lg">Recente boekingen</CardTitle>
          </CardHeader>
          <CardContent>
            {!hasSpecificClient ? (
              <p className="text-sm text-muted-foreground">
                Kies een specifieke administratie om de boekingen te zien.
              </p>
            ) : entriesLoading ? (
              <BoekingenTableSkeleton />
            ) : entriesError ? (
              <div className="flex flex-col items-start gap-3 py-6">
                <p className="text-sm text-muted-foreground">Boekingen laden is mislukt.</p>
                <Button variant="outline" size="sm" onClick={() => refetchEntries()}>
                  Opnieuw proberen
                </Button>
              </div>
            ) : !journalEntries?.length ? (
              <p className="text-sm text-muted-foreground">
                Nog geen handmatige boekingen voor deze administratie.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Datum</TableHead>
                      <TableHead>Grootboek</TableHead>
                      <TableHead>Omschrijving</TableHead>
                      <TableHead className="hidden md:table-cell">Factuurnummer</TableHead>
                      <TableHead className="hidden text-right md:table-cell">BTW</TableHead>
                      <TableHead className="text-right">Bedrag</TableHead>
                      <TableHead className="text-right">Acties</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {journalEntries.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="whitespace-nowrap">{formatDatum(e.entry_date)}</TableCell>
                        <TableCell className="max-w-[200px] truncate">
                          {resolveJournalEntryLedgerLabel(e, grootboekrekeningen) || "-"}
                        </TableCell>
                        <TableCell className="max-w-[220px] truncate">{e.description ?? "-"}</TableCell>
                        <TableCell className="hidden md:table-cell">{e.invoice_number ?? "-"}</TableCell>
                        <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">
                          {e.btw_percentage ?? 0}%
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{formatBedrag(Number(e.amount))}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            title="Verwijder boeking"
                            aria-label="Verwijder boeking"
                            disabled={deleteEntry.isPending}
                            onClick={() => setDeleteTarget(e)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleteEntry.isPending) {
            setDeleteTarget(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Boeking verwijderen?</AlertDialogTitle>
            <AlertDialogDescription>
              Deze actie kan niet ongedaan worden gemaakt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteTarget && (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{formatDatum(deleteTarget.entry_date)}</span>
                <span className="font-mono tabular-nums">{formatBedrag(Number(deleteTarget.amount))}</span>
              </div>
              <p className="mt-0.5 truncate font-medium">
                {deleteTarget.description || resolveJournalEntryLedgerLabel(deleteTarget, grootboekrekeningen) || "-"}
              </p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteEntry.isPending}>Annuleren</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteEntry.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteConfirm}
            >
              {deleteEntry.isPending ? "Verwijderen..." : "Verwijderen"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
