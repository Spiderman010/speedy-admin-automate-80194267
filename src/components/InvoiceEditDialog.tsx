import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { CheckCircle2, Save, FileText, ZoomIn, ZoomOut, RotateCw, FileCode2, Plus, Trash2, HelpCircle, Link2, Link2Off, UserPlus, Truck, Pencil, Info, ChevronLeft, ChevronRight, AlertTriangle, ExternalLink } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
import { computeLineDiffs, validatePurchaseLines, derivePrefillLine } from "@/lib/purchase-line-validation";

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
  onOpenExisting?: (invoiceId: string) => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
}

type PreviewErrorKind = "missing" | "unauthorized" | "error";

function InvoicePreview({ filePath }: { filePath: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState<PreviewErrorKind | null>(null);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    if (!filePath) { setUrl(null); setPreviewError(null); setRenderError(false); return; }
    setUrl(null);
    setPreviewError(null);
    setRenderError(false);
    setLoading(true);
    setZoom(1);
    setRotation(0);
    supabase.storage.from("invoices").createSignedUrl(filePath, 3600).then(({ data, error }) => {
      if (error) {
        console.error("InvoicePreview createSignedUrl error", filePath, error);
        const status = (error as any).status ?? (error as any).statusCode;
        const msg = (error.message ?? "").toLowerCase();
        // Supabase Storage returns 404 for both "file missing" and "access denied"
        // to avoid leaking object existence — we surface a single clear message.
        if (status === 404 || msg.includes("not found") || msg.includes("does not exist")) {
          setPreviewError("missing");
        } else if (status === 403 || status === 401 || msg.includes("unauthorized") || msg.includes("forbidden")) {
          setPreviewError("unauthorized");
        } else {
          setPreviewError("error");
        }
      }
      setUrl(data?.signedUrl ?? null);
      setLoading(false);
    }).catch((err) => {
      console.error("InvoicePreview createSignedUrl exception", filePath, err);
      setPreviewError("error");
      setLoading(false);
    });
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

  const urlErrorMessage =
    previewError === "missing" ? "Bestand ontbreekt of pad klopt niet" :
    previewError === "unauthorized" ? "Geen toegang tot bestand" :
    "Document kan niet worden geladen";

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
        {!isPdf && !renderError && (
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setRotation(r => (r + 90) % 360)}>
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        )}
        {url && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Open in nieuw tabblad"
            onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="flex-1 overflow-auto rounded-lg bg-muted/20 border">
        {isPdf && url ? (
          <iframe src={url} className="w-full h-full min-h-[400px]" style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }} />
        ) : url && !renderError ? (
          <img
            src={url}
            alt="Factuur preview"
            className="max-w-full transition-transform"
            style={{ transform: `scale(${zoom}) rotate(${rotation}deg)`, transformOrigin: "top left" }}
            onError={() => { console.error("InvoicePreview image render error", filePath); setRenderError(true); }}
          />
        ) : url && renderError ? (
          <div className="flex flex-col items-center justify-center h-full text-sm text-muted-foreground gap-3 py-8">
            <AlertTriangle className="h-8 w-8 opacity-40" />
            <p>Bestand kan niet worden weergegeven</p>
            <button
              type="button"
              className="text-xs underline underline-offset-2 hover:no-underline"
              onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
            >
              Bestand openen in nieuw tabblad
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-sm text-muted-foreground gap-2 py-8">
            <AlertTriangle className="h-8 w-8 opacity-40" />
            <p>{urlErrorMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function InvoiceEditDialog({ invoice, open, onOpenChange, onSave, onApprove, client, onOpenExisting, hasPrev, hasNext, onPrev, onNext }: Props) {
  const { toast } = useToast();
  const { data: existingLines } = usePurchaseInvoiceLines(invoice?.id);
  const replaceLines = useReplacePurchaseInvoiceLines();
  const { data: leveranciers } = useLeveranciers({
    organizationId: invoice?.organization_id ?? undefined,
    clientId: invoice?.client_id ?? undefined,
    enabled: !!invoice,
  });
  const addLeverancier = useAddLeverancier();
  const updateLeverancier = useUpdateLeverancier();
  const { data: grootboekrekeningen } = useActiveGrootboekrekeningen({
    organizationId: invoice?.organization_id ?? undefined,
    enabled: !!invoice,
  });
  const [lines, setLines] = useState<(InvoiceLineInput & { _ledgerLabel: string })[]>([]);
  const linesInitInvoiceIdRef = useRef<string | null>(null);
  const [prefilledFromHeader, setPrefilledFromHeader] = useState(false);
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
  const [duplicateMatches, setDuplicateMatches] = useState<Array<{ id: string; supplier: string | null; invoice_date: string | null; amount_incl: number | null }>>([]);
  const qc = useQueryClient();
  const canGenerateUbl = invoice ? ["gecontroleerd", "geexporteerd"].includes(invoice.status) : false;
  const clientBtwType = ((client as unknown as { btw_type?: string } | null)?.btw_type)
    ?? (client?.btw_vrijgesteld ? "vrijgesteld" : "plichtig");
  const isBtwVrijgesteld = clientBtwType === "vrijgesteld";

  const normalizeSupplierName = (s: string) =>
    s.toLowerCase().trim().replace(/\s+/g, " ");

  useEffect(() => {
    if (!invoice?.id || !invoice?.client_id) {
      setDuplicateMatches([]);
      return;
    }
    const invNum = form.invoice_number.trim();
    if (!invNum) {
      setDuplicateMatches([]);
      return;
    }
    const handle = setTimeout(async () => {
      const { data, error } = await supabase
        .from("purchase_invoices")
        .select("id, leverancier_id, supplier_btw_number, supplier, invoice_date, amount_incl")
        .eq("client_id", invoice.client_id)
        .eq("invoice_number", invNum)
        .neq("id", invoice.id);
      if (error || !data) {
        setDuplicateMatches([]);
        return;
      }
      if (data.length === 0) {
        setDuplicateMatches([]);
        return;
      }
      const curBtw = form.supplier_btw_number ? normalizeBtwNummer(form.supplier_btw_number) : "";
      const curName = form.supplier ? normalizeSupplierName(form.supplier) : "";
      const hasIdentity = !!leverancierId || !!curBtw || !!curName;
      const matches = data.filter((c: any) => {
        if (!hasIdentity) return true;
        if (leverancierId && c.leverancier_id && c.leverancier_id === leverancierId) return true;
        const cBtw = c.supplier_btw_number ? normalizeBtwNummer(c.supplier_btw_number) : "";
        if (curBtw && cBtw && curBtw === cBtw) return true;
        const cName = c.supplier ? normalizeSupplierName(c.supplier) : "";
        if (curName && cName && curName === cName) return true;
        return false;
      });
      setDuplicateMatches(
        matches.map((m: any) => ({
          id: m.id,
          supplier: m.supplier ?? null,
          invoice_date: m.invoice_date ?? null,
          amount_incl: m.amount_incl ?? null,
        }))
      );
    }, 350);
    return () => clearTimeout(handle);
  }, [invoice?.id, invoice?.client_id, form.invoice_number, form.supplier, form.supplier_btw_number, leverancierId]);

  useEffect(() => {
    if (invoice) {
      const pct = invoice.btw_percentage?.toString() || "21";
      const rawEnabled = parseFloat(pct) !== 0 || (invoice.btw_amount !== null && invoice.btw_amount !== 0);
      const enabled = isBtwVrijgesteld ? false : rawEnabled;
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
        btw_amount: isBtwVrijgesteld ? "0" : (enabled ? (invoice.btw_amount?.toString() || "") : "0"),
        btw_percentage: isBtwVrijgesteld ? "0" : (enabled ? (["0", "9", "21"].includes(pct) ? pct : "21") : "0"),
        ledger_account_text: ledgerValue,
        notes: invoice.notes || "",
      });
      setDocumentRoute(getDocumentRoute((invoice as any).document_route));
      setRouteReason(((invoice as any).route_reason as string | null) || "");
      setLeverancierId((invoice as any).leverancier_id ?? null);
      linesInitInvoiceIdRef.current = null;
      setPrefilledFromHeader(false);
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

  const handleFillFromOcr = () => {
    const ocr: any = invoice?.ocr_data ?? {};
    const patch: Partial<typeof editSupplierForm> = {};
    if (!editSupplierForm.kvk_nummer && ocr.supplier_kvk) patch.kvk_nummer = ocr.supplier_kvk;
    if (!editSupplierForm.adres && ocr.supplier_address) patch.adres = ocr.supplier_address;
    if (!editSupplierForm.postcode && ocr.supplier_postal_code) patch.postcode = ocr.supplier_postal_code;
    if (!editSupplierForm.plaats && ocr.supplier_city) patch.plaats = ocr.supplier_city;
    if (!editSupplierForm.land && ocr.supplier_country) patch.land = ocr.supplier_country;
    if (!editSupplierForm.iban && ocr.supplier_iban) patch.iban = ocr.supplier_iban;
    if (Object.keys(patch).length === 0) {
      toast({ title: "Geen ontbrekende velden om aan te vullen" });
      return;
    }
    setEditSupplierForm((f) => ({ ...f, ...patch }));
    toast({ title: "Ontbrekende velden aangevuld uit OCR" });
  };

  useEffect(() => {
    if (!invoice?.id) return;
    if (existingLines === undefined) return;
    if (linesInitInvoiceIdRef.current === invoice.id) return;
    linesInitInvoiceIdRef.current = invoice.id;

    if (existingLines.length > 0) {
      setLines(
        existingLines.map((l) => ({
          omschrijving: l.omschrijving,
          amount_excl: Number(l.amount_excl),
          btw_percentage: isBtwVrijgesteld ? 0 : (l.btw_percentage != null ? Number(l.btw_percentage) : null),
          grootboekrekening_id: l.grootboekrekening_id,
          _ledgerLabel: "",
        }))
      );
      setPrefilledFromHeader(false);
      return;
    }

    // No stored lines → prefill one default line from header totals.
    const prefill = derivePrefillLine({
      amount_excl: form.amount_excl ? parseFloat(form.amount_excl) : null,
      amount_incl: form.amount_incl ? parseFloat(form.amount_incl) : null,
      btw_percentage: form.btw_percentage ? parseFloat(form.btw_percentage) : null,
      isBtwVrijgesteld,
    });
    if (!prefill) {
      setLines([]);
      setPrefilledFromHeader(false);
      return;
    }
    const headerLedger = grootboekrekeningen?.find(
      (g) => `${g.nummer} - ${g.omschrijving}` === form.ledger_account_text
    ) ?? null;
    const omschrijving = form.supplier?.trim() || invoice.supplier?.trim() || "Inkoopfactuur";
    setLines([{
      omschrijving,
      amount_excl: prefill.amount_excl,
      btw_percentage: prefill.btw_percentage,
      grootboekrekening_id: headerLedger?.id ?? null,
      _ledgerLabel: headerLedger ? form.ledger_account_text : "",
    }]);
    setPrefilledFromHeader(true);
  }, [existingLines, invoice?.id, isBtwVrijgesteld, grootboekrekeningen, form.amount_excl, form.amount_incl, form.btw_percentage, form.ledger_account_text, form.supplier]);


  const addLine = () => { setPrefilledFromHeader(false); setLines((p) => [...p, { omschrijving: "", amount_excl: 0, btw_percentage: isBtwVrijgesteld ? 0 : 21, grootboekrekening_id: null, _ledgerLabel: "" }]); };
  const removeLine = (i: number) => { setPrefilledFromHeader(false); setLines((p) => p.filter((_, idx) => idx !== i)); };
  const updateLine = (i: number, patch: Partial<InvoiceLineInput & { _ledgerLabel: string }>) =>
    setLines((p) => p.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const headerTotalsForLines = () => {
    const excl = parseFloat(form.amount_excl);
    const btw = parseFloat(form.btw_amount);
    const incl = parseFloat(form.amount_incl);
    return {
      amount_excl: Number.isFinite(excl) ? excl : null,
      btw_amount: Number.isFinite(btw) ? btw : null,
      amount_incl: Number.isFinite(incl) ? incl : null,
    };
  };

  const validateLines = (): string | null =>
    validatePurchaseLines(
      lines.map((l) => ({
        omschrijving: l.omschrijving,
        amount_excl: Number(l.amount_excl || 0),
        btw_percentage: Number(l.btw_percentage || 0),
      })),
      headerTotalsForLines(),
    );

  if (!invoice) return null;

  const ocrScore = (() => {
    const isPresent = (v: string | null | undefined) => {
      if (!v) return false;
      const s = v.trim();
      return !!s && s.toLowerCase() !== "onbekend";
    };
    const isNum = (v: number | null | undefined) => v != null && isFinite(v);
    return [
      isPresent(invoice.supplier),
      isPresent(invoice.invoice_number),
      isPresent(invoice.invoice_date),
      isNum(invoice.amount_incl),
      isNum(invoice.btw_percentage),
      isPresent(invoice.supplier_btw_number),
    ].filter(Boolean).length;
  })();

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
      btw_amount: isBtwVrijgesteld ? 0 : (form.btw_amount ? parseFloat(form.btw_amount) : null),
      btw_percentage: isBtwVrijgesteld ? 0 : (form.btw_percentage ? parseFloat(form.btw_percentage) : null),
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
        btw_percentage: isBtwVrijgesteld ? 0 : l.btw_percentage,
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
      <DialogContent className={hasFile ? "sm:max-w-[1400px] lg:max-w-[1600px] w-[98vw] max-h-[94vh] flex flex-col overflow-hidden p-4 sm:p-6" : "sm:max-w-3xl w-[92vw] max-h-[92vh] flex flex-col overflow-hidden"}>
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-start justify-between gap-4">
            <DialogTitle className="flex items-center gap-2 flex-wrap">
              Factuur controleren
              <Badge variant={invoice.status === "te_controleren" ? "secondary" : "default"}>
                {invoice.status === "te_controleren" ? "Te controleren" : invoice.status}
              </Badge>
              <Badge variant="outline">{getDocumentRouteLabel(documentRoute)}</Badge>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className={
                        ocrScore >= 5
                          ? "cursor-default border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200"
                          : ocrScore >= 3
                          ? "cursor-default border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                          : "cursor-default border-destructive/50 bg-destructive/10 text-destructive"
                      }
                    >
                      <Info className="mr-1 h-3 w-3" />
                      {ocrScore}/6 velden herkend
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Indicatie op basis van ingevulde herkende velden; geen AI-zekerheidsscore.</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </DialogTitle>
            {(onPrev || onNext) && (
              <div className="flex items-center gap-1 shrink-0">
                <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={!hasPrev} onClick={onPrev}>
                  <ChevronLeft className="h-3.5 w-3.5 mr-0.5" />Vorige
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={!hasNext} onClick={onNext}>
                  Volgende<ChevronRight className="h-3.5 w-3.5 ml-0.5" />
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>

        <div className={hasFile ? "grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-6 flex-1 overflow-hidden min-h-0" : "flex flex-col flex-1 overflow-hidden min-h-0"}>
          {hasFile && (
            <div className="hidden lg:block h-full min-h-0 overflow-hidden">
              <InvoicePreview key={invoice.file_path ?? invoice.id} filePath={invoice.file_path} />
            </div>
          )}

          <div className="space-y-4 overflow-y-auto flex-1 min-h-0 h-full pr-2">

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

            {duplicateMatches.length > 0 && (
              <div className="rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-900 dark:text-amber-200 space-y-2">
                <div>
                  Mogelijk dubbele factuur: er {duplicateMatches.length === 1 ? "bestaat al 1 factuur" : `bestaan al ${duplicateMatches.length} facturen`} met dit factuurnummer voor deze leverancier.
                </div>
                <ul className="space-y-1">
                  {duplicateMatches.map((m) => {
                    const label = [
                      m.supplier || "Onbekende leverancier",
                      m.invoice_date ? new Date(m.invoice_date).toLocaleDateString("nl-NL") : null,
                      m.amount_incl != null
                        ? new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(Number(m.amount_incl))
                        : null,
                    ].filter(Boolean).join(" · ");
                    return (
                      <li key={m.id}>
                        {onOpenExisting ? (
                          <button
                            type="button"
                            onClick={() => onOpenExisting(m.id)}
                            className="underline underline-offset-2 hover:no-underline text-left"
                          >
                            {label}
                          </button>
                        ) : (
                          <span>{label}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
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
                  onChange={e => set("btw_amount", e.target.value)} disabled={isBtwVrijgesteld} />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>BTW toepassen</Label>
                <Switch
                  checked={btwEnabled}
                  disabled={isBtwVrijgesteld}
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
                {btwEnabled && !isBtwVrijgesteld ? (
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
              {isBtwVrijgesteld && (
                <p className="text-xs text-muted-foreground">
                  Klant is BTW-vrijgesteld: BTW wordt op 0 gezet.
                </p>
              )}
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

              {lines.length === 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    Geen regels. Voeg regels toe om de factuur over meerdere grootboekrekeningen of BTW-tarieven te splitsen.
                  </p>
                  {(form.amount_excl || form.amount_incl) && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => {
                        const headerExcl = parseFloat(form.amount_excl) || 0;
                        const headerBtw = isBtwVrijgesteld ? 0 : (parseFloat(form.btw_percentage) || 0);
                        const headerLedger = grootboekrekeningen?.find(
                          (g) => `${g.nummer} - ${g.omschrijving}` === form.ledger_account_text
                        ) ?? null;
                        const omschrijving = form.supplier?.trim() || invoice.supplier?.trim() || "Inkoopfactuur";
                        setLines([{
                          omschrijving,
                          amount_excl: headerExcl,
                          btw_percentage: headerBtw,
                          grootboekrekening_id: headerLedger?.id ?? null,
                          _ledgerLabel: headerLedger ? form.ledger_account_text : "",
                        }]);
                      }}
                    >
                      <Plus className="h-3 w-3 mr-1" />Maak deelregel voor totaalbedrag
                    </Button>
                  )}
                </div>
              ) : null}

              {prefilledFromHeader && lines.length > 0 && (
                <p className="text-xs text-muted-foreground italic">
                  Voorstelregel aangemaakt uit factuurtotaal — pas aan of splits indien nodig.
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
                        disabled={isBtwVrijgesteld}
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

              {lines.length > 0 && (() => {
                const header = headerTotalsForLines();
                const lineInputs = lines.map((l) => ({
                  omschrijving: l.omschrijving,
                  amount_excl: Number(l.amount_excl || 0),
                  btw_percentage: Number(l.btw_percentage || 0),
                }));
                const diffs = computeLineDiffs(lineInputs, header);
                const sumExcl = lineInputs.reduce((s, l) => s + l.amount_excl, 0);
                const sumBtw = lineInputs.reduce((s, l) => s + l.amount_excl * (l.btw_percentage || 0) / 100, 0);
                const sumIncl = sumExcl + sumBtw;
                const { allOk, exclOk, btwOk, inclOk, excl: diffExcl, btw: diffBtw, incl: diffIncl } = diffs;
                const fmt = (n: number) => `€${n.toFixed(2)}`;
                const fmtDiff = (d: number) => `${d > 0 ? "+" : ""}${fmt(d)}`;
                const showFillRest = !exclOk && header.amount_excl !== null;
                return (
                  <div className={`rounded-md border px-3 py-2 text-xs space-y-1 ${allOk ? "border-green-500/40 bg-green-50 dark:bg-green-950/30" : "border-amber-500/50 bg-amber-50 dark:bg-amber-950/30"}`}>
                    <div className={`flex items-center gap-1.5 font-medium mb-1 ${allOk ? "text-green-700 dark:text-green-300" : "text-amber-700 dark:text-amber-300"}`}>
                      {allOk
                        ? <><CheckCircle2 className="h-3.5 w-3.5" />Deelregels kloppen</>
                        : <><AlertTriangle className="h-3.5 w-3.5" />Deelregels wijken af</>}
                    </div>
                    <div className="grid grid-cols-3 gap-x-3 text-muted-foreground">
                      <span>Excl. BTW</span>
                      <span>BTW</span>
                      <span>Incl. BTW</span>
                    </div>
                    <div className="grid grid-cols-3 gap-x-3">
                      <span>Factuur: {header.amount_excl === null ? "—" : fmt(header.amount_excl)}</span>
                      <span>Factuur: {header.btw_amount === null ? "—" : fmt(header.btw_amount)}</span>
                      <span>Factuur: {header.amount_incl === null ? "—" : fmt(header.amount_incl)}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-x-3">
                      <span>Som: {fmt(sumExcl)}</span>
                      <span>Som: {fmt(sumBtw)}</span>
                      <span>Som: {fmt(sumIncl)}</span>
                    </div>
                    <div className={`grid grid-cols-3 gap-x-3 font-medium ${allOk ? "text-green-700 dark:text-green-300" : "text-amber-700 dark:text-amber-300"}`}>
                      <span>{diffExcl === null ? "—" : `Verschil: ${fmtDiff(diffExcl)}${exclOk ? "" : " ⚠"}`}</span>
                      <span>{diffBtw === null ? "—" : `Verschil: ${fmtDiff(diffBtw)}${btwOk ? "" : " ⚠"}`}</span>
                      <span>{diffIncl === null ? "—" : `Verschil: ${fmtDiff(diffIncl)}${inclOk ? "" : " ⚠"}`}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground pt-0.5">
                      Tolerantie: ±{fmt(diffs.tolerance)} (schaalt met aantal regels)
                    </div>
                    {showFillRest && header.amount_excl !== null && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-1 text-xs h-7"
                        onClick={() => {
                          const remaining = (header.amount_excl ?? 0) - sumExcl;
                          const headerBtw = isBtwVrijgesteld ? 0 : (parseFloat(form.btw_percentage) || 0);
                          const headerLedger = grootboekrekeningen?.find(
                            (g) => `${g.nummer} - ${g.omschrijving}` === form.ledger_account_text
                          ) ?? null;
                          setLines((prev) => [...prev, {
                            omschrijving: "Resterend bedrag",
                            amount_excl: Math.round(remaining * 100) / 100,
                            btw_percentage: headerBtw,
                            grootboekrekening_id: headerLedger?.id ?? null,
                            _ledgerLabel: headerLedger ? form.ledger_account_text : "",
                          }]);
                        }}
                      >
                        <Plus className="h-3 w-3 mr-1" />Vul resterend verschil
                      </Button>
                    )}
                  </div>
                );
              })()}
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
          {canGenerateUbl && documentRoute === "boekassist_ubl" && (
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
          {canGenerateUbl && documentRoute === "boekassist_ubl" && invoice.file_path && (
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

                  // Log download (non-blocking)
                  try {
                    const currentCount = ((invoice as any).snelstart_package_download_count ?? 0) as number;
                    const { error: logErr } = await supabase
                      .from("purchase_invoices")
                      .update({
                        snelstart_package_downloaded_at: new Date().toISOString(),
                        snelstart_package_download_count: currentCount + 1,
                      } as any)
                      .eq("id", invoice.id);
                    if (logErr) {
                      toast({ title: "Download geregistreerd niet opgeslagen", description: logErr.message });
                    } else {
                      qc.invalidateQueries({ queryKey: ["purchase_invoices"] });
                    }
                  } catch (logE: any) {
                    toast({ title: "Download geregistreerd niet opgeslagen", description: logE?.message });
                  }
                } catch (e: any) {
                  toast({ title: "Origineel document niet gevonden", description: e?.message, variant: "destructive" });
                }
              }}
            >
              <FileCode2 className="mr-2 h-4 w-4" />Download SnelStart-pakket
            </Button>
          )}
          {(invoice as any).snelstart_package_downloaded_at && (
            <span
              className="self-center"
              title={`Laatste download: ${new Date((invoice as any).snelstart_package_downloaded_at).toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`}
            >
              <Badge variant="secondary" className="text-xs font-normal whitespace-nowrap">
                Pakket gedownload{((invoice as any).snelstart_package_download_count ?? 1) > 1 ? ` · ${(invoice as any).snelstart_package_download_count}×` : ""}
              </Badge>
            </span>
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
            {invoice?.ocr_data && (
              <Button type="button" variant="outline" onClick={handleFillFromOcr} className="mr-auto">
                Vul ontbrekende velden uit OCR
              </Button>
            )}
            <Button variant="outline" onClick={() => setEditSupplierOpen(false)}>Annuleren</Button>
            <Button onClick={handleUpdateSupplier} disabled={updateLeverancier.isPending}>Opslaan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
