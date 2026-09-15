import { useState, useEffect, useMemo } from "react";
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
import { CheckCircle2, Save, FileText, ZoomIn, ZoomOut, RotateCw, AlertTriangle, HelpCircle, FileCode2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { CreateVraagpostDialog } from "@/components/CreateVraagpostDialog";
import { shouldSyncRemainingAmount } from "@/lib/invoice-balances";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/hooks/useClients";
import { SALES_UBL_TEST_HELPER_TEXT, buildSalesInvoiceTestPackage } from "@/lib/sales-ubl-generator";
import { useSalesInvoicePosting, usePostSalesInvoice } from "@/hooks/useSalesInvoicePosting";

type SalesInvoice = Tables<"sales_invoices">;

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

/**
 * Zuivere afleiding van de formulierstaat uit de gepersisteerde factuur. Wordt
 * zowel gebruikt om `form` te initialiseren/synchroniseren (in de useEffect
 * hieronder) als om, op elke render, de actueel gepersisteerde staat af te
 * leiden voor de dirty-check — zonder een aparte "laatst opgeslagen"
 * snapshot-state die uit de pas zou kunnen lopen.
 */
function deriveFormFromInvoice(invoice: SalesInvoice) {
  const verlegd = !!(invoice as any).btw_verlegd;
  const pct = invoice.btw_percentage?.toString() || "21";
  const ledgerValue = (invoice as any).ledger_account_text || "";

  return {
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
    grootboekrekening_id: invoice.grootboekrekening_id ?? "",
    notes: invoice.notes || "",
    status: invoice.status || "concept",
  };
}

/**
 * De boekhoudkundig relevante velden — exact de set die
 * prevent_posted_sales_invoice_mutation() bevriest (minus client_id/
 * organization_id, die niet in deze dialog bewerkt worden). status, due_date,
 * notes en remaining_amount/pdf_path horen hier bewust niet bij: die blijven
 * na boeken vrij bewerkbaar volgens diezelfde migratie.
 */
const ACCOUNTING_FIELDS = [
  "customer_name",
  "invoice_number",
  "invoice_date",
  "amount_excl",
  "amount_incl",
  "btw_amount",
  "btw_percentage",
  "btw_verlegd",
  "grootboekrekening_id",
  "ledger_account_text",
] as const;

/**
 * De set die vóór boeken exact gelijk moet zijn aan de gepersisteerde factuur:
 * de boekhoudkundige velden plus `status`. post_sales_invoice() leest de
 * gepersisteerde status om te bepalen óf er geboekt mag worden (alleen
 * gecontroleerd of betaald), dus met een niet-opgeslagen statuswijziging zou de
 * RPC op een andere status boeken dan de gebruiker op het scherm ziet. Dit
 * maakt status géén bevroren boekhoudkundig veld in de database: de migratie
 * blijft ongewijzigd en na boeken blijft gecontroleerd → betaald toegestaan.
 */
const PRE_POST_FIELDS = [...ACCOUNTING_FIELDS, "status"] as const;

/** String/number-veilige gelijkheid — geen nieuwe boekhoudkundige logica. */
function isPrePostStateDirty(
  form: ReturnType<typeof deriveFormFromInvoice>,
  persisted: ReturnType<typeof deriveFormFromInvoice>,
): boolean {
  return PRE_POST_FIELDS.some((key) => form[key] !== persisted[key]);
}

interface Props {
  invoice: SalesInvoice | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (id: string, updates: Partial<SalesInvoice>) => Promise<void>;
  onApprove: (id: string, updates: Partial<SalesInvoice>) => Promise<void>;
  allInvoices?: SalesInvoice[];
  /** Server-computed duplicate signal; takes precedence over the allInvoices scan. */
  knownDuplicate?: boolean;
}

export function SalesInvoiceEditDialog({ invoice, open, onOpenChange, onSave, onApprove, allInvoices, knownDuplicate }: Props) {
  const { toast } = useToast();
  const { data: clients } = useClients();
  const { data: posting } = useSalesInvoicePosting(invoice?.id);
  const postInvoice = usePostSalesInvoice();
  // Een geboekte factuur is brongegeven geworden: de database weigert elke
  // boekhoudkundige wijziging, dus de UI biedt die ook niet meer aan. De
  // databasegrendel is leidend; dit voorkomt alleen een onvermijdelijke fout.
  const isPosted = !!posting;
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
    grootboekrekening_id: "",
    notes: "",
    status: "concept",
  });
  const [btwEnabled, setBtwEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [vraagpostOpen, setVraagpostOpen] = useState(false);

  const isDuplicate = useMemo(() => {
    if (knownDuplicate !== undefined) return knownDuplicate;
    if (!invoice || !allInvoices) return false;
    const normName = invoice.customer_name?.trim().toLowerCase() ?? "";
    const normNum = invoice.invoice_number?.trim().toLowerCase() ?? "";
    if (!normName || !normNum) return false;
    return allInvoices.some(
      other =>
        other.id !== invoice.id &&
        (other.customer_name?.trim().toLowerCase() ?? "") === normName &&
        (other.invoice_number?.trim().toLowerCase() ?? "") === normNum,
    );
  }, [invoice, allInvoices, knownDuplicate]);

  const currentClient = useMemo(
    () => clients?.find((client) => client.id === invoice?.client_id) ?? null,
    [clients, invoice?.client_id],
  );

  useEffect(() => {
    if (invoice) {
      const verlegd = !!(invoice as any).btw_verlegd;
      const pct = invoice.btw_percentage?.toString() || "21";
      const enabled = !verlegd && (parseFloat(pct) !== 0 || (invoice.btw_amount !== null && invoice.btw_amount !== 0));
      setBtwEnabled(enabled && !verlegd);

      setForm(deriveFormFromInvoice(invoice));
    }
  }, [invoice]);

  // Op elke render opnieuw afgeleid uit de huidige `invoice`-prop, zodat dit
  // zichzelf corrigeert zodra de parent een vers opgeslagen/opnieuw
  // opgehaalde factuur doorgeeft — geen aparte snapshot-state die kan
  // verouderen.
  const persistedForm = useMemo(
    () => (invoice ? deriveFormFromInvoice(invoice) : null),
    [invoice],
  );
  const isDirty = !!persistedForm && isPrePostStateDirty(form, persistedForm);

  if (!invoice) return null;

  const hasFile = !!invoice.pdf_path;
  const set = (key: string, value: string | boolean) => setForm(prev => ({ ...prev, [key]: value }));

  const buildUpdates = (): Partial<SalesInvoice> => {
    const isVerlegd = form.btw_percentage === "verlegd";
    const amountExcl = form.amount_excl ? parseFloat(form.amount_excl) : null;
    const amountIncl = form.amount_incl ? parseFloat(form.amount_incl) : null;
    const nextTotal = amountIncl ?? amountExcl;

    return {
      customer_name: form.customer_name,
      invoice_number: form.invoice_number,
      invoice_date: form.invoice_date || undefined,
      due_date: form.due_date || null,
      amount_excl: amountExcl,
      amount_incl: amountIncl,
      btw_amount: isVerlegd ? 0 : (form.btw_amount ? parseFloat(form.btw_amount) : null),
      btw_percentage: isVerlegd ? 0 : (form.btw_percentage ? parseFloat(form.btw_percentage) : null),
      btw_verlegd: isVerlegd,
      ledger_account_text: form.ledger_account_text || null,
      // Explicit ledger FK. ledger_account_text stays alongside it for history
      // and the existing SnelStart export, which is unchanged by this phase.
      grootboekrekening_id: form.grootboekrekening_id || null,
      notes: form.notes || null,
      remaining_amount: shouldSyncRemainingAmount(invoice) ? nextTotal : undefined,
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

  const handleDownloadTestPackage = async () => {
    if (!invoice.pdf_path) {
      toast({
        title: "Originele PDF ontbreekt",
        description: "Download verkoop testpakket is alleen mogelijk als een originele PDF-bijlage beschikbaar is.",
        variant: "destructive",
      });
      return;
    }

    if (!invoice.pdf_path.toLowerCase().endsWith(".pdf")) {
      toast({
        title: "Originele PDF ontbreekt",
        description: "Download verkoop testpakket is alleen mogelijk als deze verkoopfactuur als PDF is geüpload.",
        variant: "destructive",
      });
      return;
    }

    try {
      const { data: pdfBlob, error } = await supabase.storage.from("invoices").download(invoice.pdf_path);
      if (error || !pdfBlob) {
        toast({
          title: "PDF-download mislukt",
          description: "De originele PDF-bijlage kon niet worden gedownload. Het testpakket is niet gemaakt.",
          variant: "destructive",
        });
        return;
      }

      const { zipBlobPromise, zipFilename } = buildSalesInvoiceTestPackage(invoice, pdfBlob, currentClient);
      const zipBlob = await zipBlobPromise;
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({
        title: "Verkoop testpakket gedownload",
        description: SALES_UBL_TEST_HELPER_TEXT,
      });
    } catch (e: any) {
      toast({
        title: "PDF-download mislukt",
        description: e?.message || "De originele PDF-bijlage kon niet worden gedownload. Het testpakket is niet gemaakt.",
        variant: "destructive",
      });
    }
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
            {isDuplicate && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <p>
                  Deze verkoopfactuur lijkt al eerder te zijn geüpload voor dezelfde klant en hetzelfde factuurnummer. Controleer dit voordat je exporteert.
                </p>
              </div>
            )}
            <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
              <p>{SALES_UBL_TEST_HELPER_TEXT}</p>
              <Button variant="outline" onClick={handleDownloadTestPackage} className="w-full sm:w-auto">
                <FileCode2 className="mr-2 h-4 w-4" />Download verkoop testpakket
              </Button>
            </div>
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
              <GrootboekCombobox
                value={form.ledger_account_text}
                onValueChange={(v) => set("ledger_account_text", v)}
                onIdChange={(id) => set("grootboekrekening_id", id || "")}
                noneOption
              />
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

            <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
              <p>{SALES_UBL_TEST_HELPER_TEXT}</p>
              <Button variant="outline" onClick={handleDownloadTestPackage} className="w-full sm:w-auto">
                <FileCode2 className="mr-2 h-4 w-4" />Download verkoop testpakket
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => setVraagpostOpen(true)} className="mr-auto">
            <HelpCircle className="mr-2 h-4 w-4" />Vraagpost maken
          </Button>
          {isPosted ? (
            <p className="text-xs text-muted-foreground self-center" data-testid="sales-posting-done">
              Deze factuur is geboekt in het grootboek. Boekhoudkundige gegevens
              liggen daarmee vast; een correctie vereist een tegenboeking.
            </p>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                data-testid="sales-posting-button"
                disabled={postInvoice.isPending || !invoice || saving || isDirty || !form.customer_name}
                onClick={async () => {
                  if (!invoice) return;
                  try {
                    await postInvoice.mutateAsync(invoice.id);
                    toast({ title: "Factuur geboekt" });
                  } catch (e) {
                    toast({
                      title: "Boeken niet gelukt",
                      description: e instanceof Error ? e.message : undefined,
                      variant: "destructive",
                    });
                  }
                }}
              >
                {postInvoice.isPending ? "Bezig met boeken…" : "Boeken in grootboek"}
              </Button>
              {isDirty && (
                <p
                  className="text-xs text-muted-foreground self-center basis-full sm:basis-auto"
                  data-testid="sales-posting-dirty-hint"
                >
                  Sla de wijzigingen eerst op voordat je de factuur boekt.
                </p>
              )}
            </>
          )}
          <Button variant="outline" onClick={handleSave} disabled={saving || !form.customer_name || isPosted}>
            <Save className="mr-2 h-4 w-4" />Opslaan
          </Button>
          <Button onClick={handleApprove} disabled={saving || !form.customer_name || isPosted}>
            <CheckCircle2 className="mr-2 h-4 w-4" />Goedkeuren
          </Button>
        </DialogFooter>
      </DialogContent>
      <CreateVraagpostDialog
        open={vraagpostOpen}
        onOpenChange={setVraagpostOpen}
        sourceType="sales_invoice"
        sourceId={invoice.id}
        clientId={invoice.client_id}
        defaultTitel={[invoice.customer_name, invoice.invoice_number].filter(Boolean).join(" — ")}
      />
    </Dialog>
  );
}
