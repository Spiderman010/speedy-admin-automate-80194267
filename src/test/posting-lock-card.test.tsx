import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PostingLockEvent } from "@/lib/posting-lock";

/**
 * De boekingsblokkade op het scherm.
 *
 * De hooks zijn NIET gemockt: `usePostingLock.ts` draait echt tegen een
 * gemockte Supabase-client, zodat ook bewezen wordt wat er over de lijn gaat —
 * en wat er NIET over de lijn gaat: geen afsluiten, geen heropenen, geen
 * directe schrijfactie.
 */

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

const rpcCalls: RpcCall[] = [];
const writeCalls: string[] = [];
const toasts: { title?: string; description?: string; variant?: string }[] = [];

function event(overrides: Partial<PostingLockEvent>): PostingLockEvent {
  return {
    id: "lock-1",
    client_id: "client-1",
    organization_id: "org-1",
    previous_locked_through: null,
    new_locked_through: "2025-12-31",
    changed_at: "2026-01-10T08:00:00.000Z",
    changed_by: "user-1",
    reason: "Aangifte ingediend",
    ...overrides,
  };
}

const GEZET = event({ id: "lock-a" });

const state = {
  canSet: true as boolean | null,
  lock: null as string | null,
  events: [] as PostingLockEvent[],
  /** Na een aanroep van de schrijver: wat de verversing teruggeeft. */
  lockNaPoging: undefined as string | null | undefined,
  eventsNaPoging: undefined as PostingLockEvent[] | undefined,
  set: "changed" as "changed" | "unchanged" | "error" | "network",
  setError: { code: "42501", message: "" },
  pogingen: 0,
  /** Houdt de verversing ná een poging vast, om het verzoeningsvenster te kunnen zien. */
  poort: null as Promise<void> | null,
};

const naPoging = <T,>(nu: T, daarna: T | undefined): T =>
  state.pogingen > 0 && daarna !== undefined ? daarna : nu;

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, session: null, loading: false }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (t: { title?: string; description?: string; variant?: string }) => toasts.push(t) }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (state.pogingen > 0 && state.poort) await state.poort;
            return table === "clients"
              ? { data: { id: "client-1", posting_locked_through: naPoging(state.lock, state.lockNaPoging) }, error: null }
              : { data: null, error: null };
          },
          order: () => ({
            order: async () => ({
              data: table === "posting_lock_events" ? naPoging(state.events, state.eventsNaPoging) : [],
              error: null,
            }),
          }),
        }),
      }),
      insert: () => { writeCalls.push(`${table}.insert`); return { error: null }; },
      update: () => { writeCalls.push(`${table}.update`); return { error: null }; },
      upsert: () => { writeCalls.push(`${table}.upsert`); return { error: null }; },
      delete: () => { writeCalls.push(`${table}.delete`); return { error: null }; },
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "has_min_role") return { data: state.canSet, error: null };
      if (fn !== "set_posting_lock") return { data: null, error: null };
      state.pogingen += 1;
      if (state.set === "network") throw new TypeError("Failed to fetch");
      if (state.set === "error") return { data: null, error: state.setError };
      const nieuw = args._locked_through as string | null;
      return {
        data: [
          {
            client_id: "client-1",
            organization_id: "org-1",
            previous_locked_through: state.lock,
            locked_through: state.set === "unchanged" ? state.lock : nieuw,
            changed_at: "2026-02-01T09:00:00.000Z",
            changed_by: "user-1",
            changed: state.set === "changed",
          },
        ],
        error: null,
      };
    },
  },
}));

import { PostingLockCard } from "@/components/overzichten/PostingLockCard";

let queryClient: QueryClient;
let invalidated: unknown[][];

function toon() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  invalidated = [];
  const echt = queryClient.invalidateQueries.bind(queryClient);
  vi.spyOn(queryClient, "invalidateQueries").mockImplementation((filters) => {
    invalidated.push((filters as { queryKey?: unknown[] })?.queryKey ?? []);
    return echt(filters);
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PostingLockCard clientId="client-1" clientName="Klant A" />
    </QueryClientProvider>,
  );
}

/** Een blokkade die door haar geschiedenis wordt gedragen. */
function geblokkeerd(datum = "2025-12-31") {
  state.lock = datum;
  state.events = [event({ id: "lock-a", new_locked_through: datum })];
}

async function openEnVul(knop: string, { datum, reden }: { datum?: string; reden?: string }) {
  fireEvent.click(await screen.findByTestId(knop));
  await screen.findByTestId("blokkade-dialoog");
  if (datum !== undefined) fireEvent.change(screen.getByTestId("blokkade-datum"), { target: { value: datum } });
  if (reden !== undefined) fireEvent.change(screen.getByTestId("blokkade-reden"), { target: { value: reden } });
}

async function bevestig() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("blokkade-bevestigen"));
  });
}

const setCalls = () => rpcCalls.filter((c) => c.fn === "set_posting_lock");
const yearCalls = () => rpcCalls.filter((c) => /fiscal_year/.test(c.fn));
const isRood = (el: HTMLElement) => /bg-destructive/.test(el.className);

beforeEach(() => {
  rpcCalls.length = 0;
  writeCalls.length = 0;
  toasts.length = 0;
  Object.assign(state, {
    canSet: true,
    lock: null,
    events: [],
    lockNaPoging: undefined,
    eventsNaPoging: undefined,
    set: "changed",
    setError: { code: "42501", message: "" },
    pogingen: 0,
    poort: null,
  });
});

describe("De huidige stand", () => {
  it("1. NULL: 'Geen boekingsblokkade', en voor een accountant alleen 'instellen'", async () => {
    toon();
    await waitFor(() => expect(screen.getByTestId("blokkade-stand")).toHaveTextContent("Geen boekingsblokkade"));
    expect(screen.getByTestId("blokkade-status-badge")).toHaveAttribute("data-locked", "false");
    expect(await screen.findByTestId("blokkade-instellen")).toHaveTextContent("Boekingsblokkade instellen");
    expect(screen.queryByTestId("blokkade-wijzigen")).toBeNull();
    expect(screen.queryByTestId("blokkade-opheffen")).toBeNull();
  });

  it("2. een datum: precies uitgelegd, en voor een accountant 'wijzigen' en 'opheffen'", async () => {
    geblokkeerd("2025-12-31");
    toon();
    await waitFor(() =>
      expect(screen.getByTestId("blokkade-stand")).toHaveTextContent("Boekingen geblokkeerd t/m 31-12-2025"),
    );
    const uitleg = screen.getByTestId("blokkade-uitleg");
    expect(uitleg).toHaveTextContent(/op of vóór 31-12-2025 worden geweigerd/);
    expect(uitleg).toHaveTextContent(/ná 31-12-2025 blijven mogelijk/);
    expect(screen.getByTestId("blokkade-los-van-boekjaar")).toHaveTextContent(
      "Deze boekingsblokkade staat los van de boekjaarstatus.",
    );
    expect(await screen.findByTestId("blokkade-wijzigen")).toHaveTextContent("Blokkade wijzigen");
    expect(screen.getByTestId("blokkade-opheffen")).toHaveTextContent("Blokkade opheffen");
    expect(screen.queryByTestId("blokkade-instellen")).toBeNull();
    // Niet gepresenteerd als boekjaarstatus.
    expect(screen.getByTestId("boekingsblokkade-card")).not.toHaveTextContent(/Boekjaarstatus|Afgesloten|Heropend/);
  });

  it("3. wie geen accountant is, ziet stand en geschiedenis maar kan niets wijzigen", async () => {
    state.canSet = false;
    geblokkeerd();
    toon();
    await waitFor(() => expect(screen.getByTestId("blokkade-geen-actie")).toHaveAttribute("data-kind", "not_allowed"));
    expect(screen.getByTestId("blokkade-geen-actie")).toHaveTextContent(/accountant/i);
    for (const knop of ["blokkade-instellen", "blokkade-wijzigen", "blokkade-opheffen"]) {
      expect(screen.queryByTestId(knop), knop).toBeNull();
    }
    expect(screen.getByTestId("blokkade-stand")).toHaveTextContent("t/m 31-12-2025");
    expect(await screen.findAllByTestId("blokkade-gebeurtenis")).toHaveLength(1);
    expect(setCalls()).toHaveLength(0);
  });
});

describe("Instellen", () => {
  it("4. een expliciete bevestiging, precies drie waarden, en alleen de toegestane schrijver", async () => {
    toon();
    await openEnVul("blokkade-instellen", {});
    const knop = screen.getByTestId("blokkade-bevestigen");
    expect(knop).toBeDisabled();
    fireEvent.change(screen.getByTestId("blokkade-datum"), { target: { value: "2025-12-31" } });
    expect(knop).toBeDisabled(); // nog geen reden
    fireEvent.change(screen.getByTestId("blokkade-reden"), { target: { value: "  Aangifte ingediend  " } });
    expect(knop).toBeEnabled();
    expect(screen.getByTestId("blokkade-gevolgen")).toHaveTextContent(
      "Boekingen met een datum op of vóór 31-12-2025 worden geblokkeerd.",
    );
    expect(isRood(knop)).toBe(false);
    expect(setCalls()).toHaveLength(0); // nog niets verstuurd

    await bevestig();
    await waitFor(() => expect(setCalls()).toHaveLength(1));
    expect(setCalls()[0].args).toEqual({
      _client_id: "client-1",
      _locked_through: "2025-12-31",
      _reason: "Aangifte ingediend",
    });
    expect(writeCalls).toEqual([]);
    expect(yearCalls()).toEqual([]);
    expect(rpcCalls.map((c) => c.fn).filter((f) => f !== "has_min_role")).toEqual(["set_posting_lock"]);
  });

  it("5. een reden van alleen witruimte of van meer dan 500 tekens houdt de knop uit", async () => {
    toon();
    await openEnVul("blokkade-instellen", { datum: "2025-12-31", reden: " \n\t " });
    expect(screen.getByTestId("blokkade-bevestigen")).toBeDisabled();
    fireEvent.change(screen.getByTestId("blokkade-reden"), { target: { value: "x".repeat(501) } });
    expect(screen.getByTestId("blokkade-bevestigen")).toBeDisabled();
    expect(screen.getByTestId("blokkade-reden-toets")).toHaveTextContent(/te lang/i);
    fireEvent.click(screen.getByTestId("blokkade-bevestigen"));
    expect(setCalls()).toHaveLength(0);
  });

  it("6. annuleren verstuurt niets", async () => {
    toon();
    await openEnVul("blokkade-instellen", { datum: "2025-12-31", reden: "Aangifte" });
    fireEvent.click(screen.getByTestId("blokkade-annuleren"));
    await waitFor(() => expect(screen.queryByTestId("blokkade-dialoog")).toBeNull());
    expect(setCalls()).toHaveLength(0);
  });
});

describe("Wijzigen", () => {
  it("7. uitbreiden: benoemd als uitbreiding, gewone knop, expliciet bevestigd", async () => {
    geblokkeerd("2025-06-30");
    toon();
    await openEnVul("blokkade-wijzigen", { datum: "2025-12-31", reden: "Q4 ingediend" });
    expect(screen.getByTestId("blokkade-gevolgen")).toHaveTextContent(
      /van 01-07-2025 t\/m 31-12-2025 worden voortaan óók geblokkeerd/,
    );
    expect(screen.queryByTestId("blokkade-versoepeling")).toBeNull();
    const knop = screen.getByTestId("blokkade-bevestigen");
    expect(knop).toHaveTextContent("Blokkade uitbreiden");
    expect(isRood(knop)).toBe(false);
    await bevestig();
    await waitFor(() => expect(setCalls()).toHaveLength(1));
    expect(setCalls()[0].args._locked_through).toBe("2025-12-31");
    expect(yearCalls()).toEqual([]);
  });

  it("8. terugzetten: een zichtbare versoepelingswaarschuwing en een rode knop", async () => {
    geblokkeerd("2025-12-31");
    toon();
    await openEnVul("blokkade-wijzigen", { datum: "2025-06-30", reden: "Correctie Q3" });
    const waarschuwing = screen.getByTestId("blokkade-versoepeling");
    expect(waarschuwing).toHaveAttribute("data-kind", "relax");
    expect(waarschuwing).toHaveTextContent(/versoepelt een financiële bescherming/i);
    expect(screen.getByTestId("blokkade-gevolgen")).toHaveTextContent(
      /van 01-07-2025 t\/m 31-12-2025 worden niet langer door deze blokkade tegengehouden/,
    );
    const knop = screen.getByTestId("blokkade-bevestigen");
    expect(knop).toHaveTextContent("Blokkade versoepelen");
    expect(isRood(knop)).toBe(true);
    await bevestig();
    await waitFor(() => expect(setCalls()).toHaveLength(1));
    expect(yearCalls()).toEqual([]);
  });

  it("9. dezelfde datum kiezen kan niet worden bevestigd", async () => {
    geblokkeerd("2025-12-31");
    toon();
    await openEnVul("blokkade-wijzigen", { reden: "Niets" });
    expect((screen.getByTestId("blokkade-datum") as HTMLInputElement).value).toBe("2025-12-31");
    expect(screen.getByTestId("blokkade-datum-ongewijzigd")).toBeInTheDocument();
    expect(screen.getByTestId("blokkade-bevestigen")).toBeDisabled();
  });
});

describe("Opheffen", () => {
  it("10. rood, met de zin dat er geen boekjaar opengaat, en zonder heropenaanroep", async () => {
    geblokkeerd("2025-12-31");
    toon();
    await openEnVul("blokkade-opheffen", { reden: "Blokkade niet meer nodig" });
    expect(screen.queryByTestId("blokkade-datum")).toBeNull();
    expect(screen.getByTestId("blokkade-versoepeling")).toHaveAttribute("data-kind", "clear");
    const dialoog = screen.getByTestId("blokkade-dialoog");
    expect(dialoog).toHaveTextContent("De blokkade opheffen opent geen afgesloten boekjaar.");
    expect(screen.getByTestId("blokkade-gevolgen")).toHaveTextContent(/afgesloten boekjaar blijft afgesloten/i);
    const knop = screen.getByTestId("blokkade-bevestigen");
    expect(isRood(knop)).toBe(true);
    await bevestig();
    await waitFor(() => expect(setCalls()).toHaveLength(1));
    expect(setCalls()[0].args).toEqual({ _client_id: "client-1", _locked_through: null, _reason: "Blokkade niet meer nodig" });
    expect(yearCalls()).toEqual([]);
    expect(writeCalls).toEqual([]);
  });
});

describe("Na afloop", () => {
  it("11. een geslaagde wijziging ververst stand en geschiedenis — geen verouderde badge", async () => {
    state.lockNaPoging = "2025-12-31";
    state.eventsNaPoging = [GEZET];
    toon();
    await openEnVul("blokkade-instellen", { datum: "2025-12-31", reden: "Aangifte ingediend" });
    await bevestig();
    await waitFor(() => expect(screen.getByTestId("blokkade-status-badge")).toHaveAttribute("data-locked", "true"));
    expect(screen.getByTestId("blokkade-stand")).toHaveTextContent("Boekingen geblokkeerd t/m 31-12-2025");
    expect(await screen.findAllByTestId("blokkade-gebeurtenis")).toHaveLength(1);
    expect(screen.queryByTestId("blokkade-dialoog")).toBeNull();
    const sleutels = invalidated.map((k) => String(k[0]));
    for (const sleutel of ["posting-lock-state", "posting-lock-events", "clients", "bank-bulk-candidates", "ledger-catchup"]) {
      expect(sleutels, sleutel).toContain(sleutel);
    }
    // De boekjaarcaches worden niet aangeraakt: dit is een ander besturingselement.
    expect(sleutels).not.toContain("year-closure");
    expect(sleutels).not.toContain("fiscal-year-events");
    expect(toasts.map((t) => t.title)).toContain("Boekingen geblokkeerd t/m 31-12-2025");
  });

  it("12. changed = false is een mededeling, geen fout, en verdubbelt niets", async () => {
    geblokkeerd("2025-06-30");
    state.set = "unchanged";
    toon();
    await openEnVul("blokkade-wijzigen", { datum: "2025-12-31", reden: "Race met collega" });
    await bevestig();
    expect(await screen.findByTestId("blokkade-mededeling")).toHaveTextContent(/stond al op deze waarde/i);
    expect(screen.queryByTestId("blokkade-fout")).toBeNull();
    expect(screen.getAllByTestId("blokkade-gebeurtenis")).toHaveLength(1);
    expect(toasts.some((t) => t.variant === "destructive")).toBe(false);
  });
});

describe("Als de database weigert", () => {
  it("13. een rolweigering en een validatieweigering komen elk met hun eigen soort door", async () => {
    state.set = "error";
    state.setError = {
      code: "42501",
      message: "Geen rechten om de boekingsblokkade te wijzigen voor deze organisatie (accountant vereist)",
    };
    const { unmount } = toon();
    await openEnVul("blokkade-instellen", { datum: "2025-12-31", reden: "Aangifte" });
    await bevestig();
    let melding = await screen.findByTestId("blokkade-fout");
    expect(melding).toHaveAttribute("data-kind", "permission");
    expect(melding).toHaveTextContent(/accountant/i);
    unmount();

    state.setError = { code: "22023", message: "Blokkadedatum 2100-12-31 valt buiten het ondersteunde bereik 2000-2100" };
    toon();
    await openEnVul("blokkade-instellen", { datum: "2025-12-31", reden: "Aangifte" });
    await bevestig();
    melding = await screen.findByTestId("blokkade-fout");
    expect(melding).toHaveAttribute("data-kind", "validation");
    expect(melding).toHaveTextContent(state.setError.message);
    // Eén poging per klik, nooit automatisch herhaald.
    expect(setCalls()).toHaveLength(2);
  });

  it("14. een netwerkstoring: eerst opnieuw kijken; blijkt niets gewijzigd, dan pas weer een knop", async () => {
    state.set = "network";
    toon();
    await openEnVul("blokkade-instellen", { datum: "2025-12-31", reden: "Aangifte" });
    await bevestig();
    const melding = await screen.findByTestId("blokkade-fout");
    expect(melding).toHaveAttribute("data-kind", "network");
    expect(melding).toHaveTextContent(/niet bekend of de boekingsblokkade is gewijzigd/i);
    expect(setCalls()).toHaveLength(1);
    // Na de verzoening mag de gebruiker bewust opnieuw — maar het is niet vanzelf gebeurd.
    expect(await screen.findByTestId("blokkade-instellen")).toBeEnabled();
    expect(setCalls()).toHaveLength(1);
  });

  it("14a. tijdens de verzoening is er geen enkele knop — een tweede wijziging kan niet", async () => {
    state.set = "network";
    let open!: () => void;
    state.poort = new Promise<void>((r) => { open = r; });
    toon();
    await openEnVul("blokkade-instellen", { datum: "2025-12-31", reden: "Aangifte" });
    await bevestig();
    // De stand wordt nog opgehaald. Tot de afloop bekend is, blijft de
    // bevestiging vergrendeld (en de dialoog kan niet dicht), en de knop op de
    // kaart staat uit. Een extra klik vuurt niets af.
    const bevestigKnop = screen.getByTestId("blokkade-bevestigen");
    expect(bevestigKnop).toBeDisabled();
    expect(bevestigKnop).toHaveTextContent("Bezig met opslaan…");
    fireEvent.click(bevestigKnop);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByTestId("blokkade-dialoog")).toBeInTheDocument();
    expect(screen.queryByTestId("blokkade-fout")).toBeNull();
    // Op de kaart zelf wordt intussen niets aangeboden.
    expect(screen.getByTestId("blokkade-geen-actie")).toHaveAttribute("data-kind", "unknown");
    expect(screen.queryByTestId("blokkade-instellen")).toBeNull();
    expect(setCalls()).toHaveLength(1);
    await act(async () => { open(); });
    expect(await screen.findByTestId("blokkade-instellen")).toBeEnabled();
    expect(screen.getByTestId("blokkade-fout")).toHaveAttribute("data-kind", "network");
    expect(setCalls()).toHaveLength(1);
  });

  it("14b. blijkt de wijziging na de storing wel doorgevoerd, dan is dát de uitkomst", async () => {
    state.set = "network";
    state.lockNaPoging = "2025-12-31";
    state.eventsNaPoging = [GEZET];
    toon();
    await openEnVul("blokkade-instellen", { datum: "2025-12-31", reden: "Aangifte" });
    await bevestig();
    expect(await screen.findByTestId("blokkade-mededeling")).toHaveTextContent(/blijkt wel te zijn doorgevoerd/i);
    expect(screen.queryByTestId("blokkade-fout")).toBeNull();
    expect(screen.getByTestId("blokkade-stand")).toHaveTextContent("t/m 31-12-2025");
    expect(setCalls()).toHaveLength(1);
  });
});

describe("Stand en geschiedenis", () => {
  it("15. spreken zij elkaar tegen, dan een blokkerende melding en geen enkele knop", async () => {
    state.lock = "2025-12-31";
    state.events = [];
    toon();
    const melding = await screen.findByTestId("blokkade-inconsistent");
    expect(melding).toHaveTextContent(/kiest hier geen kant/);
    for (const knop of ["blokkade-instellen", "blokkade-wijzigen", "blokkade-opheffen"]) {
      expect(screen.queryByTestId(knop), knop).toBeNull();
    }
    // De stand wordt wel getoond, zoals hij in de database staat.
    expect(screen.getByTestId("blokkade-stand")).toHaveTextContent("t/m 31-12-2025");
  });

  it("16. de geschiedenis staat chronologisch en deterministisch, ongeacht de leesvolgorde", async () => {
    const t = "2026-01-10T08:00:00.000Z";
    state.lock = null;
    state.events = [
      event({ id: "c", previous_locked_through: "2025-12-31", new_locked_through: null, changed_at: "2026-03-01T10:00:00.000Z", reason: "Opgeheven" }),
      event({ id: "b", previous_locked_through: "2025-06-30", new_locked_through: "2025-12-31", changed_at: t, reason: "Uitgebreid" }),
      event({ id: "a", previous_locked_through: null, new_locked_through: "2025-06-30", changed_at: t, reason: "Eerste" }),
    ];
    toon();
    const lijst = await screen.findByTestId("blokkade-gebeurtenissen");
    const regels = within(lijst).getAllByTestId("blokkade-gebeurtenis");
    expect(regels.map((r) => within(r).getByTestId("blokkade-gebeurtenis-reden").textContent)).toEqual([
      "Eerste",
      "Uitgebreid",
      "Opgeheven",
    ]);
    expect(within(regels[0]).getByTestId("blokkade-gebeurtenis-van")).toHaveTextContent("Geen blokkade");
    expect(within(regels[0]).getByTestId("blokkade-gebeurtenis-naar")).toHaveTextContent("t/m 30-06-2025");
    expect(within(regels[2]).getByTestId("blokkade-gebeurtenis-soort")).toHaveTextContent("Blokkade opheffen");
    expect(screen.queryByTestId("blokkade-inconsistent")).toBeNull();
  });

  it("17. geen verzonnen actor: alleen 'U zelf', nooit een naam of uuid", async () => {
    state.lock = "2025-12-31";
    state.events = [
      event({ id: "a", new_locked_through: "2025-06-30", changed_by: "user-1" }),
      event({
        id: "b",
        previous_locked_through: "2025-06-30",
        new_locked_through: "2025-12-31",
        changed_by: "8c1f0000-0000-4000-8000-000000000002",
        changed_at: "2026-02-01T08:00:00.000Z",
      }),
    ];
    toon();
    const regels = await screen.findAllByTestId("blokkade-gebeurtenis");
    expect(within(regels[0]).getByTestId("blokkade-gebeurtenis-actor")).toHaveTextContent("U zelf");
    expect(within(regels[1]).queryByTestId("blokkade-gebeurtenis-actor")).toBeNull();
    expect(screen.getByTestId("boekingsblokkade-card")).not.toHaveTextContent("8c1f0000");
  });
});
