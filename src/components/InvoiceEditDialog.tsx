import { useState, useEffect, useRef } from "react";
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
import { CheckCircle2, Save, FileText, ZoomIn, ZoomOut, RotateCw, FileCode2, Plus, Trash2, HelpCircle, Link2, Link2Off, UserPlus, Truck, Pencil } from "lucide-react";
import { CreateVraagpostDialog } from "@/components/CreateVraagpostDialog";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { useLeveranciers, useAddLeverancier, useUpdateLeverancier, normalizeBtwNummer } from "@/hooks/useLeveranciers";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { shouldSyncRemainingAmount } from "@/lib/invoice-balances";
import { downloadPurchaseInvoiceUbl, validatePurchaseInvoiceForUbl, generatePurchaseInvoiceUbl } from "@/lib/ubl-generator";
import JSZip from "jszip";
import { useToast } from "@/hooks/use-toast";
import { usePurchaseInvoiceLines, useReplacePurchaseInvoiceLines, type InvoiceLineInput } from "@/hooks/usePurchaseInvoiceLines";
import { DOCUMENT_ROUTE_OPTIONS, getDocumentRoute, getDocumentRouteLabel, type DocumentRoute } from "@/lib/document-route";

type PurchaseInvoice = Tables<"purchase_invoices">;
type Client = Tables<"clients">;


type SupplierAutoFillTracker = {
  leverancierId: string;
  text: string;
};


interface Props {
  invoice: PurchaseInvoice | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (id: string, updates: Partial<PurchaseInvoice>) => Promise<void>;
  onApprove: (id: string, updates: Partial<PurchaseInvoice>) => Promise<void>;
  client?: Client | null;
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

export function InvoiceEditDialog({ invoice, open, onOpenChange, onSave, onApprove, client }: Props) {
  const { toast } = useToast();
  const { data: existingLines } = usePurchaseInvoiceLines(invoice?.id);
  const replaceLines = useReplacePurchaseInvoiceLines();
  const { data: leveranciers } = useLeveranciers(invoice?.client_id);
  const addLeverancier = useAddLeverancier();
  const updateLeverancier = useUpdateLeverancier();
  const { data: grootboekrekeningen } = useActiveGrootboekrekeningen();
  const [lines, setLines] = useState<(InvoiceLineInput & { _ledgerLabel: string })[]>([]);
  const [leverancierId, setLeverancierId] = useState<string | null>(null);
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [createSupplierOpen, setCreateSupplierOpen] = useState(false);
  const [supplierForm, setSupplierForm] = useState({
    naam: "", btw_nummer: "", kvk_nummer: "", adres: "", postcode: "", plaats: "", land: "NL", iban: "",
    standaard_grootboekrekening_id: "",
  });
  const [editSupplierOpen, setEditSupplierOpen] = useState(false);
  const [editSupplierForm, setEditSupplierForm] = useState({
    naam: "", btw_nummer: "", kvk_nummer: "", adres: "", postcode: "", plaats: "", land: "NL", iban: "",
    standaard_grootboekrekening_id: "" as string, actief: true,
  });
  const [form, setForm] = useState({
    supplier: "",
    supplier_btw_number: "",
    invoice_number: "",
    invoice_date: "",
    amount_excl: "",
    amount_incl: "",
    btw_amount: "",
    btw_percentage: "",
    ledger_account_text: "",
    notes: "",
  });
  const supplierAutoFilledLedgerRef = useRef<SupplierAutoFillTracker | null>(null);
  const [btwEnabled, setBtwEnabled] = useState(true);
  const [documentRoute, setDocumentRoute] = useState<DocumentRoute>("pdf_route");
  const [routeReason, setRouteReason] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [vraagpostOpen, setVraagpostOpen] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(false);

  const normalizeSupplierName = (s: string) =>
    s.toLowerCase().trim().replace(/\s+/g, " ");

  useEffect(() => {
    if (!invoice?.id || !invoice?.client_id) {
      setDuplicateWarning(false);
      return;
    }
    const invNum = form.invoice_number.trim();
    if (!invNum) {
      setDuplicateWarning(false);
      return;
    }
    const handle = setTimeout(async () => {
      const { data, error } = await supabase
        .from("purchase_invoices")
        .select("id, leverancier_id, supplier_btw_number, supplier")
        .eq("client_id", invoice.client_id)
        .eq("invoice_number", invNum)
        .neq("id", invoice.id);
      if (error || !data) {
        setDuplicateWarning(false);
        return;
      }
      if (data.length === 0) {
        setDuplicateWarning(false);
        return;
      }
      const curBtw = form.supplier_btw_number ? normalizeBtwNummer(form.supplier_btw_number) : "";
      const curName = form.supplier ? normalizeSupplierName(form.supplier) : "";
      const hasIdentity = !!leverancierId || !!curBtw || !!curName;
      if (!hasIdentity) {
        setDuplicateWarning(true);
        return;
      }
      const match = data.some((c: any) => {
        if (leverancierId && c.leverancier_id && c.leverancier_id === leverancierId) return true;
        const cBtw = c.supplier_btw_number ? normalizeBtwNummer(c.supplier_btw_number) : "";
        if (curBtw && cBtw && curBtw === cBtw) return true;
        const cName = c.supplier ? normalizeSupplierName(c.supplier) : "";
        if (curName && cName && curName === cName) return true;
        return false;
      });
      setDuplicateWarning(match);
    }, 350);
    return () => clearTimeout(handle);
  }, [invoice?.id, invoice?.client_id, form.invoice_number, form.supplier, form.supplier_btw_number, leverancierId]);

  useEffect(() => {
    if (invoice) {
      const pct = invoice.btw_percentage?.toString() || "21";
      const enabled = parseFloat(pct) !== 0 || (invoice.btw_amount !== null && invoice.btw_amount !== 0);
      setBtwEnabled(enabled);

      const ledgerValue = invoice.ledger_account_text || "";
      supplierAutoFilledLedgerRef.current = null;

      setForm({
        supplier: invoice.supplier || "",
        supplier_btw_number: invoice.supplier_btw_number || "",
        invoice_number: invoice.invoice_number || "",
        invoice_date: invoice.invoice_date || "",
        amount_excl: invoice.amount_excl?.toString() || "",
        amount_incl: invoice.amount_incl?.toString() || "",
        btw_amount: enabled ? (invoice.btw_amount?.toString() || "") : "0",
        btw_percentage: enabled ? (["0", "9", "21"].includes(pct) ? pct : "21") : "0",
        ledger_account_text: ledgerValue,
        notes: invoice.notes || "",
      });
      setDocumentRoute(getDocumentRoute((invoice as any).document_route));
      setRouteReason(((invoice as any).route_reason as string | null) || "");
      setLeverancierId((invoice as any).leverancier_id ?? null);
    }
  }, [invoice]);

  const linkedLeverancier = leveranciers?.find((l) => l.id === leverancierId) ?? null;

  const getSupplierDefaultLedgerLabel = (supplierId: string) => {
    const leverancier = leveranciers?.find((l) => l.id === supplierId);
    if (!leverancier?.standaard_grootboekrekening_id) return null;
    const gb = grootboekrekeningen?.find((g) => g.id === leverancier.standaard_grootboekrekening_id);
    if (!gb) return null;
    return `${gb.nummer} - ${gb.omschrijving}`;
  };

  // Retry auto-fill if grootboekrekeningen loaded after the leverancier was linked.
  // setForm returns the same `prev` reference when no changes are needed,
  // so React skips the re-render and there is no infinite loop.
  useEffect(() => {
    if (!leverancierId) return;
    const label = getSupplierDefaultLedgerLabel(leverancierId);
    if (!label) return;

    setForm((prev) => {
      const tracked = supplierAutoFilledLedgerRef.current;
      const canAutofill = !prev.ledger_account_text
        || (tracked?.leverancierId === leverancierId && tracked.text === prev.ledger_account_text)
        || (tracked?.leverancierId !== leverancierId && tracked?.text === prev.ledger_account_text);

      if (!canAutofill || prev.ledger_account_text === label) {
        if (tracked?.leverancierId === leverancierId && tracked.text === prev.ledger_account_text) {
          supplierAutoFilledLedgerRef.current = { leverancierId, text: label };
        }
        return prev;
      }

      supplierAutoFilledLedgerRef.current = { leverancierId, text: label };
      return { ...prev, ledger_account_text: label };
    });
  }, [leverancierId, leveranciers, grootboekrekeningen]);

  const handleLinkExisting = (id: string) => {
    const l = leveranciers?.find((x) => x.id === id);
    if (!l) return;
    setLeverancierId(l.id);
    setForm((prev) => ({
      ...prev,
      supplier: l.naam,
      supplier_btw_number: l.btw_nummer ?? prev.supplier_btw_number,
    }));
    setLinkPopoverOpen(false);
    toast({ title: "Leverancier gekoppeld" });
  };

  const handleUnlink = () => {
    const tracked = supplierAutoFilledLedgerRef.current;
    setLeverancierId(null);
    setForm((prev) => {
      if (tracked && prev.ledger_account_text === tracked.text) {
        return { ...prev, ledger_account_text: "" };
      }
      return prev;
    });
    supplierAutoFilledLedgerRef.current = null;
    toast({ title: "Leverancier ontkoppeld" });
  };

  const openCreateSupplier = () => {
    const ocr: any = invoice?.ocr_data ?? {};
    setSupplierForm({
      naam: invoice?.supplier ?? "",
      btw_nummer: invoice?.supplier_btw_number ?? "",
      kvk_nummer: ocr.supplier_kvk ?? "",
      adres: ocr.supplier_address ?? "",
      postcode: ocr.supplier_postal_code ?? "",
      plaats: ocr.supplier_city ?? "",
      land: "NL",
      iban: ocr.supplier_iban ?? "",
      standaard_grootboekrekening_id: "",
    });
    setCreateSupplierOpen(true);
  };

  const handleCreateSupplier = async () => {
    if (!supplierForm.naam.trim()) {
      toast({ title: "Naam is verplicht", variant: "destructive" });
      return;
    }
    if (!invoice?.client_id) return;
    try {
      const created = await addLeverancier.mutateAsync({
        client_id: invoice.client_id,
        naam: supplierForm.naam.trim(),
        btw_nummer: supplierForm.btw_nummer ? normalizeBtwNummer(supplierForm.btw_nummer) : null,
        kvk_nummer: supplierForm.kvk_nummer.trim() || null,
        adres: supplierForm.adres.trim() || null,
        postcode: supplierForm.postcode.trim() || null,
        plaats: supplierForm.plaats.trim() || null,
        land: supplierForm.land.trim() || "NL",
        iban: supplierForm.iban.trim() || null,
        standaard_grootboekrekening_id: supplierForm.standaard_grootboekrekening_id || null,
        actief: true,
      });
      setLeverancierId(created.id);
      setForm((prev) => ({
        ...prev,
        supplier: created.naam,
        supplier_btw_number: created.btw_nummer ?? prev.supplier_btw_number,
      }));
      setCreateSupplierOpen(false);
      toast({ title: "Leverancier aangemaakt en gekoppeld" });
    } catch (e: any) {
      toast({ title: "Aanmaken mislukt", description: e.message, variant: "destructive" });
    }
  };

  const openEditSupplier = () => {
    if (!linkedLeverancier) return;
    setEditSupplierForm({
      naam: linkedLeverancier.naam ?? "",
      btw_nummer: linkedLeverancier.btw_nummer ?? "",
      kvk_nummer: linkedLeverancier.kvk_nummer ?? "",
      adres: linkedLeverancier.adres ?? "",
      postcode: linkedLeverancier.postcode ?? "",
      plaats: linkedLeverancier.plaats ?? "",
      land: linkedLeverancier.land ?? "NL",
      iban: linkedLeverancier.iban ?? "",
      standaard_grootboekrekening_id: linkedLeverancier.standaard_grootboekrekening_id ?? "",
      actief: linkedLeverancier.actief ?? true,
    });
    setEditSupplierOpen(true);
  };

  const handleUpdateSupplier = async () => {
    if (!linkedLeverancier) return;
    if (!editSupplierForm.naam.trim()) {
      toast({ title: "Naam is verplicht", variant: "destructive" });
      return;
    }
    try {
      const updated = await updateLeverancier.mutateAsync({
        id: linkedLeverancier.id,
        naam: editSupplierForm.naam.trim(),
        btw_nummer: editSupplierForm.btw_nummer ? normalizeBtwNummer(editSupplierForm.btw_nummer) : null,
        kvk_nummer: editSupplierForm.kvk_nummer.trim() || null,
        adres: editSupplierForm.adres.trim() || null,
        postcode: editSupplierForm.postcode.trim() || null,
        plaats: editSupplierForm.plaats.trim() || null,
        land: editSupplierForm.land.trim() || "NL",
        iban: editSupplierForm.iban.trim() || null,
        standaard_grootboekrekening_id: editSupplierForm.standaard_grootboekrekening_id || null,
        actief: editSupplierForm.actief,
      });
      setForm((prev) => ({
        ...prev,
        supplier: updated.naam,
        supplier_btw_number: updated.btw_nummer ?? prev.supplier_btw_number,
      }));
      setEditSupplierOpen(false);
      toast({ title: "Leverancier bijgewerkt" });
    } catch (e: any) {
      toast({ title: "Bijwerken mislukt", description: e.message, variant: "destructive" });
    }
  };

  useEffect(() => {
    setLines(
      (existingLines ?? []).map((l) => ({
        omschrijving: l.omschrijving,
        amount_excl: Number(l.amount_excl),
        btw_percentage: l.btw_percentage != null ? Number(l.btw_percentage) : null,
        grootboekrekening_id: l.grootboekrekening_id,
        _ledgerLabel: "",
      }))
    );
  }, [existingLines, invoice?.id]);

  const addLine = () => setLines((p) => [...p, { omschrijving: "", amount_excl: 0, btw_percentage: 21, grootboekrekening_id: null, _ledgerLabel: "" }]);
  const removeLine = (i: number) => setLines((p) => p.filter((_, idx) => idx !== i));
  const updateLine = (i: number, patch: Partial<InvoiceLineInput & { _ledgerLabel: string }>) =>
    setLines((p) => p.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const validateLines = (): string | null => {
    if (lines.length === 0) return null;
    for (const l of lines) {
      if (!l.omschrijving.trim()) return "Elke regel moet een omschrijving hebben";
      if (isNaN(Number(l.amount_excl))) return "Elke regel moet een geldig bedrag excl. hebben";
    }
    const sumExcl = lines.reduce((s, l) => s + Number(l.amount_excl || 0), 0);
    const sumIncl = lines.reduce((s, l) => s + Number(l.amount_excl || 0) * (1 + Number(l.btw_percentage || 0) / 100), 0);
    const headerIncl = parseFloat(form.amount_incl);
    const headerExcl = parseFloat(form.amount_excl);
    if (!isNaN(headerExcl) && Math.abs(sumExcl - headerExcl) > 0.02) {
      return `Totaal regels excl. (€${sumExcl.toFixed(2)}) komt niet overeen met factuurtotaal excl. (€${headerExcl.toFixed(2)})`;
    }
    if (!isNaN(headerIncl) && Math.abs(sumIncl - headerIncl) > 0.02) {
      return `Totaal regels incl. BTW (€${sumIncl.toFixed(2)}) komt niet overeen met factuurtotaal incl. (€${headerIncl.toFixed(2)})`;
    }
    return null;
  };

  if (!invoice) return null;

  const hasFile = !!invoice.file_path;
  const set = (key: string, value: string) => setForm(prev => ({ ...prev, [key]: value }));

  const buildUpdates = (): Partial<PurchaseInvoice> => {
    const amountExcl = form.amount_excl ? parseFloat(form.amount_excl) : null;
    const amountIncl = form.amount_incl ? parseFloat(form.amount_incl) : null;
    const nextTotal = amountIncl ?? amountExcl;

    return {
      supplier: form.supplier,
      supplier_btw_number: form.supplier_btw_number || null,
      invoice_number: form.invoice_number || null,
      invoice_date: form.invoice_date || null,
      amount_excl: amountExcl,
      amount_incl: amountIncl,
      btw_amount: form.btw_amount ? parseFloat(form.btw_amount) : null,
      btw_percentage: form.btw_percentage ? parseFloat(form.btw_percentage) : null,
      ledger_account_text: form.ledger_account_text || null,
      notes: form.notes || null,
      remaining_amount: shouldSyncRemainingAmount(invoice) ? nextTotal : undefined,
      document_route: documentRoute,
      route_reason: routeReason || null,
      leverancier_id: leverancierId,
    } as Partial<PurchaseInvoice>;
  };

  const persistLines = async () => {
    await replaceLines.mutateAsync({
      invoiceId: invoice.id,
      lines: lines.map((l) => ({
        omschrijving: l.omschrijving,
        amount_excl: Number(l.amount_excl) || 0,
        btw_percentage: l.btw_percentage,
        grootboekrekening_id: l.grootboekrekening_id,
      })),
    });
  };

  const handleSave = async () => {
    const err = validateLines();
    if (err) {
      toast({ title: "Ongeldige factuurregels", description: err, variant: "destructive" });
      return;
    }
    setSaving(true);
    await onSave(invoice.id, buildUpdates());
    await persistLines();
    setSaving(false);
    onOpenChange(false);
  };

  const handleApprove = async () => {
    const err = validateLines();
    if (err) {
      toast({ title: "Ongeldige factuurregels", description: err, variant: "destructive" });
      return;
    }
    setSaving(true);
    await onApprove(invoice.id, { ...buildUpdates(), status: "gecontroleerd" });
    await persistLines();
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
      <DialogContent className={hasFile ? "sm:max-w-5xl max-h-[90vh] flex flex-col" : "sm:max-w-lg flex flex-col"}>
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            Factuur controleren
            <Badge variant={invoice.status === "te_controleren" ? "secondary" : "default"}>
              {invoice.status === "te_controleren" ? "Te controleren" : invoice.status}
            </Badge>
            <Badge variant="outline">{getDocumentRouteLabel(documentRoute)}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className={hasFile ? "grid grid-cols-2 gap-6 flex-1 overflow-hidden min-h-0" : "flex-1 overflow-auto"}>
          {hasFile && (
            <InvoicePreview filePath={invoice.file_path} />
          )}

          <div className="space-y-4 overflow-y-auto flex-1 min-h-0 pr-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Leverancier *</Label>
                <Input value={form.supplier} onChange={e => set("supplier", e.target.value)} />
              </div>
              <div>
                <Label>BTW-nummer leverancier</Label>
                <Input
                  value={form.supplier_btw_number}
                  onChange={e => set("supplier_btw_number", e.target.value)}
                  placeholder="bv. NL123456789B01"
                />
              </div>
            </div>

            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="flex items-center gap-1.5"><Truck className="h-3.5 w-3.5" />Leverancier koppeling</Label>
                {linkedLeverancier ? (
                  <Badge variant="secondary" className="font-normal">
                    {linkedLeverancier.naam}
                    {linkedLeverancier.btw_nummer ? ` · ${linkedLeverancier.btw_nummer}` : ""}
                  </Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">Geen leverancier gekoppeld</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Popover open={linkPopoverOpen} onOpenChange={setLinkPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="outline" size="sm">
                      <Link2 className="h-3.5 w-3.5 mr-1" />Koppel bestaande leverancier
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="p-0 w-[320px]" align="start">
                    <Command
                      filter={(value, search) => {
                        const s = search.toLowerCase();
                        return value.toLowerCase().includes(s) ? 1 : 0;
                      }}
                    >
                      <CommandInput placeholder="Zoek op naam, BTW of KvK..." />
                      <CommandList>
                        <CommandEmpty>Geen leveranciers gevonden</CommandEmpty>
                        <CommandGroup>
                          {(leveranciers ?? []).map((l) => (
                            <CommandItem
                              key={l.id}
                              value={`${l.naam} ${l.btw_nummer ?? ""} ${l.kvk_nummer ?? ""}`}
                              onSelect={() => handleLinkExisting(l.id)}
                            >
                              <div className="flex flex-col">
                                <span>{l.naam}</span>
                                <span className="text-xs text-muted-foreground">
                                  {l.btw_nummer ?? "—"} · KvK {l.kvk_nummer ?? "—"}
                                </span>
                              </div>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <Button type="button" variant="outline" size="sm" onClick={openCreateSupplier}>
                  <UserPlus className="h-3.5 w-3.5 mr-1" />Maak leverancier aan
                </Button>
                {linkedLeverancier && (
                  <Button type="button" variant="outline" size="sm" onClick={openEditSupplier}>
                    <Pencil className="h-3.5 w-3.5 mr-1" />Leverancier bewerken
                  </Button>
                )}
                {linkedLeverancier && (
                  <Button type="button" variant="ghost" size="sm" onClick={handleUnlink}>
                    <Link2Off className="h-3.5 w-3.5 mr-1" />Leverancier ontkoppelen
                  </Button>
                )}
              </div>
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

            {duplicateWarning && (
              <div className="rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-900 dark:text-amber-200">
                Mogelijk dubbele factuur: er bestaat al een factuur met dit factuurnummer voor deze leverancier.
              </div>
            )}

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
                onValueChange={(v) => { supplierAutoFilledLedgerRef.current = null; set("ledger_account_text", v); }}
              />
            </div>

            <div className="border-t pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label>Factuurregels (optioneel)</Label>
                <Button type="button" variant="outline" size="sm" onClick={addLine}>
                  <Plus className="h-3.5 w-3.5 mr-1" />Regel toevoegen
                </Button>
              </div>
              {lines.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Geen regels. Voeg regels toe om de factuur over meerdere grootboekrekeningen of BTW-tarieven te splitsen.
                </p>
              )}
              {lines.map((l, i) => (
                <div key={i} className="rounded-md border p-2 space-y-2 bg-muted/20">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Omschrijving"
                      value={l.omschrijving}
                      onChange={(e) => updateLine(i, { omschrijving: e.target.value })}
                    />
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeLine(i)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Bedrag excl.</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={l.amount_excl}
                        onChange={(e) => updateLine(i, { amount_excl: parseFloat(e.target.value) || 0 })}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">BTW %</Label>
                      <Select
                        value={String(l.btw_percentage ?? 0)}
                        onValueChange={(v) => updateLine(i, { btw_percentage: parseFloat(v) })}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="0">0%</SelectItem>
                          <SelectItem value="9">9%</SelectItem>
                          <SelectItem value="21">21%</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Grootboekrekening</Label>
                    <GrootboekCombobox
                      value={l._ledgerLabel}
                      onValueChange={(v) => updateLine(i, { _ledgerLabel: v })}
                      onIdChange={(id) => updateLine(i, { grootboekrekening_id: id })}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t pt-3 grid grid-cols-2 gap-3">
              <div>
                <Label>Document-route</Label>
                <Select value={documentRoute} onValueChange={(v) => setDocumentRoute(v as DocumentRoute)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DOCUMENT_ROUTE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Reden route (optioneel)</Label>
                <Input value={routeReason} onChange={(e) => setRouteReason(e.target.value)} placeholder="bv. ontbrekend BTW-nummer" />
              </div>
            </div>

            <div>
              <Label>Notities</Label>
              <Textarea value={form.notes} onChange={e => set("notes", e.target.value)} rows={2} />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 flex-shrink-0 border-t pt-4">
          <Button variant="outline" onClick={() => setVraagpostOpen(true)} className="mr-auto">
            <HelpCircle className="mr-2 h-4 w-4" />Maak vraagpost
          </Button>
          {invoice.status === "gecontroleerd" && documentRoute === "boekassist_ubl" && (
            <Button
              variant="outline"
              onClick={() => {
                const missing = validatePurchaseInvoiceForUbl(invoice, client, linkedLeverancier);
                if (missing.length) {
                  toast({
                    title: "UBL niet gegenereerd",
                    description: `Ontbrekende velden: ${missing.join(", ")}`,
                    variant: "destructive",
                  });
                  return;
                }
                downloadPurchaseInvoiceUbl(invoice, client, existingLines ?? null, linkedLeverancier);
                toast({ title: "UBL XML gedownload" });
              }}
            >
              <FileCode2 className="mr-2 h-4 w-4" />Genereer UBL
            </Button>
          )}
          {invoice.status === "gecontroleerd" && documentRoute === "boekassist_ubl" && invoice.file_path && (
            <Button
              variant="outline"
              onClick={async () => {
                const missing = validatePurchaseInvoiceForUbl(invoice, client, linkedLeverancier);
                if (missing.length) {
                  toast({
                    title: "UBL niet gegenereerd",
                    description: `Ontbrekende velden: ${missing.join(", ")}`,
                    variant: "destructive",
                  });
                  return;
                }
                try {
                  const { data: fileBlob, error: dlError } = await supabase.storage
                    .from("invoices")
                    .download(invoice.file_path!);
                  if (dlError || !fileBlob) {
                    toast({ title: "Origineel document niet gevonden", variant: "destructive" });
                    return;
                  }
                  const xml = generatePurchaseInvoiceUbl(invoice, client, existingLines ?? null, linkedLeverancier);
                  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
                  const supplierName = linkedLeverancier?.naam ?? invoice.supplier ?? "";
                  const invNum = invoice.invoice_number ?? "";
                  const baseName = (invNum && supplierName)
                    ? `UBL-${sanitize(invNum)}-${sanitize(supplierName)}`
                    : `UBL-${invoice.id}`;
                  const pathLower = invoice.file_path!.toLowerCase();
                  const dotIdx = pathLower.lastIndexOf(".");
                  const ext = dotIdx >= 0 ? pathLower.substring(dotIdx) : ".pdf";
                  const zip = new JSZip();
                  zip.file(`${baseName}.xml`, xml);
                  zip.file(`${baseName}${ext}`, fileBlob);
                  const zipBlob = await zip.generateAsync({ type: "blob" });
                  const url = URL.createObjectURL(zipBlob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `${baseName}.zip`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  toast({ title: "SnelStart-pakket gedownload" });
                } catch (e: any) {
                  toast({ title: "Origineel document niet gevonden", description: e?.message, variant: "destructive" });
                }
              }}
            >
              <FileCode2 className="mr-2 h-4 w-4" />Download SnelStart-pakket
            </Button>
          )}
          <Button variant="outline" onClick={handleSave} disabled={saving || !form.supplier}>
            <Save className="mr-2 h-4 w-4" />Opslaan
          </Button>
          <Button onClick={handleApprove} disabled={saving || !form.supplier}>
            <CheckCircle2 className="mr-2 h-4 w-4" />Goedkeuren
          </Button>
        </DialogFooter>
      </DialogContent>
      <CreateVraagpostDialog
        open={vraagpostOpen}
        onOpenChange={setVraagpostOpen}
        sourceType="purchase_invoice"
        sourceId={invoice.id}
        clientId={invoice.client_id}
        defaultTitel={invoice.supplier ?? ""}
      />
      <Dialog open={createSupplierOpen} onOpenChange={setCreateSupplierOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Nieuwe leverancier</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Naam *</Label>
              <Input value={supplierForm.naam} onChange={(e) => setSupplierForm((f) => ({ ...f, naam: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>BTW-nummer</Label>
                <Input value={supplierForm.btw_nummer} onChange={(e) => setSupplierForm((f) => ({ ...f, btw_nummer: e.target.value }))} placeholder="NL123456789B01" />
              </div>
              <div>
                <Label>KvK-nummer</Label>
                <Input value={supplierForm.kvk_nummer} onChange={(e) => setSupplierForm((f) => ({ ...f, kvk_nummer: e.target.value }))} />
              </div>
            </div>
            <div>
              <Label>Adres</Label>
              <Input value={supplierForm.adres} onChange={(e) => setSupplierForm((f) => ({ ...f, adres: e.target.value }))} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Postcode</Label>
                <Input value={supplierForm.postcode} onChange={(e) => setSupplierForm((f) => ({ ...f, postcode: e.target.value }))} />
              </div>
              <div>
                <Label>Plaats</Label>
                <Input value={supplierForm.plaats} onChange={(e) => setSupplierForm((f) => ({ ...f, plaats: e.target.value }))} />
              </div>
              <div>
                <Label>Land</Label>
                <Input value={supplierForm.land} onChange={(e) => setSupplierForm((f) => ({ ...f, land: e.target.value }))} />
              </div>
            </div>
            <div>
              <Label>IBAN</Label>
              <Input value={supplierForm.iban} onChange={(e) => setSupplierForm((f) => ({ ...f, iban: e.target.value }))} />
            </div>
            <div>
              <Label>Standaard grootboekrekening</Label>
              <GrootboekCombobox
                value={
                  supplierForm.standaard_grootboekrekening_id
                    ? (() => {
                        const gb = grootboekrekeningen?.find((g) => g.id === supplierForm.standaard_grootboekrekening_id);
                        return gb ? `${gb.nummer} - ${gb.omschrijving}` : "";
                      })()
                    : ""
                }
                onValueChange={() => {}}
                onIdChange={(id) => setSupplierForm((f) => ({ ...f, standaard_grootboekrekening_id: id || "" }))}
                noneOption
                placeholder="Geen"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateSupplierOpen(false)}>Annuleren</Button>
            <Button onClick={handleCreateSupplier} disabled={addLeverancier.isPending}>Opslaan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={editSupplierOpen} onOpenChange={setEditSupplierOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Leverancier bewerken</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Naam *</Label>
              <Input value={editSupplierForm.naam} onChange={(e) => setEditSupplierForm((f) => ({ ...f, naam: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>BTW-nummer</Label>
                <Input value={editSupplierForm.btw_nummer} onChange={(e) => setEditSupplierForm((f) => ({ ...f, btw_nummer: e.target.value }))} placeholder="NL123456789B01" />
              </div>
              <div>
                <Label>KvK-nummer</Label>
                <Input value={editSupplierForm.kvk_nummer} onChange={(e) => setEditSupplierForm((f) => ({ ...f, kvk_nummer: e.target.value }))} />
              </div>
            </div>
            <div>
              <Label>Adres</Label>
              <Input value={editSupplierForm.adres} onChange={(e) => setEditSupplierForm((f) => ({ ...f, adres: e.target.value }))} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Postcode</Label>
                <Input value={editSupplierForm.postcode} onChange={(e) => setEditSupplierForm((f) => ({ ...f, postcode: e.target.value }))} />
              </div>
              <div>
                <Label>Plaats</Label>
                <Input value={editSupplierForm.plaats} onChange={(e) => setEditSupplierForm((f) => ({ ...f, plaats: e.target.value }))} />
              </div>
              <div>
                <Label>Land</Label>
                <Input value={editSupplierForm.land} onChange={(e) => setEditSupplierForm((f) => ({ ...f, land: e.target.value }))} />
              </div>
            </div>
            <div>
              <Label>IBAN</Label>
              <Input value={editSupplierForm.iban} onChange={(e) => setEditSupplierForm((f) => ({ ...f, iban: e.target.value }))} />
            </div>
            <div>
              <Label>Standaard grootboekrekening</Label>
              <GrootboekCombobox
                value={
                  editSupplierForm.standaard_grootboekrekening_id
                    ? (() => {
                        const gb = grootboekrekeningen?.find((g) => g.id === editSupplierForm.standaard_grootboekrekening_id);
                        return gb ? `${gb.nummer} - ${gb.omschrijving}` : "";
                      })()
                    : ""
                }
                onValueChange={() => {}}
                onIdChange={(id) => setEditSupplierForm((f) => ({ ...f, standaard_grootboekrekening_id: id || "" }))}
                noneOption
                placeholder="Geen"
              />
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Switch
                id="edit-supplier-actief"
                checked={editSupplierForm.actief}
                onCheckedChange={(v) => setEditSupplierForm((f) => ({ ...f, actief: v }))}
              />
              <Label htmlFor="edit-supplier-actief" className="cursor-pointer">Actief</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditSupplierOpen(false)}>Annuleren</Button>
            <Button onClick={handleUpdateSupplier} disabled={updateLeverancier.isPending}>Opslaan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
