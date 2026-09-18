import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { accountLabel, formatEuroCents } from "@/lib/financial-statements-presentation";
import type {
  FinancialStatementGroup,
  FinancialStatementSystemLine,
} from "@/lib/financial-statements";

/**
 * Balans/W&V PR 4 — een gegroepeerd jaarrekeningoverzicht als tabel.
 *
 * Puur presentatie. Elk bedrag komt kant-en-klaar uit de engine
 * (`displayedCents`, `totalCents`); hier wordt niet opgeteld, niet gesorteerd en
 * niet omgeklapt — de volgorde binnen een groep is die van `compareStatementLines`
 * en de groepsvolgorde die van de engine.
 *
 * Systeemregels (resultaatregels) zijn geen grootboekrekening: ze krijgen een
 * eigen opmaak, geen rekeningnummer en NOOIT een drilldown-link.
 */

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
      <Table className="min-w-[520px]" data-testid={testId}>
        <caption className="sr-only">
          {caption}: per groep de grootboekrekeningen met hun bedrag in euro, gevolgd door het groepstotaal.
        </caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="w-24">Rekening</TableHead>
            <TableHead scope="col" className="min-w-[220px]">Omschrijving</TableHead>
            <TableHead scope="col" className="w-32 text-right">Bedrag</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group) => (
            <GroupRows key={group.key} group={group} accountPath={accountPath} />
          ))}

          {systemLines.map((line) => (
            <TableRow
              key={line.kind}
              data-testid="statement-system-line"
              data-system-line={line.kind}
              className="bg-muted/40 hover:bg-muted/40"
            >
              {/* Geen rekeningnummer: dit ís geen grootboekrekening. */}
              <TableCell className="text-muted-foreground">—</TableCell>
              <TableCell>
                <span className="font-medium italic">{line.label}</span>
                <Badge variant="outline" className="ml-2 font-normal">Berekend</Badge>
              </TableCell>
              <Bedrag cents={line.displayedCents} />
            </TableRow>
          ))}
        </TableBody>
        <tfoot>
          <TableRow className="border-t-2 font-semibold hover:bg-transparent" data-testid="statement-total">
            <TableCell colSpan={2}>{totalLabel}</TableCell>
            <Bedrag cents={totalCents} />
          </TableRow>
        </tfoot>
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
    <>
      <TableRow className="hover:bg-transparent" data-testid="statement-group" data-group={group.key}>
        <TableCell colSpan={3} className="pt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {group.label}
        </TableCell>
      </TableRow>

      {group.lines.map((line) => (
        <TableRow key={line.accountId} data-testid="statement-line" data-account-id={line.accountId}>
          <TableCell className="font-mono tabular-nums">{line.accountNumber ?? "—"}</TableCell>
          <TableCell className="max-w-[320px]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link
                to={accountPath(line.accountId)}
                className="truncate underline-offset-4 hover:underline focus-visible:underline"
                aria-label={`Open mutaties van ${accountLabel(line.accountNumber, line.accountName)}`}
              >
                {line.accountName}
              </Link>
              {line.isContra && (
                <Badge variant="outline" className="font-normal" title="Deze rekening staat tegengesteld aan haar kolom en gaat er dus van af.">
                  Tegenrekening
                </Badge>
              )}
            </div>
          </TableCell>
          <Bedrag cents={line.displayedCents} />
        </TableRow>
      ))}

      {group.lines.length === 0 && (
        <TableRow>
          <TableCell colSpan={3} className="text-sm text-muted-foreground">
            Geen rekeningen in deze groep.
          </TableCell>
        </TableRow>
      )}

      <TableRow className="hover:bg-transparent" data-testid="statement-group-total" data-group={group.key}>
        <TableCell />
        <TableCell className="font-medium">Subtotaal {group.label}</TableCell>
        <Bedrag cents={group.totalCents} emphasis />
      </TableRow>
    </>
  );
}

function Bedrag({ cents, emphasis }: { cents: number; emphasis?: boolean }) {
  return (
    <TableCell
      className={cn("whitespace-nowrap text-right font-mono tabular-nums", emphasis && "font-semibold")}
    >
      {formatEuroCents(cents)}
    </TableCell>
  );
}
