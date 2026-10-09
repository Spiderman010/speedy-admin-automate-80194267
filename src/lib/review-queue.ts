/**
 * Review — zoeken, filteren en ordenen van de ECHTE catch-up-records.
 *
 * Puur presentatie. De toestand (`klaar`, `geblokkeerd`, `onbekend`,
 * `geboekt`) en de blokkaderedenen komen ongewijzigd uit `ledger-catchup.ts`;
 * hier wordt geen enkele boekbaarheid afgeleid, geen bedrag berekend en geen
 * record aan een writer aangeboden.
 */

import type { CatchupRecord, CatchupSource, CatchupState } from "./ledger-catchup";

/** De vier toestanden in de volgorde waarin de wachtrij ze toont. */
export const REVIEW_STATE_ORDER: readonly CatchupState[] = ["klaar", "geblokkeerd", "onbekend", "geboekt"];

export const REVIEW_STATE_LABELS: Readonly<Record<CatchupState, string>> = {
  klaar: "Klaar",
  geblokkeerd: "Geblokkeerd",
  // Geen beletsel en geen vrijbrief — nooit "Geblokkeerd" noemen.
  onbekend: "Niet te bepalen",
  geboekt: "Geboekt",
};

export const REVIEW_SOURCE_LABELS: Readonly<Record<CatchupSource, string>> = {
  inkoop: "Inkoop",
  verkoop: "Verkoop",
};

/** Eén sleutel per record: een inkoop- en een verkoopfactuur kunnen in theorie hetzelfde id dragen. */
export function reviewKey(record: Pick<CatchupRecord, "source" | "id">): string {
  return `${record.source}:${record.id}`;
}

export interface ReviewQueueFilter {
  search: string;
  state: CatchupState | null;
  source: CatchupSource | null;
}

/** Zoeken in de velden die de wachtrij toont: nummer, relatie en documentstatus. */
export function filterReviewQueue(records: readonly CatchupRecord[], filter: ReviewQueueFilter): CatchupRecord[] {
  const term = filter.search.trim().toLocaleLowerCase("nl-NL");
  return records.filter((r) => {
    if (filter.state !== null && r.state !== filter.state) return false;
    if (filter.source !== null && r.source !== filter.source) return false;
    if (!term) return true;
    return [r.reference, r.description, r.documentStatus].some((v) => v.toLocaleLowerCase("nl-NL").includes(term));
  });
}

/** Nieuwste brondatum eerst; records zonder datum achteraan. Alleen weergavevolgorde. */
export function orderReviewQueue(records: readonly CatchupRecord[]): CatchupRecord[] {
  return [...records].sort((a, b) => {
    const da = a.date ?? "";
    const db = b.date ?? "";
    if (da !== db) return da > db ? -1 : 1;
    const ka = reviewKey(a);
    const kb = reviewKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function countBySource(records: readonly CatchupRecord[]): Record<CatchupSource, number> {
  const out: Record<CatchupSource, number> = { inkoop: 0, verkoop: 0 };
  for (const r of records) out[r.source] += 1;
  return out;
}
