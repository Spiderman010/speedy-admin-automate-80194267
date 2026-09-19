import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDatumNL, formatEuro } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Tables } from "@/integrations/supabase/types";

type QueueInvoice = Pick<
  Tables<"purchase_invoices">,
  "id" | "supplier" | "invoice_number" | "invoice_date" | "amount_incl" | "amount_excl" | "status"
>;

function statusLabel(status: string) {
  if (status === "gecontroleerd") return "Gecontroleerd";
  if (status === "geexporteerd") return "Geëxporteerd";
  if (status === "betaald") return "Betaald";
  return "Te controleren";
}

function statusVariant(status: string): "success" | "outline" | "secondary" {
  if (status === "gecontroleerd" || status === "betaald") return "success";
  if (status === "geexporteerd") return "outline";
  return "secondary";
}

export function PurchaseInvoiceQueue({
  invoices,
  activeInvoiceId,
  onSelect,
}: {
  invoices: QueueInvoice[];
  activeInvoiceId: string;
  onSelect: (invoiceId: string) => void;
}) {
  return (
    <aside
      data-testid="invoice-queue"
      aria-label="Factuurwachtrij"
      className="min-w-0 overflow-hidden rounded-md border bg-card min-[1360px]:sticky min-[1360px]:top-[4.5rem] min-[1360px]:h-[calc(100dvh-6.5rem)]"
    >
      <div className="flex h-11 items-center justify-between border-b px-3">
        <h2 className="text-sm font-semibold">Wachtrij</h2>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{invoices.length}</span>
      </div>
      <ScrollArea className="max-h-56 min-[1360px]:h-[calc(100%-2.75rem)] min-[1360px]:max-h-none">
        <nav className="grid grid-flow-col auto-cols-[minmax(14rem,1fr)] gap-1 p-1.5 min-[1360px]:grid-flow-row min-[1360px]:auto-cols-auto">
          {invoices.map((item) => {
            const active = item.id === activeInvoiceId;
            const amount = item.amount_incl ?? item.amount_excl;
            return (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                aria-current={active ? "page" : undefined}
                onClick={() => onSelect(item.id)}
                className={cn(
                  "h-auto min-h-[4.5rem] w-full justify-start rounded-md border border-transparent px-2.5 py-2 text-left",
                  active && "border-primary/35 bg-primary/10 hover:bg-primary/15",
                )}
              >
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                      {item.supplier || "Onbekende leverancier"}
                    </span>
                    {amount != null && (
                      <span className="shrink-0 font-mono text-xs tabular-nums">{formatEuro(amount)}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {item.invoice_number || "Geen nummer"}
                    </span>
                    <span className="shrink-0">
                      {item.invoice_date ? formatDatumNL(item.invoice_date) : "Geen datum"}
                    </span>
                  </span>
                  <Badge variant={statusVariant(item.status)} className="h-5 text-[10px] leading-none">
                    {statusLabel(item.status)}
                  </Badge>
                </span>
              </Button>
            );
          })}
        </nav>
      </ScrollArea>
    </aside>
  );
}