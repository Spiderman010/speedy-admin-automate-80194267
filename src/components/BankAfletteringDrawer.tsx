import { useMemo, useState, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, Info, Landmark } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";
import type { BankTransactionAllocation } from "@/hooks/useBankTransactionAllocations";
import { getInvoiceTotalAmount, getInvoiceRemainingAmount } from "@/lib/invoice-balances";
import { parseMT940Description, getDisplayDescription } from "@/lib/mt940-description-parser";
import { rankCandidates } from "@/components/BankMatchDialog";
import type { InvoiceCandidate } from "@/components/BankMatchDialog";

const fmt = (amount: number | null | undefined): string =>
  amount == null
    ? "—"
    : new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

type SuggestionFilter = "auto" | "verkoop" | "inkoop" | "alle";

// Direction that "makes sense" for a given transaction amount.
function preferredType(txAmount: number): "inkoop" | "verkoop" {
  return txAmount < 0 ? "inkoop" : "verkoop";
}

export interface BankAfletteringDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: Tables<"bank_transactions"> | null;
  /** Allocation rows for this specific transaction (allocationsByTxId.get(tx.id) ?? []). */
  allocations: BankTransactionAllocation[];
  /** Full allocation list — passed in but not used directly in v1 (reserved for future phases). */
  allAllocations: BankTransactionAllocation[];
  purchaseInvoices: Tables<"purchase_invoices">[];
  salesInvoices: Tables<"sales_invoices">[];
}

export function BankAfletteringDrawer({
  open,
  onOpenChange,
  transaction,
  allocations,
  purchaseInvoices,
  salesInvoices,
}: BankAfletteringDrawerProps) {
  // ── Filter chip state ────────────────────────────────────────────────
  const [suggestionFilter, setSuggestionFilter] = useState<SuggestionFilter>("auto");

  // Reset filter to Auto whenever the active transaction changes.
  useEffect(() => {
    setSuggestionFilter("auto");
  }, [transaction?.id]);

  // ── Derived amounts ──────────────────────────────────────────────────
  const txAmount = transaction ? Math.abs(transaction.amount) : 0;

  const allocatedTotal = useMemo(
    () => allocations.reduce((sum, a) => sum + a.amount, 0),
    [allocations],
  );

  const remaining = Math.max(0, txAmount - allocatedTotal);
  const isOverAllocated = allocatedTotal > txAmount + 0.01;
  const fillPct = txAmount > 0 ? Math.min(100, (allocatedTotal / txAmount) * 100) : 0;

  // ── Parsed description ───────────────────────────────────────────────
  const parsed = useMemo(
    () => (transaction ? parseMT940Description(transaction.description) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transaction?.id],
  );

  // ── Legacy matched_invoice_id detection ──────────────────────────────
  const hasLegacy = !!transaction?.matched_invoice_id && allocations.length === 0;

  const legacyInvoice = useMemo(() => {
    if (!hasLegacy || !transaction?.matched_invoice_id) return null;
    return (
      purchaseInvoices.find(i => i.id === transaction.matched_invoice_id) ??
      salesInvoices.find(i => i.id === transaction.matched_invoice_id) ??
      null
    );
  }, [hasLegacy, transaction?.matched_invoice_id, purchaseInvoices, salesInvoices]);

  const legacyIsPurchase = hasLegacy && legacyInvoice
    ? purchaseInvoices.some(i => i.id === legacyInvoice.id)
    : false;

  // ── Invoice IDs already covered (for suggestion exclusion) ───────────
  const coveredInvoiceIds = useMemo(() => {
    const ids = new Set(allocations.map(a => a.invoice_id));
    if (transaction?.matched_invoice_id) ids.add(transaction.matched_invoice_id);
    return ids;
  }, [allocations, transaction?.matched_invoice_id]);

  // ── Suggestions ──────────────────────────────────────────────────────
  const showSuggestions =
    !!transaction &&
    transaction.match_status !== "handmatig_geboekt" &&
    !isOverAllocated &&
    remaining >= 0.01;

  const rawSuggestions = useMemo(() => {
    if (!showSuggestions || !transaction) return [];
    return rankCandidates(transaction, purchaseInvoices, salesInvoices)
      .filter(c => c.score > 0 && !coveredInvoiceIds.has(c.id));
  }, [showSuggestions, transaction, purchaseInvoices, salesInvoices, coveredInvoiceIds]);

  // Apply direction filter and sort same-direction first in "alle" mode.
  const suggestions = useMemo(() => {
    if (!transaction) return [];
    const pref = preferredType(transaction.amount);

    if (suggestionFilter === "auto") {
      return rawSuggestions.filter(c => c.type === pref).slice(0, 8);
    }
    if (suggestionFilter === "verkoop") {
      return rawSuggestions.filter(c => c.type === "verkoop").slice(0, 8);
    }
    if (suggestionFilter === "inkoop") {
      return rawSuggestions.filter(c => c.type === "inkoop").slice(0, 8);
    }
    // "alle": same-direction first, then opposite; cap at 8 total
    const same = rawSuggestions.filter(c => c.type === pref);
    const opposite = rawSuggestions.filter(c => c.type !== pref);
    return [...same, ...opposite].slice(0, 8);
  }, [rawSuggestions, suggestionFilter, transaction]);

  if (!transaction) return null;

  const displayDesc = getDisplayDescription(transaction.description, {
    counterAccount: transaction.counter_account,
    reference: transaction.reference,
  });
  const counterAccount = transaction.counter_account ?? parsed?.iban ?? null;
  const pref = preferredType(transaction.amount);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[520px] flex flex-col p-0 gap-0 overflow-hidden"
      >
        {/* ── Sticky header ─────────────────────────────────────────── */}
        <div className="shrink-0 border-b">
          <SheetHeader className="px-6 pt-6 pb-3 pr-12">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Landmark className="h-4 w-4 text-muted-foreground shrink-0" />
              Bankaflettering
            </SheetTitle>
          </SheetHeader>

          {/* Transaction identity */}
          <div className="px-6 pb-3 space-y-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium truncate">{displayDesc}</span>
              <span
                className={`font-mono text-sm font-semibold shrink-0 ${
                  transaction.amount < 0 ? "text-destructive" : "text-green-600"
                }`}
              >
                {fmt(transaction.amount)}
              </span>
            </div>
            <div className="text-xs text-muted-foreground space-y-0.5">
              <div>
                {new Date(transaction.transaction_date).toLocaleDateString("nl-NL", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </div>
              {parsed?.name && parsed.name !== displayDesc && <div>{parsed.name}</div>}
              {counterAccount && <div className="font-mono">{counterAccount}</div>}
              {parsed?.reference && <div>Ref: {parsed.reference}</div>}
            </div>
          </div>

          {/* Allocation summary bar */}
          <div className="px-6 pb-4">
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2.5">
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div>
                  <p className="text-muted-foreground mb-0.5">Bedrag</p>
                  <p className="font-mono font-medium">{fmt(txAmount)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Gealloceerd</p>
                  <p className={`font-mono font-medium ${isOverAllocated ? "text-destructive" : ""}`}>
                    {fmt(allocatedTotal)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-0.5">Resterend</p>
                  <p
                    className={`font-mono font-medium ${
                      isOverAllocated
                        ? "text-destructive"
                        : remaining > 0.01
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-green-600"
                    }`}
                  >
                    {fmt(remaining)}
                  </p>
                </div>
              </div>

              <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    isOverAllocated
                      ? "bg-destructive"
                      : remaining < 0.01
                      ? "bg-green-500"
                      : "bg-amber-500"
                  }`}
                  style={{ width: `${fillPct}%` }}
                />
              </div>

              <div className="flex justify-center">
                {isOverAllocated ? (
                  <Badge variant="destructive" className="text-[11px]">Overallocatie</Badge>
                ) : remaining < 0.01 ? (
                  <Badge className="text-[11px] bg-green-600 hover:bg-green-700">Volledig gealloceerd</Badge>
                ) : allocatedTotal < 0.01 ? (
                  <Badge variant="secondary" className="text-[11px]">Niet gealloceerd</Badge>
                ) : (
                  <Badge
                    variant="secondary"
                    className="text-[11px] bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 hover:bg-amber-100"
                  >
                    Deelallocatie
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Scrollable body ───────────────────────────────────────── */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-5 space-y-6">

            {/* ── Koppelingen ──────────────────────────────────────── */}
            <section>
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                Koppelingen
                {allocations.length > 0 && (
                  <Badge variant="secondary" className="text-[11px] font-mono">
                    {allocations.length}
                  </Badge>
                )}
              </h3>

              {allocations.length === 0 && !hasLegacy ? (
                <p className="text-sm text-muted-foreground">Nog geen koppelingen.</p>
              ) : (
                <div className="space-y-2">
                  {allocations.map(alloc => {
                    const isPurchase = alloc.invoice_type === "inkoop";
                    const inv = isPurchase
                      ? purchaseInvoices.find(i => i.id === alloc.invoice_id)
                      : salesInvoices.find(i => i.id === alloc.invoice_id);

                    if (!inv) {
                      return (
                        <AllocationCard
                          key={alloc.id}
                          label={isPurchase ? "Inkoopfactuur" : "Verkoopfactuur"}
                          invoiceNumber={alloc.invoice_id}
                          relation="Factuur niet gevonden"
                          invoiceTotal={null}
                          invoiceRemaining={null}
                          allocated={alloc.amount}
                          warning
                        />
                      );
                    }

                    const relation = isPurchase
                      ? (inv as Tables<"purchase_invoices">).supplier
                      : (inv as Tables<"sales_invoices">).customer_name;
                    const invoiceNumber = isPurchase
                      ? (inv as Tables<"purchase_invoices">).invoice_number
                      : (inv as Tables<"sales_invoices">).invoice_number;

                    return (
                      <AllocationCard
                        key={alloc.id}
                        label={isPurchase ? "Inkoopfactuur" : "Verkoopfactuur"}
                        invoiceNumber={invoiceNumber}
                        relation={relation}
                        invoiceTotal={getInvoiceTotalAmount(inv)}
                        invoiceRemaining={getInvoiceRemainingAmount(inv)}
                        allocated={alloc.amount}
                      />
                    );
                  })}

                  {hasLegacy && transaction.matched_invoice_id && (
                    <LegacyCard
                      invoiceId={transaction.matched_invoice_id}
                      invoice={legacyInvoice}
                      isPurchase={legacyIsPurchase}
                    />
                  )}
                </div>
              )}
            </section>

            {/* ── Suggesties ───────────────────────────────────────── */}
            {showSuggestions && (
              <>
                <Separator />
                <section>
                  <div className="flex items-baseline justify-between gap-2 mb-2">
                    <h3 className="text-sm font-semibold flex items-baseline gap-2">
                      Suggesties
                      <span className="text-xs font-normal text-muted-foreground">
                        voor resterend {fmt(remaining)}
                      </span>
                    </h3>
                  </div>

                  {/* Filter chips */}
                  <div className="flex items-center gap-1.5 mb-3 flex-wrap">
                    {(["auto", "verkoop", "inkoop", "alle"] as SuggestionFilter[]).map(f => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setSuggestionFilter(f)}
                        className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                          suggestionFilter === f
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background text-muted-foreground hover:border-foreground/20 hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {f === "auto"
                          ? `Auto (${pref === "verkoop" ? "Verkoop" : "Inkoop"})`
                          : f.charAt(0).toUpperCase() + f.slice(1)}
                      </button>
                    ))}
                  </div>

                  <p className="text-xs text-muted-foreground mb-3">
                    Gebruik de koppeldialoog om een factuur te koppelen.
                  </p>

                  {suggestions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {transaction?.client_id
                        ? "Geen passende openstaande facturen gevonden."
                        : "Kies eerst een klant op deze bankregel om facturen te tonen."}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {suggestions.map(c => (
                        <SuggestionCard
                          key={c.id}
                          candidate={c}
                          oppositeDirection={suggestionFilter === "alle" && c.type !== pref}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}

            {/* ── Handmatig geboekt note ────────────────────────────── */}
            {transaction.match_status === "handmatig_geboekt" && (
              <>
                <Separator />
                <section>
                  <h3 className="text-sm font-semibold mb-2">Handmatig geboekt</h3>
                  <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                    <Info className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>
                      Transactie is geboekt op een grootboekrekening. Geen factuursuggesties
                      beschikbaar. Gebruik &ldquo;Ontkoppelen&rdquo; om de koppeling te verwijderen.
                    </span>
                  </div>
                </section>
              </>
            )}

          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// ── Internal sub-components ─────────────────────────────────────────────

interface AllocationCardProps {
  label: string;
  invoiceNumber: string | null;
  relation: string;
  invoiceTotal: number | null;
  invoiceRemaining: number | null;
  allocated: number;
  warning?: boolean;
}

function AllocationCard({
  label,
  invoiceNumber,
  relation,
  invoiceTotal,
  invoiceRemaining,
  allocated,
  warning = false,
}: AllocationCardProps) {
  return (
    <div
      className={`rounded-lg border p-3 text-sm space-y-2 ${
        warning
          ? "border-amber-400/60 bg-amber-50 dark:bg-amber-950/20"
          : "bg-muted/20"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {warning && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
          <Badge variant="outline" className="text-[10px] shrink-0">
            {label}
          </Badge>
          <span className="font-medium truncate">{relation}</span>
        </div>
        <span className="font-mono font-semibold text-green-700 dark:text-green-400 shrink-0">
          {fmt(allocated)}
        </span>
      </div>

      {invoiceNumber && (
        <div className="text-xs text-muted-foreground">#{invoiceNumber}</div>
      )}

      {(invoiceTotal != null || invoiceRemaining != null) && (
        <div className="grid grid-cols-2 gap-2 text-xs pt-1.5 border-t border-border/50">
          <div>
            <p className="text-muted-foreground">Factuurbedrag</p>
            <p className="font-mono">{fmt(invoiceTotal)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Openstaand</p>
            <p
              className={`font-mono ${
                invoiceRemaining != null && invoiceRemaining < 0.01
                  ? "text-green-600"
                  : "text-amber-600 dark:text-amber-400"
              }`}
            >
              {fmt(invoiceRemaining)}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

interface LegacyCardProps {
  invoiceId: string;
  invoice: Tables<"purchase_invoices"> | Tables<"sales_invoices"> | null;
  isPurchase: boolean;
}

function LegacyCard({ invoiceId, invoice, isPurchase }: LegacyCardProps) {
  const relation = invoice
    ? isPurchase
      ? (invoice as Tables<"purchase_invoices">).supplier
      : (invoice as Tables<"sales_invoices">).customer_name
    : null;
  const invoiceNumber = invoice
    ? isPurchase
      ? (invoice as Tables<"purchase_invoices">).invoice_number
      : (invoice as Tables<"sales_invoices">).invoice_number
    : null;

  return (
    <div className="rounded-lg border border-amber-400/60 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
        <Badge
          variant="outline"
          className="text-[10px] shrink-0 border-amber-400/60 text-amber-800 dark:text-amber-300"
        >
          Migratie-koppeling
        </Badge>
        {relation ? (
          <span className="font-medium truncate">{relation}</span>
        ) : (
          <span className="text-muted-foreground font-mono text-xs truncate">{invoiceId}</span>
        )}
      </div>

      {invoiceNumber && (
        <div className="text-xs text-muted-foreground">#{invoiceNumber}</div>
      )}

      <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
        <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <span>
          Geen allocatierij aanwezig. Gebruik &ldquo;Herbereken aflettering&rdquo; om bij te
          werken.
        </span>
      </div>
    </div>
  );
}

interface SuggestionCardProps {
  candidate: InvoiceCandidate;
  oppositeDirection?: boolean;
}

function SuggestionCard({ candidate: c, oppositeDirection = false }: SuggestionCardProps) {
  const scoreClass =
    oppositeDirection
      ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
      : c.score >= 80
      ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300"
      : c.score >= 50
      ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
      : "bg-muted text-muted-foreground";

  return (
    <div
      className={`rounded-lg border p-3 text-sm space-y-2 ${
        oppositeDirection
          ? "border-amber-400/60 bg-amber-50/60 dark:bg-amber-950/20"
          : "bg-muted/20"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span
            className={`text-[10px] font-semibold font-mono px-1.5 py-0.5 rounded shrink-0 ${scoreClass}`}
          >
            {c.score}%
          </span>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {c.type === "inkoop" ? "Inkoop" : "Verkoop"}
          </Badge>
          {oppositeDirection && (
            <Badge
              variant="outline"
              className="text-[10px] shrink-0 border-amber-400/60 text-amber-800 dark:text-amber-300"
            >
              <AlertTriangle className="h-2.5 w-2.5 mr-1" />
              Tegengestelde richting
            </Badge>
          )}
          <span className="font-medium truncate">{c.name}</span>
        </div>
        <span className="font-mono text-xs font-medium shrink-0 text-right">{fmt(c.amount)}</span>
      </div>

      {c.invoiceNumber && (
        <div className="text-xs text-muted-foreground">#{c.invoiceNumber}</div>
      )}

      {c.reasons.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {c.reasons.map(r => (
            <Badge
              key={r}
              variant={r === "Exact bedrag" ? "default" : "secondary"}
              className="text-[10px]"
            >
              {r}
            </Badge>
          ))}
          {c.isPartialPayment && c.remainingAmount != null && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
              → resterend {fmt(c.remainingAmount)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
