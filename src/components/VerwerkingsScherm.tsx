import { useState, useMemo } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { X, ChevronRight, ChevronLeft, Home, Briefcase, FileText, SkipForward, CheckCircle2 } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";
import { parseMT940Description } from "@/lib/mt940-description-parser";

type BankTransaction = Tables<"bank_transactions">;
type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transactions: BankTransaction[];
  purchaseInvoices: PurchaseInvoice[];
  salesInvoices: SalesInvoice[];
  onBookPrivate: (transactionId: string) => Promise<void>;
  onBookLedger: (transactionId: string, ledgerText: string, ledgerId: string) => Promise<void>;
  onMatchInvoice: (transactionId: string, invoiceId: string, invoiceType: "inkoop" | "verkoop") => Promise<void>;
  onSkip: (transactionId: string) => void;
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

const formatDate = (dateStr: string) =>
  new Date(dateStr).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });

export function VerwerkingsScherm({
  open,
  onOpenChange,
  transactions,
  purchaseInvoices,
  salesInvoices,
  onBookPrivate,
  onBookLedger,
  onMatchInvoice,
  onSkip,
}: Props) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [mode, setMode] = useState<"main" | "grootboek" | "factuur">("main");
  const [ledgerText, setLedgerText] = useState("");
  const [ledgerId, setLedgerId] = useState("");
  const [loading, setLoading] = useState(false);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  const openTransactions = useMemo(() =>
    transactions.filter(t =>
      t.match_status === "niet_gematcht" && !skipped.has(t.id)
    ), [transactions, skipped]);

  const total = openTransactions.length;
  const current = openTransactions[currentIndex];
  const progress = total === 0 ? 100 : ((currentIndex) / total) * 100;

  const parsed = current ? parseMT940Description(current.description) : null;
  const displayName = parsed?.name || current?.description?.slice(0, 40) || "—";

  const goNext = () => {
    setMode("main");
    setLedgerText("");
    setLedgerId("");
    if (currentIndex < total - 1) {
      setCurrentIndex(i => i + 1);
    }
  };

  const goPrev = () => {
    setMode("main");
    if (currentIndex > 0) setCurrentIndex(i => i - 1);
  };

  const handlePrivate = async () => {
    if (!current) return;
    setLoading(true);
    await onBookPrivate(current.id);
    setLoading(false);
    goNext();
  };

  const handleLedger = async () => {
    if (!current || !ledgerText) return;
    setLoading(true);
    await onBookLedger(current.id, ledgerText, ledgerId);
    setLoading(false);
    goNext();
  };

  const handleSkip = () => {
    if (!current) return;
    onSkip(current.id);
    setSkipped(prev => new Set([...prev, current.id]));
    if (currentIndex >= total - 1) setCurrentIndex(Math.max(0, total - 2));
  };

  const candidateInvoices = useMemo(() => {
    if (!current) return [];
    const txAmount = Math.abs(current.amount);
    const allInvoices = [
      ...purchaseInvoices.filter(i => i.client_id === current.client_id).map(i => ({ ...i, type: "inkoop" as const })),
      ...salesInvoices.filter(i => i.client_id === current.client_id).map(i => ({ ...i, type: "verkoop" as const })),
    ];
    return allInvoices
      .filter(i => i.status !== "betaald" && i.status !== "geexporteerd")
      .sort((a, b) => {
        const diffA = Math.abs(Math.abs(a.amount_incl ?? 0) - txAmount);
        const diffB = Math.abs(Math.abs(b.amount_incl ?? 0) - txAmount);
        return diffA - diffB;
      })
      .slice(0, 8);
  }, [current, purchaseInvoices, salesInvoices]);

  if (total === 0) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <CheckCircle2 className="h-16 w-16 text-green-500" />
            <h2 className="text-xl font-bold">Alles verwerkt!</h2>
            <p className="text-muted-foreground">Er zijn geen openstaande transacties meer.</p>
            <Button onClick={() => onOpenChange(false)}>Sluiten</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 overflow-hidden">
        {/* Header met voortgang */}
        <div className="p-4 border-b">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-muted-foreground">
              {currentIndex + 1} van {total} transacties
            </span>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Transactiekaart */}
        {current && (
          <div className="p-6">
            <div className={`text-3xl font-bold mb-1 ${current.amount < 0 ? "text-destructive" : "text-green-600"}`}>
              {formatCurrency(current.amount)}
            </div>
            <div className="text-lg font-medium mb-1">{displayName}</div>
            <div className="text-sm text-muted-foreground mb-1">{formatDate(current.transaction_date)}</div>
            {parsed?.iban && (
              <div className="text-xs text-muted-foreground font-mono">{parsed.iban}</div>
            )}
            {current.description && (
              <div className="mt-2 text-xs text-muted-foreground bg-muted/50 rounded p-2 line-clamp-2">
                {current.description}
              </div>
            )}
          </div>
        )}

        {/* Actieknoppen */}
        <div className="px-6 pb-6">
          {mode === "main" && (
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-14 flex-col gap-1 border-orange-200 hover:bg-orange-50 hover:border-orange-400"
                onClick={handlePrivate}
                disabled={loading}
              >
                <Home className="h-5 w-5 text-orange-500" />
                <span className="text-xs">Privé</span>
              </Button>
              <Button
                variant="outline"
                className="h-14 flex-col gap-1 border-blue-200 hover:bg-blue-50 hover:border-blue-400"
                onClick={() => setMode("grootboek")}
              >
                <Briefcase className="h-5 w-5 text-blue-500" />
                <span className="text-xs">Grootboek</span>
              </Button>
              <Button
                variant="outline"
                className="h-14 flex-col gap-1 border-green-200 hover:bg-green-50 hover:border-green-400"
                onClick={() => setMode("factuur")}
              >
                <FileText className="h-5 w-5 text-green-500" />
                <span className="text-xs">Factuur koppelen</span>
              </Button>
              <Button
                variant="ghost"
                className="h-14 flex-col gap-1 text-muted-foreground"
                onClick={handleSkip}
              >
                <SkipForward className="h-5 w-5" />
                <span className="text-xs">Overslaan</span>
              </Button>
            </div>
          )}

          {mode === "grootboek" && (
            <div className="space-y-3">
              <p className="text-sm font-medium">Selecteer grootboekrekening:</p>
              <GrootboekCombobox
                value={ledgerText}
                onValueChange={setLedgerText}
                onIdChange={setLedgerId}
              />
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setMode("main")} className="flex-1">
                  Terug
                </Button>
                <Button onClick={handleLedger} disabled={!ledgerText || loading} className="flex-1">
                  Boeken
                </Button>
              </div>
            </div>
          )}

          {mode === "factuur" && (
            <div className="space-y-3">
              <p className="text-sm font-medium">Koppel aan factuur:</p>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {candidateInvoices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Geen openstaande facturen gevonden.</p>
                ) : (
                  candidateInvoices.map(inv => (
                    <button
                      key={inv.id}
                      className="w-full text-left p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                      onClick={async () => {
                        setLoading(true);
                        await onMatchInvoice(current.id, inv.id, inv.type);
                        setLoading(false);
                        goNext();
                      }}
                      disabled={loading}
                    >
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="text-sm font-medium">{inv.type === "inkoop" ? (inv as any).supplier : (inv as any).customer_name}</p>
                          <p className="text-xs text-muted-foreground">{(inv as any).invoice_number || "Geen nummer"}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-mono font-medium">{formatCurrency(inv.amount_incl ?? 0)}</p>
                          <Badge variant="outline" className="text-[10px]">{inv.type}</Badge>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
              <Button variant="outline" onClick={() => setMode("main")} className="w-full">
                Terug
              </Button>
            </div>
          )}
        </div>

        {/* Navigatie */}
        <div className="border-t px-6 py-3 flex justify-between">
          <Button variant="ghost" size="sm" onClick={goPrev} disabled={currentIndex === 0}>
            <ChevronLeft className="h-4 w-4 mr-1" />Vorige
          </Button>
          <Button variant="ghost" size="sm" onClick={goNext} disabled={currentIndex >= total - 1}>
            Volgende<ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
