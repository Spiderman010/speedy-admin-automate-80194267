import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DiagnosticCheck, DiagnosticCheckId, DiagnosticRun } from "@/lib/diagnostic-report";
import { available } from "@/lib/diagnostic-report";

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
  if (state.uitslag === "waarschuwing") {
    // De rookproef op productie, nagebouwd: AA-Secure 2023 — nul blokkades,
    // twee waarschuwingen die de databaseschrijver zelf niet tegenhoudt.
    return {
      ok: true,
      checks: [
        check("period_balance", "ok"),
        {
          id: "opening_balance_status",
          title: "Beginbalans",
          severity: "warning",
          summary: "Geen beginbalans-bewering voor dit boekjaar.",
        },
        {
          id: "subgroups",
          title: "Groepsindeling",
          severity: "warning",
          summary: "9 rekeningen hebben wel een categorie maar nog geen groep.",
          count: 9,
        },
      ],
      summary: { executed: 3, passed: 1, warnings: 2, blocking: 0 },
    };
  }
  const severity = state.uitslag === "blokkade" ? "error" : "ok";
  return {
    ok: true,
    checks: [check("period_balance", severity)],
    summary: {
      executed: 1,
      passed: severity === "ok" ? 1 : 0,
      warnings: 0,
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

  it("2-3. een blokkade en een onvolledige controle bieden niets aan", async () => {
    for (const uitslag of ["blokkade", "onvolledig"] as const) {
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

  it("4. een schone controle levert wél een afsluitknop op", async () => {
    toon();
    await controleer();
    expect(await screen.findByTestId("jaar-afsluiten")).toBeInTheDocument();
  });

  it("5. een waarschuwing levert óók een afsluitknop op — maar blijft amber", async () => {
    state.uitslag = "waarschuwing";
    toon();
    await controleer();
    expect(await screen.findByTestId("jaar-afsluiten")).toBeInTheDocument();
    // De uitslag wordt NIET als schoon gepresenteerd.
    const status = screen.getByTestId("jaar-status");
    expect(status).toHaveAttribute("data-status", "warning");
    expect(status).not.toHaveTextContent("Gereed voor afsluiten");
    expect(screen.getByTestId("jaar-waarschuwingen")).toHaveTextContent("2");
    // En de twee bevindingen staan er gewoon nog, met hun eigen woorden.
    expect(screen.getByTestId("jaar-groep-warning")).toHaveTextContent(/Beginbalans/);
    expect(screen.getByTestId("jaar-groep-warning")).toHaveTextContent(/Groepsindeling/);
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

describe("Afsluiten mét openstaande waarschuwingen", () => {
  it("12a. de dialoog somt elke openstaande waarschuwing op, met titel én samenvatting", async () => {
    state.uitslag = "waarschuwing";
    toon();
    await controleer();
    fireEvent.click(await screen.findByTestId("jaar-afsluiten"));
    await screen.findByTestId("jaar-bevestigen");

    const blok = screen.getByTestId("jaar-dialoog-waarschuwingen");
    expect(blok).toHaveTextContent("Nog openstaande waarschuwingen (2)");

    const regels = screen.getAllByTestId("jaar-dialoog-waarschuwing");
    expect(regels).toHaveLength(2);
    expect(regels.map((r) => r.getAttribute("data-check"))).toEqual([
      "opening_balance_status",
      "subgroups",
    ]);
    // Niet alleen de titel: de volledige samenvatting staat erbij, zodat er
    // niets in een label wordt weggemoffeld.
    expect(regels[0]).toHaveTextContent("Beginbalans — Geen beginbalans-bewering voor dit boekjaar.");
    expect(regels[1]).toHaveTextContent(
      "Groepsindeling — 9 rekeningen hebben wel een categorie maar nog geen groep.",
    );
  });

  it("12b. de dialoog zegt dat deze waarschuwingen niet blokkeren, en houdt de gewone gevolgen", async () => {
    state.uitslag = "waarschuwing";
    toon();
    await controleer();
    fireEvent.click(await screen.findByTestId("jaar-afsluiten"));
    await screen.findByTestId("jaar-bevestigen");

    expect(screen.getByTestId("jaar-waarschuwingen-uitleg")).toHaveTextContent(
      /blokkeren de jaarafsluiting niet/i,
    );
    // De gewone gevolgen van definitief afsluiten blijven staan.
    const gevolgen = screen.getByTestId("jaar-gevolgen");
    expect(gevolgen).toHaveTextContent(/geen nieuwe boekingen of tegenboekingen/i);
    expect(gevolgen).toHaveTextContent(/niet meer worden heropend/i);
  });

  it("12c. er is nog steeds één expliciete bevestiging nodig, en geen tweede knop", async () => {
    state.uitslag = "waarschuwing";
    toon();
    await controleer();
    fireEvent.click(await screen.findByTestId("jaar-afsluiten"));
    await screen.findByTestId("jaar-bevestigen");
    // Het openen van de dialoog boekt nog niets.
    expect(closeCalls()).toHaveLength(0);

    // Precies één bevestigknop: de waarschuwing zelf IS het geïnformeerde pad,
    // er is geen apart overridemechanisme naast.
    expect(screen.getAllByTestId("jaar-bevestig-knop")).toHaveLength(1);
    expect(screen.queryByRole("checkbox")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("jaar-bevestig-knop"));
    });
    await waitFor(() => expect(closeCalls()).toHaveLength(1));
  });

  it("12d. de databaseaanroep is exact dezelfde als bij een schone uitslag", async () => {
    state.uitslag = "waarschuwing";
    toon();
    await controleer();
    await sluitAf();
    await waitFor(() => expect(closeCalls()).toHaveLength(1));
    // Geen extra vlag, geen 'force', geen gereedheidsuitslag: het waarschuwings-
    // pad verandert niets aan wat de database te horen krijgt.
    expect(closeCalls()[0].args).toEqual({ _client_id: "client-1", _fiscal_year: JAAR });
    expect(writeCalls).toEqual([]);
  });

  it("12e. bij een schone uitslag staat er geen waarschuwingsblok in de dialoog", async () => {
    toon();
    await controleer();
    fireEvent.click(await screen.findByTestId("jaar-afsluiten"));
    await screen.findByTestId("jaar-bevestigen");
    expect(screen.queryByTestId("jaar-dialoog-waarschuwingen")).toBeNull();
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
