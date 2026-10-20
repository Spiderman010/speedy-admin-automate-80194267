import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
import { usePostPurchaseInvoice } from "@/hooks/usePurchaseInvoicePosting";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => rpc.mockReset());

describe("purchase posting errors", () => {
  it.each([
    "permission denied for relation ledger_postings",
    "Could not find the function public.post_purchase_invoice in the schema cache",
    "column internal_column does not exist",
    "PostgREST error with https://example.invalid/internal",
    "stack depth limit exceeded",
  ])("does not disclose technical database errors: %s", async (message) => {
    rpc.mockResolvedValue({ data: null, error: { message } });
    const { result } = renderHook(() => usePostPurchaseInvoice(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync("invoice-1")).rejects.toThrow(
        "Boeken is niet gelukt. Probeer het opnieuw.",
      );
    });
  });

  it("preserves deliberate Dutch business validation messages", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "De factuur is nog niet goedgekeurd." } });
    const { result } = renderHook(() => usePostPurchaseInvoice(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync("invoice-1")).rejects.toThrow(
        "De factuur is nog niet goedgekeurd.",
      );
    });
  });
});
