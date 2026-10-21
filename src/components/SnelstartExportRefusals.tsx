import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SnelstartRefusal } from "@/lib/snelstart-export";

/**
 * De facturen die een SnelStart-export niet heeft opgenomen, elk met de reden
 * (A2-04: zonder boekingsregels, regel zonder rekening, onbekende btw, regels
 * die niet op de kop sluiten). Zij zijn niet gemarkeerd; na het oplossen van de
 * reden gaan zij mee in een volgende export.
 */
export function SnelstartExportRefusals({
  refusals,
  description,
  onDismiss,
}: {
  refusals: readonly SnelstartRefusal[];
  description: string;
  onDismiss: () => void;
}) {
  if (!refusals.length) return null;
  return (
    <section
      aria-labelledby="snelstart-export-refusals-title"
      className="mb-3 rounded-lg border border-amber-500/50 bg-amber-50 px-3 py-2.5 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id="snelstart-export-refusals-title" className="text-sm font-semibold">
              {refusals.length === 1 ? "1 factuur niet geëxporteerd" : `${refusals.length} facturen niet geëxporteerd`}
            </h2>
            <p className="text-xs">{description}</p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={onDismiss}>
          <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Sluiten
        </Button>
      </div>
      <ul aria-label="Niet geëxporteerde facturen" className="mt-2 max-h-64 space-y-1 overflow-y-auto pl-6 text-xs">
        {refusals.map((r) => (
          <li key={r.invoiceId} className="list-disc">
            <span className="font-medium">{r.label}</span>
            {": niet geëxporteerd, reden: "}
            {r.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}
