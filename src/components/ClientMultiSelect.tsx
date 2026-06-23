import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface ClientMultiSelectClient {
  id: string;
  name: string;
}

export interface ClientMultiSelectValue {
  selectedIds: string[];
  allMode: boolean;
}

interface ClientMultiSelectProps {
  clients: ClientMultiSelectClient[];
  value: ClientMultiSelectValue;
  onChange: (value: ClientMultiSelectValue) => void;
  className?: string;
  triggerClassName?: string;
  placeholder?: string;
}

export function ClientMultiSelect({
  clients,
  value,
  onChange,
  className,
  triggerClassName,
  placeholder = "Kies klant(en)…",
}: ClientMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const sorted = useMemo(
    () => [...clients].sort((a, b) => a.name.localeCompare(b.name, "nl")),
    [clients],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((c) => c.name.toLowerCase().includes(q));
  }, [sorted, query]);

  const selectedSet = useMemo(() => new Set(value.selectedIds), [value.selectedIds]);

  const label = (() => {
    if (value.allMode) return "Alle klanten";
    if (value.selectedIds.length === 0) return placeholder;
    if (value.selectedIds.length === 1) {
      const c = clients.find((x) => x.id === value.selectedIds[0]);
      return c?.name ?? "1 klant geselecteerd";
    }
    return `${value.selectedIds.length} klanten geselecteerd`;
  })();

  const toggleClient = (id: string) => {
    if (value.allMode) {
      // When switching away from "all", start a fresh subset with just this one.
      onChange({ allMode: false, selectedIds: [id] });
      return;
    }
    const next = new Set(value.selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ allMode: false, selectedIds: Array.from(next) });
  };

  const toggleAll = () => {
    if (value.allMode) {
      onChange({ allMode: false, selectedIds: [] });
    } else {
      onChange({ allMode: true, selectedIds: [] });
    }
  };

  const clear = () => {
    onChange({ allMode: false, selectedIds: [] });
    setQuery("");
  };

  return (
    <div className={cn("inline-flex", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              "w-56 justify-between font-normal",
              value.selectedIds.length === 0 && !value.allMode && "text-muted-foreground",
              triggerClassName,
            )}
          >
            <span className="flex items-center gap-2 truncate">
              <Users className="h-4 w-4 shrink-0 opacity-70" />
              <span className="truncate">{label}</span>
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <div className="border-b p-2">
            <Input
              placeholder="Zoek klant…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8"
            />
          </div>

          <button
            type="button"
            onClick={toggleAll}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent border-b"
          >
            <Checkbox checked={value.allMode} className="pointer-events-none" />
            <span className="font-medium">Alle klanten</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {clients.length}
            </span>
          </button>

          <ScrollArea className="max-h-64">
            <div className="py-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                  Geen klanten gevonden
                </p>
              ) : (
                filtered.map((c) => {
                  const checked = value.allMode || selectedSet.has(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleClient(c.id)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent text-left"
                    >
                      <Checkbox checked={checked} className="pointer-events-none" />
                      <span className="truncate">{c.name}</span>
                      {checked && !value.allMode && (
                        <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </ScrollArea>

          {(value.allMode || value.selectedIds.length > 0) && (
            <div className="border-t p-2 flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {value.allMode
                  ? `Alle ${clients.length} klanten`
                  : `${value.selectedIds.length} geselecteerd`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={clear}
                className="h-7 px-2 text-xs"
              >
                <X className="mr-1 h-3 w-3" /> Wissen
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
