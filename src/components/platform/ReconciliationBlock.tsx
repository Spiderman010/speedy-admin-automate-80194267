import { Fragment } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AccountingAmount } from "@/components/platform/AccountingAmount";

/**
 * Platform Kit — een aansluiting: een paar bedragen en de uitkomst eronder.
 *
 * Bijvoorbeeld beginsaldo + mutaties = eindsaldo, of debet / credit / netto,
 * of berekend − aangegeven = verschil.
 *
 * DEZE COMPONENT REKENT NIET. Zij telt de regels niet op, controleert niet of
 * ze bij de uitkomst passen en corrigeert niets. Elk getal komt kant-en-klaar
 * van de beller, en de beller blijft verantwoordelijk voor de berekening én
 * voor de uitspraak of het aansluit. Precies daarom kan deze component overal
 * worden gebruikt zonder dat er een tweede rekenmotor ontstaat: er zit er geen
 * in.
 *
 * `reconciled` is die uitspraak van de beller, niet een oordeel van deze
 * component. Is zij `false`, dan verschijnt `mismatchNotice` — en alleen dan,
 * en alleen als de beller er een meegeeft. Er wordt hier nooit een eigen
 * conclusie over de cijfers getrokken.
 */
export interface ReconciliationRow {
  label: ReactNode;
  /** Bedrag in hele centen, al berekend door de beller. */
  cents: number;
  testId?: string;
}

export interface ReconciliationBlockProps extends HTMLAttributes<HTMLDListElement> {
  /** De bijdragende regels, in de volgorde waarin ze gelezen moeten worden. */
  rows: readonly ReconciliationRow[];
  /**
   * De uitkomst. Meestal één regel; twee mag wanneer hetzelfde bedrag in twee
   * oriëntaties wordt getoond (grootboeksaldo naast rapportbedrag).
   */
  result: ReconciliationRow | readonly ReconciliationRow[];
  /** De uitspraak van de beller of het aansluit. Weglaten = geen uitspraak. */
  reconciled?: boolean;
  /** Wat er te zien is wanneer `reconciled === false`. */
  mismatchNotice?: ReactNode;
}

export function ReconciliationBlock({
  rows,
  result,
  reconciled,
  mismatchNotice,
  className,
  ...rest
}: ReconciliationBlockProps) {
  const results: readonly ReconciliationRow[] = Array.isArray(result)
    ? (result as readonly ReconciliationRow[])
    : [result as ReconciliationRow];
  return (
    <>
      <dl
        className={cn(
          "grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm",
          className,
        )}
        data-reconciled={reconciled === undefined ? undefined : String(reconciled)}
        {...rest}
      >
        {rows.map((row, index) => (
          <Fragment key={`row-${index}`}>
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-right">
              <AccountingAmount cents={row.cents} data-testid={row.testId} />
            </dd>
          </Fragment>
        ))}
        {results.map((row, index) => (
          <Fragment key={`result-${index}`}>
            <dt className="font-medium">{row.label}</dt>
            <dd className="text-right">
              <AccountingAmount cents={row.cents} emphasis data-testid={row.testId} />
            </dd>
          </Fragment>
        ))}
      </dl>
      {reconciled === false && mismatchNotice}
    </>
  );
}
