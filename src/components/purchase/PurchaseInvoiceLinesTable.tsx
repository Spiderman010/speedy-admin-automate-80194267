import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { isPartiallyFilledLine } from "@/lib/purchase-line-validation";
import { parseAmountInput, formatAmountInput } from "@/lib/amount-input";
import { round2 } from "@/lib/btw-calc";
import { formatEuro } from "@/lib/format";
import { cn } from "@/lib/utils";

/** One editable booking line as held in workspace state. */
export interface LineRow {
  omschrijving: string;
  amount_input: string;
  btw_percentage: string;
  /** De ENIGE echte rekening. Leeg betekent: nog geen rekening gekozen. */
  grootboekrekening_id: string | null;
  /**
   * Het label van de gekozen rekening. Bevat uitsluitend de weergave van een
   * werkelijk gekozen rekening — nooit losse tekst uit een oude factuur, want
   * dan zou de kiezer gevuld lijken zonder dat er een rekening achter zit.
   */
  grootboek_label: string;
  /**
   * Deze regel is afgeleid uit de factuurkop en staat NIET in de database.
   * Oude facturen hebben vaak geen opgeslagen boekingsregels; de werkbank toont
   * er dan één als concept, zodat de gebruiker hem kan afmaken en opslaan.
   */
  derived?: boolean;
  /** Vrije tekst uit de oude factuur, puur ter referentie. Geen rekening. */
  legacyLabel?: string | null;
  /** Precies één ondubbelzinnige kandidaat; alleen ná bevestiging toegewezen. */
  suggestedAccount?: { id: string; label: string } | null;
}

export interface PurchaseInvoiceLinesTableProps {
  lines: LineRow[];
  isBtwVrijgesteld: boolean;
  onPatchLine: (idx: number, patch: Partial<LineRow>) => void;
  onRemoveLine: (idx: number) => void;
  onAddLine: () => void;
}

/**
 * Booking-line editor. Purely presentational: state, add/remove semantics and
 * BTW defaults live in the workspace page. Per-row BTW/incl are the same
 * derivations the workspace always rendered (round2(excl * pct / 100)).
 * Partial-line detection uses the existing isPartiallyFilledLine helper.
 */
export function PurchaseInvoiceLinesTable({
  lines, isBtwVrijgesteld, onPatchLine, onRemoveLine, onAddLine,
}: PurchaseInvoiceLinesTableProps) {
  if (lines.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        <p>Nog geen boekingsregels.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={onAddLine}>
          <Plus className="mr-1 h-4 w-4" /> Eerste boekingsregel toevoegen
        </Button>
      </div>
    );
  }

  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-9 min-w-[160px] pl-2">Omschrijving</TableHead>
            <TableHead className="h-9 min-w-[200px]">Grootboek</TableHead>
            <TableHead className="h-9 w-[112px] text-right">Excl.</TableHead>
            <TableHead className="h-9 w-[84px]">BTW %</TableHead>
            <TableHead className="h-9 w-[96px] text-right">BTW</TableHead>
            <TableHead className="h-9 w-[112px] text-right">Incl.</TableHead>
            <TableHead className="h-9 w-[40px] pr-1"><span className="sr-only">Acties</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line, idx) => {
            const excl = parseAmountInput(line.amount_input) ?? 0;
            const pct = parseAmountInput(line.btw_percentage) ?? 0;
            const btw = round2(excl * pct / 100);
            const incl = round2(excl + btw);
            const partial = isPartiallyFilledLine({
              omschrijving: line.omschrijving,
              amount_input: line.amount_input,
              grootboekrekening_id: line.grootboekrekening_id,
            });
            return (
              <TableRow
                key={idx}
                data-partial={partial ? "true" : undefined}
                className={cn(
                  "align-top",
                  partial && "border-l-2 border-l-amber-500 bg-amber-50/60 hover:bg-amber-50/80 dark:bg-amber-950/20 dark:hover:bg-amber-950/30",
                )}
              >
                <TableCell className="py-1.5 pl-2">
                  <div className="flex items-center gap-1.5">
                    {partial && (
                      <AlertTriangle
                        className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                        aria-label="Regel niet compleet"
                      />
                    )}
                    <Input
                      value={line.omschrijving}
                      onChange={(e) => onPatchLine(idx, { omschrijving: e.target.value })}
                      placeholder="Omschrijving"
                      aria-label="Omschrijving"
                      aria-invalid={partial || undefined}
                      className="h-8"
                    />
                  </div>
                </TableCell>
                <TableCell className="py-1.5">
                  <GrootboekCombobox
                    value={line.grootboek_label}
                    onValueChange={(v) => onPatchLine(idx, { grootboek_label: v })}
                    onIdChange={(id) => onPatchLine(idx, { grootboekrekening_id: id })}
                    noneOption
                    className="h-8"
                  />
                  {/* Oude factuur zonder opgeslagen regels: de tekst van toen is
                      geen rekening. Ze staat hier als verwijzing, en alleen bij
                      precies één ondubbelzinnige treffer is er iets te
                      bevestigen — met één klik, door de gebruiker. */}
                  {!line.grootboekrekening_id && line.legacyLabel && (
                    <div className="mt-1 space-y-1" data-testid="legacy-account-hint">
                      <p className="text-[11px] text-muted-foreground">
                        Oude factuurtekst: <span className="font-mono">{line.legacyLabel}</span>
                      </p>
                      {line.suggestedAccount ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px] font-normal">
                            Voorgestelde rekening uit oude factuur — bevestigen
                          </Badge>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            data-testid="legacy-account-confirm"
                            onClick={() =>
                              onPatchLine(idx, {
                                grootboekrekening_id: line.suggestedAccount!.id,
                                grootboek_label: line.suggestedAccount!.label,
                              })
                            }
                          >
                            Bevestig {line.suggestedAccount.label}
                          </Button>
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted-foreground" data-testid="legacy-account-no-suggestion">
                          Geen eenduidige rekening te bepalen; kies er zelf één.
                        </p>
                      )}
                    </div>
                  )}
                </TableCell>
                <TableCell className="py-1.5">
                  <Input
                    inputMode="decimal"
                    value={line.amount_input}
                    onChange={(e) => onPatchLine(idx, { amount_input: e.target.value })}
                    onBlur={() => {
                      const n = parseAmountInput(line.amount_input);
                      onPatchLine(idx, { amount_input: n === null ? line.amount_input : formatAmountInput(n) });
                    }}
                    placeholder="0,00"
                    aria-label="Bedrag excl. regel"
                    aria-invalid={partial || undefined}
                    className="h-8 text-right font-mono tabular-nums"
                  />
                </TableCell>
                <TableCell className="py-1.5">
                  <Select
                    value={line.btw_percentage}
                    onValueChange={(v) => onPatchLine(idx, { btw_percentage: v })}
                    disabled={isBtwVrijgesteld}
                  >
                    <SelectTrigger className="h-8" aria-label="BTW-percentage regel">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">0%</SelectItem>
                      <SelectItem value="9">9%</SelectItem>
                      <SelectItem value="21">21%</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="py-1.5 pt-3 text-right font-mono text-sm tabular-nums text-muted-foreground">
                  {formatEuro(btw)}
                </TableCell>
                <TableCell className="py-1.5 pt-3 text-right font-mono text-sm tabular-nums">
                  {formatEuro(incl)}
                </TableCell>
                <TableCell className="py-1.5 pr-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => onRemoveLine(idx)}
                    aria-label="Regel verwijderen"
                    title="Regel verwijderen"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
