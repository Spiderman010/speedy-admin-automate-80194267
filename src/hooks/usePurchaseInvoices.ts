import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type PurchaseInvoice = Tables<"purchase_invoices">;
type PurchaseInvoiceInsert = TablesInsert<"purchase_invoices">;

export interface UsePurchaseInvoicesOptions {
  organizationId?: string;
  clientId?: string;
  enabled?: boolean;
}

export const PURCHASE_INVOICES_PAGE_SIZE = 50;

export type PurchaseInvoiceSortField = "supplier" | "invoice_number" | "date" | "amount" | "btw" | "status";

const SORT_COLUMNS: Record<PurchaseInvoiceSortField, string> = {
  supplier: "supplier",
  invoice_number: "invoice_number",
  date: "invoice_date",
  amount: "amount_incl",
  btw: "btw_amount",
  status: "status",
};

// PostgREST or() syntax breaks on commas/parens and ilike treats % and _ as
// wildcards; strip the former and escape the latter so user input stays literal.
export function sanitizeSearchTerm(raw: string): string {
  return raw
    .trim()
    .replace(/[,()"']/g, " ")
    .replace(/[%_]/g, (m) => `\\${m}`)
    .replace(/\s+/g, " ")
    .trim();
}

export interface UsePaginatedPurchaseInvoicesOptions {
  organizationId?: string;
  clientId?: string;
  enabled?: boolean;
  page: number; // 1-based
  pageSize?: number;
  search?: string;
  status?: string; // "all" disables the filter
  documentRoute?: string; // "all" disables the filter
  sortField?: PurchaseInvoiceSortField;
  sortDir?: "asc" | "desc";
}

export interface PaginatedPurchaseInvoices {
  invoices: PurchaseInvoice[];
  total: number;
}

export function usePaginatedPurchaseInvoices(options: UsePaginatedPurchaseInvoicesOptions) {
  const {
    organizationId,
    clientId,
    enabled = true,
    page,
    pageSize = PURCHASE_INVOICES_PAGE_SIZE,
    search = "",
    status = "all",
    documentRoute = "all",
    sortField = "date",
    sortDir = "desc",
  } = options;
  const { user } = useAuth();
  const cleanSearch = sanitizeSearchTerm(search);

  return useQuery<PaginatedPurchaseInvoices>({
    queryKey: [
      "purchase_invoices",
      "page",
      organizationId ?? "all",
      clientId ?? "all",
      page,
      pageSize,
      cleanSearch,
      status,
      documentRoute,
      sortField,
      sortDir,
    ],
    queryFn: async () => {
      let query = supabase
        .from("purchase_invoices")
        .select("*", { count: "exact" });
      if (organizationId) query = query.eq("organization_id", organizationId);
      if (clientId) query = query.eq("client_id", clientId);
      if (status !== "all") query = query.eq("status", status);
      if (documentRoute !== "all") query = query.eq("document_route", documentRoute);
      if (cleanSearch) {
        query = query.or(
          `supplier.ilike.%${cleanSearch}%,invoice_number.ilike.%${cleanSearch}%,ledger_account_text.ilike.%${cleanSearch}%`
        );
      }
      const from = (page - 1) * pageSize;
      const { data, error, count } = await query
        .order(SORT_COLUMNS[sortField], { ascending: sortDir === "asc", nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      return { invoices: (data ?? []) as PurchaseInvoice[], total: count ?? 0 };
    },
    placeholderData: keepPreviousData,
    enabled: !!user && enabled,
  });
}

// Reset pagination whenever any filter/sort dependency changes, but not on mount.
export function useResetPageOnChange(reset: () => void, deps: readonly unknown[]) {
  const firstRun = useRef(true);
  const signature = JSON.stringify(deps);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}

export function usePurchaseInvoices(options: UsePurchaseInvoicesOptions = {}) {
  const { organizationId, clientId, enabled = true } = options;
  const { user } = useAuth();
  return useQuery({
    queryKey: ["purchase_invoices", organizationId ?? "all", clientId ?? "all"],
    queryFn: async () => {
      let query = supabase.from("purchase_invoices").select("*").order("invoice_date", { ascending: false });
      if (organizationId) query = query.eq("organization_id", organizationId);
      if (clientId) query = query.eq("client_id", clientId);
      const { data, error } = await query;
      if (error) throw error;
      return data as PurchaseInvoice[];
    },
    enabled: !!user && enabled,
  });
}

export function useAddPurchaseInvoice() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (invoice: Omit<PurchaseInvoiceInsert, "user_id">) => {
      if (!user) throw new Error("Not authenticated");
      const remainingAmount = invoice.remaining_amount ?? invoice.amount_incl ?? invoice.amount_excl ?? null;
      const { data, error } = await supabase
        .from("purchase_invoices")
        .insert({ ...invoice, user_id: user.id, remaining_amount: remainingAmount })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase_invoices"] }),
  });
}

export function useUpdatePurchaseInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<PurchaseInvoice> & { id: string }) => {
      const { data, error } = await supabase
        .from("purchase_invoices")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase_invoices"] }),
  });
}

export function useDeletePurchaseInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error: linesErr } = await supabase
        .from("purchase_invoice_lines")
        .delete()
        .eq("purchase_invoice_id", invoiceId);
      if (linesErr) throw linesErr;

      const { error } = await supabase.from("purchase_invoices").delete().eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase_invoices"] });
      qc.invalidateQueries({ queryKey: ["purchase_invoice_lines"] });
    },
  });
}
