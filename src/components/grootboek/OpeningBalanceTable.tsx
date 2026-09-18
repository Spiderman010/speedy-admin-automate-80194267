import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Info, Plus, Trash2 } from "lucide-react";
import { GrootboekCombobox } from "@/components/GrootboekCombobox";
import { cn } from "@/lib/utils";
import {
  accountCategoryNote,
  createEmptyLineRow,
  formatCentsInput,
  lineIssues,
  parseExactAmount,
  type OpeningBalanceAccountRef,
  type OpeningBalanceLineRow,
} from "@/lib/opening-balance-utils";

/**
 * Fase 6C-b8 (PR 2) — de regeltabel van een beginbalans.
 *
 * Puur presentatie: de state zit in de pagina. Debet en credit zijn twee losse
 * velden die elkaar NIET automatisch leegmaken of invullen; staan ze allebei
 * gevuld, dan verschijnt een fout. Bedragen worden nooit afgerond: op blur
 * wordt alleen een geldig tweedecimaal bedrag nl-NL uitgelijnd, 0,005 blijft
 * 0,005 zodat de RPC hem kan weigeren. De rekeningkeuze is beperkt tot actieve
 * rekeningen binnen het bereik van deze administratie; de database keurt dat
 * opnieuw. Er wordt uit `categorie` geen boekhoudregel afgeleid — alleen een
 * niet-blokkerende opmerking bij omzet, kosten en privé.
 */

export interface OpeningBalanceTableProps {
  lines: OpeningBalanceLineRow[];
  clientId: string;
  /** Volledige rekeninglijst (ook inactief), voor labels, categorie en actief-controle. */
  accountsById: ReadonlyMap<string, OpeningBalanceAccountRef>;
  /** Geboekt of nihil: alles alleen-lezen, geen toevoegen/verwijderen meer. */
  readOnly?: boolean;
  /**
   * Functionele update. Bewust GEEN kant-en-klare array: de combobox roept in
   * één gebeurtenis eerst onValueChange en dan onIdChange aan; met een updater
   * stapelen die correct.
   */
  onChange: (updater: (prev: OpeningBalanceLineRow[]) => OpeningBalanceLineRow[]) => void;
}

const AMOUNT_INPUT_CLASS = "h-11 text-right font-mono tabular-nums sm:h-8";

export function OpeningBalanceTable({
  lines,
  clientId,
  accountsById,
  readOnly = false,
  onChange,
}: OpeningBalanceTableProps) {
  const patch = (index: number, change: (line: OpeningBalanceLineRow) => OpeningBalanceLineRow) => {
    onChange((prev) => prev.map((line, i) => (i === index ? change(line) : line)));
  };

  const normaliseOnBlur = (index: number, side: "debit_input" | "credit_input") => {
    onChange((prev) =>
      prev.map((line, i) => {
        if (i !== index) return line;
        const parsed = parseExactAmount(line[side]);
        // Alleen netjes uitlijnen, NOOIT afronden of leegmaken: ongeldige of
        // te precieze invoer blijft letterlijk staan.
        if (parsed.kind !== "ok") return line;
        return { ...line, [side]: parsed.cents === 0 ? "" : formatCentsInput(parsed.cents) };
      }),
    );
  };

  return (
    <div className="space-y-3">
      <div className="-mx-1 overflow-x-auto px-1">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-9 min-w-[180px] pl-2">Omschrijving</TableHead>
              <TableHead className="h-9 min-w-[240px]">Grootboekrekening</TableHead>
              <TableHead className="h-9 w-[136px] text-right">Debet</TableHead>
              <TableHead className="h-9 w-[136px] text-right">Credit</TableHead>
              <TableHead className="h-9 w-[56px] pr-1">
                <span className="sr-only">Acties</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line, index) => {
              const rowNumber = index + 1;
              const account = line.grootboekrekening_id ? accountsById.get(line.grootboekrekening_id) : undefined;
              const label = line.grootboek_label || (account ? `${account.nummer} - ${account.omschrijving}` : "");
              const context = label ? ` (${label})` : "";
              const issues = readOnly ? [] : lineIssues(line, accountsById, clientId);
              const note = accountCategoryNote(account?.categorie);
              const issuesId = `ob-line-${line.key}-issues`;
              const noteId = `ob-line-${line.key}-note`;
              const describedBy = [issues.length > 0 ? issuesId : null, note ? noteId : null]
                .filter(Boolean)
                .join(" ") || undefined;
              return (
                <Fragment key={line.key}>
                  <TableRow className="align-top" data-testid="beginbalans-line-row">
                    <TableCell className="py-1.5 pl-2">
                      <Input
                        value={line.description}
                        disabled={readOnly}
                        onChange={(e) => patch(index, (l) => ({ ...l, description: e.target.value }))}
                        placeholder="Omschrijving"
                        aria-label={`Omschrijving regel ${rowNumber}`}
                        className="h-11 sm:h-8"
                      />
                    </TableCell>
                    <TableCell className="py-1.5">
                      {readOnly ? (
                        <p className="truncate py-1.5 text-sm" aria-label={`Grootboekrekening regel ${rowNumber}`}>
                          {label || "—"}
                        </p>
                      ) : (
                        <GrootboekCombobox
                          value={line.grootboek_label}
                          clientId={clientId}
                          onValueChange={(v) => patch(index, (l) => ({ ...l, grootboek_label: v }))}
                          onIdChange={(id) => patch(index, (l) => ({ ...l, grootboekrekening_id: id || null }))}
                          className="h-11 sm:h-8"
                        />
                      )}
                    </TableCell>
                    <TableCell className="py-1.5">
                      <Input
                        inputMode="decimal"
                        value={line.debit_input}
                        disabled={readOnly}
                        onChange={(e) => patch(index, (l) => ({ ...l, debit_input: e.target.value }))}
                        onBlur={() => normaliseOnBlur(index, "debit_input")}
                        placeholder="0,00"
                        aria-label={`Debet regel ${rowNumber}${context}`}
                        aria-invalid={issues.length > 0 || undefined}
                        aria-describedby={describedBy}
                        className={cn(AMOUNT_INPUT_CLASS, issues.length > 0 && "border-destructive")}
                      />
                    </TableCell>
                    <TableCell className="py-1.5">
                      <Input
                        inputMode="decimal"
                        value={line.credit_input}
                        disabled={readOnly}
                        onChange={(e) => patch(index, (l) => ({ ...l, credit_input: e.target.value }))}
                        onBlur={() => normaliseOnBlur(index, "credit_input")}
                        placeholder="0,00"
                        aria-label={`Credit regel ${rowNumber}${context}`}
                        aria-invalid={issues.length > 0 || undefined}
                        aria-describedby={describedBy}
                        className={cn(AMOUNT_INPUT_CLASS, issues.length > 0 && "border-destructive")}
                      />
                    </TableCell>
                    <TableCell className="py-1.5 pr-1">
                      {!readOnly && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11 text-muted-foreground hover:text-destructive sm:h-8 sm:w-8"
                          onClick={() => onChange((prev) => prev.filter((_, i) => i !== index))}
                          aria-label={`Regel ${rowNumber} verwijderen`}
                          title="Regel verwijderen"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {(issues.length > 0 || note) && (
                    <TableRow className="hover:bg-transparent" data-testid="beginbalans-line-notes">
                      <TableCell colSpan={5} className="py-0 pb-2 pl-2">
                        {issues.length > 0 && (
                          <ul id={issuesId} role="alert" className="space-y-0.5 text-xs text-destructive">
                            {issues.map((issue) => (
                              <li key={issue.code} data-testid={`beginbalans-line-issue-${issue.code}`}>
                                Regel {rowNumber}: {issue.message}
                              </li>
                            ))}
                          </ul>
                        )}
                        {note && (
                          <p
                            id={noteId}
                            className="flex items-start gap-1.5 text-xs text-muted-foreground"
                            data-testid="beginbalans-category-note"
                          >
                            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            {note}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
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
          className="h-11 sm:h-8"
          onClick={() => onChange((prev) => [...prev, createEmptyLineRow()])}
        >
          <Plus className="mr-1 h-4 w-4" /> Regel toevoegen
        </Button>
      )}
    </div>
  );
}
