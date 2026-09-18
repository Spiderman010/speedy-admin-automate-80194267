import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger,
} from "@/components/ui/select";
import { FilterChip } from "@/components/FilterChip";
import { periodLabel, recentYears, type PeriodSelection } from "@/lib/grootboek-saldi-utils";

/**
 * Balans/W&V PR 4 — de gedeelde filterbalk van de twee jaarrekeningrapporten.
 *
 * Bewust dezelfde bouwstenen en dezelfde semantiek als de proef- en
 * saldibalans: de bestaande administratiekeuze uit `useClientContext`, dezelfde
 * jaarchips, dezelfde "van / tot en met" met inclusieve einddatum die één keer
 * (in `periodFromSelection`) naar half-open wordt omgezet. Geen tweede
 * administratiekiezer en geen eigen periodebegrip.
 */

export interface FinancialReportHeaderProps {
  clients: readonly { id: string; name: string }[] | undefined;
  selectedClientId: string;
  onSelectClient: (id: string) => void;
  selection: PeriodSelection;
  onSelectionChange: (selection: PeriodSelection) => void;
  idPrefix: string;
}

export function FinancialReportHeader({
  clients,
  selectedClientId,
  onSelectClient,
  selection,
  onSelectionChange,
  idPrefix,
}: FinancialReportHeaderProps) {
  const years = recentYears();
  const selectedClient = clients?.find((c) => c.id === selectedClientId);

  const applyRange = (from: string, to: string) => {
    if (from && to && from <= to) onSelectionChange({ kind: "range", from, toInclusive: to });
  };

  return (
    <div className="mb-4 space-y-3 rounded-lg border bg-card p-3 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select value={selectedClientId} onValueChange={onSelectClient}>
          <SelectTrigger className="w-full sm:w-64" aria-label="Administratie">
            <span className="truncate">{selectedClient ? selectedClient.name : "Alle administraties"}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle administraties</SelectItem>
            {clients?.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap items-center gap-1.5" data-testid={`${idPrefix}-period-filters`}>
          <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground">Boekjaar</span>
          {years.map((y) => (
            <FilterChip
              key={y}
              label={String(y)}
              active={selection.kind === "year" && selection.year === y}
              onClick={() => onSelectionChange({ kind: "year", year: y })}
            />
          ))}
        </div>
      </div>
      <RangeRow idPrefix={idPrefix} selection={selection} onApply={applyRange} />
    </div>
  );
}

function RangeRow({
  idPrefix,
  selection,
  onApply,
}: {
  idPrefix: string;
  selection: PeriodSelection;
  onApply: (from: string, to: string) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-from`} className="text-xs">Van</Label>
        <Input
          id={`${idPrefix}-from`}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="h-8 w-40"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-to`} className="text-xs">Tot en met</Label>
        <Input
          id={`${idPrefix}-to`}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="h-8 w-40"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onApply(from, to)}
        disabled={!from || !to || from > to}
      >
        Periode toepassen
      </Button>
      <span className="text-xs text-muted-foreground" data-testid={`${idPrefix}-period-label`}>
        Geselecteerd: {periodLabel(selection)}
      </span>
    </div>
  );
}
