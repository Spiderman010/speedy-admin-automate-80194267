import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/fetch-all-rows";
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

const TABLE = "bank_transaction_allocations" as const;
const QUERY_KEY = ["bank_transaction_allocations"] as const;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface UseBankTransactionAllocationsOptions {
  organizationId?: string;
  clientId?: string;
  /** Beperk de query server-side tot deze klant-IDs. Leeg = geen resultaten. */
  clientIds?: string[];
  enabled?: boolean;
}

/**
 * Every allocation row of the scope, fetched page by page so the list is
 * complete beyond PostgREST's row cap. Callers sum these rows to recalculate
 * what is still open on an invoice, so a silently truncated list (the newest
 * rows fell off: created_at ASC) would write a wrong remaining amount.
 */
export async function fetchAllBankTransactionAllocations(
  opts: Omit<UseBankTransactionAllocationsOptions, "enabled"> = {},
): Promise<BankTransactionAllocation[]> {
  const { organizationId, clientId, clientIds } = opts;
  if (clientIds && clientIds.length === 0) return [];
  return fetchAllRows<BankTransactionAllocation>(async (from, to) => {
    let query = supabase.from(TABLE).select("*");
    if (organizationId) query = query.eq("organization_id", organizationId);
    if (clientId) query = query.eq("client_id", clientId);
    if (clientIds) query = query.in("client_id", clientIds);
    // The previous order (created_at ASC), with id as the unique tiebreaker so
    // page windows never overlap or skip rows.
    const { data, error } = await query
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    return { data: data as BankTransactionAllocation[] | null, error };
  });
}

/**
 * List all allocation rows, optionally scoped to an org and/or client.
 * Suitable for building a lookup map (allocationsByTransactionId, etc.)
 * for the Bankafschriften table. Complete beyond 1000 rows.
 */
export function useBankTransactionAllocations(options: UseBankTransactionAllocationsOptions = {}) {
  const { organizationId, clientId, clientIds, enabled = true } = options;
  const { user } = useAuth();
  const clientIdsKey = clientIds ? [...clientIds].sort().join(",") : "";
  return useQuery({
    queryKey: [...QUERY_KEY, organizationId ?? "all", clientId ?? "all", clientIdsKey],
    queryFn: () => fetchAllBankTransactionAllocations({ organizationId, clientId, clientIds }),
    enabled: !!user && enabled,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
//
// Bewust geen: een koppeling ontstaat of verdwijnt alleen via de betaalschrijver
// (link_bank_payment / unlink_bank_payment in @/hooks/useBankPaymentLink), die
// in dezelfde transactie het restant, `betaald` en de matchvelden afleidt (P5,
// D1). De vroegere insert-, upsert- en delete-hooks schreven de koppelingsrij
// los van al het andere en zijn verwijderd; na P5c weigert de database ze ook.
