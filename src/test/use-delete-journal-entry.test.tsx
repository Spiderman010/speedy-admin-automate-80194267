import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { eqMock, deleteMock, fromMock } = vi.hoisted(() => {
  const hoistedEqMock = vi.fn();
  const hoistedDeleteMock = vi.fn(() => ({ eq: hoistedEqMock }));
  const hoistedFromMock = vi.fn(() => ({ delete: hoistedDeleteMock }));

  return {
    eqMock: hoistedEqMock,
    deleteMock: hoistedDeleteMock,
    fromMock: hoistedFromMock,
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: fromMock,
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
  }),
}));

import { useDeleteJournalEntry } from "@/hooks/useJournalEntries";

describe("useDeleteJournalEntry", () => {
  beforeEach(() => {
    eqMock.mockReset();
    deleteMock.mockClear();
    fromMock.mockClear();
    eqMock.mockResolvedValue({ error: null });
  });

  it("verwijdert alleen op id en invalideert journal_entries", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useDeleteJournalEntry(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync("journal-123");
    });

    expect(fromMock).toHaveBeenCalledWith("journal_entries");
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(eqMock).toHaveBeenCalledWith("id", "journal-123");
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["journal_entries"] });
    });
  });
});
