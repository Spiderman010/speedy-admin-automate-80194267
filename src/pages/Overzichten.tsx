import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { TrendingUp, TrendingDown, Minus, Download, Loader2 } from "lucide-react";
import { useClients } from "@/hooks/useClients";
import { usePurchaseInvoices } from "@/hooks/usePurchaseInvoices";
import { useJournalEntries } from "@/hooks/useJournalEntries";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { exportAllForClient } from "@/lib/snelstart-export";
import { useToast } from "@/hooks/use-toast";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

export default function Overzichten() {
  const { data: clients } = useClients();
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();

  const { data: invoices } = usePurchaseInvoices(selectedClient || undefined);
  const { data: entries } = useJournalEntries(selectedClient || undefined);
  const { data: transactions } = useBankTransactions(selectedClient || undefined);

  const totalInvoices = invoices?.reduce((s, i) => s + (i.amount_incl ?? 0), 0) ?? 0;
  const totalBtw = invoices?.reduce((s, i) => s + (i.btw_amount ?? 0), 0) ?? 0;
  const totalEntries = entries?.reduce((s, e) => s + e.amount, 0) ?? 0;

  const handleExportAll = async () => {
    if (!selectedClient) {
      toast({ title: "Selecteer eerst een klant", variant: "destructive" });
      return;
    }
    const clientName = clients?.find(c => c.id === selectedClient)?.name ?? "klant";
    setExporting(true);
    try {
      await exportAllForClient(
        clientName,
        invoices?.filter(i => i.status === "gecontroleerd") ?? [],
        entries ?? [],
        transactions?.filter(t => t.match_status === "gematcht") ?? [],
      );
      toast({ title: "ZIP-bestand gedownload", description: `Export voor ${clientName} is klaar.` });
    } catch (e: any) {
      toast({ title: "Exportfout", description: e.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHeader title="Overzichten" description="Financiële rapportages per klant">
        <Select value={selectedClient} onValueChange={setSelectedClient}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Selecteer klant" />
          </SelectTrigger>
          <SelectContent>
            {clients?.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleExportAll} disabled={exporting || !selectedClient}>
          {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
          Export alles (Snelstart)
        </Button>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-success" />
              <p className="text-sm text-muted-foreground">Inkoopfacturen</p>
            </div>
            <p className="mt-1 font-display text-xl font-bold">{formatCurrency(totalInvoices)}</p>
            <p className="text-xs text-muted-foreground">{invoices?.length ?? 0} facturen</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-destructive" />
              <p className="text-sm text-muted-foreground">BTW totaal</p>
            </div>
            <p className="mt-1 font-display text-xl font-bold">{formatCurrency(totalBtw)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Minus className="h-4 w-4 text-primary" />
              <p className="text-sm text-muted-foreground">Boekingen totaal</p>
            </div>
            <p className="mt-1 font-display text-xl font-bold">{formatCurrency(totalEntries)}</p>
            <p className="text-xs text-muted-foreground">{entries?.length ?? 0} boekingen</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-display text-lg">Recente inkoopfacturen</CardTitle>
        </CardHeader>
        <CardContent>
          {!invoices?.length ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {selectedClient ? "Geen facturen voor deze klant." : "Selecteer een klant om data te bekijken."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Leverancier</TableHead>
                  <TableHead>Factuurnummer</TableHead>
                  <TableHead>Datum</TableHead>
                  <TableHead className="text-right">Excl. BTW</TableHead>
                  <TableHead className="text-right">BTW</TableHead>
                  <TableHead className="text-right">Incl. BTW</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.slice(0, 10).map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.supplier}</TableCell>
                    <TableCell className="font-mono text-sm">{inv.invoice_number || "—"}</TableCell>
                    <TableCell>{inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString("nl-NL") : "—"}</TableCell>
                    <TableCell className="text-right font-mono">{inv.amount_excl != null ? formatCurrency(inv.amount_excl) : "—"}</TableCell>
                    <TableCell className="text-right font-mono">{inv.btw_amount != null ? formatCurrency(inv.btw_amount) : "—"}</TableCell>
                    <TableCell className="text-right font-mono font-semibold">{inv.amount_incl != null ? formatCurrency(inv.amount_incl) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
