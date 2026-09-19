import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatEuro } from "@/lib/format";
import type { HeaderTotals, LineTotals, LineDiffs } from "@/lib/purchase-line-validation";

export type TotalsState = "green" | "amber" | "red";

/**
 * Compact status pill: one glance tells the user whether the booking lines
 * reconcile with the invoice. The state/message are computed by the page from
 * the existing validation helpers; this component only renders them.
 */
export function PurchaseInvoiceTotalsStatusPill({ state }: { state: TotalsState }) {
  const cfg =
    state === "green"
      ? { icon: CheckCircle2, label: "Sluit aan", cls: "border-green-500/60 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200" }
      : state === "red"
        ? { icon: XCircle, label: "Totalen ontbreken", cls: "border-destructive/50 bg-destructive/10 text-destructive" }
        : { icon: AlertTriangle, label: "Nog niet sluitend", cls: "border-amber-500/60 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" };
  const Icon = cfg.icon;
  return (
    <span
      data-totals-state={state}
      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", cfg.cls)}
    >
      <Icon className="h-3 w-3" /> {cfg.label}
    </span>
  );
}

export interface PurchaseInvoiceTotalsSummaryProps {
  header: HeaderTotals;
  lineTotals: LineTotals;
  diffs: LineDiffs;
  state: TotalsState;
  message: string;
}

/**
 * Factuur vs. boekingsregels vs. verschil, for excl / BTW / incl.
 * Semantics are unchanged: the per-column ok flags come straight from
 * computeLineDiffs (same tolerance), the banner state/message from the page.
 */
export function PurchaseInvoiceTotalsSummary({
  header, lineTotals, diffs, state, message,
}: PurchaseInvoiceTotalsSummaryProps) {
  const banner =
    state === "green" ? "border-green-500/50 bg-green-50 text-green-900 dark:bg-green-950/40 dark:text-green-200"
      : state === "amber" ? "border-amber-500/50 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      : "border-destructive/50 bg-destructive/10 text-destructive";
  const BannerIcon = state === "green" ? CheckCircle2 : state === "red" ? XCircle : AlertTriangle;

  const fmt = (n: number | null) => (n == null ? "—" : formatEuro(n));

  const diffCls = (d: number | null, ok: boolean) =>
    cn(
      "text-right font-mono tabular-nums",
      d == null ? "text-muted-foreground"
        : !ok ? "font-semibold text-amber-700 dark:text-amber-400"
        : "text-green-700 dark:text-green-400",
    );

  return (
    <div data-testid="totals-summary" data-totals-state={state} className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="w-[38%] py-1 text-left font-medium"><span className="sr-only">Regel</span></th>
              <th scope="col" className="py-1 text-right font-medium">Excl.</th>
              <th scope="col" className="py-1 text-right font-medium">BTW</th>
              <th scope="col" className="py-1 text-right font-medium">Incl.</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className="py-1 text-left font-normal text-muted-foreground">Factuur</th>
              <td className="py-1 text-right font-mono tabular-nums">{fmt(header.amount_excl)}</td>
              <td className="py-1 text-right font-mono tabular-nums">{fmt(header.btw_amount)}</td>
              <td className="py-1 text-right font-mono tabular-nums">{fmt(header.amount_incl)}</td>
            </tr>
            <tr>
              <th scope="row" className="py-1 text-left font-normal text-muted-foreground">Boekingsregels</th>
              <td className="py-1 text-right font-mono tabular-nums">{formatEuro(lineTotals.sumExcl)}</td>
              <td className="py-1 text-right font-mono tabular-nums">{formatEuro(lineTotals.sumBtw)}</td>
              <td className="py-1 text-right font-mono tabular-nums">{formatEuro(lineTotals.sumIncl)}</td>
            </tr>
            <tr className="border-t">
              <th scope="row" className="py-1.5 text-left font-medium">Verschil</th>
              <td className={cn("py-1.5", diffCls(diffs.excl, diffs.exclOk))}>{fmt(diffs.excl)}</td>
              <td className={cn("py-1.5", diffCls(diffs.btw, diffs.btwOk))}>{fmt(diffs.btw)}</td>
              <td className={cn("py-1.5", diffCls(diffs.incl, diffs.inclOk))}>{fmt(diffs.incl)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div role="status" className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", banner)}>
        <BannerIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message}</span>
      </div>
    </div>
  );
}
