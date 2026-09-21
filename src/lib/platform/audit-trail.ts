/**
 * Platform Kit — de regel achter een audit-/metadatablok.
 *
 * Deze laag bepaalt één ding: wat er gebeurt met een veld waarvan de waarde
 * niet is vastgelegd. Er zijn precies twee eerlijke antwoorden, en de beller
 * kiest welke:
 *
 *   - `fallback` meegegeven  → de regel blijft staan met die expliciete tekst
 *                              ("Niet vastgelegd"). Dit is wat de
 *                              tegenboekingsweergave uit 6C-b9 doet: de
 *                              gebruiker moet zién dat er geen reden is
 *                              opgeschreven.
 *   - geen `fallback`        → de regel valt weg. Een veld dat er niet is,
 *                              wordt niet als leeg getoond.
 *
 * Wat hier nooit gebeurt: een ontbrekende datum invullen met vandaag, een
 * ontbrekende reden aanvullen met een standaardzin, of een gebruiker tonen.
 * Er is in dit leesmodel geen actor beschikbaar, dus het blok kent er ook geen.
 */

export interface AuditTrailEntry {
  /** Het label links; altijd de term die de gebruiker elders ook ziet. */
  label: string;
  /** De vastgelegde waarde, al opgemaakt door de beller. `null` = niet vastgelegd. */
  value: string | null | undefined;
  /** Klassen voor de waarde, bijvoorbeeld `font-mono tabular-nums`. */
  valueClassName?: string;
  testId?: string;
}

export interface VisibleAuditEntry {
  label: string;
  value: string;
  valueClassName?: string;
  testId?: string;
  /** `true` wanneer er niets was vastgelegd en `value` de plaatsvervanger is. */
  missing: boolean;
}

/** Leeg of alleen spaties telt als niet vastgelegd; een "waarde" van spaties bewijst niets. */
function isRecorded(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Welke regels een audit-blok toont, gegeven wat er werkelijk is vastgelegd.
 *
 * @param fallback Tekst voor een niet-vastgelegd veld. Laat weg om zulke
 *                 velden helemaal weg te laten.
 */
export function visibleAuditEntries(
  entries: readonly AuditTrailEntry[],
  fallback?: string,
): VisibleAuditEntry[] {
  const visible: VisibleAuditEntry[] = [];
  for (const entry of entries) {
    if (isRecorded(entry.value)) {
      visible.push({
        label: entry.label,
        value: entry.value,
        valueClassName: entry.valueClassName,
        testId: entry.testId,
        missing: false,
      });
      continue;
    }
    if (fallback === undefined) continue;
    visible.push({
      label: entry.label,
      value: fallback,
      valueClassName: entry.valueClassName,
      testId: entry.testId,
      missing: true,
    });
  }
  return visible;
}
