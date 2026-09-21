import { Fragment } from "react";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { visibleAuditEntries, type AuditTrailEntry } from "@/lib/platform/audit-trail";

/**
 * Platform Kit — een blok vastgelegde metadata: datum, reden, bron, verwijzing.
 *
 * Alleen weergave. De component leest niets, schrijft niets en vult niets aan.
 * Wat de beller niet meegeeft, bestaat hier niet:
 *
 *   - een ontbrekende datum wordt niet "vandaag";
 *   - een ontbrekende reden wordt geen standaardzin;
 *   - er is geen actorveld, omdat er in de leesmodellen van deze app geen
 *     gebruikersnaam beschikbaar is. Zou die er ooit komen, dan is het gewoon
 *     een extra regel in `entries` — geen uitzondering in deze component.
 *
 * `fallback` bepaalt wat er met een niet-vastgelegd veld gebeurt: mét fallback
 * blijft de regel zichtbaar met die tekst ("Niet vastgelegd"), zónder fallback
 * verdwijnt de regel. Zie `src/lib/platform/audit-trail.ts`.
 */
export interface AuditTrailBlockProps extends HTMLAttributes<HTMLDListElement> {
  entries: readonly AuditTrailEntry[];
  /** Tekst voor een veld dat niet is vastgelegd. Weglaten = regel weglaten. */
  fallback?: string;
}

export function AuditTrailBlock({ entries, fallback, className, ...rest }: AuditTrailBlockProps) {
  const visible = visibleAuditEntries(entries, fallback);
  if (visible.length === 0) return null;
  return (
    <dl
      className={cn("grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground", className)}
      {...rest}
    >
      {visible.map((entry, index) => (
        <Fragment key={`${entry.label}-${index}`}>
          <dt>{entry.label}</dt>
          <dd
            className={entry.valueClassName}
            data-testid={entry.testId}
            data-missing={entry.missing ? "true" : undefined}
          >
            {entry.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export type { AuditTrailEntry };
