import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

// Local type until src/integrations/supabase/types.ts is regenerated from the DB schema.
// After running `supabase gen types typescript`, remove this block and import from types.ts.
export type BankTransactionAllocation = {
  id: string;
  bank_transaction_id: string;
  invoice_type: "inkoop" | "verkoop";
  invoice_id: string;
  client_id: string;
  amount: number;
  user_id: string;
  created_at: string;
  updated_at: string;
};

export type BankTransactionAllocationInsert = Omit<BankTransactionAllocation, "id" | "user_id" | "created_at" | "updated_at">;

const TABLE = "bank_transaction_allocations" as const;
const QUERY_KEY = ["bank_transaction_allocations"] as const;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface UseBankTransactionAllocationsOptions {
  organizationId?: string;
  clientId?: string;
  enabled?: boolean;
}

/**
 * List all allocation rows, optionally scoped to an org and/or client.
 * Suitable for building a lookup map (allocationsByTransactionId, etc.)
 * for the Bankafschriften table.
 */
export function useBankTransactionAllocations(options: UseBankTransactionAllocationsOptions = {}) {
  const { organizationId, clientId, enabled = true } = options;
  const { user } = useAuth();
  return useQuery({
    queryKey: [...QUERY_KEY, organizationId ?? "all", clientId ?? "all"],
    queryFn: async () => {
      let query = supabase
        .from(TABLE)
        .select("*")
        .order("created_at", { ascending: true });
      if (organizationId) query = query.eq("organization_id", organizationId);
      if (clientId) query = query.eq("client_id", clientId);
      const { data, error } = await query;
      if (error) throw error;
      return data as BankTransactionAllocation[];
    },
    enabled: !!user && enabled,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Insert a single allocation row.
 * Fails if a row for (bank_transaction_id, invoice_id) already exists.
 * Use useUpsertBankTransactionAllocation when you want to overwrite the amount.
 */
export function useAddBankTransactionAllocation() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (allocation: BankTransactionAllocationInsert) => {
      if (!user) throw new Error("Not authenticated");
      const { data, error } = await supabase
        .from(TABLE)
        .insert({ ...allocation, user_id: user.id })
        .select()
        .single();
      if (error) throw error;
      return data as BankTransactionAllocation;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

/**
 * Insert or update an allocation row by the unique key (bank_transaction_id, invoice_id).
 * On conflict the amount (and updated_at) is overwritten — all other columns are unchanged.
 * Use this for the matching flow where re-confirming a link should adjust the amount.
 */
export function useUpsertBankTransactionAllocation() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (allocation: BankTransactionAllocationInsert) => {
      if (!user) throw new Error("Not authenticated");
      const { data, error } = await supabase
        .from(TABLE)
        .upsert(
          { ...allocation, user_id: user.id },
          { onConflict: "bank_transaction_id,invoice_id" },
        )
        .select()
        .single();
      if (error) throw error;
      return data as BankTransactionAllocation;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

/**
 * Delete a single allocation row by its primary key (id).
 */
export function useDeleteBankTransactionAllocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from(TABLE).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

/**
 * Delete all allocation rows for a given bank transaction.
 * Call this as part of the unlink flow before clearing matched_invoice_id.
 */
export function useDeleteAllocationsForTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (bankTransactionId: string) => {
      const { error } = await supabase
        .from(TABLE)
        .delete()
        .eq("bank_transaction_id", bankTransactionId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

/**
 * Delete all allocation rows for a given invoice.
 * Call this when an invoice is fully unlinked from all bank transactions,
 * or before deleting/reallocating an invoice from scratch.
 */
export function useDeleteAllocationsForInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error } = await supabase
        .from(TABLE)
        .delete()
        .eq("invoice_id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}
