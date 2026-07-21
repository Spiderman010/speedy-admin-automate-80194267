import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Tables } from "@/integrations/supabase/types";

export type PurchaseInvoiceLine = Tables<"purchase_invoice_lines">;
type PurchaseInvoice = Tables<"purchase_invoices">;

export function usePurchaseInvoiceLines(invoiceId?: string | null) {
  return useQuery({
    queryKey: ["purchase_invoice_lines", invoiceId],
    queryFn: async () => {
      if (!invoiceId) return [] as PurchaseInvoiceLine[];
      const { data, error } = await supabase
        .from("purchase_invoice_lines")
        .select("*")
        .eq("purchase_invoice_id", invoiceId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as PurchaseInvoiceLine[];
    },
    enabled: !!invoiceId,
  });
}

export interface InvoiceLineInput {
  omschrijving: string;
  amount_excl: number;
  btw_percentage: number | null;
  grootboekrekening_id: string | null;
}

export type PurchaseInvoiceHeaderSaveInput = Partial<Pick<
  PurchaseInvoice,
  | "client_id"
  | "leverancier_id"
  | "supplier"
  | "invoice_number"
  | "invoice_date"
  | "amount_excl"
  | "btw_amount"
  | "amount_incl"
  | "btw_percentage"
  | "ledger_account_text"
  | "notes"
  | "status"
>>;

export function useReplacePurchaseInvoiceLines() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ invoiceId, lines }: { invoiceId: string; lines: InvoiceLineInput[] }) => {
      if (!user) throw new Error("Not authenticated");
      // Atomic replace via RPC — delete + insert run in a single transaction.
      // If any step fails the existing lines remain untouched.
      const payload = lines.map((l, idx) => ({
        omschrijving: l.omschrijving,
        amount_excl: l.amount_excl,
        btw_percentage: l.btw_percentage,
        grootboekrekening_id: l.grootboekrekening_id,
        sort_order: idx,
      }));
      // Generated types don't yet include this RPC — cast the client locally.
      // See supabase/migrations/*_add-replace-purchase-invoice-lines-rpc.sql
      const client = supabase as unknown as {
        rpc: (
          fn: "replace_purchase_invoice_lines",
          args: { _invoice_id: string; _lines: unknown },
        ) => Promise<{ data: PurchaseInvoiceLine[] | null; error: { message: string } | null }>;
      };
      const { error } = await client.rpc("replace_purchase_invoice_lines", {
        _invoice_id: invoiceId,
        _lines: payload,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["purchase_invoice_lines", vars.invoiceId] });
    },
  });
}

export function useSavePurchaseInvoiceWithLines() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({
      invoiceId,
      headerUpdates,
      lines,
    }: {
      invoiceId: string;
      headerUpdates: PurchaseInvoiceHeaderSaveInput;
      lines: InvoiceLineInput[];
    }) => {
      if (!user) throw new Error("Not authenticated");
      const payload = lines.map((l, idx) => ({
        omschrijving: l.omschrijving,
        amount_excl: l.amount_excl,
        btw_percentage: l.btw_percentage,
        grootboekrekening_id: l.grootboekrekening_id,
        sort_order: idx,
      }));
      const client = supabase as unknown as {
        rpc: (
          fn: "save_purchase_invoice_with_lines",
          args: {
            _invoice_id: string;
            _header_updates: PurchaseInvoiceHeaderSaveInput;
            _lines: unknown;
          },
        ) => Promise<{ data: PurchaseInvoice | null; error: { message: string } | null }>;
      };
      const { data, error } = await client.rpc("save_purchase_invoice_with_lines", {
        _invoice_id: invoiceId,
        _header_updates: headerUpdates,
        _lines: payload,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["purchase_invoice", vars.invoiceId] });
      qc.invalidateQueries({ queryKey: ["purchase_invoices"] });
      qc.invalidateQueries({ queryKey: ["purchase_invoice_lines", vars.invoiceId] });
    },
  });
}
