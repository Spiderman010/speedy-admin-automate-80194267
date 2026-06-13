import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useActiveGrootboekrekeningen } from "@/hooks/useGrootboekrekeningen";
import { useActiveOrganization } from "@/hooks/useActiveOrganization";

function formatAccount(nummer: number, omschrijving: string) {
  return `${nummer} - ${omschrijving}`;
}

interface Props {
  value: string;
  onValueChange: (v: string) => void;
  onIdChange?: (id: string) => void;
  className?: string;
  noneOption?: boolean;
  placeholder?: string;
}

export function GrootboekCombobox({ value, onValueChange, onIdChange, className, noneOption, placeholder = "Selecteer rekening..." }: Props) {
  const [open, setOpen] = useState(false);
  const { activeOrganizationId, isReady } = useActiveOrganization();
  const { data: accounts } = useActiveGrootboekrekeningen({
    organizationId: activeOrganizationId ?? undefined,
    enabled: isReady && activeOrganizationId !== null,
  });

  const items = accounts ?? [];
  const selectedItem = items.find(a => formatAccount(a.nummer, a.omschrijving) === value);
  const displayLabel = selectedItem ? formatAccount(selectedItem.nummer, selectedItem.omschrijving) : value || placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className={cn("w-full justify-between font-normal h-10 text-sm", className)}>
          <span className="truncate">{displayLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Zoek op nummer of naam..." />
          <CommandList>
            <CommandEmpty>Geen rekening gevonden.</CommandEmpty>
            <CommandGroup>
              {items.map((account) => {
                const label = formatAccount(account.nummer, account.omschrijving);
                return (
                  <CommandItem
                    key={account.id}
                    value={label}
                    onSelect={(v) => {
                      onValueChange(v);
                      const selected = items.find(a => formatAccount(a.nummer, a.omschrijving).toLowerCase() === v.toLowerCase());
                      if (selected && onIdChange) onIdChange(selected.id);
                      setOpen(false);
                    }}
                  >
                    <Check className={cn("mr-2 h-4 w-4", value === label ? "opacity-100" : "opacity-0")} />
                    {label}
                  </CommandItem>
                );
              })}
              {noneOption && (
                <CommandItem
                  key="none"
                  value="Geen"
                  onSelect={() => {
                    onValueChange("");
                    onIdChange?.("");
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 h-4 w-4", value === "" ? "opacity-100" : "opacity-0")} />
                  Geen
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
