/**
 * De BTW-keuze bij het coderen van een bankregel.
 *
 * Geen stille BTW: de server (post_bank_transaction) leest het opgeslagen
 * percentage en behandelt NULL als 0%. Daarom is de keuze hier verplicht en
 * expliciet: "" betekent "nog niet gekozen", "0" is een bewuste "Geen BTW".
 */

export const BTW_KEUZE_OPTIES = [
  { value: "0", label: "Geen BTW" },
  { value: "9", label: "9%" },
  { value: "21", label: "21%" },
] as const;

/** Opgeslagen percentage → keuzewaarde; "" voor null of een onbekend percentage. */
export function btwKeuzeFromPercentage(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "";
  const match = BTW_KEUZE_OPTIES.find((o) => Number(o.value) === p);
  return match ? match.value : "";
}

/** Keuzewaarde → percentage; null zolang er niets gekozen is. */
export function btwKeuzeToPercentage(v: string): number | null {
  if (v === "") return null;
  const match = BTW_KEUZE_OPTIES.find((o) => o.value === v);
  return match ? Number(match.value) : null;
}
