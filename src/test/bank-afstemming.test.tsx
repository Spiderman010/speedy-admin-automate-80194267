import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Bankafstemming-overzicht (/bank/afstemming) — alleen lezen.
 *
 * De datahooks zijn gemockt; het saldo komt uit de ÉCHTE rapportagekern
 * (`buildAccountReport`) over de gemockte grootboekregels. De Supabase-client is
 * een spion die bij elke aanraking faalt.
 */

const { supabaseCalls, calls } = vi.hoisted(() => ({
  supabaseCalls: [] as string[],
  calls: {
    clients: [] as Array<{ organizationId: string | undefined; enabled: boolean | undefined }>,
    accounts: [] as Array<Record<string, unknown>>,
    postings: [] as Array<Record<string, unknown>>,
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
          throw new Error(`Bankafstemming raakte supabase.${String(prop)} aan`);
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
  org: { activeOrganizationId: "org-1" as string | null, isReady: true },
  clients: ok([]) as Q,
  accounts: ok([]) as Q,
  postings: ok([]) as Q,
  bankNewest: ok({ transactions: [], total: 0 }) as Q,
  bankOldest: ok({ transactions: [], total: 0 }) as Q,
};

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/hooks/useActiveOrganization", () => ({ useActiveOrganization: () => state.org }));
vi.mock("@/hooks/useClients", () => ({
  useClients: (organizationId: string | undefined, enabled: boolean | undefined) => {
    calls.clients.push({ organizationId, enabled });
    return state.clients;
  },
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: (opts: Record<string, unknown>) => {
    calls.accounts.push(opts);
    return state.accounts;
  },
}));
vi.mock("@/hooks/useLedgerPostings", () => ({
  useLedgerPostings: (opts: Record<string, unknown>) => {
    calls.postings.push(opts);
    return state.postings;
  },
}));
vi.mock("@/hooks/useBankTransactions", () => ({
  usePaginatedBankTransactions: (opts: Record<string, unknown>) => {
    calls.bank.push(opts);
    return opts.sortDir === "asc" ? state.bankOldest : state.bankNewest;
  },
}));

import BankAfstemming, { BANK_OVERVIEW_READ_ONLY_NOTE } from "@/pages/BankAfstemming";
import { ClientProvider, useClientContext } from "@/hooks/useClientContext";
import { buildAccountReport } from "@/lib/ledger-reporting";
import { ALL_TIME_PERIOD } from "@/lib/grootboek-saldi-utils";
import { bankImportSection, kruispostenSection } from "@/lib/bank-reconciliation-overview";
import { assertNavKeepsSubpagesNested } from "@/test/support/nav-scope";

const CLIENT = { id: "c-1", name: "Bakkerij Van Dijk", organization_id: "org-1", ibans: ["NL91ABNA0417164300", "NL02RABO0123456789"] };
const ACCOUNTS = [
  { id: "gb-1100", nummer: 1100, omschrijving: "Bank ING", client_id: null, actief: true, categorie: "activa" },
  { id: "gb-1200", nummer: 1200, omschrijving: "Kruisposten", client_id: null, actief: true, categorie: "activa" },
  { id: "gb-4000", nummer: 4000, omschrijving: "Kosten", client_id: null, actief: true, categorie: "activa" },
  // Een 1200 van een ANDERE administratie hoort hier nooit mee te tellen.
  { id: "gb-1200-x", nummer: 1200, omschrijving: "Kruisposten andere klant", client_id: "c-2", actief: true, categorie: "activa" },
];

let seq = 0;
const regel = (group: string, date: string, account: string, debit: number, credit: number) => ({
  id: `p-${++seq}`, client_id: "c-1", organization_id: "org-1", posting_group_id: group, line_no: seq, posting_date: date,
  boekjaar: Number(date.slice(0, 4)), grootboekrekening_id: account, debit_amount: debit, credit_amount: credit,
  currency: "EUR", description: null, source_type: "manual_journal", source_id: group, source_line_id: null,
  reversal_of_posting_id: null, user_id: "u", created_at: date, created_xact_id: "1",
});
/** 1200 krijgt 250 debet en 100 credit → eindsaldo 150 debet. */
const POSTINGS = [
  regel("g1", "2025-11-30", "gb-1200", 250, 0), regel("g1", "2025-11-30", "gb-1100", 0, 250),
  regel("g2", "2026-01-05", "gb-1100", 100, 0), regel("g2", "2026-01-05", "gb-1200", 0, 100),
];

function EerdereSelectie({ id }: { id: string }) {
  const { setSelectedClientId } = useClientContext();
  useEffect(() => setSelectedClientId(id), [id, setSelectedClientId]);
  return null;
}
function Bronscherm() {
  const { selectedClientId } = useClientContext();
  return <div data-testid="bron-administratie">{selectedClientId}</div>;
}

function renderPage(selected: string | null = "c-1") {
  return render(
    <ClientProvider>
      {selected && <EerdereSelectie id={selected} />}
      <MemoryRouter initialEntries={["/bank/afstemming"]}>
        <Routes>
          <Route path="/bank/afstemming" element={<BankAfstemming />} />
          <Route path="/bank" element={<Bronscherm />} />
          <Route path="/grootboek/saldi" element={<Bronscherm />} />
          <Route path="/grootboek/saldi/:accountId" element={<Bronscherm />} />
        </Routes>
      </MemoryRouter>
    </ClientProvider>,
  );
}

const sectie = (naam: "import" | "kruisposten") => screen.getByTestId(`bank-overview-${naam}`);

beforeEach(() => {
  supabaseCalls.length = 0;
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k].length = 0;
  state.org = { activeOrganizationId: "org-1", isReady: true };
  state.clients = ok([CLIENT, { ...CLIENT, id: "c-2", name: "Andere klant", ibans: [] }]);
  state.accounts = ok(ACCOUNTS);
  state.postings = ok(POSTINGS);
  state.bankNewest = ok({ transactions: [{ transaction_date: "2026-09-25" }], total: 214 });
  state.bankOldest = ok({ transactions: [{ transaction_date: "2025-01-02" }], total: 214 });
});

describe("Bankafstemming — feiten uit bestaande leesmodellen", () => {
  it("1. kop met administratie, terugweg naar Bank en twee secties; geen 'volledig/afgestemd'-bewering", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Bankafstemming" })).toBeInTheDocument();
    expect(screen.getByText(/Bakkerij Van Dijk · /)).toBeInTheDocument();
    // De terugweg in de kop en de link in de banksectie wijzen allebei naar het bestaande Bank-scherm.
    expect(screen.getAllByRole("link", { name: "Naar Bank" }).map((a) => a.getAttribute("href"))).toEqual(["/bank", "/bank"]);
    expect(sectie("import")).toBeInTheDocument();
    expect(sectie("kruisposten")).toBeInTheDocument();
    expect(screen.getByTestId("bank-overview-toolbar")).toHaveTextContent(BANK_OVERVIEW_READ_ONLY_NOTE);
    expect(document.body.textContent).not.toMatch(/volledig ingelezen\.|is afgestemd|volledig afgestemd/i);
  });

  it("2. bankgegevens: IBAN's van de administratie, aantal en datums van de bankleeshook", () => {
    renderPage();
    expect(sectie("import")).toHaveAttribute("data-status", "informatief");
    const ibans = within(sectie("import")).getByTestId("bank-overview-ibans");
    expect(within(ibans).getAllByRole("listitem").map((li) => li.textContent)).toEqual(CLIENT.ibans);
    expect(within(sectie("import")).getByTestId("bank-overview-count")).toHaveTextContent("214");
    expect(within(sectie("import")).getByTestId("bank-overview-first")).toHaveTextContent("02-01-2025");
    expect(within(sectie("import")).getByTestId("bank-overview-last")).toHaveTextContent("25-09-2026");
    expect(sectie("import")).toHaveTextContent("dit is één telling voor alle rekeningen samen");
    expect(calls.bank.at(-1)).toMatchObject({ clientId: "c-1", page: 1, pageSize: 1, enabled: true });
  });

  it("3. 1200 aanwezig: het saldo is exact het eindsaldo van buildAccountReport over alle jaren", () => {
    renderPage();
    const report = buildAccountReport({ rows: POSTINGS, clientId: "c-1", period: ALL_TIME_PERIOD, accounts: ACCOUNTS });
    expect(report.ok).toBe(true);
    const rollup = report.ok ? report.rollups.find((r) => r.account.id === "gb-1200")! : null;
    expect(rollup!.closingCents).toBe(15000);
    const rijen = within(sectie("kruisposten")).getAllByTestId("bank-overview-kruisposten-row");
    // Alleen de 1200 binnen de administratiegrens, niet die van een andere administratie.
    expect(rijen).toHaveLength(1);
    expect(within(rijen[0]).getByTestId("bank-overview-kruisposten-saldo")).toHaveTextContent("€ 150,00");
    expect(rijen[0]).toHaveTextContent("Kruisposten");
    expect(sectie("kruisposten")).toHaveAttribute("data-status", "aandacht");
    expect(sectie("kruisposten")).toHaveTextContent("Het saldo van rekening 1200 is niet nul.");
    expect(calls.postings.at(-1)).toMatchObject({ clientId: "c-1", period: ALL_TIME_PERIOD });
  });

  it("4. 1200 aanwezig met saldo nul → Informatief; zonder boekingen → 'Geen boekingen', geen verzonnen nul", () => {
    state.postings = ok([...POSTINGS, regel("g3", "2026-02-01", "gb-1200", 0, 150), regel("g3", "2026-02-01", "gb-1100", 150, 0)]);
    const { unmount } = renderPage();
    expect(sectie("kruisposten")).toHaveAttribute("data-status", "informatief");
    expect(sectie("kruisposten")).toHaveTextContent("Het saldo van rekening 1200 is nul.");
    unmount();

    state.postings = ok([]);
    renderPage();
    expect(sectie("kruisposten")).toHaveAttribute("data-status", "informatief");
    expect(within(sectie("kruisposten")).getByTestId("bank-overview-kruisposten-saldo")).toHaveTextContent("Geen boekingen");
    expect(within(sectie("kruisposten")).getByTestId("bank-overview-kruisposten-saldo")).not.toHaveTextContent("€");
  });

  it("5. 1200 bestaat niet: feitelijke lege staat, geen saldo en geen vervangende rekening", () => {
    state.accounts = ok(ACCOUNTS.filter((a) => a.id !== "gb-1200"));
    renderPage();
    expect(sectie("kruisposten")).toHaveAttribute("data-status", "informatief");
    expect(sectie("kruisposten")).toHaveTextContent("Rekening 1200 bestaat niet in het rekeningschema van deze administratie; er wordt geen saldo getoond.");
    expect(within(sectie("kruisposten")).queryByTestId("bank-overview-kruisposten-table")).toBeNull();
    expect(sectie("kruisposten")).not.toHaveTextContent("€");
    expect(sectie("kruisposten")).not.toHaveTextContent("Kruisposten andere klant");
  });
});

describe("Bankafstemming — onleesbaar of ladend is nooit 'gereed'", () => {
  it("6. rekeningschema onleesbaar → Niet te bepalen, geen saldo, opnieuw proberen leest alleen opnieuw", () => {
    state.accounts = fout();
    renderPage();
    expect(sectie("kruisposten")).toHaveAttribute("data-status", "niet_te_bepalen");
    expect(sectie("kruisposten")).not.toHaveTextContent("€");
    fireEvent.click(within(sectie("kruisposten")).getByRole("button", { name: "Opnieuw proberen" }));
    expect(state.accounts.refetch).toHaveBeenCalledTimes(1);
    expect(state.postings.refetch).toHaveBeenCalledTimes(1);
    expect(state.bankNewest.refetch).not.toHaveBeenCalled();
  });

  it("7. grootboekregels onleesbaar → Niet te bepalen, geen saldo", () => {
    state.postings = fout();
    renderPage();
    expect(sectie("kruisposten")).toHaveAttribute("data-status", "niet_te_bepalen");
    expect(within(sectie("kruisposten")).queryByTestId("bank-overview-kruisposten-saldo")).toBeNull();
  });

  it("8. een kern die zijn eigen controle niet haalt → Niet te bepalen, geen saldo", () => {
    state.postings = ok([regel("gx", "2026-03-01", "gb-1200", 100, 0)]); // één halve groep
    renderPage();
    expect(sectie("kruisposten")).toHaveAttribute("data-status", "niet_te_bepalen");
    expect(sectie("kruisposten")).toHaveTextContent("boekingscontrole niet sluit");
    expect(within(sectie("kruisposten")).queryByTestId("bank-overview-kruisposten-saldo")).toBeNull();
  });

  it("9. banktransacties onleesbaar → Niet te bepalen, geen telling, en alleen bank-refetch", () => {
    state.bankOldest = fout();
    renderPage();
    expect(sectie("import")).toHaveAttribute("data-status", "niet_te_bepalen");
    expect(within(sectie("import")).queryByTestId("bank-overview-count")).toBeNull();
    fireEvent.click(within(sectie("import")).getByRole("button", { name: "Opnieuw proberen" }));
    expect(state.bankNewest.refetch).toHaveBeenCalledTimes(1);
    expect(state.bankOldest.refetch).toHaveBeenCalledTimes(1);
    expect(state.accounts.refetch).not.toHaveBeenCalled();
  });

  it("10. laden is nooit Informatief of Aandacht nodig", () => {
    state.accounts = laden();
    state.postings = laden();
    state.bankNewest = laden();
    renderPage();
    expect(sectie("import")).toHaveAttribute("data-status", "laden");
    expect(sectie("kruisposten")).toHaveAttribute("data-status", "laden");
  });

  it("11. de pure laag: fout of laden geeft nooit een saldo of telling", () => {
    for (const read of [{ kind: "error" as const }, { kind: "loading" as const }]) {
      const b = bankImportSection(read);
      expect(b.total).toBeNull();
      expect(["niet_te_bepalen", "laden"]).toContain(b.status);
      const k = kruispostenSection(read, { kind: "loading" }, "c-1");
      expect(k.rows).toEqual([]);
      expect(["niet_te_bepalen", "laden"]).toContain(k.status);
      const k2 = kruispostenSection({ kind: "ok", value: ACCOUNTS }, read, "c-1");
      expect(k2.rows).toEqual([]);
      expect(["niet_te_bepalen", "laden"]).toContain(k2.status);
    }
  });
});

describe("Bankafstemming — administratie en organisatie", () => {
  it("12. zonder specifieke administratie: banner, geen administratiegebonden lezing", () => {
    renderPage(null);
    expect(screen.getByText("Kies eerst een specifieke administratie om het bankoverzicht te bekijken.")).toBeInTheDocument();
    expect(calls.postings.every((c) => c.clientId === undefined && c.enabled === false)).toBe(true);
    expect(calls.bank.every((c) => c.clientId === undefined && c.enabled === false)).toBe(true);
  });

  it("13. ingelogd zonder organisatie: geen laadlus, nette melding, geen lezingen", () => {
    state.org = { activeOrganizationId: null, isReady: true };
    state.clients = laden();
    renderPage();
    expect(screen.queryByText("Administraties laden…")).toBeNull();
    expect(screen.getByTestId("bank-overview-unavailable")).toHaveTextContent("Er is geen actieve organisatie; het overzicht is niet te bepalen.");
    expect(calls.clients.every((c) => c.enabled === false)).toBe(true);
    expect(calls.accounts.every((c) => c.enabled === false)).toBe(true);
    expect(calls.postings.every((c) => c.clientId === undefined)).toBe(true);
    expect(supabaseCalls).toEqual([]);
  });

  it("14. links blijven bij dezelfde administratie en wijzen naar bestaande schermen", async () => {
    renderPage();
    expect(within(sectie("kruisposten")).getByRole("link", { name: "Open mutaties van 1200 - Kruisposten" })).toHaveAttribute(
      "href",
      "/grootboek/saldi/gb-1200",
    );
    fireEvent.click(within(sectie("kruisposten")).getByRole("link", { name: "Naar Grootboeksaldi" }));
    expect(await screen.findByTestId("bron-administratie")).toHaveTextContent(/^c-1$/);
  });
});

describe("Bankafstemming — route, ingang en alleen lezen", () => {
  const strip = (pad: string) =>
    readFileSync(resolve(process.cwd(), pad), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((r) => !r.trimStart().startsWith("//"))
      .join("\n");

  it("15. route onder Bank zonder nav-item; Bank linkt ernaartoe en geeft de gekozen administratie mee", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    expect(app).toContain('<Route path="/bank/afstemming" element={<BankAfstemming />} />');
    assertNavKeepsSubpagesNested(["/bank/afstemming"]);
    const bank = strip("src/pages/Bank.tsx");
    // Precies één administratie gaat mee; anders wordt de context gewist ("all").
    expect(bank).toMatch(/to="\/bank\/afstemming"[\s\S]{0,120}onClick=\{\(\) => setSelectedClientId\(singleClientId \?\? "all"\)\}[\s\S]{0,40}Bankafstemming/);
  });

  it("16. geen schrijfhook, mutatie, RPC of databaseclient in pagina en afleidingslaag", () => {
    for (const pad of ["src/pages/BankAfstemming.tsx", "src/lib/bank-reconciliation-overview.ts"]) {
      const bron = strip(pad);
      expect(bron, pad).not.toMatch(/integrations\/supabase|supabase\./);
      expect(bron, pad).not.toMatch(/useMutation|mutateAsync|\.mutate\(|usePost[A-Z]|useAdd[A-Z]|useUpdate[A-Z]|useDelete[A-Z]|useRun[A-Z]|useSeed[A-Z]/);
      expect(bron, pad).not.toMatch(/\.rpc\(|\.from\(\s*["'`]|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\bfetch\(/);
    }
    const hooks = [...strip("src/pages/BankAfstemming.tsx").matchAll(/import \{([^}]+)\} from "@\/hooks\/[^"]+"/g)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim()))
      .sort();
    expect(hooks).toEqual([
      "useActiveOrganization",
      "useClientContext",
      "useClients",
      "useGrootboekrekeningen",
      "useLedgerPostings",
      "usePaginatedBankTransactions",
    ]);
  });

  it("17. op de pagina staat geen actieknop: alleen links en (bij een fout) opnieuw proberen", () => {
    renderPage();
    // Zonder fout geen enkele knop; de administratiekeuze is een combobox.
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.getByRole("combobox", { name: "Administratie" })).toBeInTheDocument();
    expect(supabaseCalls).toEqual([]);
  });
});

describe("Bankafstemming — Codex-review PR #239", () => {
  it("18. na een wissel van administratie telt achtergebleven bankdata (placeholder) als laden, niet als feit", () => {
    state.bankNewest = { ...ok({ transactions: [{ transaction_date: "2026-09-25" }], total: 214 }), isPlaceholderData: true } as Q;
    renderPage();
    expect(sectie("import")).toHaveAttribute("data-status", "laden");
    expect(within(sectie("import")).queryByTestId("bank-overview-count")).toBeNull();
    expect(sectie("import")).not.toHaveTextContent("214");
  });

  it("19. zonder precies één administratie in Bank opent het overzicht zonder eerdere administratie", () => {
    // Het effect van de Bank-link bij een multi-selectie: de context wordt "all".
    renderPage("all");
    expect(screen.getByText("Kies eerst een specifieke administratie om het bankoverzicht te bekijken.")).toBeInTheDocument();
    expect(calls.bank.every((c) => c.clientId === undefined)).toBe(true);
  });
});
