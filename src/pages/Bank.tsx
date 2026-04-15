import { useState, useCallback, useMemo } from "react";
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
import { Upload, CheckCircle2, HelpCircle, Link2, Download, Info, Unlink, ArrowUp, ArrowDown, Search } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { BankStatementUploadDialog, type MatchedTransaction } from "@/components/BankStatementUploadDialog";
import { BankMatchDialog, rankCandidates } from "@/components/BankMatchDialog";
import { VerwerkingsScherm } from "@/components/VerwerkingsScherm";
import type { Tables } from "@/integrations/supabase/types";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

type SortField = "date" | "amount" | "description" | "status";
type SortDir = "asc" | "desc";

import { useClientContext } from "@/hooks/useClientContext";

export default function Bank() {
  const [searchParams] = useSearchParams();
  const { selectedClientId, setSelectedClientId } = useClientContext();
  const [clientFilter, setClientFilter] = useState(() => searchParams.get("client") ?? selectedClientId);
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [matchTx, setMatchTx] = useState<Tables<"bank_transactions"> | null>(null);
  const [verwerkingOpen, setVerwerkingOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLedger, setBulkLedger] = useState("");
  const [bulkLedgerId, setBulkLedgerId] = useState("");
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

  const matched = transactions?.filter((t) => t.match_status === "gematcht").length ?? 0;

  // Compute which niet_gematcht transactions have candidate matches (= suggestions)
  const suggestionIds = useMemo(() => {
    if (!transactions || !invoices || !salesInvs) return new Set<string>();
    const ids = new Set<string>();
    for (const t of transactions) {
      if (t.match_status !== "niet_gematcht") continue;
      const candidates = rankCandidates(t, invoices, salesInvs);
      if (candidates.some(c => c.score > 0)) {
        ids.add(t.id);
      }
    }
    return ids;
  }, [transactions, invoices, salesInvs]);

  const suggested = suggestionIds.size;
  const unmatched = (transactions?.filter((t) => t.match_status === "niet_gematcht").length ?? 0) - suggested;

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
  }, [transactions, statusFilter, searchQuery, sortField, sortDir]);

  const openTransactions = filteredSorted.filter((t) => t.match_status !== "gematcht");

  const handleConfirm = async (id: string) => {
    try {
      await updateTx.mutateAsync({ id, match_status: "gematcht" });
      toast({ title: "Transactie bevestigd" });
    } catch (e: any) {
      toast({ title: "Fout", description: e.message, variant: "destructive" });
    }
  };

  const handleMatch = useCallback(async (
    transactionId: string,
    invoiceId: string,
    invoiceType: "inkoop" | "verkoop",
    exactMatch: boolean,
    isPartialPayment: boolean,
    remainingAmount: number | null
  ) => {
    try {
      await updateTx.mutateAsync({
        id: transactionId,
        match_status: "gematcht",
        matched_invoice_id: invoiceId,
        match_confidence: exactMatch ? 100 : isPartialPayment ? 60 : 80,
      });

      if (exactMatch && !isPartialPayment) {
        if (invoiceType === "inkoop") {
          await updatePurchase.mutateAsync({ id: invoiceId, status: "betaald" });
        } else {
          await updateSales.mutateAsync({ id: invoiceId, status: "betaald" });
        }
        toast({ title: "Transactie gekoppeld", description: "Factuur status → Betaald" });
      } else if (isPartialPayment && remainingAmount != null) {
        // Update invoice amount to remaining
        if (invoiceType === "inkoop") {
          await updatePurchase.mutateAsync({ id: invoiceId, amount_incl: remainingAmount });
        } else {
          await updateSales.mutateAsync({ id: invoiceId, amount_incl: remainingAmount });
        }
        toast({ title: "Deelbetaling gekoppeld", description: `Resterend: ${formatCurrency(remainingAmount)}` });
      } else {
        toast({ title: "Transactie gekoppeld" });
      }

      setMatchTx(null);
    } catch (e: any) {
      toast({ title: "Fout bij koppelen", description: e.message, variant: "destructive" });
    }
  }, [updateTx, updatePurchase, updateSales, toast]);

  const handleUnlink = useCallback(async (tx: Tables<"bank_transactions">) => {
    try {
      const invoiceId = tx.matched_invoice_id;
      const txAmount = Math.abs(tx.amount);

      await updateTx.mutateAsync({
        id: tx.id,
        match_status: "niet_gematcht",
        matched_invoice_id: null,
        match_confidence: null,
      });

      // Restore invoice amount if it was a partial payment
      if (invoiceId) {
        // Try to find in purchases first, then sales
        const purchaseInv = invoices?.find(i => i.id === invoiceId);
        const salesInv = salesInvs?.find(i => i.id === invoiceId);

        if (purchaseInv) {
          const currentAmount = purchaseInv.amount_incl ?? 0;
          // If invoice is betaald, set back to gecontroleerd; if partial, restore amount
          if (purchaseInv.status === "betaald") {
            await updatePurchase.mutateAsync({ id: invoiceId, status: "gecontroleerd" });
          } else {
            // Partial payment — restore the original amount
            await updatePurchase.mutateAsync({ id: invoiceId, amount_incl: currentAmount + txAmount });
          }
        } else if (salesInv) {
          if (salesInv.status === "betaald") {
            await updateSales.mutateAsync({ id: invoiceId, status: "gecontroleerd" });
          } else {
            const currentAmount = salesInv.amount_incl ?? 0;
            await updateSales.mutateAsync({ id: invoiceId, amount_incl: currentAmount + txAmount });
          }
        }
      }

      toast({ title: "Koppeling verwijderd", description: "Transactie is weer open." });
    } catch (e: any) {
      toast({ title: "Fout bij ontkoppelen", description: e.message, variant: "destructive" });
    }
  }, [updateTx, updatePurchase, updateSales, invoices, salesInvs, toast]);

  const handleManualBook = useCallback(async (transactionId: string, ledgerAccount: string, description: string, grootboekrekeningId?: string) => {
    try {
      await updateTx.mutateAsync({
        id: transactionId,
        match_status: "handmatig_geboekt",
        description: description || undefined,
        grootboekrekening_id: grootboekrekeningId || undefined,
      });
      toast({ title: "Transactie geboekt", description: `Grootboek: ${ledgerAccount}` });
      setMatchTx(null);
    } catch (e: any) {
      toast({ title: "Fout bij boeken", description: e.message, variant: "destructive" });
    }
  }, [updateTx, toast]);

  

  const handleBulkBook = useCallback(async () => {
    if (selectedIds.size === 0 || !bulkLedger) return;
    
    const ids = Array.from(selectedIds);
    let success = 0;
    const errors: string[] = [];
    
    for (const id of ids) {
      try {
        await updateTx.mutateAsync({
          id,
          match_status: "handmatig_geboekt",
          grootboekrekening_id: bulkLedgerId || undefined,
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
    
    if (success > 0) {
      toast({ title: `${success} transactie(s) geboekt naar ${bulkLedger}` });
    }
    if (errors.length > 0) {
      toast({ title: "Fout bij boeken", description: `${errors.length} transactie(s) mislukt: ${errors[0]}`, variant: "destructive" });
    }
  }, [selectedIds, bulkLedger, updateTx, toast, refetch]);

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

      const candidates = rankCandidates(tx, invoices, salesInvs);
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
            await updatePurchase.mutateAsync({ id: best.id, status: "betaald" });
          } else {
            await updateSales.mutateAsync({ id: best.id, status: "betaald" });
          }
        } else if (best.isPartialPayment && best.remainingAmount != null) {
          if (best.type === "inkoop") {
            await updatePurchase.mutateAsync({ id: best.id, amount_incl: best.remainingAmount });
          } else {
            await updateSales.mutateAsync({ id: best.id, amount_incl: best.remainingAmount });
          }
        }

        confirmed++;
      } catch (e: any) {
        console.error("Bulk confirm error:", e);
        errors.push(e.message || "Onbekende fout");
      }
    }

    setSelectedIds(new Set());
    await refetch();
    refetchPurchase();
    refetchSales();

    const parts: string[] = [];
    if (confirmed > 0) parts.push(`${confirmed} bevestigd`);
    if (skipped > 0) parts.push(`${skipped} overgeslagen (geen suggestie)`);
    if (errors.length > 0) parts.push(`${errors.length} mislukt`);

    toast({
      title: `Suggesties verwerkt`,
      description: parts.join(", "),
      variant: errors.length > 0 && confirmed === 0 ? "destructive" : undefined,
    });
  }, [selectedIds, transactions, invoices, salesInvs, suggestionIds, updateTx, updatePurchase, updateSales, toast, refetch, refetchPurchase, refetchSales]);

  const handleImport = useCallback(async (clientId: string, txs: MatchedTransaction[]) => {
    let success = 0;
    for (const tx of txs) {
      try {
        await addTx.mutateAsync({
          client_id: clientId,
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
        success++;
      } catch (e: any) {
        console.error("Import error:", e);
      }
    }
    toast({ title: `${success} van ${txs.length} transacties geïmporteerd` });
  }, [addTx, toast]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === openTransactions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(openTransactions.map(t => t.id)));
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
        <Button variant="outline" onClick={() => setVerwerkingOpen(true)} disabled={!transactions?.some(t => t.match_status === "niet_gematcht")}>
          ⚡ Verwerken ({transactions?.filter(t => t.match_status === "niet_gematcht").length ?? 0})
        </Button>
          <Upload className="mr-2 h-4 w-4" />Upload afschrift
        </Button>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <Card><CardContent className="flex items-center gap-3 p-4">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <div><p className="font-display text-xl font-bold">{matched}</p><p className="text-xs text-muted-foreground">Gematcht</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 p-4">
          <Link2 className="h-5 w-5 text-warning" />
          <div><p className="font-display text-xl font-bold">{suggested}</p><p className="text-xs text-muted-foreground">Suggesties</p></div>
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
                      checked={openTransactions.length > 0 && selectedIds.size === openTransactions.length}
                      onCheckedChange={toggleSelectAll}
                    />
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => handleSort("date")}>Datum<SortIcon field="date" /></TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => handleSort("description")}>Omschrijving<SortIcon field="description" /></TableHead>
                  <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("amount")}>Bedrag<SortIcon field="amount" /></TableHead>
                  <TableHead>Betrouwbaarheid</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => handleSort("status")}>Status<SortIcon field="status" /></TableHead>
                  <TableHead className="w-32"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSorted.map((t) => {
                  const isOpen = t.match_status !== "gematcht";
                  return (
                    <TableRow key={t.id}>
                      <TableCell>
                        {isOpen ? (
                          <Checkbox
                            checked={selectedIds.has(t.id)}
                            onCheckedChange={() => toggleSelect(t.id)}
                          />
                        ) : null}
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
                      <TableCell className={`text-right font-mono ${t.amount < 0 ? "text-destructive" : "text-success"}`}>
                        {formatCurrency(t.amount)}
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
                          : suggestionIds.has(t.id) ? "secondary" 
                          : "destructive"
                        }>
                          {t.match_status === "gematcht" ? "Gematcht" 
                           : t.match_status === "handmatig_geboekt" ? "Handmatig geboekt"
                           : suggestionIds.has(t.id) ? "Suggestie" 
                           : "Open"}
                        </Badge>
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
          <Button size="sm" onClick={handleBulkBook} disabled={!bulkLedger}>
            Boek geselecteerde transacties
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setSelectedIds(new Set()); setBulkLedger(""); setBulkLedgerId(""); }}>
            Annuleren
          </Button>
        </div>
      )}

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
            await updatePurchase.mutateAsync({ id: invoiceId, status: "betaald" });
          } else {
            await updateSales.mutateAsync({ id: invoiceId, status: "betaald" });
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
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        clients={clients ?? []}
        invoices={invoices ?? []}
        onImport={handleImport}
        existingTransactions={transactions ?? []}
        bookingTemplates={bookingTemplates ?? []}
      />

      <BankMatchDialog
        open={!!matchTx}
        onOpenChange={(v) => { if (!v) setMatchTx(null); }}
        transaction={matchTx}
        purchaseInvoices={(invoices ?? []).filter(i => matchTx ? i.client_id === matchTx.client_id : true)}
        salesInvoices={(salesInvs ?? []).filter(i => matchTx ? i.client_id === matchTx.client_id : true)}
        onConfirm={handleMatch}
        onManualBook={handleManualBook}
        onRefresh={handleRefreshMatching}
      />
    </>
  );
}
