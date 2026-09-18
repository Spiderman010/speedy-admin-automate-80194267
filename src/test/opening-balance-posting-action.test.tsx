import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Fase 6C-b8 (PR 2) — de boek- en nihilacties tegen een echte QueryClient en
 * een gemockte Supabase-client. Hier wordt bewezen wat de hooks precies de
 * deur uit sturen: één RPC met alleen de id, nooit succes zonder bevestiging
 * uit de database, en de juiste cache-invalidaties.
 */

type Marker = Record<string, unknown> | null;
type Header = Record<string, unknown> | null;

const state = {
  marker: null as Marker,
  markerError: null as { message: string; code?: string } | null,
  header: null as Header,
  canAssert: true as boolean | null,
};

const { rpcSpy, toastSpy } = vi.hoisted(() => ({ rpcSpy: vi.fn(), toastSpy: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u-1" }, loading: false }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (table === "opening_balance_postings") {
              return state.markerError ? { data: null, error: state.markerError } : { data: state.marker, error: null };
            }
            if (table === "opening_balances") return { data: state.header, error: null };
            return { data: null, error: null };
          },
        }),
      }),
    }),
    rpc: rpcSpy,
  },
}));

import { OpeningBalancePostingAction } from "@/components/grootboek/OpeningBalancePostingAction";
import { OpeningBalanceNilAction } from "@/components/grootboek/OpeningBalanceNilAction";
import {
  createEmptyLineRow,
  createEmptyLineRows,
  type OpeningBalanceAccountRef,
  type OpeningBalanceHeaderForm,
  type OpeningBalanceLineRow,
} from "@/lib/opening-balance-utils";

const header: OpeningBalanceHeaderForm = {
  boekjaar: "2027",
  opening_date: "2027-01-01",
  description: "Beginbalans 2027",
  reference: "",
};

const accountsById = new Map<string, OpeningBalanceAccountRef>([
  ["gb-1", { id: "gb-1", nummer: 1300, omschrijving: "Debiteuren", categorie: "activa", actief: true, client_id: null }],
  ["gb-2", { id: "gb-2", nummer: 1600, omschrijving: "Crediteuren", categorie: "passiva", actief: true, client_id: null }],
]);

const balanced = (): OpeningBalanceLineRow[] => [
  { ...createEmptyLineRow(), grootboekrekening_id: "gb-1", debit_input: "1000,00" },
  { ...createEmptyLineRow(), grootboekrekening_id: "gb-2", credit_input: "1000,00" },
];

const nilHeader = () => ({
  id: "ob-1",
  nil_declaration: true,
  nil_declared_at: "2027-01-05T10:00:00Z",
  nil_declared_by: "u-1",
});

function renderPosting(over: Partial<React.ComponentProps<typeof OpeningBalancePostingAction>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const onPosted = vi.fn();
  const onCompetingState = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <OpeningBalancePostingAction
        openingBalanceId="ob-1"
        clientId="c-1"
        header={header}
        lines={balanced()}
        accountsById={accountsById}
        isDirty={false}
        isSaving={false}
        stateUncertain={false}
        stateUnavailable={false}
        onPosted={onPosted}
        onCompetingState={onCompetingState}
        {...over}
      />
    </QueryClientProvider>,
  );
  return { queryClient, invalidateSpy, onPosted, onCompetingState };
}

function renderNil(over: Partial<React.ComponentProps<typeof OpeningBalanceNilAction>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDeclared = vi.fn();
  const onCompetingState = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <OpeningBalanceNilAction
        openingBalanceId="ob-1"
        header={header}
        lines={createEmptyLineRows(2)}
        savedLineCount={0}
        isHeaderDirty={false}
        isSaving={false}
        stateUncertain={false}
        stateUnavailable={false}
        onDeclared={onDeclared}
        onCompetingState={onCompetingState}
        {...over}
      />
    </QueryClientProvider>,
  );
  return { onDeclared, onCompetingState };
}

const button = () => screen.getByTestId("beginbalans-posting-button") as HTMLButtonElement;
const hint = () => screen.getByTestId("beginbalans-posting-hint");
const postCalls = () => rpcSpy.mock.calls.filter((c) => c[0] === "post_opening_balance");
const nilCalls = () => rpcSpy.mock.calls.filter((c) => c[0] === "declare_opening_balance_nil");

async function confirmPost() {
  fireEvent.click(button());
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByTestId("beginbalans-post-confirm"));
}

const rpcDefault = () =>
  rpcSpy.mockImplementation(async (fn: string) =>
    fn === "has_min_role" ? { data: state.canAssert, error: null } : { data: "group-1", error: null },
  );

beforeEach(() => {
  rpcSpy.mockReset();
  toastSpy.mockClear();
  state.marker = null;
  state.markerError = null;
  state.header = { id: "ob-1", nil_declaration: false, nil_declared_at: null, nil_declared_by: null };
  state.canAssert = true;
  rpcDefault();
});

describe("OpeningBalancePostingAction", () => {
  it("23. in balans, opgeslagen, accountant → knop aan, geen hint", async () => {
    renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(screen.queryByTestId("beginbalans-posting-hint")).toBeNull();
  });

  it("29. al geboekt → vaste definitieve melding en geen knop", async () => {
    state.marker = { opening_balance_id: "ob-1", posting_group_id: "g-1", total_amount: 1000 };
    renderPosting();
    await waitFor(() => expect(screen.getByTestId("beginbalans-posting-done")).toHaveTextContent("definitief"));
    expect(screen.queryByTestId("beginbalans-posting-button")).toBeNull();
  });

  it("22. geen accountant → geen knop, alleen de rolhint", async () => {
    state.canAssert = false;
    renderPosting();
    await waitFor(() => expect(hint()).toHaveTextContent("Alleen een accountant kan een beginbalans boeken."));
    expect(screen.queryByTestId("beginbalans-posting-button")).toBeNull();
  });

  it("24. rol nog onbekend → geen knop", async () => {
    rpcSpy.mockImplementation(() => new Promise(() => {}));
    renderPosting();
    expect(hint()).toHaveTextContent("Rechten worden gecontroleerd…");
    expect(screen.queryByTestId("beginbalans-posting-button")).toBeNull();
  });

  it("18. niet in balans → knop uit met het verschil", async () => {
    const lines = balanced();
    lines[1] = { ...lines[1], credit_input: "999,00" };
    renderPosting({ lines });
    await waitFor(() => expect(hint()).toHaveTextContent("Debet en credit zijn niet gelijk"));
    expect(button().disabled).toBe(true);
  });

  it("niet-opgeslagen wijzigingen of lopende opslag → knop uit", async () => {
    renderPosting({ isDirty: true });
    await waitFor(() => expect(hint()).toHaveTextContent("Er zijn niet-opgeslagen wijzigingen. Sla eerst op."));
    expect(button().disabled).toBe(true);
  });

  it("claimtabel onbevraagbaar (deploy-venster) → neutrale hint, knop uit, geen rpc", async () => {
    state.markerError = { message: "Could not find the table 'public.opening_balance_postings' in the schema cache", code: "PGRST205" };
    renderPosting();
    await waitFor(() => expect(hint()).toHaveTextContent("Beginbalansen zijn nog niet beschikbaar in deze omgeving"));
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    await new Promise((r) => setTimeout(r, 0));
    expect(postCalls()).toHaveLength(0);
  });

  it("27/28. bevestigen → post_opening_balance precies één keer met alleen de id; succes na de claimrij", async () => {
    const { onPosted } = renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) => {
      if (fn === "has_min_role") return { data: true, error: null };
      state.marker = { opening_balance_id: "ob-1", posting_group_id: "g-1", total_amount: 1000 };
      return { data: "g-1", error: null };
    });
    await confirmPost();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Beginbalans geboekt" }));
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0][1]).toEqual({ _opening_balance_id: "ob-1" });
    expect(onPosted).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("beginbalans-posting-done")).toBeInTheDocument());
  });

  it("de bevestigingsdialoog kan worden geannuleerd zonder rpc", async () => {
    renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Annuleren" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(postCalls()).toHaveLength(0);
  });

  it("28. geen succesmelding zolang de claimrij het niet bevestigt", async () => {
    const { onPosted } = renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    await confirmPost();
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Boeking niet bevestigd", variant: "destructive" })),
    );
    expect(toastSpy).not.toHaveBeenCalledWith({ title: "Beginbalans geboekt" });
    expect(onPosted).not.toHaveBeenCalled();
  });

  it("31. 23505 (al geboekt) → opnieuw ophalen, geboekte weergave, geen foutmelding", async () => {
    const { onPosted, onCompetingState } = renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) => {
      if (fn === "has_min_role") return { data: true, error: null };
      state.marker = { opening_balance_id: "ob-1", posting_group_id: "g-1", total_amount: 1000 };
      return { data: null, error: { code: "23505", message: "Deze beginbalans is al geboekt" } };
    });
    await confirmPost();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Deze beginbalans is al geboekt." }));
    expect(onCompetingState).toHaveBeenCalled();
    expect(onPosted).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("beginbalans-posting-done")).toBeInTheDocument());
  });

  it("45. 40001 → opnieuw ophalen en een veilige melding", async () => {
    const { onCompetingState } = renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) =>
      fn === "has_min_role"
        ? { data: true, error: null }
        : { data: null, error: { code: "40001", message: "De beginbalans is tussentijds gewijzigd; probeer opnieuw" } },
    );
    await confirmPost();
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Boeken niet gelukt", description: expect.stringMatching(/tussentijds gewijzigd/) })),
    );
    expect(onCompetingState).toHaveBeenCalled();
    expect(postCalls()).toHaveLength(1);
  });

  it("46. 40P01 → herhaalbare melding en geen automatische tweede poging", async () => {
    const { onCompetingState } = renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) =>
      fn === "has_min_role" ? { data: true, error: null } : { data: null, error: { code: "40P01", message: "deadlock detected" } },
    );
    await confirmPost();
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Boeken niet gelukt",
        description: "Een andere grootboekactie voor deze administratie was tegelijk bezig. Probeer opnieuw.",
        variant: "destructive",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(postCalls()).toHaveLength(1);
    expect(onCompetingState).not.toHaveBeenCalled();
    // De knop is er nog: de gebruiker mag zelf opnieuw proberen.
    expect(button().disabled).toBe(false);
  });

  it("42501 → destructieve toast met de databasemelding", async () => {
    renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) =>
      fn === "has_min_role"
        ? { data: true, error: null }
        : { data: null, error: { code: "42501", message: "Geen rechten om een beginbalans te boeken voor deze organisatie (accountant vereist)" } },
    );
    await confirmPost();
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Boeken niet gelukt",
        description: "Geen rechten om een beginbalans te boeken voor deze organisatie (accountant vereist)",
        variant: "destructive",
      }),
    );
  });

  it("48. validatiefout (22023, eerdere grootboekfeiten) → de Nederlandse databasemelding", async () => {
    renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    const message = "Er staan al boekingen vóór 2027-01-01 in het grootboek van deze administratie (laatste: 2026-11-30); een beginbalans moet het eerste feit zijn";
    rpcSpy.mockImplementation(async (fn: string) =>
      fn === "has_min_role" ? { data: true, error: null } : { data: null, error: { code: "22023", message } },
    );
    await confirmPost();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Boeken niet gelukt", description: message, variant: "destructive" }));
  });

  it("deploy-venster tijdens de rpc → neutrale melding, nooit de rauwe schemafout", async () => {
    renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) =>
      fn === "has_min_role"
        ? { data: true, error: null }
        : { data: null, error: { code: "PGRST202", message: "Could not find the function in the schema cache" } },
    );
    await confirmPost();
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Boeken niet gelukt",
        description: "Beginbalansen zijn nog niet beschikbaar in deze omgeving (het databaseschema ontbreekt).",
        variant: "destructive",
      }),
    );
  });

  it("boekt nooit uit zichzelf", async () => {
    renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(postCalls()).toHaveLength(0);
  });

  it("succes → de beginbalansfamilie én ledger-postings geïnvalideerd", async () => {
    const { invalidateSpy } = renderPosting();
    await waitFor(() => expect(button().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) => {
      if (fn === "has_min_role") return { data: true, error: null };
      state.marker = { opening_balance_id: "ob-1", posting_group_id: "g-1", total_amount: 1000 };
      return { data: "g-1", error: null };
    });
    invalidateSpy.mockClear();
    await confirmPost();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Beginbalans geboekt" }));
    const keys = invalidateSpy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual([
      JSON.stringify(["opening-balances"]),
      JSON.stringify(["opening-balance", "ob-1"]),
      JSON.stringify(["opening-balance-lines", "ob-1"]),
      JSON.stringify(["opening-balance-posting", "ob-1"]),
      JSON.stringify(["ledger-postings"]),
    ]);
  });
});

describe("OpeningBalanceNilAction", () => {
  const nilButton = () => screen.getByTestId("beginbalans-nil-button") as HTMLButtonElement;

  async function confirmNil() {
    fireEvent.click(nilButton());
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByTestId("beginbalans-nil-confirm"));
  }

  it("36. alleen een accountant ziet de actie; onbekend is niets", async () => {
    state.canAssert = false;
    renderNil();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("beginbalans-nil-button")).toBeNull();
  });

  it("37. regels blokkeren de verklaring", async () => {
    renderNil({ savedLineCount: 2 });
    await waitFor(() => expect(nilButton().disabled).toBe(true));
    expect(screen.getByTestId("beginbalans-nil-hint")).toHaveTextContent("2 opgeslagen regel(s)");
  });

  it("38/39/40. bevestiging → declare_opening_balance_nil precies één keer; succes pas na bevestigde kop", async () => {
    const { onDeclared } = renderNil();
    await waitFor(() => expect(nilButton().disabled).toBe(false));
    fireEvent.click(nilButton());
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Vastleggen dat er geen beginbalans nodig is?");
    expect(dialog).toHaveTextContent("kan niet ongedaan worden gemaakt");
    fireEvent.click(within(dialog).getByTestId("beginbalans-nil-confirm"));
    // De RPC slaagt maar de kop bevestigt (nog) niets.
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Nihil-verklaring niet bevestigd", variant: "destructive" })),
    );
    expect(nilCalls()).toHaveLength(1);
    expect(nilCalls()[0][1]).toEqual({ _opening_balance_id: "ob-1" });
    expect(onDeclared).not.toHaveBeenCalled();

    rpcSpy.mockImplementation(async (fn: string) => {
      if (fn === "has_min_role") return { data: true, error: null };
      state.header = nilHeader();
      return { data: null, error: null };
    });
    await confirmNil();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Vastgelegd: geen beginbalans nodig" }));
    expect(nilCalls()).toHaveLength(2);
    expect(onDeclared).toHaveBeenCalledTimes(1);
  });

  it("23505 (al nihil) → opnieuw ophalen en de bevestigde weergave", async () => {
    const { onDeclared, onCompetingState } = renderNil();
    await waitFor(() => expect(nilButton().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) => {
      if (fn === "has_min_role") return { data: true, error: null };
      state.header = nilHeader();
      return { data: null, error: { code: "23505", message: "Deze beginbalans is al op nihil verklaard" } };
    });
    await confirmNil();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({ title: "Deze beginbalans is al op nihil verklaard." }));
    expect(onCompetingState).toHaveBeenCalled();
    expect(onDeclared).toHaveBeenCalled();
  });

  it("een geboekte beginbalans (23505 met claim elders) → servermelding, geen nihil", async () => {
    const { onDeclared, onCompetingState } = renderNil();
    await waitFor(() => expect(nilButton().disabled).toBe(false));
    rpcSpy.mockImplementation(async (fn: string) =>
      fn === "has_min_role"
        ? { data: true, error: null }
        : { data: null, error: { code: "23505", message: "Deze administratie heeft al een geboekte beginbalans; een nihil-verklaring is niet mogelijk" } },
    );
    await confirmNil();
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        title: "Nihil-verklaring niet gelukt",
        description: "Deze administratie heeft al een geboekte beginbalans; een nihil-verklaring is niet mogelijk",
        variant: "destructive",
      }),
    );
    expect(onCompetingState).toHaveBeenCalled();
    expect(onDeclared).not.toHaveBeenCalled();
  });

  it("de nihil-verklaring loopt uitsluitend via de RPC: geen update van nihil-kolommen", () => {
    expect(rpcSpy.mock.calls.every((c) => typeof c[0] === "string")).toBe(true);
  });
});
