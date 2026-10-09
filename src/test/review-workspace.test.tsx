import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Review — de echte, alleen-lezen wachtrij.
 *
 * De leeshook `useLedgerCatchup` is gemockt, maar de records die hij teruggeeft
 * komen uit de ÉCHTE beoordelingslaag (`evaluatePurchaseInvoice` /
 * `evaluateSalesInvoice`). Zo bewijzen deze tests dat de pagina de toestanden
 * van die laag ongewijzigd toont en zelf niets afleidt. De Supabase-client is
 * een spion die bij elke aanraking faalt: de pagina mag hem nooit gebruiken.
 */

const { supabaseCalls, hookCalls } = vi.hoisted(() => ({
  supabaseCalls: [] as string[],
  hookCalls: [] as Array<{ clientId: string | undefined; year: number | null }>,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: new Proxy(
    {},
    {
      get: (_t, prop) => {
        supabaseCalls.push(String(prop));
        return () => {
          throw new Error(`Review raakte supabase.${String(prop)} aan`);
        };
      },
    },
  ),
}));

const state = {
  clientId: "c1" as string,
  data: undefined as unknown,
  isPending: false,
  isError: false,
  error: null as { message: string } | null,
  refetch: vi.fn(),
};

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "boekhouder@agio.nl" } }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c1", name: "Klant 1" }, { id: "c2", name: "Klant 2" }] }),
}));
vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.clientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/components/OrganizationSelector", () => ({
  OrganizationSelector: () => null,
}));
vi.mock("@/hooks/useLedgerCatchup", () => ({
  useLedgerCatchup: (clientId: string | undefined, period: { year: number | null }) => {
    hookCalls.push({ clientId, year: period.year });
    return {
      data: state.isPending || state.isError ? undefined : state.data,
      isPending: state.isPending,
      isError: state.isError,
      error: state.error,
      refetch: state.refetch,
    };
  },
  // Bewust een val: zou de pagina de bulkschrijver ooit aanroepen, dan faalt de test.
  useRunLedgerCatchup: () => {
    throw new Error("Review mag useRunLedgerCatchup niet gebruiken");
  },
}));

import Review, { REVIEW_EMPTY_MESSAGE, REVIEW_READ_ONLY_NOTE } from "@/pages/Review";
import { AppShell } from "@/components/layout/app-shell";
import { NAV_SECTIONS, pageTitleForPath } from "@/components/layout/nav";
import {
  evaluatePurchaseInvoice,
  evaluateSalesInvoice,
  summarize,
  type CatchupClientConfig,
  type CatchupRecord,
} from "@/lib/ledger-catchup";
import { filterReviewQueue, orderReviewQueue, reviewKey } from "@/lib/review-queue";

const CONFIG: CatchupClientConfig = {
  id: "c1",
  posting_locked_through: null,
  crediteuren_rekening_id: "cred",
  debiteuren_rekening_id: "deb",
  btw_te_vorderen_rekening_id: "btwv",
  btw_te_betalen_rekening_id: "btwb",
};
/** De blokkadestand kon niet worden gelezen: het enige wat `onbekend` oplevert. */
const CONFIG_ONBEKEND: CatchupClientConfig = { ...CONFIG, posting_locked_through: undefined };
const REGELS = { count: 1, sumExcl: 100, withoutAccount: 0, nonPositiveAmountCount: 0 };

const inkoop = (over: Record<string, unknown> = {}) => ({
  id: "pi-x", client_id: "c1", status: "gecontroleerd", invoice_date: "2026-03-01",
  invoice_number: "F-1", supplier: "Lev BV", amount_excl: 100, amount_incl: 121, btw_amount: 21, ...over,
});
const verkoop = (over: Record<string, unknown> = {}) => ({
  id: "si-x", client_id: "c1", status: "gecontroleerd", invoice_date: "2026-04-01", invoice_number: "V-1",
  customer_name: "Klant BV", amount_excl: 200, amount_incl: 242, btw_amount: 42, btw_verlegd: false,
  grootboekrekening_id: "omzet", ...over,
});

/** Echte uitkomsten van de beoordelingslaag — één per toestand, plus extra's. */
function records(): CatchupRecord[] {
  return [
    evaluatePurchaseInvoice({
      invoice: inkoop({ id: "pi-klaar", invoice_number: "MN-0912", supplier: "Meelhandel Noord", invoice_date: "2026-09-02" }),
      config: CONFIG, lines: REGELS, postingGroupId: null,
    }),
    evaluatePurchaseInvoice({
      invoice: inkoop({ id: "pi-blok", status: "te_controleren", invoice_number: "ED-778", supplier: "Energie Direct", invoice_date: "2026-08-28" }),
      config: CONFIG, lines: REGELS, postingGroupId: null,
    }),
    evaluatePurchaseInvoice({
      invoice: inkoop({ id: "pi-onbekend", invoice_number: "KPN-0918", supplier: "KPN Zakelijk", invoice_date: "2026-09-18" }),
      config: CONFIG_ONBEKEND, lines: REGELS, postingGroupId: null,
    }),
    evaluatePurchaseInvoice({
      invoice: inkoop({ id: "pi-geboekt", invoice_number: "VC-1180", supplier: "Verpakking & Co", invoice_date: "2026-07-21" }),
      config: CONFIG, lines: REGELS, postingGroupId: "pg-1180",
    }),
    evaluateSalesInvoice({
      invoice: verkoop({ id: "si-blok", invoice_number: "VF-0298", customer_name: "Hotel De Linde", btw_verlegd: true, btw_amount: 0, amount_incl: 200 }),
      config: CONFIG, postingGroupId: null,
    }),
    evaluateSalesInvoice({
      invoice: verkoop({ id: "si-klaar", invoice_number: "VF-0311", customer_name: "Cafe Het Plein", invoice_date: "2026-06-15" }),
      config: CONFIG, postingGroupId: null,
    }),
  ];
}

function laad(rs: CatchupRecord[] = records()) {
  state.data = {
    records: rs,
    purchase: summarize(rs.filter((r) => r.source === "inkoop")),
    sales: summarize(rs.filter((r) => r.source === "verkoop")),
  };
}

const renderReview = () =>
  render(
    <MemoryRouter initialEntries={["/review"]}>
      <Review />
    </MemoryRouter>,
  );

const tabel = () => screen.getByTestId("review-table");
const rijen = () => within(tabel()).getAllByRole("row").filter((r) => r.hasAttribute("data-review-state"));
const paneel = () => screen.getByTestId("review-detail");
const geselecteerd = () => rijen().filter((r) => r.getAttribute("aria-selected") === "true").map((r) => r.getAttribute("data-testid"));
const record = (id: string) => records().find((r) => r.id === id)!;
const kies = (id: string) => {
  const r = record(id);
  fireEvent.click(within(screen.getByTestId(`review-row-${reviewKey(r)}`)).getByRole("button", { name: `${r.description} — ${r.reference}` }));
};
const zoek = (waarde: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Zoeken in de wachtrij" }), { target: { value: waarde } });

beforeEach(() => {
  supabaseCalls.length = 0;
  hookCalls.length = 0;
  state.clientId = "c1";
  state.isPending = false;
  state.isError = false;
  state.error = null;
  state.refetch = vi.fn();
  laad();
});

describe("Review — de echte toestanden en tellers", () => {
  it("1. de vier tellers tonen exact de telling van de beoordelingslaag", () => {
    renderReview();
    expect(screen.getByRole("heading", { level: 1, name: "Review" })).toBeInTheDocument();
    const telling = summarize(records());
    // Het voorbeeld dekt alle vier de toestanden.
    expect(Math.min(telling.klaar, telling.geblokkeerd, telling.onbekend, telling.geboekt)).toBeGreaterThan(0);
    expect(screen.getByTestId("review-counter-klaar")).toHaveTextContent(`Klaar${telling.klaar}`);
    expect(screen.getByTestId("review-counter-geblokkeerd")).toHaveTextContent(`Geblokkeerd${telling.geblokkeerd}`);
    expect(screen.getByTestId("review-counter-onbekend")).toHaveTextContent(`Niet te bepalen${telling.onbekend}`);
    expect(screen.getByTestId("review-counter-geboekt")).toHaveTextContent(`Geboekt${telling.geboekt}`);
    expect(rijen()).toHaveLength(records().length);
  });

  it("2. elke rij draagt de toestand van de laag zelf, met icoon én tekst", () => {
    renderReview();
    for (const r of records()) {
      const rij = screen.getByTestId(`review-row-${reviewKey(r)}`);
      expect(rij).toHaveAttribute("data-review-state", r.state);
      const chip = rij.querySelector(`[data-state="${r.state}"]`)!;
      expect(chip).not.toBeNull();
      expect(chip.querySelector("svg")).not.toBeNull();
    }
  });

  it("3. elke statusteller filtert op precies die toestand", () => {
    renderReview();
    for (const s of ["klaar", "geblokkeerd", "onbekend", "geboekt"] as const) {
      fireEvent.click(screen.getByTestId(`review-counter-${s}`));
      expect(screen.getByTestId(`review-counter-${s}`)).toHaveAttribute("aria-pressed", "true");
      const verwacht = records().filter((r) => r.state === s).length;
      expect(rijen()).toHaveLength(verwacht);
      for (const rij of rijen()) expect(rij).toHaveAttribute("data-review-state", s);
      fireEvent.click(screen.getByTestId(`review-counter-${s}`));
    }
    expect(rijen()).toHaveLength(records().length);
  });

  it("4. de soortfilter telt en filtert echte inkoop en verkoop", () => {
    renderReview();
    const filters = screen.getByTestId("review-source-filters");
    expect(within(filters).getByRole("button", { name: /Inkoop/ })).toHaveTextContent("Inkoop4");
    expect(within(filters).getByRole("button", { name: /Verkoop/ })).toHaveTextContent("Verkoop2");
    fireEvent.click(within(filters).getByRole("button", { name: /Verkoop/ }));
    expect(rijen()).toHaveLength(2);
  });

  it("5. de hook krijgt de gekozen administratie en het gekozen jaar", () => {
    renderReview();
    expect(hookCalls.at(-1)).toEqual({ clientId: "c1", year: null });
    fireEvent.click(within(screen.getByTestId("review-year-filters")).getByRole("button", { name: "2026" }));
    expect(hookCalls.at(-1)).toEqual({ clientId: "c1", year: 2026 });
  });
});

describe("Review — onbekend is geen geblokkeerd", () => {
  it("6. onbekend heeft een eigen teller, label en waarschuwing — nooit een blokkade", () => {
    renderReview();
    const onbekend = record("pi-onbekend");
    expect(onbekend.state).toBe("onbekend");
    expect(screen.getByTestId("review-counter-onbekend")).toHaveTextContent("1");
    // Telt NIET mee bij geblokkeerd.
    expect(screen.getByTestId("review-counter-geblokkeerd")).toHaveTextContent(
      String(records().filter((r) => r.state === "geblokkeerd").length),
    );

    kies("pi-onbekend");
    const notice = within(paneel()).getByTestId("review-state-notice");
    expect(notice).toHaveAttribute("data-severity", "warning");
    expect(notice).toHaveTextContent("Niet te bepalen");
    expect(notice).toHaveTextContent("wordt ook niet aangeboden om te boeken");
    expect(notice).not.toHaveTextContent("Geblokkeerd");
    expect(within(paneel()).getByText(onbekend.blocks[0].label)).toHaveAttribute("data-block-code", "boekingsblokkade_onbekend");
  });

  it("7. een concreet beletsel naast een onbekende blokkade blijft geblokkeerd (precedentie van de laag)", () => {
    const gemengd = evaluatePurchaseInvoice({
      invoice: inkoop({ id: "pi-gemengd", status: "te_controleren", supplier: "Gemengd BV", invoice_number: "G-1" }),
      config: CONFIG_ONBEKEND, lines: REGELS, postingGroupId: null,
    });
    expect(gemengd.state).toBe("geblokkeerd");
    laad([gemengd]);
    renderReview();
    expect(screen.getByTestId("review-counter-geblokkeerd")).toHaveTextContent("1");
    expect(screen.getByTestId("review-counter-onbekend")).toHaveTextContent("0");
    const notice = within(paneel()).getByTestId("review-state-notice");
    expect(notice).toHaveAttribute("data-severity", "blocking");
    // Beide redenen blijven zichtbaar.
    expect(notice.querySelectorAll("[data-block-code]")).toHaveLength(gemengd.blocks.length);
  });

  it("8. de detailweergave per toestand: klaar, geblokkeerd met redenen, geboekt met boekingsgroep", () => {
    renderReview();
    kies("pi-klaar");
    expect(within(paneel()).getByTestId("review-state-notice")).toHaveAttribute("data-severity", "info");
    expect(within(paneel()).queryByTestId("review-blocks")).toBeNull();

    kies("pi-blok");
    const blok = within(paneel()).getByTestId("review-state-notice");
    expect(blok).toHaveAttribute("data-severity", "blocking");
    for (const b of record("pi-blok").blocks) expect(blok).toHaveTextContent(b.label);

    kies("pi-geboekt");
    expect(within(paneel()).getByTestId("review-posting-group")).toHaveTextContent("pg-1180");
    expect(within(paneel()).getByTestId("review-source")).toHaveTextContent("gecontroleerd");
  });

  it("9. de bronlink gebruikt de bestaande bronroute", () => {
    renderReview();
    kies("pi-klaar");
    expect(within(paneel()).getByTestId("review-source-link")).toHaveAttribute("href", "/facturen/inkoop/pi-klaar");
    kies("si-klaar");
    expect(within(paneel()).getByTestId("review-source-link")).toHaveAttribute("href", "/verkoop");
  });
});

describe("Review — het paneel volgt de gefilterde wachtrij", () => {
  it("10. statusfilter: een weggefilterde selectie wijkt voor het eerste zichtbare document", () => {
    renderReview();
    kies("pi-klaar");
    expect(paneel()).toHaveTextContent("Meelhandel Noord");

    fireEvent.click(screen.getByTestId("review-counter-geblokkeerd"));
    const eerste = filterReviewQueue(orderReviewQueue(records()), { search: "", state: "geblokkeerd", source: null })[0];
    expect(paneel()).toHaveTextContent(eerste.description);
    expect(paneel()).not.toHaveTextContent("Meelhandel Noord");
    expect(geselecteerd()).toEqual([`review-row-${reviewKey(eerste)}`]);
  });

  it("11. zoeken: een weggefilterde selectie wijkt; geen treffers geeft een leeg paneel", () => {
    renderReview();
    kies("pi-klaar");
    zoek("Energie");
    expect(paneel()).toHaveTextContent("Energie Direct");
    expect(paneel()).not.toHaveTextContent("Meelhandel Noord");
    expect(geselecteerd()).toEqual([`review-row-${reviewKey(record("pi-blok"))}`]);

    zoek("bestaat-niet-xyz");
    expect(screen.getByTestId("review-no-match")).toBeInTheDocument();
    expect(paneel()).toHaveTextContent("Kies een document om de details te bekijken.");
    expect(within(paneel()).queryByTestId("review-state-notice")).toBeNull();
  });

  it("12. soortfilter in combinatie met zoeken laat nooit een verouderd document staan", () => {
    renderReview();
    kies("pi-onbekend");
    fireEvent.click(within(screen.getByTestId("review-source-filters")).getByRole("button", { name: /Verkoop/ }));
    expect(paneel()).not.toHaveTextContent("KPN Zakelijk");
    zoek("Plein");
    expect(paneel()).toHaveTextContent("Cafe Het Plein");
    expect(geselecteerd()).toEqual([`review-row-${reviewKey(record("si-klaar"))}`]);
  });

  it("13. nieuwe data (ander jaar of andere administratie) zonder het gekozen document: geen verouderd paneel", () => {
    const { rerender } = renderReview();
    kies("pi-onbekend");
    expect(paneel()).toHaveTextContent("KPN Zakelijk");
    laad(records().filter((r) => r.id !== "pi-onbekend"));
    rerender(
      <MemoryRouter initialEntries={["/review"]}>
        <Review />
      </MemoryRouter>,
    );
    expect(paneel()).not.toHaveTextContent("KPN Zakelijk");
    expect(geselecteerd()).toHaveLength(1);
  });
});

describe("Review — lege, ladende en foutieve wachtrij", () => {
  it("14. een echte lege wachtrij toont de lege staat, geen tabel en geen tellers", () => {
    laad([]);
    renderReview();
    expect(screen.getByTestId("review-empty")).toHaveTextContent(REVIEW_EMPTY_MESSAGE);
    expect(screen.queryByTestId("review-table")).toBeNull();
    expect(screen.queryByTestId("review-counter-klaar")).toBeNull();
  });

  it("15. zonder specifieke administratie: banner, en de hook krijgt geen administratie", () => {
    state.clientId = "all";
    renderReview();
    expect(screen.getByText("Kies eerst een specifieke administratie om de wachtrij te bekijken.")).toBeInTheDocument();
    expect(screen.queryByTestId("review-table")).toBeNull();
    expect(hookCalls.at(-1)?.clientId).toBeUndefined();
  });

  it("16. laden en laadfout zijn aparte toestanden; opnieuw proberen is alleen een lezing", () => {
    state.isPending = true;
    const { unmount } = renderReview();
    expect(screen.getByText("Wachtrij laden…")).toBeInTheDocument();
    unmount();

    state.isPending = false;
    state.isError = true;
    state.error = { message: "permission denied" };
    renderReview();
    expect(screen.getByTestId("review-error")).toHaveTextContent("permission denied");
    fireEvent.click(screen.getByRole("button", { name: "Opnieuw proberen" }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("review-table")).toBeNull();
  });
});

describe("Review — alleen lezen", () => {
  const strip = (pad: string) =>
    readFileSync(resolve(process.cwd(), pad), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((r) => !r.trimStart().startsWith("//"))
      .join("\n");

  it("17. geen schrijfhook, mutatie, RPC, databaseclient of schrijfmethode in pagina en filterlaag", () => {
    for (const pad of ["src/pages/Review.tsx", "src/lib/review-queue.ts"]) {
      const bron = strip(pad);
      expect(bron, pad).not.toMatch(/integrations\/supabase|supabase\./);
      expect(bron, pad).not.toMatch(/useMutation|mutateAsync|\.mutate\(|useRunLedgerCatchup|usePost[A-Z]/);
      expect(bron, pad).not.toMatch(/\.rpc\(|\.from\(\s*["\x27`]|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\bfetch\(/);
      expect(bron, pad).not.toMatch(/postableRecords|catchupRunOrder/);
    }
    // De enige datahooks: de catch-up-leeshook en de bestaande context/lijsten.
    const hooks = [...strip("src/pages/Review.tsx").matchAll(/from "@\/hooks\/([^"]+)"/g)].map((m) => m[1]).sort();
    expect(hooks).toEqual(["useActiveOrganization", "useClientContext", "useClients", "useLedgerCatchup"]);
    expect(strip("src/pages/Review.tsx")).toMatch(/import \{ useLedgerCatchup \} from "@\/hooks\/useLedgerCatchup"/);
  });

  it("18. geen boek-, goedkeur- of voorbeeldacties en geen voorbeelddata meer", () => {
    renderReview();
    // "Geboekt" (de teller) is een toestand, geen actie; daarom op het woord "boek(en)".
    for (const naam of [/\bboek(en)?\b/i, /goedkeur/i, /terugzet/i, /verwerk/i]) {
      expect(screen.queryByRole("button", { name: naam })).toBeNull();
    }
    expect(screen.queryByText(/Voorbeelddata|Voorbeeld — geen boeking/)).toBeNull();
    expect(paneel()).toHaveTextContent(REVIEW_READ_ONLY_NOTE);
    // Selecteren, zoeken en filteren raken de database niet.
    kies("pi-blok");
    zoek("KPN");
    fireEvent.click(screen.getByTestId("review-counter-onbekend"));
    expect(supabaseCalls).toEqual([]);
  });

  it("19. op kleine schermen staat het paneel onder de tabel, op grote ernaast", () => {
    renderReview();
    const grid = tabel().closest(".grid")!;
    expect(grid.className).toMatch(/xl:grid-cols-\[minmax\(0,1fr\)_\d+px\]/);
    expect(grid.className).not.toMatch(/(^|\s)grid-cols-/);
    expect(Array.from(grid.children)[1]).toBe(paneel());
  });

  it("20. /review bestaat als route en als nav-item, en is actief op die route", () => {
    expect(readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8")).toContain(
      '<Route path="/review" element={<Review />} />',
    );
    const item = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.url === "/review");
    expect(item?.title).toBe("Review");
    expect(pageTitleForPath("/review")).toBe("Review");

    render(
      <MemoryRouter initialEntries={["/review"]}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /Review/ })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("link", { name: /Dashboard/ })).toHaveAttribute("data-active", "false");
  });
});
