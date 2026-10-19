import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

type CorrectionInput = {
  transactionId: string;
  expectedPostingGroupId: string | null;
  accountId: string;
  vat: number;
  reason: string;
  requestId: string;
};

/** A single atomic, idempotent server-side bank correction. Never modify ledger rows in the client. */
export function useReclassifyBankTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: CorrectionInput) => {
      const { data, error } = await supabase.rpc("reclassify_bank_transaction", {
        _transaction_id: v.transactionId,
        _expected_posting_group_id: v.expectedPostingGroupId,
        _grootboekrekening_id: v.accountId,
        _btw_percentage: v.vat,
        _request_id: v.requestId,
        _reason: v.reason,
        _description: null,
      });
      if (error) throw new Error("Bankcorrectie geweigerd. Vernieuw de bankregel en controleer de boekingsstatus.");
      return data;
    },
    onSuccess: (_data, v) => {
      qc.invalidateQueries({ queryKey: ["bank-transaction-posting", v.transactionId] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["ledger-postings"] });
    },
  });
}
