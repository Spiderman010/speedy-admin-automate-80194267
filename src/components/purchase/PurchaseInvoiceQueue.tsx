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
      className="min-w-0 self-start overflow-hidden rounded-md border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)] lg:col-span-2 xl:col-span-1 xl:col-start-1 xl:row-span-2 xl:row-start-1 xl:sticky xl:top-[3.75rem] xl:h-[calc(100dvh-8.5rem)]"
    >
      <div className="flex h-11 items-center justify-between border-b px-3">
        <h2 className="text-sm font-semibold text-foreground">Wachtrij</h2>
        <span className="rounded-sm border bg-card px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">{invoices.length}</span>
      </div>
      <div className="max-h-56 overflow-x-auto xl:h-[calc(100%-2.75rem)] xl:max-h-none xl:overflow-x-hidden xl:overflow-y-auto">
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
                  "h-auto min-h-[3.25rem] w-full md:h-auto justify-start rounded-none px-3 py-2 text-left font-normal hover:bg-muted/60",
                  active && "bg-primary/[0.06] shadow-[inset_2px_0_0_hsl(var(--primary))] hover:bg-primary/[0.08]",
                )}
              >
                <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5">
                  <span className="col-span-2 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
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
                  <Badge variant={statusVariant(item.status)} className="col-span-2 h-4 justify-self-start text-[10px] font-medium leading-none">
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