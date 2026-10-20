import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

import { BTW_KEUZE_OPTIES } from "@/lib/btw-keuze";

/** Verplichte, expliciete BTW-keuze (zie `@/lib/btw-keuze`). */
export interface BtwKeuzeSelectProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export function BtwKeuzeSelect({ id, value, onValueChange, className, disabled }: BtwKeuzeSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} className={className} data-testid="btw-keuze-select">
        <SelectValue placeholder="Kies BTW" />
      </SelectTrigger>
      <SelectContent>
        {BTW_KEUZE_OPTIES.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
