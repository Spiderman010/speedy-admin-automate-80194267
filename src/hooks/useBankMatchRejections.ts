import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { InvoiceCandidate } from "@/components/BankMatchDialog";

// Local type until src/integrations/supabase/types.ts is regenerated from the
// DB schema (same convention as useBankTransactionAllocations). After running
// `supabase gen types typescript`, remove this block and import from types.ts.
export type BankMatchRejection = {
  id: string;
  organization_id: string;
  client_id: string;
  bank_transaction_id: string;
  invoice_id: string;
  invoice_type: "inkoop" | "verkoop";
  rejected_by: string | null;
  created_at: string;
};

export type BankMatchRejectionInsert = Omit<
  BankMatchRejection,
  "id" | "rejected_by" | "created_at"
>;

const TABLE = "bank_match_rejections";
const QUERY_KEY = ["bank_match_rejections"] as const;

// The table is not yet in the generated types; cast the accessor until
// types.ts is regenerated (mirrors the local-type convention above).
const rejectionsTable = () =>
  (supabase.from as unknown as (table: string) => ReturnType<typeof supabase.from>)(TABLE);

// ---------------------------------------------------------------------------
// Pure helpers — the single shared rejection predicate for every matching path
// ---------------------------------------------------------------------------

/** Build a bank_transaction_id → Set<invoice_id> lookup from rejection rows. */
export function buildRejectionMap(
  rejections: readonly BankMatchRejection[] | undefined,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const r of rejections ?? []) {
    const existing = map.get(r.bank_transaction_id);
    if (existing) existing.add(r.invoice_id);
    else map.set(r.bank_transaction_id, new Set([r.invoice_id]));
  }
  return map;
}

/**
 * Remove candidates the user explicitly rejected for this transaction.
 * This runs BEFORE any top-candidate selection so a rejected invoice can
 * never win the ranking again — while every other candidate stays eligible.
 */
export function filterRejectedCandidates(
  candidates: InvoiceCandidate[],
  rejectedInvoiceIds: ReadonlySet<string> | undefined,
): InvoiceCandidate[] {
  if (!rejectedInvoiceIds || rejectedInvoiceIds.size === 0) return candidates;
  return candidates.filter(c => !rejectedInvoiceIds.has(c.id));
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface UseBankMatchRejectionsOptions {
  organizationId?: string;
  clientId?: string;
  /** Beperk de query server-side tot deze klant-IDs. Leeg = geen resultaten. */
  clientIds?: string[];
  enabled?: boolean;
}

/** List rejection rows scoped to an org and/or client selection. */
export function useBankMatchRejections(options: UseBankMatchRejectionsOptions = {}) {
  const { organizationId, clientId, clientIds, enabled = true } = options;
  const { user } = useAuth();
  const clientIdsKey = clientIds ? [...clientIds].sort().join(",") : "";
  return useQuery({
    queryKey: [...QUERY_KEY, organizationId ?? "all", clientId ?? "all", clientIdsKey],
    queryFn: async () => {
      let query = rejectionsTable()
        .select("*")
        .order("created_at", { ascending: true });
      if (organizationId) query = query.eq("organization_id", organizationId);
      if (clientId) query = query.eq("client_id", clientId);
      if (clientIds) {
        if (clientIds.length === 0) return [] as BankMatchRejection[];
        query = query.in("client_id", clientIds);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data as unknown as BankMatchRejection[];
    },
    enabled: !!user && enabled,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Record an explicit rejection. Upserts on the unique
 * (bank_transaction_id, invoice_id) key with ignoreDuplicates so rejecting
 * the same combination twice can never create duplicate rows.
 */
export function useAddBankMatchRejection() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (rejection: BankMatchRejectionInsert) => {
      if (!user) throw new Error("Not authenticated");
      const { error } = await rejectionsTable().upsert(
        { ...rejection, rejected_by: user.id },
        { onConflict: "bank_transaction_id,invoice_id", ignoreDuplicates: true },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

/**
 * Clear the rejection for one exact combination. Called ONLY after an
 * explicit, successful manual confirmation of that same invoice — automatic
 * recalculation must never clear rejection history.
 */
export function useClearBankMatchRejection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { bankTransactionId: string; invoiceId: string }) => {
      const { error } = await rejectionsTable()
        .delete()
        .eq("bank_transaction_id", input.bankTransactionId)
        .eq("invoice_id", input.invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}
