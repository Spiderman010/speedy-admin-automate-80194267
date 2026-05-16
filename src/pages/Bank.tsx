import { useState, useCallback, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Upload, CheckCircle2, HelpCircle, Link2, Download, Info, Unlink, ArrowUp, ArrowDown, Search, Zap, RefreshCw, Plus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { parseMT940Description, getDisplayDescription } from "@/lib/mt940-description-parser";
import { useToast } from "@/hooks/use-toast";
import { useBankTransactions, useAddBankTransaction, useUpdateBankTransaction } from "@/hooks/useBankTransactions";
import { usePurchaseInvoices, useUpdatePurchaseInvoice } from "@/hooks/usePurchaseInvoices";
import { useSalesInvoices, useUpdateSalesInvoice } from "@/hooks/useSalesInvoices";
import { exportBankTransactionsCSV } from "@/lib/snelstart-export";
import { useClients } from "@/hooks/useClients";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useBookingTemplates } from "@/hooks/useBookingTemplates";
import { useCreateVraagpost } from "@/hooks/useVraagposten";
import { useVraagposten } from "@/hooks/useVraagposten";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { BankStatementUploadDialog, type MatchedTransaction } from "@/components/BankStatementUploadDialog";
import { BankMatchDialog, rankCandidates } from "@/components/BankMatchDialog";
import { VerwerkingsScherm } from "@/components/VerwerkingsScherm";
import type { Tables } from "@/integrations/supabase/types";
import { getInvoiceRemainingAmount, getInvoiceTotalAmount } from "@/lib/invoice-balances";
import { useBankTransactionAllocations, useUpsertBankTransactionAllocation, useDeleteAllocationsForTransaction } from "@/hooks/useBankTransactionAllocations";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

type SortField = "date" | "amount" | "description" | "status";
type SortDir = "asc" | "desc";

import { useClientContext } from "@/hooks/useClientContext";

const isOpenTransactionStatus = (matchStatus: string) =>
  matchStatus === "niet_gematcht" || matchStatus === "suggestie";

export default function Bank() {
  const [searchParams] = useSearchParams();
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const [clientFilter, setClientFilter] = useState(() => searchParams.get("client") ?? selectedClientId);
  const [statusFilter, setStatusFilter] = useState("all");
  const [vraagpostFilter, setVraagpostFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [matchTx, setMatchTx] = useState<Tables<"bank_transactions"> | null>(null);
  const [matchDialogMode, setMatchDialogMode] = useState<"primary" | "additional">("primary");
  const [additionalMaxAmount, setAdditionalMaxAmount] = useState<number | undefined>(undefined);
  const [verwerkingOpen, setVerwerkingOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLedger, setBulkLedger] = useState("");
  const [bulkLedgerId, setBulkLedgerId] = useState("");
  const [confirmUnlinkOpen, setConfirmUnlinkOpen] = useState(false);

  useEffect(() => {
    setClientFilter(selectedClientId);
  }, [selectedClientId]);

  const { toast } = useToast();

  const { data: clients } = useClients();
  const { data: grootboekrekeningen } = useActiveGrootboekrekeningen();
  const { data: bookingTemplates } = useBookingTemplates();
  const { data: transactions, isLoading, refetch } = useBankTransactions(clientFilter !== "all" ? clientFilter : undefined);
  const { data: invoices, refetch: refetchPurchase } = usePurchaseInvoices();
  const { data: salesInvs, refetch: refetchSales } = useSalesInvoices();
  const addTx = useAddBankTransaction();
  const updateTx = useUpdateBankTransaction();
  const updatePurchase = useUpdatePurchaseInvoice();
  const updateSales = useUpdateSalesInvoice();
  const createVraagpost = useCreateVraagpost();
  const { data: vraagposten } = useVraagposten(clientFilter !== "all" ? clientFilter : undefined);
  const upsertAllocation = useUpsertBankTransactionAllocation();
  const deleteAllocationsForTx = useDeleteAllocationsForTransaction();
  const { data: allAllocations } = useBankTransactionAllocations(clientFilter !== "all" ? clientFilter : undefined);

  const matched = transactions?.filter((t) => t.match_status === "gematcht").length ?? 0;

  // Compute which niet_gematcht transactions have candidate matches (= suggestions)
  const suggestionIds = useMemo(() => {
    const ids = new Set<string>();
    if (!transactions) return ids;

    for (const t of transactions) {
      if (t.match_status === "suggestie") {
        ids.add(t.id);
        continue;
      }

      if (!invoices || !salesInvs) continue;
      if (t.match_status !== "niet_gematcht") continue;
      const candidates = rankCandidates(
        t,
        invoices.filter(i => i.client_id === t.client_id),
        salesInvs.filter(i => i.client_id === t.client_id),
      );
      if (candidates.some(c => c.score > 0)) {
        ids.add(t.id);
      }
    }
    return ids;
  }, [transactions, invoices, salesInvs]);

  const suggested = suggestionIds.size;
  const unmatched = (transactions?.filter((t) => t.match_status === "niet_gematcht").length ?? 0)
    - (transactions?.filter((t) => t.match_status === "niet_gematcht" && suggestionIds.has(t.id)).length ?? 0);

  // Alle openstaande transacties (niet_gematcht + suggesties) voor de verwerkingsknop
  const openCount = transactions?.filter((t) => isOpenTransactionStatus(t.match_status)).length ?? 0;

  const grootboekrekeningById = useMemo(() => {
    const m = new Map<string, { nummer: number; omschrijving: string }>();
    for (const g of grootboekrekeningen ?? []) m.set(g.id, g);
    return m;
  }, [grootboekrekeningen]);

  const purchaseInvoiceById = useMemo(() => {
    const m = new Map<string, NonNullable<typeof invoices>[number]>();
    for (const i of invoices ?? []) m.set(i.id, i);
    return m;
  }, [invoices]);

  const salesInvoiceById = useMemo(() => {
    const m = new Map<string, NonNullable<typeof salesInvs>[number]>();
    for (const i of salesInvs ?? []) m.set(i.id, i);
    return m;
  }, [salesInvs]);

  const allocatedAmountByTxId = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of allAllocations ?? []) {
      m.set(a.bank_transaction_id, (m.get(a.bank_transaction_id) ?? 0) + a.amount);
    }
    return m;
  }, [allAllocations]);

  const vraagpostByBankTransactionId = useMemo(() => {
    const m = new Map<string, NonNullable<typeof vraagposten>[number]>();
    for (const vp of vraagposten ?? []) {
      if (vp.source_type === "bank_transaction" && vp.source_id) {
        m.set(vp.source_id, vp);
      }
    }
    return m;
  }, [vraagposten]);

  // Resolves invoice, checks client consistency, queries live allocation state, and upserts
  // one allocation row. Throws on any error so callers can surface it via toast.
  // explicitAllocationAmount — when provided (manual match dialog), bypasses the auto-cap
  // calculation and uses the user-supplied value, subject to hard safety caps.
  const upsertSingleAllocationForMatch = useCallback(async (
    tx: Tables<"bank_transactions">,
    invoiceId: string,
    explicitAllocationAmount?: number,
  ) => {
    const purchaseInv = invoices?.find(i => i.id === invoiceId);
    const salesInv = salesInvs?.find(i => i.id === invoiceId);
    const inv = purchaseInv ?? salesInv;
    if (!inv) throw new Error(`Factuur ${invoiceId} niet gevonden voor allocatie`);

    if (inv.client_id !== tx.client_id) {
      throw new Error("Factuur en transactie hebben verschillende klanten; allocatie geweigerd");
    }

    const invoiceType: "inkoop" | "verkoop" = purchaseInv ? "inkoop" : "verkoop";
    const txAmount = Math.abs(tx.amount);

    // Fresh query so that concurrent calls inside the same bulk/import loop each see
    // the rows written by the previous iteration — React query cache is not updated
    // synchronously between await calls in the same loop.
    const { data: liveRows, error: fetchError } = await supabase
      .from("bank_transaction_allocations")
      .select("bank_transaction_id, amount")
      .eq("invoice_id", invoiceId);
    if (fetchError) throw fetchError;

    const alreadyAllocated = (liveRows ?? [])
      .filter(r => r.bank_transaction_id !== tx.id)
      .reduce((sum, r) => sum + (r.amount as number), 0);
    const invoiceTotal = Math.abs(getInvoiceTotalAmount(inv) ?? txAmount);
    const allocationOpen = Math.max(0, invoiceTotal - alreadyAllocated);
    const autoAmount = Math.min(txAmount, allocationOpen);

    let allocationAmount: number;
    if (explicitAllocationAmount !== undefined) {
      if (explicitAllocationAmount <= 0)
        throw new Error("Allocatiebedrag moet groter zijn dan 0");
      if (explicitAllocationAmount > txAmount + 0.001)
        throw new Error("Allocatiebedrag is hoger dan het banktransactiebedrag");
      if (explicitAllocationAmount > allocationOpen + 0.001)
        throw new Error("Allocatiebedrag is hoger dan het openstaande factuurbedrag");
      allocationAmount = Math.min(explicitAllocationAmount, txAmount, allocationOpen);
    } else {
      allocationAmount = autoAmount;
      if (allocationAmount <= 0) return; // auto mode: nothing to allocate, skip silently
    }

    await upsertAllocation.mutateAsync({
      bank_transaction_id: tx.id,
      invoice_type: invoiceType,
      invoice_id: invoiceId,
      client_id: tx.client_id,
      amount: allocationAmount,
    });
  }, [invoices, salesInvs, upsertAllocation]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "date" ? "desc" : "asc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3 inline ml-1" /> : <ArrowDown className="h-3 w-3 inline ml-1" />;
  };

  const filteredSorted = useMemo(() => {
    if (!transactions) return [];
    let result = [...transactions];

    // Status filter
    if (statusFilter === "open") result = result.filter(t => t.match_status === "niet_gematcht" || t.match_status === "suggestie");
    else if (statusFilter === "gematcht") result = result.filter(t => t.match_status === "gematcht");
    else if (statusFilter === "handmatig") result = result.filter(t => t.match_status === "handmatig_geboekt");

    // Vraagpost filter
    if (vraagpostFilter !== "all") {
      result = result.filter(t => {
        const vp = vraagpostByBankTransactionId.get(t.id);
        if (vraagpostFilter === "without") return !vp;
        if (vraagpostFilter === "with") return !!vp;
        if (vraagpostFilter === "open") return !!vp && (vp.status === "open" || vp.status === "in_behandeling");
        if (vraagpostFilter === "opgelost") return !!vp && vp.status === "opgelost";
        if (vraagpostFilter === "genegeerd") return !!vp && vp.status === "genegeerd";
        return true;
      });
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(t => {
        const desc = (t.description || "").toLowerCase();
        const ref = (t.reference || "").toLowerCase();
        const counter = (t.counter_account || "").toLowerCase();
        const parsed = parseMT940Description(t.description);
        const name = (parsed.name || "").toLowerCase();
        return desc.includes(q) || ref.includes(q) || counter.includes(q) || name.includes(q);
      });
    }

    // Sort
    result.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      switch (sortField) {
        case "date": return dir * (new Date(a.transaction_date).getTime() - new Date(b.transaction_date).getTime());
        case "amount": return dir * (a.amount - b.amount);
        case "description": return dir * (a.description || "").localeCompare(b.description || "", "nl");
        case "status": return dir * a.match_status.localeCompare(b.match_status, "nl");
        default: return 0;
      }
    });

    return result;
  }, [transactions, statusFilter, vraagpostFilter, vraagpostByBankTransactionId, searchQuery, sortField, sortDir]);

  const openTransactions = filteredSorted.filter((t) => isOpenTransactionStatus(t.match_status));

  const handleConfirm = useCallback(async (id: string) => {
    try {
      const tx = transactions?.find(t => t.id === id);
      if (!tx) return;

      // If the transaction already carries a matched_invoice_id (set during import),
      // simply promote the status — do not lose the existing link.
      if (tx.matched_invoice_id) {
        await updateTx.mutateAsync({ id, match_status: "gematcht" });
        await upsertSingleAllocationForMatch(tx, tx.matched_invoice_id);
        toast({ title: "Transactie bevestigd" });
        return;
      }

      // No existing link — try to rank candidates and use the best scoring one.
      const candidates =
        invoices && salesInvs
          ? rankCandidates(
              tx,
              invoices.filter(i => i.client_id === tx.client_id),
              salesInvs.filter(i => i.client_id === tx.client_id),
            )
          : [];
      const best = candidates.find(c => c.score > 0);

      if (best) {
        const exactMatch =
          best.reasons.includes("Exact bedrag") ||
          best.reasons.includes("Bedrag ≈ gelijk (≤€0,50)");
        await updateTx.mutateAsync({
          id,
          match_status: "gematcht",
          matched_invoice_id: best.id,
          match_confidence:
            exactMatch && !best.isPartialPayment ? 100 : best.isPartialPayment ? 60 : 80,
        });
        if (exactMatch && !best.isPartialPayment) {
          if (best.type === "inkoop") {
            await updatePurchase.mutateAsync({ id: best.id, remaining_amount: 0 });
          } else {
            await updateSales.mutateAsync({ id: best.id, status: "betaald", remaining_amount: 0 });
          }
          await upsertSingleAllocationForMatch(tx, best.id);
          toast({ title: "Transactie bevestigd", description: "Factuur status → Betaald" });
        } else {
          await upsertSingleAllocationForMatch(tx, best.id);
          toast({ title: "Transactie bevestigd" });
        }
        return;
      }

      // No scoreable candidate — open BankMatchDialog so the user picks manually.
      setMatchTx(tx);
      toast({
        title: "Geen automatische factuurkoppeling",
        description: "Selecteer een factuur of boek handmatig.",
        variant: "destructive",
      });
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
  }, [transactions, invoices, salesInvs, updateTx, updatePurchase, updateSales, upsertSingleAllocationForMatch, toast]);

  const closeMatchDialog = useCallback(() => {
    setMatchTx(null);
    setMatchDialogMode("primary");
    setAdditionalMaxAmount(undefined);
  }, []);

  const handleMatch = useCallback(async (
    transactionId: string,
    invoiceId: string,
    invoiceType: "inkoop" | "verkoop",
    exactMatch: boolean,
    isPartialPayment: boolean,
    remainingAmount: number | null,
    allocationAmount?: number,
  ) => {
    try {
      const tx = transactions?.find(t => t.id === transactionId);

      // Additional mode: only write the new allocation row and update the invoice's remaining_amount.
      // Do NOT overwrite the tx record (matched_invoice_id is already set for the primary invoice).
      if (matchDialogMode === "additional") {
        if (tx && allocationAmount != null && allocationAmount > 0) {
          await upsertSingleAllocationForMatch(tx, invoiceId, allocationAmount);

          const purchaseInv = invoices?.find(i => i.id === invoiceId);
          const salesInv = salesInvs?.find(i => i.id === invoiceId);
          if (purchaseInv) {
            const currentRemaining = getInvoiceRemainingAmount(purchaseInv) ?? getInvoiceTotalAmount(purchaseInv) ?? 0;
            const newRemaining = Math.max(0, currentRemaining - allocationAmount);
            await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
          } else if (salesInv) {
            const currentRemaining = getInvoiceRemainingAmount(salesInv) ?? getInvoiceTotalAmount(salesInv) ?? 0;
            const newRemaining = Math.max(0, currentRemaining - allocationAmount);
            if (newRemaining < 0.01) {
              await updateSales.mutateAsync({ id: invoiceId, status: "betaald", remaining_amount: 0 });
            } else {
              await updateSales.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
            }
          }

          toast({ title: "Extra factuur gekoppeld" });
        }
        closeMatchDialog();
        return;
      }

      await updateTx.mutateAsync({
        id: transactionId,
        match_status: "gematcht",
        matched_invoice_id: invoiceId,
        match_confidence: exactMatch ? 100 : isPartialPayment ? 60 : 80,
      });

      if (exactMatch && !isPartialPayment) {
        if (invoiceType === "inkoop") {
          await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: 0 });
        } else {
          await updateSales.mutateAsync({ id: invoiceId, status: "betaald", remaining_amount: 0 });
        }
      } else if (isPartialPayment && remainingAmount != null) {
        if (invoiceType === "inkoop") {
          await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: remainingAmount });
        } else {
          await updateSales.mutateAsync({ id: invoiceId, remaining_amount: remainingAmount });
        }
      }

      if (tx) await upsertSingleAllocationForMatch(tx, invoiceId, allocationAmount);

      if (exactMatch && !isPartialPayment) {
        toast({ title: "Transactie gekoppeld", description: "Factuur status → Betaald" });
      } else if (isPartialPayment && remainingAmount != null) {
        toast({ title: "Deelbetaling gekoppeld", description: `Resterend: ${formatCurrency(remainingAmount)}` });
      } else {
        toast({ title: "Transactie gekoppeld" });
      }

      closeMatchDialog();
    } catch (e: any) {
      toast({ title: "Fout bij koppelen", description: e.message, variant: "destructive" });
    }
  }, [matchDialogMode, transactions, invoices, salesInvs, updateTx, updatePurchase, updateSales, upsertSingleAllocationForMatch, closeMatchDialog, toast]);

  const handleUnlink = useCallback(async (tx: Tables<"bank_transactions">) => {
    try {
      const invoiceId = tx.matched_invoice_id;
      const txAmount = Math.abs(tx.amount);

      await deleteAllocationsForTx.mutateAsync(tx.id);

      await updateTx.mutateAsync({
        id: tx.id,
        match_status: "niet_gematcht",
        matched_invoice_id: null,
        match_confidence: null,
      });

      if (invoiceId) {
        const purchaseInv = invoices?.find(i => i.id === invoiceId);
        const salesInv = salesInvs?.find(i => i.id === invoiceId);

        if (purchaseInv) {
          const totalAmount = getInvoiceTotalAmount(purchaseInv);
          if (totalAmount != null) {
            const currentRemaining = purchaseInv.remaining_amount ?? getInvoiceRemainingAmount(purchaseInv) ?? 0;
            const restoredRemaining = Math.min(totalAmount, currentRemaining + txAmount);
            await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: restoredRemaining });
          }
        } else if (salesInv) {
          const totalAmount = getInvoiceTotalAmount(salesInv);
          const currentRemaining = getInvoiceRemainingAmount(salesInv) ?? 0;
          if (salesInv.status === "betaald") {
            await updateSales.mutateAsync({ id: invoiceId, status: "gecontroleerd", remaining_amount: totalAmount });
          } else if (totalAmount != null) {
            await updateSales.mutateAsync({ id: invoiceId, remaining_amount: Math.min(totalAmount, currentRemaining + txAmount) });
          }
        }
      }

      await refetchPurchase();
      await refetchSales();
      toast({ title: "Koppeling verwijderd", description: "Transactie is weer open." });
    } catch (e: any) {
      toast({ title: "Fout bij ontkoppelen", description: e.message, variant: "destructive" });
    }
  }, [deleteAllocationsForTx, updateTx, updatePurchase, updateSales, invoices, salesInvs, refetchPurchase, refetchSales, toast]);

  const handleManualBook = useCallback(async (transactionId: string, ledgerAccount: string, description: string, grootboekrekeningId?: string) => {
    try {
      await updateTx.mutateAsync({
        id: transactionId,
        match_status: "handmatig_geboekt",
        description: description || undefined,
        grootboekrekening_id: grootboekrekeningId || undefined,
      });
      toast({ title: "Transactie geboekt", description: `Grootboek: ${ledgerAccount}` });
      closeMatchDialog();
    } catch (e: any) {
      toast({ title: "Fout bij boeken", description: e.message, variant: "destructive" });
    }
  }, [updateTx, closeMatchDialog, toast]);

  const handleMaakVraagpost = useCallback(async (tx: Tables<"bank_transactions">) => {
    try {
      const { data: existing } = await supabase
        .from("vraagposten")
        .select("id")
        .eq("source_type", "bank_transaction")
        .eq("source_id", tx.id)
        .maybeSingle();

      if (!existing) {
        const [y, m, d] = tx.transaction_date.split("-");
        const formattedDate = y && m && d ? `${d}-${m}-${y}` : tx.transaction_date;
        const formattedAmount = new Intl.NumberFormat("nl-NL", {
          style: "currency",
          currency: "EUR",
        }).format(tx.amount);

        await createVraagpost.mutateAsync({
          source_type: "bank_transaction",
          source_id: tx.id,
          client_id: tx.client_id,
          titel: tx.description || "Banktransactie zonder factuur",
          omschrijving: `${formattedDate} · ${formattedAmount}`,
          categorie: "bank_zonder_factuur",
        });
      }

      const account1605 = grootboekrekeningen?.find(a => a.nummer === 1605);
      await updateTx.mutateAsync({
        id: tx.id,
        match_status: "handmatig_geboekt",
        grootboekrekening_id: account1605?.id ?? undefined,
      });

      toast({ title: existing ? "Vraagpost bestaat al" : "Vraagpost aangemaakt" });
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
  }, [createVraagpost, updateTx, grootboekrekeningen, toast]);

  const handleBulkBook = useCallback(async () => {
    if (selectedIds.size === 0 || !bulkLedger) return;

    const ids = Array.from(selectedIds);
    let success = 0;
    const errors: string[] = [];

    for (const id of ids) {
      const tx = transactions?.find(t => t.id === id);
      if (!tx) continue;

      try {
        // Reverse invoice side effects before overwriting the link
        const invoiceId = tx.matched_invoice_id;
        if (invoiceId) {
          await deleteAllocationsForTx.mutateAsync(id);
          const txAmount = Math.abs(tx.amount);
          const purchaseInv = invoices?.find(i => i.id === invoiceId);
          const salesInv = salesInvs?.find(i => i.id === invoiceId);

          if (purchaseInv) {
            const totalAmount = getInvoiceTotalAmount(purchaseInv);
            if (totalAmount != null) {
              const currentRemaining = purchaseInv.remaining_amount ?? getInvoiceRemainingAmount(purchaseInv) ?? 0;
              const restoredRemaining = Math.min(totalAmount, currentRemaining + txAmount);
              await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: restoredRemaining });
            }
          } else if (salesInv) {
            const totalAmount = getInvoiceTotalAmount(salesInv);
            const currentRemaining = getInvoiceRemainingAmount(salesInv) ?? 0;
            if (salesInv.status === "betaald") {
              await updateSales.mutateAsync({ id: invoiceId, status: "gecontroleerd", remaining_amount: totalAmount });
            } else if (totalAmount != null) {
              await updateSales.mutateAsync({ id: invoiceId, remaining_amount: Math.min(totalAmount, currentRemaining + txAmount) });
            }
          }
        }

        await updateTx.mutateAsync({
          id,
          match_status: "handmatig_geboekt",
          grootboekrekening_id: bulkLedgerId || undefined,
          matched_invoice_id: null,
          match_confidence: null,
        });
        success++;
      } catch (e: any) {
        console.error("Bulk boeken error:", e);
        errors.push(e.message || "Onbekende fout");
      }
    }

    setSelectedIds(new Set());
    setBulkLedger("");
    setBulkLedgerId("");
    await refetch();
    await refetchPurchase();
    await refetchSales();

    if (success > 0) {
      toast({ title: `${success} transactie(s) geboekt naar ${bulkLedger}` });
    }
    if (errors.length > 0) {
      toast({ title: "Fout bij boeken", description: `${errors.length} transactie(s) mislukt: ${errors[0]}`, variant: "destructive" });
    }
  }, [selectedIds, bulkLedger, bulkLedgerId, transactions, invoices, salesInvs, deleteAllocationsForTx, updateTx, updatePurchase, updateSales, toast, refetch, refetchPurchase, refetchSales]);

  const handleBulkUnlink = useCallback(async () => {
    if (selectedIds.size === 0) return;

    const ids = Array.from(selectedIds);
    let success = 0;
    const errors: string[] = [];

    for (const id of ids) {
      const tx = transactions?.find(t => t.id === id);
      if (!tx) continue;

      try {
        const invoiceId = tx.matched_invoice_id;
        const txAmount = Math.abs(tx.amount);

        await deleteAllocationsForTx.mutateAsync(tx.id);

        await updateTx.mutateAsync({
          id: tx.id,
          match_status: "niet_gematcht",
          matched_invoice_id: null,
          match_confidence: null,
          grootboekrekening_id: null,
        });

        if (invoiceId) {
          const purchaseInv = invoices?.find(i => i.id === invoiceId);
          const salesInv = salesInvs?.find(i => i.id === invoiceId);

          if (purchaseInv) {
            const totalAmount = getInvoiceTotalAmount(purchaseInv);
            if (totalAmount != null) {
              const currentRemaining = purchaseInv.remaining_amount ?? getInvoiceRemainingAmount(purchaseInv) ?? 0;
              const restoredRemaining = Math.min(totalAmount, currentRemaining + txAmount);
              await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: restoredRemaining });
            }
          } else if (salesInv) {
            const totalAmount = getInvoiceTotalAmount(salesInv);
            const currentRemaining = getInvoiceRemainingAmount(salesInv) ?? 0;
            if (salesInv.status === "betaald") {
              await updateSales.mutateAsync({ id: invoiceId, status: "gecontroleerd", remaining_amount: totalAmount });
            } else if (totalAmount != null) {
              await updateSales.mutateAsync({ id: invoiceId, remaining_amount: Math.min(totalAmount, currentRemaining + txAmount) });
            }
          }
        }

        success++;
      } catch (e: any) {
        errors.push(e.message || "Onbekende fout");
      }
    }

    setSelectedIds(new Set());
    setConfirmUnlinkOpen(false);
    await refetch();
    await refetchPurchase();
    await refetchSales();

    if (success > 0) {
      toast({ title: `${success} transactie(s) ontkoppeld` });
    }
    if (errors.length > 0) {
      toast({ title: "Fout bij ontkoppelen", description: errors[0], variant: "destructive" });
    }
  }, [selectedIds, transactions, invoices, salesInvs, deleteAllocationsForTx, updateTx, updatePurchase, updateSales, toast, refetch, refetchPurchase, refetchSales]);

  const handleRepairAflettering = useCallback(async () => {
    if (selectedIds.size === 0 || !transactions) return;

    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Step 1: collect eligible tx ids — gematcht, has matched_invoice_id,
    // and the linked invoice still appears unreconciled (remaining ≈ total or null).
    // Group them by matched_invoice_id so each invoice is written only once.
    const groups = new Map<string, { invoiceId: string; txIds: string[] }>();

    for (const id of Array.from(selectedIds)) {
      const tx = transactions.find(t => t.id === id);
      if (!tx || tx.match_status !== "gematcht" || !tx.matched_invoice_id) continue;

      const inv =
        invoices?.find(i => i.id === tx.matched_invoice_id) ??
        salesInvs?.find(i => i.id === tx.matched_invoice_id);
      if (!inv) { skipped++; continue; }

      const totalAmount = getInvoiceTotalAmount(inv);
      if (totalAmount == null) { skipped++; continue; }

      // Only eligible when remaining_amount is null (never set) or ≈ total (never subtracted)
      const isUnreconciled =
        inv.remaining_amount == null ||
        Math.abs((inv.remaining_amount) - totalAmount) < 0.02;

      if (!isUnreconciled) { skipped++; continue; }

      const existing = groups.get(tx.matched_invoice_id);
      if (existing) {
        existing.txIds.push(id);
      } else {
        groups.set(tx.matched_invoice_id, { invoiceId: tx.matched_invoice_id, txIds: [id] });
      }
    }

    // Step 2: process each invoice group with a single write.
    for (const { invoiceId, txIds } of groups.values()) {
      const purchaseInv = invoices?.find(i => i.id === invoiceId);
      const salesInv = salesInvs?.find(i => i.id === invoiceId);
      const inv = purchaseInv ?? salesInv;
      if (!inv) { skipped += txIds.length; continue; }

      const totalAmount = getInvoiceTotalAmount(inv);
      if (totalAmount == null) { skipped += txIds.length; continue; }

      const startingRemaining = inv.remaining_amount ?? totalAmount;

      // Sum all selected payment amounts for this invoice in one pass
      const totalPayment = txIds.reduce((sum, id) => {
        const tx = transactions.find(t => t.id === id);
        return sum + (tx ? Math.abs(tx.amount) : 0);
      }, 0);

      const newRemaining = Math.max(0, startingRemaining - totalPayment);

      try {
        if (newRemaining < 0.02) {
          if (purchaseInv) {
            await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: 0 });
          } else {
            await updateSales.mutateAsync({ id: invoiceId, status: "betaald", remaining_amount: 0 });
          }
        } else {
          if (purchaseInv) {
            await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
          } else {
            await updateSales.mutateAsync({ id: invoiceId, remaining_amount: newRemaining });
          }
        }
        updated += txIds.length;
      } catch (e: any) {
        errors.push(e.message || "Onbekende fout");
        skipped += txIds.length;
      }
    }

    await refetchPurchase();
    await refetchSales();

    if (updated > 0) {
      toast({ title: `${updated} aflettering(en) bijgewerkt${skipped > 0 ? `, ${skipped} overgeslagen` : ""}` });
    } else if (skipped > 0) {
      toast({ title: `${skipped} transactie(s) overgeslagen (al afgeletterd of factuur niet gevonden)` });
    }
    if (errors.length > 0) {
      toast({ title: "Fout bij herberekening", description: errors[0], variant: "destructive" });
    }
  }, [selectedIds, transactions, invoices, salesInvs, updatePurchase, updateSales, toast, refetchPurchase, refetchSales]);

  const handleBulkConfirmSuggestions = useCallback(async () => {
    if (selectedIds.size === 0 || !transactions || !invoices || !salesInvs) return;

    let confirmed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const id of Array.from(selectedIds)) {
      const tx = transactions.find(t => t.id === id);
      if (!tx || !suggestionIds.has(tx.id)) {
        skipped++;
        continue;
      }

      const candidates = rankCandidates(
        tx,
        invoices.filter(i => i.client_id === tx.client_id),
        salesInvs.filter(i => i.client_id === tx.client_id),
      );
      const best = candidates.find(c => c.score > 0);
      if (!best) {
        skipped++;
        continue;
      }

      const exactMatch = best.reasons.includes("Exact bedrag") || best.reasons.includes("Bedrag ≈ gelijk (≤€0,50)");

      try {
        await updateTx.mutateAsync({
          id: tx.id,
          match_status: "gematcht",
          matched_invoice_id: best.id,
          match_confidence: exactMatch && !best.isPartialPayment ? 100 : best.isPartialPayment ? 60 : 80,
        });

        if (exactMatch && !best.isPartialPayment) {
          if (best.type === "inkoop") {
            await updatePurchase.mutateAsync({ id: best.id, remaining_amount: 0 });
          } else {
            await updateSales.mutateAsync({ id: best.id, status: "betaald", remaining_amount: 0 });
          }
        } else if (best.isPartialPayment && best.remainingAmount != null) {
          if (best.type === "inkoop") {
            await updatePurchase.mutateAsync({ id: best.id, remaining_amount: best.remainingAmount });
          } else {
            await updateSales.mutateAsync({ id: best.id, remaining_amount: best.remainingAmount });
          }
        }
        await upsertSingleAllocationForMatch(tx, best.id);
        confirmed++;
      } catch (e: any) {
        errors.push(e.message || "Onbekende fout");
      }
    }

    setSelectedIds(new Set());
    await refetch();
    await refetchPurchase();
    await refetchSales();

    if (confirmed > 0) {
      toast({ title: `${confirmed} suggestie(s) bevestigd` });
    }
    if (skipped > 0) {
      toast({ title: `${skipped} transactie(s) overgeslagen (geen suggestie)` });
    }
    if (errors.length > 0) {
      toast({ title: "Fout bij bevestigen", description: errors[0], variant: "destructive" });
    }
  }, [selectedIds, transactions, invoices, salesInvs, suggestionIds, updateTx, updatePurchase, updateSales, upsertSingleAllocationForMatch, toast, refetch, refetchPurchase, refetchSales]);

  const handleImport = useCallback(async (importClientId: string, txs: MatchedTransaction[]) => {
    let success = 0;
    let allocationErrors = 0;
    let firstAllocationError = "";
    for (const tx of txs) {
      try {
        const newTx = await addTx.mutateAsync({
          client_id: importClientId,
          transaction_date: tx.date,
          amount: tx.amount,
          description: tx.description,
          counter_account: tx.counterAccount,
          reference: tx.reference,
          match_status: tx.matchStatus,
          match_confidence: tx.matchConfidence,
          matched_invoice_id: tx.matchedInvoiceId,
          grootboekrekening_id: tx.grootboekrekeningId ?? undefined,
        });

        // Aflettering: update the linked purchase invoice after a confirmed match
        if (tx.matchedInvoiceId && tx.matchStatus === "gematcht") {
          const purchaseInv = invoices?.find(i => i.id === tx.matchedInvoiceId);
          if (purchaseInv) {
            const txAmount = Math.abs(tx.amount);
            const totalAmount = getInvoiceTotalAmount(purchaseInv);
            const remainingAmount = getInvoiceRemainingAmount(purchaseInv);
            const effectiveRemaining = remainingAmount ?? totalAmount ?? txAmount;
            const isExact = Math.abs(effectiveRemaining - txAmount) < 0.02;
            if (isExact) {
              await updatePurchase.mutateAsync({ id: purchaseInv.id, remaining_amount: 0 });
            } else if (totalAmount != null) {
              const newRemaining = Math.max(0, effectiveRemaining - txAmount);
              await updatePurchase.mutateAsync({ id: purchaseInv.id, remaining_amount: newRemaining });
            }
          }
          if (newTx) {
            try {
              await upsertSingleAllocationForMatch(newTx, tx.matchedInvoiceId);
            } catch (allocErr: any) {
              allocationErrors++;
              if (!firstAllocationError) firstAllocationError = allocErr?.message || "Onbekende fout";
              console.error("Allocation write failed during import:", allocErr);
            }
          }
        }

        success++;
      } catch (e: any) {
        console.error("Import error:", e);
      }
    }
    await refetchPurchase();
    if (allocationErrors > 0) {
      toast({
        title: `${success} van ${txs.length} transacties geïmporteerd, maar ${allocationErrors} allocatie(s) niet aangemaakt`,
        description: firstAllocationError,
        variant: "destructive",
      });
    } else {
      toast({ title: `${success} van ${txs.length} transacties geïmporteerd` });
    }
  }, [addTx, invoices, salesInvs, updatePurchase, upsertSingleAllocationForMatch, refetchPurchase, toast]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredSorted.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredSorted.map(t => t.id)));
    }
  };

  const handleRefreshMatching = useCallback(() => {
    refetch();
    refetchPurchase();
    refetchSales();
  }, [refetch, refetchPurchase, refetchSales]);

  return (
    <>
      <PageHeader title="Bankafschriften" description="Upload en match bankafschriften met facturen">
        <Select value={clientFilter} onValueChange={(v) => { setClientFilter(v); setSelectedClientId(v); }}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Klant" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle klanten</SelectItem>
            {clients?.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => {
          const matched_txs = transactions?.filter(t => t.match_status === "gematcht" || t.match_status === "handmatig_geboekt") ?? [];
          if (!matched_txs.length) { toast({ title: "Geen verwerkte transacties om te exporteren", variant: "destructive" }); return; }
          const clientName = clientFilter !== "all" ? clients?.find(c => c.id === clientFilter)?.name : undefined;
          exportBankTransactionsCSV(matched_txs, grootboekrekeningen ?? [], clientName);
          toast({ title: `${matched_txs.length} transacties geëxporteerd` });
        }}>
          <Download className="mr-2 h-4 w-4" />Export Snelstart
        </Button>
        <Button
          variant="default"
          onClick={() => setVerwerkingOpen(true)}
          disabled={openCount === 0}
        >
          <Zap className="mr-2 h-4 w-4" />
          Verwerken {openCount > 0 && `(${openCount})`}
        </Button>
        <Button onClick={() => setUploadOpen(true)}>
          <Upload className="mr-2 h-4 w-4" />Upload afschrift
        </Button>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-4 mb-6">
        <Card><CardContent className="flex items-center gap-3 p-4">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <div><p className="font-display text-xl font-bold">{matched}</p><p className="text-xs text-muted-foreground">Gematcht</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 p-4">
          <Link2 className="h-5 w-5 text-warning" />
          <div><p className="font-display text-xl font-bold">{suggested}</p><p className="text-xs text-muted-foreground">Suggesties</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 p-4">
          <Download className="h-5 w-5 text-muted-foreground" />
          <div><p className="font-display text-xl font-bold">{transactions?.filter(t => t.match_status === "handmatig_geboekt").length ?? 0}</p><p className="text-xs text-muted-foreground">Handmatig geboekt</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 p-4">
          <HelpCircle className="h-5 w-5 text-destructive" />
          <div><p className="font-display text-xl font-bold">{unmatched}</p><p className="text-xs text-muted-foreground">Niet gematcht</p></div>
        </CardContent></Card>
      </div>

      <div className="flex gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Zoeken op omschrijving, naam, referentie, tegenrekening..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle statussen</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="gematcht">Gematcht</SelectItem>
            <SelectItem value="handmatig">Handmatig geboekt</SelectItem>
          </SelectContent>
        </Select>
        <Select value={vraagpostFilter} onValueChange={setVraagpostFilter}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle vraagposten</SelectItem>
            <SelectItem value="with">Met vraagpost</SelectItem>
            <SelectItem value="open">Vraagpost open</SelectItem>
            <SelectItem value="opgelost">Vraagpost opgelost</SelectItem>
            <SelectItem value="genegeerd">Vraagpost genegeerd</SelectItem>
            <SelectItem value="without">Zonder vraagpost</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-6">
          {isLoading ? (
            <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : !filteredSorted.length ? (
            <div className="py-12 text-center text-muted-foreground">
              {transactions?.length ? "Geen transacties gevonden met deze filters." : "Nog geen transacties. Upload een bankafschrift om te beginnen."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={filteredSorted.length > 0 && selectedIds.size === filteredSorted.length}
                      onCheckedChange={toggleSelectAll}
                    />
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => handleSort("date")}>Datum<SortIcon field="date" /></TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => handleSort("description")}>Omschrijving<SortIcon field="description" /></TableHead>
                  <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("amount")}>Bedrag<SortIcon field="amount" /></TableHead>
                  <TableHead>Betrouwbaarheid</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => handleSort("status")}>Status<SortIcon field="status" /></TableHead>
                  <TableHead>Gekoppeld aan</TableHead>
                  <TableHead className="w-32"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSorted.map((t) => {
                  const isOpen = isOpenTransactionStatus(t.match_status);
                  const isSuggestion = suggestionIds.has(t.id);
                  const txAbsAmt = Math.abs(t.amount);
                  const allocatedForTx = allocatedAmountByTxId.get(t.id) ?? 0;
                  const unallocatedAmount = Math.max(0, txAbsAmt - allocatedForTx);
                  return (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(t.id)}
                          onCheckedChange={() => toggleSelect(t.id)}
                        />
                      </TableCell>
                      <TableCell>{new Date(t.transaction_date).toLocaleDateString("nl-NL")}</TableCell>
                      <TableCell className="max-w-xs">
                        <div className="flex items-center gap-1">
                          <span className="truncate">{getDisplayDescription(t.description)}</span>
                          {t.description && (() => {
                            const p = parseMT940Description(t.description);
                            return (p.name || p.iban || p.reference) ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="bottom" align="start" className="max-w-sm text-xs space-y-1">
                                    {p.name && <div><span className="text-muted-foreground">Naam:</span> {p.name}</div>}
                                    {p.iban && <div><span className="text-muted-foreground">Tegenrekening:</span> {p.iban}</div>}
                                    {p.reference && <div><span className="text-muted-foreground">Referentie:</span> {p.reference}</div>}
                                    <div className="pt-1 border-t text-muted-foreground break-all">{p.raw}</div>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : null;
                          })()}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={`font-mono ${t.amount < 0 ? "text-destructive" : "text-success"}`}>
                          {formatCurrency(t.amount)}
                        </span>
                        {t.matched_invoice_id && (() => {
                          const inv =
                            invoices?.find(i => i.id === t.matched_invoice_id) ??
                            salesInvs?.find(i => i.id === t.matched_invoice_id);
                          if (!inv) return null;
                          const total = getInvoiceTotalAmount(inv);
                          const remaining = getInvoiceRemainingAmount(inv);
                          if (total == null) return null;

                          const fullyPaid = remaining != null && Math.abs(remaining) < 0.01;
                          const isPartial = remaining != null && remaining > 0.01 && remaining < total - 0.01;
                          const notAfgeletterd = remaining != null && remaining >= total - 0.01 && !fullyPaid;
                          const paidAmount = remaining != null ? Math.max(0, total - remaining) : 0;

                          return (
                            <div className="mt-0.5 space-y-0.5">
                              {fullyPaid ? (
                                <p className="text-xs text-success">Volledig betaald</p>
                              ) : isPartial ? (
                                <>
                                  <p className="text-xs font-medium text-amber-600">Deelbetaling</p>
                                  <p className="text-xs text-muted-foreground">
                                    Betaald: {formatCurrency(paidAmount)}
                                  </p>
                                  <p className="text-xs text-warning font-medium">
                                    Openstaand: {formatCurrency(remaining)}
                                  </p>
                                </>
                              ) : notAfgeletterd ? (
                                <>
                                  <p className="text-xs font-medium text-destructive">Nog niet afgeletterd</p>
                                  <p className="text-xs text-muted-foreground">
                                    Betaald: {formatCurrency(0)}
                                  </p>
                                  <p className="text-xs text-warning font-medium">
                                    Openstaand: {formatCurrency(remaining ?? total)}
                                  </p>
                                </>
                              ) : (
                                <>
                                  <p className="text-xs text-muted-foreground">
                                    Betaald: {formatCurrency(total - (remaining ?? total))}
                                  </p>
                                  <p className="text-xs text-warning font-medium">
                                    Openstaand: {formatCurrency(remaining ?? total)}
                                  </p>
                                </>
                              )}
                            </div>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        {t.match_confidence != null ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-16 rounded-full bg-secondary">
                              <div className="h-full rounded-full bg-primary" style={{ width: `${t.match_confidence}%` }} />
                            </div>
                            <span className="text-xs text-muted-foreground">{t.match_confidence}%</span>
                          </div>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={
                          t.match_status === "gematcht" ? "default" 
                          : t.match_status === "handmatig_geboekt" ? "secondary"
                          : isSuggestion ? "secondary" 
                          : "destructive"
                        }>
                          {t.match_status === "gematcht" ? "Gematcht" 
                           : t.match_status === "handmatig_geboekt" ? "Handmatig geboekt"
                           : isSuggestion ? "Suggestie" 
                           : "Open"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {(() => {
                          // Determine the booking/link label
                          let label = "—";
                          let isOrphanMatch = false;
                          if (t.matched_invoice_id) {
                            const pi = purchaseInvoiceById.get(t.matched_invoice_id);
                            if (pi) {
                              label = `Inkoopfactuur: ${pi.supplier}${pi.invoice_number ? ` · ${pi.invoice_number}` : ""}`;
                            } else {
                              const si = salesInvoiceById.get(t.matched_invoice_id);
                              if (si) label = `Verkoopfactuur: ${si.customer_name} · ${si.invoice_number}`;
                            }
                          } else if (t.match_status === "gematcht") {
                            // Gematcht but no invoice id stored — flag as orphan so user knows
                            label = "Gematcht zonder factuurkoppeling";
                            isOrphanMatch = true;
                          } else if (t.match_status === "handmatig_geboekt" && t.grootboekrekening_id) {
                            const gb = grootboekrekeningById.get(t.grootboekrekening_id);
                            if (gb) label = `${gb.nummer} - ${gb.omschrijving}`;
                          }
                          const vp = vraagpostByBankTransactionId.get(t.id);
                          const vpBadge = (() => {
                            if (!vp) return null;
                            if (vp.status === "opgelost") {
                              return (
                                <Badge variant="outline" className="text-xs w-fit border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200">
                                  Vraagpost opgelost
                                </Badge>
                              );
                            }
                            if (vp.status === "genegeerd") {
                              return (
                                <Badge variant="secondary" className="text-xs w-fit">
                                  Vraagpost genegeerd
                                </Badge>
                              );
                            }
                            return (
                              <Badge variant="outline" className="text-xs w-fit border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                                Vraagpost open
                              </Badge>
                            );
                          })();
                          return (
                            <div className="flex flex-col gap-1 min-w-0">
                              <span
                                className={`text-sm truncate max-w-[200px] block ${isOrphanMatch ? "text-amber-600 dark:text-amber-400" : ""}`}
                                title={label}
                              >{label}</span>
                              {vpBadge}
                            </div>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {t.match_status === "gematcht" || t.match_status === "handmatig_geboekt" ? (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button size="sm" variant="ghost" onClick={() => {
                                    if (t.match_status === "handmatig_geboekt") {
                                      updateTx.mutateAsync({
                                        id: t.id,
                                        match_status: "niet_gematcht",
                                        grootboekrekening_id: null,
                                      }).then(() => {
                                        toast({ title: "Handmatige boeking verwijderd", description: "Transactie is weer open." });
                                      });
                                    } else {
                                      handleUnlink(t);
                                    }
                                  }}>
                                    <Unlink className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Ontkoppelen</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : t.match_status === "suggestie" ? (
                            <Button size="sm" variant="default" onClick={() => handleConfirm(t.id)}>
                              Bevestig
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => setMatchTx(t)}>
                              Koppel
                            </Button>
                          )}
                          {t.match_status === "gematcht" && unallocatedAmount >= 0.01 && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button size="sm" variant="ghost" onClick={() => {
                                    setMatchDialogMode("additional");
                                    setAdditionalMaxAmount(unallocatedAmount);
                                    setMatchTx(t);
                                  }}>
                                    <Plus className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Extra factuur koppelen ({formatCurrency(unallocatedAmount)} resterend)</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                          {isOpen && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button size="sm" variant="ghost" onClick={() => handleMaakVraagpost(t)}>
                                    <HelpCircle className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Maak vraagpost</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
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

      {/* Bulk boeken toolbar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-background border rounded-lg shadow-lg px-6 py-3 flex items-center gap-4">
          <span className="text-sm font-medium">{selectedIds.size} transactie(s) geselecteerd</span>
          {(() => {
            const selectedSuggestionCount = Array.from(selectedIds).filter(id => suggestionIds.has(id)).length;
            return selectedSuggestionCount > 0 ? (
              <Button size="sm" variant="default" onClick={handleBulkConfirmSuggestions}>
                <CheckCircle2 className="mr-1 h-4 w-4" />
                Bevestig {selectedSuggestionCount} suggestie(s)
              </Button>
            ) : null;
          })()}
          <div className="w-64">
            <GrootboekCombobox value={bulkLedger} onValueChange={setBulkLedger} onIdChange={setBulkLedgerId} />
          </div>
          {(() => {
            const repairCount = Array.from(selectedIds).filter(id => {
              const tx = transactions?.find(t => t.id === id);
              return tx?.match_status === "gematcht" && tx.matched_invoice_id != null;
            }).length;
            return repairCount > 0 ? (
              <Button size="sm" variant="outline" onClick={handleRepairAflettering}>
                <RefreshCw className="mr-1 h-4 w-4" />
                Herbereken aflettering ({repairCount})
              </Button>
            ) : null;
          })()}
          <Button size="sm" onClick={handleBulkBook} disabled={!bulkLedger}>
            Boek geselecteerde transacties
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (selectedIds.size > 1) {
                setConfirmUnlinkOpen(true);
              } else {
                handleBulkUnlink();
              }
            }}
          >
            <Unlink className="mr-1 h-4 w-4" />
            Ontkoppel geselecteerde
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setSelectedIds(new Set()); setBulkLedger(""); setBulkLedgerId(""); }}>
            Annuleren
          </Button>
        </div>
      )}

      <AlertDialog open={confirmUnlinkOpen} onOpenChange={setConfirmUnlinkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transacties ontkoppelen</AlertDialogTitle>
            <AlertDialogDescription>
              Weet je zeker dat je {selectedIds.size} transacties wilt ontkoppelen? Dit reset ze naar "Niet gematcht" en keert eventuele factuurwijzigingen terug.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuleren</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkUnlink}>Ontkoppelen</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <VerwerkingsScherm
        open={verwerkingOpen}
        onOpenChange={setVerwerkingOpen}
        transactions={transactions?.filter(t => clientFilter === "all" || t.client_id === clientFilter) ?? []}
        purchaseInvoices={invoices ?? []}
        salesInvoices={salesInvs ?? []}
        onBookPrivate={async (id) => {
          await updateTx.mutateAsync({ id, match_status: "handmatig_geboekt", grootboekrekening_id: undefined });
          toast({ title: "Privé geboekt" });
          refetch();
        }}
        onBookLedger={async (id, ledgerText, ledgerId) => {
          await updateTx.mutateAsync({ id, match_status: "handmatig_geboekt", grootboekrekening_id: ledgerId || undefined });
          toast({ title: `Geboekt: ${ledgerText}` });
          refetch();
        }}
        onMatchInvoice={async (id, invoiceId, invoiceType) => {
          await updateTx.mutateAsync({ id, match_status: "gematcht", matched_invoice_id: invoiceId, match_confidence: 100 });
          if (invoiceType === "inkoop") {
            await updatePurchase.mutateAsync({ id: invoiceId, remaining_amount: 0 });
          } else {
            await updateSales.mutateAsync({ id: invoiceId, status: "betaald", remaining_amount: 0 });
          }
          const matchedTx = transactions?.find(t => t.id === id);
          if (matchedTx) {
            try {
              await upsertSingleAllocationForMatch(matchedTx, invoiceId);
            } catch (e: any) {
              toast({ title: "Allocatierij niet aangemaakt", description: e.message, variant: "destructive" });
            }
          }
          toast({ title: "Factuur gekoppeld" });
          refetch();
          refetchPurchase();
          refetchSales();
        }}
        onSkip={(id) => {
          toast({ title: "Transactie overgeslagen" });
        }}
      />

      <BankStatementUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        clients={clients ?? []}
        invoices={invoices ?? []}
        onImport={handleImport}
        existingTransactions={transactions ?? []}
        bookingTemplates={bookingTemplates ?? []}
        defaultClientId={clientFilter !== "all" ? clientFilter : undefined}
      />

      <BankMatchDialog
        open={!!matchTx}
        onOpenChange={(v) => { if (!v) closeMatchDialog(); }}
        transaction={matchTx}
        purchaseInvoices={(invoices ?? []).filter(i => matchTx ? i.client_id === matchTx.client_id : true)}
        salesInvoices={(salesInvs ?? []).filter(i => matchTx ? i.client_id === matchTx.client_id : true)}
        onConfirm={handleMatch}
        onManualBook={handleManualBook}
        onRefresh={handleRefreshMatching}
        maxAllocationAmount={matchDialogMode === "additional" ? additionalMaxAmount : undefined}
        alreadyAllocatedAmount={matchDialogMode === "additional" && matchTx ? allocatedAmountByTxId.get(matchTx.id) : undefined}
      />
    </>
  );
}
