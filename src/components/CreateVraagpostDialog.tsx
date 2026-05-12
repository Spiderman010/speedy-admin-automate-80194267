import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateVraagpost,
  VRAAGPOST_CATEGORIE_OPTIONS,
} from "@/hooks/useVraagposten";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceType: "purchase_invoice" | "bank_transaction" | "sales_invoice" | "handmatig";
  sourceId?: string | null;
  clientId?: string | null;
  defaultTitel?: string;
}

export function CreateVraagpostDialog({
  open, onOpenChange, sourceType, sourceId, clientId, defaultTitel,
}: Props) {
  const { toast } = useToast();
  const createVp = useCreateVraagpost();
  const [categorie, setCategorie] = useState<string>("overig");
  const [titel, setTitel] = useState("");
  const [omschrijving, setOmschrijving] = useState("");

  useEffect(() => {
    if (open) {
      setCategorie("overig");
      setTitel(defaultTitel ?? "");
      setOmschrijving("");
    }
  }, [open, defaultTitel]);

  const handleSubmit = async () => {
    if (!titel.trim()) {
      toast({ title: "Titel is verplicht", variant: "destructive" });
      return;
    }
    try {
      await createVp.mutateAsync({
        source_type: sourceType,
        source_id: sourceId ?? null,
        client_id: clientId ?? null,
        categorie,
        titel: titel.trim(),
        omschrijving: omschrijving.trim() || null,
      });
      toast({ title: "Vraagpost aangemaakt" });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Aanmaken mislukt", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nieuwe vraagpost</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Categorie</Label>
            <Select value={categorie} onValueChange={setCategorie}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {VRAAGPOST_CATEGORIE_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Titel *</Label>
            <Input value={titel} onChange={e => setTitel(e.target.value)} />
          </div>
          <div>
            <Label>Omschrijving</Label>
            <Textarea value={omschrijving} onChange={e => setOmschrijving(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Annuleren</Button>
          <Button onClick={handleSubmit} disabled={createVp.isPending}>Aanmaken</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
