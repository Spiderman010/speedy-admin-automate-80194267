import { useState, useMemo } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { CheckCircle2, RefreshCw } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";
import { parseMT940Description } from "@/lib/mt940-description-parser";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";

type BankTransaction = Tables<"bank_transactions">;
type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;

const CLOSED_STATUSES = ["betaald", "geëxporteerd"];

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
  onConfirm: (transactionId: string, invoiceId: string, invoiceType: "inkoop" | "verkoop", exactMatch: boolean, isPartialPayment: boolean, remainingAmount: number | null) => void;
  onManualBook?: (transactionId: string, ledgerAccount: string, description: string, grootboekrekeningId?: string) => void;
  onRefresh?: () => void;
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
    if (CLOSED_STATUSES.includes(inv.status)) continue;
    const invoiceAmount = inv.amount_incl ?? inv.amount_excl;
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
    if (CLOSED_STATUSES.includes(inv.status)) continue;
    const invoiceAmount = inv.amount_incl ?? inv.amount_excl;
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
    if (searchText.includes(invNum)) {
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


export function BankMatchDialog({
  open, onOpenChange, transaction, purchaseInvoices, salesInvoices, onConfirm, onManualBook, onRefresh,
}: BankMatchDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("factuur");
  const [ledgerAccount, setLedgerAccount] = useState("");
  const [ledgerAccountId, setLedgerAccountId] = useState("");
  const [manualDesc, setManualDesc] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const candidates = useMemo(() => {
    if (!transaction) return [];
    return rankCandidates(transaction, purchaseInvoices, salesInvoices);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transaction, purchaseInvoices, salesInvoices, refreshKey]);

  const selected = candidates.find((c) => c.id === selectedId);
  const exactMatch = selected ? (selected.reasons.includes("Exact bedrag") || selected.reasons.includes("Bedrag ≈ gelijk (≤€0,50)")) : false;

  const handleConfirm = () => {
    if (!transaction || !selected) return;
    onConfirm(transaction.id, selected.id, selected.type, exactMatch && !selected.isPartialPayment, selected.isPartialPayment, selected.remainingAmount);
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
    onOpenChange(false);
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) resetAndClose();
    else onOpenChange(v);
  };

  if (!transaction) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Transactie koppelen</DialogTitle>
          <DialogDescription>Koppel aan een factuur of boek handmatig.</DialogDescription>
        </DialogHeader>

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
            <TabsTrigger value="handmatig" className="flex-1">Handmatig boeken</TabsTrigger>
          </TabsList>

          <TabsContent value="factuur">
            <div className="flex justify-end mb-2">
              <Button variant="ghost" size="sm" onClick={handleRefresh} className="text-xs gap-1">
                <RefreshCw className="h-3 w-3" />
                Opnieuw matchen
              </Button>
            </div>
            <ScrollArea className="max-h-72 overflow-y-auto">
              {candidates.length === 0 ? (
                <p className="py-8 text-center text-muted-foreground text-sm">Geen openstaande facturen gevonden.</p>
              ) : (
                <div className="space-y-2">
                  {candidates.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={`w-full text-left rounded-lg border p-3 transition-colors hover:bg-accent/50 ${
                        selectedId === c.id ? "border-primary bg-primary/5 ring-1 ring-primary" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{c.name}</span>
                            <Badge variant="outline" className="text-[10px] shrink-0">
                              {c.type === "inkoop" ? "Inkoop" : "Verkoop"}
                            </Badge>
                            {c.isPartialPayment && (
                              <Badge variant="secondary" className="text-[10px] shrink-0 bg-warning/20 text-warning-foreground">
                                Deelbetaling
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
                  ))}
                </div>
              )}
            </ScrollArea>
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

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>Annuleren</Button>
          {tab === "factuur" ? (
            <Button disabled={!selectedId} onClick={handleConfirm}>
              Koppelen{selected?.isPartialPayment ? " (deelbetaling)" : exactMatch ? " & Betaald" : ""}
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
