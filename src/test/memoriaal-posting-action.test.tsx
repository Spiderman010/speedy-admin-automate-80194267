import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Fase 6C-b6 (PR 2) — "Boeken in grootboek" voor een memoriaalboeking.
 *
 * De component stuurt uitsluitend de id naar public.post_manual_journal();
 * alle hints zijn UX en de RPC keurt alles server-side opnieuw. Er wordt nooit
 * succes gemeld zolang de claimtabel dat niet bevestigt.
 */

type Marker = { manual_journal_id: string; posting_group_id: string; total_amount: number } | null;

const state = {
  marker: null as Marker,
  markerError: null as { message: string; code?: string } | null,
  canPost: true as boolean | null,
};

const { rpcSpy, toastSpy } = vi.hoisted(() => ({
  rpcSpy: vi.fn(),
  toastSpy: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u-1" }, loading: false }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            state.markerError
              ? { data: null, error: state.markerError }
              : { data: state.marker, error: null },
        }),
      }),
    }),
    rpc: rpcSpy,
  },
}));

import { MemoriaalPostingAction } from "@/components/memoriaal/MemoriaalPostingAction";
import {
  createEmptyLineRow,
  type ManualJournalHeaderForm,
  type ManualJournalLineRow,
} from "@/lib/manual-journal-utils";

const header: ManualJournalHeaderForm = {
  client_id: "c-1",
  posting_date: "2027-03-31",
  description: "Afschrijving maart",
  reference: "MEM-1",
};

const balanced = (): ManualJournalLineRow[] => [
  { ...createEmptyLineRow(), grootboekrekening_id: "gb-1", debit_input: "100,00" },
  { ...createEmptyLineRow(), grootboekrekening_id: "gb-2", credit_input: "100,00" },
];

function renderAction(over: Partial<React.ComponentProps<typeof MemoriaalPostingAction>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const onPosted = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoriaalPostingAction
        journalId="mj-1"
        header={header}
        lines={balanced()}
        isDirty={false}
        onPosted={onPosted}
        {...over}
      />
    </QueryClientProvider>,
  );
  return { queryClient, invalidateSpy, onPosted };
}

const button = () => screen.getByTestId("memoriaal-posting-button") as HTMLButtonElement;
const hint = () => screen.getByTestId("memoriaal-posting-hint");

const rpcDefault = () =>
  rpcSpy.mockImplementation(async (fn: string) =>
    fn === "has_min_role"
      ? { data: state.canPost, error: null }
      : { data: "group-1", error: null },
  );

beforeEach(() => {
  rpcSpy.mockReset();
  toastSpy.mockClear();
  state.marker = null;
  state.markerError = null;
  state.canPost = true;
  rpcDefault();
});

describe("MemoriaalPostingAction", () => {
  it("1. in balans, opgeslagen, accountant → knop aan, geen hint", async () => {
    renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(screen.queryByTestId("memoriaal-posting-hint")).toBeNull();
  });

  it("2. al geboekt → vaste melding en geen knop", async () => {
    state.marker = { manual_journal_id: "mj-1", posting_group_id: "g-1", total_amount: 100 };
    renderAction();
    await waitFor(() =>
      expect(screen.getByTestId("memoriaal-posting-done")).toHaveTextContent(
        "Deze memoriaalboeking is geboekt. Een correctie vereist een tegenboeking.",
      ),
    );
    expect(screen.queryByTestId("memoriaal-posting-button")).toBeNull();
  });

  it("3. niet-opgeslagen wijzigingen → knop uit met hint", async () => {
    renderAction({ isDirty: true });
    await waitFor(() =>
      expect(hint()).toHaveTextContent("Er zijn niet-opgeslagen wijzigingen. Sla eerst op."),
    );
    expect(button().disabled).toBe(true);
  });

  it("4. nog niet opgeslagen concept → knop uit", async () => {
    renderAction({ journalId: null, isDirty: true });
    await waitFor(() => expect(hint()).toHaveTextContent("Sla de memoriaalboeking eerst op."));
    expect(button().disabled).toBe(true);
  });

  it("5. geen accountant → knop uit met rolhint", async () => {
    state.canPost = false;
    renderAction();
    await waitFor(() =>
      expect(hint()).toHaveTextContent("Alleen een accountant kan een memoriaalboeking boeken."),
    );
    expect(button().disabled).toBe(true);
  });

  it("6. niet in balans → knop uit", async () => {
    const lines = balanced();
    lines[1] = { ...lines[1], credit_input: "99,00" };
    renderAction({ lines });
    await waitFor(() => expect(hint()).toHaveTextContent("Debet en credit zijn niet gelijk."));
    expect(button().disabled).toBe(true);
  });

  it("7. claimtabel onbevraagbaar (deploy-venster) → neutrale hint, knop uit, geen rpc", async () => {
    state.markerError = {
      message: "Could not find the table 'public.manual_journal_postings' in the schema cache",
      code: "PGRST205",
    };
    renderAction();
    await waitFor(() =>
      expect(hint()).toHaveTextContent(
        "Boeken in het grootboek is nog niet beschikbaar voor memoriaalboekingen.",
      ),
    );
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    await new Promise((r) => setTimeout(r, 0));
    expect(rpcSpy.mock.calls.filter((c) => c[0] === "post_manual_journal")).toHaveLength(0);
  });

  it("8. klik → post_manual_journal precies één keer met alleen de id", async () => {
    renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    // Na de RPC bevestigt de claimtabel de boeking.
    rpcSpy.mockImplementation(async (fn: string) => {
      if (fn === "has_min_role") return { data: true, error: null };
      state.marker = { manual_journal_id: "mj-1", posting_group_id: "g-1", total_amount: 100 };
      return { data: "g-1", error: null };
    });
    fireEvent.click(button());
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ title: "Memoriaalboeking geboekt" }),
    );
    const postCalls = rpcSpy.mock.calls.filter((c) => c[0] === "post_manual_journal");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0][1]).toEqual({ _journal_id: "mj-1" });
  });

  it("9. geen succesmelding zolang de claimtabel het niet bevestigt", async () => {
    renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    // RPC slaagt, maar de marker blijft onzichtbaar.
    fireEvent.click(button());
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Boeking niet bevestigd",
        description: "Ververs de pagina en controleer de status.",
        variant: "destructive",
      }),
    );
    expect(toastSpy).not.toHaveBeenCalledWith({ title: "Memoriaalboeking geboekt" });
  });

  it("10. 23505 duplicaat → opnieuw ophalen en naar de geboekte weergave, geen foutmelding", async () => {
    const { onPosted } = renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) => {
      if (fn === "has_min_role") return { data: true, error: null };
      state.marker = { manual_journal_id: "mj-1", posting_group_id: "g-1", total_amount: 100 };
      return { data: null, error: { code: "23505", message: "Deze memoriaalboeking is al geboekt" } };
    });
    fireEvent.click(button());
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ title: "Deze memoriaalboeking is al geboekt." }),
    );
    expect(onPosted).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("memoriaal-posting-done")).toBeInTheDocument());
  });

  it("11. 42501 rechten/onwijzigbaar → destructieve toast met de databasemelding", async () => {
    renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) =>
      fn === "has_min_role"
        ? { data: true, error: null }
        : {
            data: null,
            error: {
              code: "42501",
              message: "Geen rechten om memoriaalboekingen te boeken voor deze organisatie (accountant vereist)",
            },
          },
    );
    fireEvent.click(button());
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Boeken niet gelukt",
        description:
          "Geen rechten om memoriaalboekingen te boeken voor deze organisatie (accountant vereist)",
        variant: "destructive",
      }),
    );
  });

  it("12. validatiefout (23514) → de Nederlandse databasemelding wordt getoond", async () => {
    renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) =>
      fn === "has_min_role"
        ? { data: true, error: null }
        : {
            data: null,
            error: {
              code: "23514",
              message: "Memoriaalboeking is niet in balans: debet 100.00 is ongelijk aan credit 99.00",
            },
          },
    );
    fireEvent.click(button());
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Boeken niet gelukt",
        description: "Memoriaalboeking is niet in balans: debet 100.00 is ongelijk aan credit 99.00",
        variant: "destructive",
      }),
    );
  });

  it("13. deploy-venster tijdens de rpc → neutrale melding, nooit de rauwe schemafout", async () => {
    renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) =>
      fn === "has_min_role"
        ? { data: true, error: null }
        : {
            data: null,
            error: { code: "PGRST202", message: "Could not find the function in the schema cache" },
          },
    );
    fireEvent.click(button());
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Boeken niet gelukt",
        description: "Boeken in het grootboek is nog niet beschikbaar voor memoriaalboekingen.",
        variant: "destructive",
      }),
    );
  });

  it("14. boekt nooit uit zichzelf", async () => {
    renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(rpcSpy.mock.calls.filter((c) => c[0] === "post_manual_journal")).toHaveLength(0);
  });

  it("15. succes → precies de vier query keys geïnvalideerd", async () => {
    const { invalidateSpy } = renderAction();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) => {
      if (fn === "has_min_role") return { data: true, error: null };
      state.marker = { manual_journal_id: "mj-1", posting_group_id: "g-1", total_amount: 100 };
      return { data: "g-1", error: null };
    });
    invalidateSpy.mockClear();
    fireEvent.click(button());
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({ title: "Memoriaalboeking geboekt" }),
    );
    const keys = invalidateSpy.mock.calls.map((c) =>
      JSON.stringify((c[0] as { queryKey: unknown }).queryKey),
    );
    expect(keys).toEqual([
      JSON.stringify(["manual-journal-posting", "mj-1"]),
      JSON.stringify(["manual_journal", "mj-1"]),
      JSON.stringify(["manual_journals"]),
      JSON.stringify(["ledger-postings"]),
    ]);
  });
});
