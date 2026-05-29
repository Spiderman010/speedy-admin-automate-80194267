import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Separator } from "@/components/ui/separator";
import type { Tables } from "@/integrations/supabase/types";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Plus, Download, FileText, CheckCircle2, Clock, Send, Upload, Loader2, Eye, ArrowUp, ArrowDown, Search, Landmark, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useClients } from "@/hooks/useClients";
import { useSalesInvoices, useAddSalesInvoice, useUpdateSalesInvoice, useDeleteSalesInvoice } from "@/hooks/useSalesInvoices";
import { exportSalesInvoicesCSV } from "@/lib/snelstart-export";
import { Skeleton } from "@/components/ui/skeleton";
import { SalesInvoiceDialog, type SalesInvoiceFormData } from "@/components/SalesInvoiceDialog";
import { SalesInvoiceEditDialog } from "@/components/SalesInvoiceEditDialog";
import { InvoiceNumberCopyButton } from "@/components/InvoiceNumberCopyButton";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useQueryClient } from "@tanstack/react-query";
import { useClientContext } from "@/hooks/useClientContext";
import { getInvoicePaymentState, getInvoiceTotalAmount, getInvoiceRemainingAmount } from "@/lib/invoice-balances";
import { useBankTransactionAllocations, useUpsertBankTransactionAllocation, type BankTransactionAllocation } from "@/hooks/useBankTransactionAllocations";
import { useBankTransactions, useUpdateBankTransaction } from "@/hooks/useBankTransactions";
import { getDisplayDescription } from "@/lib/mt940-description-parser";

function Chip({
  label, active, count, onClick, activeClassName,
}: {
  label: string; active: boolean; count: number;
  onClick: () => void; activeClassName?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? (activeClassName ?? "border-primary bg-primary text-primary-foreground")
          : "border-border bg-background text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground"
      }`}
    >
      {label}
      <span className={`rounded-full px-1.5 text-[10px] font-semibold leading-tight ${active ? "bg-black/15" : "bg-muted"}`}>
        {count}
      </span>
    </button>
  );
}

const statusConfig: Record<string, { label: string; icon: typeof Clock; variant: "default" | "secondary" | "outline" }> = {
  concept: { label: "Concept", icon: Clock, variant: "secondary" },
  verzonden: { label: "Verzonden", icon: Send, variant: "default" },
  betaald: { label: "Betaald", icon: CheckCircle2, variant: "outline" },
  gecontroleerd: { label: "Gecontroleerd", icon: CheckCircle2, variant: "outline" },
  geexporteerd: { label: "Geëxporteerd", icon: Download, variant: "outline" },
};

const STATUS_ORDER = ["concept", "verzonden", "gecontroleerd", "betaald", "geexporteerd"];

const formatCurrency = (amount: number | null) =>
  amount != null ? new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount) : "—";

type SortField = "invoice_number" | "client" | "customer_name" | "date" | "due_date" | "amount" | "btw" | "status";
type SortDir = "asc" | "desc";

type SalesTxCandidate = {
  tx: Tables<"bank_transactions">;
  bankAllocated: number;
  bankUnallocated: number;
  suggestedAmount: number;
  score: number;
  reasons: string[];
};

function scoreSalesCandidates(
  transactions: Tables<"bank_transactions">[],
  allAllocations: BankTransactionAllocation[],
  invoiceId: string,
  invoiceNumber: string | null,
  invoiceOpen: number,
  customerName: string | null,
  invoiceDate: string | null,
  searchQ: string,
): SalesTxCandidate[] {
  const allocByTxId = new Map<string, number>();
  for (const a of allAllocations) {
    allocByTxId.set(a.bank_transaction_id, (allocByTxId.get(a.bank_transaction_id) ?? 0) + a.amount);
  }
  const linkedTxIds = new Set(
    allAllocations.filter(a => a.invoice_id === invoiceId).map(a => a.bank_transaction_id)
  );
  const q = searchQ.trim().toLowerCase();
  const results: SalesTxCandidate[] = [];
  for (const tx of transactions) {
    if (tx.amount <= 0) continue;
    if (linkedTxIds.has(tx.id)) continue;
    const bankAllocated = allocByTxId.get(tx.id) ?? 0;
    const bankUnallocated = Math.abs(tx.amount) - bankAllocated;
    if (bankUnallocated < 0.01) continue;
    const suggestedAmount = Math.min(invoiceOpen, bankUnallocated);
    const displayDesc = getDisplayDescription(tx.description);
    const rawDesc = tx.description ?? "";
    let score = 0;
    const reasons: string[] = [];
    if (Math.abs(bankUnallocated - invoiceOpen) < 0.01) { score += 50; reasons.push("Exact bedrag"); }
    if (invoiceNumber) {
      const n = invoiceNumber.toLowerCase();
      if (rawDesc.toLowerCase().includes(n) || displayDesc.toLowerCase().includes(n)) { score += 25; reasons.push("Factuurnummer gevonden"); }
    }
    if (customerName) {
      const parts = customerName.toLowerCase().split(/\s+/).filter(p => p.length > 3);
      if (parts.some(p => rawDesc.toLowerCase().includes(p) || displayDesc.toLowerCase().includes(p))) { score += 20; reasons.push("Naam gevonden"); }
    }
    if (invoiceDate && tx.transaction_date) {
      const diff = Math.abs(new Date(tx.transaction_date).getTime() - new Date(invoiceDate).getTime()) / 86400000;
      if (diff <= 30) { score += 10; reasons.push("Datum dichtbij"); }
    }
    if (q) {
      const dateStr = tx.transaction_date ? new Date(tx.transaction_date).toLocaleDateString("nl-NL") : "";
      const amtStr = Math.abs(tx.amount).toFixed(2);
      if (rawDesc.toLowerCase().includes(q) || displayDesc.toLowerCase().includes(q) || dateStr.includes(q) || amtStr.includes(q)) { score += 5; reasons.push("Zoekmatch"); }
    }
    results.push({ tx, bankAllocated, bankUnallocated, suggestedAmount, score, reasons });
  }
  return results.sort((a, b) => b.score - a.score);
}

export default function Verkoop() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const [clientFilter, setClientFilter] = useState(selectedClientId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadClientId, setUploadClientId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const { data: clients } = useClients();
  const { data: invoices, isLoading } = useSalesInvoices(clientFilter !== "all" ? clientFilter : undefined);
  const addInvoice = useAddSalesInvoice();
  const updateInvoice = useUpdateSalesInvoice();
  const deleteInvoice = useDeleteSalesInvoice();
  const [editInvoice, setEditInvoice] = useState<any>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Tables<"sales_invoices"> | null>(null);
  const [afletteringInvoice, setAfletteringInvoice] = useState<any>(null);
  const [bankSearchQuery, setBankSearchQuery] = useState("");
  const [linkTarget, setLinkTarget] = useState<SalesTxCandidate | null>(null);
  const [linkAmount, setLinkAmount] = useState("");
  const deleteHasExportWarning = deleteTarget?.status === "geexporteerd";

  const upsertAllocation = useUpsertBankTransactionAllocation();
  const updateBankTx = useUpdateBankTransaction();

  useEffect(() => {
    setClientFilter(selectedClientId);
  }, [selectedClientId]);

  const { data: allAllocations } = useBankTransactionAllocations(clientFilter !== "all" ? clientFilter : undefined);
  const { data: allBankTransactions } = useBankTransactions(clientFilter !== "all" ? clientFilter : undefined);

  const allocationsByInvoiceId = useMemo(() => {
    const m = new Map<string, typeof allAllocations[number][]>();
    for (const a of allAllocations ?? []) {
      if (a.invoice_type !== "verkoop") continue;
      const existing = m.get(a.invoice_id);
      if (existing) existing.push(a);
      else m.set(a.invoice_id, [a]);
    }
    return m;
  }, [allAllocations]);

  const bankTransactionById = useMemo(() => {
    const m = new Map<string, NonNullable<typeof allBankTransactions>[number]>();
    for (const tx of allBankTransactions ?? []) m.set(tx.id, tx);
    return m;
  }, [allBankTransactions]);

  const getClientName = (id: string) => clients?.find(c => c.id === id)?.name ?? "—";

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === "asc" ? <ArrowUp className="inline h-3 w-3 ml-1" /> : <ArrowDown className="inline h-3 w-3 ml-1" />;
  };

  const searchFiltered = useMemo(() => {
    if (!invoices) return [];
    if (!searchQuery.trim()) return invoices;
    const q = searchQuery.toLowerCase();
    return invoices.filter(inv =>
      (inv.invoice_number || "").toLowerCase().includes(q) ||
      (inv.customer_name || "").toLowerCase().includes(q) ||
      (inv.status || "").toLowerCase().includes(q)
    );
  }, [invoices, searchQuery]);

  // Each count-base applies all OTHER active filters so chip numbers show "what you'd see if you clicked this"
  const forPaymentCounts = useMemo(() => {
    if (workflowFilter === "all") return searchFiltered;
    return searchFiltered.filter(inv => inv.status === workflowFilter);
  }, [searchFiltered, workflowFilter]);

  const forWorkflowCounts = useMemo(() => {
    if (paymentFilter === "all") return searchFiltered;
    return searchFiltered.filter(inv => {
      const state = getInvoicePaymentState(inv);
      if (paymentFilter === "paid") return state === "paid";
      if (paymentFilter === "partial") return state === "partial";
      return state === "open" || state === "unknown";
    });
  }, [searchFiltered, paymentFilter]);

  const uniqueStatuses = useMemo(() => {
    const present = new Set(searchFiltered.map(inv => inv.status).filter(Boolean));
    const ordered = STATUS_ORDER.filter(s => present.has(s));
    present.forEach(s => { if (!STATUS_ORDER.includes(s)) ordered.push(s); });
    return ordered;
  }, [searchFiltered]);

  const filteredSorted = useMemo(() => {
    let list = [...searchFiltered];
    if (workflowFilter !== "all") list = list.filter(inv => inv.status === workflowFilter);
    if (paymentFilter !== "all") list = list.filter(inv => {
      const state = getInvoicePaymentState(inv);
      if (paymentFilter === "paid") return state === "paid";
      if (paymentFilter === "partial") return state === "partial";
      return state === "open" || state === "unknown";
    });
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "invoice_number": cmp = (a.invoice_number || "").localeCompare(b.invoice_number || ""); break;
        case "client": cmp = getClientName(a.client_id).localeCompare(getClientName(b.client_id)); break;
        case "customer_name": cmp = (a.customer_name || "").localeCompare(b.customer_name || ""); break;
        case "date": cmp = (a.invoice_date || "").localeCompare(b.invoice_date || ""); break;
        case "due_date": cmp = (a.due_date || "").localeCompare(b.due_date || ""); break;
        case "amount": cmp = (a.amount_incl ?? 0) - (b.amount_incl ?? 0); break;
        case "btw": cmp = (a.btw_amount ?? 0) - (b.btw_amount ?? 0); break;
        case "status": cmp = (a.status || "").localeCompare(b.status || ""); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [searchFiltered, workflowFilter, paymentFilter, sortField, sortDir, clients]);

  const handleManualSave = async (form: SalesInvoiceFormData, file: File | null) => {
    let pdfPath: string | null = null;
    if (file) {
      const ext = file.name.split(".").pop() || "pdf";
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const path = `${userId}/sales/${form.client_id}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from("invoices").upload(path, file);
      if (uploadErr) {
        toast({ title: "Upload mislukt", description: uploadErr.message, variant: "destructive" });
        return;
      }
      pdfPath = path;
    }
    await addInvoice.mutateAsync({
      client_id: form.client_id,
      customer_name: form.customer_name,
      invoice_number: form.invoice_number,
      invoice_date: form.invoice_date,
      due_date: form.due_date || null,
      amount_excl: form.amount_excl ? parseFloat(form.amount_excl) : null,
      btw_percentage: form.btw_percentage ? parseFloat(form.btw_percentage) : null,
      btw_amount: form.btw_amount ? parseFloat(form.btw_amount) : null,
      amount_incl: form.amount_incl ? parseFloat(form.amount_incl) : null,
      remaining_amount: form.amount_incl ? parseFloat(form.amount_incl) : form.amount_excl ? parseFloat(form.amount_excl) : null,
      notes: form.notes || null,
      pdf_path: pdfPath,
    });
    toast({ title: "Verkoopfactuur aangemaakt" });
  };

  const processFiles = useCallback(async (files: File[]) => {
    if (!uploadClientId) {
      toast({ title: "Selecteer eerst een klant", variant: "destructive" });
      return;
    }
    if (!session?.access_token) {
      toast({ title: "Niet ingelogd", variant: "destructive" });
      return;
    }

    const validFiles = files.filter(f =>
      ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(f.type)
    );
    if (!validFiles.length) {
      toast({ title: "Geen geldige bestanden", description: "Gebruik PDF, JPG of PNG.", variant: "destructive" });
      return;
    }

    setUploading(true);
    setUploadProgress([]);
    let successCount = 0;
    let failCount = 0;

    for (const file of validFiles) {
      setUploadProgress(prev => [...prev, `⏳ ${file.name} wordt verwerkt...`]);
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("client_id", uploadClientId);

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-sales-invoice`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${session.access_token}` },
            body: formData,
          }
        );

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Onbekende fout" }));
          throw new Error(err.error || `HTTP ${response.status}`);
        }

        const result = await response.json();
        const ext = result.extracted;
        successCount++;
        setUploadProgress(prev => [
          ...prev.slice(0, -1),
          `✅ ${file.name} → ${ext?.customer_name || "Verwerkt"} ${ext?.amount_incl ? formatCurrency(ext.amount_incl) : ""}`,
        ]);
      } catch (e: any) {
        failCount++;
        setUploadProgress(prev => [
          ...prev.slice(0, -1),
          `❌ ${file.name}: ${e.message}`,
        ]);
      }
    }

    setUploading(false);
    queryClient.invalidateQueries({ queryKey: ["sales_invoices"] });

    if (failCount === 0) {
      toast({ title: "Verwerking voltooid", description: `${successCount} bestand(en) verwerkt.` });
    } else if (successCount === 0) {
      toast({ title: "Verwerking mislukt", description: `Geen bestanden konden worden verwerkt.`, variant: "destructive" });
    } else {
      toast({ title: "Gedeeltelijk verwerkt", description: `${successCount} geslaagd, ${failCount} mislukt.`, variant: "destructive" });
    }
  }, [uploadClientId, session, toast, queryClient]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    processFiles(Array.from(e.dataTransfer.files));
  }, [processFiles]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  }, [processFiles]);

  const handleSalesLink = async () => {
    if (!afletteringInvoice || !linkTarget) return;
    const amount = parseFloat(linkAmount);
    const inv = afletteringInvoice;
    const { tx } = linkTarget;

    // 1. Duplicate check — abort if this (tx, invoice) pair is already allocated
    const alreadyLinked = (allAllocations ?? []).some(
      a => a.bank_transaction_id === tx.id && a.invoice_id === inv.id && a.invoice_type === "verkoop"
    );
    if (alreadyLinked) { toast({ title: "Deze banktransactie is al gekoppeld aan deze factuur", variant: "destructive" }); return; }

    // 2. Fresh bank-unallocated from latest local allAllocations
    const bankAllocatedNow = (allAllocations ?? [])
      .filter(a => a.bank_transaction_id === tx.id)
      .reduce((sum, a) => sum + a.amount, 0);
    const bankUnallocatedNow = Math.abs(tx.amount) - bankAllocatedNow;
    if (bankUnallocatedNow < 0.01) { toast({ title: "Deze banktransactie is al volledig gealloceerd", variant: "destructive" }); return; }

    // 3. Fresh invoice-open from current state
    const invoiceOpen = getInvoiceRemainingAmount(inv) ?? 0;
    if (invoiceOpen < 0.01) { toast({ title: "Deze factuur staat niet meer open", variant: "destructive" }); return; }

    if (isNaN(amount) || amount <= 0) { toast({ title: "Ongeldig bedrag", variant: "destructive" }); return; }
    if (amount > invoiceOpen + 0.005) { toast({ title: "Bedrag groter dan openstaand factuurbedrag", variant: "destructive" }); return; }
    if (amount > bankUnallocatedNow + 0.005) { toast({ title: "Bedrag groter dan beschikbaar banksaldo", variant: "destructive" }); return; }

    try {
      await upsertAllocation.mutateAsync({ bank_transaction_id: tx.id, invoice_type: "verkoop", invoice_id: inv.id, client_id: inv.client_id, amount });
      const newRemaining = Math.max(0, invoiceOpen - amount);
      const invoiceUpdates: { remaining_amount: number; status?: string } = { remaining_amount: newRemaining };
      if (newRemaining <= 0.01) invoiceUpdates.status = "betaald";
      await updateInvoice.mutateAsync({ id: inv.id, ...invoiceUpdates } as any);
      const bankUpdates: { id: string; match_status: string; matched_invoice_id?: string } = { id: tx.id, match_status: "gematcht" };
      if (!tx.matched_invoice_id) bankUpdates.matched_invoice_id = inv.id;
      await updateBankTx.mutateAsync(bankUpdates);
      setAfletteringInvoice({ ...inv, remaining_amount: newRemaining, ...(newRemaining <= 0.01 ? { status: "betaald" } : {}) });
      setLinkTarget(null);
      setLinkAmount("");
      toast({ title: "Koppeling aangemaakt" });
    } catch (e: any) {
      toast({ title: "Koppelen mislukt", description: e.message, variant: "destructive" });
    }
  };

  return (
    <>
      <PageHeader title="Verkoopfacturen" description="Upload, verwerk en beheer verkoopfacturen">
        <Select value={clientFilter} onValueChange={(v) => { setClientFilter(v); setSelectedClientId(v); }}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Klant" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle klanten</SelectItem>
            {clients?.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => {
          const exportable = invoices?.filter(i => i.status === "gecontroleerd" || i.status === "betaald") ?? [];
          if (!exportable.length) {
            toast({ title: "Geen exporteerbare verkoopfacturen", description: "Alleen gecontroleerde en betaalde facturen worden geëxporteerd.", variant: "destructive" });
            return;
          }
          const clientName = clientFilter !== "all" ? clients?.find(c => c.id === clientFilter)?.name : undefined;
          exportSalesInvoicesCSV(exportable, clientName);
          toast({ title: `${exportable.length} verkoopfacturen geëxporteerd voor Snelstart` });
        }}>
          <Download className="mr-2 h-4 w-4" />Export
        </Button>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />Handmatig toevoegen
        </Button>
      </PageHeader>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overzicht</TabsTrigger>
          <TabsTrigger value="upload">Upload</TabsTrigger>
        </TabsList>

        <TabsContent value="upload" className="mt-6 space-y-4">
          <Card>
            <CardContent className="p-6">
              <div className="mb-4">
                <label className="text-sm font-medium mb-2 block">Klant selecteren *</label>
                <Select value={uploadClientId} onValueChange={setUploadClientId}>
                  <SelectTrigger className="w-64"><SelectValue placeholder="Kies klant voor upload" /></SelectTrigger>
                  <SelectContent>
                    {clients?.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div
                className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-colors ${
                  dragActive ? "border-primary bg-primary/5" : "border-border"
                } ${!uploadClientId ? "opacity-50 pointer-events-none" : ""}`}
                onDragOver={e => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                  {uploading ? <Loader2 className="h-8 w-8 text-primary animate-spin" /> : <Upload className="h-8 w-8 text-primary" />}
                </div>
                <h3 className="font-display text-lg font-semibold">
                  {uploading ? "Facturen worden verwerkt..." : "Sleep verkoopfacturen hierheen"}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  PDF, JPG of PNG — AI herkent automatisch klantnaam, bedragen en BTW
                </p>
                <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" multiple className="hidden" onChange={handleFileSelect} />
                <Button className="mt-4" onClick={() => fileInputRef.current?.click()} disabled={uploading || !uploadClientId}>
                  <FileText className="mr-2 h-4 w-4" />Bestanden selecteren
                </Button>
              </div>
            </CardContent>
          </Card>

          {uploadProgress.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h4 className="font-display text-sm font-semibold mb-2">Verwerkingsresultaten</h4>
                <div className="space-y-1 text-sm font-mono">
                  {uploadProgress.map((line, i) => (
                    <div key={i} className={line.startsWith("❌") ? "text-destructive" : ""}>{line}</div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="overview" className="mt-6">
          <div className="mb-5 space-y-2.5">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Zoeken op factuurnummer, klantnaam of status..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Betaalstatus</span>
              <Chip label="Alle" active={paymentFilter === "all"} count={forPaymentCounts.length}
                onClick={() => setPaymentFilter("all")} />
              <Chip label="Openstaand" active={paymentFilter === "open"}
                count={forPaymentCounts.filter(inv => { const s = getInvoicePaymentState(inv); return s === "open" || s === "unknown"; }).length}
                onClick={() => setPaymentFilter(paymentFilter === "open" ? "all" : "open")}
                activeClassName="border-orange-400 bg-orange-50 text-orange-900 dark:bg-orange-950/40 dark:text-orange-200" />
              <Chip label="Deelbetaling" active={paymentFilter === "partial"}
                count={forPaymentCounts.filter(inv => getInvoicePaymentState(inv) === "partial").length}
                onClick={() => setPaymentFilter(paymentFilter === "partial" ? "all" : "partial")}
                activeClassName="border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" />
              <Chip label="Betaald" active={paymentFilter === "paid"}
                count={forPaymentCounts.filter(inv => getInvoicePaymentState(inv) === "paid").length}
                onClick={() => setPaymentFilter(paymentFilter === "paid" ? "all" : "paid")}
                activeClassName="border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200" />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Status</span>
              <Chip label="Alle statussen" active={workflowFilter === "all"} count={forWorkflowCounts.length}
                onClick={() => setWorkflowFilter("all")} />
              {uniqueStatuses.map(s => (
                <Chip
                  key={s}
                  label={statusConfig[s]?.label ?? s}
                  active={workflowFilter === s}
                  count={forWorkflowCounts.filter(inv => inv.status === s).length}
                  onClick={() => setWorkflowFilter(workflowFilter === s ? "all" : s)}
                />
              ))}
            </div>
          </div>
          <Card>
            <CardContent className="p-6">
              {isLoading ? (
                <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : !filteredSorted.length ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                    <FileText className="h-8 w-8 text-primary" />
                  </div>
                  <h3 className="font-display text-lg font-semibold">
                    {searchQuery || workflowFilter !== "all" || paymentFilter !== "all" ? "Geen facturen gevonden" : "Nog geen verkoopfacturen"}
                  </h3>
                  <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                    {searchQuery || workflowFilter !== "all" || paymentFilter !== "all" ? "Probeer een andere zoekopdracht of pas de filters aan." : "Upload facturen via het Upload-tabblad of voeg handmatig toe."}
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("invoice_number")}>Factuurnummer<SortIcon field="invoice_number" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("client")}>Klant<SortIcon field="client" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("customer_name")}>Klantnaam<SortIcon field="customer_name" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("date")}>Datum<SortIcon field="date" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("due_date")}>Vervaldatum<SortIcon field="due_date" /></TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("amount")}>Bedrag<SortIcon field="amount" /></TableHead>
                      <TableHead className="text-right">Openstaand</TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("btw")}>BTW<SortIcon field="btw" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("status")}>Status<SortIcon field="status" /></TableHead>
                      <TableHead className="w-20"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSorted.map(inv => {
                      const sc = statusConfig[inv.status] || statusConfig.concept;
                      const hasExportWarning = inv.status === "geexporteerd";
                      return (
                        <TableRow key={inv.id} className="cursor-pointer hover:bg-muted/50" onClick={() => { setEditInvoice(inv); setEditOpen(true); }}>
                          <TableCell className="font-mono text-sm font-medium">
                            <div className="flex items-center gap-2 flex-wrap">
                              {inv.invoice_number ? (
                                <>
                                  <span>{inv.invoice_number}</span>
                                  <InvoiceNumberCopyButton invoiceNumber={inv.invoice_number} />
                                </>
                              ) : (
                                <span>—</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{getClientName(inv.client_id)}</TableCell>
                          <TableCell className="font-medium">{inv.customer_name}</TableCell>
                          <TableCell>{new Date(inv.invoice_date).toLocaleDateString("nl-NL")}</TableCell>
                          <TableCell>{inv.due_date ? new Date(inv.due_date).toLocaleDateString("nl-NL") : "—"}</TableCell>
                          <TableCell className="text-right font-mono">{formatCurrency(inv.amount_incl)}</TableCell>
                          <TableCell className="text-right">
                            {(() => {
                              const total = getInvoiceTotalAmount(inv);
                              const remaining = getInvoiceRemainingAmount(inv);
                              if (remaining === 0 || inv.status === "betaald") {
                                return <span className="font-mono text-sm text-green-600">€0,00</span>;
                              }
                              if (total != null && remaining != null && remaining < total) {
                                return (
                                  <div>
                                    <Badge variant="secondary" className="text-[10px] mb-0.5">Deelbetaling</Badge>
                                    <div className="font-mono text-sm text-amber-600">{formatCurrency(remaining)}</div>
                                  </div>
                                );
                              }
                              const openstaand = remaining ?? total;
                              if (openstaand != null) {
                                return <span className="font-mono text-sm text-amber-600">{formatCurrency(openstaand)}</span>;
                              }
                              return <span className="text-muted-foreground text-sm">—</span>;
                            })()}
                          </TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground">{formatCurrency(inv.btw_amount)}</TableCell>
                          <TableCell>
                            <Badge variant={sc.variant} className="gap-1">
                              <sc.icon className="h-3 w-3" />{sc.label}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              {allocationsByInvoiceId.has(inv.id) && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => { e.stopPropagation(); setAfletteringInvoice(inv); }}>
                                        <Landmark className="h-4 w-4" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Bekijk aflettering</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => { e.stopPropagation(); setEditInvoice(inv); setEditOpen(true); }}>
                                <Eye className="h-4 w-4" />
                              </Button>
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                    className={`h-8 w-8 text-muted-foreground ${hasExportWarning ? "hover:text-amber-600" : "hover:text-destructive"}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDeleteTarget(inv);
                                    }}
                                    aria-label={hasExportWarning ? "Verwijderen met extra waarschuwing: factuur is geëxporteerd" : "Verwijderen"}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    {hasExportWarning
                                      ? "Geëxporteerd: verwijderen met extra waarschuwing"
                                      : "Verwijderen"}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <SalesInvoiceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        clients={clients?.map(c => ({ id: c.id, name: c.name, btw_vrijgesteld: c.btw_vrijgesteld })) ?? []}
        onSave={handleManualSave}
      />

      <SalesInvoiceEditDialog
        invoice={editInvoice}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSave={async (id, updates) => {
          try {
            await updateInvoice.mutateAsync({ id, ...updates } as any);
            toast({ title: "Factuur opgeslagen" });
          } catch (e: any) {
            toast({ title: "Opslaan mislukt", description: e.message, variant: "destructive" });
            throw e;
          }
        }}
        onApprove={async (id, updates) => {
          try {
            await updateInvoice.mutateAsync({ id, ...updates } as any);
            toast({ title: "Factuur goedgekeurd" });
          } catch (e: any) {
            toast({ title: "Goedkeuren mislukt", description: e.message, variant: "destructive" });
            throw e;
          }
        }}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteHasExportWarning ? "Geëxporteerde verkoopfactuur verwijderen?" : "Verkoopfactuur verwijderen"}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                {!deleteHasExportWarning ? (
                  <p>Weet je zeker dat je deze verkoopfactuur wilt verwijderen? Dit kan niet ongedaan worden gemaakt.</p>
                ) : null}
                {deleteTarget && (
                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-foreground">
                    <div><span className="font-medium">Factuurnummer:</span> {deleteTarget.invoice_number || "—"}</div>
                    <div><span className="font-medium">Klant:</span> {deleteTarget.customer_name || "—"}</div>
                    <div><span className="font-medium">Bedrag:</span> {formatCurrency(deleteTarget.amount_incl)}</div>
                  </div>
                )}
                {deleteHasExportWarning ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                    <p className="text-destructive">
                      Deze verkoopfactuur is al geëxporteerd. Als je deze upload verwijdert, wordt alleen het record in BoekAssist verwijderd. Een eerdere export of externe boekhouding wordt niet automatisch aangepast. Verwijder alleen als dit een verkeerde upload was of als je de gevolgen begrijpt.
                    </p>
                  </div>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteInvoice.isPending}>Annuleren</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteInvoice.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async (e) => {
                e.preventDefault();
                if (!deleteTarget) return;
                const wasExportedInvoice = deleteTarget.status === "geexporteerd";
                try {
                  await deleteInvoice.mutateAsync(deleteTarget.id);
                  toast(
                    wasExportedInvoice
                      ? {
                          title: "Verkoopfactuur verwijderd uit BoekAssist",
                          description: "Let op: eerdere exports of externe boekhouding zijn niet automatisch aangepast.",
                        }
                      : {
                          title: "Verkoopfactuur verwijderd",
                          description: "Alleen de upload/registratie in BoekAssist is verwijderd.",
                        }
                  );
                  if (editInvoice?.id === deleteTarget.id) {
                    setEditInvoice(null);
                    setEditOpen(false);
                  }
                  if (afletteringInvoice?.id === deleteTarget.id) {
                    setAfletteringInvoice(null);
                    setBankSearchQuery("");
                  }
                  setDeleteTarget(null);
                } catch (err: any) {
                  toast({ title: "Verwijderen mislukt", description: err?.message, variant: "destructive" });
                }
              }}
            >
              {deleteHasExportWarning ? "Toch verwijderen" : "Verwijderen"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {afletteringInvoice && (() => {
        const inv = afletteringInvoice;
        const allocations = allocationsByInvoiceId.get(inv.id) ?? [];
        const totalAllocated = allocations.reduce((s, a) => s + a.amount, 0);
        const invoiceTotal = getInvoiceTotalAmount(inv) ?? 0;
        const openRemaining = getInvoiceRemainingAmount(inv) ?? Math.max(0, invoiceTotal - totalAllocated);
        const candidates = scoreSalesCandidates(
          allBankTransactions ?? [], allAllocations ?? [],
          inv.id, inv.invoice_number, openRemaining, inv.customer_name, inv.invoice_date, bankSearchQuery,
        );
        return (
          <Dialog open={!!afletteringInvoice} onOpenChange={(v) => { if (!v) { setAfletteringInvoice(null); setBankSearchQuery(""); } }}>
            <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
              <DialogHeader className="shrink-0">
                <DialogTitle>Aflettering factuur {inv.invoice_number}</DialogTitle>
                <DialogDescription>{inv.customer_name}</DialogDescription>
              </DialogHeader>
              <div className="min-h-0 flex-1 overflow-y-auto pr-1 space-y-4">
                <div className="rounded-lg border bg-muted/50 p-4 space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Totaalbedrag factuur</span>
                    <span className="font-mono font-medium">{formatCurrency(invoiceTotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Totaal gealloceerd</span>
                    <span className="font-mono font-medium text-green-700 dark:text-green-400">{formatCurrency(totalAllocated)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Openstaand</span>
                    <span className={`font-mono font-medium ${openRemaining > 0.005 ? "text-amber-700 dark:text-amber-400" : "text-green-700 dark:text-green-400"}`}>
                      {formatCurrency(openRemaining)}
                    </span>
                  </div>
                </div>

                {allocations.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Geen afletterings gevonden.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Datum</TableHead>
                        <TableHead>Omschrijving</TableHead>
                        <TableHead className="text-right">Banktransactie</TableHead>
                        <TableHead className="text-right">Gealloceerd</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {allocations.map((alloc) => {
                        const tx = bankTransactionById.get(alloc.bank_transaction_id);
                        return (
                          <TableRow key={alloc.id}>
                            <TableCell className="text-sm whitespace-nowrap">
                              {tx ? new Date(tx.transaction_date).toLocaleDateString("nl-NL") : "—"}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate">
                              {tx ? getDisplayDescription(tx.description) : <span className="italic">Banktransactie niet gevonden</span>}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {tx ? formatCurrency(tx.amount) : "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm font-medium">
                              {formatCurrency(alloc.amount)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}

                <Separator />

                <div>
                  <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
                    <Search className="h-3.5 w-3.5" />Bankbetaling zoeken
                  </h3>
                  <Input
                    placeholder="Zoek op datum, omschrijving, bedrag of tegenpartij"
                    value={bankSearchQuery}
                    onChange={e => setBankSearchQuery(e.target.value)}
                    className="mb-3"
                  />
                  {candidates.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-3">
                      {bankSearchQuery ? "Geen resultaten gevonden." : "Geen kandidaat-transacties beschikbaar."}
                    </p>
                  ) : candidates.map((c) => (
                    <div key={c.tx.id} className="rounded-md border px-3 py-2 mb-2 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-mono text-xs text-muted-foreground">
                            {c.tx.transaction_date ? new Date(c.tx.transaction_date).toLocaleDateString("nl-NL") : "—"}
                          </div>
                          <div className="truncate font-medium">{getDisplayDescription(c.tx.description)}</div>
                          {c.reasons.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {c.reasons.map(r => <Badge key={r} variant="secondary" className="text-[10px] px-1.5 py-0">{r}</Badge>)}
                            </div>
                          )}
                        </div>
                        <div className="text-right shrink-0 text-xs font-mono">
                          <div className="text-muted-foreground">{formatCurrency(Math.abs(c.tx.amount))}</div>
                          {c.bankAllocated > 0 && <div className="text-amber-600">−{formatCurrency(c.bankAllocated)}</div>}
                          <div className="font-semibold">{formatCurrency(c.bankUnallocated)}</div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-2 pt-2 border-t">
                        <span className="text-xs text-muted-foreground">
                          Kan koppelen: <span className="font-mono font-medium">{formatCurrency(c.suggestedAmount)}</span>
                        </span>
                        <Button variant="outline" size="sm" className="h-7 text-xs"
                          onClick={() => { setLinkTarget(c); setLinkAmount(c.suggestedAmount.toFixed(2)); }}>
                          Koppel
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </DialogContent>
          </Dialog>
        );
      })()}

      {linkTarget && (
        <Dialog open={!!linkTarget} onOpenChange={(o) => !o && setLinkTarget(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Koppeling bevestigen</DialogTitle>
              <DialogDescription>
                {linkTarget.tx.transaction_date ? new Date(linkTarget.tx.transaction_date).toLocaleDateString("nl-NL") : "—"}{" "}
                — {getDisplayDescription(linkTarget.tx.description)}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="text-sm flex justify-between text-muted-foreground">
                <span>Beschikbaar bankbedrag</span>
                <span className="font-mono font-medium text-foreground">{formatCurrency(linkTarget.bankUnallocated)}</span>
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">Bedrag koppelen (€)</label>
                <Input type="number" min="0.01" step="0.01" value={linkAmount} onChange={e => setLinkAmount(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setLinkTarget(null)}>Annuleren</Button>
              <Button onClick={handleSalesLink}
                disabled={upsertAllocation.isPending || updateInvoice.isPending || updateBankTx.isPending}>
                {(upsertAllocation.isPending || updateInvoice.isPending || updateBankTx.isPending)
                  ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Koppelen
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
