import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { CATEGORY_LABELS } from "@/lib/grootboek-saldi-utils";
import { formatAmountNl, type TrialBalanceRow, type TrialBalanceTotals } from "@/lib/proef-saldibalans";

/**
 * Fase 6C-b7 PR 3 — de proef- en saldibalans als tabel.
 *
 * Puur presentatie. De zes bedragkolommen komen kant-en-klaar uit
 * `buildTrialBalance()`; hier wordt niet gerekend, niet gesorteerd en niet
 * omgeklapt. Dezelfde opmaakfunctie als de CSV (`formatAmountNl`), zodat
 * scherm en export niet uit elkaar kunnen lopen.
 */

export interface ProefSaldibalansTableProps {
  rows: TrialBalanceRow[];
  totals: TrialBalanceTotals;
  accountPath?: (accountId: string) => string;
  /**
   * Doorklikken naar de mutaties van deze rekening, in de periode die nu op
   * het scherm staat. Ontbreekt de callback, dan blijft de bestaande link naar
   * /grootboek/saldi/:accountId het enige pad.
   */
  onDrilldown?: (accountId: string) => void;
}

export function ProefSaldibalansTable({
  rows,
  totals,
  accountPath = (id) => `/grootboek/saldi/${id}`,
  onDrilldown,
}: ProefSaldibalansTableProps) {
  return (
    // Horizontaal scrollen binnen de container, nooit de hele pagina.
    <div className="-mx-1 overflow-x-auto px-1">
      <Table className="min-w-[1040px]">
        <caption className="sr-only">
          Proef- en saldibalans per grootboekrekening: beginsaldo, periodemutaties en eindsaldo,
          elk gesplitst in debet en credit. Alle bedragen in euro.
        </caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="w-24">Rekening</TableHead>
            <TableHead scope="col" className="min-w-[200px]">Omschrijving</TableHead>
            <TableHead scope="col" className="w-28">Categorie</TableHead>
            <TableHead scope="col" className="w-28 text-right">Beginsaldo debet</TableHead>
            <TableHead scope="col" className="w-28 text-right">Beginsaldo credit</TableHead>
            <TableHead scope="col" className="w-28 text-right">Periode debet</TableHead>
            <TableHead scope="col" className="w-28 text-right">Periode credit</TableHead>
            <TableHead scope="col" className="w-28 text-right">Eindsaldo debet</TableHead>
            <TableHead scope="col" className="w-28 text-right">Eindsaldo credit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const a = r.account;
            const label = a.nummer === null ? a.omschrijving : `${a.nummer} - ${a.omschrijving}`;
            return (
              <TableRow key={a.id} data-testid="psb-row" data-account-id={a.id}>
                <TableCell className="font-mono tabular-nums">
                  {onDrilldown ? (
                    <button
                      type="button"
                      className="rounded-sm underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onDrilldown(a.id)}
                      data-testid="psb-drilldown"
                      data-account-id={a.id}
                      aria-label={`Toelichting bij ${label}`}
                    >
                      {a.nummer ?? "—"}
                    </button>
                  ) : (
                    (a.nummer ?? "—")
                  )}
                </TableCell>
                <TableCell className="max-w-[280px]">
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
                    {!r.hasPostings && (
                      <Badge variant="outline" className="font-normal">Geen boekingen</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={a.categorie === "onbekend" ? "outline" : "secondary"} className="font-normal">
                    {CATEGORY_LABELS[a.categorie]}
                  </Badge>
                </TableCell>
                <Bedrag cents={r.openingDebitCents} />
                <Bedrag cents={r.openingCreditCents} />
                <Bedrag cents={r.periodDebitCents} />
                <Bedrag cents={r.periodCreditCents} />
                <Bedrag cents={r.closingDebitCents} emphasis />
                <Bedrag cents={r.closingCreditCents} emphasis />
              </TableRow>
            );
          })}
        </TableBody>
        <tfoot>
          <TableRow className="border-t-2 font-medium hover:bg-transparent" data-testid="psb-totals">
            <TableCell colSpan={3}>
              Totaal ({rows.length} rekening{rows.length === 1 ? "" : "en"})
            </TableCell>
            <Bedrag cents={totals.openingDebitCents} />
            <Bedrag cents={totals.openingCreditCents} />
            <Bedrag cents={totals.periodDebitCents} />
            <Bedrag cents={totals.periodCreditCents} />
            <Bedrag cents={totals.closingDebitCents} emphasis />
            <Bedrag cents={totals.closingCreditCents} emphasis />
          </TableRow>
        </tfoot>
      </Table>
    </div>
  );
}

function Bedrag({ cents, emphasis }: { cents: number; emphasis?: boolean }) {
  return (
    <TableCell
      className={`whitespace-nowrap text-right font-mono tabular-nums${emphasis ? " font-semibold" : ""}`}
    >
      {formatAmountNl(cents)}
    </TableCell>
  );
}
