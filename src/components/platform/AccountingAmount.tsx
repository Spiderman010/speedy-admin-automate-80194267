import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/grootboek-saldi-utils";

/**
 * Platform Kit — één manier om een geldbedrag te tonen.
 *
 * DIT IS EEN WEERGAVECOMPONENT. Er wordt hier niet gerekend en er wordt geen
 * betekenis afgeleid:
 *
 *   - `cents` is al af. Het komt uit de kern (`ledger-reporting.ts`), uit de
 *     engine (`financial-statements.ts`) of uit een andere plek die de
 *     boekhoudkundige waarheid bepaalt. Hier wordt niet gedeeld, opgeteld of
 *     afgerond.
 *   - Er wordt NOOIT een teken omgeklapt. De enige plek die een grootboeksaldo
 *     naar een rapportbedrag oriënteert is `displayedCents()` in de engine; een
 *     tweede tekenmotor zou het hele punt van die ene zijn.
 *   - Er wordt NOOIT debet/credit afgeleid uit rekeningnummer, rekeningnaam of
 *     categorie. Weet de beller de oriëntatie, dan geeft die het juiste getal
 *     door; weet hij het niet, dan hoort hier geen bedrag te staan.
 *
 * De opmaak is die van de rest van de app: `formatCents` (nl-NL, euro, een
 * creditsaldo blijft negatief) in een monospace-cel met `tabular-nums`, zodat
 * bedragen onder elkaar uitlijnen.
 */
export interface AccountingAmountProps {
  /** Bedrag in hele centen, al berekend door de beller. */
  cents: number;
  /** Uitkomstregel: zwaarder gezet. */
  emphasis?: boolean;
  /** Bijzaak: gedempt gezet. */
  muted?: boolean;
  /**
   * Lege cel in plaats van "€ 0,00". Het bestaande idioom in debet- en
   * creditkolommen, waar een nul geen informatie is maar ruis.
   */
  blankWhenZero?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function AccountingAmount({
  cents,
  emphasis,
  muted,
  blankWhenZero,
  className,
  "data-testid": testId,
}: AccountingAmountProps) {
  const blank = blankWhenZero === true && cents === 0;
  return (
    <span
      className={cn(
        "whitespace-nowrap font-mono tabular-nums",
        emphasis === true && "font-semibold",
        muted === true && "text-muted-foreground",
        className,
      )}
      data-testid={testId}
    >
      {blank ? "" : formatCents(cents)}
    </span>
  );
}
