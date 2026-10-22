import { useState, useMemo } from "react";
import { toast } from "@/hooks/use-toast";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { X, ChevronRight, ChevronLeft, Home, Briefcase, FileText, SkipForward, CheckCircle2 } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";
import { parseMT940Description } from "@/lib/mt940-description-parser";
import { getInvoiceTotalAmount } from "@/lib/invoice-balances";
import { gatedInvoiceCandidates, hasTiedTopCandidates, preselectCandidate, preselectFullPaymentCandidate } from "@/lib/bank-candidate-gate";
import { BtwKeuzeSelect } from "@/components/bank/BtwKeuzeSelect";
import { btwKeuzeFromPercentage, btwKeuzeToPercentage } from "@/lib/btw-keuze";

type BankTransaction = Tables<"bank_transactions">;
type PurchaseInvoice = Tables<"purchase_invoices">;
type SalesInvoice = Tables<"sales_invoices">;

const isActionableTransaction = (matchStatus: string) =>
  matchStatus === "niet_gematcht" || matchStatus === "suggestie";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transactions: BankTransaction[];
  purchaseInvoices: PurchaseInvoice[];
  salesInvoices: SalesInvoice[];
  /** Undefined while rejection data is unavailable: invoice matches fail closed. */
  rejectionIndex?: ReadonlySet<string>;
  onBookPrivate: (transactionId: string) => Promise<void>;
  onBookLedger: (transactionId: string, ledgerText: string, ledgerId: string, btwPercentage: number) => Promise<void>;
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
  rejectionIndex,
  onBookPrivate,
  onBookLedger,
  onMatchInvoice,
  onSkip,
}: Props) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [mode, setMode] = useState<"main" | "grootboek" | "factuur">("main");
  const [ledgerText, setLedgerText] = useState("");
  const [ledgerId, setLedgerId] = useState("");
  // "" = not chosen yet; prefilled from the current transaction when entering
  // ledger mode and reset whenever we move to another transaction.
  const [ledgerBtw, setLedgerBtw] = useState("");
  const [loading, setLoading] = useState(false);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  const openTransactions = useMemo(() =>
    transactions.filter(t =>
      isActionableTransaction(t.match_status) && !skipped.has(t.id)
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
    setLedgerBtw("");
    if (currentIndex < total - 1) {
      setCurrentIndex(i => i + 1);
    }
  };

  const goPrev = () => {
    setMode("main");
    setLedgerBtw("");
    if (currentIndex > 0) setCurrentIndex(i => i - 1);
  };

  const openLedgerMode = () => {
    setLedgerBtw(btwKeuzeFromPercentage(current?.btw_percentage));
    setMode("grootboek");
  };

  // Only move on when the coding was saved; on a refusal the parent shows the
  // reason and the user stays on this transaction.
  const handlePrivate = async () => {
    if (!current) return;
    setLoading(true);
    try {
      await onBookPrivate(current.id);
      goNext();
    } catch {
      /* reported by the parent */
    } finally {
      setLoading(false);
    }
  };

  const handleLedger = async () => {
    const btwPercentage = btwKeuzeToPercentage(ledgerBtw);
    if (!current || !ledgerText || btwPercentage == null) return;
    setLoading(true);
    try {
      await onBookLedger(current.id, ledgerText, ledgerId, btwPercentage);
      goNext();
    } catch {
      /* reported by the parent */
    } finally {
      setLoading(false);
    }
  };

  const handleSkip = () => {
    if (!current) return;
    onSkip(current.id);
    setSkipped(prev => new Set([...prev, current.id]));
    if (currentIndex >= total - 1) setCurrentIndex(Math.max(0, total - 2));
  };

  // De veilige-matchpoort op het levende pad (nulmeting A1-04, C-14): alleen
  // facturen in de juiste richting, van deze administratie, met een openstaand
  // bedrag, niet afgewezen en met identiteit (factuurnummer of naam in de
  // omschrijving). Fail-closed zolang de afwijzingen niet geladen zijn.
  const candidates = useMemo(() => {
    if (!current || !rejectionIndex) return [];
    return gatedInvoiceCandidates(current, purchaseInvoices, salesInvoices, rejectionIndex);
  }, [current, purchaseInvoices, salesInvoices, rejectionIndex]);
  const shownCandidates = candidates.slice(0, 8);
  // Voorselectie alleen bij precies één kandidaat met de hoogste score; bij een
  // gelijke topscore kiest de gebruiker zelf (C-04).
  // Ook niet bij een deel- of overbetaling: de betaalschrijver legt dan maar een
  // deel vast (min(|bedrag|, open)) en de rest blijft open of ongealloceerd, dus
  // dan kiest de gebruiker bewust (review P2-1).
  const preselected = useMemo(
    () => (current ? preselectFullPaymentCandidate(candidates, current.amount) : null),
    [candidates, current],
  );
  const amountDiffers = !!current && !preselected && !!preselectCandidate(candidates);
  const tiedTop = hasTiedTopCandidates(candidates);
  const [choice, setChoice] = useState<{ txId: string; invoiceId: string } | null>(null);
  const selectedCandidate = current && choice?.txId === current.id
    ? shownCandidates.find((c) => c.id === choice.invoiceId) ?? null
    : preselected;
  const invoiceTotals = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const i of purchaseInvoices) m.set(`inkoop|${i.id}`, getInvoiceTotalAmount(i));
    for (const i of salesInvoices) m.set(`verkoop|${i.id}`, getInvoiceTotalAmount(i));
    return m;
  }, [purchaseInvoices, salesInvoices]);

  // Koppelen gebeurt pas na een bewuste keuze (of de enige beste kandidaat) en
  // een klik op "Koppelen". Wat er bij het koppelen met de factuur gebeurt, is
  // aan de aanroeper (het schrijfpad).
  const handleMatchSelected = async () => {
    if (!current || !selectedCandidate) return;
    setLoading(true);
    try {
      await onMatchInvoice(current.id, selectedCandidate.id, selectedCandidate.type);
      goNext();
    } catch (error) {
      toast({ title: "Factuurkoppeling mislukt", description: error instanceof Error ? error.message : "Probeer opnieuw", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

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
                onClick={openLedgerMode}
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
              <div className="space-y-1">
                <label htmlFor="verwerking-ledger-btw" className="text-sm font-medium">BTW *</label>
                <BtwKeuzeSelect id="verwerking-ledger-btw" value={ledgerBtw} onValueChange={setLedgerBtw} />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setMode("main")} className="flex-1">
                  Terug
                </Button>
                <Button
                  onClick={handleLedger}
                  disabled={!ledgerText || ledgerBtw === "" || loading}
                  className="flex-1"
                  data-testid="verwerking-ledger-submit"
                >
                  Coderen
                </Button>
              </div>
            </div>
          )}

          {mode === "factuur" && current && (
            <div className="space-y-3">
              <p className="text-sm font-medium">Koppel aan factuur:</p>
              {tiedTop && (
                <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="verwerking-tie">
                  Meerdere facturen passen even goed. Kies zelf de juiste factuur.
                </p>
              )}
              {amountDiffers && (
                <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="verwerking-amount-differs">
                  Het bedrag wijkt af van het openstaande bedrag (deel- of overbetaling). Kies zelf of deze factuur klopt.
                </p>
              )}
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {shownCandidates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Geen passende openstaande factuur gevonden: alleen facturen van deze administratie, in de juiste
                    richting, met een openstaand bedrag en met het factuurnummer of de naam in de omschrijving worden
                    voorgesteld. Koppel zo nodig via de bankregel zelf.
                  </p>
                ) : (
                  shownCandidates.map(inv => {
                    const remainingAmount = inv.amount;
                    const totalAmount = invoiceTotals.get(`${inv.type}|${inv.id}`) ?? null;
                    const isSelected = selectedCandidate?.id === inv.id;

                    return (
                      <button
                        key={inv.id}
                        type="button"
                        aria-pressed={isSelected}
                        className={`w-full text-left p-3 rounded-lg border transition-colors ${isSelected ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                        onClick={() => setChoice({ txId: current.id, invoiceId: inv.id })}
                        disabled={loading}
                      >
                        <div className="flex justify-between items-center">
                          <div>
                            <p className="text-sm font-medium">{inv.name}</p>
                            <p className="text-xs text-muted-foreground">{inv.invoiceNumber || "Geen nummer"}</p>
                            {remainingAmount != null && totalAmount != null && remainingAmount !== totalAmount && (
                              <p className="text-xs text-muted-foreground">Openstaand: {formatCurrency(remainingAmount)} van {formatCurrency(totalAmount)}</p>
                            )}
                            <p className="text-[11px] text-muted-foreground">{inv.reasons.join(" · ")}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-mono font-medium">{formatCurrency(remainingAmount ?? totalAmount ?? 0)}</p>
                            <Badge variant="outline" className="text-[10px]">{inv.type}</Badge>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setMode("main")} className="flex-1">
                  Terug
                </Button>
                <Button
                  onClick={handleMatchSelected}
                  disabled={!selectedCandidate || loading}
                  className="flex-1"
                  data-testid="verwerking-match-submit"
                >
                  Koppelen
                </Button>
              </div>
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
