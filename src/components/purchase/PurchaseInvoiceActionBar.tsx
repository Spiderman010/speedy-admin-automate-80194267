import { Button } from "@/components/ui/button";
import { ArrowLeft, CheckCircle2, ChevronRight, Info, Loader2, Save } from "lucide-react";

export interface PurchaseInvoiceActionBarProps {
  canSave: boolean;
  canApprove: boolean;
  saving: boolean;
  hasNext: boolean;
  /**
   * Plain-language reasons why "Goedkeuren" is disabled, derived by the page
   * from the existing gate booleans. Empty when approving is allowed.
   */
  approveBlockers: string[];
  onCancel: () => void;
  onSave: () => void;
  onApprove: () => void;
  onNext: () => void;
}

/**
 * Sticky bottom action bar. `sticky` (not `fixed`) so it stays inside the
 * shell's content column: it never overlaps the sidebar and inherits the
 * page container's horizontal padding. Handlers and gates are the page's.
 */
export function PurchaseInvoiceActionBar({
  canSave, canApprove, saving, hasNext, approveBlockers,
  onCancel, onSave, onApprove, onNext,
}: PurchaseInvoiceActionBarProps) {
  const showBlockers = !canApprove && approveBlockers.length > 0;

  return (
    <div
      data-testid="action-bar"
      className="sticky bottom-0 z-30 -mx-4 -mb-6 mt-2 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6 lg:-mx-8 lg:-mb-8 lg:px-8"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {showBlockers && (
          <p
            id="approve-blockers"
            className="order-last flex items-start gap-1.5 text-xs text-muted-foreground sm:order-none sm:mr-auto"
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-medium text-foreground">Goedkeuren nog niet mogelijk:</span>{" "}
              {approveBlockers.join(" ")}
            </span>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Button variant="ghost" size="sm" onClick={onCancel} className="mr-auto sm:mr-0">
            <ArrowLeft className="mr-2 h-4 w-4" /> Annuleren
          </Button>
          <Button variant="outline" onClick={onSave} disabled={!canSave}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Opslaan
          </Button>
          <Button
            onClick={onApprove}
            disabled={!canApprove}
            aria-describedby={showBlockers ? "approve-blockers" : undefined}
          >
            <CheckCircle2 className="mr-2 h-4 w-4" /> Goedkeuren
          </Button>
          {hasNext && (
            <Button variant="secondary" onClick={onNext}>
              Volgende <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
