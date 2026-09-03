import { useState, useCallback, useRef, useMemo, useEffect } from "react";
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
import { Upload, FileText, Download, CheckCircle2, Clock, Loader2, ArrowUp, ArrowDown, Search, Trash2, Landmark, Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { PurchaseInvoiceCreateDialog } from "@/components/PurchaseInvoiceCreateDialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  usePaginatedPurchaseInvoices,
  usePurchaseInvoiceDuplicates,
  useResetPageOnChange,
  useUpdatePurchaseInvoice,
  useDeletePurchaseInvoice,
  fetchAllExportablePurchaseInvoices,
  markPurchaseInvoicesExported,
  buildYearOptions,
  PURCHASE_INVOICES_PAGE_SIZE,
  type PurchaseInvoiceYearFilter,
} from "@/hooks/usePurchaseInvoices";
import { useVraagposten } from "@/hooks/useVraagposten";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { exportPurchaseInvoicesCSV } from "@/lib/snelstart-export";
import { useClients } from "@/hooks/useClients";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useQueryClient } from "@tanstack/react-query";
import { InvoiceNumberCopyButton } from "@/components/InvoiceNumberCopyButton";
import type { Tables } from "@/integrations/supabase/types";
import { getDocumentRouteLabel, DOCUMENT_ROUTE_OPTIONS } from "@/lib/document-route";
import { getInvoiceRemainingAmount, getInvoiceTotalAmount } from "@/lib/invoice-balances";
import { useBankTransactionAllocations, useUpsertBankTransactionAllocation, type BankTransactionAllocation } from "@/hooks/useBankTransactionAllocations";
import { useBankTransactions, useUpdateBankTransaction } from "@/hooks/useBankTransactions";
import { getDisplayDescription } from "@/lib/mt940-description-parser";
import { useNavigate } from "react-router-dom";
import { FilterChip } from "@/components/FilterChip";

const statusConfig = {
  te_controleren: { label: "Te controleren", icon: Clock, variant: "secondary" as const },
  gecontroleerd: { label: "Gecontroleerd", icon: CheckCircle2, variant: "default" as const },
  betaald: { label: "Betaald", icon: CheckCircle2, variant: "default" as const },
  geexporteerd: { label: "Geëxporteerd", icon: Download, variant: "outline" as const },
};

const WORKFLOW_STATUS_CHIPS = [
  { value: "te_controleren", label: "Te controleren" },
  { value: "gecontroleerd", label: "Gecontroleerd" },
  { value: "betaald", label: "Betaald" },
  { value: "geexporteerd", label: "Geëxporteerd" },
] as const;

const formatCurrency = (amount: number | null) =>
  amount != null ? new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount) : "—";

function getVraagpostBadgeProps(status: string) {
  switch (status) {
    case "opgelost":
      return {
        label: "Vraagpost opgelost",
        variant: "outline" as const,
        className: "text-xs w-fit border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200",
      };
    case "genegeerd":
      return {
        label: "Vraagpost genegeerd",
        variant: "secondary" as const,
        className: "text-xs w-fit",
      };
    default:
      return {
        label: "Vraagpost open",
        variant: "outline" as const,
        className: "text-xs w-fit border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
      };
  }
}

function getPurchaseInvoiceDisplayStatus(inv: { status: string | null; remaining_amount?: number | null; amount_incl?: number | null; amount_excl?: number | null }): string {
  const remaining = getInvoiceRemainingAmount(inv as any);
  if (remaining === 0) return "betaald";
  const total = getInvoiceTotalAmount(inv as any);
  if (total != null && remaining != null && remaining < total) return "deelbetaling";
  return inv.status || "";
}

function calcOcrScore(inv: Tables<"purchase_invoices">): number {
  const isPresent = (v: string | null | undefined) => {
    if (!v) return false;
    const s = v.trim();
    return !!s && s.toLowerCase() !== "onbekend";
  };
  const isNum = (v: number | null | undefined) => v != null && isFinite(v);
  return [
    isPresent(inv.supplier),
    isPresent(inv.invoice_number),
    isPresent(inv.invoice_date),
    isNum(inv.amount_incl),
    isNum(inv.btw_percentage),
    isPresent(inv.supplier_btw_number),
  ].filter(Boolean).length;
}

// "status" is not sortable: the table shows a derived payment status that
// differs from the stored workflow status a server sort would use.
type SortField = "supplier" | "invoice_number" | "date" | "amount" | "btw";
type SortDir = "asc" | "desc";

import { useClientContext } from "@/hooks/useClientContext";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";

type PurchaseTxCandidate = {
  tx: Tables<"bank_transactions">;
  bankAllocated: number;
  bankUnallocated: number;
  suggestedAmount: number;
  score: number;
  reasons: string[];
};

function scorePurchaseCandidates(
  transactions: Tables<"bank_transactions">[],
  allAllocations: BankTransactionAllocation[],
  invoiceId: string,
  invoiceNumber: string | null,
  invoiceOpen: number,
  supplierName: string | null,
  invoiceDate: string | null,
  searchQ: string,
): PurchaseTxCandidate[] {
  const allocByTxId = new Map<string, number>();
  for (const a of allAllocations) {
    allocByTxId.set(a.bank_transaction_id, (allocByTxId.get(a.bank_transaction_id) ?? 0) + a.amount);
  }
  const linkedTxIds = new Set(
    allAllocations.filter(a => a.invoice_id === invoiceId).map(a => a.bank_transaction_id)
  );
  const q = searchQ.trim().toLowerCase();
  const results: PurchaseTxCandidate[] = [];
  for (const tx of transactions) {
    if (tx.amount >= 0) continue;
    if (linkedTxIds.has(tx.id)) continue;
    const bankAllocated = allocByTxId.get(tx.id) ?? 0;
    const bankUnallocated = Math.abs(tx.amount) - bankAllocated;
    if (bankUnallocated < 0.01) continue;
    const suggestedAmount = Math.min(invoiceOpen, bankUnallocated);
    const displayDesc = getDisplayDescription(tx.description, { counterAccount: tx.counter_account, reference: tx.reference });
    const rawDesc = tx.description ?? "";
    let score = 0;
    const reasons: string[] = [];
    if (Math.abs(bankUnallocated - invoiceOpen) < 0.01) { score += 50; reasons.push("Exact bedrag"); }
    if (invoiceNumber) {
      const n = invoiceNumber.toLowerCase();
      if (rawDesc.toLowerCase().includes(n) || displayDesc.toLowerCase().includes(n)) { score += 25; reasons.push("Factuurnummer gevonden"); }
    }
    if (supplierName) {
      const parts = supplierName.toLowerCase().split(/\s+/).filter(p => p.length > 3);
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

export default function Facturen() {
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const navigate = useNavigate();
  const [clientFilter, setClientFilter] = useState(selectedClientId);
  const [uploadClientId, setUploadClientId] = useState<string>(
    selectedClientId !== "all" ? selectedClientId : ""
  );
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [routeFilter, setRouteFilter] = useState("all");
  // Year filter (invoice_date based). Default "all" keeps existing behaviour.
  const [yearFilter, setYearFilter] = useState<PurchaseInvoiceYearFilter>("all");
  const yearOptions = useMemo(() => buildYearOptions(), []);
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const { toast } = useToast();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const orgEnabled = isReady && activeOrganizationId !== null;
  const { data: clients } = useClients(activeOrganizationId ?? undefined, orgEnabled);
  // Paginated, server-filtered list for the overview table.
  const {
    data: pageData,
    isLoading,
    isFetching: isListFetching,
    isError: isListError,
    refetch: refetchList,
  } = usePaginatedPurchaseInvoices({
    organizationId: activeOrganizationId ?? undefined,
    clientId: clientFilter !== "all" ? clientFilter : undefined,
    enabled: orgEnabled,
    page,
    search: debouncedSearch,
    status: workflowFilter,
    documentRoute: routeFilter,
    year: yearFilter,
    sortField,
    sortDir,
  });
  const pageInvoices = pageData?.invoices;
  const totalCount = pageData?.total ?? 0;
  const [exporting, setExporting] = useState(false);
  // Server-backed duplicate lookup for the invoice numbers on this page —
  // finds duplicates even when they live on another page.
  const { data: duplicateIds } = usePurchaseInvoiceDuplicates(
    pageInvoices,
    activeOrganizationId ?? undefined,
  );

  useResetPageOnChange(
    () => setPage(1),
    [debouncedSearch, workflowFilter, paymentFilter, routeFilter, yearFilter, sortField, sortDir, clientFilter, activeOrganizationId],
  );
  const { data: vraagposten } = useVraagposten({
    organizationId: activeOrganizationId ?? undefined,
    clientId: clientFilter !== "all" ? clientFilter : undefined,
    enabled: orgEnabled,
  });
  const updateInvoice = useUpdatePurchaseInvoice();
  const deleteInvoice = useDeletePurchaseInvoice();
  const [dragActive, setDragActive] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Tables<"purchase_invoices"> | null>(null);
  const deleteHasExportWarning = deleteTarget?.status === "geexporteerd";
  const [afletteringInvoice, setAfletteringInvoice] = useState<Tables<"purchase_invoices"> | null>(null);
  const [bankSearchQuery, setBankSearchQuery] = useState("");
  const [linkTarget, setLinkTarget] = useState<PurchaseTxCandidate | null>(null);
  const [linkAmount, setLinkAmount] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const upsertAllocation = useUpsertBankTransactionAllocation();
  const updateBankTx = useUpdateBankTransaction();

  const { data: allAllocations } = useBankTransactionAllocations({
    organizationId: activeOrganizationId ?? undefined,
    clientId: clientFilter !== "all" ? clientFilter : undefined,
    enabled: orgEnabled,
  });
  const { data: allBankTransactions } = useBankTransactions({
    organizationId: activeOrganizationId ?? undefined,
    clientId: clientFilter !== "all" ? clientFilter : undefined,
    enabled: orgEnabled,
  });

  const allocationsByInvoiceId = useMemo(() => {
    const m = new Map<string, NonNullable<typeof allAllocations>[number][]>();
    for (const a of allAllocations ?? []) {
      if (a.invoice_type !== "inkoop") continue;
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

  const vraagpostByPurchaseInvoiceId = useMemo(() => {
    const m = new Map<string, NonNullable<typeof vraagposten>[number]>();
    for (const vp of vraagposten ?? []) {
      if (vp.source_type !== "purchase_invoice" || !vp.source_id || m.has(vp.source_id)) continue;
      m.set(vp.source_id, vp);
    }
    return m;
  }, [vraagposten]);

  useEffect(() => {
    setClientFilter(selectedClientId);
    setUploadClientId(selectedClientId !== "all" ? selectedClientId : "");
  }, [selectedClientId]);

  const handlePurchaseLink = async () => {
    if (!afletteringInvoice || !linkTarget) return;
    const amount = parseFloat(linkAmount);
    const inv = afletteringInvoice;
    const { tx } = linkTarget;

    // 1. Duplicate check — abort if this (tx, invoice) pair is already allocated
    const alreadyLinked = (allAllocations ?? []).some(
      a => a.bank_transaction_id === tx.id && a.invoice_id === inv.id && a.invoice_type === "inkoop"
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
      await upsertAllocation.mutateAsync({ bank_transaction_id: tx.id, invoice_type: "inkoop", invoice_id: inv.id, client_id: inv.client_id, amount });
      const newRemaining = Math.max(0, invoiceOpen - amount);
      await updateInvoice.mutateAsync({ id: inv.id, remaining_amount: newRemaining });
      const bankUpdates: { id: string; match_status: string; matched_invoice_id?: string } = { id: tx.id, match_status: "gematcht" };
      if (!tx.matched_invoice_id) bankUpdates.matched_invoice_id = inv.id;
      await updateBankTx.mutateAsync(bankUpdates);
      setAfletteringInvoice({ ...inv, remaining_amount: newRemaining });
      setLinkTarget(null);
      setLinkAmount("");
      toast({ title: "Koppeling aangemaakt" });
    } catch (e: any) {
      toast({ title: "Koppelen mislukt", description: e.message, variant: "destructive" });
    }
  };

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

  // Search, workflow-status, route and sorting are applied server-side by
  // usePaginatedPurchaseInvoices; this is the current page of results.
  const searchFiltered = useMemo(() => pageInvoices ?? [], [pageInvoices]);

  // Payment state derives from remaining_amount vs total (a column-to-column
  // comparison PostgREST cannot filter on), so it stays client-side within the
  // current page. All other filters and sorting are applied server-side.
  const filteredSorted = useMemo(() => {
    if (paymentFilter === "all") return searchFiltered;
    return searchFiltered.filter(inv => {
      const ds = getPurchaseInvoiceDisplayStatus(inv);
      if (paymentFilter === "paid") return ds === "betaald";
      if (paymentFilter === "partial") return ds === "deelbetaling";
      return ds !== "betaald" && ds !== "deelbetaling";
    });
  }, [searchFiltered, paymentFilter]);

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
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-invoice`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
            body: formData,
          }
        );

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Onbekende fout" }));
          throw new Error(err.error || `HTTP ${response.status}`);
        }

        const result = await response.json();
        const ext = result.extracted;

        setUploadProgress(prev => [
          ...prev.slice(0, -1),
          `✅ ${file.name} → ${ext?.supplier || "Verwerkt"} ${ext?.amount_incl ? formatCurrency(ext.amount_incl) : ""}`,
        ]);
        successCount++;
      } catch (e: any) {
        setUploadProgress(prev => [
          ...prev.slice(0, -1),
          `❌ ${file.name}: ${e.message}`,
        ]);
        failCount++;
      }
    }

    setUploading(false);
    queryClient.invalidateQueries({ queryKey: ["purchase_invoices"] });
    if (failCount > 0 && successCount === 0) {
      toast({ title: "Verwerking mislukt", description: `${failCount} bestand(en) niet verwerkt.`, variant: "destructive" });
    } else if (failCount > 0) {
      toast({ title: "Gedeeltelijk verwerkt", description: `${successCount} gelukt, ${failCount} mislukt.`, variant: "destructive" });
    } else {
      toast({ title: "Verwerking voltooid", description: `${successCount} bestand(en) verwerkt.` });
    }
  }, [uploadClientId, session, toast, queryClient]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files);
    processFiles(files);
  }, [processFiles]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  }, [processFiles]);

  const getClientName = (clientId: string) => clients?.find((c) => c.id === clientId)?.name ?? "—";

  const handleExportSnelstart = async () => {
    if (exporting) return;
    if (!activeOrganizationId) {
      toast({ title: "Geen actieve organisatie", description: "Selecteer eerst een organisatie voordat je exporteert.", variant: "destructive" });
      return;
    }
    setExporting(true);
    try {
      const exportable = await fetchAllExportablePurchaseInvoices({
        organizationId: activeOrganizationId,
        clientId: clientFilter !== "all" ? clientFilter : undefined,
        year: yearFilter,
      });
      if (!exportable.length) { toast({ title: "Geen gecontroleerde of betaalde facturen om te exporteren", variant: "destructive" }); return; }
      const clientName = clientFilter !== "all" ? clients?.find(c => c.id === clientFilter)?.name : undefined;
      const ids = exportPurchaseInvoicesCSV(exportable, clientName, yearFilter === "all" ? undefined : yearFilter);
      try {
        await markPurchaseInvoicesExported({ organizationId: activeOrganizationId, invoiceIds: ids });
        queryClient.invalidateQueries({ queryKey: ["purchase_invoices"] });
        toast({ title: `${ids.length} facturen geëxporteerd voor Snelstart` });
      } catch (statusErr: any) {
        // CSV is already downloaded; earlier batches may be committed.
        queryClient.invalidateQueries({ queryKey: ["purchase_invoices"] });
        toast({
          title: "CSV gedownload, maar status bijwerken mislukt",
          description: `Mogelijk staan niet alle facturen op 'geëxporteerd'. Probeer opnieuw of controleer de lijst. (${statusErr?.message ?? "onbekende fout"})`,
          variant: "destructive",
        });
      }
    } catch (e: any) {
      toast({ title: "Export mislukt", description: e?.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      {/* Shell header shows "Inkoop"; keep h1 for a11y only */}
      <h1 className="sr-only">Inkoopfacturen</h1>

      {/* Compact action bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={clientFilter} onValueChange={(v) => { setClientFilter(v); setSelectedClientId(v); }}>
          <SelectTrigger className="w-48">
            <span className="truncate">
              {clientFilter === "all"
                ? "Alle klanten"
                : (clients?.find(c => c.id === clientFilter)?.name ?? "Klant")}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle klanten</SelectItem>
            {clients?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select
          value={String(yearFilter)}
          onValueChange={(v) => setYearFilter(v === "all" ? "all" : Number(v))}
        >
          <SelectTrigger className="w-32" aria-label="Jaar">
            <span className="truncate">{yearFilter === "all" ? "Alle jaren" : yearFilter}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle jaren</SelectItem>
            {yearOptions.map((y) => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button variant="outline" disabled={exporting} onClick={handleExportSnelstart}>
          {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}Export Snelstart
        </Button>
      </div>

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
                <Select value={uploadClientId} onValueChange={(v) => { setUploadClientId(v); setSelectedClientId(v); }}>
                  <SelectTrigger className="w-64"><SelectValue placeholder="Kies klant voor upload" /></SelectTrigger>
                  <SelectContent>
                    {clients?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div
                className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-colors ${
                  dragActive ? "border-primary bg-primary/5" : "border-border"
                } ${!uploadClientId ? "opacity-50 pointer-events-none" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                  {uploading ? (
                    <Loader2 className="h-8 w-8 text-primary animate-spin" />
                  ) : (
                    <Upload className="h-8 w-8 text-primary" />
                  )}
                </div>
                <h3 className="font-display text-lg font-semibold">
                  {uploading ? "Facturen worden verwerkt..." : "Sleep facturen hierheen"}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  PDF, JPG of PNG bestanden — AI herkent automatisch leverancier, bedragen en BTW
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <Button
                  className="mt-4"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || !uploadClientId}
                >
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
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="relative max-w-md flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Zoeken op leverancier, factuurnummer of grootboek..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />Nieuwe inkoopfactuur
              </Button>
            </div>
            {/* Workflow status (primary navigation — server-side filter) */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Workflow</span>
              <FilterChip label="Alle" active={workflowFilter === "all"}
                onClick={() => setWorkflowFilter("all")} />
              {WORKFLOW_STATUS_CHIPS.map(chip => (
                <FilterChip
                  key={chip.value}
                  label={chip.label}
                  active={workflowFilter === chip.value}
                  onClick={() => setWorkflowFilter(workflowFilter === chip.value ? "all" : chip.value)}
                />
              ))}
            </div>
            {/* Betaalstatus (client-side filter within current page) */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Betaalstatus</span>
              <FilterChip label="Alle" active={paymentFilter === "all"}
                onClick={() => setPaymentFilter("all")} />
              <FilterChip label="Openstaand" active={paymentFilter === "open"}
                onClick={() => setPaymentFilter(paymentFilter === "open" ? "all" : "open")}
                activeClassName="border-orange-400 bg-orange-50 text-orange-900 dark:bg-orange-950/40 dark:text-orange-200" />
              <FilterChip label="Deelbetaling" active={paymentFilter === "partial"}
                onClick={() => setPaymentFilter(paymentFilter === "partial" ? "all" : "partial")}
                activeClassName="border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" />
              <FilterChip label="Betaald" active={paymentFilter === "paid"}
                onClick={() => setPaymentFilter(paymentFilter === "paid" ? "all" : "paid")}
                activeClassName="border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200" />
            </div>
            {/* Documentroute */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Route</span>
              <FilterChip label="Alle" active={routeFilter === "all"}
                onClick={() => setRouteFilter("all")} />
              {DOCUMENT_ROUTE_OPTIONS.map(opt => (
                <FilterChip key={opt.value} label={opt.label} active={routeFilter === opt.value}
                  onClick={() => setRouteFilter(routeFilter === opt.value ? "all" : opt.value)} />
              ))}
            </div>
          </div>
          <Card>
            <CardContent className="overflow-x-auto p-6">
              {isLoading ? (
                <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : isListError ? (
                <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
                  <p className="text-sm text-destructive">Inkoopfacturen laden mislukt.</p>
                  <Button variant="outline" size="sm" onClick={() => refetchList()}>Opnieuw proberen</Button>
                </div>
              ) : !filteredSorted.length ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
                    <FileText className="h-8 w-8 text-primary" />
                  </div>
                  <h3 className="font-display text-lg font-semibold">
                    {searchQuery || workflowFilter !== "all" || paymentFilter !== "all" || routeFilter !== "all"
                      ? "Geen inkoopfacturen gevonden"
                      : "Nog geen inkoopfacturen"}
                  </h3>
                  <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                    {searchQuery || workflowFilter !== "all" || paymentFilter !== "all" || routeFilter !== "all"
                      ? "Pas je zoekterm of filters aan om meer resultaten te zien."
                      : "Upload je eerste inkoopfacturen om ze te controleren, verwerken en exporteren."}
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("supplier")}>Leverancier<SortIcon field="supplier" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("invoice_number")}>Factuurnummer<SortIcon field="invoice_number" /></TableHead>
                      <TableHead className="hidden sm:table-cell">Klant</TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("date")}>Datum<SortIcon field="date" /></TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("amount")}>Bedrag<SortIcon field="amount" /></TableHead>
                      <TableHead className="text-right">Openstaand</TableHead>
                      <TableHead className="text-right cursor-pointer select-none hidden md:table-cell" onClick={() => toggleSort("btw")}>BTW<SortIcon field="btw" /></TableHead>
                      <TableHead className="hidden md:table-cell">Grootboek</TableHead>
                      <TableHead className="hidden lg:table-cell">Route</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-20"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSorted.map((inv) => {
                      const sc = statusConfig[inv.status as keyof typeof statusConfig] || statusConfig.te_controleren;
                      const displayStatus = getPurchaseInvoiceDisplayStatus(inv);
                      const isPaid = displayStatus === "betaald";
                      const isPartiallyPaid = displayStatus === "deelbetaling";
                      const linkedVraagpost = vraagpostByPurchaseInvoiceId.get(inv.id);
                      const vraagpostBadge = linkedVraagpost ? getVraagpostBadgeProps(linkedVraagpost.status) : null;
                      return (
                        <TableRow key={inv.id} className="cursor-pointer hover:bg-muted/50" onClick={() => navigate(`/facturen/inkoop/${inv.id}`)}>
                          <TableCell className="font-medium">
                            <div className="flex flex-col gap-1">
                              <span>{inv.supplier}</span>
                              {linkedVraagpost && vraagpostBadge ? (
                                <button
                                  type="button"
                                  title={linkedVraagpost.titel ? `Vraagpost: ${linkedVraagpost.titel}` : undefined}
                                  className="w-fit rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    navigate(`/vraagposten?focus=${encodeURIComponent(linkedVraagpost.id)}`);
                                  }}
                                >
                                  <Badge variant={vraagpostBadge.variant} className={`${vraagpostBadge.className} cursor-pointer`}>
                                    {vraagpostBadge.label}
                                  </Badge>
                                </button>
                              ) : null}
                              {(() => {
                                const score = calcOcrScore(inv);
                                const colorClass =
                                  score >= 5
                                    ? "border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200"
                                    : score >= 3
                                    ? "border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                                    : "border-destructive/50 bg-destructive/10 text-destructive";
                                return (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className={`inline-flex w-fit cursor-default items-center rounded border px-1 py-0 text-[10px] font-normal ${colorClass}`}>
                                          {score}/6 herkend
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <p>Indicatie op basis van ingevulde herkende velden; geen AI-zekerheidsscore.</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                );
                              })()}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            <div className="flex items-center gap-2 flex-wrap">
                              {inv.invoice_number ? (
                                <>
                                  <span>{inv.invoice_number}</span>
                                  <InvoiceNumberCopyButton invoiceNumber={inv.invoice_number} />
                                </>
                              ) : (
                                <span>—</span>
                              )}
                              {duplicateIds?.has(inv.id) && (
                                <Badge variant="outline" className="border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 text-xs font-normal">
                                  Mogelijk dubbel
                                </Badge>
                              )}
                              {(inv as any).snelstart_package_downloaded_at && (
                                <Badge variant="outline" className="text-xs font-normal">
                                  Pakket gedownload{((inv as any).snelstart_package_download_count ?? 0) > 1 ? ` (${(inv as any).snelstart_package_download_count}×)` : ""}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground hidden sm:table-cell">{getClientName(inv.client_id)}</TableCell>
                          <TableCell>{inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString("nl-NL") : "—"}</TableCell>
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
                          <TableCell className="text-right font-mono text-muted-foreground hidden md:table-cell">{formatCurrency(inv.btw_amount)}</TableCell>
                          <TableCell className="text-sm hidden md:table-cell">{inv.ledger_account_text || "—"}</TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <Badge variant="outline" className="text-xs">
                              {getDocumentRouteLabel((inv as any).document_route)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-0.5 items-start">
                              {/* Workflow status badge */}
                              <Badge variant={sc.variant} className="gap-1">
                                <sc.icon className="h-3 w-3" />{sc.label}
                              </Badge>
                              {/* Payment badge — only when it adds information */}
                              {isPartiallyPaid && (
                                <Badge variant="secondary" className="gap-1 text-amber-700">
                                  <Clock className="h-3 w-3" />Deelbetaling
                                </Badge>
                              )}
                              {isPaid && inv.status !== "betaald" && (
                                <Badge variant="outline" className="gap-1 border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200">
                                  <CheckCircle2 className="h-3 w-3" />Betaald
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1">
                              {allocationsByInvoiceId.has(inv.id) && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 text-muted-foreground hover:text-primary"
                                        onClick={() => setAfletteringInvoice(inv)}
                                        aria-label="Aflettering bekijken"
                                      >
                                        <Landmark className="h-4 w-4" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Aflettering bekijken</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => setDeleteTarget(inv)}
                                aria-label="Verwijderen"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              {!isLoading && !isListError && totalCount > 0 && (
                <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t pt-4">
                  <span className="text-sm text-muted-foreground">
                    {(page - 1) * PURCHASE_INVOICES_PAGE_SIZE + 1}–{Math.min(page * PURCHASE_INVOICES_PAGE_SIZE, totalCount)} van {totalCount} facturen
                    {paymentFilter !== "all" ? " · betaalstatusfilter geldt binnen de huidige pagina" : ""}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === 1 || isListFetching}
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" />Vorige
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page * PURCHASE_INVOICES_PAGE_SIZE >= totalCount || isListFetching}
                      onClick={() => setPage(p => p + 1)}
                    >
                      Volgende<ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <PurchaseInvoiceCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        clients={clients ?? []}
        organizationId={activeOrganizationId}
        defaultClientId={clientFilter !== "all" ? clientFilter : undefined}
        onCreated={(inv) => {
          queryClient.invalidateQueries({ queryKey: ["purchase_invoices"] });
          navigate(`/facturen/inkoop/${inv.id}`);
        }}
      />


      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteHasExportWarning ? "Geëxporteerde inkoopfactuur verwijderen?" : "Inkoopfactuur verwijderen"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                {!deleteHasExportWarning ? (
                  <p>Weet je zeker dat je deze inkoopfactuur wilt verwijderen? Dit kan niet ongedaan worden gemaakt.</p>
                ) : null}
                {deleteTarget && (
                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-foreground">
                    <div><span className="font-medium">Leverancier:</span> {deleteTarget.supplier || "—"}</div>
                    <div><span className="font-medium">Factuurnummer:</span> {deleteTarget.invoice_number || "—"}</div>
                    <div><span className="font-medium">Bedrag:</span> {deleteTarget.amount_incl != null ? new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(deleteTarget.amount_incl) : "—"}</div>
                  </div>
                )}
                {deleteHasExportWarning ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                    <p className="text-destructive">
                      Deze inkoopfactuur is al geëxporteerd. Als je deze upload verwijdert, wordt alleen het record in BoekAssist verwijderd. Een eerdere export of externe boekhouding wordt niet automatisch aangepast. Verwijder alleen als dit een verkeerde upload was of als je de gevolgen begrijpt.
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
                const wasExported = deleteTarget.status === "geexporteerd";
                try {
                  await deleteInvoice.mutateAsync(deleteTarget.id);
                  toast(
                    wasExported
                      ? {
                          title: "Inkoopfactuur verwijderd uit BoekAssist",
                          description: "Let op: eerdere exports of externe boekhouding zijn niet automatisch aangepast.",
                        }
                      : {
                          title: "Inkoopfactuur verwijderd",
                          description: "Alleen de upload/registratie in BoekAssist is verwijderd.",
                        }
                  );
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
        const total = getInvoiceTotalAmount(inv);
        const allocated = allocations.reduce((sum, a) => sum + a.amount, 0);
        const remaining = getInvoiceRemainingAmount(inv);
        const open = remaining ?? (total != null ? Math.max(0, total - allocated) : null);
        const invoiceOpen = open ?? 0;
        const candidates = scorePurchaseCandidates(
          allBankTransactions ?? [], allAllocations ?? [],
          inv.id, inv.invoice_number, invoiceOpen, inv.supplier, inv.invoice_date, bankSearchQuery,
        );
        return (
          <Dialog open={!!afletteringInvoice} onOpenChange={(o) => { if (!o) { setAfletteringInvoice(null); setBankSearchQuery(""); } }}>
            <DialogContent className="max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
              <DialogHeader className="shrink-0">
                <DialogTitle>Aflettering factuur {inv.invoice_number || "—"}</DialogTitle>
                <DialogDescription>{inv.supplier || "Onbekende leverancier"}</DialogDescription>
              </DialogHeader>
              <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-4">
                <div className="rounded-lg border bg-muted/40 p-4 grid grid-cols-3 gap-3 text-center text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Totaal</div>
                    <div className="font-mono font-semibold">{formatCurrency(total)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Vereffend</div>
                    <div className="font-mono font-semibold text-green-600">{formatCurrency(allocated)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Openstaand</div>
                    <div className={`font-mono font-semibold ${open === 0 ? "text-green-600" : "text-amber-600"}`}>
                      {formatCurrency(open)}
                    </div>
                  </div>
                </div>
                {allocations.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-2">Geen afletteringen gevonden.</p>
                ) : (
                  <div className="space-y-2">
                    {allocations.map((a) => {
                      const tx = bankTransactionById.get(a.bank_transaction_id);
                      return (
                        <div key={a.id} className="flex items-center justify-between gap-3 text-sm rounded-md border px-3 py-2">
                          <div className="min-w-0">
                            <div className="font-mono text-xs text-muted-foreground">
                              {tx?.transaction_date ? new Date(tx.transaction_date).toLocaleDateString("nl-NL") : "—"}
                            </div>
                            <div className="truncate">{tx ? getDisplayDescription(tx.description, { counterAccount: tx.counter_account, reference: tx.reference }) : "—"}</div>
                          </div>
                          <div className="font-mono font-medium shrink-0">{formatCurrency(a.amount)}</div>
                        </div>
                      );
                    })}
                  </div>
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
                          <div className="truncate font-medium">{getDisplayDescription(c.tx.description, { counterAccount: c.tx.counter_account, reference: c.tx.reference })}</div>
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
                — {getDisplayDescription(linkTarget.tx.description, { counterAccount: linkTarget.tx.counter_account, reference: linkTarget.tx.reference })}
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
              <Button onClick={handlePurchaseLink}
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
