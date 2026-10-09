import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Administratie-gereedheid (/klanten/:clientId/gereedheid) — alleen lezen.
 *
 * De datahooks zijn gemockt; wat ze teruggeven komt uit de ÉCHTE modellen
 * (`computeLedgerCompleteness`, `computeOpeningBalanceCompleteness`,
 * `evaluate*Invoice`, `computeClientReadiness`). De Supabase-client is een
 * spion die bij elke aanraking faalt.
 */

const { supabaseCalls, calls } = vi.hoisted(() => ({
  supabaseCalls: [] as string[],
  calls: {
    catchup: [] as Array<{ clientId: string | undefined; year: number | null }>,
    opening: [] as Array<{ clientId: string | undefined; period: { from: string; toExclusive: string } }>,
    completeness: [] as Array<string | undefined>,
    bank: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: new Proxy(
    {},
    {
      get: (_t, prop) => {
        supabaseCalls.push(String(prop));
        return () => {
          throw new Error(`Gereedheid raakte supabase.${String(prop)} aan`);
        };
      },
    },
  ),
}));

type Q = { data?: unknown; isPending: boolean; isError: boolean; error?: unknown; refetch: () => void };
const ok = (data: unknown): Q => ({ data, isPending: false, isError: false, error: null, refetch: vi.fn() });
const fout = (message = "permission denied"): Q => ({ data: undefined, isPending: false, isError: true, error: { message }, refetch: vi.fn() });
const laden = (): Q => ({ data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() });

const state = {
  clients: ok([]) as Q,
  accounts: ok([]) as Q,
  completeness: ok(undefined) as Q,
  opening: { data: undefined as unknown, isPending: false, isError: false },
  catchup: ok(undefined) as Q,
  bankNewest: ok({ transactions: [], total: 0 }) as Q,
  bankOldest: ok({ transactions: [], total: 0 }) as Q,
};

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({ useClients: () => state.clients }));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({ useGrootboekrekeningen: () => state.accounts }));
vi.mock("@/hooks/useLedgerCompleteness", () => ({
  useLedgerCompleteness: (clientId: string | undefined) => {
    calls.completeness.push(clientId);
    return state.completeness;
  },
  useOpeningBalanceCompleteness: (clientId: string | undefined, period: { from: string; toExclusive: string }) => {
    calls.opening.push({ clientId, period });
    return state.opening;
  },
}));
vi.mock("@/hooks/useLedgerCatchup", () => ({
  useLedgerCatchup: (clientId: string | undefined, period: { year: number | null }) => {
    calls.catchup.push({ clientId, year: period.year });
    return state.catchup;
  },
  useRunLedgerCatchup: () => {
    throw new Error("Gereedheid mag useRunLedgerCatchup niet gebruiken");
  },
}));
vi.mock("@/hooks/useBankTransactions", () => ({
  usePaginatedBankTransactions: (opts: Record<string, unknown>) => {
    calls.bank.push(opts);
    return opts.sortDir === "asc" ? state.bankOldest : state.bankNewest;
  },
}));

import KlantGereedheid, { READINESS_NO_VERDICT_NOTE } from "@/pages/KlantGereedheid";
import { NAV_SECTIONS, pageTitleForPath } from "@/components/layout/nav";
import { computeClientReadiness } from "@/lib/client-readiness";
import {
  computeLedgerCompleteness,
  computeOpeningBalanceCompleteness,
  unknownOpeningBalanceCompleteness,
} from "@/lib/ledger-completeness";
import {
  evaluatePurchaseInvoice,
  summarize,
  type CatchupClientConfig,
  type CatchupRecord,
} from "@/lib/ledger-catchup";
import {
  bankRow,
  beginbalansRow,
  historischRow,
  instellingenRow,
  rekeningschemaRow,
  volledigheidRow,
} from "@/lib/client-readiness-overview";

const YEAR = new Date().getFullYear();

const CLIENT = {
  id: "c-1", name: "Bakkerij Van Dijk", organization_id: "org-1", ibans: ["NL91ABNA0417164300", "NL02RABO0123456789"],
  bank_dagboek: 1100, inkoop_dagboek: 700, verkoop_dagboek: 800,
  debiteuren_rekening_id: "gb-1300", crediteuren_rekening_id: "gb-1600",
  btw_te_vorderen_rekening_id: "gb-1520", btw_te_betalen_rekening_id: null, bank_rekening_id: null,
};
const ACCOUNTS = [
  { id: "gb-1100", nummer: 1100, omschrijving: "Bank", client_id: null, actief: true },
  { id: "gb-1300", nummer: 1300, omschrijving: "Debiteuren", client_id: null, actief: true },
  { id: "gb-1600", nummer: 1600, omschrijving: "Crediteuren", client_id: null, actief: true },
  { id: "gb-4999", nummer: 4999, omschrijving: "Oud", client_id: null, actief: false },
  // Van een andere administratie: hoort NIET mee te tellen.
  { id: "gb-x", nummer: 1101, omschrijving: "Bank andere klant", client_id: "c-2", actief: true },
];

const COMPLETENESS = computeLedgerCompleteness({
  purchase: { eligible: 5, posted: 3 },
  sales: { eligible: 2, posted: 2, refusedVerlegd: 1 },
  bank: { eligible: 0, posted: 0, awaitingInvoice: 2 },
  manual: { total: 0, posted: 0 },
});

const OPENING_NOT_SET = computeOpeningBalanceCompleteness({ headers: [], marker: null, year: YEAR });

const CONFIG: CatchupClientConfig = {
  id: "c-1", posting_locked_through: null, crediteuren_rekening_id: "cred", debiteuren_rekening_id: "deb",
  btw_te_vorderen_rekening_id: "btwv", btw_te_betalen_rekening_id: "btwb",
};
const REGELS = { count: 1, sumExcl: 100, withoutAccount: 0, nonPositiveAmountCount: 0 };
const factuur = (id: string, over: Record<string, unknown> = {}) => ({
  id, client_id: "c-1", status: "gecontroleerd", invoice_date: `${YEAR}-03-01`, invoice_number: id,
  supplier: "Lev", amount_excl: 100, amount_incl: 121, btw_amount: 21, ...over,
});
const klaar = (id: string) => evaluatePurchaseInvoice({ invoice: factuur(id), config: CONFIG, lines: REGELS, postingGroupId: null });
const geblokkeerd = (id: string) =>
  evaluatePurchaseInvoice({ invoice: factuur(id, { status: "te_controleren" }), config: CONFIG, lines: REGELS, postingGroupId: null });
const onbekend = (id: string) =>
  evaluatePurchaseInvoice({ invoice: factuur(id), config: { ...CONFIG, posting_locked_through: undefined }, lines: REGELS, postingGroupId: null });
const geboekt = (id: string) => evaluatePurchaseInvoice({ invoice: factuur(id), config: CONFIG, lines: REGELS, postingGroupId: `pg-${id}` });
const catchupData = (records: CatchupRecord[]) => ({ records, purchase: summarize(records), sales: summarize([]) });

function renderPage(path = "/klanten/c-1/gereedheid") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/klanten/:clientId/gereedheid" element={<KlantGereedheid />} />
      </Routes>
    </MemoryRouter>,
  );
}

const rij = (key: string) => screen.getByTestId(`readiness-row-${key}`);

beforeEach(() => {
  supabaseCalls.length = 0;
  calls.catchup.length = 0;
  calls.opening.length = 0;
  calls.completeness.length = 0;
  calls.bank.length = 0;
  state.clients = ok([CLIENT, { ...CLIENT, id: "c-2", name: "Andere klant" }]);
  state.accounts = ok(ACCOUNTS);
  state.completeness = ok(COMPLETENESS);
  state.opening = { data: OPENING_NOT_SET, isPending: false, isError: false };
  state.catchup = ok(catchupData([klaar("a"), geblokkeerd("b"), geboekt("c")]));
  state.bankNewest = ok({ transactions: [{ transaction_date: `${YEAR}-09-25` }], total: 214 });
  state.bankOldest = ok({ transactions: [{ transaction_date: `${YEAR}-01-02` }], total: 214 });
});

describe("Gereedheid — alleen bewijs uit bestaande modellen", () => {
  it("1. kop met administratienaam, terugweg en zes bewijsregels; geen totaaloordeel", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Bakkerij Van Dijk" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Naar Administraties/ })).toHaveAttribute("href", "/klanten");
    for (const key of ["rekeningschema", "instellingen", "beginbalans", "volledigheid", "historisch", "bank"]) {
      expect(rij(key)).toBeInTheDocument();
    }
    expect(screen.getByTestId("readiness-no-verdict")).toHaveTextContent(READINESS_NO_VERDICT_NOTE);
    expect(screen.queryByText(/Administratie is gereed/i)).toBeNull();
  });

  it("2. rekeningschema telt alleen rekeningen binnen de administratiegrens", () => {
    renderPage();
    expect(rij("rekeningschema")).toHaveAttribute("data-status", "in_orde");
    expect(rij("rekeningschema")).toHaveTextContent("4 grootboekrekeningen beschikbaar voor deze administratie, waarvan 3 actief.");
  });

  it("3. grootboekinstellingen tonen exact de ontbrekende velden van computeClientReadiness", () => {
    renderPage();
    const verwacht = computeClientReadiness(CLIENT as never, [], [], [], [], ACCOUNTS as never).configMissingReasons;
    expect(verwacht.length).toBeGreaterThan(0);
    expect(rij("instellingen")).toHaveAttribute("data-status", "aandacht");
    const details = within(rij("instellingen")).getByTestId("readiness-details-instellingen");
    expect(within(details).getAllByRole("listitem").map((li) => li.textContent)).toEqual(verwacht);
  });

  it("4. volledigheid en beginbalans volgen hun model letterlijk", () => {
    renderPage();
    expect(rij("volledigheid")).toHaveAttribute("data-status", "aandacht");
    const regels = within(within(rij("volledigheid")).getByTestId("readiness-details-volledigheid")).getAllByRole("listitem");
    expect(regels).toHaveLength(COMPLETENESS.sources.length);
    expect(regels[0]).toHaveTextContent("Inkoopfacturen: 3 van 5 geboekt — onvolledig");
    expect(regels[1]).toHaveTextContent("1 geweigerd (BTW verlegd)");
    expect(rij("beginbalans")).toHaveAttribute("data-status", "aandacht");
    expect(rij("beginbalans")).toHaveTextContent(`Niet ingesteld (boekjaar ${YEAR}).`);
    expect(rij("beginbalans")).toHaveTextContent(OPENING_NOT_SET.note!);
  });

  it("5. historische boekingen tonen de telling van summarize()", () => {
    renderPage();
    const s = summarize([klaar("a"), geblokkeerd("b"), geboekt("c")]);
    const details = within(rij("historisch")).getByTestId("readiness-details-historisch");
    expect(details).toHaveTextContent(`Klaar om te boeken: ${s.klaar}`);
    expect(details).toHaveTextContent(`Geblokkeerd: ${s.geblokkeerd}`);
    expect(details).toHaveTextContent(`Niet te bepalen: ${s.onbekend}`);
    expect(details).toHaveTextContent(`Geboekt: ${s.geboekt}`);
  });

  it("6. bank is altijd informatief en toont alleen wat er ligt", () => {
    renderPage();
    expect(rij("bank")).toHaveAttribute("data-status", "informatief");
    expect(rij("bank")).toHaveTextContent(`214 banktransacties geïmporteerd, van 02-01-${YEAR} t/m 25-09-${YEAR}.`);
    expect(rij("bank")).toHaveTextContent("NL91ABNA0417164300, NL02RABO0123456789");
    expect(rij("bank")).toHaveTextContent("Of elke rekening volledig is ingelezen, is uit de bestaande gegevens niet af te leiden.");
  });

  it("7. het boekjaar gaat naar beginbalans en catch-up; volledigheid en bank blijven administratiebreed", () => {
    renderPage();
    expect(calls.catchup.at(-1)).toEqual({ clientId: "c-1", year: YEAR });
    expect(calls.opening.at(-1)?.period).toEqual({ from: `${YEAR}-01-01`, toExclusive: `${YEAR + 1}-01-01` });
    fireEvent.click(within(screen.getByTestId("readiness-year-filters")).getByRole("button", { name: String(YEAR - 1) }));
    expect(calls.catchup.at(-1)).toEqual({ clientId: "c-1", year: YEAR - 1 });
    expect(calls.opening.at(-1)?.period).toEqual({ from: `${YEAR - 1}-01-01`, toExclusive: `${YEAR}-01-01` });
    expect(calls.completeness.at(-1)).toBe("c-1");
    expect(calls.bank.at(-1)).toMatchObject({ clientId: "c-1", page: 1, pageSize: 1 });
  });
});

describe("Gereedheid — geblokkeerd is niet hetzelfde als niet te bepalen", () => {
  it("8. alleen onbekende facturen → Niet te bepalen, nooit Geblokkeerd", () => {
    state.catchup = ok(catchupData([onbekend("a"), geboekt("b")]));
    renderPage();
    expect(rij("historisch")).toHaveAttribute("data-status", "niet_te_bepalen");
    expect(within(rij("historisch")).getByText("Niet te bepalen", { selector: "span" })).toBeInTheDocument();
    expect(within(rij("historisch")).queryByText("Geblokkeerd", { selector: "span" })).toBeNull();
  });

  it("9. een concreet beletsel wint, maar de onbekende telling blijft apart zichtbaar", () => {
    state.catchup = ok(catchupData([onbekend("a"), geblokkeerd("b")]));
    renderPage();
    expect(rij("historisch")).toHaveAttribute("data-status", "geblokkeerd");
    const details = within(rij("historisch")).getByTestId("readiness-details-historisch");
    expect(details).toHaveTextContent("Geblokkeerd: 1");
    expect(details).toHaveTextContent("Niet te bepalen: 1");
  });

  it("10. de pure regel: elke combinatie geeft de verwachte toestand", () => {
    const s = (over: Partial<ReturnType<typeof summarize>>) => ({ totaal: 1, geboekt: 0, klaar: 0, geblokkeerd: 0, onbekend: 0, ...over });
    expect(historischRow({ kind: "ok", value: s({ geblokkeerd: 1 }) }, "x").status).toBe("geblokkeerd");
    expect(historischRow({ kind: "ok", value: s({ onbekend: 1 }) }, "x").status).toBe("niet_te_bepalen");
    expect(historischRow({ kind: "ok", value: s({ klaar: 1 }) }, "x").status).toBe("aandacht");
    expect(historischRow({ kind: "ok", value: s({ geboekt: 1 }) }, "x").status).toBe("in_orde");
    expect(historischRow({ kind: "ok", value: s({ totaal: 0 }) }, "x").status).toBe("informatief");
  });
});

describe("Gereedheid — een mislukte bron wordt nooit In orde", () => {
  it.each([
    ["rekeningschema", () => { state.accounts = fout(); }],
    ["instellingen", () => { state.accounts = fout(); }],
    ["volledigheid", () => { state.completeness = fout(); }],
    ["historisch", () => { state.catchup = fout(); }],
    ["bank", () => { state.bankOldest = fout(); }],
  ])("11. %s: leesfout → Niet te bepalen met Opnieuw proberen", (key, breek) => {
    breek();
    renderPage();
    expect(rij(key)).toHaveAttribute("data-status", "niet_te_bepalen");
    expect(rij(key)).toHaveTextContent("De gegevens konden niet worden gelezen");
    expect(within(rij(key)).getByRole("button", { name: "Opnieuw proberen" })).toBeInTheDocument();
  });

  it("12. beginbalans: leesfout of 'onbekend' uit het model → Niet te bepalen", () => {
    state.opening = { data: unknownOpeningBalanceCompleteness(YEAR), isPending: false, isError: true };
    renderPage();
    expect(rij("beginbalans")).toHaveAttribute("data-status", "niet_te_bepalen");
    expect(beginbalansRow({ kind: "ok", value: unknownOpeningBalanceCompleteness(YEAR) }).status).toBe("niet_te_bepalen");
  });

  it("13. een opnieuw-proberen-klik is alleen een lezing (refetch)", () => {
    state.catchup = fout();
    renderPage();
    fireEvent.click(within(rij("historisch")).getByRole("button", { name: "Opnieuw proberen" }));
    expect(state.catchup.refetch).toHaveBeenCalledTimes(1);
  });

  it("14. aan het laden is nooit In orde", () => {
    state.accounts = laden();
    state.completeness = laden();
    state.catchup = laden();
    state.bankNewest = laden();
    state.opening = { data: undefined, isPending: true, isError: false };
    renderPage();
    for (const key of ["rekeningschema", "instellingen", "beginbalans", "volledigheid", "historisch", "bank"]) {
      expect(rij(key)).toHaveAttribute("data-status", "laden");
    }
  });

  it("15. de pure laag: geen enkele bron kan bij een fout of tijdens laden 'in_orde' opleveren", () => {
    const failed = { kind: "error" as const };
    const loading = { kind: "loading" as const };
    for (const read of [failed, loading]) {
      for (const row of [
        rekeningschemaRow(read, "c-1"),
        instellingenRow(read),
        beginbalansRow(read),
        volledigheidRow(read),
        historischRow(read, "x"),
        bankRow(read),
      ]) {
        expect(row.status, row.key).not.toBe("in_orde");
      }
    }
  });

  it("16. een onbekende bron in de volledigheid maakt de hele regel Niet te bepalen", () => {
    const metOnbekend = computeLedgerCompleteness({
      purchase: { eligible: 1, posted: 2 }, // geboekt > postbaar: het model zegt 'unknown'
      sales: { eligible: 0, posted: 0, refusedVerlegd: 0 },
      bank: { eligible: 0, posted: 0, awaitingInvoice: 0 },
      manual: { total: 0, posted: 0 },
    });
    expect(volledigheidRow({ kind: "ok", value: metOnbekend }).status).toBe("niet_te_bepalen");
    const leeg = computeLedgerCompleteness({
      purchase: { eligible: 0, posted: 0 },
      sales: { eligible: 0, posted: 0, refusedVerlegd: 0 },
      bank: { eligible: 0, posted: 0, awaitingInvoice: 0 },
      manual: { total: 0, posted: 0 },
    });
    expect(volledigheidRow({ kind: "ok", value: leeg }).status).toBe("informatief");
  });
});

describe("Gereedheid — lege toestanden", () => {
  it("17. geen rekeningen → Geblokkeerd; geen banktransacties en geen facturen → feitelijk informatief", () => {
    state.accounts = ok([]);
    state.catchup = ok(catchupData([]));
    state.bankNewest = ok({ transactions: [], total: 0 });
    state.bankOldest = ok({ transactions: [], total: 0 });
    state.clients = ok([{ ...CLIENT, ibans: [] }]);
    renderPage();
    expect(rij("rekeningschema")).toHaveAttribute("data-status", "geblokkeerd");
    expect(rij("historisch")).toHaveAttribute("data-status", "informatief");
    expect(rij("historisch")).toHaveTextContent(`Geen inkoop- of verkoopfacturen in boekjaar ${YEAR}.`);
    expect(rij("bank")).toHaveTextContent("Nog geen banktransacties geïmporteerd.");
    expect(rij("bank")).toHaveTextContent("Geen IBAN vastgelegd bij deze administratie.");
  });

  it("18. onbekende administratie: melding en geen enkele lezing met een administratie-id", () => {
    renderPage("/klanten/bestaat-niet/gereedheid");
    expect(screen.getByTestId("readiness-client-missing")).toHaveTextContent("Deze administratie bestaat niet in de actieve organisatie.");
    expect(calls.catchup.every((c) => c.clientId === undefined)).toBe(true);
    expect(calls.completeness.every((c) => c === undefined)).toBe(true);
    expect(calls.bank.every((c) => c.clientId === undefined && c.enabled === false)).toBe(true);
  });

  it("19. administraties niet leesbaar → geen bewijsregels, eerlijk niet te bepalen", () => {
    state.clients = fout();
    renderPage();
    expect(screen.getByTestId("readiness-client-missing")).toHaveTextContent("de gereedheid is niet te bepalen");
    expect(screen.queryByTestId("readiness-row-rekeningschema")).toBeNull();
  });
});

describe("Gereedheid — links en ingang", () => {
  it("20. elke regel linkt naar het bestaande bronscherm", () => {
    renderPage();
    const hrefs = (key: string) => within(rij(key)).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs("rekeningschema")).toEqual(["/grootboek"]);
    expect(hrefs("instellingen")).toEqual(["/klanten"]);
    expect(hrefs("beginbalans")).toEqual(["/grootboek/beginbalans"]);
    expect(hrefs("volledigheid")).toEqual(["/grootboek/saldi"]);
    expect(hrefs("historisch")).toEqual(["/review", "/grootboek/historisch"]);
    expect(hrefs("bank")).toEqual(["/bank"]);
    // Al die bestemmingen bestaan als route.
    const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    for (const pad of ["/grootboek", "/klanten", "/grootboek/beginbalans", "/grootboek/saldi", "/review", "/grootboek/historisch", "/bank"]) {
      expect(app, pad).toContain(`path="${pad}"`);
    }
  });

  it("21. route onder Administraties, geen nieuw nav-item; Klanten linkt ernaar", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    expect(app).toContain('<Route path="/klanten/:clientId/gereedheid" element={<KlantGereedheid />} />');
    expect(NAV_SECTIONS.flatMap((s) => s.items).some((i) => i.url.includes("gereedheid"))).toBe(false);
    expect(pageTitleForPath("/klanten/c-1/gereedheid")).toBe("Administraties");
    const klanten = readFileSync(resolve(process.cwd(), "src/pages/Klanten.tsx"), "utf8");
    expect(klanten.match(/to=\{`\/klanten\/\$\{(client\.id|editingId)\}\/gereedheid`\}/g)).toHaveLength(3);
  });
});

describe("Gereedheid — alleen lezen", () => {
  const strip = (pad: string) =>
    readFileSync(resolve(process.cwd(), pad), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((r) => !r.trimStart().startsWith("//"))
      .join("\n");

  it("22. geen schrijfhook, mutatie, RPC of databaseclient in pagina en afleidingslaag", () => {
    for (const pad of ["src/pages/KlantGereedheid.tsx", "src/lib/client-readiness-overview.ts"]) {
      const bron = strip(pad);
      expect(bron, pad).not.toMatch(/integrations\/supabase\/client|supabase\./);
      expect(bron, pad).not.toMatch(/useMutation|mutateAsync|\.mutate\(|useRunLedgerCatchup|usePost[A-Z]|useAdd[A-Z]|useUpdate[A-Z]|useDelete[A-Z]|useSeed[A-Z]/);
      expect(bron, pad).not.toMatch(/\.rpc\(|\.from\(\s*["'`]|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\bfetch\(/);
    }
    const hooks = [...strip("src/pages/KlantGereedheid.tsx").matchAll(/import \{([^}]+)\} from "@\/hooks\/[^"]+"/g)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim()))
      .sort();
    expect(hooks).toEqual([
      "useActiveOrganization",
      "useClients",
      "useGrootboekrekeningen",
      "useLedgerCatchup",
      "useLedgerCompleteness",
      "useOpeningBalanceCompleteness",
      "usePaginatedBankTransactions",
    ]);
  });

  it("23. op de pagina staat geen enkele actieknop buiten opnieuw proberen", () => {
    renderPage();
    const knoppen = screen.getAllByRole("button").map((b) => b.textContent?.trim());
    // Alleen de jaarchips; terug en de bronlinks zijn links.
    expect(knoppen.every((t) => /^\d{4}$/.test(t ?? ""))).toBe(true);
    expect(supabaseCalls).toEqual([]);
  });
});
