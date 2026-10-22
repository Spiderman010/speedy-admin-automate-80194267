import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type PurchaseInvoice = Tables<"purchase_invoices">;
type PurchaseInvoiceInsert = TablesInsert<"purchase_invoices">;

export interface UsePurchaseInvoicesOptions {
  organizationId?: string;
  clientId?: string;
  enabled?: boolean;
}

export const PURCHASE_INVOICES_PAGE_SIZE = 50;

// "status" is intentionally not sortable: the column stores the workflow
// status while the table displays a payment status derived from
// remaining_amount, so a server sort on the column would look wrong.
export type PurchaseInvoiceSortField = "supplier" | "invoice_number" | "date" | "amount" | "btw";

const SORT_COLUMNS: Record<PurchaseInvoiceSortField, string> = {
  supplier: "supplier",
  invoice_number: "invoice_number",
  date: "invoice_date",
  amount: "amount_incl",
  btw: "btw_amount",
};

// PostgREST or() syntax breaks on commas/parens and ilike treats % and _ as
// wildcards; strip the former and escape the latter so user input stays literal.
export function sanitizeSearchTerm(raw: string): string {
  return raw
    .trim()
    .replace(/[,()"']/g, " ")
    .replace(/[%_]/g, (m) => `\\${m}`)
    .replace(/\s+/g, " ")
    .trim();
}

// Year filter: driven by invoice_date only (never created_at). "all" adds no
// filter at all, so existing behaviour stays identical.
export type PurchaseInvoiceYearFilter = number | "all";

export const YEAR_OPTIONS_COUNT = 10;

export function buildYearOptions(
  currentYear: number = new Date().getFullYear(),
  count: number = YEAR_OPTIONS_COUNT,
): number[] {
  return Array.from({ length: count }, (_, i) => currentYear - i);
}

// Half-open interval [YYYY-01-01, (YYYY+1)-01-01) so no time-of-day math is needed.
export function getYearDateRange(
  year: PurchaseInvoiceYearFilter | undefined,
): { from: string; to: string } | null {
  if (year === undefined || year === "all" || !Number.isFinite(year as number)) return null;
  const y = year as number;
  return { from: `${y}-01-01`, to: `${y + 1}-01-01` };
}

export interface UsePaginatedPurchaseInvoicesOptions {
  organizationId?: string;
  clientId?: string;
  enabled?: boolean;
  page: number; // 1-based
  pageSize?: number;
  search?: string;
  status?: string; // "all" disables the filter
  documentRoute?: string; // "all" disables the filter
  year?: PurchaseInvoiceYearFilter; // "all" disables the filter
  sortField?: PurchaseInvoiceSortField;
  sortDir?: "asc" | "desc";
}


export interface PaginatedPurchaseInvoices {
  invoices: PurchaseInvoice[];
  total: number;
}

export function usePaginatedPurchaseInvoices(options: UsePaginatedPurchaseInvoicesOptions) {
  const {
    organizationId,
    clientId,
    enabled = true,
    page,
    pageSize = PURCHASE_INVOICES_PAGE_SIZE,
    search = "",
    status = "all",
    documentRoute = "all",
    year = "all",
    sortField = "date",
    sortDir = "desc",
  } = options;
  const { user } = useAuth();
  const cleanSearch = sanitizeSearchTerm(search);

  return useQuery<PaginatedPurchaseInvoices>({
    queryKey: [
      "purchase_invoices",
      "page",
      organizationId ?? "all",
      clientId ?? "all",
      page,
      pageSize,
      cleanSearch,
      status,
      documentRoute,
      String(year ?? "all"),
      sortField,
      sortDir,
    ],
    queryFn: async () => {
      let query = supabase
        .from("purchase_invoices")
        .select("*", { count: "exact" });
      if (organizationId) query = query.eq("organization_id", organizationId);
      if (clientId) query = query.eq("client_id", clientId);
      if (status !== "all") query = query.eq("status", status);
      if (documentRoute !== "all") query = query.eq("document_route", documentRoute);
      const range = getYearDateRange(year);
      if (range) {
        query = query.gte("invoice_date", range.from).lt("invoice_date", range.to);
      }
      if (cleanSearch) {
        query = query.or(
          `supplier.ilike.%${cleanSearch}%,invoice_number.ilike.%${cleanSearch}%,ledger_account_text.ilike.%${cleanSearch}%`
        );
      }
      const from = (page - 1) * pageSize;
      const { data, error, count } = await query
        .order(SORT_COLUMNS[sortField], { ascending: sortDir === "asc", nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      return { invoices: (data ?? []) as PurchaseInvoice[], total: count ?? 0 };
    },
    placeholderData: keepPreviousData,
    enabled: !!user && enabled,
  });
}

export const EXPORT_BATCH_SIZE = 1000;
export const EXPORTABLE_STATUSES = ["gecontroleerd", "betaald"] as const;

// Fetches every exportable invoice in deterministic id-ordered batches so
// exports are complete even past PostgREST's max-rows cap. Only call this
// on demand (export click), never on mount.
export async function fetchAllExportablePurchaseInvoices(opts: {
  organizationId?: string;
  clientId?: string;
  year?: PurchaseInvoiceYearFilter;
}): Promise<PurchaseInvoice[]> {
  const yearRange = getYearDateRange(opts.year);
  const all: PurchaseInvoice[] = [];
  for (let offset = 0; ; offset += EXPORT_BATCH_SIZE) {
    let query = supabase
      .from("purchase_invoices")
      .select("*")
      .in("status", [...EXPORTABLE_STATUSES]);
    if (opts.organizationId) query = query.eq("organization_id", opts.organizationId);
    if (opts.clientId) query = query.eq("client_id", opts.clientId);
    if (yearRange) {
      query = query.gte("invoice_date", yearRange.from).lt("invoice_date", yearRange.to);
    }
    const { data, error } = await query
      .order("id", { ascending: true })
      .range(offset, offset + EXPORT_BATCH_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as PurchaseInvoice[];
    all.push(...batch);
    if (batch.length < EXPORT_BATCH_SIZE) return all;
  }
}

// SnelStart-inkoopexport per boekingsregel (A2-04): de regels en hun
// grootboekrekeningen worden pas bij de exportklik opgehaald, in batches. Mist
// er iets, dan weigert de exportopbouw de factuur (Σ regels moet exact op de kop
// sluiten); er wordt niets gerepareerd. Structureel gelijk aan
// `SnelstartPurchaseLine` / `SnelstartLedgerAccount` in snelstart-export.ts.
export type PurchaseExportLine = Pick<
  Tables<"purchase_invoice_lines">,
  "id" | "purchase_invoice_id" | "omschrijving" | "amount_excl" | "btw_percentage" | "grootboekrekening_id" | "sort_order" | "organization_id"
>;
export type PurchaseExportAccount = Pick<Tables<"grootboekrekeningen">, "id" | "nummer" | "organization_id" | "client_id">;

export const EXPORT_LOOKUP_ID_BATCH_SIZE = 100;

export async function fetchPurchaseInvoiceExportLines(opts: {
  invoiceIds: readonly string[];
}): Promise<PurchaseExportLine[]> {
  const ids = [...new Set(opts.invoiceIds)];
  const all: PurchaseExportLine[] = [];
  for (let i = 0; i < ids.length; i += EXPORT_LOOKUP_ID_BATCH_SIZE) {
    const batch = ids.slice(i, i + EXPORT_LOOKUP_ID_BATCH_SIZE);
    for (let offset = 0; ; offset += EXPORT_BATCH_SIZE) {
      const { data, error } = await supabase
        .from("purchase_invoice_lines")
        .select("id, purchase_invoice_id, omschrijving, amount_excl, btw_percentage, grootboekrekening_id, sort_order, organization_id")
        .in("purchase_invoice_id", batch)
        .order("purchase_invoice_id", { ascending: true })
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + EXPORT_BATCH_SIZE - 1);
      if (error) throw error;
      const rows = (data ?? []) as PurchaseExportLine[];
      all.push(...rows);
      if (rows.length < EXPORT_BATCH_SIZE) break;
    }
  }
  return all;
}

export async function fetchExportLedgerAccounts(opts: {
  organizationId: string;
  accountIds: readonly (string | null | undefined)[];
}): Promise<PurchaseExportAccount[]> {
  if (!opts.organizationId) {
    throw new Error("Geen actieve organisatie: grootboekrekeningen kunnen niet worden geladen");
  }
  const ids = [...new Set(opts.accountIds.filter((id): id is string => !!id))];
  const all: PurchaseExportAccount[] = [];
  for (let i = 0; i < ids.length; i += EXPORT_LOOKUP_ID_BATCH_SIZE) {
    const { data, error } = await supabase
      .from("grootboekrekeningen")
      .select("id, nummer, organization_id, client_id")
      .eq("organization_id", opts.organizationId)
      .in("id", ids.slice(i, i + EXPORT_LOOKUP_ID_BATCH_SIZE));
    if (error) throw error;
    all.push(...((data ?? []) as PurchaseExportAccount[]));
  }
  return all;
}

export const STATUS_UPDATE_BATCH_SIZE = 150;

// Pairs (id, read updated_at) per compare-and-set UPDATE (Codex #299). Each pair
// costs ~155 URL characters once encoded (uuid in `id=in.(…)` plus
// `and(id.eq."<uuid>",updated_at.eq."<ISO with µs and +00:00>")` in `or=(…)`);
// 40 pairs keep the whole request URL around 6.6 KB, safely under ~8 KB
// (measured in src/test/purchase-invoices-export-cas-url.test.ts).
export const STATUS_UPDATE_CAS_BATCH_SIZE = 40;

// PostgREST logic-tree value, double-quoted so ':' '.' '+' ',' '(' ')' in a
// timestamp are taken literally; '"' and '\' are backslash-escaped. The value
// is the exact string read from the database, never reformatted.
const postgrestQuoted = (v: string) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** De markering raakte niet precies de geëxporteerde facturen; `unmarkedIds` noemt welke niet. */
export class PurchaseExportMarkError extends Error {
  constructor(
    message: string,
    readonly marked: number,
    readonly expected: number,
    readonly unmarkedIds: readonly string[] = [],
  ) {
    super(message);
    this.name = "PurchaseExportMarkError";
  }
}

// Marks exactly the exported invoices in safe ID chunks, and only AFTER the
// file was built and its download started (the caller's job). Every update is
// scoped to the organization and the administratie, and only flips an invoice
// that is still exportable (compare-and-set on status) and — when
// `fetchedUpdatedAt` is given — whose `updated_at` is still EXACTLY the value
// read for the file (per-row compare-and-set, H6-03 / Codex #299). Per batch
// of STATUS_UPDATE_CAS_BATCH_SIZE invoices ONE request carries every pair as
// `or=(and(id.eq.<id>,updated_at.eq.<read value>),…)`: no shared cutoff (an
// edit after the read can never hide under a later-read invoice's newer
// timestamp), no client clock, and a bounded number of requests however many
// distinct timestamps there are. An id without a read `updated_at` is not
// marked (fail-closed). It writes `status` only — never `remaining_amount`,
// never a payment status (D1). Each update must report back (RETURNING)
// exactly the rows it was asked to mark. ALL batches are tried (H6-02): every
// invoice in the downloaded file gets its chance to be marked; afterwards the
// unmarked ids are reported in one PurchaseExportMarkError, never as success.
// The caller must invalidate ["purchase_invoices"] once after this settles.
export async function markPurchaseInvoicesExported(opts: {
  organizationId: string;
  clientId: string;
  invoiceIds: readonly string[];
  fetchedUpdatedAt?: ReadonlyMap<string, string | null | undefined>;
}): Promise<{ marked: number }> {
  const { organizationId, clientId, fetchedUpdatedAt } = opts;
  if (!organizationId) {
    throw new Error("Geen actieve organisatie: export-status kan niet worden bijgewerkt");
  }
  if (!clientId || clientId === "all") {
    throw new Error("Geen administratie gekozen: export-status kan niet worden bijgewerkt");
  }
  const invoiceIds = [...new Set(opts.invoiceIds)];
  let marked = 0;
  const unmarked: string[] = [];
  const errors: string[] = [];
  const markable = fetchedUpdatedAt
    ? invoiceIds.filter((id) => {
        if (fetchedUpdatedAt.get(id)) return true;
        unmarked.push(id); // fail-closed: no read value, no compare-and-set possible
        return false;
      })
    : invoiceIds;
  const size = fetchedUpdatedAt ? STATUS_UPDATE_CAS_BATCH_SIZE : STATUS_UPDATE_BATCH_SIZE;
  for (let i = 0; i < markable.length; i += size) {
    const batch = markable.slice(i, i + size);
    let query = supabase
      .from("purchase_invoices")
      .update({ status: "geexporteerd" })
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .in("id", batch)
      .in("status", [...EXPORTABLE_STATUSES]);
    if (fetchedUpdatedAt) {
      query = query.or(
        batch
          .map((id) => `and(id.eq.${postgrestQuoted(id)},updated_at.eq.${postgrestQuoted(fetchedUpdatedAt.get(id)!)})`)
          .join(","),
      );
    }
    const { data, error } = await query.select("id");
    if (error) {
      errors.push(error.message);
      unmarked.push(...batch);
      continue;
    }
    const hit = new Set((data ?? []).map((r: { id: string }) => r.id));
    marked += batch.filter((id) => hit.has(id)).length;
    unmarked.push(...batch.filter((id) => !hit.has(id)));
  }
  if (unmarked.length) {
    // Keep the caller's order so the message names invoices predictably.
    const order = new Map(invoiceIds.map((id, i) => [id, i]));
    unmarked.sort((a, b) => order.get(a)! - order.get(b)!);
  }
  if (unmarked.length) {
    throw new PurchaseExportMarkError(
      `${marked} van ${invoiceIds.length} facturen op 'geëxporteerd' gezet; ${unmarked.length} niet ` +
        `(geen rechten, de status is intussen gewijzigd of de factuur is na het ophalen bewerkt)` +
        (errors.length ? `: ${[...new Set(errors)].join("; ")}` : "."),
      marked,
      invoiceIds.length,
      unmarked,
    );
  }
  return { marked };
}

export const DUPLICATE_LOOKUP_BATCH_SIZE = 25;

export type DuplicateCandidate = Pick<
  PurchaseInvoice,
  "id" | "client_id" | "invoice_number" | "supplier" | "supplier_btw_number" | "leverancier_id"
>;

// Looks up potential duplicates for the invoice numbers on the current page
// across the entire table (so duplicates on other pages are found), fetching
// only the columns the duplicate check needs, in small batches.
export async function fetchPurchaseInvoiceDuplicateCandidates(
  pageInvoices: ReadonlyArray<DuplicateCandidate>,
  opts: { organizationId?: string } = {},
): Promise<DuplicateCandidate[]> {
  const numbers = [...new Set(
    pageInvoices
      .filter(inv => (inv.invoice_number || "").trim() && inv.client_id)
      .map(inv => inv.invoice_number!.trim())
  )];
  const clientIds = [...new Set(
    pageInvoices.filter(inv => inv.client_id).map(inv => inv.client_id!)
  )];
  if (!numbers.length || !clientIds.length) return [];

  const out: DuplicateCandidate[] = [];
  for (let i = 0; i < numbers.length; i += DUPLICATE_LOOKUP_BATCH_SIZE) {
    const batch = numbers.slice(i, i + DUPLICATE_LOOKUP_BATCH_SIZE);
    let query = supabase
      .from("purchase_invoices")
      .select("id, client_id, invoice_number, supplier, supplier_btw_number, leverancier_id")
      .in("invoice_number", batch)
      .in("client_id", clientIds);
    if (opts.organizationId) query = query.eq("organization_id", opts.organizationId);
    const { data, error } = await query;
    if (error) throw error;
    out.push(...((data ?? []) as DuplicateCandidate[]));
  }
  return out;
}

// Same duplicate semantics the overview always used: group on
// client_id + trimmed invoice_number, then match on leverancier_id,
// normalized BTW number or normalized supplier name; rows without any
// identity count as a match within their group.
export function computeDuplicateIds(candidates: ReadonlyArray<DuplicateCandidate>): Set<string> {
  const result = new Set<string>();
  const normBtw = (s: string | null | undefined) =>
    (s || "").toUpperCase().replace(/[\s.\-]/g, "");
  const normName = (s: string | null | undefined) =>
    (s || "").toLowerCase().trim().replace(/\s+/g, " ");
  const groups = new Map<string, DuplicateCandidate[]>();
  for (const inv of candidates) {
    const num = (inv.invoice_number || "").trim();
    if (!num || !inv.client_id) continue;
    const key = `${inv.client_id}|${num}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(inv);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      const aBtw = normBtw(a.supplier_btw_number);
      const aName = normName(a.supplier);
      const aHasIdentity = !!a.leverancier_id || !!aBtw || !!aName;
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j];
        const bBtw = normBtw(b.supplier_btw_number);
        const bName = normName(b.supplier);
        const bHasIdentity = !!b.leverancier_id || !!bBtw || !!bName;
        let match = false;
        if (a.leverancier_id && b.leverancier_id && a.leverancier_id === b.leverancier_id) match = true;
        else if (aBtw && bBtw && aBtw === bBtw) match = true;
        else if (aName && bName && aName === bName) match = true;
        else if (!aHasIdentity || !bHasIdentity) match = true;
        if (match) {
          result.add(a.id);
          result.add(b.id);
        }
      }
    }
  }
  return result;
}

export function usePurchaseInvoiceDuplicates(
  pageInvoices: PurchaseInvoice[] | undefined,
  organizationId?: string,
) {
  const pairsKey = (pageInvoices ?? [])
    .filter(inv => (inv.invoice_number || "").trim() && inv.client_id)
    .map(inv => `${inv.client_id}|${inv.invoice_number!.trim()}`)
    .sort()
    .join(",");

  return useQuery<Set<string>>({
    queryKey: ["purchase_invoices", "duplicates", organizationId ?? "all", pairsKey],
    queryFn: async () => {
      const fetched = await fetchPurchaseInvoiceDuplicateCandidates(pageInvoices ?? [], { organizationId });
      // Merge the page rows in so the check still works if the lookup misses them.
      const byId = new Map<string, DuplicateCandidate>();
      for (const inv of pageInvoices ?? []) byId.set(inv.id, inv);
      for (const c of fetched) byId.set(c.id, c);
      return computeDuplicateIds([...byId.values()]);
    },
    enabled: (pageInvoices?.length ?? 0) > 0,
  });
}

// Reset pagination whenever any filter/sort dependency changes, but not on mount.
export function useResetPageOnChange(reset: () => void, deps: readonly unknown[]) {
  const firstRun = useRef(true);
  const signature = JSON.stringify(deps);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}

export function usePurchaseInvoices(options: UsePurchaseInvoicesOptions = {}) {
  const { organizationId, clientId, enabled = true } = options;
  const { user } = useAuth();
  return useQuery({
    queryKey: ["purchase_invoices", organizationId ?? "all", clientId ?? "all"],
    queryFn: async () => {
      let query = supabase.from("purchase_invoices").select("*").order("invoice_date", { ascending: false });
      if (organizationId) query = query.eq("organization_id", organizationId);
      if (clientId) query = query.eq("client_id", clientId);
      const { data, error } = await query;
      if (error) throw error;
      return data as PurchaseInvoice[];
    },
    enabled: !!user && enabled,
  });
}

export function useAddPurchaseInvoice() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (invoice: Omit<PurchaseInvoiceInsert, "user_id">) => {
      if (!user) throw new Error("Not authenticated");
      const remainingAmount = invoice.remaining_amount ?? invoice.amount_incl ?? invoice.amount_excl ?? null;
      const { data, error } = await supabase
        .from("purchase_invoices")
        .insert({ ...invoice, user_id: user.id, remaining_amount: remainingAmount })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase_invoices"] }),
  });
}

export function useUpdatePurchaseInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<PurchaseInvoice> & { id: string }) => {
      const { data, error } = await supabase
        .from("purchase_invoices")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase_invoices"] }),
  });
}

export function useDeletePurchaseInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error: linesErr } = await supabase
        .from("purchase_invoice_lines")
        .delete()
        .eq("purchase_invoice_id", invoiceId);
      if (linesErr) throw linesErr;

      const { error } = await supabase.from("purchase_invoices").delete().eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase_invoices"] });
      qc.invalidateQueries({ queryKey: ["purchase_invoice_lines"] });
    },
  });
}
