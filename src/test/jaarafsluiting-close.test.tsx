import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DiagnosticCheck, DiagnosticCheckId, DiagnosticRun } from "@/lib/diagnostic-report";
import { available } from "@/lib/diagnostic-report";

// Radix Select gebruikt deze browser-API; jsdom implementeert haar niet.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

/**
 * Jaarafsluiting — definitief afsluiten (PR 2b).
 *
 * Wat hier bewaakt wordt is de belofte van het scherm: er gebeurt niets tot de
 * gebruiker twee keer expliciet ja zegt, er gaat nooit meer dan een
 * administratie en een jaartal de deur uit, een ruwe databasefout komt nooit
 * op het scherm, en een onbekende afloop leidt eerst tot opnieuw kijken en pas
 * daarna tot opnieuw proberen.
 *
 * De hooks van de afsluiting zijn NIET gemockt: `useYearClose.ts` draait echt,
 * tegen een gemockte Supabase-client. Zo wordt ook bewezen wat er werkelijk
 * over de lijn gaat. De gereedheid komt uit de échte `evaluateYearClose()`.
 */

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

const rpcCalls: RpcCall[] = [];
const writeCalls: string[] = [];
const toasts: { title?: string; description?: string; variant?: string }[] = [];

/**
 * Het boekjaar dat de pagina zelf voorstelt. Hardcoderen zou deze test op
 * 1 januari laten omvallen: de keuzelijst loopt mee met de kalender, en een
 * jaar zonder boekingen levert terecht een waarschuwing op in plaats van een
 * afsluitknop.
 */
const JAAR = new Date().getFullYear() - 1;
const VORIG_JAAR = JAAR - 1;

const CLOSURE = {
  client_id: "client-1",
  organization_id: "org-1",
  fiscal_year: JAAR,
  closed_at: "2027-01-15T10:30:00.000Z",
  closed_by: "user-1",
};

const state = {
  /** Gereedheid: welke controle-uitslag de bronnen opleveren. */
  uitslag: "schoon" as "schoon" | "waarschuwing" | "blokkade" | "onvolledig",
  watermark: null as number | null,
  canClose: true as boolean | null,
  /** Wat de leesquery op year_closures teruggeeft. */
  closure: null as typeof CLOSURE | null,
  /** Wat close_fiscal_year() doet. */
  close: "created" as "created" | "existing" | "error" | "network",
  closeError: { code: "23514", message: "" } as { code: string; message: string },
  /** Na een mislukte poging alsnog bewijs vinden (de time-outverzoening). */
  closureNaPoging: null as typeof CLOSURE | null,
  pogingen: 0,
};

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: clientKeuze.id, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({
    data: [
      { id: "client-1", name: "Klant A", afgesloten_boekjaar: state.watermark },
      { id: "client-2", name: "Klant B", afgesloten_boekjaar: null },
    ],
  }),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, session: null, loading: false }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (t: { title?: string; description?: string; variant?: string }) => toasts.push(t) }),
}));

/** Welke administratie het scherm toont; los van `state` zodat hij kan wisselen. */
const clientKeuze = { id: "client-1" };

function check(id: DiagnosticCheckId, severity: DiagnosticCheck["severity"]): DiagnosticCheck {
  return { id, title: `Controle ${id}`, severity, summary: "samenvatting" };
}

/** Een échte DiagnosticRun, zodat `evaluateYearClose()` onvervalst kan draaien. */
function diagnostics(): DiagnosticRun {
  if (state.uitslag === "onvolledig") {
    return {
      ok: false,
      unavailable: ["Grootboekmutaties"],
      checks: [check("period_balance", "ok")],
      summary: { executed: 1, passed: 1, warnings: 0, blocking: 0 },
    };
  }
  const severity =
    state.uitslag === "blokkade" ? "error" : state.uitslag === "waarschuwing" ? "warning" : "ok";
  return {
    ok: true,
    checks: [check("period_balance", severity)],
    summary: {
      executed: 1,
      passed: severity === "ok" ? 1 : 0,
      warnings: severity === "warning" ? 1 : 0,
      blocking: severity === "error" ? 1 : 0,
    },
  };
}

vi.mock("@/hooks/useYearCloseSources", () => ({
  useYearCloseSources: () => ({
    isPending: false,
    input: {
      diagnostics: diagnostics(),
      closedThrough: available(state.watermark),
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
          eq: () => ({
            maybeSingle: async () => {
              if (table !== "year_closures") return { data: null, error: null };
              const rij = state.pogingen > 0 ? (state.closureNaPoging ?? state.closure) : state.closure;
              return { data: rij, error: null };
            },
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
      if (fn !== "close_fiscal_year") return { data: null, error: null };
      state.pogingen += 1;
      if (state.close === "network") throw new TypeError("Failed to fetch");
      if (state.close === "error") return { data: null, error: state.closeError };
      return { data: [{ ...CLOSURE, created: state.close === "created" }], error: null };
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

/** De gereedheidscontrole draaien, zoals een gebruiker dat doet. */
async function controleer() {
  fireEvent.click(screen.getByTestId("jaar-uitvoeren"));
  await screen.findByTestId("jaar-rapport");
}

/** De afsluitknop indrukken en in de dialoog bevestigen. */
async function sluitAf() {
  fireEvent.click(await screen.findByTestId("jaar-afsluiten"));
  const knop = await screen.findByTestId("jaar-bevestig-knop");
  await act(async () => {
    fireEvent.click(knop);
  });
}

beforeEach(() => {
  rpcCalls.length = 0;
  writeCalls.length = 0;
  toasts.length = 0;
  clientKeuze.id = "client-1";
  Object.assign(state, {
    uitslag: "schoon",
    watermark: null,
    canClose: true,
    closure: null,
    close: "created",
    closeError: { code: "23514", message: "" },
    closureNaPoging: null,
    pogingen: 0,
  });
});

const closeCalls = () => rpcCalls.filter((c) => c.fn === "close_fiscal_year");

describe("Wanneer verschijnt de afsluitknop", () => {
  it("1. vóór de gereedheidscontrole is er geen afsluitknop", async () => {
    toon();
    await screen.findByTestId("jaar-uitvoeren");
    expect(screen.queryByTestId("jaar-afsluiten")).toBeNull();
    expect(screen.queryByTestId("jaar-geen-actie")).toBeNull();
  });

  it("2-4. een blokkade, een onvolledige controle en een waarschuwing bieden niets aan", async () => {
    for (const uitslag of ["blokkade", "onvolledig", "waarschuwing"] as const) {
      state.uitslag = uitslag;
      const { unmount } = toon();
      await controleer();
      await waitFor(() =>
        expect(screen.getByTestId("jaar-geen-actie"), uitslag).toHaveAttribute("data-kind", "not_ready"),
      );
      expect(screen.queryByTestId("jaar-afsluiten"), uitslag).toBeNull();
      unmount();
    }
    // En er is in geen van die gevallen ook maar één RPC afgevuurd.
    expect(closeCalls()).toHaveLength(0);
  });

  it("5. een schone controle levert wél een afsluitknop op", async () => {
    toon();
    await controleer();
    expect(await screen.findByTestId("jaar-afsluiten")).toBeInTheDocument();
  });

  it("6. een te lage rol krijgt uitleg in plaats van een knop", async () => {
    state.canClose = false;
    toon();
    await controleer();
    await waitFor(() => expect(screen.getByTestId("jaar-geen-actie")).toHaveAttribute("data-kind", "not_allowed"));
    expect(screen.queryByTestId("jaar-afsluiten")).toBeNull();
    expect(screen.getByTestId("jaar-geen-actie")).toHaveTextContent(/accountant/i);
  });
});

describe("De bevestiging", () => {
  it("7. de knop opent een dialoog en boekt nog niets", async () => {
    toon();
    await controleer();
    fireEvent.click(await screen.findByTestId("jaar-afsluiten"));
    await screen.findByTestId("jaar-bevestigen");
    expect(closeCalls()).toHaveLength(0);
  });

  it("8. de dialoog benoemt administratie, jaar en de gevolgen", async () => {
    toon();
    await controleer();
    fireEvent.click(await screen.findByTestId("jaar-afsluiten"));
    const dialoog = await screen.findByTestId("jaar-bevestigen");
    expect(dialoog).toHaveTextContent("Klant A");
    expect(dialoog).toHaveTextContent(String(JAAR));
    const gevolgen = screen.getByTestId("jaar-gevolgen");
    expect(gevolgen).toHaveTextContent(/geen nieuwe boekingen of tegenboekingen/i);
    expect(gevolgen).toHaveTextContent(/blijven ongewijzigd/i);
    expect(gevolgen).toHaveTextContent(/geen resultaatboeking/i);
    expect(gevolgen).toHaveTextContent(/geen beginbalans/i);
    expect(gevolgen).toHaveTextContent(/niet meer worden heropend/i);
  });

  it("9. annuleren boekt niets", async () => {
    toon();
    await controleer();
    fireEvent.click(await screen.findByTestId("jaar-afsluiten"));
    fireEvent.click(await screen.findByTestId("jaar-annuleer-knop"));
    expect(closeCalls()).toHaveLength(0);
  });

  it("10. er gaan precies twee waarden de deur uit", async () => {
    toon();
    await controleer();
    await sluitAf();
    await waitFor(() => expect(closeCalls()).toHaveLength(1));
    expect(closeCalls()[0].args).toEqual({ _client_id: "client-1", _fiscal_year: JAAR });
    // Geen resultaat, geen gereedheid, geen classificatie, geen watermerk.
    expect(Object.keys(closeCalls()[0].args)).toHaveLength(2);
  });

  it("11. twee klikken binnen één tick leveren één aanroep op", async () => {
    toon();
    await controleer();
    fireEvent.click(await screen.findByTestId("jaar-afsluiten"));
    const knop = await screen.findByTestId("jaar-bevestig-knop");
    await act(async () => {
      fireEvent.click(knop);
      fireEvent.click(knop);
      fireEvent.click(knop);
    });
    await waitFor(() => expect(closeCalls().length).toBeGreaterThan(0));
    expect(closeCalls()).toHaveLength(1);
  });
});

describe("Na afloop", () => {
  it("12. een geslaagde afsluiting toont het afsluitbewijs", async () => {
    toon();
    await controleer();
    await sluitAf();
    const bewijs = await screen.findByTestId("jaar-afsluitbewijs");
    expect(bewijs).toHaveTextContent(`Boekjaar afgesloten ${JAAR}`);
    expect(screen.getByTestId("afsluitbewijs-administratie")).toHaveTextContent("Klant A");
    expect(screen.getByTestId("afsluitbewijs-tijdstip")).toHaveTextContent("15-01-2027");
    expect(screen.getByTestId("afsluitbewijs-actor")).toHaveTextContent("U zelf");
    // Nooit een bedrag: `result_cents` bestaat niet.
    expect(bewijs.textContent ?? "").not.toMatch(/€|resultaat/i);
  });

  it("13. de afsluitknop verdwijnt daarna", async () => {
    toon();
    await controleer();
    await sluitAf();
    await screen.findByTestId("jaar-afsluitbewijs");
    expect(screen.queryByTestId("jaar-afsluiten")).toBeNull();
    // En de momentopname van vóór de afsluiting staat er niet meer naast.
    expect(screen.queryByTestId("jaar-rapport")).toBeNull();
  });

  it("14. created = false is geen fout maar een mededeling", async () => {
    state.close = "existing";
    toon();
    await controleer();
    await sluitAf();
    await screen.findByTestId("jaar-afsluitbewijs");
    expect(screen.getByTestId("jaar-al-afgesloten")).toHaveTextContent(
      "Dit boekjaar was al afgesloten. Het bestaande afsluitbewijs is geladen.",
    );
    expect(screen.queryByTestId("jaar-afsluitfout")).toBeNull();
    expect(toasts.some((t) => t.variant === "destructive")).toBe(false);
  });

  it("15. de relevante caches worden ververst", async () => {
    toon();
    await controleer();
    await sluitAf();
    await waitFor(() => expect(invalidated.length).toBeGreaterThan(0));
    const sleutels = invalidated.map((k) => String(k[0]));
    for (const sleutel of ["year-closure", "clients", "ledger-postings", "unposted-source-work"]) {
      expect(sleutels, sleutel).toContain(sleutel);
    }
  });

  it("16. er wordt nooit rechtstreeks geschreven", async () => {
    toon();
    await controleer();
    await sluitAf();
    await screen.findByTestId("jaar-afsluitbewijs");
    expect(writeCalls).toEqual([]);
    expect(rpcCalls.map((c) => c.fn).filter((f) => f !== "has_min_role")).toEqual(["close_fiscal_year"]);
  });
});

describe("Als de database weigert", () => {
  const weiger = async (code: string, message: string) => {
    state.close = "error";
    state.closeError = { code, message };
    toon();
    await controleer();
    await sluitAf();
    return screen.findByTestId("jaar-afsluitfout");
  };

  it("17. de erfenistoestand krijgt een eigen, duidelijke melding", async () => {
    const melding = await weiger(
      "23514",
      "Boekjaar 2026 staat al als afgesloten (watermerk 2026) maar er is geen bijbehorend afsluitbewijs; dit moet handmatig worden onderzocht.",
    );
    expect(melding).toHaveAttribute("data-kind", "inconsistent_closure");
    expect(melding).toHaveTextContent(/ontbreekt een afsluitbewijs uit de nieuwe jaarafsluiting/i);
    expect(screen.getByTestId("jaar-afsluitadvies")).toHaveTextContent(
      "Controleer deze administratie voordat u verdergaat.",
    );
    // Er wordt niets gerepareerd en niets opnieuw geprobeerd.
    expect(closeCalls()).toHaveLength(1);
    expect(screen.queryByTestId("jaar-afsluitbewijs")).toBeNull();
  });

  it("18. openstaand bronwerk, ongebalanceerde groep, volgorde en datum krijgen elk hun eigen soort", async () => {
    const gevallen: [string, string][] = [
      ["unposted_work", "Er staat nog 1 postbaar brondocument(en) open met boekjaar t/m 2026; afsluiten zou dat document voorgoed onboekbaar maken."],
      ["unbalanced_group", "Er staat t/m boekjaar 2026 1 ongebalanceerde boekingsgroep(en) in het grootboek; afsluiten zou die onherstelbaar maken."],
      ["year_order", "Er liggen oudere boekjaren met boekingen nog open (2025); boekjaar 2026 afsluiten zou die ongemerkt meenemen."],
      ["missing_date", "Van 1 postbaar brondocument(en) is de boekhoudkundige datum onbekend; het boekjaar kan niet worden vastgesteld en afsluiten is daarom niet veilig."],
    ];
    for (const [soort, tekst] of gevallen) {
      const melding = await weiger("23514", tekst);
      expect(melding, soort).toHaveAttribute("data-kind", soort);
      expect(screen.getByTestId("jaar-afsluitadvies"), soort).toBeInTheDocument();
      document.body.innerHTML = "";
    }
  });

  it("19. een tenantweigering en een rolweigering worden onderscheiden", async () => {
    const tenant = await weiger("42501", "Administratie niet beschikbaar");
    expect(tenant).toHaveAttribute("data-kind", "unavailable");
    document.body.innerHTML = "";

    const rol = await weiger(
      "42501",
      "Geen rechten om een boekjaar af te sluiten voor deze organisatie (accountant vereist)",
    );
    expect(rol).toHaveAttribute("data-kind", "permission");
    expect(rol).toHaveTextContent(/accountant/i);
  });

  it("20. ruwe databasetekst komt nooit op het scherm", async () => {
    await weiger(
      "XX000",
      'new row for relation "year_closures" violates check constraint "year_closures_fiscal_year_check"',
    );
    const pagina = document.body.textContent ?? "";
    for (const lek of ["violates", "constraint", "year_closures", "XX000", "relation"]) {
      expect(pagina, lek).not.toContain(lek);
    }
    expect(screen.getByTestId("jaar-afsluitfout")).toHaveTextContent(
      "Het afsluiten is niet gelukt. Probeer het opnieuw.",
    );
  });
});

describe("Een onbekende afloop", () => {
  it("21. bij een netwerkstoring wordt eerst opnieuw gekeken, niet opnieuw geprobeerd", async () => {
    state.close = "network";
    toon();
    await controleer();
    await sluitAf();
    await screen.findByTestId("jaar-afsluitfout");
    // Eén poging. Geen automatische herhaling.
    expect(closeCalls()).toHaveLength(1);
    expect(screen.getByTestId("jaar-afsluitfout")).toHaveTextContent(
      /niet bekend of het boekjaar is afgesloten/i,
    );
    // De afsluitknop staat er weer: opnieuw proberen mag, bewust.
    expect(screen.getByTestId("jaar-afsluiten")).toBeInTheDocument();
  });

  it("22. blijkt er tóch bewijs te liggen, dan wordt dat getoond in plaats van een fout", async () => {
    state.close = "network";
    state.closureNaPoging = CLOSURE;
    toon();
    await controleer();
    await sluitAf();
    await screen.findByTestId("jaar-afsluitbewijs");
    expect(screen.queryByTestId("jaar-afsluitfout")).toBeNull();
    expect(screen.getByTestId("jaar-al-afgesloten")).toBeInTheDocument();
    expect(closeCalls()).toHaveLength(1);
  });
});

describe("Een jaar dat al dicht is", () => {
  it("23. een bestaand afsluitbewijs toont bij binnenkomst meteen de afgesloten staat", async () => {
    state.closure = CLOSURE;
    toon();
    await screen.findByTestId("jaar-afsluitbewijs");
    expect(screen.queryByTestId("jaar-afsluiten")).toBeNull();
    expect(screen.getByTestId("jaar-afgesloten")).toHaveTextContent(/kan niet ongedaan|vast|later/i);
  });

  it("24. de controle opnieuw draaien geeft het jaar geen tweede afsluitknop", async () => {
    state.closure = CLOSURE;
    toon();
    await screen.findByTestId("jaar-afsluitbewijs");
    await controleer();
    expect(screen.getByTestId("jaar-rapport")).toBeInTheDocument();
    expect(screen.queryByTestId("jaar-afsluiten")).toBeNull();
    expect(screen.getByTestId("jaar-afsluitbewijs")).toBeInTheDocument();
  });

  it("25. watermerk zonder bewijs wordt expliciet als inconsistent getoond", async () => {
    state.watermark = JAAR;
    state.closure = null;
    toon();
    const melding = await screen.findByTestId("jaar-inconsistent");
    expect(melding).toHaveTextContent(/ontbreekt een afsluitbewijs uit de nieuwe jaarafsluiting/i);
    expect(melding).toHaveTextContent("Controleer deze administratie voordat u verdergaat.");
    expect(screen.queryByTestId("jaar-afsluiten")).toBeNull();
  });

  it("25a. toont boekjaarstatus en boekingsblokkade als twee onafhankelijke concepten", async () => {
    state.closure = CLOSURE;
    state.watermark = JAAR;
    toon();

    const status = await screen.findByTestId("jaar-status-card");
    expect(status).toHaveTextContent("Boekjaarstatus");
    await waitFor(() => expect(screen.getByTestId("jaar-status-badge")).toHaveTextContent("Afgesloten"));

    const blokkade = screen.getByTestId("boekingsblokkade-card");
    expect(blokkade).toHaveTextContent("Nog niet afzonderlijk ingesteld");
    expect(blokkade).toHaveTextContent("Deze staat los van de boekjaarstatus");
    expect(blokkade).not.toHaveTextContent(`31-12-${JAAR}`);
  });

  it("25b. de heropeningsdialoog is een niet-schrijvend prototype met verplichte reden", async () => {
    state.closure = CLOSURE;
    toon();
    await screen.findByTestId("jaar-afsluitbewijs");

    expect(screen.getByRole("button", { name: "Boekjaar heropenen" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Bekijk toekomstige werkwijze" }));
    const dialoog = await screen.findByTestId("jaar-heropenen-dialoog");
    expect(dialoog).toHaveTextContent(/eerdere afsluiting blijft zichtbaar in de audittrail/i);
    expect(screen.getByLabelText("Reden voor heropening")).toHaveAttribute("required");
    expect(screen.getByPlaceholderText("Nagekomen inkoopfactuur")).toBeInTheDocument();
    expect(screen.getByTestId("jaar-heropenen-bevestigen")).toBeDisabled();
    expect(closeCalls()).toHaveLength(0);
    expect(writeCalls).toEqual([]);
  });

  it("25c. Historie toont alleen werkelijk afsluitbewijs en geen verzonnen heropening", async () => {
    state.closure = CLOSURE;
    toon();
    await screen.findByTestId("jaar-afsluitbewijs");
    const historie = screen.getByTestId("jaar-historie");
    expect(historie).toHaveTextContent(`Boekjaar afgesloten ${JAAR}`);
    expect(historie).toHaveTextContent("15-01-2027");
    expect(historie).not.toHaveTextContent("Nagekomen inkoopfactuur");
    expect(historie).not.toHaveTextContent("opnieuw afgesloten");
  });
});

describe("De nieuwe pagina-opbouw", () => {
  it("28. een open jaar toont de gescheiden kaarten, gereedheid en lege echte historie", async () => {
    toon();
    await screen.findByTestId("jaar-uitvoeren");

    expect(screen.getByTestId("jaar-status-badge")).toHaveTextContent("Open");
    expect(screen.getByTestId("boekingsblokkade-card")).toHaveTextContent("Nog niet afzonderlijk ingesteld");
    expect(screen.getByText("Gereedheid voor afsluiten")).toBeInTheDocument();
    expect(screen.getByTestId("jaar-historie")).toHaveTextContent(
      "Voor dit boekjaar is nog geen afsluiting vastgelegd.",
    );
  });

  it("29. de echte afsluitactie houdt de huidige technische waarschuwing", async () => {
    toon();
    await controleer();

    await screen.findByTestId("jaar-afsluiten");
    expect(screen.getByTestId("jaar-status-card")).toHaveTextContent(
      "de huidige technische jaarafsluiting kan nog niet worden heropend",
    );
    expect(screen.getByTestId("jaar-afsluiten")).toHaveTextContent("Boekjaar definitief afsluiten");
  });
});

describe("Wisselen van administratie of boekjaar", () => {
  it("26. een andere administratie toont geen gereedheid van de vorige", async () => {
    const { rerender } = toon();
    await controleer();
    expect(screen.getByTestId("jaar-rapport")).toBeInTheDocument();

    clientKeuze.id = "client-2";
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Jaarafsluiting />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId("jaar-rapport")).toBeNull());
    expect(screen.queryByTestId("jaar-afsluiten")).toBeNull();
  });

  it("27. een ander boekjaar toont geen afsluitbewijs van het vorige", async () => {
    toon();
    await controleer();
    await sluitAf();
    await screen.findByTestId("jaar-afsluitbewijs");

    // De leesquery voor het NIEUWE jaar levert niets op; het bewijs van 2026
    // mag dan niet blijven staan.
    state.closure = null;
    state.closureNaPoging = null;
    fireEvent.click(screen.getByLabelText("Boekjaar"));
    const optie = await screen.findByRole("option", { name: String(VORIG_JAAR) });
    await act(async () => {
      fireEvent.click(optie);
    });
    await waitFor(() => expect(screen.queryByTestId("jaar-afsluitbewijs")).toBeNull());
  });
});
