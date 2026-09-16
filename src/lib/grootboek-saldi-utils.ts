// Fase 6C-b7 PR 2 — kleine, pure helpers voor de saldischermen.
// Geen boekhoudrekenwerk: dat zit in ledger-reporting.ts (PR 1).

import { centsToAmount, yearPeriod, type LedgerAccountCategory, type LedgerPeriod } from "@/lib/ledger-reporting";
import { formatEuro } from "@/lib/format";

/** Alle jaren die het grootboek kan bevatten (boekjaar CHECK 2000..2100). */
export const ALL_TIME_PERIOD: LedgerPeriod = { from: "2000-01-01", toExclusive: "2101-01-01" };

/**
 * De gebruiker kiest een inclusieve einddatum ("t/m"); de rapportagekern werkt
 * half-open [from, toExclusive). Eén plek voor die omzetting, getest.
 */
export function inclusiveEndToExclusive(inclusiveEnd: string): string {
  const d = new Date(`${inclusiveEnd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function exclusiveEndToInclusive(toExclusive: string): string {
  const d = new Date(`${toExclusive}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export type PeriodSelection =
  | { kind: "all" }
  | { kind: "year"; year: number }
  | { kind: "range"; from: string; toInclusive: string };

export function periodFromSelection(sel: PeriodSelection): LedgerPeriod {
  if (sel.kind === "all") return ALL_TIME_PERIOD;
  if (sel.kind === "year") return yearPeriod(sel.year);
  return { from: sel.from, toExclusive: inclusiveEndToExclusive(sel.toInclusive) };
}

export function formatDatumNL(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}-${m}-${y}` : iso;
}

export function periodLabel(sel: PeriodSelection): string {
  if (sel.kind === "all") return "Alle jaren";
  if (sel.kind === "year") return String(sel.year);
  return `${formatDatumNL(sel.from)} t/m ${formatDatumNL(sel.toInclusive)}`;
}

/** Centen → nl-NL eurotekst; een creditsaldo blijft negatief (geen omklap). */
export function formatCents(cents: number): string {
  return formatEuro(centsToAmount(cents));
}

export const CATEGORY_LABELS: Record<LedgerAccountCategory, string> = {
  activa: "Activa",
  passiva: "Passiva",
  omzet: "Omzet",
  kosten: "Kosten",
  privé: "Privé",
  onbekend: "Onbekend",
};

/** Jaren voor de jaarkeuze: huidig jaar en de vier ervoor. */
export function recentYears(now = new Date()): number[] {
  const y = now.getFullYear();
  return [y, y - 1, y - 2, y - 3, y - 4];
}
