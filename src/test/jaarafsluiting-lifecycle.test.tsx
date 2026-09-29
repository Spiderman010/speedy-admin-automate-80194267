import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DiagnosticRun } from "@/lib/diagnostic-report";
import { available } from "@/lib/diagnostic-report";
import type { FiscalYearEvent } from "@/lib/year-close-lifecycle";

// Radix Select gebruikt deze browser-API; jsdom implementeert haar niet.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

/**
 * Jaarafsluiting PR F — de levenscyclus op het scherm.
 *
 * Wat hier bewaakt wordt: de status komt uit `year_closures.status`, de
 * historie uit `fiscal_year_events`; alleen een accountant krijgt de knoppen;
 * heropenen vereist een reden van 1–500 tekens en gaat als precies drie
 * waarden de deur uit; een serverweigering komt letterlijk op het scherm;
 * een idempotente uitkomst is een mededeling en verdubbelt niets; en de
 * boekingsblokkade wordt nooit aangeraakt.
 *
 * De hooks zijn NIET gemockt: `useYearClose.ts` draait echt tegen een
 * gemockte Supabase-client, zodat ook bewezen wordt wat er over de lijn gaat.
 */

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

const rpcCalls: RpcCall[] = [];
const writeCalls: string[] = [];
const toasts: { title?: string; description?: string; variant?: string }[] = [];

const JAAR = new Date().getFullYear() - 1;

const CLOSED = {
  client_id: "client-1",
  organization_id: "org-1",
  fiscal_year: JAAR,
  closed_at: "2027-01-15T10:30:00.000Z",
  closed_by: "user-1",
  status: "closed" as const,
};
const REOPENED = { ...CLOSED, status: "reopened" as const };

function event(overrides: Partial<FiscalYearEvent>): FiscalYearEvent {
  return {
    id: "evt-1",
    client_id: "client-1",
    organization_id: "org-1",
    fiscal_year: JAAR,
    event_type: "closed",
    occurred_at: "2027-01-15T10:30:00.000Z",
    actor_id: "user-1",
    reason: null,
    ...overrides,
  };
}

const EVT_CLOSED = event({ id: "evt-a", event_type: "closed", occurred_at: "2027-01-15T10:30:00.000Z" });
const EVT_REOPENED = event({
  id: "evt-b",
  event_type: "reopened",
  occurred_at: "2027-02-01T09:00:00.000Z",
  reason: "Nagekomen inkoopfactuur",
  actor_id: "user-2",
});
const EVT_RECLOSED = event({ id: "evt-c", event_type: "closed", occurred_at: "2027-02-03T16:45:00.000Z" });

const REOPEN_RESULT = {
  client_id: "client-1",
  organization_id: "org-1",
  fiscal_year: JAAR,
  status: "reopened",
  event_id: "evt-b",
  occurred_at: EVT_REOPENED.occurred_at,
  actor_id: "user-1",
  reason: "Nagekomen inkoopfactuur",
  afgesloten_boekjaar: null,
  reopened: true,
};

const state = {
  watermark: null as number | null,
  canClose: true as boolean | null,
  closure: null as typeof CLOSED | typeof REOPENED | null,
  events: [] as FiscalYearEvent[],
  /** De leesquery op fiscal_year_events faalt. */
  eventsError: false,
  /** De boekingsblokkade: een eigen stand en een eigen geschiedenis. */
  lock: null as string | null,
  lockEvents: [] as unknown[],
  /** Na een mutatie: wat de verversing daarna teruggeeft. */
  closureNaPoging: undefined as typeof CLOSED | typeof REOPENED | null | undefined,
  eventsNaPoging: undefined as FiscalYearEvent[] | undefined,
  watermarkNaPoging: undefined as number | null | undefined,
  reopen: "reopened" as "reopened" | "existing" | "error" | "network",
  reopenError: { code: "23514", message: "" },
  close: "created" as "created" | "existing" | "error",
  closeError: { code: "23514", message: "" },
  pogingen: 0,
};

const naPoging = <T,>(nu: T, daarna: T | undefined): T =>
  state.pogingen > 0 && daarna !== undefined ? daarna : nu;

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "client-1", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({
    data: [{ id: "client-1", name: "Klant A", afgesloten_boekjaar: naPoging(state.watermark, state.watermarkNaPoging) }],
  }),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, session: null, loading: false }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (t: { title?: string; description?: string; variant?: string }) => toasts.push(t) }),
}));

/** Een schone gereedheid, zodat (opnieuw) afsluiten kan worden aangeboden. */
function diagnostics(): DiagnosticRun {
  return {
    ok: true,
    checks: [{ id: "period_balance", title: "Controle", severity: "ok", summary: "samenvatting" }],
    summary: { executed: 1, passed: 1, warnings: 0, blocking: 0 },
  };
}

vi.mock("@/hooks/useYearCloseSources", () => ({
  useYearCloseSources: () => ({
    isPending: false,
    input: {
      diagnostics: diagnostics(),
      closedThrough: available(naPoging(state.watermark, state.watermarkNaPoging)),
      activityByYear: available(new Map([[JAAR, 4]])),
      unpostedWork: available([]),
    },
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          // De boekingsblokkade (eigen kaart, eigen hook): één filter op de
          // administratie, dan de stand of de geschiedenis.
          maybeSingle: async () =>
            table === "clients"
              ? { data: { id: "client-1", posting_locked_through: state.lock }, error: null }
              : { data: null, error: null },
          order: () => ({
            order: async () => ({ data: table === "posting_lock_events" ? state.lockEvents : [], error: null }),
          }),
          eq: () => ({
            maybeSingle: async () => {
              if (table !== "year_closures") return { data: null, error: null };
              return { data: naPoging(state.closure, state.closureNaPoging), error: null };
            },
            order: () => ({
              order: async () => {
                if (table !== "fiscal_year_events") return { data: [], error: null };
                if (state.eventsError) return { data: null, error: { code: "42501", message: "permission denied" } };
                return { data: naPoging(state.events, state.eventsNaPoging), error: null };
              },
            }),
          }),
        }),
      }),
      // Elke schrijfweg wordt geregistreerd: hij hoort nooit te worden gebruikt.
      insert: () => { writeCalls.push(`${table}.insert`); return { error: null }; },
      update: () => { writeCalls.push(`${table}.update`); return { error: null }; },
      upsert: () => { writeCalls.push(`${table}.upsert`); return { error: null }; },
      delete: () => { writeCalls.push(`${table}.delete`); return { error: null }; },
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "has_min_role") return { data: state.canClose, error: null };
      if (fn === "reopen_fiscal_year") {
        state.pogingen += 1;
        if (state.reopen === "network") throw new TypeError("Failed to fetch");
        if (state.reopen === "error") return { data: null, error: state.reopenError };
        return { data: [{ ...REOPEN_RESULT, reopened: state.reopen === "reopened" }], error: null };
      }
      if (fn === "close_fiscal_year") {
        state.pogingen += 1;
        if (state.close === "error") return { data: null, error: state.closeError };
        return { data: [{ ...CLOSED, status: undefined, created: state.close === "created" }], error: null };
      }
      return { data: null, error: null };
    },
  },
}));

import Jaarafsluiting from "@/pages/Jaarafsluiting";

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
      <MemoryRouter>
        <Jaarafsluiting />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function controleer() {
  fireEvent.click(screen.getByTestId("jaar-uitvoeren"));
  await screen.findByTestId("jaar-rapport");
}

/** De heropenknop, de reden, en bevestigen. */
async function heropen(reden: string) {
  fireEvent.click(await screen.findByTestId("jaar-heropenen"));
  const veld = await screen.findByTestId("jaar-heropenen-reden");
  fireEvent.change(veld, { target: { value: reden } });
  const knop = screen.getByTestId("jaar-heropenen-bevestigen");
  await act(async () => {
    fireEvent.click(knop);
  });
}

async function sluitAf() {
  fireEvent.click(await screen.findByTestId("jaar-afsluiten"));
  const knop = await screen.findByTestId("jaar-bevestig-knop");
  await act(async () => {
    fireEvent.click(knop);
  });
}

/** Een afgesloten jaar op het watermerk: de normale heropenbare toestand. */
function afgesloten() {
  state.closure = CLOSED;
  state.watermark = JAAR;
  state.events = [EVT_CLOSED];
}

/** Een heropend jaar: het watermerk is gezakt. */
function heropend() {
  state.closure = REOPENED;
  state.watermark = null;
  state.events = [EVT_CLOSED, EVT_REOPENED];
}

beforeEach(() => {
  rpcCalls.length = 0;
  writeCalls.length = 0;
  toasts.length = 0;
  Object.assign(state, {
    watermark: null,
    canClose: true,
    closure: null,
    events: [],
    eventsError: false,
    lock: null,
    lockEvents: [],
    closureNaPoging: undefined,
    eventsNaPoging: undefined,
    watermarkNaPoging: undefined,
    reopen: "reopened",
    reopenError: { code: "23514", message: "" },
    close: "created",
    closeError: { code: "23514", message: "" },
    pogingen: 0,
  });
});

const reopenCalls = () => rpcCalls.filter((c) => c.fn === "reopen_fiscal_year");
const closeCalls = () => rpcCalls.filter((c) => c.fn === "close_fiscal_year");
const lockCalls = () => rpcCalls.filter((c) => /posting_lock|posting_allowed/.test(c.fn));

describe("De status en de knop die erbij hoort", () => {
  it("1. een afgesloten jaar toont Afgesloten en, voor een accountant, de heropenknop", async () => {
    afgesloten();
    toon();
    await waitFor(() => expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "closed"));
    expect(screen.getByTestId("jaar-status-badge")).toHaveTextContent("Afgesloten");
    expect(await screen.findByTestId("jaar-heropenen")).toBeEnabled();
    expect(screen.queryByTestId("jaar-afsluiten")).toBeNull();
  });

  it("2. een heropend jaar toont Heropend en, na een schone controle, 'opnieuw afsluiten'", async () => {
    heropend();
    toon();
    await waitFor(() => expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "reopened"));
    expect(screen.getByTestId("jaar-status-badge")).toHaveTextContent("Heropend");
    expect(screen.queryByTestId("jaar-heropenen")).toBeNull();
    await controleer();
    const knop = await screen.findByTestId("jaar-afsluiten");
    expect(knop).toHaveTextContent("Boekjaar opnieuw afsluiten");
    expect(screen.getByTestId("jaar-heropend-hint")).toHaveTextContent(/dezelfde volledige controle/i);
    // De status is een levensloopgegeven, geen afleiding uit boekingen.
    expect(screen.getByTestId("jaar-status-details")).toHaveTextContent("Nagekomen inkoopfactuur");
  });

  it("3. een open jaar toont Open en, na een schone controle, de afsluitknop", async () => {
    toon();
    await waitFor(() => expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "open"));
    expect(screen.getByTestId("jaar-status-badge")).toHaveTextContent("Open");
    expect(screen.queryByTestId("jaar-heropenen")).toBeNull();
    await controleer();
    expect(await screen.findByTestId("jaar-afsluiten")).toHaveTextContent("Boekjaar definitief afsluiten");
  });

  it("4. wie geen accountant is, krijgt uitleg in plaats van knoppen — en kan niets afvuren", async () => {
    state.canClose = false;
    afgesloten();
    const { unmount } = toon();
    await waitFor(() => expect(screen.getByTestId("jaar-geen-heropening")).toHaveAttribute("data-kind", "not_allowed"));
    expect(screen.getByTestId("jaar-geen-heropening")).toHaveTextContent(/accountant/i);
    expect(screen.queryByTestId("jaar-heropenen")).toBeNull();
    // Status en historie blijven wél zichtbaar.
    expect(screen.getByTestId("jaar-status-badge")).toHaveTextContent("Afgesloten");
    expect(await screen.findByTestId("jaar-gebeurtenissen")).toBeInTheDocument();
    unmount();

    heropend();
    toon();
    await controleer();
    await waitFor(() => expect(screen.getByTestId("jaar-geen-actie")).toHaveAttribute("data-kind", "not_allowed"));
    expect(screen.queryByTestId("jaar-afsluiten")).toBeNull();
    expect(reopenCalls()).toHaveLength(0);
    expect(closeCalls()).toHaveLength(0);
  });
});

describe("De reden", () => {
  it("5. zonder reden — ook niet met alleen witruimte — kan er niet worden bevestigd", async () => {
    afgesloten();
    toon();
    fireEvent.click(await screen.findByTestId("jaar-heropenen"));
    const veld = await screen.findByTestId("jaar-heropenen-reden");
    const knop = screen.getByTestId("jaar-heropenen-bevestigen");
    expect(knop).toBeDisabled();
    fireEvent.change(veld, { target: { value: "   \n\t " } });
    expect(knop).toBeDisabled();
    expect(screen.getByTestId("jaar-heropenen-reden-toets")).toHaveAttribute("data-ok", "false");
    fireEvent.click(knop);
    expect(reopenCalls()).toHaveLength(0);
  });

  it("6. meer dan 500 tekens wordt client-side geweigerd; precies 500 mag", async () => {
    afgesloten();
    toon();
    fireEvent.click(await screen.findByTestId("jaar-heropenen"));
    const veld = await screen.findByTestId("jaar-heropenen-reden");
    const knop = screen.getByTestId("jaar-heropenen-bevestigen");

    fireEvent.change(veld, { target: { value: "x".repeat(501) } });
    expect(knop).toBeDisabled();
    expect(screen.getByTestId("jaar-heropenen-reden-toets")).toHaveTextContent(/te lang/i);
    fireEvent.click(knop);
    expect(reopenCalls()).toHaveLength(0);

    fireEvent.change(veld, { target: { value: "x".repeat(500) } });
    expect(knop).toBeEnabled();
    expect(screen.getByTestId("jaar-heropenen-reden-toets")).toHaveAttribute("data-ok", "true");
  });

  it("6b. de reden gaat getrimd de deur uit, met precies drie waarden", async () => {
    afgesloten();
    state.closureNaPoging = REOPENED;
    state.eventsNaPoging = [EVT_CLOSED, EVT_REOPENED];
    state.watermarkNaPoging = null;
    toon();
    await heropen("  Nagekomen inkoopfactuur \n");
    await waitFor(() => expect(reopenCalls()).toHaveLength(1));
    expect(reopenCalls()[0].args).toEqual({
      _client_id: "client-1",
      _fiscal_year: JAAR,
      _reason: "Nagekomen inkoopfactuur",
    });
    expect(Object.keys(reopenCalls()[0].args)).toHaveLength(3);
  });
});

describe("Na een geslaagde handeling wordt alles ververst", () => {
  it("7. een geslaagde heropening toont Heropend, de reden en de nieuwe gebeurtenis", async () => {
    afgesloten();
    state.closureNaPoging = REOPENED;
    state.eventsNaPoging = [EVT_CLOSED, EVT_REOPENED];
    state.watermarkNaPoging = null;
    toon();
    await heropen("Nagekomen inkoopfactuur");

    await waitFor(() => expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "reopened"));
    expect(screen.queryByTestId("jaar-afsluitbewijs")).toBeNull();
    const bewijs = await screen.findByTestId("jaar-heropeningsbewijs");
    expect(bewijs).toHaveTextContent(`Boekjaar heropend ${JAAR}`);
    expect(bewijs).toHaveTextContent("Nagekomen inkoopfactuur");
    expect(screen.queryByTestId("jaar-al-heropend")).toBeNull();
    // De levensloop heeft nu twee regels, in volgorde.
    const regels = screen.getAllByTestId("jaar-gebeurtenis");
    expect(regels.map((r) => r.getAttribute("data-event-type"))).toEqual(["closed", "reopened"]);
    // De heropenknop is weg; de dialoog is dicht.
    expect(screen.queryByTestId("jaar-heropenen")).toBeNull();
    expect(screen.queryByTestId("jaar-heropenen-dialoog")).toBeNull();

    const sleutels = invalidated.map((k) => String(k[0]));
    for (const sleutel of ["year-closure", "fiscal-year-events", "clients", "ledger-postings", "unposted-source-work"]) {
      expect(sleutels, sleutel).toContain(sleutel);
    }
    expect(toasts.map((t) => t.title)).toContain(`Boekjaar ${JAAR} heropend`);
  });

  it("8. een geslaagde herafsluiting toont Afgesloten en de derde gebeurtenis", async () => {
    heropend();
    state.closureNaPoging = CLOSED;
    state.eventsNaPoging = [EVT_CLOSED, EVT_REOPENED, EVT_RECLOSED];
    state.watermarkNaPoging = JAAR;
    toon();
    await controleer();
    await sluitAf();

    await waitFor(() => expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "closed"));
    expect(closeCalls()[0].args).toEqual({ _client_id: "client-1", _fiscal_year: JAAR });
    expect(await screen.findByTestId("jaar-afsluitbewijs")).toBeInTheDocument();
    expect(screen.queryByTestId("jaar-heropeningsbewijs")).toBeNull();
    expect(screen.queryByTestId("jaar-afsluiten")).toBeNull();
    expect(screen.queryByTestId("jaar-rapport")).toBeNull();
    expect(screen.getAllByTestId("jaar-gebeurtenis").map((r) => r.getAttribute("data-event-type"))).toEqual([
      "closed",
      "reopened",
      "closed",
    ]);
    expect(await screen.findByTestId("jaar-heropenen")).toBeInTheDocument();
    const sleutels = invalidated.map((k) => String(k[0]));
    expect(sleutels).toContain("fiscal-year-events");
  });
});

describe("Als de database weigert", () => {
  it("9. een 23514 bij heropenen komt letterlijk op het scherm, met zijn soort", async () => {
    afgesloten();
    state.reopen = "error";
    state.reopenError = {
      code: "23514",
      message: `Alleen het laatst afgesloten boekjaar (${JAAR + 1}) kan worden heropend; heropen eerst de jongere jaren.`,
    };
    toon();
    await heropen("Nagekomen inkoopfactuur");
    const melding = await screen.findByTestId("jaar-heropenfout");
    expect(melding).toHaveAttribute("data-kind", "not_highest");
    expect(melding).toHaveTextContent(state.reopenError.message);
    expect(screen.getByTestId("jaar-heropenadvies")).toBeInTheDocument();
    // Niets gerepareerd, niets herhaald, status ongewijzigd.
    expect(reopenCalls()).toHaveLength(1);
    expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "closed");
    expect(toasts.some((t) => t.variant === "destructive")).toBe(true);
  });

  it("9b. een inconsistente levensloop is een blokkade, geen succes", async () => {
    afgesloten();
    state.reopen = "error";
    state.reopenError = {
      code: "23514",
      message: `Boekjaar ${JAAR} staat afgesloten maar de gebeurtenisgeschiedenis draagt dat niet (laatste: reopened); de afsluitstand is inconsistent en moet handmatig worden onderzocht.`,
    };
    toon();
    await heropen("Nagekomen inkoopfactuur");
    const melding = await screen.findByTestId("jaar-heropenfout");
    expect(melding).toHaveAttribute("data-kind", "inconsistent");
    expect(melding).toHaveTextContent(state.reopenError.message);
    expect(screen.getByTestId("jaar-heropenadvies")).toHaveTextContent("Controleer deze administratie voordat u verdergaat.");
    expect(screen.queryByTestId("jaar-heropeningsbewijs")).toBeNull();
    expect(toasts.map((t) => t.title)).not.toContain(`Boekjaar ${JAAR} heropend`);
  });

  it("9c. een rolweigering van de database wordt als zodanig getoond", async () => {
    afgesloten();
    state.reopen = "error";
    state.reopenError = {
      code: "42501",
      message: "Geen rechten om een boekjaar te heropenen voor deze organisatie (accountant vereist)",
    };
    toon();
    await heropen("Nagekomen inkoopfactuur");
    const melding = await screen.findByTestId("jaar-heropenfout");
    expect(melding).toHaveAttribute("data-kind", "permission");
    expect(melding).toHaveTextContent(/accountant/i);
  });

  it("9d. bij herafsluiten komt de gereedheidsweigering of het heropende oudere jaar letterlijk door", async () => {
    heropend();
    state.close = "error";
    state.closeError = {
      code: "23514",
      message: `Boekjaar ${JAAR - 1} staat heropend; sluit dat eerst opnieuw af voordat boekjaar ${JAAR} wordt afgesloten.`,
    };
    const { unmount } = toon();
    await controleer();
    await sluitAf();
    let melding = await screen.findByTestId("jaar-afsluitfout");
    expect(melding).toHaveAttribute("data-kind", "older_reopened");
    expect(melding).toHaveTextContent(state.closeError.message);
    expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "reopened");
    unmount();

    state.pogingen = 0;
    state.closeError = {
      code: "23514",
      message: `Er staat nog 1 postbaar brondocument(en) open met boekjaar t/m ${JAAR}; afsluiten zou dat document voorgoed onboekbaar maken.`,
    };
    toon();
    await controleer();
    await sluitAf();
    melding = await screen.findByTestId("jaar-afsluitfout");
    expect(melding).toHaveAttribute("data-kind", "unposted_work");
    expect(melding).toHaveTextContent(state.closeError.message);
  });

  it("9e. een netwerkstoring: eerst opnieuw kijken, en blijkt het jaar heropend dan is dát de uitkomst", async () => {
    afgesloten();
    state.reopen = "network";
    state.closureNaPoging = REOPENED;
    state.eventsNaPoging = [EVT_CLOSED, EVT_REOPENED];
    state.watermarkNaPoging = null;
    toon();
    await heropen("Nagekomen inkoopfactuur");
    await waitFor(() => expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "reopened"));
    expect(screen.queryByTestId("jaar-heropenfout")).toBeNull();
    expect(reopenCalls()).toHaveLength(1);
  });
});

describe("De boekingsblokkade staat er los van", () => {
  it("10. geen enkele handeling raakt de blokkade of schrijft rechtstreeks", async () => {
    afgesloten();
    state.closureNaPoging = REOPENED;
    state.eventsNaPoging = [EVT_CLOSED, EVT_REOPENED];
    state.watermarkNaPoging = null;
    const { unmount } = toon();
    await heropen("Nagekomen inkoopfactuur");
    await waitFor(() => expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "reopened"));
    unmount();

    state.pogingen = 0;
    heropend();
    state.closureNaPoging = CLOSED;
    state.eventsNaPoging = [EVT_CLOSED, EVT_REOPENED, EVT_RECLOSED];
    state.watermarkNaPoging = JAAR;
    toon();
    await controleer();
    await sluitAf();
    await waitFor(() => expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "closed"));

    expect(lockCalls()).toEqual([]);
    expect(writeCalls).toEqual([]);
    expect(rpcCalls.map((c) => c.fn).filter((f) => f !== "has_min_role")).toEqual([
      "reopen_fiscal_year",
      "close_fiscal_year",
    ]);
    // De blokkadekaart blijft een eigen, ongewijzigd concept.
    // De blokkadekaart blijft een eigen, ongewijzigd concept: geen blokkade
    // vóór, geen blokkade na — afsluiten en heropenen raken haar niet.
    const blokkade = screen.getByTestId("boekingsblokkade-card");
    expect(screen.getByTestId("blokkade-stand")).toHaveTextContent("Geen boekingsblokkade");
    expect(blokkade).toHaveTextContent("Een boekjaar heropenen heft deze blokkade niet op.");
  });

  it("10c. afgesloten jaar + geen blokkade: twee losse standen, geen van beide afgeleid van de ander", async () => {
    afgesloten();
    state.lock = null;
    toon();
    await waitFor(() => expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "closed"));
    await waitFor(() => expect(screen.getByTestId("blokkade-status-badge")).toHaveAttribute("data-locked", "false"));
    expect(screen.getByTestId("blokkade-stand")).toHaveTextContent("Geen boekingsblokkade");
    // Het jaar is dicht, maar de kaart zegt niet dat er een blokkade is.
    expect(screen.getByTestId("boekingsblokkade-card")).not.toHaveTextContent(`31-12-${JAAR}`);
  });

  it("10d. heropend jaar + blokkade nog gezet: beide blijven zichtbaar zoals ze zijn", async () => {
    heropend();
    state.lock = `${JAAR}-12-31`;
    state.lockEvents = [
      {
        id: "lock-1",
        client_id: "client-1",
        organization_id: "org-1",
        previous_locked_through: null,
        new_locked_through: `${JAAR}-12-31`,
        changed_at: "2027-01-10T08:00:00.000Z",
        changed_by: "user-1",
        reason: "Aangifte ingediend",
      },
    ];
    toon();
    await waitFor(() => expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "reopened"));
    await waitFor(() => expect(screen.getByTestId("blokkade-status-badge")).toHaveAttribute("data-locked", "true"));
    expect(screen.getByTestId("blokkade-stand")).toHaveTextContent(`Boekingen geblokkeerd t/m 31-12-${JAAR}`);
    expect(screen.queryByTestId("blokkade-inconsistent")).toBeNull();
    expect(screen.getByTestId("boekingsblokkade-card")).toHaveTextContent(
      "Een boekjaar heropenen heft deze blokkade niet op.",
    );
    // De jaarkaart noemt de blokkade niet als onderdeel van haar status.
    expect(screen.getByTestId("jaar-status-card")).not.toHaveTextContent(/geblokkeerd t\/m/i);
    expect(lockCalls()).toEqual([]);
  });

  it("10b. de heropeningsdialoog belooft niet dat een periode of blokkade opengaat", async () => {
    afgesloten();
    toon();
    fireEvent.click(await screen.findByTestId("jaar-heropenen"));
    const gevolgen = await screen.findByTestId("jaar-heropenen-gevolgen");
    expect(gevolgen).toHaveTextContent(/boekingsblokkade .* verandert hierdoor niet/i);
    expect(gevolgen).not.toHaveTextContent(/blokkade (wordt )?opgeheven|periode weer open/i);
    expect(reopenCalls()).toHaveLength(0);
  });
});

describe("De historie", () => {
  it("11. afgesloten → heropend → afgesloten, in die volgorde, met reden en zonder verzonnen actor", async () => {
    // Bewust door elkaar aangeleverd: de volgorde moet uit de tijdstippen komen.
    state.closure = CLOSED;
    state.watermark = JAAR;
    state.events = [EVT_RECLOSED, EVT_CLOSED, EVT_REOPENED];
    toon();
    const lijst = await screen.findByTestId("jaar-gebeurtenissen");
    const regels = within(lijst).getAllByTestId("jaar-gebeurtenis");
    expect(regels.map((r) => r.getAttribute("data-event-type"))).toEqual(["closed", "reopened", "closed"]);
    expect(regels[0]).toHaveTextContent("Afgesloten");
    expect(regels[0]).toHaveTextContent("15-01-2027");
    expect(regels[0]).toHaveTextContent("U zelf");
    expect(regels[1]).toHaveTextContent("Heropend");
    expect(regels[1]).toHaveTextContent("Nagekomen inkoopfactuur");
    expect(regels[1]).toHaveTextContent("01-02-2027");
    // user-2 is niet de ingelogde gebruiker: geen naam verzonnen, geen uuid getoond.
    expect(regels[1]).not.toHaveTextContent("U zelf");
    expect(regels[1]).not.toHaveTextContent("user-2");
    expect(regels[2]).toHaveTextContent("03-02-2027");
    expect(regels.every((r) => r.textContent?.includes(String(JAAR)))).toBe(true);
  });

  it("11b. kan de historie niet worden gelezen, dan staat dat er — er wordt niets verzonnen", async () => {
    afgesloten();
    state.eventsError = true;
    toon();
    // Het bewijs is er nog; de gebeurtenissen niet: een melding, geen regels.
    await screen.findByTestId("jaar-afsluitbewijs");
    const melding = await screen.findByTestId("jaar-historie-fout");
    expect(melding).toHaveTextContent(/niet worden opgehaald/i);
    expect(melding).not.toHaveTextContent(/permission denied/);
    expect(screen.queryByTestId("jaar-gebeurtenis")).toBeNull();
    // De status zelf komt uit het bewijs en blijft gewoon staan.
    expect(screen.getByTestId("jaar-status-badge")).toHaveAttribute("data-status", "closed");
  });
});

describe("Idempotente uitkomsten verdubbelen niets", () => {
  it("12. reopened = false is een mededeling; er komt geen tweede bewijs en geen tweede regel", async () => {
    heropend();
    state.reopen = "existing";
    // De pagina biedt op een heropend jaar geen heropenknop aan; deze
    // uitkomst ontstaat bij een race met een collega. Simuleer: bij
    // binnenkomst nog afgesloten, de server zegt "al heropend".
    state.closure = CLOSED;
    state.watermark = JAAR;
    state.events = [EVT_CLOSED];
    state.closureNaPoging = REOPENED;
    state.eventsNaPoging = [EVT_CLOSED, EVT_REOPENED];
    state.watermarkNaPoging = null;
    toon();
    await heropen("Nagekomen inkoopfactuur");

    await screen.findByTestId("jaar-al-heropend");
    expect(screen.getByTestId("jaar-al-heropend")).toHaveTextContent("Dit boekjaar was al heropend.");
    expect(screen.getAllByTestId("jaar-heropeningsbewijs")).toHaveLength(1);
    expect(screen.getAllByTestId("jaar-gebeurtenis")).toHaveLength(2);
    expect(screen.queryByTestId("jaar-heropenfout")).toBeNull();
    expect(toasts.some((t) => t.variant === "destructive")).toBe(false);
    expect(toasts.map((t) => t.title)).toContain("Boekjaar was al heropend");
  });

  it("12b. created = false bij herafsluiten is een mededeling, geen fout", async () => {
    heropend();
    state.close = "existing";
    state.closureNaPoging = CLOSED;
    state.eventsNaPoging = [EVT_CLOSED, EVT_REOPENED, EVT_RECLOSED];
    state.watermarkNaPoging = JAAR;
    toon();
    await controleer();
    await sluitAf();
    await screen.findByTestId("jaar-al-afgesloten");
    expect(screen.getAllByTestId("jaar-afsluitbewijs")).toHaveLength(1);
    expect(screen.queryByTestId("jaar-afsluitfout")).toBeNull();
    expect(screen.getAllByTestId("jaar-gebeurtenis")).toHaveLength(3);
  });
});
