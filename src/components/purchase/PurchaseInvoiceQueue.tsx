import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
      className="min-w-0 self-start overflow-hidden border-b bg-muted/20 lg:col-span-2 xl:col-span-1 xl:sticky xl:top-[4.5rem] xl:h-[calc(100dvh-8.5rem)] xl:border-b-0"
    >
      <div className="flex h-9 items-center justify-between border-b bg-muted/40 px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Wachtrij</h2>
        <span className="rounded-sm border bg-card px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">{invoices.length}</span>
      </div>
      <div className="max-h-56 overflow-x-auto xl:h-[calc(100%-2.25rem)] xl:max-h-none xl:overflow-x-hidden xl:overflow-y-auto">
        <nav className="grid grid-flow-col auto-cols-[minmax(14rem,1fr)] divide-x xl:grid-flow-row xl:auto-cols-auto xl:divide-x-0 xl:divide-y">
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
                  "h-auto min-h-[3.25rem] w-full md:h-auto justify-start rounded-none px-3 py-2 text-left font-normal hover:bg-accent/60",
                  active && "bg-card shadow-[inset_3px_0_0_hsl(var(--primary))] hover:bg-card [&_.queue-supplier]:text-primary",
                )}
              >
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex items-center gap-2">
                    <span className="queue-supplier min-w-0 flex-1 truncate text-[13px] font-semibold">
                      {item.supplier || "Onbekende leverancier"}
                    </span>
                    {amount != null && (
                      <span className="shrink-0 font-mono text-xs tabular-nums">{formatEuro(amount)}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {item.invoice_number || "Geen nummer"}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {item.invoice_date ? formatDatumNL(item.invoice_date) : "Geen datum"}
                    </span>
                  </span>
                  <Badge variant={statusVariant(item.status)} className="h-4 text-[10px] leading-none">
                    {statusLabel(item.status)}
                  </Badge>
                </span>
              </Button>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}