import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { BankLedgerFacts } from "@/lib/bank-ledger-status";

/**
 * Leest de boekingsmarkers voor precies deze banktransacties (één pagina),
 * plus de tegenboekingen van die boekingsgroepen.
 *
 * Bewust een eigen, smalle query op de zichtbare id's in plaats van de
 * paginabrede allocatielijst: die kan op het PostgREST-maximum worden
 * afgekapt. Elke fout laat de query falen, en dan is de status "onbekend".
 *
 * De sleutel valt onder ["bank_transactions"], zodat elke boeking (direct,
 * via factuur of in bulk) deze status meteen ververst.
 */
export function useBankLedgerStatus(transactionIds: readonly string[], enabled = true) {
  const { user } = useAuth();
  const ids = [...new Set(transactionIds)].sort();
  return useQuery<BankLedgerFacts>({
    queryKey: ["bank_transactions", "ledger-status", ids],
    enabled: !!user && enabled && ids.length > 0,
    queryFn: () => fetchBankLedgerFacts(ids),
  });
}

export async function fetchBankLedgerFacts(ids: readonly string[]): Promise<BankLedgerFacts> {
  const [direct, allocations] = await Promise.all([
    supabase.from("bank_transaction_postings").select("bank_transaction_id, posting_group_id").in("bank_transaction_id", [...ids]),
    supabase
      .from("bank_allocation_postings")
      .select("bank_transaction_id, posting_group_id, amount")
      .in("bank_transaction_id", [...ids]),
  ]);
  if (direct.error) throw direct.error;
  if (allocations.error) throw allocations.error;

  const directPostingGroup = new Map<string, string>();
  for (const p of direct.data ?? []) directPostingGroup.set(p.bank_transaction_id, p.posting_group_id);

  const allocationPostings = new Map<string, { postingGroupId: string; amount: number }[]>();
  for (const p of allocations.data ?? []) {
    const entry = { postingGroupId: p.posting_group_id, amount: Number(p.amount) };
    const list = allocationPostings.get(p.bank_transaction_id);
    if (list) list.push(entry);
    else allocationPostings.set(p.bank_transaction_id, [entry]);
  }

  const groupIds = [
    ...new Set([
      ...(direct.data ?? []).map((p) => p.posting_group_id),
      ...(allocations.data ?? []).map((p) => p.posting_group_id),
    ]),
  ];
  let reversedGroups = new Set<string>();
  if (groupIds.length > 0) {
    const reversals = await supabase
      .from("ledger_reversal_postings")
      .select("original_posting_group_id")
      .in("original_posting_group_id", groupIds);
    if (reversals.error) throw reversals.error;
    reversedGroups = new Set((reversals.data ?? []).map((r) => r.original_posting_group_id));
  }

  return { directPostingGroup, allocationPostings, reversedGroups };
}
