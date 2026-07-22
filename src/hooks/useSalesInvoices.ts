import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useActiveOrganization } from "./useActiveOrganization";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type SalesInvoice = Tables<"sales_invoices">;
type SalesInvoiceInsert = TablesInsert<"sales_invoices">;

export const SALES_INVOICES_PAGE_SIZE = 50;
export const SALES_FETCH_BATCH_SIZE = 1000;

// Escape a term so it matches literally inside a PostgREST .or() ilike filter,
// WITHOUT dropping any of the user's characters:
//  - `\`, `%`, `_` are escaped so LIKE treats them as literals;
//  - the value is wrapped in double quotes so PostgREST reserved characters
//    (`,` `.` `:` `(` `)`) are preserved literally instead of parsed as syntax;
//  - `"` inside the value is backslash-escaped.
// Apostrophes and other punctuation pass through unchanged.
export function escapeIlikeValue(term: string): string {
  const likeEscaped = term
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/"/g, '\\"');
  return `"%${likeEscaped}%"`;
}

// Build a PostgREST or() argument that matches `term` as a literal substring
// across the given columns. Returns "" when the term is blank.
export function buildIlikeOrFilter(columns: readonly string[], term: string): string {
  const trimmed = term.trim();
  if (!trimmed) return "";
  const value = escapeIlikeValue(trimmed);
  return columns.map((c) => `${c}.ilike.${value}`).join(",");
}

// Cache-key fragment for a search term. Must represent EXACTLY the term sent to
// the backend: applySearch()/buildIlikeOrFilter only trim leading/trailing space
// (they preserve internal whitespace and punctuation), so this trims only too.
// Collapsing internal whitespace here would let "ACME  BV" and "ACME BV" — which
// are different backend queries — share one React Query cache entry.
export function searchCacheKey(raw: string): string {
  return raw.trim();
}

const SALES_SEARCH_COLUMNS = ["invoice_number", "customer_name", "status"] as const;

// "client" (cross-table name lookup) and "status" (the table displays a
// derived payment status, not the stored workflow status) are intentionally
// not sortable server-side.
export type SalesInvoiceSortField =
  | "invoice_number" | "customer_name" | "date" | "due_date" | "amount" | "btw";

const SALES_SORT_COLUMNS: Record<SalesInvoiceSortField, string> = {
  invoice_number: "invoice_number",
  customer_name: "customer_name",
  date: "invoice_date",
  due_date: "due_date",
  amount: "amount_incl",
  btw: "btw_amount",
};

function applySearch(query: any, term: string) {
  const filter = buildIlikeOrFilter(SALES_SEARCH_COLUMNS, term);
  if (!filter) return query;
  return query.or(filter);
}

// Clamp a 1-based page into [1, totalPages]; used to recover after a deletion
// or mutation shrinks the result set below the current page.
export function clampPage(page: number, totalPages: number): number {
  const max = Math.max(1, totalPages);
  if (page < 1) return 1;
  if (page > max) return max;
  return page;
}

export interface UsePaginatedSalesInvoicesOptions {
  clientId?: string;
  enabled?: boolean;
  page: number; // 1-based
  pageSize?: number;
  search?: string;
  status?: string; // "all" disables the filter
  sortField?: SalesInvoiceSortField;
  sortDir?: "asc" | "desc";
}

export interface PaginatedSalesInvoices {
  invoices: SalesInvoice[];
  total: number;
}

export function usePaginatedSalesInvoices(options: UsePaginatedSalesInvoicesOptions) {
  const {
    clientId,
    enabled = true,
    page,
    pageSize = SALES_INVOICES_PAGE_SIZE,
    search = "",
    status = "all",
    sortField = "date",
    sortDir = "desc",
  } = options;
  const { user } = useAuth();
  const { activeOrganizationId } = useActiveOrganization();
  const searchKey = searchCacheKey(search);

  return useQuery<PaginatedSalesInvoices>({
    queryKey: [
      "sales_invoices",
      "page",
      activeOrganizationId ?? "none",
      clientId ?? "all",
      page,
      pageSize,
      searchKey,
      status,
      sortField,
      sortDir,
    ],
    queryFn: async () => {
      let query: any = supabase
        .from("sales_invoices")
        .select("*", { count: "exact" })
        .eq("organization_id", activeOrganizationId!);
      if (clientId) query = query.eq("client_id", clientId);
      if (status !== "all") query = query.eq("status", status);
      query = applySearch(query, search);
      const from = (page - 1) * pageSize;
      const { data, error, count } = await query
        .order(SALES_SORT_COLUMNS[sortField], { ascending: sortDir === "asc", nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      return { invoices: (data ?? []) as SalesInvoice[], total: count ?? 0 };
    },
    placeholderData: keepPreviousData,
    enabled: !!user && !!activeOrganizationId && enabled,
  });
}

// Fetches every matching sales invoice in deterministic batches, preserving
// the previous invoice_date DESC ordering with id ASC as tiebreaker so batch
// windows never overlap or skip rows. Correct beyond PostgREST's max-rows cap.
// organizationId is required: every read stays org-scoped.
export async function fetchAllSalesInvoices(opts: {
  organizationId: string;
  clientId?: string;
  clientIds?: string[];
  statuses?: readonly string[];
}): Promise<SalesInvoice[]> {
  if (!opts.organizationId) {
    throw new Error("Geen actieve organisatie: verkoopfacturen kunnen niet worden geladen");
  }
  if (opts.clientIds && opts.clientIds.length === 0) return []; // empty subset ⇒ no rows
  const all: SalesInvoice[] = [];
  for (let offset = 0; ; offset += SALES_FETCH_BATCH_SIZE) {
    let query: any = supabase
      .from("sales_invoices")
      .select("*")
      .eq("organization_id", opts.organizationId);
    if (opts.clientId) query = query.eq("client_id", opts.clientId);
    if (opts.clientIds) query = query.in("client_id", opts.clientIds);
    if (opts.statuses) query = query.in("status", [...opts.statuses]);
    const { data, error } = await query
      .order("invoice_date", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + SALES_FETCH_BATCH_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as SalesInvoice[];
    all.push(...batch);
    if (batch.length < SALES_FETCH_BATCH_SIZE) return all;
  }
}

export interface UseSalesInvoicesOptions {
  clientId?: string;
  clientIds?: string[];
  enabled?: boolean;
}

// Whole-dataset hook for consumers that genuinely need every invoice
// (Bank.tsx matching/aflettering). Batched, correct beyond 1000 rows.
// Callers MUST gate it: without `enabled` it would fetch the whole org
// dataset on mount. Empty `clientIds` yields no rows.
export function useSalesInvoices(options: UseSalesInvoicesOptions = {}) {
  const { clientId, clientIds, enabled = true } = options;
  const { user } = useAuth();
  const { activeOrganizationId } = useActiveOrganization();
  const clientIdsKey = clientIds ? [...clientIds].sort().join(",") : "";
  return useQuery({
    queryKey: ["sales_invoices", "all", activeOrganizationId ?? "none", clientId ?? "all", clientIdsKey],
    queryFn: () => fetchAllSalesInvoices({ organizationId: activeOrganizationId!, clientId, clientIds }),
    enabled: !!user && !!activeOrganizationId && enabled,
  });
}

// ── Receivables summary ─────────────────────────────────────────────────────
// Whole-dataset aggregate (open totals depend on every invoice). Fetches only
// the five columns the computation needs, in deterministic batches — never the
// complete table rows.

export type ReceivableRow = Pick<
  SalesInvoice,
  "id" | "status" | "amount_excl" | "amount_incl" | "remaining_amount"
>;

export interface ReceivablesSummary {
  openTotal: number;
  countOpen: number;
  countPartial: number;
  countPaid: number;
  totalInvoices: number;
}

function paymentStateOf(inv: ReceivableRow): "paid" | "partial" | "open" {
  if (inv.status === "betaald") return "paid";
  const total = inv.amount_incl ?? inv.amount_excl ?? null;
  const remaining = inv.remaining_amount ?? total;
  if (remaining === 0) return "paid";
  if (total != null && remaining != null && remaining > 0 && remaining < total) return "partial";
  return "open";
}

export function computeReceivablesSummary(rows: readonly ReceivableRow[]): ReceivablesSummary {
  let openTotal = 0, countOpen = 0, countPartial = 0, countPaid = 0;
  for (const inv of rows) {
    const state = paymentStateOf(inv);
    const total = inv.amount_incl ?? inv.amount_excl ?? 0;
    const remaining = inv.remaining_amount ?? total;
    if (state === "paid") countPaid++;
    else if (state === "partial") { countPartial++; openTotal += remaining ?? 0; }
    else { countOpen++; openTotal += remaining ?? 0; }
  }
  return { openTotal, countOpen, countPartial, countPaid, totalInvoices: rows.length };
}

export async function fetchReceivableRows(opts: {
  organizationId: string;
  clientId?: string;
  search?: string;
}): Promise<ReceivableRow[]> {
  if (!opts.organizationId) {
    throw new Error("Geen actieve organisatie: samenvatting kan niet worden geladen");
  }
  const all: ReceivableRow[] = [];
  for (let offset = 0; ; offset += SALES_FETCH_BATCH_SIZE) {
    let query: any = supabase
      .from("sales_invoices")
      .select("id, status, amount_excl, amount_incl, remaining_amount")
      .eq("organization_id", opts.organizationId);
    if (opts.clientId) query = query.eq("client_id", opts.clientId);
    query = applySearch(query, opts.search ?? "");
    const { data, error } = await query
      .order("id", { ascending: true })
      .range(offset, offset + SALES_FETCH_BATCH_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as ReceivableRow[];
    all.push(...batch);
    if (batch.length < SALES_FETCH_BATCH_SIZE) return all;
  }
}

export function useSalesReceivablesSummary(opts: {
  clientId?: string;
  search?: string;
  enabled?: boolean;
}) {
  const { user } = useAuth();
  const { activeOrganizationId } = useActiveOrganization();
  const searchKey = searchCacheKey(opts.search ?? "");
  return useQuery<ReceivablesSummary>({
    queryKey: [
      "sales_invoices",
      "receivables",
      activeOrganizationId ?? "none",
      opts.clientId ?? "all",
      searchKey,
    ],
    queryFn: async () => {
      const rows = await fetchReceivableRows({
        organizationId: activeOrganizationId!,
        clientId: opts.clientId,
        search: opts.search ?? "",
      });
      return computeReceivablesSummary(rows);
    },
    enabled: !!user && !!activeOrganizationId && (opts.enabled ?? true),
  });
}

// ── Duplicate detection ─────────────────────────────────────────────────────
// Same semantics the overview always used: normalized customer_name +
// invoice_number pairs with two or more invoices are duplicates. Candidates
// for the current page are looked up server-side in small batches (minimal
// columns), so duplicates on other pages are found without a full-list load.
//
// The lookup is deliberately a *broad* net: a case-insensitive ilike substring
// match per invoice number catches stored variants like " vf-001 " and "VF-001".
// It is NOT an exact `.in(...)`. computeSalesDuplicateIds then applies the final
// normalized (trim + lowercase) customer_name + invoice_number equality so any
// over-matches (e.g. "VF-0011" when looking up "VF-001") are discarded.

export const SALES_DUPLICATE_LOOKUP_BATCH_SIZE = 25;

export type SalesDuplicateCandidate = Pick<SalesInvoice, "id" | "customer_name" | "invoice_number">;

export function computeSalesDuplicateIds(rows: readonly SalesDuplicateCandidate[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const inv of rows) {
    const normName = inv.customer_name?.trim().toLowerCase() ?? "";
    const normNum = inv.invoice_number?.trim().toLowerCase() ?? "";
    if (!normName || !normNum) continue;
    const key = `${normName}||${normNum}`;
    const group = groups.get(key) ?? [];
    group.push(inv.id);
    groups.set(key, group);
  }
  const result = new Set<string>();
  for (const ids of groups.values()) {
    if (ids.length >= 2) ids.forEach(id => result.add(id));
  }
  return result;
}

export async function fetchSalesDuplicateCandidates(
  pageInvoices: ReadonlyArray<SalesDuplicateCandidate>,
  opts: { organizationId: string; clientId?: string },
): Promise<SalesDuplicateCandidate[]> {
  if (!opts.organizationId) return [];
  const numbers = [...new Set(
    pageInvoices
      .filter(inv => (inv.invoice_number || "").trim() && (inv.customer_name || "").trim())
      .map(inv => inv.invoice_number!.trim())
  )];
  if (!numbers.length) return [];
  const out: SalesDuplicateCandidate[] = [];
  for (let i = 0; i < numbers.length; i += SALES_DUPLICATE_LOOKUP_BATCH_SIZE) {
    const batch = numbers.slice(i, i + SALES_DUPLICATE_LOOKUP_BATCH_SIZE);
    // Case/whitespace-tolerant candidate net: one ilike substring per number.
    const filter = batch
      .map((num) => `invoice_number.ilike.${escapeIlikeValue(num)}`)
      .join(",");
    let query: any = supabase
      .from("sales_invoices")
      .select("id, customer_name, invoice_number")
      .eq("organization_id", opts.organizationId)
      .or(filter);
    if (opts.clientId) query = query.eq("client_id", opts.clientId);
    const { data, error } = await query;
    if (error) throw error;
    out.push(...((data ?? []) as SalesDuplicateCandidate[]));
  }
  return out;
}

export function useSalesInvoiceDuplicates(
  pageInvoices: SalesInvoice[] | undefined,
  clientId?: string,
) {
  const { user } = useAuth();
  const { activeOrganizationId } = useActiveOrganization();
  const pairsKey = (pageInvoices ?? [])
    .filter(inv => (inv.invoice_number || "").trim() && (inv.customer_name || "").trim())
    .map(inv => `${inv.customer_name!.trim().toLowerCase()}||${inv.invoice_number!.trim().toLowerCase()}`)
    .sort()
    .join(",");

  return useQuery<Set<string>>({
    queryKey: ["sales_invoices", "duplicates", activeOrganizationId ?? "none", clientId ?? "all", pairsKey],
    queryFn: async () => {
      const fetched = await fetchSalesDuplicateCandidates(pageInvoices ?? [], {
        organizationId: activeOrganizationId!,
        clientId,
      });
      const byId = new Map<string, SalesDuplicateCandidate>();
      for (const inv of pageInvoices ?? []) byId.set(inv.id, inv);
      for (const c of fetched) byId.set(c.id, c);
      return computeSalesDuplicateIds([...byId.values()]);
    },
    enabled: !!user && !!activeOrganizationId && (pageInvoices?.length ?? 0) > 0,
  });
}

// ── Mutations (unchanged semantics; family-wide invalidation) ───────────────

export function useAddSalesInvoice() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (inv: Omit<SalesInvoiceInsert, "user_id">) => {
      if (!user) throw new Error("Not authenticated");
      const remainingAmount = inv.remaining_amount ?? inv.amount_incl ?? inv.amount_excl ?? null;
      const { data, error } = await supabase
        .from("sales_invoices")
        .insert({ ...inv, user_id: user.id, remaining_amount: remainingAmount })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sales_invoices"] }),
  });
}

export function useUpdateSalesInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<SalesInvoice> & { id: string }) => {
      const { data, error } = await supabase
        .from("sales_invoices")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sales_invoices"] }),
  });
}

export function useDeleteSalesInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error } = await supabase.from("sales_invoices").delete().eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sales_invoices"] }),
  });
}
