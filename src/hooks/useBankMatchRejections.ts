import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { BankMatchRejectionLike } from "@/lib/bank-match-rejections";

const QUERY_KEY = ["bank-match-rejections"] as const;
const PAGE_SIZE = 1000;

export interface BankRejectionScope {
  organizationId?: string;
  /** Mandatory explicit administration selection; never query all tenants by default. */
  clientIds?: readonly string[];
  enabled?: boolean;
}

/**
 * Read complete rejection history for the explicitly selected administrations.
 * A query error is propagated; consumers MUST fail closed rather than
 * treating an error or loading state as an empty rejection list.
 */
export function useBankMatchRejections({
  organizationId,
  clientIds,
  enabled = true,
}: BankRejectionScope) {
  const { user } = useAuth();
  const sortedClientIds = [...(clientIds ?? [])].sort();
  const clientKey = sortedClientIds.join(",");
  return useQuery({
    queryKey: [...QUERY_KEY, organizationId ?? "none", clientKey],
    enabled: enabled && !!user && !!organizationId && sortedClientIds.length > 0,
    queryFn: async (): Promise<BankMatchRejectionLike[]> => {
      if (!organizationId || sortedClientIds.length === 0) return [];
      const result: BankMatchRejectionLike[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await supabase
          .from("bank_match_rejections")
          .select("bank_transaction_id,invoice_type,invoice_id")
          .eq("organization_id", organizationId)
          .in("client_id", sortedClientIds)
          .order("id", { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1);
        if (error) throw error;
        for (const row of data ?? []) {
          if (row.invoice_type !== "inkoop" && row.invoice_type !== "verkoop") {
            throw new Error("Ongeldige factuursoort in bankmatch-afwijzingen");
          }
          result.push({
            bank_transaction_id: row.bank_transaction_id,
            invoice_type: row.invoice_type,
            invoice_id: row.invoice_id,
          });
        }
        if ((data?.length ?? 0) < PAGE_SIZE) return result;
      }
    },
  });
}

export interface RecordBankMatchRejection {
  organizationId: string;
  clientId: string;
  bankTransactionId: string;
  invoiceType: "inkoop" | "verkoop";
  invoiceId: string;
}

/**
 * Only records rejection feedback; does not alter a transaction or book funds.
 * The database validates that the invoice and transaction belong to the same tenant.
 */
export function useRecordBankMatchRejection() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordBankMatchRejection) => {
      if (!user) throw new Error("Niet ingelogd");
      const { error } = await supabase.from("bank_match_rejections").upsert(
        {
          organization_id: input.organizationId,
          client_id: input.clientId,
          bank_transaction_id: input.bankTransactionId,
          invoice_type: input.invoiceType,
          invoice_id: input.invoiceId,
          rejected_by: user.id,
        },
        { onConflict: "bank_transaction_id,invoice_type,invoice_id", ignoreDuplicates: true },
      );
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}
