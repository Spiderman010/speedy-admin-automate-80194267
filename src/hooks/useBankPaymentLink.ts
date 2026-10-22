import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  amountToRpc,
  newPaymentRequestId,
  parseLinkResult,
  parseUnlinkResult,
  toBankPaymentError,
  type BankPaymentInvoiceType,
  type BankPaymentRpcError,
  type LinkBankPaymentResult,
  type UnlinkBankPaymentResult,
} from "@/lib/bank-payment-link";

/**
 * De betaalschrijver (P5, D1): link_bank_payment / unlink_bank_payment.
 *
 * Shim zoals useBankBulkPosting: de RPC's staan nog niet in de gegenereerde
 * types.ts (die wordt alleen uit de database geregenereerd). Ontbreekt de RPC
 * (PGRST202 en verwanten), dan gooit de aanroep een BankPaymentError met een
 * duidelijke melding — en er is dan niets geschreven: de app doet geen enkele
 * eigen schrijfactie naast deze ene aanroep.
 */
interface BankPaymentApi {
  rpc(
    fn: "link_bank_payment" | "unlink_bank_payment",
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: BankPaymentRpcError | null }>;
}

const paymentApi = () => supabase as unknown as BankPaymentApi;

export interface LinkBankPaymentInput {
  bankTransactionId: string;
  invoiceType: BankPaymentInvoiceType;
  invoiceId: string;
  /** Het koppelingsbedrag in euro, hooguit twee decimalen. */
  amount: number;
  /** Alleen meegeven bij een bewuste herhaling van dezelfde handeling. */
  requestId?: string;
}

export interface UnlinkBankPaymentInput {
  bankTransactionId: string;
  /** Precies deze koppeling; zonder: alle koppelingen van de banktransactie. */
  allocationId?: string;
  requestId?: string;
}

export async function linkBankPayment(input: LinkBankPaymentInput): Promise<LinkBankPaymentResult> {
  const args = {
    _bank_transaction_id: input.bankTransactionId,
    _invoice_type: input.invoiceType,
    _invoice_id: input.invoiceId,
    _amount: amountToRpc(input.amount),
    _request_id: input.requestId ?? newPaymentRequestId(),
  };
  const { data, error } = await paymentApi().rpc("link_bank_payment", args);
  if (error) throw toBankPaymentError(error);
  return parseLinkResult(data);
}

export async function unlinkBankPayment(input: UnlinkBankPaymentInput): Promise<UnlinkBankPaymentResult> {
  const args = {
    _bank_transaction_id: input.bankTransactionId,
    _request_id: input.requestId ?? newPaymentRequestId(),
    _allocation_id: input.allocationId ?? null,
  };
  const { data, error } = await paymentApi().rpc("unlink_bank_payment", args);
  if (error) throw toBankPaymentError(error);
  return parseUnlinkResult(data);
}

/** Alles wat een koppeling of ontkoppeling kan veranderen. */
export const BANK_PAYMENT_QUERY_KEYS = [
  ["bank_transactions"],
  ["bank_transaction_allocations"],
  ["purchase_invoices"],
  ["sales_invoices"],
] as const;

/**
 * Koppelen en ontkoppelen vanuit een scherm. `link` en `unlink` verversen zelf
 * niets, zodat een reeks aanroepen (bulk, automatisch voorstellen) één keer
 * ververst: roep `refresh` aan na de handeling, ook na een fout.
 */
export function useBankPaymentLink() {
  const queryClient = useQueryClient();
  const refresh = useCallback(async () => {
    await Promise.all(BANK_PAYMENT_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }, [queryClient]);
  return { link: linkBankPayment, unlink: unlinkBankPayment, refresh };
}
