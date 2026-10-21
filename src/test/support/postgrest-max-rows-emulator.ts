/**
 * Een kleine PostgREST/supabase-js-emulator in het geheugen, met de rijgrens
 * van de server (`db-max-rows`, Supabase-standaard 1000).
 *
 * Overgenomen uit de nulmeting (agent C, `repro/C/postgrest-emulator.ts`) en
 * uitgebreid met paginering op set-returning RPC's (`.rpc(...).order().range()`).
 * Er gaat geen netwerkverkeer de deur uit.
 *
 * De semantiek die ertoe doet:
 *   - een verzoek ZONDER range/limit geeft stil hoogstens `maxRows` rijen terug,
 *     zonder fout — precies zoals PostgREST met db-max-rows;
 *   - een verzoek MET range(a, b) geeft hoogstens min(b - a + 1, maxRows) rijen;
 *   - een set-returning RPC wordt net zo afgekapt, ook met range;
 *   - elk verzoek komt in `log`, zodat een test de rondes kan tellen.
 */
export type Row = Record<string, any>;

export interface RequestLog {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete" | "rpc";
  filters: string[];
  range?: [number, number];
  limit?: number;
  order: string[];
  returned: number;
}

type Filter = (r: Row) => boolean;

function cmp(a: any, b: any): number {
  if (a === b) return 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

function parseOr(expr: string): Filter {
  const parts = expr.split(",").map((s) => s.trim()).filter(Boolean);
  const preds: Filter[] = parts.map((part) => {
    const m = part.match(/^([a-z_]+)\.(eq|is|neq)\.(.*)$/);
    if (!m) throw new Error(`emulator: or-filter niet ondersteund: ${part}`);
    const [, col, op, raw] = m;
    if (op === "is") return (r) => (raw === "null" ? r[col] == null : String(r[col]) === raw);
    if (op === "eq") return (r) => r[col] != null && String(r[col]) === raw;
    return (r) => String(r[col]) !== raw;
  });
  return (r) => preds.some((p) => p(r));
}

export function createPostgrestEmulator(opts: {
  maxRows?: number;
  tables: Record<string, Row[]>;
  rpc?: Record<string, (args: any) => Row[] | { error: { code?: string; message: string } }>;
}) {
  const maxRows = opts.maxRows ?? 1000;
  const tables = opts.tables;
  const log: RequestLog[] = [];
  let idSeq = 0;

  class Builder {
    private filters: Filter[] = [];
    private filterText: string[] = [];
    private orders: { col: string; asc: boolean; nullsFirst?: boolean }[] = [];
    private rangeArg?: [number, number];
    private limitArg?: number;
    private op: RequestLog["op"] = "select";
    private payload: any;
    private upsertConflict?: string[];
    private countExact = false;
    private head = false;
    private singleMode: "none" | "single" | "maybe" = "none";
    private returning = false;

    constructor(
      private table: string,
      private rpcRows?: () => Row[] | { error: { code?: string; message: string } },
    ) {
      if (rpcRows) this.op = "rpc";
    }

    select(_cols?: string, o?: { count?: string; head?: boolean }) {
      if (this.op === "select" || this.op === "rpc") {
        this.countExact = o?.count === "exact";
        this.head = !!o?.head;
      } else {
        this.returning = true;
      }
      return this;
    }
    private add(text: string, f: Filter) {
      this.filters.push(f);
      this.filterText.push(text);
      return this;
    }
    eq(c: string, v: any) { return this.add(`${c}=eq.${v}`, (r) => r[c] === v); }
    neq(c: string, v: any) { return this.add(`${c}=neq.${v}`, (r) => r[c] !== v); }
    in(c: string, vs: any[]) {
      const s = new Set(vs);
      return this.add(`${c}=in.(${vs.length})`, (r) => s.has(r[c]));
    }
    gt(c: string, v: any) { return this.add(`${c}=gt.${v}`, (r) => r[c] != null && cmp(r[c], v) > 0); }
    gte(c: string, v: any) { return this.add(`${c}=gte.${v}`, (r) => r[c] != null && cmp(r[c], v) >= 0); }
    lt(c: string, v: any) { return this.add(`${c}=lt.${v}`, (r) => r[c] != null && cmp(r[c], v) < 0); }
    lte(c: string, v: any) { return this.add(`${c}=lte.${v}`, (r) => r[c] != null && cmp(r[c], v) <= 0); }
    is(c: string, v: any) { return this.add(`${c}=is.${v}`, (r) => (v === null ? r[c] == null : r[c] === v)); }
    or(expr: string) { return this.add(`or=(${expr})`, parseOr(expr)); }
    order(col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) {
      this.orders.push({ col, asc: o?.ascending !== false, nullsFirst: o?.nullsFirst });
      return this;
    }
    range(a: number, b: number) { this.rangeArg = [a, b]; return this; }
    limit(n: number) { this.limitArg = n; return this; }
    single() { this.singleMode = "single"; return this; }
    maybeSingle() { this.singleMode = "maybe"; return this; }
    insert(values: any) { this.op = "insert"; this.payload = values; return this; }
    update(values: any) { this.op = "update"; this.payload = values; return this; }
    upsert(values: any, o?: { onConflict?: string }) {
      this.op = "upsert";
      this.payload = values;
      this.upsertConflict = o?.onConflict?.split(",").map((s) => s.trim());
      return this;
    }
    delete() { this.op = "delete"; return this; }

    private matches(r: Row) { return this.filters.every((f) => f(r)); }

    private sortRows(rows: Row[]): Row[] {
      if (!this.orders.length) return rows;
      return [...rows].sort((a, b) => {
        for (const o of this.orders) {
          const av = a[o.col];
          const bv = b[o.col];
          if (av == null || bv == null) {
            if (av == null && bv == null) continue;
            // PostgreSQL: ASC zet NULL achteraan, DESC vooraan.
            const nullsFirst = o.nullsFirst ?? !o.asc;
            return (av == null ? -1 : 1) * (nullsFirst ? 1 : -1);
          }
          const c = cmp(av, bv);
          if (c !== 0) return o.asc ? c : -c;
        }
        return 0;
      });
    }

    private page(all: Row[]): Row[] {
      const offset = this.rangeArg ? this.rangeArg[0] : 0;
      let want = this.rangeArg ? this.rangeArg[1] - this.rangeArg[0] + 1 : Infinity;
      if (this.limitArg !== undefined) want = Math.min(want, this.limitArg);
      const take = Math.min(want, maxRows); // PostgREST db-max-rows
      return this.head ? [] : all.slice(offset, offset + take);
    }

    private exec(): { data: any; error: any; count?: number | null } {
      if (this.op === "rpc") {
        const produced = this.rpcRows!();
        if (!Array.isArray(produced)) {
          log.push({ table: this.table, op: "rpc", filters: [], order: [], returned: 0 });
          return { data: null, error: produced.error };
        }
        const result = this.sortRows(produced.filter((r) => this.matches(r)));
        const page = this.page(result);
        log.push({
          table: this.table, op: "rpc", filters: this.filterText, range: this.rangeArg, limit: this.limitArg,
          order: this.orders.map((o) => `${o.col}.${o.asc ? "asc" : "desc"}`), returned: page.length,
        });
        return this.finish(page, this.countExact ? result.length : null);
      }
      const rows = (tables[this.table] ??= []);
      if (this.op === "select") {
        const result = this.sortRows(rows.filter((r) => this.matches(r)));
        const page = this.page(result);
        log.push({
          table: this.table, op: "select", filters: this.filterText, range: this.rangeArg, limit: this.limitArg,
          order: this.orders.map((o) => `${o.col}.${o.asc ? "asc" : "desc"}`), returned: page.length,
        });
        return this.finish(page, this.countExact ? result.length : null);
      }
      if (this.op === "insert") {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const inserted = list.map((v: Row) => ({ id: v.id ?? `gen-${++idSeq}`, ...v }));
        rows.push(...inserted);
        log.push({ table: this.table, op: "insert", filters: [], order: [], returned: inserted.length });
        return this.finish(this.returning ? inserted : null, null);
      }
      if (this.op === "upsert") {
        const v = this.payload as Row;
        const keys = this.upsertConflict ?? ["id"];
        const existing = rows.find((r) => keys.every((k) => r[k] === v[k]));
        let out: Row;
        if (existing) {
          Object.assign(existing, v);
          out = existing;
        } else {
          out = { id: v.id ?? `gen-${++idSeq}`, ...v };
          rows.push(out);
        }
        log.push({ table: this.table, op: "upsert", filters: keys, order: [], returned: 1 });
        return this.finish(this.returning ? [out] : null, null);
      }
      if (this.op === "update") {
        const hit = rows.filter((r) => this.matches(r));
        for (const r of hit) Object.assign(r, this.payload);
        log.push({ table: this.table, op: "update", filters: this.filterText, order: [], returned: hit.length });
        return this.finish(this.returning ? hit : null, null);
      }
      const keep = rows.filter((r) => !this.matches(r));
      const removed = rows.length - keep.length;
      tables[this.table] = keep;
      log.push({ table: this.table, op: "delete", filters: this.filterText, order: [], returned: removed });
      return this.finish(null, null);
    }

    private finish(data: any, count: number | null) {
      if (this.singleMode !== "none" && Array.isArray(data)) {
        if (data.length === 1) return { data: data[0], error: null, count };
        if (data.length === 0 && this.singleMode === "maybe") return { data: null, error: null, count };
        return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, count };
      }
      return { data, error: null, count };
    }

    then<T1, T2>(resolve: (v: any) => T1, reject?: (e: any) => T2) {
      return Promise.resolve().then(() => this.exec()).then(resolve, reject);
    }
  }

  const client = {
    from: (table: string) => new Builder(table),
    rpc: (fn: string, args: any) => {
      const impl = opts.rpc?.[fn];
      return new Builder(`rpc:${fn}`, () =>
        impl ? impl(args) : { error: { code: "PGRST202", message: `function ${fn} not found` } },
      );
    },
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "user-1" }, access_token: "inert" } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  };

  return { client, log, tables, maxRows };
}

/** De leesverzoeken (tabel of RPC) uit het logboek. */
export function readsOn(log: RequestLog[], table: string): RequestLog[] {
  return log.filter((l) => l.table === table && (l.op === "select" || l.op === "rpc"));
}
