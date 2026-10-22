import { describe, expect, it } from "vitest";
import {
  chunkValues,
  fetchAllRows,
  FULL_LIST_PAGE_SIZE,
  IncompleteListError,
  type PageResult,
} from "@/lib/fetch-all-rows";
import { createPostgrestEmulator, readsOn, type Row } from "./support/postgrest-max-rows-emulator";

/**
 * De gedeelde helper voor volledige lijsten (nulmeting NM-07, C-01, E-08).
 * Gedrag tegen een PostgREST-emulator die net als de server stil afkapt op
 * `max_rows`; geen netwerk.
 */

const rows = (n: number, make: (i: number) => Row) => Array.from({ length: n }, (_, i) => make(i));
const id = (i: number) => `r-${String(i).padStart(5, "0")}`;

function pageVia(emu: ReturnType<typeof createPostgrestEmulator>) {
  return (from: number, to: number) =>
    emu.client.from("t").select("*").order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<
      PageResult<Row>
    >;
}

describe("fetchAllRows", () => {
  it("haalt 2500 rijen volledig op bij een servergrens van 1000, en stopt pas op een lege pagina", async () => {
    const emu = createPostgrestEmulator({ maxRows: 1000, tables: { t: rows(2500, (i) => ({ id: id(i) })) } });
    // Controle: een verzoek zonder range wordt stil afgekapt.
    const capped = (await (emu.client.from("t").select("*") as unknown as PromiseLike<PageResult<Row>>)).data!;
    expect(capped).toHaveLength(1000);

    const all = await fetchAllRows(pageVia(emu));
    expect(all).toHaveLength(2500);
    expect(new Set(all.map((r) => r.id)).size).toBe(2500);
    expect(readsOn(emu.log, "t").slice(1).map((l) => l.range)).toEqual([
      [0, FULL_LIST_PAGE_SIZE - 1],
      [1000, 1999],
      [2000, 2999],
      [2500, 3499],
    ]);
  });

  it("is ook volledig als de servergrens lager is dan de paginagrootte (de offset volgt de ontvangen rijen)", async () => {
    const emu = createPostgrestEmulator({ maxRows: 300, tables: { t: rows(1250, (i) => ({ id: id(i) })) } });
    const all = await fetchAllRows(pageVia(emu));
    expect(all.map((r) => r.id)).toEqual(rows(1250, (i) => ({ id: id(i) })).map((r) => r.id));
    expect(readsOn(emu.log, "t").map((l) => l.returned)).toEqual([300, 300, 300, 300, 50, 0]);
  });

  it("een fout op een latere pagina geeft geen halve lijst maar een fout", async () => {
    let call = 0;
    await expect(
      fetchAllRows(async () => {
        call++;
        if (call === 2) return { data: null, error: { code: "57014", message: "statement timeout" } };
        return { data: rows(1000, (i) => ({ id: `${call}-${i}` })), error: null };
      }),
    ).rejects.toMatchObject({ code: "57014" });
  });

  it("een rij die door een gelijktijdige invoeging twee keer terugkomt, telt één keer", async () => {
    const pages = [
      { data: [{ id: "a" }, { id: "b" }], error: null },
      { data: [{ id: "b" }, { id: "c" }], error: null },
      { data: [], error: null },
    ];
    const all = await fetchAllRows(async () => pages.shift()!, { pageSize: 2 });
    expect(all.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("een server die steeds dezelfde pagina geeft, maakt geen eindeloze lus en geen stille onvolledige lijst", async () => {
    await expect(
      fetchAllRows(async () => ({ data: [{ id: "x" }, { id: "y" }], error: null }), { pageSize: 2 }),
    ).rejects.toBeInstanceOf(IncompleteListError);
  });

  it("een rij zonder sleutel is een fout, geen stil gat", async () => {
    await expect(fetchAllRows(async () => ({ data: [{ naam: "zonder id" }], error: null }))).rejects.toBeInstanceOf(
      IncompleteListError,
    );
  });

  it("een eigen sleutel kan (bijvoorbeeld transaction_id van een RPC)", async () => {
    const pages = [{ data: [{ transaction_id: "t1" }], error: null }, { data: [], error: null }];
    const all = await fetchAllRows(async () => pages.shift()!, { key: (r: { transaction_id: string }) => r.transaction_id });
    expect(all).toEqual([{ transaction_id: "t1" }]);
  });
});

describe("chunkValues", () => {
  it("knipt in blokken van de opgegeven grootte en houdt de volgorde", () => {
    expect(chunkValues([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkValues([], 2)).toEqual([]);
    expect(chunkValues(rows(250, (i) => ({ i })).map((r) => r.i)).map((c) => c.length)).toEqual([100, 100, 50]);
  });
});
