import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type BankTransaction = Tables<"bank_transactions">;
type BankTransactionInsert = TablesInsert<"bank_transactions">;

export const BANK_TRANSACTIONS_PAGE_SIZE = 50;
export const BANK_FETCH_BATCH_SIZE = 1000;

export interface UseBankTransactionsOptions {
  organizationId?: string;
  clientId?: string;
  /** Beperk de query server-side tot deze klant-IDs. Leeg = geen resultaten. */
  clientIds?: string[];
  enabled?: boolean;
}

// PostgREST or() breaks on commas/parens and ilike treats % and _ as
// wildcards; strip the former and escape the latter so input stays literal.
export function bankSanitizeSearchTerm(raw: string): string {
  return raw
    .trim()
    .replace(/[,()"']/g, " ")
    .replace(/[%_]/g, (m) => `\\${m}`)
    .replace(/\s+/g, " ")
    .trim();
}

// Only workflow statuses that map cleanly to the stored match_status column
// can be filtered server-side. Derived statuses (blokkeert_export /
// niet_in_bankexport) depend on resolveBankExportGrootboek and stay client-side.
export const BANK_STATUS_MATCH_VALUES: Record<string, string[] | undefined> = {
  all: undefined,
  open: ["niet_gematcht", "suggestie"],
  gematcht: ["gematcht"],
  handmatig: ["handmatig_geboekt"],
};

export function isServerFilterableBankStatus(status: string): boolean {
  return Object.prototype.hasOwnProperty.call(BANK_STATUS_MATCH_VALUES, status);
}

export type BankTransactionSortField = "date" | "amount" | "description" | "status";

const BANK_SORT_COLUMNS: Record<BankTransactionSortField, string> = {
  date: "transaction_date",
  amount: "amount",
  description: "description",
  status: "match_status",
};

function applyScope<T extends { eq: (...a: any[]) => T; in: (...a: any[]) => T }>(
  query: T,
  opts: { organizationId?: string; clientId?: string; clientIds?: string[] },
): T | null {
  let q = query;
  if (opts.organizationId) q = q.eq("organization_id", opts.organizationId);
  if (opts.clientId) q = q.eq("client_id", opts.clientId);
  if (opts.clientIds) {
    if (opts.clientIds.length === 0) return null; // empty subset ⇒ no rows
    q = q.in("client_id", opts.clientIds);
  }
  return q;
}

export interface UsePaginatedBankTransactionsOptions extends UseBankTransactionsOptions {
  page: number; // 1-based
  pageSize?: number;
  search?: string;
  status?: string; // key of BANK_STATUS_MATCH_VALUES; other values disable the server status filter
  sortField?: BankTransactionSortField;
  sortDir?: "asc" | "desc";
}

export interface PaginatedBankTransactions {
  transactions: BankTransaction[];
  total: number;
}

export function usePaginatedBankTransactions(options: UsePaginatedBankTransactionsOptions) {
  const {
    organizationId,
    clientId,
    clientIds,
    enabled = true,
    page,
    pageSize = BANK_TRANSACTIONS_PAGE_SIZE,
    search = "",
    status = "all",
    sortField = "date",
    sortDir = "desc",
  } = options;
  const { user } = useAuth();
  const clientIdsKey = clientIds ? [...clientIds].sort().join(",") : "";
  const cleanSearch = bankSanitizeSearchTerm(search);
  const statusValues = BANK_STATUS_MATCH_VALUES[status];

  return useQuery<PaginatedBankTransactions>({
    queryKey: [
      "bank_transactions",
      "page",
      organizationId ?? "all",
      clientId ?? "all",
      clientIdsKey,
      page,
      pageSize,
      cleanSearch,
      status,
      sortField,
      sortDir,
    ],
    queryFn: async () => {
      let query: any = supabase.from("bank_transactions").select("*", { count: "exact" });
      query = applyScope(query, { organizationId, clientId, clientIds });
      if (query === null) return { transactions: [], total: 0 };
      if (statusValues) query = query.in("match_status", statusValues);
      if (cleanSearch) {
        query = query.or(
          `description.ilike.%${cleanSearch}%,reference.ilike.%${cleanSearch}%,counter_account.ilike.%${cleanSearch}%`
        );
      }
      const from = (page - 1) * pageSize;
      const { data, error, count } = await query
        .order(BANK_SORT_COLUMNS[sortField], { ascending: sortDir === "asc", nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      return { transactions: (data ?? []) as BankTransaction[], total: count ?? 0 };
    },
    placeholderData: keepPreviousData,
    enabled: !!user && enabled,
  });
}

// Fetches every matching transaction in deterministic id-ordered batches so
// whole-dataset workflows (stats, suggestions, blockers, export) are complete
// past PostgREST's max-rows cap. Only run this on demand / after a selection,
// never as an unbounded select on mount.
export async function fetchAllBankTransactions(
  opts: UseBankTransactionsOptions = {},
): Promise<BankTransaction[]> {
  if (opts.clientIds && opts.clientIds.length === 0) return [];
  const all: BankTransaction[] = [];
  for (let offset = 0; ; offset += BANK_FETCH_BATCH_SIZE) {
    let query: any = supabase.from("bank_transactions").select("*");
    query = applyScope(query, opts);
    if (query === null) return [];
    // Preserve the previous whole-dataset ordering (transaction_date DESC),
    // with id ASC as a deterministic tiebreaker so batch windows never overlap
    // or skip rows. Applied to every batch.
    const { data, error } = await query
      .order("transaction_date", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + BANK_FETCH_BATCH_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as BankTransaction[];
    all.push(...batch);
    if (batch.length < BANK_FETCH_BATCH_SIZE) return all;
  }
}

// Whole-dataset hook powering matching/stats/blockers/export. Now batched, so
// it is correct beyond 1000 rows. Gate it behind a selection so it never runs
// on bare mount.
export function useBankTransactions(options: UseBankTransactionsOptions = {}) {
  const { organizationId, clientId, clientIds, enabled = true } = options;
  const { user } = useAuth();
  const clientIdsKey = clientIds ? [...clientIds].sort().join(",") : "";
  return useQuery({
    queryKey: ["bank_transactions", "all", organizationId ?? "all", clientId ?? "all", clientIdsKey],
    queryFn: () => fetchAllBankTransactions({ organizationId, clientId, clientIds }),
    enabled: !!user && enabled,
  });
}

export function useAddBankTransaction() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (tx: Omit<BankTransactionInsert, "user_id">) => {
      if (!user) throw new Error("Not authenticated");
      const { data, error } = await supabase
        .from("bank_transactions")
        .insert({ ...tx, user_id: user.id })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bank_transactions"] }),
  });
}

export function useUpdateBankTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<BankTransaction> & { id: string }) => {
      const { data, error } = await supabase
        .from("bank_transactions")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bank_transactions"] }),
  });
}
