// Kleine helper voor string-vriendelijke bedraginvoer in de inkoopfactuur-popup.
// - Sta lege string toe zonder terug te vallen op "0".
// - Ondersteun zowel komma als punt als decimaalscheidingsteken.
// - Parse pas op berekening/blur/save, nooit tijdens typen.

/** Parse invoerveld naar number. Lege of ongeldige invoer → null. */
export function parseAmountInput(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw
    .toString()
    .trim()
    .replace(/\s/g, "")
    .replace(/[^0-9,.-]/g, "")
    .replace(",", ".");
  if (cleaned === "" || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Zelfde als parseAmountInput maar met 0 als fallback voor live totalen. */
export function parseAmountInputOrZero(raw: string | null | undefined): number {
  const n = parseAmountInput(raw);
  return n === null ? 0 : n;
}

/**
 * Formatteer een number naar een NL-vriendelijke string voor het invoerveld.
 * - null/undefined/NaN → "" (leeg, niet "0").
 * - Anders max. 2 decimalen met komma als decimaalscheider.
 */
export function formatAmountInput(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  // Twee decimalen, komma als decimaalscheider, geen groepering (voorkomt "1.234,56" in een invoerveld).
  return num.toLocaleString("nl-NL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}
