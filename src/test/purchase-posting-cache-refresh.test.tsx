import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const { rpc, invalidate } = vi.hoisted(() => ({
  rpc: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc },
}));
import { usePostPurchaseInvoice } from "@/hooks/usePurchaseInvoicePosting";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.invalidateQueries = invalidate;
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => { rpc.mockReset(); invalidate.mockReset(); invalidate.mockResolvedValue(undefined); });

describe("purchase invoice posting cache", () => {
  it("refreshes invoice detail, list, marker and ledger only after confirmed server posting", async () => {
    rpc.mockResolvedValue({ data: "group-1", error: null });
    const { result } = renderHook(() => usePostPurchaseInvoice(), { wrapper });
    await act(async () => { await result.current.mutateAsync("inv-1"); });
    expect(rpc).toHaveBeenCalledWith("post_purchase_invoice", { _invoice_id: "inv-1" });
    for (const key of [
      ["purchase-invoice-posting", "inv-1"],
      ["purchase_invoice", "inv-1"],
      ["purchase_invoices"],
      ["ledger-postings"],
    ]) expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
  });

  it("does not mark or refresh anything after rejected posting", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Boeking geweigerd" } });
    const { result } = renderHook(() => usePostPurchaseInvoice(), { wrapper });
    await act(async () => { await expect(result.current.mutateAsync("inv-1")).rejects.toThrow("Boeking geweigerd"); });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
