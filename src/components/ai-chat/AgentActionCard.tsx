import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatCurrency } from "@/lib/format";
import {
  STATUS_LABELS,
  lineTotals,
  type AgentAction,
} from "@/lib/agent-actions";

interface AgentActionCardProps {
  action: AgentAction;
  onConfirm: (actionId: string) => void;
  onCancel: (actionId: string) => void;
  onRetry: (actionId: string) => void;
  onClose: (actionId: string) => void;
}

function title(action: AgentAction) {
  return action.type === "change_purchase_invoice_status"
    ? "Status wijzigen"
    : "Boekingsregels opslaan";
}

export function AgentActionCard({
  action,
  onConfirm,
  onCancel,
  onRetry,
  onClose,
}: AgentActionCardProps) {
  const { invoice } = action.payload;
  const isBusy = action.status === "confirmed";
  const isOpen =
    action.status === "proposed" ||
    action.status === "awaiting_confirmation" ||
    action.status === "confirmed";

  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-sm font-semibold">{title(action)}</CardTitle>
        <Badge variant="secondary">Demo</Badge>
      </CardHeader>

      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
          <span className="text-muted-foreground">Factuur</span>
          <span className="font-medium">
            {invoice.leverancier} — {invoice.invoice_number}
          </span>

          {action.type === "change_purchase_invoice_status" ? (
            <>
              <span className="text-muted-foreground">Huidige status</span>
              <span>{STATUS_LABELS[action.payload.current_status]}</span>
              <span className="text-muted-foreground">Nieuwe status</span>
              <span className="font-medium">{STATUS_LABELS[action.payload.new_status]}</span>
            </>
          ) : (
            <>
              <span className="text-muted-foreground">Aantal regels</span>
              <span>{action.payload.lines.length}</span>
            </>
          )}
        </div>

        {action.type === "save_purchase_invoice_lines" && (
          <>
            <Separator />
            <div className="space-y-2">
              {action.payload.lines.map((line, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{line.omschrijving}</p>
                    <p className="text-xs text-muted-foreground">
                      Grootboek {line.grootboek} · BTW {line.btw_percentage}%
                    </p>
                  </div>
                  <span className="shrink-0 tabular-nums">{formatCurrency(line.amount_excl)}</span>
                </div>
              ))}
            </div>
            {(() => {
              const totals = lineTotals(action.payload.lines);
              return (
                <div className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
                  <span className="text-muted-foreground">Totaal excl.</span>
                  <span className="tabular-nums">{formatCurrency(totals.excl)}</span>
                  <span className="text-muted-foreground">BTW</span>
                  <span className="tabular-nums">{formatCurrency(totals.btw)}</span>
                  <span className="text-muted-foreground">Totaal incl.</span>
                  <span className="font-medium tabular-nums">{formatCurrency(totals.incl)}</span>
                </div>
              );
            })()}
          </>
        )}

        {isOpen && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Deze actie wijzigt boekhoudgegevens. In dit prototype wordt de actie alleen
              gesimuleerd.
            </span>
          </div>
        )}

        {action.status === "cancelled" && (
          <p className="text-xs text-muted-foreground">Actie geannuleerd.</p>
        )}

        {action.status === "success" && (
          <div className="flex items-center gap-2 text-sm text-primary">
            <CheckCircle2 className="h-4 w-4" />
            <span>Actie uitgevoerd (demo)</span>
          </div>
        )}

        {action.status === "error" && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="h-4 w-4" />
            <span>Actie kon niet worden uitgevoerd.</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {isOpen && (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={isBusy}
                onClick={() => onCancel(action.id)}
              >
                Annuleren
              </Button>
              <Button size="sm" disabled={isBusy} onClick={() => onConfirm(action.id)}>
                {isBusy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Bevestigen
              </Button>
            </>
          )}
          {action.status === "error" && (
            <>
              <Button variant="ghost" size="sm" onClick={() => onClose(action.id)}>
                Sluiten
              </Button>
              <Button size="sm" onClick={() => onRetry(action.id)}>
                Opnieuw proberen
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
