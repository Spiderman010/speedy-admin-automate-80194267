import { useState, type ReactNode } from "react";
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
 * Balans/W&V PR 5 — één compacte toolbar in plaats van verspreide bediening.
 *
 * Bewust dezelfde bouwstenen en dezelfde semantiek als de proef- en
 * saldibalans: de bestaande administratiekeuze uit `useClientContext`, dezelfde
 * jaarchips, dezelfde "van / tot en met" met inclusieve einddatum die één keer
 * (in `periodFromSelection`) naar half-open wordt omgezet. Geen tweede
 * administratiekiezer en geen eigen periodebegrip.
 *
 * De status- en actieslots zitten in deze balk, zodat bediening en oordeel bij
 * elkaar staan en er op een smal scherm niets naast de rest komt te zweven.
 */

export interface FinancialReportHeaderProps {
  clients: readonly { id: string; name: string }[] | undefined;
  selectedClientId: string;
  onSelectClient: (id: string) => void;
  selection: PeriodSelection;
  onSelectionChange: (selection: PeriodSelection) => void;
  idPrefix: string;
  /** Volledigheidsbadge; staat rechts in de balk. */
  status?: ReactNode;
  /** Exportknop en eventuele andere acties. */
  actions?: ReactNode;
}

export function FinancialReportHeader({
  clients,
  selectedClientId,
  onSelectClient,
  selection,
  onSelectionChange,
  idPrefix,
  status,
  actions,
}: FinancialReportHeaderProps) {
  const years = recentYears();
  const selectedClient = clients?.find((c) => c.id === selectedClientId);

  const applyRange = (from: string, to: string) => {
    if (from && to && from <= to) onSelectionChange({ kind: "range", from, toInclusive: to });
  };

  return (
    <section
      aria-label="Rapportinstellingen"
      className="mb-4 rounded-lg border bg-card shadow-sm"
      data-testid={`${idPrefix}-toolbar`}
    >
      {/* Rij 1 — waarover gaat dit rapport, en wat is het oordeel. */}
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <Select value={selectedClientId} onValueChange={onSelectClient}>
          <SelectTrigger className="h-9 w-full min-w-0 sm:w-56" aria-label="Administratie">
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
          <span className="text-xs font-medium text-muted-foreground">Boekjaar</span>
          {years.map((y) => (
            <FilterChip
              key={y}
              label={String(y)}
              active={selection.kind === "year" && selection.year === y}
              onClick={() => onSelectionChange({ kind: "year", year: y })}
            />
          ))}
        </div>

        {/* ml-auto duwt status en acties naar rechts zodra er ruimte is, en
            valt op een smal scherm vanzelf terug naar de volgende regel. */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {status}
          {actions}
        </div>
      </div>

      {/* Rij 2 — de vrije periode, compacter en onder de hoofdkeuzes. */}
      <RangeRow idPrefix={idPrefix} selection={selection} onApply={applyRange} />
    </section>
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
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 p-3">
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-from`} className="text-xs text-muted-foreground">Van</Label>
        <Input
          id={`${idPrefix}-from`}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="h-9 w-[9.5rem]"
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-to`} className="text-xs text-muted-foreground">Tot en met</Label>
        <Input
          id={`${idPrefix}-to`}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="h-9 w-[9.5rem]"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9"
        onClick={() => onApply(from, to)}
        disabled={!from || !to || from > to}
      >
        {/* Volledige naam blijft staan: hij is de toegankelijke naam van deze
            knop. Compactheid komt uit de hoogte, niet uit een half woord. */}
        Periode toepassen
      </Button>
      <p className="text-xs text-muted-foreground" data-testid={`${idPrefix}-period-label`}>
        Periode: <span className="font-medium text-foreground">{periodLabel(selection)}</span>
      </p>
    </div>
  );
}
