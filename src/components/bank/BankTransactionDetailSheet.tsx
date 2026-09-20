import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { FileSearch, Link2, Unlink, HelpCircle, CheckCircle2, X } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";
import type { BankTransactionAllocation } from "@/hooks/useBankTransactionAllocations";
import { parseMT940Description, getDisplayDescription } from "@/lib/mt940-description-parser";
import { BankTransactionPostingAction } from "@/components/bank/BankTransactionPostingAction";

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(amount);

const formatDate = (dateStr: string) =>
  new Date(dateStr).toLocaleDateString("nl-NL", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

type Grootboekrekening = { id: string; nummer: number; omschrijving: string };
type Vraagpost = { status: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: Tables<"bank_transactions"> | null;
  allocations: BankTransactionAllocation[];
  purchaseInvoices: Tables<"purchase_invoices">[];
  salesInvoices: Tables<"sales_invoices">[];
  grootboekrekeningen: Grootboekrekening[];
  vraagpost: Vraagpost | null;
  isSafe: boolean;
  onMatch: (tx: Tables<"bank_transactions">) => void;
  onConfirmSuggestion: (tx: Tables<"bank_transactions">) => void;
  onRejectSuggestion: (tx: Tables<"bank_transactions">) => void;
  onUnlink: (tx: Tables<"bank_transactions">) => void;
  onOpenAfletter: (tx: Tables<"bank_transactions">) => void;
  onMaakVraagpost: (tx: Tables<"bank_transactions">) => void;
};

function StatusBadge({ status }: { status: string }) {
  if (status === "gematcht") return <Badge>Gematcht</Badge>;
  if (status === "handmatig_geboekt") return <Badge variant="secondary">Handmatig geboekt</Badge>;
  if (status === "suggestie") return <Badge variant="secondary">Suggestie</Badge>;
  return <Badge variant="destructive">Open</Badge>;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 py-1.5 items-start">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

export function BankTransactionDetailSheet({
  open,
  onOpenChange,
  transaction: tx,
  allocations,
  purchaseInvoices,
  salesInvoices,
  grootboekrekeningen,
  vraagpost,
  isSafe,
  onMatch,
  onConfirmSuggestion,
  onRejectSuggestion,
  onUnlink,
  onOpenAfletter,
  onMaakVraagpost,
}: Props) {
  if (!tx) return null;

  const parsed = parseMT940Description(tx.description ?? "");
  const displayDesc = getDisplayDescription(tx.description ?? "");
  const isPositive = tx.amount >= 0;
  const isOpen = tx.match_status === "niet_gematcht" || tx.match_status === "suggestie";
  const isGematcht = tx.match_status === "gematcht";
  const isHandmatig = tx.match_status === "handmatig_geboekt";

  const linkedPurchase = tx.matched_invoice_id
    ? purchaseInvoices.find((i) => i.id === tx.matched_invoice_id)
    : null;
  const linkedSales = tx.matched_invoice_id
    ? salesInvoices.find((i) => i.id === tx.matched_invoice_id)
    : null;
  const linkedInvoice = linkedPurchase ?? linkedSales;

  const grootboek = tx.grootboekrekening_id
    ? grootboekrekeningen.find((g) => g.id === tx.grootboekrekening_id)
    : null;

  const totalAllocated = allocations.reduce((s, a) => s + a.amount, 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[480px] flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-base">Transactiedetails</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* Amount + status */}
          <div className="flex items-center justify-between">
            <span
              className={`text-2xl font-semibold font-mono ${
                isPositive ? "text-green-600" : "text-destructive"
              }`}
            >
              {formatCurrency(tx.amount)}
            </span>
            <StatusBadge status={tx.match_status ?? "niet_gematcht"} />
          </div>

          <Separator />

          {/* Core fields */}
          <div>
            <DetailRow label="Datum">
              {tx.transaction_date ? formatDate(tx.transaction_date) : "—"}
            </DetailRow>
            <DetailRow label="Omschrijving">{displayDesc || "—"}</DetailRow>
            {parsed.name && <DetailRow label="Naam">{parsed.name}</DetailRow>}
            {(tx.camt_counterparty_name || parsed.name) && !tx.camt_counterparty_name && null}
            {tx.camt_counterparty_name && (
              <DetailRow label="Tegenpartij">{tx.camt_counterparty_name}</DetailRow>
            )}
            {tx.counter_account && (
              <DetailRow label="Rekeningnummer">{tx.counter_account}</DetailRow>
            )}
            {tx.reference && <DetailRow label="Referentie">{tx.reference}</DetailRow>}
            {parsed.reference && !tx.reference && (
              <DetailRow label="Referentie">{parsed.reference}</DetailRow>
            )}
          </div>

          {/* Match confidence */}
          {tx.match_status === "suggestie" && tx.match_confidence != null && (
            <>
              <Separator />
              <DetailRow label="Betrouwbaarheid">
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-muted rounded-full h-1.5">
                    <div
                      className="bg-primary h-1.5 rounded-full"
                      style={{ width: `${tx.match_confidence}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono">{tx.match_confidence}%</span>
                </div>
              </DetailRow>
            </>
          )}

          {/* Linked invoice or grootboek */}
          {(linkedInvoice || grootboek || allocations.length > 0) && (
            <>
              <Separator />
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                  Koppeling
                </p>
                {linkedInvoice && (
                  <DetailRow label="Factuur">
                    {linkedPurchase
                      ? `Inkoopfactuur ${linkedPurchase.invoice_number ?? linkedPurchase.id}`
                      : `Verkoopfactuur ${(linkedInvoice as Tables<"sales_invoices">).invoice_number ?? linkedInvoice.id}`}
                  </DetailRow>
                )}
                {grootboek && (
                  <DetailRow label="Grootboek">
                    {String(grootboek.nummer)} — {grootboek.omschrijving}
                  </DetailRow>
                )}
                {allocations.length > 0 && (
                  <DetailRow label="Gealloceerd">
                    {formatCurrency(totalAllocated)} ({allocations.length} regel
                    {allocations.length !== 1 ? "s" : ""})
                  </DetailRow>
                )}
              </div>
            </>
          )}

          {/* Vraagpost */}
          {vraagpost && (
            <>
              <Separator />
              <DetailRow label="Vraagpost">
                {vraagpost.status === "opgelost" && (
                  <Badge className="bg-green-100 text-green-800 border-green-200">
                    Vraagpost opgelost
                  </Badge>
                )}
                {vraagpost.status === "genegeerd" && (
                  <Badge variant="secondary">Vraagpost genegeerd</Badge>
                )}
                {vraagpost.status !== "opgelost" && vraagpost.status !== "genegeerd" && (
                  <Badge className="bg-amber-100 text-amber-800 border-amber-200">
                    Vraagpost open
                  </Badge>
                )}
              </DetailRow>
            </>
          )}
        </div>

        {/* Action footer */}
        <div className="border-t px-6 py-4 space-y-2">
          {isHandmatig && (
            <div className="pb-2">
              <BankTransactionPostingAction
                transaction={tx}
                allocationCount={allocations.length}
              />
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => { onOpenAfletter(tx); onOpenChange(false); }}
          >
            <FileSearch className="mr-2 h-4 w-4" />
            Afletterdetails bekijken
          </Button>

          {tx.match_status === "suggestie" && (
            <>
              <Button
                variant={isSafe ? "default" : "outline"}
                size="sm"
                className="w-full justify-start"
                onClick={() => { onConfirmSuggestion(tx); onOpenChange(false); }}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {isSafe ? "Bevestig (veilig)" : "Controleer & bevestig"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-foreground"
                onClick={() => { onRejectSuggestion(tx); onOpenChange(false); }}
              >
                <X className="mr-2 h-4 w-4" />
                Suggestie afwijzen
              </Button>
            </>
          )}

          {isOpen && tx.match_status !== "suggestie" && (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => { onMatch(tx); onOpenChange(false); }}
            >
              <Link2 className="mr-2 h-4 w-4" />
              Koppelen aan factuur
            </Button>
          )}

          {(isGematcht || isHandmatig) && (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => { onUnlink(tx); onOpenChange(false); }}
            >
              <Unlink className="mr-2 h-4 w-4" />
              Ontkoppelen
            </Button>
          )}

          {isOpen && !vraagpost && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground"
              onClick={() => { onMaakVraagpost(tx); onOpenChange(false); }}
            >
              <HelpCircle className="mr-2 h-4 w-4" />
              Vraagpost aanmaken
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
