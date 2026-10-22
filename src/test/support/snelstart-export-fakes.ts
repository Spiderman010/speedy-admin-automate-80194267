import { vi } from "vitest";

/**
 * Testdubbels voor de SnelStart-exporttests (herstelpakket P6).
 *
 * - `fakeSupabase`: een kleine in-memory nabootsing van de supabase-js-
 *   querybouwer, genoeg voor de exportpaden (select met eq/in/gte/lt/order/
 *   range, update met optioneel `.select()` als RETURNING). Elke query wordt in
 *   `fakeDb.calls` gelogd, zodat een test kan zien wat er gelezen en gemarkeerd
 *   is. Er is geen netwerk. Net als PostgREST (db-max-rows) levert één verzoek
 *   nooit meer dan `fakeDb.maxRows` rijen, ook zonder `range`.
 * - `installDownloadCapture`: vangt Blob + object-URL + ankerklik af, zodat de
 *   test de inhoud van het gedownloade bestand kan lezen.
 *
 * `fakeDb.events` legt de volgorde vast van downloads en updates; daarmee wordt
 * bewezen dat er pas na het starten van de download gemarkeerd wordt.
 */

export type Row = Record<string, any>;

export interface FakeCall {
  table: string;
  op: "select" | "update";
  filters: string[];
  payload?: unknown;
  returned: number;
}

export const fakeDb = {
  tables: {} as Record<string, Row[]>,
  calls: [] as FakeCall[],
  events: [] as string[],
  /** PostgREST `db-max-rows`: het maximum aantal rijen per verzoek. */
  maxRows: 1000,
  /** Simuleert een server die het administratiefilter negeert. */
  ignoreClientFilter: false,
  /**
   * Bepaalt welke gevonden rijen een UPDATE werkelijk raakt (zoals RLS die
   * stil 0 rijen kan opleveren). Standaard: alle gevonden rijen.
   */
  updateFilter: null as null | ((table: string, rows: Row[]) => Row[]),
  /** Laat een verzoek met een fout terugkomen (bijvoorbeeld een RLS-weigering). */
  failWith: null as null | ((table: string, op: "select" | "update") => { message: string } | null),
  /**
   * Draait direct nadat een SELECT zijn rijen heeft gelezen: zo kan een test
   * een bewerking door een ander "tussen het lezen en het markeren" nabootsen.
   */
  afterSelect: null as null | ((table: string, rows: Row[]) => void),
  reset() {
    this.tables = {};
    this.calls = [];
    this.events = [];
    this.maxRows = 1000;
    this.ignoreClientFilter = false;
    this.updateFilter = null;
    this.failWith = null;
    this.afterSelect = null;
  },
};

type Filter = (r: Row) => boolean;

class FakeQuery implements PromiseLike<{ data: any; error: any; count?: number | null }> {
  private filters: Filter[] = [];
  private filterText: string[] = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private rangeArg: [number, number] | null = null;
  private op: "select" | "update" = "select";
  private payload: Row | null = null;
  private returning = false;
  private countExact = false;

  constructor(private readonly table: string) {}

  select(_cols?: string, opts?: { count?: string }) {
    if (this.op === "update") this.returning = true;
    else this.countExact = opts?.count === "exact";
    return this;
  }

  private add(text: string, f: Filter) {
    this.filterText.push(text);
    this.filters.push(f);
    return this;
  }

  eq(col: string, value: unknown) {
    if (col === "client_id" && fakeDb.ignoreClientFilter) {
      this.filterText.push(`${col}=eq.${String(value)} (genegeerd)`);
      return this;
    }
    return this.add(`${col}=eq.${String(value)}`, (r) => r[col] === value);
  }

  in(col: string, values: readonly unknown[]) {
    if (col === "client_id" && fakeDb.ignoreClientFilter) {
      this.filterText.push(`${col}=in.(${values.length}) (genegeerd)`);
      return this;
    }
    const set = new Set(values);
    return this.add(`${col}=in.(${[...values].join(",")})`, (r) => set.has(r[col]));
  }

  gte(col: string, value: string) {
    return this.add(`${col}=gte.${value}`, (r) => r[col] != null && String(r[col]) >= value);
  }

  lte(col: string, value: string) {
    return this.add(`${col}=lte.${value}`, (r) => r[col] != null && String(r[col]) <= value);
  }

  /**
   * Alleen de vorm die de exportmarkering gebruikt (Codex #299):
   * `and(id.eq."<id>",updated_at.eq."<ts>"),…` — een rij matcht als één paar
   * exact gelijk is. Elke andere vorm is een testfout.
   */
  or(filters: string) {
    const pairs = [...filters.matchAll(/and\(id\.eq\."((?:[^"\\]|\\.)*)",updated_at\.eq\."((?:[^"\\]|\\.)*)"\)/g)];
    const rebuilt = pairs.map((m) => m[0]).join(",");
    if (!pairs.length || rebuilt !== filters) throw new Error(`fakeSupabase.or: onbekende vorm ${filters}`);
    const unq = (v: string) => v.replace(/\\(.)/g, "$1");
    const want = pairs.map((m) => [unq(m[1]), unq(m[2])] as const);
    return this.add(`or=(${filters})`, (r) => want.some(([id, ts]) => r.id === id && r.updated_at === ts));
  }

  lt(col: string, value: string) {
    return this.add(`${col}=lt.${value}`, (r) => r[col] != null && String(r[col]) < value);
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false });
    return this;
  }

  range(from: number, to: number) {
    this.rangeArg = [from, to];
    return this;
  }

  update(values: Row) {
    this.op = "update";
    this.payload = values;
    return this;
  }

  private exec(): { data: any; error: any; count?: number | null } {
    const injected = fakeDb.failWith?.(this.table, this.op) ?? null;
    if (injected) {
      fakeDb.calls.push({ table: this.table, op: this.op, filters: this.filterText, payload: this.payload ?? undefined, returned: 0 });
      return { data: null, error: injected };
    }
    const rows = (fakeDb.tables[this.table] ??= []);
    const matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      const hit = fakeDb.updateFilter ? fakeDb.updateFilter(this.table, matched) : matched;
      for (const r of hit) Object.assign(r, this.payload);
      fakeDb.calls.push({ table: this.table, op: "update", filters: this.filterText, payload: this.payload, returned: hit.length });
      fakeDb.events.push(`update:${this.table}:${hit.map((r) => r.id).join(",")}`);
      return { data: this.returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
    }
    let result = [...matched];
    if (this.orders.length) {
      result.sort((a, b) => {
        for (const o of this.orders) {
          const av = a[o.col];
          const bv = b[o.col];
          if (av === bv) continue;
          if (av == null) return 1;
          if (bv == null) return -1;
          const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av) < String(bv) ? -1 : 1;
          return o.asc ? c : -c;
        }
        return 0;
      });
    }
    const total = result.length;
    if (this.rangeArg) result = result.slice(this.rangeArg[0], this.rangeArg[1] + 1);
    result = result.slice(0, fakeDb.maxRows);
    fakeDb.calls.push({ table: this.table, op: "select", filters: this.filterText, returned: result.length });
    const data = result.map((r) => ({ ...r }));
    fakeDb.afterSelect?.(this.table, data);
    return { data, error: null, count: this.countExact ? total : null };
  }

  then<T1 = { data: any; error: any }, T2 = never>(
    onFulfilled?: ((value: { data: any; error: any; count?: number | null }) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: any) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve().then(() => this.exec()).then(onFulfilled, onRejected);
  }
}

export const fakeSupabase = {
  from: (table: string) => new FakeQuery(table),
  rpc: vi.fn(),
  storage: { from: vi.fn() },
  auth: {
    getSession: async () => ({ data: { session: { user: { id: "user-1" }, access_token: "inert" } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
};

export const updatesOn = (table: string) => fakeDb.calls.filter((c) => c.table === table && c.op === "update");
export const selectsOn = (table: string) => fakeDb.calls.filter((c) => c.table === table && c.op === "select");

// ── Downloads ────────────────────────────────────────────────────────────────

export interface CapturedDownload {
  name: string;
  blob: Blob;
}

export const downloads: CapturedDownload[] = [];

/** Vangt `URL.createObjectURL` + ankerklik af; roep aan in `beforeEach`. */
export function installDownloadCapture(): void {
  downloads.length = 0;
  let lastBlob: Blob | null = null;
  (URL as any).createObjectURL = vi.fn((blob: Blob) => {
    lastBlob = blob;
    return "blob:p6-test";
  });
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: lastBlob as Blob });
    fakeDb.events.push(`download:${this.download}`);
  });
}

export function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

export function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const hasBom = (bytes: Uint8Array) => bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

/** Regels van CSV-bytes (zonder BOM), plus of er een BOM was. */
export function csvLinesFromBytes(bytes: Uint8Array): { bom: boolean; lines: string[] } {
  const bom = hasBom(bytes);
  const text = new TextDecoder("utf-8").decode(bom ? bytes.slice(3) : bytes);
  return { bom, lines: text.split("\r\n") };
}

/** Regels van een gedownload CSV-bestand (zonder BOM), plus of er een BOM was. */
export async function csvLines(download: CapturedDownload): Promise<{ bom: boolean; lines: string[] }> {
  return csvLinesFromBytes(await readBlobBytes(download.blob));
}

// ── Fixtures: één organisatie met twee administraties ───────────────────────

export const ORG = "org-1";
export const CLIENT_EEN = { id: "c1", name: "Bakkerij Een BV", organization_id: ORG, bank_dagboek: 1200 };
export const CLIENT_TWEE = { id: "c2", name: "Garage Twee VOF", organization_id: ORG, bank_dagboek: 1300 };

export const accountRow = (id: string, nummer: number, over: Row = {}): Row => ({
  id,
  nummer,
  omschrijving: `Rekening ${nummer}`,
  organization_id: ORG,
  client_id: null,
  actief: true,
  ...over,
});

export const purchaseRow = (id: string, clientId: string, over: Row = {}): Row => ({
  id,
  client_id: clientId,
  organization_id: ORG,
  supplier: `Leverancier ${id}`,
  invoice_number: `F-${id}`,
  invoice_date: "2026-10-20",
  amount_excl: 100,
  btw_amount: 21,
  amount_incl: 121,
  btw_percentage: 21,
  ledger_account_text: "4400 - Kantoorkosten (notitie)",
  status: "gecontroleerd",
  remaining_amount: 121,
  document_route: "pdf_route",
  updated_at: "2026-10-20T08:00:00+00:00",
  ...over,
});

export const lineRow = (id: string, invoiceId: string, over: Row = {}): Row => ({
  id,
  purchase_invoice_id: invoiceId,
  organization_id: ORG,
  omschrijving: `Regel ${id}`,
  amount_excl: 100,
  btw_percentage: 21,
  grootboekrekening_id: "gb-4400",
  sort_order: 0,
  ...over,
});

export const salesRow = (id: string, clientId: string, over: Row = {}): Row => ({
  id,
  client_id: clientId,
  organization_id: ORG,
  user_id: "user-1",
  customer_name: `Klant ${id}`,
  invoice_number: `V-${id}`,
  invoice_date: "2026-10-01",
  due_date: "2026-10-31",
  amount_excl: 100,
  btw_amount: 21,
  amount_incl: 121,
  btw_percentage: 21,
  btw_verlegd: false,
  status: "gecontroleerd",
  ledger_account_text: "8000 - Omzet",
  grootboekrekening_id: null,
  remaining_amount: 121,
  notes: null,
  pdf_path: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

/**
 * De nulmetingfactuur van A2-04: 100 @ 21% op 4400 en 100 @ 9% op 4600,
 * kop 200 / 30 / 230, met het kop-btw% zoals de werkbank het opslaat (21).
 */
export function seedA204(clientId = CLIENT_EEN.id): void {
  fakeDb.tables.purchase_invoices = [
    ...(fakeDb.tables.purchase_invoices ?? []),
    purchaseRow("p-a204", clientId, {
      supplier: "Leverancier BV",
      invoice_number: "000123",
      amount_excl: 200,
      btw_amount: 30,
      amount_incl: 230,
      btw_percentage: 21,
      remaining_amount: 230,
    }),
  ];
  fakeDb.tables.purchase_invoice_lines = [
    ...(fakeDb.tables.purchase_invoice_lines ?? []),
    lineRow("l-a204-1", "p-a204", { omschrijving: "Kantoorartikelen", amount_excl: 100, btw_percentage: 21, grootboekrekening_id: "gb-4400", sort_order: 0 }),
    lineRow("l-a204-2", "p-a204", { omschrijving: "Vakliteratuur", amount_excl: 100, btw_percentage: 9, grootboekrekening_id: "gb-4600", sort_order: 1 }),
  ];
}

export const A204_CSV = [
  '"Datum";"Omschrijving";"Grootboekrekening";"Bedrag";"Btw-code"',
  '"20-10-2026";"Leverancier BV - 000123 - Kantoorartikelen";"4400";"121,00";"1"',
  '"20-10-2026";"Leverancier BV - 000123 - Vakliteratuur";"4600";"109,00";"2"',
];
