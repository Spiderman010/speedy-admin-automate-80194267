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
import { CheckCircle2, Save, FileText, ZoomIn, ZoomOut, RotateCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { shouldSyncRemainingAmount } from "@/lib/invoice-balances";

type PurchaseInvoice = Tables<"purchase_invoices">;


interface Props {
  invoice: PurchaseInvoice | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (id: string, updates: Partial<PurchaseInvoice>) => Promise<void>;
  onApprove: (id: string, updates: Partial<PurchaseInvoice>) => Promise<void>;
}

function InvoicePreview({ filePath }: { filePath: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!filePath) { setUrl(null); return; }
    setLoading(true);
    supabase.storage.from("invoices").createSignedUrl(filePath, 3600).then(({ data }) => {
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
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="animate-pulse text-sm">Document laden...</div>
      </div>
    );
  }

  const isPdf = filePath.toLowerCase().endsWith(".pdf");

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 mb-2 border-b pb-2">
        <span className="text-xs font-medium text-muted-foreground mr-auto">Origineel document</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(z => Math.max(0.5, z - 0.25))}>
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs text-muted-foreground w-10 text-center">{Math.round(zoom * 100)}%</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(z => Math.min(3, z + 0.25))}>
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        {!isPdf && (
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setRotation(r => (r + 90) % 360)}>
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="flex-1 overflow-auto rounded-lg bg-muted/20 border">
        {isPdf && url ? (
          <iframe src={url} className="w-full h-full min-h-[400px]" style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }} />
        ) : url ? (
          <img
            src={url}
            alt="Factuur preview"
            className="max-w-full transition-transform"
            style={{ transform: `scale(${zoom}) rotate(${rotation}deg)`, transformOrigin: "top left" }}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Kan document niet laden</div>
        )}
      </div>
    </div>
  );
}

export function InvoiceEditDialog({ invoice, open, onOpenChange, onSave, onApprove }: Props) {
  const [form, setForm] = useState({
    supplier: "",
    invoice_number: "",
    invoice_date: "",
    amount_excl: "",
    amount_incl: "",
    btw_amount: "",
    btw_percentage: "",
    ledger_account_text: "",
    notes: "",
  });
  const [btwEnabled, setBtwEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (invoice) {
      const pct = invoice.btw_percentage?.toString() || "21";
      const enabled = parseFloat(pct) !== 0 || (invoice.btw_amount !== null && invoice.btw_amount !== 0);
      setBtwEnabled(enabled);

      const ledgerValue = invoice.ledger_account_text || "";

      setForm({
        supplier: invoice.supplier || "",
        invoice_number: invoice.invoice_number || "",
        invoice_date: invoice.invoice_date || "",
        amount_excl: invoice.amount_excl?.toString() || "",
        amount_incl: invoice.amount_incl?.toString() || "",
        btw_amount: enabled ? (invoice.btw_amount?.toString() || "") : "0",
        btw_percentage: enabled ? (["0", "9", "21"].includes(pct) ? pct : "21") : "0",
        ledger_account_text: ledgerValue,
        notes: invoice.notes || "",
      });
    }
  }, [invoice]);

  if (!invoice) return null;

  const hasFile = !!invoice.file_path;
  const set = (key: string, value: string) => setForm(prev => ({ ...prev, [key]: value }));

  const buildUpdates = (): Partial<PurchaseInvoice> => {
    const amountExcl = form.amount_excl ? parseFloat(form.amount_excl) : null;
    const amountIncl = form.amount_incl ? parseFloat(form.amount_incl) : null;
    const nextTotal = amountIncl ?? amountExcl;

    return {
      supplier: form.supplier,
      invoice_number: form.invoice_number || null,
      invoice_date: form.invoice_date || null,
      amount_excl: amountExcl,
      amount_incl: amountIncl,
      btw_amount: form.btw_amount ? parseFloat(form.btw_amount) : null,
      btw_percentage: form.btw_percentage ? parseFloat(form.btw_percentage) : null,
      ledger_account_text: form.ledger_account_text || null,
      notes: form.notes || null,
      remaining_amount: shouldSyncRemainingAmount(invoice) ? nextTotal : undefined,
    };
  };

  const handleSave = async () => {
    setSaving(true);
    await onSave(invoice.id, buildUpdates());
    setSaving(false);
    onOpenChange(false);
  };

  const handleApprove = async () => {
    setSaving(true);
    await onApprove(invoice.id, { ...buildUpdates(), status: "gecontroleerd" });
    setSaving(false);
    onOpenChange(false);
  };

  const recalcBtw = () => {
    const excl = parseFloat(form.amount_excl);
    const incl = parseFloat(form.amount_incl);
    if (!isNaN(excl) && !isNaN(incl)) {
      set("btw_amount", (incl - excl).toFixed(2));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={hasFile ? "sm:max-w-5xl max-h-[90vh]" : "sm:max-w-lg"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Factuur controleren
            <Badge variant={invoice.status === "te_controleren" ? "secondary" : "default"}>
              {invoice.status === "te_controleren" ? "Te controleren" : invoice.status}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className={hasFile ? "grid grid-cols-2 gap-6 min-h-[450px]" : ""}>
          {hasFile && (
            <InvoicePreview filePath={invoice.file_path} />
          )}

          <div className="space-y-4 overflow-y-auto max-h-[60vh] pr-1">
            <div>
              <Label>Leverancier *</Label>
              <Input value={form.supplier} onChange={e => set("supplier", e.target.value)} />
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

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Bedrag excl.</Label>
                <Input type="number" step="0.01" value={form.amount_excl}
                  onChange={e => set("amount_excl", e.target.value)} onBlur={recalcBtw} />
              </div>
              <div>
                <Label>Bedrag incl.</Label>
                <Input type="number" step="0.01" value={form.amount_incl}
                  onChange={e => set("amount_incl", e.target.value)} onBlur={recalcBtw} />
              </div>
              <div>
                <Label>BTW-bedrag</Label>
                <Input type="number" step="0.01" value={form.btw_amount}
                  onChange={e => set("btw_amount", e.target.value)} />
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
                    } else {
                      set("btw_percentage", "21");
                    }
                  }}
                />
              </div>
              <div>
                <Label>BTW %</Label>
                {btwEnabled ? (
                  <Select value={form.btw_percentage} onValueChange={(v) => set("btw_percentage", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">0%</SelectItem>
                      <SelectItem value="9">9%</SelectItem>
                      <SelectItem value="21">21%</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value="0" disabled />
                )}
              </div>
            </div>

            <div>
              <Label>Grootboekrekening</Label>
              <GrootboekCombobox
                value={form.ledger_account_text}
                onValueChange={(v) => set("ledger_account_text", v)}
              />
            </div>

            <div>
              <Label>Notities</Label>
              <Textarea value={form.notes} onChange={e => set("notes", e.target.value)} rows={2} />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleSave} disabled={saving || !form.supplier}>
            <Save className="mr-2 h-4 w-4" />Opslaan
          </Button>
          <Button onClick={handleApprove} disabled={saving || !form.supplier}>
            <CheckCircle2 className="mr-2 h-4 w-4" />Goedkeuren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
