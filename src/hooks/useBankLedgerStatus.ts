import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { BankLedgerFacts } from "@/lib/bank-ledger-status";

/**
 * Leest de boekingsmarkers voor precies deze banktransacties (één pagina).
 *
 * Bewust een eigen, smalle query op de zichtbare id's in plaats van de
 * paginabrede allocatielijst: die lijst kan op het PostgREST-maximum worden
 * afgekapt, en een ontbrekende koppeling zou een regel dan ten onrechte als
 * "niet geboekt" of juist "geboekt" laten zien.
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
    queryFn: async () => {
      const [direct, allocations] = await Promise.all([
        supabase.from("bank_transaction_postings").select("bank_transaction_id").in("bank_transaction_id", ids),
        supabase.from("bank_transaction_allocations").select("id, bank_transaction_id").in("bank_transaction_id", ids),
      ]);
      if (direct.error) throw direct.error;
      if (allocations.error) throw allocations.error;

      const allocationsByTransaction = new Map<string, string[]>();
      for (const a of allocations.data ?? []) {
        const list = allocationsByTransaction.get(a.bank_transaction_id);
        if (list) list.push(a.id);
        else allocationsByTransaction.set(a.bank_transaction_id, [a.id]);
      }

      const allocationIds = (allocations.data ?? []).map((a) => a.id);
      let postedAllocations = new Set<string>();
      if (allocationIds.length > 0) {
        const posted = await supabase
          .from("bank_allocation_postings")
          .select("allocation_id")
          .in("allocation_id", allocationIds);
        if (posted.error) throw posted.error;
        postedAllocations = new Set((posted.data ?? []).map((p) => p.allocation_id));
      }

      return {
        directlyPosted: new Set((direct.data ?? []).map((p) => p.bank_transaction_id)),
        allocationsByTransaction,
        postedAllocations,
      };
    },
  });
}
