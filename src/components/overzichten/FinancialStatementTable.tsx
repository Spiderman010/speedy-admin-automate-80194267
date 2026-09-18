import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { accountLabel, formatCents } from "@/lib/financial-statements-presentation";
import type {
  FinancialStatementGroup,
  FinancialStatementSystemLine,
} from "@/lib/financial-statements";

/**
 * Balans/W&V PR 4 — een gegroepeerd jaarrekeningoverzicht als tabel.
 * Balans/W&V PR 5 — dichtere regels en een duidelijker hiërarchie.
 *
 * Puur presentatie. Elk bedrag komt kant-en-klaar uit de engine
 * (`displayedCents`, `totalCents`); hier wordt niet opgeteld, niet gesorteerd en
 * niet omgeklapt — de volgorde binnen een groep is die van `compareStatementLines`
 * en de groepsvolgorde die van de engine.
 *
 * Hiërarchie, van licht naar zwaar: rekeningregel → subtotaal → eindtotaal.
 * Elke groep is een eigen `<tbody>` met een `<th scope="rowgroup">` als kop,
 * zodat een schermlezer die kop aan de regels eronder koppelt in plaats van
 * hem als lege cel voor te lezen.
 *
 * Systeemregels (resultaatregels) zijn geen grootboekrekening: ze krijgen een
 * eigen opmaak, geen rekeningnummer en NOOIT een drilldown-link.
 */

/** Dichte, maar nog aanklikbare regelhoogte voor een financieel overzicht. */
const CELL = "px-3 py-1.5";

export interface FinancialStatementTableProps {
  /** De koptekst boven deze kolom, bv. "Activa". */
  caption: string;
  groups: readonly FinancialStatementGroup[];
  /** Presentatieregels die onder de groepen horen (alleen de balans heeft die). */
  systemLines?: readonly FinancialStatementSystemLine[];
  totalLabel: string;
  totalCents: number;
  testId?: string;
  accountPath?: (accountId: string) => string;
}

export function FinancialStatementTable({
  caption,
  groups,
  systemLines = [],
  totalLabel,
  totalCents,
  testId,
  accountPath = (id) => `/grootboek/saldi/${id}`,
}: FinancialStatementTableProps) {
  return (
    // Horizontaal scrollen binnen de container, nooit de hele pagina.
    <div className="-mx-1 overflow-x-auto px-1">
      <Table className="min-w-[440px]" data-testid={testId}>
        <caption className="sr-only">
          {caption}: per groep de grootboekrekeningen met hun bedrag in euro, gevolgd door het groepstotaal.
        </caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className={cn(CELL, "w-20")}>Rekening</TableHead>
            <TableHead scope="col" className={cn(CELL, "min-w-[180px]")}>Omschrijving</TableHead>
            <TableHead scope="col" className={cn(CELL, "w-36 text-right")}>Bedrag</TableHead>
          </TableRow>
        </TableHeader>
        {groups.map((group) => (
          <GroupRows key={group.key} group={group} accountPath={accountPath} />
        ))}

        <TableBody>
          {systemLines.map((line) => (
            <TableRow
              key={line.kind}
              data-testid="statement-system-line"
              data-system-line={line.kind}
              // Zichtbaar anders dan een rekeningregel, maar bewust rustiger
              // dan een subtotaal: het is een toelichtende regel, geen bron.
              className="border-dashed bg-muted/20 hover:bg-muted/20"
            >
              {/* Geen rekeningnummer: dit ís geen grootboekrekening. Zelfde
                  streepje als de kolom elders gebruikt, decoratief voor een
                  schermlezer. */}
              <TableCell className={cn(CELL, "font-mono text-xs text-muted-foreground")}>
                <span aria-hidden="true">—</span>
              </TableCell>
              <TableCell className={CELL}>
                <span className="italic text-muted-foreground">{line.label}</span>
                <Badge variant="outline" className="ml-2 align-middle text-xs font-normal">
                  Berekend
                </Badge>
              </TableCell>
              <Bedrag cents={line.displayedCents} />
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow
            className="border-t-2 border-foreground/20 bg-transparent hover:bg-transparent"
            data-testid="statement-total"
          >
            <TableCell colSpan={2} className={cn(CELL, "text-sm font-semibold uppercase tracking-wide")}>
              {totalLabel}
            </TableCell>
            <Bedrag cents={totalCents} strong />
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function GroupRows({
  group,
  accountPath,
}: {
  group: FinancialStatementGroup;
  accountPath: (accountId: string) => string;
}) {
  return (
    // Eigen <tbody> per groep: dan is de kop een rowgroup-kop die een
    // schermlezer werkelijk aan de regels eronder koppelt.
    <TableBody>
      <TableRow className="border-0 bg-muted/30 hover:bg-muted/30" data-testid="statement-group" data-group={group.key}>
        <th
          scope="rowgroup"
          colSpan={3}
          className={cn(CELL, "text-left text-xs font-semibold uppercase tracking-wide text-foreground")}
        >
          {group.label}
        </th>
      </TableRow>

      {group.lines.map((line) => (
        <TableRow
          key={line.accountId}
          data-testid="statement-line"
          data-account-id={line.accountId}
          className="border-b-0 focus-within:bg-muted/40 hover:bg-muted/40"
        >
          <TableCell className={cn(CELL, "font-mono text-xs tabular-nums text-muted-foreground")}>
            {line.accountNumber ?? "—"}
          </TableCell>
          <TableCell className={cn(CELL, "max-w-[280px]")}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <Link
                to={accountPath(line.accountId)}
                className="min-w-0 break-words rounded-sm underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open mutaties van ${accountLabel(line.accountNumber, line.accountName)}`}
              >
                {line.accountName}
              </Link>
              {line.isContra && (
                <Badge
                  variant="outline"
                  className="text-xs font-normal"
                  title="Deze rekening staat tegengesteld aan haar kolom en gaat er dus van af."
                >
                  Tegenrekening
                </Badge>
              )}
            </div>
          </TableCell>
          <Bedrag cents={line.displayedCents} />
        </TableRow>
      ))}

      {group.lines.length === 0 && (
        <TableRow className="border-b-0 hover:bg-transparent">
          <TableCell colSpan={3} className={cn(CELL, "text-xs italic text-muted-foreground")}>
            Geen rekeningen in deze groep.
          </TableCell>
        </TableRow>
      )}

      <TableRow
        className="border-t hover:bg-transparent"
        data-testid="statement-group-total"
        data-group={group.key}
      >
        <TableCell className={CELL} />
        <TableCell className={cn(CELL, "text-sm font-medium")}>Subtotaal {group.label}</TableCell>
        <Bedrag cents={group.totalCents} emphasis />
      </TableRow>
    </TableBody>
  );
}

function Bedrag({
  cents,
  emphasis,
  strong,
}: {
  cents: number;
  emphasis?: boolean;
  strong?: boolean;
}) {
  return (
    <TableCell
      className={cn(
        CELL,
        // tabular-nums houdt de cijferkolom uitgelijnd; whitespace-nowrap
        // voorkomt dat een bedrag over twee regels breekt.
        "whitespace-nowrap text-right font-mono text-sm tabular-nums",
        emphasis && "font-medium",
        strong && "text-base font-bold",
      )}
    >
      {formatCents(cents)}
    </TableCell>
  );
}
