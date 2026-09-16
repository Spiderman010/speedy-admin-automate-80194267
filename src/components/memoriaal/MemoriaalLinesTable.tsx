import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Info, Plus, Trash2 } from "lucide-react";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { formatEuro } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  applyCreditInput,
  applyDebitInput,
  createEmptyLineRow,
  formatAmount,
  lineTotals,
  parseAmount,
  VAT_HINT,
  type ManualJournalLineRow,
} from "@/lib/manual-journal-utils";

/**
 * Fase 6C-b6 (PR 2) — de regeltabel van een memoriaalboeking.
 *
 * Puur presentatie: de state zit in de pagina. Debet en credit sluiten elkaar
 * uit (een bedrag op de ene zijde wist de andere) en de totalen zijn afgeleid.
 * "In balans" verschijnt alleen wanneer debet gelijk is aan credit én er ook
 * echt een bedrag staat. De database keurt alles opnieuw.
 */

export interface MemoriaalLinesTableProps {
  lines: ManualJournalLineRow[];
  /** Geboekt: alles alleen-lezen, geen toevoegen/verwijderen meer. */
  readOnly?: boolean;
  /**
   * Functionele update. Bewust GEEN kant-en-klare array: de combobox roept in
   * één gebeurtenis eerst onValueChange en dan onIdChange aan. Met een waarde
   * uit de props zou de tweede aanroep de eerste overschrijven (label of id
   * raakt kwijt); met een updater stapelen ze correct.
   */
  onChange: (updater: (prev: ManualJournalLineRow[]) => ManualJournalLineRow[]) => void;
}

export function MemoriaalLinesTable({ lines, readOnly = false, onChange }: MemoriaalLinesTableProps) {
  const totals = lineTotals(lines);

  const patch = (
    index: number,
    change: (line: ManualJournalLineRow) => ManualJournalLineRow,
  ) => {
    onChange((prev) => prev.map((line, i) => (i === index ? change(line) : line)));
  };

  return (
    <div className="space-y-3">
      <div className="-mx-1 overflow-x-auto px-1">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-9 min-w-[180px] pl-2">Omschrijving</TableHead>
              <TableHead className="h-9 min-w-[220px]">Grootboekrekening</TableHead>
              <TableHead className="h-9 w-[128px] text-right">Debet</TableHead>
              <TableHead className="h-9 w-[128px] text-right">Credit</TableHead>
              <TableHead className="h-9 w-[48px] pr-1">
                <span className="sr-only">Acties</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line, index) => {
              const rowNumber = index + 1;
              return (
                <TableRow key={line.key} className="align-top" data-testid="memoriaal-line-row">
                  <TableCell className="py-1.5 pl-2">
                    <Input
                      value={line.omschrijving}
                      disabled={readOnly}
                      onChange={(e) => patch(index, (l) => ({ ...l, omschrijving: e.target.value }))}
                      placeholder="Omschrijving"
                      aria-label={`Omschrijving regel ${rowNumber}`}
                      className="h-8"
                    />
                  </TableCell>
                  <TableCell className="py-1.5">
                    {readOnly ? (
                      <p
                        className="truncate py-1.5 text-sm"
                        aria-label={`Grootboekrekening regel ${rowNumber}`}
                      >
                        {line.grootboek_label || "—"}
                      </p>
                    ) : (
                      <GrootboekCombobox
                        value={line.grootboek_label}
                        onValueChange={(v) => patch(index, (l) => ({ ...l, grootboek_label: v }))}
                        onIdChange={(id) =>
                          patch(index, (l) => ({ ...l, grootboekrekening_id: id || null }))
                        }
                        className="h-8"
                      />
                    )}
                  </TableCell>
                  <TableCell className="py-1.5">
                    <Input
                      inputMode="decimal"
                      value={line.debit_input}
                      disabled={readOnly}
                      onChange={(e) => patch(index, (l) => applyDebitInput(l, e.target.value))}
                      onBlur={() => {
                        const n = parseAmount(line.debit_input);
                        if (n !== null) patch(index, (l) => ({ ...l, debit_input: formatAmount(n) }));
                      }}
                      placeholder="0,00"
                      aria-label={`Debet regel ${rowNumber}`}
                      className="h-8 text-right font-mono tabular-nums"
                    />
                  </TableCell>
                  <TableCell className="py-1.5">
                    <Input
                      inputMode="decimal"
                      value={line.credit_input}
                      disabled={readOnly}
                      onChange={(e) => patch(index, (l) => applyCreditInput(l, e.target.value))}
                      onBlur={() => {
                        const n = parseAmount(line.credit_input);
                        if (n !== null) patch(index, (l) => ({ ...l, credit_input: formatAmount(n) }));
                      }}
                      placeholder="0,00"
                      aria-label={`Credit regel ${rowNumber}`}
                      className="h-8 text-right font-mono tabular-nums"
                    />
                  </TableCell>
                  <TableCell className="py-1.5 pr-1">
                    {!readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => onChange((prev) => prev.filter((_, i) => i !== index))}
                        aria-label={`Regel ${rowNumber} verwijderen`}
                        title="Regel verwijderen"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {!readOnly && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange((prev) => [...prev, createEmptyLineRow()])}
        >
          <Plus className="mr-1 h-4 w-4" /> Regel toevoegen
        </Button>
      )}

      <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 border-t pt-3 text-sm">
        <span className="text-muted-foreground">
          Totaal debet{" "}
          <span className="font-mono tabular-nums text-foreground" data-testid="memoriaal-total-debit">
            {formatEuro(totals.debit)}
          </span>
        </span>
        <span className="text-muted-foreground">
          Totaal credit{" "}
          <span className="font-mono tabular-nums text-foreground" data-testid="memoriaal-total-credit">
            {formatEuro(totals.credit)}
          </span>
        </span>
        <span className="text-muted-foreground">
          Verschil{" "}
          <span
            className={cn(
              "font-mono tabular-nums",
              totals.difference === 0 ? "text-foreground" : "text-destructive",
            )}
            data-testid="memoriaal-difference"
          >
            {formatEuro(totals.difference)}
          </span>
        </span>
        {totals.isBalanced && (
          <Badge variant="outline" data-testid="memoriaal-balanced">
            In balans
          </Badge>
        )}
      </div>

      <p className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="memoriaal-vat-hint">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {VAT_HINT}
      </p>
    </div>
  );
}
