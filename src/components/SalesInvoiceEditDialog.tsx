import { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { CheckCircle2, Save, FileText, ZoomIn, ZoomOut, RotateCw, Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

type SalesInvoice = Tables<"sales_invoices">;

const LEDGER_ACCOUNTS = [
  { code: "1100", name: "Rekening-courant bank" },
  { code: "1200", name: "Kruisposten" },
  { code: "1300", name: "Debiteuren" },
  { code: "1600", name: "Crediteuren" },
  { code: "4203", name: "Betaalde huur" },
  { code: "4210", name: "Gas water elektra" },
  { code: "4400", name: "Reclame- en advertentiekosten" },
  { code: "4406", name: "Reis- en verblijfkosten" },
  { code: "4420", name: "Websitekosten" },
  { code: "4500", name: "Brandstofkosten auto's" },
  { code: "4501", name: "Reparatie onderhoud auto's" },
  { code: "4518", name: "Parkeerkosten auto's" },
  { code: "4600", name: "Kantoorbenodigdheden" },
  { code: "4602", name: "Telefoonkosten" },
  { code: "4604", name: "Drukwerk" },
  { code: "4610", name: "Kosten automatisering" },
  { code: "4614", name: "Overige kantoorkosten" },
  { code: "4650", name: "Bedrijfsaansprakelijkheidsverzekering" },
  { code: "4700", name: "Accountants- en advieskosten" },
  { code: "4702", name: "Notariskosten" },
  { code: "4753", name: "Bankkosten" },
  { code: "7000", name: "Inkopen alle btw tarieven" },
  { code: "7001", name: "Inkopen laag tarief" },
  { code: "7002", name: "Inkopen hoog tarief" },
  { code: "7100", name: "Kosten uitbesteed werk" },
  { code: "7400", name: "Inkoopwaarde handelsgoederen" },
  { code: "8000", name: "Omzet hoog tarief" },
  { code: "8001", name: "Omzet laag tarief" },
  { code: "8002", name: "Omzet verlegd" },
  { code: "8003", name: "Omzet vrij van btw" },
];

function formatAccount(code: string, name: string) {
  return `${code} - ${name}`;
}

function LedgerAccountCombobox({ value, onValueChange }: { value: string; onValueChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = LEDGER_ACCOUNTS.find(a => formatAccount(a.code, a.name) === value);
  const displayLabel = selected ? formatAccount(selected.code, selected.name) : value || "Selecteer rekening...";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal h-10 text-sm">
          <span className="truncate">{displayLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Zoek rekening..." />
          <CommandList>
            <CommandEmpty>Geen rekening gevonden.</CommandEmpty>
            <CommandGroup>
              {LEDGER_ACCOUNTS.map((account) => {
                const label = formatAccount(account.code, account.name);
                return (
                  <CommandItem key={account.code} value={label} onSelect={(v) => { onValueChange(v); setOpen(false); }}>
                    <Check className={cn("mr-2 h-4 w-4", value === label ? "opacity-100" : "opacity-0")} />
                    {label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function InvoicePreview({ filePath }: { filePath: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!filePath) { setUrl(null); return; }
    setLoading(true);
    supabase.storage.from("invoices").createSignedUrl(filePath, 3600).then(({ data, error }) => {
      if (error) console.error("Storage signed URL error:", error);
      setUrl(data?.signedUrl ?? null);
      setLoading(false);
    });
    setZoom(1);
    setRotation(0);
  }, [filePath]);

  if (!filePath) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground bg-muted/30 rounded-lg">
        <FileText className="h-12 w-12 mb-3 opacity-40" />
        <p className="text-sm">Geen bestand beschikbaar</p>
      </div>
    );
  }
  if (loading) {
    return <div className="flex items-center justify-center h-full text-muted-foreground"><div className="animate-pulse text-sm">Document laden...</div></div>;
  }

  const isPdf = filePath.toLowerCase().endsWith(".pdf");
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 mb-2 border-b pb-2">
        <span className="text-xs font-medium text-muted-foreground mr-auto">Origineel document</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(z => Math.max(0.5, z - 0.25))}><ZoomOut className="h-3.5 w-3.5" /></Button>
        <span className="text-xs text-muted-foreground w-10 text-center">{Math.round(zoom * 100)}%</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(z => Math.min(3, z + 0.25))}><ZoomIn className="h-3.5 w-3.5" /></Button>
        {!isPdf && <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setRotation(r => (r + 90) % 360)}><RotateCw className="h-3.5 w-3.5" /></Button>}
      </div>
      <div className="flex-1 overflow-auto rounded-lg bg-muted/20 border">
        {isPdf && url ? (
          <iframe src={url} className="w-full h-full min-h-[400px]" style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }} />
        ) : url ? (
          <img src={url} alt="Factuur preview" className="max-w-full transition-transform" style={{ transform: `scale(${zoom}) rotate(${rotation}deg)`, transformOrigin: "top left" }} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Kan document niet laden</div>
        )}
      </div>
    </div>
  );
}

interface Props {
  invoice: SalesInvoice | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (id: string, updates: Partial<SalesInvoice>) => Promise<void>;
  onApprove: (id: string, updates: Partial<SalesInvoice>) => Promise<void>;
}

export function SalesInvoiceEditDialog({ invoice, open, onOpenChange, onSave, onApprove }: Props) {
  const [form, setForm] = useState({
    customer_name: "",
    invoice_number: "",
    invoice_date: "",
    due_date: "",
    amount_excl: "",
    amount_incl: "",
    btw_amount: "",
    btw_percentage: "21",
    btw_verlegd: false,
    ledger_account_text: "",
    notes: "",
    status: "concept",
  });
  const [btwEnabled, setBtwEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (invoice) {
      const verlegd = !!(invoice as any).btw_verlegd;
      const pct = invoice.btw_percentage?.toString() || "21";
      const enabled = !verlegd && (parseFloat(pct) !== 0 || (invoice.btw_amount !== null && invoice.btw_amount !== 0));
      setBtwEnabled(enabled && !verlegd);

      let ledgerValue = (invoice as any).ledger_account_text || "";
      const match = LEDGER_ACCOUNTS.find(a =>
        ledgerValue === formatAccount(a.code, a.name) || ledgerValue === a.code || ledgerValue === a.name
      );
      if (match) ledgerValue = formatAccount(match.code, match.name);

      setForm({
        customer_name: invoice.customer_name || "",
        invoice_number: invoice.invoice_number || "",
        invoice_date: invoice.invoice_date || "",
        due_date: invoice.due_date || "",
        amount_excl: invoice.amount_excl?.toString() || "",
        amount_incl: invoice.amount_incl?.toString() || "",
        btw_amount: verlegd ? "0" : (invoice.btw_amount?.toString() || ""),
        btw_percentage: verlegd ? "verlegd" : (["0", "9", "21"].includes(pct) ? pct : "21"),
        btw_verlegd: verlegd,
        ledger_account_text: ledgerValue,
        notes: invoice.notes || "",
        status: invoice.status || "concept",
      });
    }
  }, [invoice]);

  if (!invoice) return null;

  const hasFile = !!invoice.pdf_path;
  const set = (key: string, value: string | boolean) => setForm(prev => ({ ...prev, [key]: value }));

  const buildUpdates = (): Partial<SalesInvoice> => {
    const isVerlegd = form.btw_percentage === "verlegd";
    return {
      customer_name: form.customer_name,
      invoice_number: form.invoice_number,
      invoice_date: form.invoice_date || undefined,
      due_date: form.due_date || null,
      amount_excl: form.amount_excl ? parseFloat(form.amount_excl) : null,
      amount_incl: form.amount_incl ? parseFloat(form.amount_incl) : null,
      btw_amount: isVerlegd ? 0 : (form.btw_amount ? parseFloat(form.btw_amount) : null),
      btw_percentage: isVerlegd ? 0 : (form.btw_percentage ? parseFloat(form.btw_percentage) : null),
      btw_verlegd: isVerlegd,
      ledger_account_text: form.ledger_account_text || null,
      notes: form.notes || null,
    } as any;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(invoice.id, buildUpdates());
      onOpenChange(false);
    } catch {
      // error handled by parent
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async () => {
    setSaving(true);
    try {
      await onApprove(invoice.id, { ...buildUpdates(), status: "gecontroleerd" });
      onOpenChange(false);
    } catch {
      // error handled by parent
    } finally {
      setSaving(false);
    }
  };

  const recalcBtw = () => {
    if (form.btw_percentage === "verlegd" || !btwEnabled) return;
    const excl = parseFloat(form.amount_excl);
    const incl = parseFloat(form.amount_incl);
    if (!isNaN(excl) && !isNaN(incl)) set("btw_amount", (incl - excl).toFixed(2));
  };

  const statusLabel: Record<string, string> = {
    concept: "Concept",
    verzonden: "Verzonden",
    betaald: "Betaald",
    gecontroleerd: "Gecontroleerd",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={hasFile ? "sm:max-w-5xl max-h-[90vh]" : "sm:max-w-lg"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Verkoopfactuur controleren
            <Badge variant={invoice.status === "concept" ? "secondary" : "default"}>
              {statusLabel[invoice.status] || invoice.status}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className={hasFile ? "grid grid-cols-2 gap-6 min-h-[450px]" : ""}>
          {hasFile && <InvoicePreview filePath={invoice.pdf_path} />}

          <div className="space-y-4 overflow-y-auto max-h-[60vh] pr-1">
            <div>
              <Label>Klantnaam *</Label>
              <Input value={form.customer_name} onChange={e => set("customer_name", e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Factuurnummer</Label>
                <Input value={form.invoice_number} onChange={e => set("invoice_number", e.target.value)} />
              </div>
              <div>
                <Label>Factuurdatum</Label>
                <Input type="date" value={form.invoice_date} onChange={e => set("invoice_date", e.target.value)} />
              </div>
            </div>

            <div>
              <Label>Vervaldatum</Label>
              <Input type="date" value={form.due_date} onChange={e => set("due_date", e.target.value)} />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Bedrag excl.</Label>
                <Input type="number" step="0.01" value={form.amount_excl} onChange={e => set("amount_excl", e.target.value)} onBlur={recalcBtw} />
              </div>
              <div>
                <Label>Bedrag incl.</Label>
                <Input type="number" step="0.01" value={form.amount_incl} onChange={e => set("amount_incl", e.target.value)} onBlur={recalcBtw} />
              </div>
              <div>
                <Label>BTW-bedrag</Label>
                <Input type="number" step="0.01" value={form.btw_amount} onChange={e => set("btw_amount", e.target.value)} disabled={!btwEnabled || form.btw_percentage === "verlegd"} />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>BTW toepassen</Label>
                <Switch
                  checked={btwEnabled}
                  onCheckedChange={(checked) => {
                    setBtwEnabled(checked);
                    if (!checked) {
                      set("btw_percentage", "0");
                      set("btw_amount", "0");
                      set("btw_verlegd", false);
                    } else {
                      set("btw_percentage", "21");
                    }
                  }}
                />
              </div>
              {btwEnabled && (
                <div>
                  <Label>BTW %</Label>
                  <Select
                    value={form.btw_percentage}
                    onValueChange={(v) => {
                      set("btw_percentage", v);
                      if (v === "verlegd") {
                        set("btw_amount", "0");
                        set("btw_verlegd", true);
                      } else {
                        set("btw_verlegd", false);
                      }
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">0%</SelectItem>
                      <SelectItem value="9">9%</SelectItem>
                      <SelectItem value="21">21%</SelectItem>
                      <SelectItem value="verlegd">Verlegd</SelectItem>
                    </SelectContent>
                  </Select>
                  {form.btw_percentage === "verlegd" && (
                    <p className="text-xs text-muted-foreground mt-1">BTW verlegd — bedrag is 0, tarief wordt als "verlegd" geëxporteerd</p>
                  )}
                </div>
              )}
            </div>

            <div>
              <Label>Grootboekrekening</Label>
              <LedgerAccountCombobox value={form.ledger_account_text} onValueChange={(v) => set("ledger_account_text", v)} />
            </div>

            <div>
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => set("status", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="concept">Concept</SelectItem>
                  <SelectItem value="verzonden">Verzonden</SelectItem>
                  <SelectItem value="betaald">Betaald</SelectItem>
                  <SelectItem value="gecontroleerd">Gecontroleerd</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Notities</Label>
              <Textarea value={form.notes} onChange={e => set("notes", e.target.value)} rows={2} />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleSave} disabled={saving || !form.customer_name}>
            <Save className="mr-2 h-4 w-4" />Opslaan
          </Button>
          <Button onClick={handleApprove} disabled={saving || !form.customer_name}>
            <CheckCircle2 className="mr-2 h-4 w-4" />Goedkeuren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
