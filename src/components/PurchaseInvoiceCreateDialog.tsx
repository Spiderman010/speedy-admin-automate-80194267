import { useEffect, useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Save } from "lucide-react";
import { useAddPurchaseInvoice } from "@/hooks/usePurchaseInvoices";
import { useLeveranciers } from "@/hooks/useLeveranciers";
import { useToast } from "@/hooks/use-toast";
import { parseAmountInput, formatAmountInput } from "@/lib/amount-input";
import type { Tables } from "@/integrations/supabase/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clients: { id: string; name: string }[];
  organizationId: string | null;
  defaultClientId?: string;
  onCreated: (invoice: Tables<"purchase_invoices">) => void;
}

interface FormState {
  client_id: string;
  leverancier_id: string;
  supplier: string;
  invoice_number: string;
  invoice_date: string;
  amount_excl: string;
  btw_amount: string;
  amount_incl: string;
  btw_percentage: string;
  notes: string;
}

const empty = (defaultClientId?: string): FormState => ({
  client_id: defaultClientId ?? "",
  leverancier_id: "",
  supplier: "",
  invoice_number: "",
  invoice_date: new Date().toISOString().slice(0, 10),
  amount_excl: "",
  btw_amount: "",
  amount_incl: "",
  btw_percentage: "21",
  notes: "",
});

export function PurchaseInvoiceCreateDialog({
  open, onOpenChange, clients, organizationId, defaultClientId, onCreated,
}: Props) {
  const [form, setForm] = useState<FormState>(() => empty(defaultClientId));
  const [lastEdited, setLastEdited] = useState<"excl" | "incl" | "btw" | null>(null);
  const { toast } = useToast();
  const addInvoice = useAddPurchaseInvoice();

  const { data: leveranciers } = useLeveranciers({
    organizationId: organizationId ?? undefined,
    clientId: form.client_id || undefined,
    enabled: !!organizationId && !!form.client_id,
  });

  useEffect(() => {
    if (open) {
      setForm(empty(defaultClientId));
      setLastEdited(null);
    }
  }, [open, defaultClientId]);

  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  // Live BTW-berekening: afhankelijk van welk veld laatst is aangepast.
  useEffect(() => {
    const pct = parseAmountInput(form.btw_percentage);
    if (pct === null) return;
    if (lastEdited === "btw") return;

    if (lastEdited === "incl") {
      const incl = parseAmountInput(form.amount_incl);
      if (incl === null) return;
      const excl = Math.round((incl / (1 + pct / 100)) * 100) / 100;
      const btw = Math.round((incl - excl) * 100) / 100;
      const nextExcl = formatAmountInput(excl);
      const nextBtw = formatAmountInput(btw);
      if (nextExcl !== form.amount_excl || nextBtw !== form.btw_amount) {
        setForm((f) => ({ ...f, amount_excl: nextExcl, btw_amount: nextBtw }));
      }
    } else {
      // 'excl' of pct-wijziging → bereken btw + incl vanuit excl
      const excl = parseAmountInput(form.amount_excl);
      if (excl === null) return;
      const btw = Math.round(excl * pct) / 100;
      const incl = Math.round((excl + btw) * 100) / 100;
      const nextBtw = formatAmountInput(btw);
      const nextIncl = formatAmountInput(incl);
      if (nextBtw !== form.btw_amount || nextIncl !== form.amount_incl) {
        setForm((f) => ({ ...f, btw_amount: nextBtw, amount_incl: nextIncl }));
      }
    }
  }, [form.amount_excl, form.amount_incl, form.btw_percentage, lastEdited, form.amount_excl, form.btw_amount]);

  const canSave = !!form.client_id && form.supplier.trim().length > 0 && !addInvoice.isPending;




  const handleLeverancierChange = (id: string) => {
    if (id === "__none__") {
      update({ leverancier_id: "" });
      return;
    }
    const lev = leveranciers?.find((l) => l.id === id);
    update({
      leverancier_id: id,
      supplier: lev?.naam || form.supplier,
    });
  };

  const handleSave = async () => {
    if (!form.client_id) {
      toast({ title: "Kies eerst een klant", variant: "destructive" });
      return;
    }
    if (!form.supplier.trim()) {
      toast({ title: "Leverancier is verplicht", variant: "destructive" });
      return;
    }
    const amountExcl = parseAmountInput(form.amount_excl);
    const amountIncl = parseAmountInput(form.amount_incl);
    const btwAmount = parseAmountInput(form.btw_amount);
    const btwPct = parseAmountInput(form.btw_percentage);

    try {
      const created = await addInvoice.mutateAsync({
        client_id: form.client_id,
        leverancier_id: form.leverancier_id || null,
        supplier: form.supplier.trim(),
        invoice_number: form.invoice_number.trim() || null,
        invoice_date: form.invoice_date || null,
        amount_excl: amountExcl,
        amount_incl: amountIncl,
        btw_amount: btwAmount,
        btw_percentage: btwPct,
        notes: form.notes.trim() || null,
        status: "te_controleren",
      });
      toast({ title: "Factuur aangemaakt" });
      onCreated(created as Tables<"purchase_invoices">);
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Aanmaken mislukt", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nieuwe inkoopfactuur</DialogTitle>
          <DialogDescription>
            Handmatig een inkoopfactuur invoeren zonder upload. Regels toevoegen kan na het opslaan.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label>Klant *</Label>
            <Select
              value={form.client_id}
              onValueChange={(v) => update({ client_id: v, leverancier_id: "" })}
            >
              <SelectTrigger><SelectValue placeholder="Selecteer klant" /></SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="col-span-2">
            <Label>Leverancier</Label>
            <div className="flex gap-2">
              <div className="w-1/2">
                <Select
                  value={form.leverancier_id || "__none__"}
                  onValueChange={handleLeverancierChange}
                  disabled={!form.client_id}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Bestaande leverancier" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— vrije invoer —</SelectItem>
                    {(leveranciers ?? []).map((l) => (
                      <SelectItem key={l.id} value={l.id}>{l.naam}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Input
                className="w-1/2"
                placeholder="of typ leveranciernaam *"
                value={form.supplier}
                onChange={(e) => update({ supplier: e.target.value })}
              />
            </div>
          </div>

          <div>
            <Label>Factuurnummer</Label>
            <Input
              value={form.invoice_number}
              onChange={(e) => update({ invoice_number: e.target.value })}
              placeholder="F-2026-001"
            />
          </div>
          <div>
            <Label>Factuurdatum</Label>
            <Input
              type="date"
              value={form.invoice_date}
              onChange={(e) => update({ invoice_date: e.target.value })}
            />
          </div>

          <div>
            <Label>Bedrag excl.</Label>
            <Input
              inputMode="decimal"
              value={form.amount_excl}
              onChange={(e) => update({ amount_excl: e.target.value })}
              onBlur={recalcFromExcl}
              placeholder="0,00"
            />
          </div>
          <div>
            <Label>BTW-bedrag</Label>
            <Input
              inputMode="decimal"
              value={form.btw_amount}
              onChange={(e) => update({ btw_amount: e.target.value })}
              placeholder="0,00"
            />
          </div>
          <div>
            <Label>Bedrag incl.</Label>
            <Input
              inputMode="decimal"
              value={form.amount_incl}
              onChange={(e) => update({ amount_incl: e.target.value })}
              onBlur={recalcFromIncl}
              placeholder="0,00"
            />
          </div>
          <div>
            <Label>BTW %</Label>
            <Select
              value={form.btw_percentage}
              onValueChange={handleBtwPctChange}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0%</SelectItem>
                <SelectItem value="9">9%</SelectItem>
                <SelectItem value="21">21%</SelectItem>
              </SelectContent>
            </Select>
          </div>


          <div className="col-span-2">
            <Label>Notities</Label>
            <Textarea
              rows={2}
              value={form.notes}
              onChange={(e) => update({ notes: e.target.value })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={addInvoice.isPending}>
            Annuleren
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {addInvoice.isPending ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Bezig...</>
            ) : (
              <><Save className="mr-2 h-4 w-4" />Opslaan</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
