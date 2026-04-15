import { useState, useEffect, useRef } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Save, Upload, FileText, X } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clients: { id: string; name: string; btw_vrijgesteld?: boolean }[];
  onSave: (data: SalesInvoiceFormData, file: File | null) => Promise<void>;
  editData?: SalesInvoiceFormData | null;
}

export interface SalesInvoiceFormData {
  client_id: string;
  customer_name: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  amount_excl: string;
  btw_percentage: string;
  btw_amount: string;
  amount_incl: string;
  notes: string;
}

const emptyForm: SalesInvoiceFormData = {
  client_id: "",
  customer_name: "",
  invoice_number: "",
  invoice_date: new Date().toISOString().split("T")[0],
  due_date: "",
  amount_excl: "",
  btw_percentage: "21",
  btw_amount: "",
  amount_incl: "",
  notes: "",
};

const btwOptions = [
  { label: "0%", value: "0" },
  { label: "9%", value: "9" },
  { label: "21%", value: "21" },
];

export function SalesInvoiceDialog({ open, onOpenChange, clients, onSave, editData }: Props) {
  const [form, setForm] = useState<SalesInvoiceFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setForm(editData || emptyForm);
      setFile(null);
    }
  }, [open, editData]);

  const set = (key: keyof SalesInvoiceFormData, value: string) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const recalc = () => {
    const excl = parseFloat(form.amount_excl);
    const pct = parseFloat(form.btw_percentage);
    if (!isNaN(excl) && !isNaN(pct)) {
      const btw = excl * (pct / 100);
      setForm(prev => ({
        ...prev,
        btw_amount: btw.toFixed(2),
        amount_incl: (excl + btw).toFixed(2),
      }));
    }
  };

  const handleClientChange = (clientId: string) => {
    const client = clients.find((entry) => entry.id === clientId);
    const nextBtwPercentage = client?.btw_vrijgesteld ? "0" : emptyForm.btw_percentage;

    setForm((prev) => {
      const excl = parseFloat(prev.amount_excl);
      if (Number.isNaN(excl)) {
        return {
          ...prev,
          client_id: clientId,
          btw_percentage: nextBtwPercentage,
        };
      }

      const btw = excl * (parseFloat(nextBtwPercentage) / 100);
      return {
        ...prev,
        client_id: clientId,
        btw_percentage: nextBtwPercentage,
        btw_amount: btw.toFixed(2),
        amount_incl: (excl + btw).toFixed(2),
      };
    });
  };

  const handleBtwChange = (value: string) => {
    setForm((prev) => {
      const excl = parseFloat(prev.amount_excl);
      if (Number.isNaN(excl)) {
        return { ...prev, btw_percentage: value };
      }

      const btw = excl * (parseFloat(value) / 100);
      return {
        ...prev,
        btw_percentage: value,
        btw_amount: btw.toFixed(2),
        amount_incl: (excl + btw).toFixed(2),
      };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    await onSave(form, file);
    setSaving(false);
    onOpenChange(false);
  };

  const isValid = form.client_id && form.customer_name && form.invoice_number && form.invoice_date;

  const handleDateChange = (date: string) => {
    set("invoice_date", date);
    if (date && !form.due_date) {
      const d = new Date(date);
      d.setDate(d.getDate() + 30);
      set("due_date", d.toISOString().split("T")[0]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editData ? "Factuur bewerken" : "Nieuwe verkoopfactuur"}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div>
            <Label>Klant *</Label>
            <Select value={form.client_id} onValueChange={handleClientChange}>
              <SelectTrigger><SelectValue placeholder="Selecteer klant" /></SelectTrigger>
              <SelectContent>
                {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Klantnaam op factuur *</Label>
            <Input value={form.customer_name} onChange={e => set("customer_name", e.target.value)}
              placeholder="Bedrijfsnaam klant" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Factuurnummer *</Label>
              <Input value={form.invoice_number} onChange={e => set("invoice_number", e.target.value)}
                placeholder="VF-2024-001" />
            </div>
            <div>
              <Label>Factuurdatum *</Label>
              <Input type="date" value={form.invoice_date} onChange={e => handleDateChange(e.target.value)} />
            </div>
            <div>
              <Label>Vervaldatum</Label>
              <Input type="date" value={form.due_date} onChange={e => set("due_date", e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Bedrag excl. BTW</Label>
              <Input type="number" step="0.01" value={form.amount_excl}
                onChange={e => set("amount_excl", e.target.value)}
                onBlur={recalc} />
            </div>
            <div>
              <Label>BTW %</Label>
              <Select value={form.btw_percentage} onValueChange={handleBtwChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {btwOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>BTW-bedrag</Label>
              <Input type="number" step="0.01" value={form.btw_amount} readOnly className="bg-muted" />
            </div>
          </div>

          <div>
            <Label>Bedrag incl. BTW</Label>
            <Input type="number" step="0.01" value={form.amount_incl} readOnly className="bg-muted font-semibold" />
          </div>

          <div>
            <Label>Factuurbestand (PDF)</Label>
            <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden"
              onChange={e => { if (e.target.files?.[0]) setFile(e.target.files[0]); e.target.value = ""; }} />
            {file ? (
              <div className="flex items-center gap-2 mt-1 p-2 rounded-md border bg-muted/30">
                <FileText className="h-4 w-4 text-primary" />
                <span className="text-sm flex-1 truncate">{file.name}</span>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setFile(null)}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <Button variant="outline" className="mt-1 w-full" onClick={() => fileRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" />Bestand uploaden
              </Button>
            )}
          </div>

          <div>
            <Label>Notities</Label>
            <Textarea value={form.notes} onChange={e => set("notes", e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleSave} disabled={saving || !isValid}>
            <Save className="mr-2 h-4 w-4" />{editData ? "Opslaan" : "Factuur aanmaken"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
