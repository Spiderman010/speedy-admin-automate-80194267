import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { readFileSync } from "node:fs";

/**
 * Fase 6C-b7 PR 2 — de saldilijst (/grootboek/saldi).
 *
 * De datalaag (useLedgerPostings, useLedgerCompleteness, rekeningen, klanten)
 * is gemockt; het rekenwerk NIET: buildAccountReport uit PR 1 draait echt.
 * Zo bewijzen de tests dat de pagina de kern gebruikt en niets zelf optelt.
 */

const state = {
  selectedClientId: "c-1",
  postings: [] as Array<Record<string, unknown>>,
  postingsPending: false,
  postingsError: null as { message: string } | null,
  accounts: [] as Array<Record<string, unknown>>,
  completeness: undefined as unknown,
};

const { setClientSpy, ledgerSpy } = vi.hoisted(() => ({ setClientSpy: vi.fn(), ledgerSpy: vi.fn() }));

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.selectedClientId, setSelectedClientId: setClientSpy }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c-1", name: "Klant Een", organization_id: "org-1" }] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({ data: state.accounts }),
}));
vi.mock("@/hooks/useLedgerPostings", () => ({
  useLedgerPostings: (opts: unknown) => {
    ledgerSpy(opts);
    return {
      data: state.postingsPending || state.postingsError ? undefined : state.postings,
      isPending: state.postingsPending,
      isError: !!state.postingsError,
      error: state.postingsError,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@/hooks/useLedgerCompleteness", () => ({
  useLedgerCompleteness: () => ({ data: state.completeness, isPending: false, isError: false }),
  // 6C-b8 PR 3: beginbalansdimensie; standaard niet aanwezig zodat de bestaande verwachtingen gelden.
  useOpeningBalanceCompleteness: () => ({ data: undefined, isPending: false, isError: false }),
}));

import GrootboekSaldi from "@/pages/GrootboekSaldi";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderPage(path = "/grootboek/saldi") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/grootboek/saldi" element={<GrootboekSaldi />} />
        <Route path="/grootboek/saldi/:accountId" element={<GrootboekSaldi />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

let seq = 0;
const p = (over: Record<string, unknown>) => {
  seq += 1;
  return {
    id: `p-${String(seq).padStart(4, "0")}`,
    client_id: "c-1",
    organization_id: "org-1",
    posting_group_id: "g-1",
    line_no: 1,
    posting_date: "2027-03-01",
    boekjaar: 2027,
    debit_amount: 0,
    credit_amount: 0,
    currency: "EUR",
    description: null,
    source_type: "manual_journal",
    source_id: "mj-1",
    source_line_id: null,
    reversal_of_posting_id: null,
    user_id: "u-1",
    created_at: "2027-03-01T00:00:00Z",
    created_xact_id: "1",
    ...over,
  };
};
const grp = (g: string, date: string, legs: Array<[string, number, number]>) =>
  legs.map(([acc, d, c], i) =>
    p({ posting_group_id: g, line_no: i + 1, posting_date: date, boekjaar: Number(date.slice(0, 4)), grootboekrekening_id: acc, debit_amount: d, credit_amount: c }),
  );

const YEAR = new Date().getFullYear();
const inYear = (m: string) => `${YEAR}-${m}`;

const accounts = [
  { id: "gb-1100", nummer: 1100, omschrijving: "Bank", categorie: "activa", actief: true },
  { id: "gb-1600", nummer: 1600, omschrijving: "Crediteuren", categorie: "passiva", actief: true },
  { id: "gb-4000", nummer: 4000, omschrijving: "Kosten", categorie: "kosten", actief: true },
  { id: "gb-4999", nummer: 4999, omschrijving: "Oude rekening", categorie: "kosten", actief: false },
  { id: "gb-0900", nummer: 900, omschrijving: "Privé-opnamen", categorie: "privé", actief: true },
  { id: "gb-9999", nummer: 9999, omschrijving: "Vrije tekst", categorie: "Kostem", actief: true },
];

const rows = () => screen.getAllByTestId("saldi-row");

beforeEach(() => {
  ledgerSpy.mockClear();
  setClientSpy.mockClear();
  state.selectedClientId = "c-1";
  state.postings = [];
  state.postingsPending = false;
  state.postingsError = null;
  state.accounts = accounts;
  state.completeness = undefined;
});

describe("GrootboekSaldi — saldilijst", () => {
  it("1. zonder specifieke administratie: NoClientBanner en geen tabel", () => {
    state.selectedClientId = "all";
    renderPage();
    expect(screen.getByText(/Kies eerst een specifieke administratie/)).toBeInTheDocument();
    expect(screen.queryByTestId("saldi-row")).toBeNull();
  });

  it("2. laden → skeleton, geen cijfers", () => {
    state.postingsPending = true;
    renderPage();
    expect(screen.getByText("Grootboek laden…")).toBeInTheDocument();
    expect(screen.getByText("Grootboek laden…").closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByTestId("saldi-row")).toBeNull();
  });

  it("3. leeg grootboek → eerlijke lege staat, geen tabel met nullen", () => {
    renderPage();
    expect(screen.getByText("Nog geen geboekte grootboekmutaties voor deze periode.")).toBeInTheDocument();
    expect(screen.queryByTestId("saldi-row")).toBeNull();
  });

  it("4. geldige rijen: nummer, omschrijving, categorie, begin/debet/credit/eind", () => {
    state.postings = [
      ...grp("g-0", `${YEAR - 1}-06-01`, [["gb-1100", 500, 0], ["gb-1600", 0, 500]]),
      ...grp("g-1", inYear("03-01"), [["gb-4000", 121, 0], ["gb-1100", 0, 121]]),
    ];
    renderPage();
    expect(rows()).toHaveLength(3);
    const bank = rows().find((r) => r.getAttribute("data-account-id") === "gb-1100")!;
    expect(bank).toHaveTextContent("1100");
    expect(bank).toHaveTextContent("Bank");
    expect(bank).toHaveTextContent("Activa");
    const cells = bank.querySelectorAll("td");
    expect(cells[3]).toHaveTextContent("500,00"); // beginsaldo
    expect(cells[4]).toHaveTextContent("0,00"); // debet
    expect(cells[5]).toHaveTextContent("121,00"); // credit
    expect(cells[6]).toHaveTextContent("379,00"); // eind = 500 + 0 − 121
    expect(screen.getByTestId("saldi-totals")).toHaveTextContent("3 rekeningen");
  });

  it("5. debetsaldo positief", () => {
    state.postings = grp("g-1", inYear("03-01"), [["gb-4000", 250, 0], ["gb-1600", 0, 250]]);
    renderPage();
    const r = rows().find((x) => x.getAttribute("data-account-id") === "gb-4000")!;
    expect(r.querySelectorAll("td")[6]).toHaveTextContent("€ 250,00");
    expect(r.querySelectorAll("td")[6]).not.toHaveTextContent("-");
  });

  it("6. creditsaldo blijft negatief (geen omklap per categorie)", () => {
    state.postings = grp("g-1", inYear("03-01"), [["gb-4000", 250, 0], ["gb-1600", 0, 250]]);
    renderPage();
    const r = rows().find((x) => x.getAttribute("data-account-id") === "gb-1600")!;
    expect(r.querySelectorAll("td")[6].textContent).toMatch(/-\s?€\s?250,00|€\s?-250,00/);
    expect(r).toHaveTextContent("Passiva");
  });

  it("7. nulsaldo met beweging blijft zichtbaar", () => {
    state.postings = [
      ...grp("g-1", inYear("02-01"), [["gb-4000", 100, 0], ["gb-1100", 0, 100]]),
      ...grp("g-2", inYear("02-02"), [["gb-1100", 100, 0], ["gb-4000", 0, 100]]),
    ];
    renderPage();
    const r = rows().find((x) => x.getAttribute("data-account-id") === "gb-4000")!;
    expect(r.querySelectorAll("td")[6]).toHaveTextContent("€ 0,00");
  });

  it("8. een inactieve rekening met saldo blijft zichtbaar, met badge", () => {
    state.postings = grp("g-1", inYear("03-01"), [["gb-4999", 80, 0], ["gb-1600", 0, 80]]);
    renderPage();
    const r = rows().find((x) => x.getAttribute("data-account-id") === "gb-4999")!;
    expect(r).toHaveTextContent("Oude rekening");
    expect(r).toHaveTextContent("Inactief");
    expect(r.querySelectorAll("td")[6]).toHaveTextContent("€ 80,00");
  });

  it("9. een niet-herleidbare rekening blijft zichtbaar als 'Onbekende rekening'", () => {
    state.postings = grp("g-1", inYear("03-01"), [["gb-ghost", 33, 0], ["gb-1600", 0, 33]]);
    renderPage();
    const r = rows().find((x) => x.getAttribute("data-account-id") === "gb-ghost")!;
    expect(r).toHaveTextContent("Onbekende rekening");
    // De categoriekolom (index 2) toont zelfstandig "Onbekend" — niet alleen de rekeningbadge.
    expect(r.querySelectorAll("td")[2]).toHaveTextContent(/^Onbekend$/);
    expect(r.querySelectorAll("td")[6]).toHaveTextContent("€ 33,00");
  });

  it("10. onbekende/vrije-tekstcategorie → badge 'Onbekend'", () => {
    state.postings = grp("g-1", inYear("03-01"), [["gb-9999", 12, 0], ["gb-1600", 0, 12]]);
    renderPage();
    const r = rows().find((x) => x.getAttribute("data-account-id") === "gb-9999")!;
    expect(r).toHaveTextContent("Vrije tekst");
    expect(r).toHaveTextContent("Onbekend");
  });

  it("11. privé → categorie 'Privé', zonder balans/W&V-indeling", () => {
    state.postings = grp("g-1", inYear("03-01"), [["gb-0900", 40, 0], ["gb-1100", 0, 40]]);
    renderPage();
    const r = rows().find((x) => x.getAttribute("data-account-id") === "gb-0900")!;
    expect(r).toHaveTextContent("Privé");
    expect(screen.queryByText(/eigen vermogen|balans|winst/i)).toBeNull();
  });

  it("12. klik op de rekeningnaam opent /grootboek/saldi/:accountId", async () => {
    state.postings = grp("g-1", inYear("03-01"), [["gb-4000", 250, 0], ["gb-1600", 0, 250]]);
    renderPage();
    const link = screen.getByRole("link", { name: "Open mutaties van 4000 - Kosten" });
    expect(link).toHaveAttribute("href", "/grootboek/saldi/gb-4000");
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/grootboek/saldi/gb-4000"));
    expect(screen.getByTestId("account-header")).toHaveTextContent("4000");
  });

  it("13. een falende zelfcontrole blokkeert de cijfers met een alert", () => {
    // Twee halve groepen die elkaar op setniveau opheffen — de groepscontrole vangt het.
    state.postings = [
      p({ grootboekrekening_id: "gb-4000", debit_amount: 100, posting_date: inYear("03-01"), posting_group_id: "g-a" }),
      p({ grootboekrekening_id: "gb-1600", credit_amount: 100, posting_date: inYear("03-01"), posting_group_id: "g-b" }),
    ];
    renderPage();
    const alert = screen.getByTestId("ledger-self-check-failed");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(
      "Het grootboekrapport kan niet veilig worden opgebouwd omdat de boekingscontrole niet sluit.",
    );
    expect(screen.queryByTestId("saldi-row")).toBeNull();
    expect(screen.queryByTestId("saldi-totals")).toBeNull();
  });

  it("13b. ook op /grootboek/saldi/:accountId blokkeert een falende zelfcontrole de cijfers", () => {
    state.postings = [
      p({ grootboekrekening_id: "gb-4000", debit_amount: 100, posting_date: inYear("03-01"), posting_group_id: "g-a" }),
      p({ grootboekrekening_id: "gb-1600", credit_amount: 100, posting_date: inYear("03-01"), posting_group_id: "g-b" }),
    ];
    renderPage("/grootboek/saldi/gb-4000");
    expect(screen.getByTestId("ledger-self-check-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("account-summary")).toBeNull();
    expect(screen.queryByTestId("mutation-row")).toBeNull();
  });

  it("14. een niet-EUR-rij blokkeert de cijfers", () => {
    state.postings = [
      ...grp("g-1", inYear("03-01"), [["gb-4000", 100, 0], ["gb-1600", 0, 100]]),
      ...grp("g-2", inYear("03-02"), [["gb-4000", 5, 0], ["gb-1600", 0, 5]]).map((r) => ({ ...r, currency: "USD" })),
    ];
    renderPage();
    expect(screen.getByTestId("ledger-error")).toHaveTextContent(/alleen EUR/);
    expect(screen.queryByTestId("saldi-row")).toBeNull();
  });

  it("15. periodefilters gaan als half-open [from, toExclusive) naar de hook; boekjaar nooit", () => {
    renderPage();
    const last = () => ledgerSpy.mock.calls.at(-1)![0] as { clientId: string; period: { from: string; toExclusive: string } };
    expect(last()).toMatchObject({ clientId: "c-1", period: { from: `${YEAR}-01-01`, toExclusive: `${YEAR + 1}-01-01` } });
    expect(JSON.stringify(last())).not.toContain("boekjaar");

    fireEvent.click(screen.getByRole("button", { name: String(YEAR - 1) }));
    expect(last().period).toEqual({ from: `${YEAR - 1}-01-01`, toExclusive: `${YEAR}-01-01` });

    fireEvent.click(screen.getByRole("button", { name: "Alle jaren" }));
    expect(last().period).toEqual({ from: "2000-01-01", toExclusive: "2101-01-01" });

    // "Tot en met" is inclusief voor de gebruiker; de hook krijgt de dag erna exclusief.
    fireEvent.change(screen.getByLabelText("Van"), { target: { value: "2027-02-01" } });
    fireEvent.change(screen.getByLabelText("Tot en met"), { target: { value: "2027-02-28" } });
    fireEvent.click(screen.getByRole("button", { name: "Periode toepassen" }));
    expect(last().period).toEqual({ from: "2027-02-01", toExclusive: "2027-03-01" });
    expect(screen.getByTestId("period-label")).toHaveTextContent("01-02-2027 t/m 28-02-2027");
  });

  it("15b. laadfout van de hook → alert, geen cijfers", () => {
    state.postingsError = { message: "permission denied" };
    renderPage();
    expect(screen.getByTestId("ledger-error")).toHaveTextContent("permission denied");
    expect(screen.queryByTestId("saldi-row")).toBeNull();
  });

  it("15c. precies één h1 per pagina", () => {
    state.postings = grp("g-1", inYear("03-01"), [["gb-4000", 250, 0], ["gb-1600", 0, 250]]);
    renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Grootboeksaldi");
  });
});

describe("GrootboekSaldi — statische grenzen", () => {
  const files = [
    "src/pages/GrootboekSaldi.tsx",
    "src/components/grootboek/GrootboekSaldiTable.tsx",
    "src/components/grootboek/GrootboekAccountMutations.tsx",
    "src/components/grootboek/LedgerCompletenessNotice.tsx",
    "src/lib/grootboek-saldi-utils.ts",
    "src/lib/ledger-completeness.ts",
    "src/hooks/useLedgerCompleteness.ts",
  ].map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("33. geen nieuwe geldberekening leest documenttotalen", () => {
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/amount_incl|amount_excl|btw_amount|remaining_amount|\.amount\b/);
      expect(text, path).not.toMatch(/import[^;]*(ledger-mutations|useJournalEntries|journal-entry-utils|usePurchaseInvoices|useSalesInvoices|useBankTransactions|snelstart-export)/);
    }
  });

  it("34. geen journal_entries-import of -query in de saldischermen", () => {
    // De naam mag in een toelichting staan; een query, import of hook niet.
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(/from\(\s*["']journal_entries|useJournalEntries|journal-entry-utils/);
      const tables = [...text.matchAll(/from\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]);
      expect(tables, path).not.toContain("journal_entries");
    }
    // De volledigheidshook telt alleen (count/head) en leest id's — geen bedragkolommen.
    const hook = files.find((f) => f.path.endsWith("useLedgerCompleteness.ts"))!.text;
    const selects = [...hook.matchAll(/\.select\(\s*"([^"]*)"/g)].map((m) => m[1]);
    for (const s of selects) expect(s).not.toMatch(/amount|total|bedrag/);
  });

  it("35/36. geen wijziging aan gegenereerde types en geen migratie in deze branch", () => {
    // Echte controle via git (de bronbestanden zelf kunnen geen SQL "bevatten"
    // op een manier die iets bewijst). Zie ook bronmutaties-rename.test.tsx.
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" });
    expect(changed).not.toMatch(/integrations\/supabase\/types\.ts/);
    // Voorheen: "deze branch bevat geen migratie". Dat was een uitspraak over de
    // SCOPE van één UI-PR, geen invariant — zodra een latere fase wél een
    // migratie meebrengt (6C-b8, beginbalans) kan hij niet meer kloppen. Wat
    // hier werkelijk beschermd moet worden is het contract waar deze laag op
    // leest: een migratie in deze branch mag de fundering uit 6C-b2 niet
    // wijzigen of weggooien.
    for (const bestand of changed.split("\n").filter((f) => f.startsWith("supabase/migrations/"))) {
      const sql = readFileSync(bestand, "utf8")
        .split("\n")
        .filter((r) => !r.trimStart().startsWith("--"))
        .join("\n");
      expect(sql, bestand).not.toMatch(/ALTER TABLE public\.ledger_postings/);
      expect(sql, bestand).not.toMatch(/DROP TABLE[^;]*ledger_postings/);
      // Een migratie mag haar EIGEN toevoeging aan ledger_postings idempotent
      // weggooien, maar nooit een object uit de fundering zelf.
      const fundering = readFileSync(
        "supabase/migrations/20260914120000_add_ledger_postings_foundation.sql",
        "utf8",
      );
      for (const drop of sql.match(/DROP (?:TABLE|FUNCTION|TRIGGER|POLICY|INDEX)[^;]*/g) ?? []) {
        if (!/ledger_postings/.test(drop)) continue;
        const naam = drop.match(/DROP \w+(?: IF EXISTS)? ([\w.]+)/)?.[1] ?? "";
        expect(fundering, `${bestand}: ${drop}`).not.toContain(`CREATE TRIGGER ${naam}`);
        expect(fundering, `${bestand}: ${drop}`).not.toContain(`CREATE CONSTRAINT TRIGGER ${naam}`);
        expect(fundering, `${bestand}: ${drop}`).not.toContain(`INDEX IF NOT EXISTS ${naam}`);
      }
    }
    for (const { path, text } of files) expect(text, path).not.toMatch(/\.rpc\(/);
  });

  it("de pagina rekent niet zelf: alle bedragen komen uit ledger-reporting", () => {
    const page = files.find((f) => f.path.endsWith("GrootboekSaldi.tsx"))!.text;
    expect(page).toMatch(/buildAccountReport/);
    expect(page).toMatch(/buildRunningBalance/);
    expect(page).not.toMatch(/debit_amount|credit_amount/);
  });
});
