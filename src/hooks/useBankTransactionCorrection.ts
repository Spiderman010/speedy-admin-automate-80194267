import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

type BankCorrectionRpc = (name: "reclassify_bank_transaction", args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;

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
      const callCorrection = supabase.rpc.bind(supabase) as unknown as BankCorrectionRpc;
      const { data, error } = await callCorrection("reclassify_bank_transaction", {
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

/** PostgREST/PostgreSQL: the function (or its schema) is not there. */
const RPC_MISSING_CODES = new Set(["PGRST202", "PGRST203", "42883"]);

/**
 * Is `reclassify_bank_transaction` deployed in the database this app talks to?
 *
 * The probe calls it with every argument NULL. Both deployed versions
 * (20261018120000 and 20261018150000) reject that at step 0 with 22004, before
 * reading or writing any data, so the probe has no side effects. A missing
 * function gives PGRST202. Anything else is unknown: the caller fails closed.
 */
export async function bankCorrectionAvailable(): Promise<boolean> {
  const call = supabase.rpc.bind(supabase) as unknown as BankCorrectionRpc;
  const { error } = await call("reclassify_bank_transaction", {
    _transaction_id: null,
    _expected_posting_group_id: null,
    _grootboekrekening_id: null,
    _btw_percentage: null,
    _request_id: null,
    _reason: null,
    _description: null,
  });
  if (error?.code === "22004") return true;
  if (error?.code && RPC_MISSING_CODES.has(error.code)) return false;
  throw new Error("Kon niet bepalen of bankcorrecties beschikbaar zijn.");
}

/** `true` only once the probe proved the RPC exists; loading, missing and unknown all hide the action. */
export function useBankCorrectionAvailable(enabled: boolean) {
  return useQuery({
    queryKey: ["bank-correction-available"],
    queryFn: bankCorrectionAvailable,
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}
