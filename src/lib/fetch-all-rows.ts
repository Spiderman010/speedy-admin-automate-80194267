/**
 * Volledige lijsten ophalen, voorbij de rijgrens van PostgREST.
 *
 * PostgREST levert zonder `range` stil hoogstens `max_rows` rijen (de
 * Supabase-standaard is 1000) en meldt dat niet: de client krijgt gewoon
 * `{ data: [1000 rijen], error: null }`. Elke lijst die als VOLLEDIGE set wordt
 * gebruikt — om een openstaand bedrag te herberekenen, kandidaten te zoeken of
 * iets te tellen — moet daarom pagina voor pagina worden opgehaald.
 *
 * Dit is de gedeelde helper, naar het model van `fetchLedgerPostings`:
 *   - de aanroeper bouwt elke pagina met een DETERMINISTISCHE totale volgorde
 *     (de laatste sorteerkolom is uniek, meestal `id`), anders kunnen
 *     paginavensters elkaar overlappen of rijen overslaan;
 *   - de offset schuift op met het aantal werkelijk ontvangen rijen, en er
 *     wordt doorgegaan tot een lege pagina — de volledigheid hangt dus niet af
 *     van de aanname dat de servergrens minstens `pageSize` is;
 *   - rijen worden op hun sleutel ontdubbeld: een rij die tijdens het ophalen
 *     vóór het venster wordt ingevoegd, schuift de rest op en komt dan twee
 *     keer terug;
 *   - een niet-lege pagina zonder één nieuwe rij is geen voortgang: dan wordt
 *     er een fout gegooid in plaats van eindeloos door te lopen of stil een
 *     onvolledige lijst te leveren.
 *
 * Bekende grens (gelijk aan de bestaande batchhelpers): een rij die tijdens
 * het ophalen vóór het venster wordt VERWIJDERD, schuift de rest één plaats
 * terug; de eerste rij van de volgende pagina kan dan ontbreken. Een
 * server-side aggregaat is de structurele oplossing (nulmeting NM-07).
 */

/** De rijgrens die de app aanhoudt; gelijk aan de Supabase-standaard `max_rows`. */
export const FULL_LIST_PAGE_SIZE = 1000;

/**
 * Hoeveel waarden één `.in()`-filter maximaal krijgt. Een lijst van honderden
 * uuid's in de URL loopt anders tegen de lengtegrens van proxy en server aan.
 */
export const IN_FILTER_CHUNK_SIZE = 100;

export interface PageResult<T> {
  data: T[] | null;
  error: unknown;
}

export interface FetchAllRowsOptions<T> {
  pageSize?: number;
  /** Unieke sleutel per rij; standaard `id`. */
  key?: (row: T) => string;
}

export class IncompleteListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteListError";
  }
}

const defaultKey = (row: unknown): string => {
  const id = (row as { id?: unknown } | null)?.id;
  if (id === undefined || id === null) {
    throw new IncompleteListError("Lijst kan niet volledig worden geladen: een rij heeft geen sleutel.");
  }
  return String(id);
};

/**
 * Haalt alle pagina's op. `fetchPage(from, to)` levert de rijen `from` t/m
 * `to` (inclusief, zoals `.range()`), in een vaste volgorde.
 */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  options: FetchAllRowsOptions<T> = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? FULL_LIST_PAGE_SIZE;
  const key = options.key ?? (defaultKey as (row: T) => string);
  const all: T[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; ) {
    const { data, error } = await fetchPage(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = data ?? [];
    if (page.length === 0) return all;
    let fresh = 0;
    for (const row of page) {
      const k = key(row);
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(row);
      fresh++;
    }
    if (fresh === 0) {
      throw new IncompleteListError(
        "Lijst kan niet volledig worden geladen: de server gaf geen nieuwe rijen terug. Probeer het opnieuw.",
      );
    }
    offset += page.length;
  }
}

/** Knipt een lijst in stukken voor `.in()`-filters. */
export function chunkValues<T>(values: readonly T[], size: number = IN_FILTER_CHUNK_SIZE): T[][] {
  if (size < 1) throw new Error("chunkValues: size moet minstens 1 zijn");
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
