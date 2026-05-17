import { useState, useMemo, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { CheckCircle2, RefreshCw, AlertTriangle } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";
import { parseMT940Description } from "@/lib/mt940-description-parser";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { getInvoiceRemainingAmount, isClosedInvoiceStatus } from "@/lib/invoice-balances";

type BankTransaction = Tables<"bank_transactions">;
type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;

export interface InvoiceCandidate {
  id: string;
  type: "inkoop" | "verkoop";
  invoiceNumber: string | null;
  name: string;
  amount: number | null;
  date: string | null;
  score: number;
  reasons: string[];
  isPartialPayment: boolean;
  remainingAmount: number | null;
}

interface BankMatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: BankTransaction | null;
  purchaseInvoices: PurchaseInvoice[];
  salesInvoices: SalesInvoice[];
  onConfirm: (transactionId: string, invoiceId: string, invoiceType: "inkoop" | "verkoop", exactMatch: boolean, isPartialPayment: boolean, remainingAmount: number | null, allocationAmount: number) => void;
  onManualBook?: (transactionId: string, ledgerAccount: string, description: string, grootboekrekeningId?: string) => void;
  onRefresh?: () => void;
  /** When set, caps the allocation amount to this value (unallocated remainder on an already-matched tx). */
  maxAllocationAmount?: number;
  /** Total already allocated for this tx (displayed in info panel). */
  alreadyAllocatedAmount?: number;
  /** Invoice IDs to exclude from the candidate list (already allocated to this tx in additional mode). */
  excludedInvoiceIds?: string[];
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

export function rankCandidates(
  tx: BankTransaction,
  purchases: PurchaseInvoice[],
  sales: SalesInvoice[]
): InvoiceCandidate[] {
  const txAmount = Math.abs(tx.amount);
  const candidates: InvoiceCandidate[] = [];
  const txDesc = (tx.description || "").toLowerCase();
  const txRef = (tx.reference || "").toLowerCase();
  const parsed = parseMT940Description(tx.description);
  const searchText = `${txDesc} ${txRef} ${(parsed.reference || "").toLowerCase()}`;

  for (const inv of purchases) {
    if (isClosedInvoiceStatus(inv.status)) continue;
    const invoiceAmount = getInvoiceRemainingAmount(inv);
    const absInvoiceAmount = invoiceAmount != null ? Math.abs(invoiceAmount) : null;

    let score = 0;
    const reasons: string[] = [];
    let isPartialPayment = false;
    let remainingAmount: number | null = null;

    // Amount matching — ignore date entirely
    if (absInvoiceAmount != null && txAmount > 0) {
      const diff = Math.abs(absInvoiceAmount - txAmount);
      if (diff < 0.01) {
        score += 100;
        reasons.push("Exact bedrag");
      } else if (diff <= 0.50) {
        score += 90;
        reasons.push("Bedrag ≈ gelijk (≤€0,50)");
      } else if (txAmount < absInvoiceAmount && txAmount > 0) {
        // Partial payment
        score += 60;
        isPartialPayment = true;
        remainingAmount = absInvoiceAmount - txAmount;
        reasons.push("Deelbetaling");
      }
    }

    // Invoice number in description/reference
    if (inv.invoice_number) {
      const invNum = inv.invoice_number.toLowerCase();
      if (searchText.includes(invNum)) {
        score += 50;
        reasons.push("Factuurnr gevonden");
      }
    }

    // Name in description
    if (txDesc.includes(inv.supplier.toLowerCase())) {
      score += 20;
      reasons.push("Naam in omschrijving");
    }

    candidates.push({
      id: inv.id,
      type: "inkoop",
      invoiceNumber: inv.invoice_number,
      name: inv.supplier,
      amount: invoiceAmount,
      date: inv.invoice_date,
      score,
      reasons,
      isPartialPayment,
      remainingAmount,
    });
  }

  for (const inv of sales) {
    if (isClosedInvoiceStatus(inv.status)) continue;
    const invoiceAmount = getInvoiceRemainingAmount(inv);
    const absInvoiceAmount = invoiceAmount != null ? Math.abs(invoiceAmount) : null;

    let score = 0;
    const reasons: string[] = [];
    let isPartialPayment = false;
    let remainingAmount: number | null = null;

    if (absInvoiceAmount != null && txAmount > 0) {
      const diff = Math.abs(absInvoiceAmount - txAmount);
      if (diff < 0.01) {
        score += 100;
        reasons.push("Exact bedrag");
      } else if (diff <= 0.50) {
        score += 90;
        reasons.push("Bedrag ≈ gelijk (≤€0,50)");
      } else if (txAmount < absInvoiceAmount && txAmount > 0) {
        score += 60;
        isPartialPayment = true;
        remainingAmount = absInvoiceAmount - txAmount;
        reasons.push("Deelbetaling");
      }
    }

    // Invoice number in description/reference
    const invNum = inv.invoice_number.toLowerCase();
    if (invNum && searchText.includes(invNum)) {
      score += 50;
      reasons.push("Factuurnr gevonden");
    }

    if (txDesc.includes(inv.customer_name.toLowerCase())) {
      score += 20;
      reasons.push("Naam in omschrijving");
    }

    candidates.push({
      id: inv.id,
      type: "verkoop",
      invoiceNumber: inv.invoice_number,
      name: inv.customer_name,
      amount: invoiceAmount,
      date: inv.invoice_date,
      score,
      reasons,
      isPartialPayment,
      remainingAmount,
    });
  }

  // Sort: by score desc, then prioritize type based on transaction sign
  const preferredType = tx.amount >= 0 ? "verkoop" : "inkoop";
  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.type === preferredType && b.type !== preferredType) return -1;
    if (b.type === preferredType && a.type !== preferredType) return 1;
    return 0;
  });
}


type CandidateFilter = "auto" | "verkoop" | "inkoop" | "alle";

export function BankMatchDialog({
  open, onOpenChange, transaction, purchaseInvoices, salesInvoices, onConfirm, onManualBook, onRefresh,
  maxAllocationAmount, alreadyAllocatedAmount, excludedInvoiceIds,
}: BankMatchDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("factuur");
  const [ledgerAccount, setLedgerAccount] = useState("");
  const [ledgerAccountId, setLedgerAccountId] = useState("");
  const [manualDesc, setManualDesc] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [allocationAmountStr, setAllocationAmountStr] = useState("");
  const [candidateFilter, setCandidateFilter] = useState<CandidateFilter>("auto");

  const candidates = useMemo(() => {
    if (!transaction) return [];
    const all = rankCandidates(transaction, purchaseInvoices, salesInvoices);
    if (!excludedInvoiceIds?.length) return all;
    const excluded = new Set(excludedInvoiceIds);
    return all.filter(c => !excluded.has(c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transaction, purchaseInvoices, salesInvoices, refreshKey, excludedInvoiceIds]);

  const preferredType: "inkoop" | "verkoop" = transaction?.amount != null
    ? (transaction.amount >= 0 ? "verkoop" : "inkoop")
    : "verkoop";

  const displayedCandidates = useMemo(() => {
    if (candidateFilter === "auto") return candidates.filter(c => c.type === preferredType);
    if (candidateFilter === "verkoop") return candidates.filter(c => c.type === "verkoop");
    if (candidateFilter === "inkoop") return candidates.filter(c => c.type === "inkoop");
    const same = candidates.filter(c => c.type === preferredType);
    const opposite = candidates.filter(c => c.type !== preferredType);
    return [...same, ...opposite];
  }, [candidates, candidateFilter, preferredType]);

  // Reset filter to auto when the transaction changes (dialog re-opens with a different tx)
  useEffect(() => {
    setCandidateFilter("auto");
  }, [transaction?.id]);

  const selected = candidates.find((c) => c.id === selectedId);
  const exactMatch = selected ? (selected.reasons.includes("Exact bedrag") || selected.reasons.includes("Bedrag ≈ gelijk (≤€0,50)")) : false;

  // Reset allocation amount to sensible default whenever the selected candidate changes.
  useEffect(() => {
    if (!selected || !transaction) {
      setAllocationAmountStr("");
      return;
    }
    const effectiveCap = maxAllocationAmount ?? Math.abs(transaction.amount);
    const invOpen = selected.amount != null ? Math.abs(selected.amount) : null;
    const defaultAmt = invOpen != null ? Math.min(effectiveCap, invOpen) : effectiveCap;
    setAllocationAmountStr(defaultAmt.toFixed(2));
  }, [selectedId]); // intentionally only on selectedId — not on transaction/selected to avoid mid-type resets

  // Derived allocation amount validation
  const txAbsAmount = transaction ? Math.abs(transaction.amount) : 0;
  const effectiveCap = maxAllocationAmount ?? txAbsAmount;
  const invoiceOpenAmount = selected?.amount != null ? Math.abs(selected.amount) : null;
  const parsedAllocationAmount = parseFloat(allocationAmountStr.replace(",", "."));
  const allocIsNaN = isNaN(parsedAllocationAmount) || parsedAllocationAmount <= 0;
  const allocExceedsCap = !allocIsNaN && parsedAllocationAmount > effectiveCap + 0.001;
  const allocExceedsInvoice = !allocIsNaN && invoiceOpenAmount != null && parsedAllocationAmount > invoiceOpenAmount + 0.001;
  const allocError: string | null = allocIsNaN
    ? "Vul een geldig bedrag in"
    : allocExceedsCap
    ? maxAllocationAmount != null
      ? `Bedrag mag niet hoger zijn dan het resterend te verdelen bedrag (${formatCurrency(effectiveCap)})`
      : `Bedrag mag niet hoger zijn dan banktransactie (${formatCurrency(effectiveCap)})`
    : allocExceedsInvoice
    ? `Bedrag mag niet hoger zijn dan open factuurbedrag (${formatCurrency(invoiceOpenAmount!)})`
    : null;

  const handleConfirm = () => {
    if (!transaction || !selected || allocError) return;
    onConfirm(
      transaction.id, selected.id, selected.type,
      exactMatch && !selected.isPartialPayment, selected.isPartialPayment, selected.remainingAmount,
      parsedAllocationAmount,
    );
    resetAndClose();
  };

  const handleManualBook = () => {
    if (!transaction || !ledgerAccount || !onManualBook) return;
    onManualBook(transaction.id, ledgerAccount, manualDesc, ledgerAccountId || undefined);
    resetAndClose();
  };

  const handleRefresh = () => {
    setRefreshKey(k => k + 1);
    onRefresh?.();
  };

  const resetAndClose = () => {
    setSelectedId(null);
    setTab("factuur");
    setLedgerAccount("");
    setLedgerAccountId("");
    setManualDesc("");
    setAllocationAmountStr("");
    onOpenChange(false);
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) resetAndClose();
    else onOpenChange(v);
  };

  if (!transaction) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{maxAllocationAmount != null ? "Extra factuur koppelen" : "Transactie koppelen"}</DialogTitle>
          <DialogDescription>
            {maxAllocationAmount != null
              ? `Koppel een tweede factuur aan het resterend bedrag (${formatCurrency(maxAllocationAmount)}).`
              : "Koppel aan een factuur of boek handmatig."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1 space-y-4">
        {/* Transaction details */}
        {(() => {
          const parsed = parseMT940Description(transaction.description);
          const iban = transaction.counter_account || parsed.iban;
          return (
            <div className="rounded-lg border bg-muted/50 p-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Datum</span>
                <span className="font-medium">{new Date(transaction.transaction_date).toLocaleDateString("nl-NL")}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Bedrag</span>
                <span className={`font-mono font-medium ${transaction.amount < 0 ? "text-destructive" : "text-success"}`}>
                  {formatCurrency(transaction.amount)}
                </span>
              </div>
              {parsed.name && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Naam</span>
                  <span className="font-medium">{parsed.name}</span>
                </div>
              )}
              {iban && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tegenrekening</span>
                  <span className="font-medium font-mono">{iban}</span>
                </div>
              )}
              {parsed.reference && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Referentie</span>
                  <span className="font-medium">{parsed.reference}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Omschrijving</span>
                <span className="font-medium text-right max-w-xs break-all text-xs">{transaction.description || "—"}</span>
              </div>
            </div>
          );
        })()}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full">
            <TabsTrigger value="factuur" className="flex-1">Koppel aan factuur</TabsTrigger>
            {maxAllocationAmount == null && (
              <TabsTrigger value="handmatig" className="flex-1">Handmatig boeken</TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="factuur">
            <div className="flex justify-end mb-2">
              <Button variant="ghost" size="sm" onClick={handleRefresh} className="text-xs gap-1">
                <RefreshCw className="h-3 w-3" />
                Opnieuw matchen
              </Button>
            </div>
            <div className="flex items-center gap-1.5 mb-2 flex-wrap">
              {(["auto", "verkoop", "inkoop", "alle"] as CandidateFilter[]).map(f => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setCandidateFilter(f)}
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                    candidateFilter === f
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {f === "auto"
                    ? `Auto (${preferredType === "verkoop" ? "Verkoop" : "Inkoop"})`
                    : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            <ScrollArea className="h-[180px]">
              {displayedCandidates.length === 0 ? (
                <p className="py-8 text-center text-muted-foreground text-sm">
                  {candidates.length === 0
                    ? "Geen openstaande facturen gevonden."
                    : "Geen facturen gevonden voor dit filter."}
                </p>
              ) : (
                <div className="space-y-2">
                  {displayedCandidates.map((c) => {
                    const isOpposite = c.type !== preferredType;
                    return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={`w-full text-left rounded-lg border p-3 transition-colors hover:bg-accent/50 ${
                        selectedId === c.id
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : isOpposite
                          ? "border-amber-300 dark:border-amber-700"
                          : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate">{c.name}</span>
                            <Badge variant="outline" className="text-[10px] shrink-0">
                              {c.type === "inkoop" ? "Inkoop" : "Verkoop"}
                            </Badge>
                            {c.isPartialPayment && (
                              <Badge variant="secondary" className="text-[10px] shrink-0 bg-warning/20 text-warning-foreground">
                                Deelbetaling
                              </Badge>
                            )}
                            {isOpposite && (
                              <Badge variant="outline" className="text-[10px] shrink-0 border-amber-500/60 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 flex items-center gap-0.5">
                                <AlertTriangle className="h-2.5 w-2.5" />
                                Tegengestelde richting
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {c.invoiceNumber && <span>{c.invoiceNumber} · </span>}
                            {c.date && <span>{new Date(c.date).toLocaleDateString("nl-NL")} · </span>}
                            <span className="font-mono">{c.amount != null ? formatCurrency(c.amount) : "—"}</span>
                          </div>
                          {c.isPartialPayment && c.remainingAmount != null && transaction && (
                            <div className="text-xs text-muted-foreground mt-1 space-x-2">
                              <span>Factuur: <span className="font-mono">{formatCurrency(c.amount!)}</span></span>
                              <span>→ Betaling: <span className="font-mono">{formatCurrency(Math.abs(transaction.amount))}</span></span>
                              <span>→ Resterend: <span className="font-mono font-semibold">{formatCurrency(c.remainingAmount)}</span></span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {c.reasons.length > 0 && (
                            <div className="flex flex-wrap gap-1 justify-end">
                              {c.reasons.map((r) => (
                                <Badge key={r} variant={r === "Exact bedrag" ? "default" : "secondary"} className="text-[10px]">
                                  {r}
                                </Badge>
                              ))}
                            </div>
                          )}
                          {selectedId === c.id && <CheckCircle2 className="h-4 w-4 text-primary" />}
                        </div>
                      </div>
                    </button>
                    );
                  })}
                </div>
              )}
            </ScrollArea>

            {selected && (
              <div className="mt-3 rounded-lg border bg-muted/40 p-3 space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Banktransactie</span>
                  <span className="font-mono font-medium">{formatCurrency(txAbsAmount)}</span>
                </div>
                {maxAllocationAmount != null && alreadyAllocatedAmount != null && alreadyAllocatedAmount > 0 && (
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Reeds gealloceerd</span>
                    <span className="font-mono font-medium">{formatCurrency(alreadyAllocatedAmount)}</span>
                  </div>
                )}
                {maxAllocationAmount != null && (
                  <div className="flex items-center justify-between text-xs font-medium text-amber-700 dark:text-amber-400">
                    <span>Nog te verdelen</span>
                    <span className="font-mono">{formatCurrency(maxAllocationAmount)}</span>
                  </div>
                )}
                {invoiceOpenAmount != null && (
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Open factuurbedrag</span>
                    <span className="font-mono font-medium">{formatCurrency(invoiceOpenAmount)}</span>
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-xs">Te alloceren bedrag *</Label>
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={allocationAmountStr}
                    onChange={(e) => setAllocationAmountStr(e.target.value)}
                    className={`h-8 font-mono text-sm ${allocError ? "border-destructive focus-visible:ring-destructive" : ""}`}
                    placeholder="0.00"
                  />
                  {allocError ? (
                    <p className="text-xs text-destructive">{allocError}</p>
                  ) : !allocIsNaN && (
                    <p className="text-xs text-muted-foreground">
                      Restant op transactie:{" "}
                      <span className="font-mono">{formatCurrency(Math.max(0, effectiveCap - parsedAllocationAmount))}</span>
                    </p>
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="handmatig" className="space-y-4 pt-2">
            <div>
              <Label>Grootboekrekening *</Label>
<GrootboekCombobox value={ledgerAccount} onValueChange={setLedgerAccount} onIdChange={setLedgerAccountId} />
              <p className="text-xs text-muted-foreground mt-1">Bijv. privé, bankkosten, of niet-factuurgerelateerde betaling</p>
            </div>
            <div>
              <Label>Omschrijving (optioneel)</Label>
              <Input value={manualDesc} onChange={(e) => setManualDesc(e.target.value)} placeholder="Toelichting..." />
            </div>
          </TabsContent>
        </Tabs>
        </div>

        <DialogFooter className="shrink-0 border-t pt-3 bg-background">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>Annuleren</Button>
          {tab === "factuur" ? (
            <Button disabled={!selectedId || !!allocError} onClick={handleConfirm}>
              {maxAllocationAmount != null
                ? "Extra factuur koppelen"
                : `Koppelen${
                    selected && !allocIsNaN && parsedAllocationAmount < txAbsAmount - 0.001
                      ? " (deelallocatie)"
                      : selected?.isPartialPayment ? " (deelbetaling)"
                      : exactMatch ? " & Betaald"
                      : ""
                  }`}
            </Button>
          ) : (
            <Button disabled={!ledgerAccount} onClick={handleManualBook}>
              Boeken
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
