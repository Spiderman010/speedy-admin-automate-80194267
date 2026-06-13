import { useState, useEffect } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Save, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/hooks/useClients";
import { useAddJournalEntry, useJournalEntries } from "@/hooks/useJournalEntries";
import { exportJournalEntriesCSV } from "@/lib/snelstart-export";
import { useClientContext } from "@/hooks/useClientContext";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { formatGetal } from "@/lib/format";
import { NoClientBanner } from "@/components/NoClientBanner";

const btwOptions = [
  { label: "0%", value: 0 },
  { label: "9%", value: 9 },
  { label: "21%", value: 21 },
];

export default function Boekingen() {
  const { toast } = useToast();
  const { data: clients } = useClients();
  const addEntry = useAddJournalEntry();
  const { selectedClientId, setSelectedClientId } = useClientContext();

  const hasSpecificClient = !!selectedClientId && selectedClientId !== "all";

  const [form, setForm] = useState({
    client_id: hasSpecificClient ? selectedClientId : "",
    entry_date: new Date().toISOString().split("T")[0],
    ledger_account_id: "" as string,
    ledger_account_text: "",
    btw_percentage: 21,
    amount: "",
    invoice_number: "",
    description: "",
  });

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

  const { data: journalEntries } = useJournalEntries(form.client_id || undefined);

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
      await addEntry.mutateAsync({
        client_id: form.client_id,
        entry_date: form.entry_date,
        // FK journal_entries.ledger_account_id verwijst naar ledger_accounts (niet grootboekrekeningen).
        // We slaan daarom alleen de leesbare tekst op en laten id leeg om FK-fouten te voorkomen.
        ledger_account_id: null,
        ledger_account_text: form.ledger_account_text,
        btw_percentage: form.btw_percentage,
        amount: amountIncl,
        btw_amount: Math.round(btwAmount * 100) / 100,
        invoice_number: form.invoice_number || null,
        description: form.description || null,
        entry_type: "handmatig",
      });
      toast({ title: "Boeking opgeslagen" });
      setForm({ ...form, amount: "", invoice_number: "", description: "", ledger_account_id: "", ledger_account_text: "" });
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
  };

  const formatBedrag = (n: number | null | undefined) =>
    typeof n === "number" ? formatGetal(n) : "-";
  const formatDatum = (d: string) => {
    const [y, m, day] = d.split("-");
    return `${day}-${m}-${y}`;
  };

  return (
    <>
      <PageHeader title="Snelle Invoer" description="Handmatig boekingen invoeren">
        <Button variant="outline" onClick={() => {
          if (!journalEntries?.length) { toast({ title: "Geen boekingen om te exporteren", variant: "destructive" }); return; }
          const clientName = form.client_id ? clients?.find(c => c.id === form.client_id)?.name : undefined;
          exportJournalEntriesCSV(journalEntries, clientName);
          toast({ title: `${journalEntries.length} boekingen geëxporteerd` });
        }}>
          <Download className="mr-2 h-4 w-4" />Export Snelstart
        </Button>
      </PageHeader>

      <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-lg">Nieuwe boeking</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!hasSpecificClient && (
                <NoClientBanner message="Kies eerst een specifieke administratie om een boeking toe te voegen." />
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Klant *</Label>
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
                    <SelectTrigger><SelectValue placeholder="Selecteer klant" /></SelectTrigger>
                    <SelectContent>
                      {clients?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}{c.btw_vrijgesteld ? " (BTW-vrij)" : ""}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>Datum</Label>
                  <Input type="date" value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Grootboekrekening</Label>
                  <GrootboekCombobox
                    value={form.ledger_account_text}
                    onValueChange={(v) => setForm((prev) => ({ ...prev, ledger_account_text: v }))}
                    onIdChange={(id) => setForm((prev) => ({ ...prev, ledger_account_id: id }))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>BTW-percentage</Label>
                  <Select value={String(form.btw_percentage)} onValueChange={(v) => setForm({ ...form, btw_percentage: Number(v) })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {btwOptions.map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Bedrag (incl. BTW) *</Label>
                  <Input type="number" step="0.01" placeholder="0,00" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>Factuurnummer</Label>
                  <Input placeholder="Optioneel" value={form.invoice_number} onChange={(e) => setForm({ ...form, invoice_number: e.target.value })} />
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Omschrijving</Label>
                <Textarea placeholder="Korte omschrijving van de boeking..." rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setForm({ ...form, amount: "", invoice_number: "", description: "", ledger_account_id: "", ledger_account_text: "" })}>
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
              <CardTitle className="font-display text-lg">Boekingen</CardTitle>
            </CardHeader>
            <CardContent>
              {!hasSpecificClient ? (
                <p className="text-sm text-muted-foreground">
                  Kies een specifieke administratie om de boekingen te zien.
                </p>
              ) : !journalEntries?.length ? (
                <p className="text-sm text-muted-foreground">
                  Nog geen snelle invoer boekingen voor deze administratie.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Datum</TableHead>
                        <TableHead>Omschrijving</TableHead>
                        <TableHead>Grootboek</TableHead>
                        <TableHead className="text-right">Bedrag</TableHead>
                        <TableHead className="text-right">BTW %</TableHead>
                        <TableHead className="text-right">BTW-bedrag</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {journalEntries.map((e) => (
                        <TableRow key={e.id}>
                          <TableCell>{formatDatum(e.entry_date)}</TableCell>
                          <TableCell className="max-w-[260px] truncate">{e.description ?? "-"}</TableCell>
                          <TableCell className="max-w-[220px] truncate">{e.ledger_account_text ?? "-"}</TableCell>
                          <TableCell className="text-right">{formatBedrag(Number(e.amount))}</TableCell>
                          <TableCell className="text-right">{e.btw_percentage ?? 0}%</TableCell>
                          <TableCell className="text-right">{formatBedrag(Number(e.btw_amount))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
      </div>
    </>
  );
}
