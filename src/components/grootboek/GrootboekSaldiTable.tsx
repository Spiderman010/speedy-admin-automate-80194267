import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { LedgerAccountRollup, LedgerReportTotals } from "@/lib/ledger-reporting";
import { formatLedgerAccountLabel } from "@/lib/ledger-reporting";
import { CATEGORY_LABELS, formatCents } from "@/lib/grootboek-saldi-utils";

/**
 * Fase 6C-b7 PR 2 — de saldilijst. Puur presentatie van rollups uit
 * buildAccountReport(); hier wordt niet gerekend en niet omgeklapt: een
 * creditsaldo is een negatief getal (debet-positief, zoals op een proef- en
 * saldibalans).
 */

export interface GrootboekSaldiTableProps {
  rollups: LedgerAccountRollup[];
  totals: LedgerReportTotals;
  /** Basis-URL voor de rekeningpagina; de rekening-id wordt eraan geplakt. */
  accountPath?: (accountId: string) => string;
}

export function GrootboekSaldiTable({
  rollups,
  totals,
  accountPath = (id) => `/grootboek/saldi/${id}`,
}: GrootboekSaldiTableProps) {
  return (
    // Horizontaal scrollen binnen de container op smalle schermen, nooit de
    // hele pagina.
    <div className="-mx-1 overflow-x-auto px-1">
      <Table className="min-w-[840px]">
        <caption className="sr-only">
          Saldilijst per grootboekrekening: beginsaldo, debet, credit en eindsaldo (debet-positief)
        </caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="w-24">Nummer</TableHead>
            <TableHead scope="col">Omschrijving</TableHead>
            <TableHead scope="col" className="w-28">Categorie</TableHead>
            <TableHead scope="col" className="w-32 text-right">Beginsaldo</TableHead>
            <TableHead scope="col" className="w-32 text-right">Debet</TableHead>
            <TableHead scope="col" className="w-32 text-right">Credit</TableHead>
            <TableHead scope="col" className="w-32 text-right">Eindsaldo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rollups.map((r) => {
            const a = r.account;
            const label = formatLedgerAccountLabel(a);
            return (
              <TableRow key={a.id} data-testid="saldi-row" data-account-id={a.id}>
                <TableCell className="font-mono tabular-nums">{a.nummer ?? "—"}</TableCell>
                <TableCell className="max-w-[320px]">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      to={accountPath(a.id)}
                      className="truncate font-medium underline-offset-4 hover:underline focus-visible:underline"
                      aria-label={`Open mutaties van ${label}`}
                    >
                      {a.omschrijving}
                    </Link>
                    {!a.resolved && (
                      <Badge variant="outline" className="font-normal">Onbekende rekening</Badge>
                    )}
                    {a.resolved && a.actief === false && (
                      <Badge variant="outline" className="font-normal">Inactief</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={a.categorie === "onbekend" ? "outline" : "secondary"} className="font-normal">
                    {CATEGORY_LABELS[a.categorie]}
                  </Badge>
                </TableCell>
                <Money cents={r.openingCents} />
                <Money cents={r.periodDebitCents} />
                <Money cents={r.periodCreditCents} />
                <Money cents={r.closingCents} emphasis />
              </TableRow>
            );
          })}
        </TableBody>
        <tfoot>
          <TableRow className="border-t-2 font-medium hover:bg-transparent" data-testid="saldi-totals">
            <TableCell colSpan={3}>Totaal ({rollups.length} rekening{rollups.length === 1 ? "" : "en"})</TableCell>
            <Money cents={totals.openingCents} />
            <Money cents={totals.periodDebitCents} />
            <Money cents={totals.periodCreditCents} />
            <Money cents={totals.closingCents} emphasis />
          </TableRow>
        </tfoot>
      </Table>
    </div>
  );
}

function Money({ cents, emphasis }: { cents: number; emphasis?: boolean }) {
  return (
    <TableCell className={cn("whitespace-nowrap text-right font-mono tabular-nums", emphasis && "font-semibold")}>
      {formatCents(cents)}
    </TableCell>
  );
}
