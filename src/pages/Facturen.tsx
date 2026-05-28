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
import { Upload, FileText, Download, CheckCircle2, Clock, Loader2, ArrowUp, ArrowDown, Search, Trash2, Landmark } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { usePurchaseInvoices, useUpdatePurchaseInvoice, useDeletePurchaseInvoice } from "@/hooks/usePurchaseInvoices";
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
import { InvoiceEditDialog } from "@/components/InvoiceEditDialog";
import type { Tables } from "@/integrations/supabase/types";
import { getDocumentRouteLabel, DOCUMENT_ROUTE_OPTIONS } from "@/lib/document-route";
import { getInvoiceRemainingAmount, getInvoiceTotalAmount } from "@/lib/invoice-balances";
import { useBankTransactionAllocations, useUpsertBankTransactionAllocation, type BankTransactionAllocation } from "@/hooks/useBankTransactionAllocations";
import { useBankTransactions, useUpdateBankTransaction } from "@/hooks/useBankTransactions";
import { getDisplayDescription } from "@/lib/mt940-description-parser";
import { useNavigate } from "react-router-dom";

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

const statusConfig = {
  te_controleren: { label: "Te controleren", icon: Clock, variant: "secondary" as const },
  gecontroleerd: { label: "Gecontroleerd", icon: CheckCircle2, variant: "default" as const },
  betaald: { label: "Betaald", icon: CheckCircle2, variant: "default" as const },
  geexporteerd: { label: "Geëxporteerd", icon: Download, variant: "outline" as const },
};

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

type SortField = "supplier" | "invoice_number" | "date" | "amount" | "btw" | "status";
type SortDir = "asc" | "desc";

import { useClientContext } from "@/hooks/useClientContext";

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
    const displayDesc = getDisplayDescription(tx.description);
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
  const navigate = useNavigate();
  const [clientFilter, setClientFilter] = useState(selectedClientId);
  const [uploadClientId, setUploadClientId] = useState<string>(
    selectedClientId !== "all" ? selectedClientId : ""
  );
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [routeFilter, setRouteFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const { toast } = useToast();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: clients } = useClients();
  const { data: invoices, isLoading } = usePurchaseInvoices(clientFilter !== "all" ? clientFilter : undefined);
  const { data: vraagposten } = useVraagposten(clientFilter !== "all" ? clientFilter : undefined);
  const updateInvoice = useUpdatePurchaseInvoice();
  const deleteInvoice = useDeletePurchaseInvoice();
  const [dragActive, setDragActive] = useState(false);
  const [editInvoice, setEditInvoice] = useState<Tables<"purchase_invoices"> | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Tables<"purchase_invoices"> | null>(null);
  const [afletteringInvoice, setAfletteringInvoice] = useState<Tables<"purchase_invoices"> | null>(null);
  const [bankSearchQuery, setBankSearchQuery] = useState("");
  const [linkTarget, setLinkTarget] = useState<PurchaseTxCandidate | null>(null);
  const [linkAmount, setLinkAmount] = useState("");

  const upsertAllocation = useUpsertBankTransactionAllocation();
  const updateBankTx = useUpdateBankTransaction();

  const { data: allAllocations } = useBankTransactionAllocations(clientFilter !== "all" ? clientFilter : undefined);
  const { data: allBankTransactions } = useBankTransactions(clientFilter !== "all" ? clientFilter : undefined);

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

  const handleSaveInvoice = async (id: string, updates: Partial<Tables<"purchase_invoices">>) => {
    await updateInvoice.mutateAsync({ id, ...updates });
    toast({ title: "Factuur opgeslagen" });
  };

  const handleApproveInvoice = async (id: string, updates: Partial<Tables<"purchase_invoices">>) => {
    await updateInvoice.mutateAsync({ id, ...updates });
    toast({ title: "Factuur goedgekeurd" });
  };

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

  const searchFiltered = useMemo(() => {
    if (!invoices) return [];
    if (!searchQuery.trim()) return invoices;
    const q = searchQuery.toLowerCase();
    return invoices.filter(inv =>
      (inv.supplier || "").toLowerCase().includes(q) ||
      (inv.invoice_number || "").toLowerCase().includes(q) ||
      (inv.ledger_account_text || "").toLowerCase().includes(q)
    );
  }, [invoices, searchQuery]);

  // Each count-base applies all OTHER active filters so chip numbers show "what you'd see if you clicked this"
  const forPaymentCounts = useMemo(() => {
    let list = searchFiltered;
    if (workflowFilter !== "all") list = list.filter(inv => inv.status === workflowFilter);
    if (routeFilter !== "all") list = list.filter(inv => (inv as any).document_route === routeFilter);
    return list;
  }, [searchFiltered, workflowFilter, routeFilter]);

  const forWorkflowCounts = useMemo(() => {
    let list = searchFiltered;
    if (paymentFilter !== "all") list = list.filter(inv => {
      const ds = getPurchaseInvoiceDisplayStatus(inv);
      if (paymentFilter === "paid") return ds === "betaald";
      if (paymentFilter === "partial") return ds === "deelbetaling";
      return ds !== "betaald" && ds !== "deelbetaling";
    });
    if (routeFilter !== "all") list = list.filter(inv => (inv as any).document_route === routeFilter);
    return list;
  }, [searchFiltered, paymentFilter, routeFilter]);

  const forRouteCounts = useMemo(() => {
    let list = searchFiltered;
    if (workflowFilter !== "all") list = list.filter(inv => inv.status === workflowFilter);
    if (paymentFilter !== "all") list = list.filter(inv => {
      const ds = getPurchaseInvoiceDisplayStatus(inv);
      if (paymentFilter === "paid") return ds === "betaald";
      if (paymentFilter === "partial") return ds === "deelbetaling";
      return ds !== "betaald" && ds !== "deelbetaling";
    });
    return list;
  }, [searchFiltered, workflowFilter, paymentFilter]);

  const filteredSorted = useMemo(() => {
    let list = [...searchFiltered];
    if (workflowFilter !== "all") list = list.filter(inv => inv.status === workflowFilter);
    if (paymentFilter !== "all") list = list.filter(inv => {
      const ds = getPurchaseInvoiceDisplayStatus(inv);
      if (paymentFilter === "paid") return ds === "betaald";
      if (paymentFilter === "partial") return ds === "deelbetaling";
      return ds !== "betaald" && ds !== "deelbetaling";
    });
    if (routeFilter !== "all") list = list.filter(inv => (inv as any).document_route === routeFilter);
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "supplier": cmp = (a.supplier || "").localeCompare(b.supplier || ""); break;
        case "invoice_number": cmp = (a.invoice_number || "").localeCompare(b.invoice_number || ""); break;
        case "date": cmp = (a.invoice_date || "").localeCompare(b.invoice_date || ""); break;
        case "amount": cmp = (a.amount_incl ?? 0) - (b.amount_incl ?? 0); break;
        case "btw": cmp = (a.btw_amount ?? 0) - (b.btw_amount ?? 0); break;
        case "status": cmp = getPurchaseInvoiceDisplayStatus(a).localeCompare(getPurchaseInvoiceDisplayStatus(b)); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [searchFiltered, workflowFilter, paymentFilter, routeFilter, sortField, sortDir]);

  const duplicateIds = useMemo(() => {
    const result = new Set<string>();
    if (!invoices) return result;
    const normBtw = (s: string | null | undefined) =>
      (s || "").toUpperCase().replace(/[\s.\-]/g, "");
    const normName = (s: string | null | undefined) =>
      (s || "").toLowerCase().trim().replace(/\s+/g, " ");
    const groups = new Map<string, typeof invoices>();
    for (const inv of invoices) {
      const num = (inv.invoice_number || "").trim();
      if (!num || !inv.client_id) continue;
      const key = `${inv.client_id}|${num}`;
      if (!groups.has(key)) groups.set(key, [] as any);
      groups.get(key)!.push(inv);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        const a = group[i];
        const aBtw = normBtw(a.supplier_btw_number);
        const aName = normName(a.supplier);
        const aHasIdentity = !!a.leverancier_id || !!aBtw || !!aName;
        for (let j = i + 1; j < group.length; j++) {
          const b = group[j];
          const bBtw = normBtw(b.supplier_btw_number);
          const bName = normName(b.supplier);
          const bHasIdentity = !!b.leverancier_id || !!bBtw || !!bName;
          let match = false;
          if (a.leverancier_id && b.leverancier_id && a.leverancier_id === b.leverancier_id) match = true;
          else if (aBtw && bBtw && aBtw === bBtw) match = true;
          else if (aName && bName && aName === bName) match = true;
          else if (!aHasIdentity || !bHasIdentity) match = true;
          if (match) {
            result.add(a.id);
            result.add(b.id);
          }
        }
      }
    }
    return result;
  }, [invoices]);

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

  return (
    <>
      <PageHeader title="Inkoopfacturen" description="Upload, verwerk en exporteer inkoopfacturen">
        <Select value={clientFilter} onValueChange={(v) => { setClientFilter(v); setSelectedClientId(v); }}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Klant" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle klanten</SelectItem>
            {clients?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => {
          const exportable = invoices?.filter(i => i.status === "gecontroleerd" || i.status === "betaald") ?? [];
          if (!exportable.length) { toast({ title: "Geen gecontroleerde of betaalde facturen om te exporteren", variant: "destructive" }); return; }
          const clientName = clientFilter !== "all" ? clients?.find(c => c.id === clientFilter)?.name : undefined;
          const ids = exportPurchaseInvoicesCSV(exportable, clientName);
          ids.forEach(id => updateInvoice.mutateAsync({ id, status: "geexporteerd" }));
          toast({ title: `${ids.length} facturen geëxporteerd voor Snelstart` });
        }}>
          <Download className="mr-2 h-4 w-4" />Export Snelstart
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
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Zoeken op leverancier, factuurnummer of grootboek..."
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
                count={forPaymentCounts.filter(inv => { const ds = getPurchaseInvoiceDisplayStatus(inv); return ds !== "betaald" && ds !== "deelbetaling"; }).length}
                onClick={() => setPaymentFilter(paymentFilter === "open" ? "all" : "open")}
                activeClassName="border-orange-400 bg-orange-50 text-orange-900 dark:bg-orange-950/40 dark:text-orange-200" />
              <Chip label="Deelbetaling" active={paymentFilter === "partial"}
                count={forPaymentCounts.filter(inv => getPurchaseInvoiceDisplayStatus(inv) === "deelbetaling").length}
                onClick={() => setPaymentFilter(paymentFilter === "partial" ? "all" : "partial")}
                activeClassName="border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" />
              <Chip label="Betaald" active={paymentFilter === "paid"}
                count={forPaymentCounts.filter(inv => getPurchaseInvoiceDisplayStatus(inv) === "betaald").length}
                onClick={() => setPaymentFilter(paymentFilter === "paid" ? "all" : "paid")}
                activeClassName="border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200" />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Workflow</span>
              <Chip label="Alle" active={workflowFilter === "all"} count={forWorkflowCounts.length}
                onClick={() => setWorkflowFilter("all")} />
              <Chip label="Te controleren" active={workflowFilter === "te_controleren"}
                count={forWorkflowCounts.filter(inv => inv.status === "te_controleren").length}
                onClick={() => setWorkflowFilter(workflowFilter === "te_controleren" ? "all" : "te_controleren")} />
              <Chip label="Gecontroleerd" active={workflowFilter === "gecontroleerd"}
                count={forWorkflowCounts.filter(inv => inv.status === "gecontroleerd").length}
                onClick={() => setWorkflowFilter(workflowFilter === "gecontroleerd" ? "all" : "gecontroleerd")} />
              <Chip label="Geëxporteerd" active={workflowFilter === "geexporteerd"}
                count={forWorkflowCounts.filter(inv => inv.status === "geexporteerd").length}
                onClick={() => setWorkflowFilter(workflowFilter === "geexporteerd" ? "all" : "geexporteerd")} />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">Route</span>
              <Chip label="Alle" active={routeFilter === "all"} count={forRouteCounts.length}
                onClick={() => setRouteFilter("all")} />
              {DOCUMENT_ROUTE_OPTIONS.map(opt => (
                <Chip key={opt.value} label={opt.label} active={routeFilter === opt.value}
                  count={forRouteCounts.filter(inv => (inv as any).document_route === opt.value).length}
                  onClick={() => setRouteFilter(routeFilter === opt.value ? "all" : opt.value)} />
              ))}
            </div>
          </div>
          <Card>
            <CardContent className="p-6">
              {isLoading ? (
                <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : !filteredSorted.length ? (
                <div className="py-12 text-center text-muted-foreground">
                  {searchQuery ? "Geen facturen gevonden voor deze zoekopdracht." : "Nog geen facturen. Upload je eerste facturen via het Upload-tabblad."}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("supplier")}>Leverancier<SortIcon field="supplier" /></TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("invoice_number")}>Factuurnummer<SortIcon field="invoice_number" /></TableHead>
                      <TableHead>Klant</TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("date")}>Datum<SortIcon field="date" /></TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("amount")}>Bedrag<SortIcon field="amount" /></TableHead>
                      <TableHead className="text-right">Openstaand</TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("btw")}>BTW<SortIcon field="btw" /></TableHead>
                      <TableHead>Grootboek</TableHead>
                      <TableHead>Route</TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("status")}>Status<SortIcon field="status" /></TableHead>
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
                        <TableRow key={inv.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setEditInvoice(inv)}>
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
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span>{inv.invoice_number || "—"}</span>
                              {duplicateIds.has(inv.id) && (
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
                          <TableCell className="text-sm text-muted-foreground">{getClientName(inv.client_id)}</TableCell>
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
                          <TableCell className="text-right font-mono text-muted-foreground">{formatCurrency(inv.btw_amount)}</TableCell>
                          <TableCell className="text-sm">{inv.ledger_account_text || "—"}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {getDocumentRouteLabel((inv as any).document_route)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {isPaid ? (
                              <Badge variant="outline" className="gap-1 border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200">
                                <CheckCircle2 className="h-3 w-3" />Betaald
                              </Badge>
                            ) : isPartiallyPaid ? (
                              <Badge variant="secondary" className="gap-1 text-amber-700">
                                <Clock className="h-3 w-3" />Deelbetaling
                              </Badge>
                            ) : (
                              <Badge variant={sc.variant} className="gap-1">
                                <sc.icon className="h-3 w-3" />{sc.label}
                              </Badge>
                            )}
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
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <InvoiceEditDialog
        invoice={editInvoice}
        open={!!editInvoice}
        onOpenChange={(open) => !open && setEditInvoice(null)}
        onSave={handleSaveInvoice}
        onApprove={handleApproveInvoice}
        client={editInvoice ? clients?.find(c => c.id === editInvoice.client_id) ?? null : null}
        onOpenExisting={(id) => {
          const found = invoices?.find((inv) => inv.id === id);
          if (found) setEditInvoice(found);
        }}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Inkoopfactuur verwijderen</AlertDialogTitle>
            <AlertDialogDescription>
              Weet je zeker dat je deze inkoopfactuur wilt verwijderen? Dit kan niet ongedaan worden gemaakt.
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
                try {
                  await deleteInvoice.mutateAsync({ id: deleteTarget.id, file_path: deleteTarget.file_path });
                  toast({ title: "Inkoopfactuur verwijderd" });
                  if (editInvoice?.id === deleteTarget.id) setEditInvoice(null);
                  setDeleteTarget(null);
                } catch (err: any) {
                  toast({ title: "Verwijderen mislukt", description: err?.message, variant: "destructive" });
                }
              }}
            >
              Verwijderen
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
                            <div className="truncate">{tx ? getDisplayDescription(tx.description) : "—"}</div>
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
