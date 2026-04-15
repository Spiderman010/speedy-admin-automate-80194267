import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Save, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/hooks/useClients";
import { useAddJournalEntry, useJournalEntries } from "@/hooks/useJournalEntries";
import { exportJournalEntriesCSV } from "@/lib/snelstart-export";

const grootboekrekeningen = [
  "4100 - Inkoopkosten",
  "4200 - Personeelskosten",
  "4300 - Kantoorkosten",
  "4400 - Vervoerskosten",
  "4500 - Telecom",
  "4600 - Energie",
  "4700 - Huisvestingskosten",
  "4800 - Afschrijvingen",
  "8000 - Omzet",
  "8100 - Overige opbrengsten",
];

const btwOptions = [
  { label: "0%", value: 0 },
  { label: "9%", value: 9 },
  { label: "21%", value: 21 },
];

export default function Boekingen() {
  const { toast } = useToast();
  const { data: clients } = useClients();
  const addEntry = useAddJournalEntry();

  const [form, setForm] = useState({
    client_id: "",
    entry_date: new Date().toISOString().split("T")[0],
    ledger_account_text: "",
    btw_percentage: 21,
    amount: "",
    invoice_number: "",
    description: "",
  });

  const { data: journalEntries } = useJournalEntries(form.client_id || undefined);

  const handleSave = async () => {
    if (!form.client_id || !form.amount) {
      toast({ title: "Vul klant en bedrag in", variant: "destructive" });
      return;
    }
    const amountIncl = parseFloat(form.amount);
    const btwAmount = amountIncl - amountIncl / (1 + form.btw_percentage / 100);

    try {
      await addEntry.mutateAsync({
        client_id: form.client_id,
        entry_date: form.entry_date,
        ledger_account_text: form.ledger_account_text,
        btw_percentage: form.btw_percentage,
        amount: amountIncl,
        btw_amount: Math.round(btwAmount * 100) / 100,
        invoice_number: form.invoice_number || null,
        description: form.description || null,
        entry_type: "handmatig",
      });
      toast({ title: "Boeking opgeslagen" });
      setForm({ ...form, amount: "", invoice_number: "", description: "", ledger_account_text: "" });
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
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

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-lg">Nieuwe boeking</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Klant *</Label>
                  <Select value={form.client_id} onValueChange={(v) => {
                    const client = clients?.find((c) => c.id === v);
                    setForm((prev) => ({
                      ...prev,
                      client_id: v,
                      btw_percentage: client?.btw_vrijgesteld ? 0 : 21,
                    }));
                  }}>
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
                  <Select value={form.ledger_account_text} onValueChange={(v) => setForm({ ...form, ledger_account_text: v })}>
                    <SelectTrigger><SelectValue placeholder="Selecteer rekening" /></SelectTrigger>
                    <SelectContent>
                      {grootboekrekeningen.map((gb) => <SelectItem key={gb} value={gb}>{gb}</SelectItem>)}
                    </SelectContent>
                  </Select>
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
                <Button variant="outline" onClick={() => setForm({ ...form, amount: "", invoice_number: "", description: "", ledger_account_text: "" })}>
                  Wissen
                </Button>
                <Button onClick={handleSave} disabled={addEntry.isPending}>
                  <Save className="mr-2 h-4 w-4" />{addEntry.isPending ? "Opslaan..." : "Opslaan"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-lg">Terugkerend</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Sla veelvoorkomende boekingen op als sjabloon zodat je ze met één klik kunt herhalen.
              </p>
              <Button variant="outline" className="mt-4 w-full">
                <Plus className="mr-2 h-4 w-4" />Sjabloon aanmaken
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
