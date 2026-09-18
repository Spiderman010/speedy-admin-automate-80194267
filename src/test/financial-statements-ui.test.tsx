import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Balans/W&V PR 4 — de zichtbare jaarrekeningrapporten.
 *
 * De pagina's krijgen hun cijfers van de échte engine: de fixtures gaan door
 * buildAccountReport() en buildFinancialStatements() heen en alleen de
 * dataleverende hooks zijn gemockt. Zo bewijst elke test tegelijk dat het
 * scherm precies toont wat de engine teruggeeft — en niets zelf uitrekent.
 */

const state = {
  rows: [] as any[],
  accounts: [] as any[],
  postingsPending: false,
  postingsError: null as { message: string } | null,
  accountsPending: false,
  accountsError: null as { message: string } | null,
  clientId: "client-1" as string,
};

const refetchPostings = vi.fn();
const refetchAccounts = vi.fn();
const setSelectedClientId = vi.fn();

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.clientId, setSelectedClientId }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "client-1", name: "Klant A" }, { id: "client-2", name: "Klant B" }] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({
    data: state.accounts,
    isPending: state.accountsPending,
    isError: !!state.accountsError,
    error: state.accountsError,
    refetch: refetchAccounts,
  }),
}));
vi.mock("@/hooks/useLedgerCompleteness", () => ({
  useLedgerCompleteness: () => ({ data: undefined, isPending: false, isError: false }),
  // De balans leest hier alleen de beginbalansSTATUS (volledigheid), nooit
  // cijfers. Testinfrastructuur: standaard "niet ingesteld", zodat de tests
  // precies het geval dekken waar deze fix over gaat.
  useOpeningBalanceCompleteness: () => ({
    data: {
      state: "not_set", year: 2026, assertionYear: null, draftCount: 0,
      label: "Niet ingesteld", severity: "incomplete", note: null,
    },
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/hooks/useLedgerPostings", () => ({
  useLedgerPostings: (opts: any) => {
    // Zoals de echte hook: filteren op administratie én op de half-open
    // periode [from, toExclusive). Zonder die periodefilter zou een
    // jaarwisseling in de test niets veranderen.
    const rows = opts?.clientId
      ? state.rows.filter(
          (r) =>
            r.client_id === opts.clientId &&
            r.posting_date < opts.period.toExclusive,
        )
      : [];
    return {
      data: opts?.clientId ? rows : undefined,
      isPending: state.postingsPending,
      isError: !!state.postingsError,
      error: state.postingsError,
      refetch: refetchPostings,
    };
  },
}));

import Balans from "@/pages/Balans";
import WinstVerlies from "@/pages/WinstVerlies";
import { buildAccountReport, yearPeriod } from "@/lib/ledger-reporting";
import {
  buildFinancialStatements,
  movementOnPeriodStartFromRows,
  openingBalanceContributionFromRows,
} from "@/lib/financial-statements";
import { formatCents } from "@/lib/financial-statements-presentation";

/**
 * `formatCents` gebruikt Intl en dus een harde spatie (U+00A0) tussen € en het
 * bedrag. `toHaveTextContent` normaliseert de witruimte in de DOM, dus moet de
 * verwachting dezelfde normalisatie ondergaan — anders vergelijk je een harde
 * met een gewone spatie.
 */
const bedrag = (cents: number) => formatCents(cents).replace(/\u00a0/g, " ");

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
function entry(debit: string, credit: string, amount: string, date: string, sourceType = "manual_journal", client = "client-1") {
  seq++;
  const group = `g-${seq}`;
  const base = {
    client_id: client,
    posting_group_id: group,
    posting_date: date,
    boekjaar: Number(date.slice(0, 4)),
    currency: "EUR",
    source_type: sourceType,
  };
  return [
    { ...base, id: `${group}-1`, line_no: 1, grootboekrekening_id: debit, debit_amount: amount, credit_amount: "0.00" },
    { ...base, id: `${group}-2`, line_no: 2, grootboekrekening_id: credit, debit_amount: "0.00", credit_amount: amount },
  ];
}

const acc = (over: any) => ({
  nummer: 1000, omschrijving: "Rekening", categorie: "activa", actief: true,
  statement_type: null, report_group: null, normal_side: null, report_sort: null, ...over,
});

const BANK = acc({ id: "a-bank", nummer: 1100, omschrijving: "Bank", statement_type: "balans", report_group: "vlottende_activa" });
const KAPITAAL = acc({ id: "a-kap", nummer: 610, omschrijving: "Kapitaal", categorie: "passiva", statement_type: "balans", report_group: "eigen_vermogen" });
const OMZET = acc({ id: "a-omzet", nummer: 8000, omschrijving: "Omzet", categorie: "omzet", statement_type: "winst_verlies", report_group: "netto_omzet" });
const KOSTEN = acc({ id: "a-kosten", nummer: 4700, omschrijving: "Advieskosten", categorie: "kosten", statement_type: "winst_verlies", report_group: "overige_bedrijfskosten" });

/**
 * Precies dezelfde aanroep als useFinancialStatements(), inclusief de twee
 * diagnosekaarten — anders zou de ijking langs een ander pad lopen dan de
 * pagina en dus niets bewijzen.
 */
function engineResult(period = yearPeriod(new Date().getFullYear())) {
  const rows = state.rows.filter(
    (r) => r.client_id === state.clientId && r.posting_date < period.toExclusive,
  );
  const report = buildAccountReport({ rows, clientId: state.clientId, period, accounts: state.accounts });
  return buildFinancialStatements({
    report,
    period,
    accounts: state.accounts,
    openingBalanceContribution: openingBalanceContributionFromRows(rows, period),
    movementOnPeriodStart: movementOnPeriodStartFromRows(rows, period),
  });
}

const renderBalans = () => render(<MemoryRouter initialEntries={["/grootboek/balans"]}><Balans /></MemoryRouter>);
const renderWv = () => render(<MemoryRouter initialEntries={["/grootboek/winst-verlies"]}><WinstVerlies /></MemoryRouter>);

const YEAR = new Date().getFullYear();
const d = (md: string) => `${YEAR}-${md}`;

/** Winst: omzet 1000, kosten 400, kapitaalstorting 5000. */
function winstjaar() {
  state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN];
  state.rows = [
    ...entry(BANK.id, KAPITAAL.id, "5000.00", d("01-01")),
    ...entry(BANK.id, OMZET.id, "1000.00", d("04-01")),
    ...entry(KOSTEN.id, BANK.id, "400.00", d("05-01")),
  ];
}

beforeEach(() => {
  state.rows = [];
  state.accounts = [];
  state.postingsPending = false;
  state.postingsError = null;
  state.accountsPending = false;
  state.accountsError = null;
  state.clientId = "client-1";
  refetchPostings.mockReset();
  refetchAccounts.mockReset();
  setSelectedClientId.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Balans", () => {
  it("1/29. rendert de groepen van de engine, in de volgorde van de engine", () => {
    winstjaar();
    renderBalans();
    const groepen = screen.getAllByTestId("statement-group").map((g) => g.getAttribute("data-group"));
    const engine = engineResult();
    if (!engine.ok) throw new Error("engine faalde");
    const verwacht = [
      ...engine.balanceSheet.assetGroups.map((g) => g.key),
      ...engine.balanceSheet.liabilityEquityGroups.map((g) => g.key),
    ];
    expect(groepen).toEqual(verwacht);
  });

  it("3/8/9. de totalen op het scherm komen letterlijk uit de engine", () => {
    winstjaar();
    const engine = engineResult();
    if (!engine.ok) throw new Error("engine faalde");
    renderBalans();

    const activa = screen.getByTestId("balans-activa-table");
    const passiva = screen.getByTestId("balans-passiva-table");
    expect(within(activa).getByTestId("statement-total")).toHaveTextContent(
      bedrag(engine.balanceSheet.totalAssetsCents),
    );
    expect(within(passiva).getByTestId("statement-total")).toHaveTextContent(
      bedrag(engine.balanceSheet.totalLiabilitiesEquityCents),
    );
  });

  it("10/11. het verschil staat er, en nul levert geen waarschuwing op", () => {
    winstjaar();
    renderBalans();
    const verschil = screen.getByTestId("balans-difference");
    expect(verschil).toHaveAttribute("data-difference", "0");
    expect(verschil).toHaveTextContent(bedrag(0));
    expect(screen.queryByTestId("balans-difference-warning")).toBeNull();
  });

  it("11b. een verschil ongelijk nul waarschuwt zichtbaar", () => {
    // Een niet-geclassificeerde rekening laat de balans niet sluiten.
    state.accounts = [BANK, KAPITAAL, acc({ id: "a-vreemd", nummer: 3000, omschrijving: "Onbekend" })];
    state.rows = [...entry("a-vreemd", KAPITAAL.id, "50.00", d("06-01"))];
    renderBalans();
    const engine = engineResult();
    if (!engine.ok) throw new Error("engine faalde");
    expect(engine.balanceSheet.differenceCents).not.toBe(0);
    expect(screen.getByTestId("balans-difference-warning")).toBeInTheDocument();
    expect(screen.getByTestId("balans-difference")).toHaveTextContent(
      bedrag(engine.balanceSheet.differenceCents),
    );
  });

  it("5/6/25. systeemregels zijn zichtbaar onderscheiden en hebben geen drilldown", () => {
    winstjaar();
    renderBalans();
    const systeem = screen.getAllByTestId("statement-system-line");
    expect(systeem.length).toBe(2);
    for (const rij of systeem) {
      // Geen link, geen rekeningnummer — het is geen grootboekrekening.
      expect(within(rij).queryByRole("link")).toBeNull();
      expect(within(rij).getByText("Berekend")).toBeInTheDocument();
      expect(rij).toHaveTextContent("—");
    }
    expect(screen.getByText(/Resultaat lopend boekjaar/)).toBeInTheDocument();
  });

  it("7. echte rekeningregels linken naar het bestaande saldoscherm", () => {
    winstjaar();
    renderBalans();
    const rij = screen.getAllByTestId("statement-line").find((r) => r.getAttribute("data-account-id") === BANK.id)!;
    const link = within(rij).getByRole("link");
    expect(link).toHaveAttribute("href", `/grootboek/saldi/${BANK.id}`);
  });

  it("32. privé staat aan de passivakant en gaat van het vermogen af", () => {
    const prive = acc({ id: "a-prive", nummer: 651, omschrijving: "Privé-opnamen", categorie: "privé", statement_type: "balans", report_group: "prive" });
    state.accounts = [BANK, KAPITAAL, prive];
    state.rows = [
      ...entry(BANK.id, KAPITAAL.id, "5000.00", d("01-01")),
      ...entry("a-prive", BANK.id, "1000.00", d("06-01")),
    ];
    renderBalans();
    const passiva = screen.getByTestId("balans-passiva-table");
    const rij = within(passiva).getAllByTestId("statement-line").find((r) => r.getAttribute("data-account-id") === "a-prive")!;
    expect(rij).toHaveTextContent(bedrag(-100_000));
    expect(within(passiva).getByTestId("statement-total")).toHaveTextContent(bedrag(400_000));
    expect(screen.getByTestId("balans-difference")).toHaveAttribute("data-difference", "0");
  });

  it("31. een tegenrekening houdt het bedrag van de engine en wordt als zodanig gemarkeerd", () => {
    const machine = acc({ id: "a-mach", nummer: 31, omschrijving: "Machines", statement_type: "balans", report_group: "vaste_activa" });
    const cumul = acc({ id: "a-cum", nummer: 32, omschrijving: "Machines afschrijving", statement_type: "balans", report_group: "vaste_activa", normal_side: "credit" });
    const afs = acc({ id: "a-afs", nummer: 4103, omschrijving: "Afschrijvingskosten", statement_type: "winst_verlies", report_group: "afschrijvingen" });
    state.accounts = [machine, cumul, afs, KAPITAAL];
    state.rows = [
      ...entry("a-mach", KAPITAAL.id, "1000.00", d("01-01")),
      ...entry("a-afs", "a-cum", "300.00", d("12-01")),
    ];
    renderBalans();
    const rij = screen.getAllByTestId("statement-line").find((r) => r.getAttribute("data-account-id") === "a-cum")!;
    expect(rij).toHaveTextContent(bedrag(-30_000));
    expect(within(rij).getByText("Tegenrekening")).toBeInTheDocument();
    const activa = screen.getByTestId("balans-activa-table");
    expect(within(activa).getByTestId("statement-total")).toHaveTextContent(bedrag(70_000));
  });

  it("30. report_sort bepaalt de volgorde binnen een groep", () => {
    const eerst = acc({ id: "a-2", nummer: 1200, omschrijving: "Tweede nummer", statement_type: "balans", report_group: "vlottende_activa", report_sort: 1 });
    const laatst = acc({ id: "a-1", nummer: 1100, omschrijving: "Eerste nummer", statement_type: "balans", report_group: "vlottende_activa", report_sort: 9 });
    state.accounts = [eerst, laatst, KAPITAAL];
    state.rows = [
      ...entry("a-1", KAPITAAL.id, "100.00", d("03-01")),
      ...entry("a-2", KAPITAAL.id, "100.00", d("03-01")),
    ];
    renderBalans();
    const activa = screen.getByTestId("balans-activa-table");
    const ids = within(activa).getAllByTestId("statement-line").map((r) => r.getAttribute("data-account-id"));
    expect(ids).toEqual(["a-2", "a-1"]);
  });

  it("24. lege periode toont een lege staat, geen nulbalans die echt lijkt", () => {
    state.accounts = [BANK, KAPITAAL];
    state.rows = [];
    renderBalans();
    expect(screen.getByText(/Nog geen geboekte grootboekmutaties/)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Winst-en-verliesrekening", () => {
  it("2. rendert de groepen van de engine", () => {
    winstjaar();
    renderWv();
    const engine = engineResult();
    if (!engine.ok) throw new Error("engine faalde");
    const groepen = screen.getAllByTestId("statement-group").map((g) => g.getAttribute("data-group"));
    expect(groepen).toEqual(engine.profitLoss.groups.map((g) => g.key));
  });

  it("12/13. het resultaat komt uit de engine en een winst leest als winst", () => {
    winstjaar();
    const engine = engineResult();
    if (!engine.ok) throw new Error("engine faalde");
    renderWv();
    const resultaat = screen.getByTestId("wv-result");
    expect(engine.profitLoss.netResultCents).toBe(60_000);
    expect(resultaat).toHaveAttribute("data-result", String(engine.profitLoss.netResultCents));
    expect(resultaat).toHaveTextContent(bedrag(engine.profitLoss.netResultCents));
    expect(resultaat).toHaveTextContent("winst");
    // Ook de totaalregel van de tabel is het resultaat van de engine.
    expect(screen.getByTestId("statement-total")).toHaveTextContent(bedrag(engine.profitLoss.netResultCents));
  });

  it("14. een verlies leest als verlies", () => {
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN];
    state.rows = [
      ...entry(BANK.id, KAPITAAL.id, "5000.00", d("01-01")),
      ...entry(BANK.id, OMZET.id, "100.00", d("04-01")),
      ...entry(KOSTEN.id, BANK.id, "450.00", d("05-01")),
    ];
    renderWv();
    const resultaat = screen.getByTestId("wv-result");
    expect(resultaat).toHaveAttribute("data-result", "-35000");
    expect(resultaat).toHaveTextContent("verlies");
  });

  it("3. opbrengsten en kosten komen letterlijk uit de engine", () => {
    winstjaar();
    const engine = engineResult();
    if (!engine.ok) throw new Error("engine faalde");
    renderWv();
    expect(screen.getByTestId("wv-revenue")).toHaveTextContent(bedrag(engine.profitLoss.revenueCents));
    expect(screen.getByTestId("wv-expense")).toHaveTextContent(bedrag(engine.profitLoss.expenseCents));
  });

  it("22. een beginbalansbijdrage aan de W&V wordt gemeld", () => {
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN];
    state.rows = [
      ...entry(BANK.id, OMZET.id, "700.00", d("07-01"), "opening_balance"),
      ...entry(BANK.id, OMZET.id, "300.00", d("09-01")),
    ];
    renderWv();
    const notice = screen.getByTestId("statement-opening-contribution");
    expect(notice).toHaveTextContent(/openings-\/cutoverbedragen/);
    expect(notice).toHaveTextContent(bedrag(70_000));
  });

  it("22b. beginbalansposten die tegen elkaar wegvallen worden nog steeds gemeld", () => {
    // Een saldo van nul betekent niet "geen cutover": €700 opbrengst tegenover
    // €700 kosten heft elkaar op, maar er zit wél €1.400 aan openingsbedragen
    // in dit rapport. Dat mag niet stilzwijgend verdwijnen.
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN];
    state.rows = [
      ...entry(BANK.id, OMZET.id, "700.00", d("07-01"), "opening_balance"),
      ...entry(KOSTEN.id, BANK.id, "700.00", d("07-01"), "opening_balance"),
    ];
    const engine = engineResult();
    if (!engine.ok) throw new Error("engine faalde");
    expect(engine.profitLoss.openingBalanceContributionCents).toBe(0);
    expect(engine.diagnostics.openingBalanceInsidePeriod).toBe(true);

    renderWv();
    expect(screen.getByTestId("statement-opening-contribution")).toHaveTextContent(/tegen elkaar wegvallen/);
  });

  it("23. zonder beginbalansposten verschijnt er geen melding — en nooit een nul als bevestiging", () => {
    winstjaar();
    renderWv();
    expect(screen.queryByTestId("statement-opening-contribution")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("niet geclassificeerd en volledigheid", () => {
  const metVreemdeRekening = () => {
    state.accounts = [BANK, KAPITAAL, acc({ id: "a-vreemd", nummer: 3000, omschrijving: "Onbekende post", categorie: "kosten" })];
    state.rows = [
      ...entry(BANK.id, KAPITAAL.id, "5000.00", d("01-01")),
      ...entry("a-vreemd", BANK.id, "50.00", d("06-01")),
    ];
  };

  it("15/16. niet-geclassificeerde rekeningen zijn zichtbaar, met bedrag en reden", () => {
    metVreemdeRekening();
    renderBalans();
    const sectie = screen.getByTestId("balans-unclassified");
    const rij = within(sectie).getByTestId("statement-unclassified-row");
    expect(rij).toHaveAttribute("data-account-id", "a-vreemd");
    expect(rij).toHaveTextContent("3000");
    expect(rij).toHaveTextContent("Onbekende post");
    expect(rij).toHaveTextContent(bedrag(5_000));
    expect(within(rij).getByText("Geen rapport gekozen")).toBeInTheDocument();
  });

  it("15b. de waarschuwing en de link naar het rekeningschema staan erbij", () => {
    metVreemdeRekening();
    renderBalans();
    const waarschuwing = screen.getByTestId("statement-unclassified-warning");
    expect(waarschuwing).toHaveTextContent(
      "Dit rapport is niet volledig zolang actieve grootboekrekeningen niet zijn geclassificeerd.",
    );
    expect(within(waarschuwing).getByRole("link")).toHaveAttribute("href", "/grootboek");
  });

  it("16b. ook op de W&V verdwijnt niet-geclassificeerde activiteit niet", () => {
    metVreemdeRekening();
    renderWv();
    expect(within(screen.getByTestId("wv-unclassified")).getByTestId("statement-unclassified-row")).toBeInTheDocument();
  });

  it("18b. een ongeclassificeerde rekening zónder beweging spreekt de groene status niet tegen", () => {
    // Twee openingsboekingen die elkaar opheffen: de rekening wacht op
    // classificatie, maar er is niets bewogen. De engine noemt het rapport dan
    // volledig, dus de sectie mag geen rood alarm tonen.
    state.accounts = [BANK, KAPITAAL, acc({ id: "a-stil", nummer: 3100, omschrijving: "Stille rekening" })];
    state.rows = [
      ...entry(BANK.id, KAPITAAL.id, "5000.00", `${YEAR - 1}-01-01`),
      ...entry("a-stil", BANK.id, "500.00", `${YEAR - 1}-06-01`),
      ...entry(BANK.id, "a-stil", "500.00", `${YEAR - 1}-07-01`),
    ];
    renderBalans();
    expect(screen.getByTestId("statement-completeness")).toHaveAttribute("data-completeness", "complete");
    const waarschuwing = screen.getByTestId("statement-unclassified-warning");
    expect(waarschuwing).toHaveAttribute("data-has-activity", "false");
    expect(waarschuwing).toHaveTextContent(/geen beweging/);
    // De rekening blijft wél zichtbaar.
    expect(screen.getByTestId("statement-unclassified-row")).toHaveAttribute("data-account-id", "a-stil");
  });

  it("17. onvolledig wordt zichtbaar als status", () => {
    metVreemdeRekening();
    renderBalans();
    const badge = screen.getByTestId("statement-completeness");
    expect(badge).toHaveAttribute("data-completeness", "incomplete");
    expect(badge).toHaveTextContent("Onvolledig");
  });

  it("18. volledig wordt zichtbaar als status en geeft geen waarschuwing", () => {
    winstjaar();
    renderBalans();
    const badge = screen.getByTestId("statement-completeness");
    expect(badge).toHaveAttribute("data-completeness", "complete");
    expect(badge).toHaveTextContent("Volledig");
    expect(screen.queryByTestId("statement-completeness-notice")).toBeNull();
  });

  it("20. een periode die geen heel boekjaar is heet 'Controle vereist' en is nooit groen", () => {
    winstjaar();
    renderBalans();
    fireEvent.change(screen.getByLabelText("Van"), { target: { value: d("07-01") } });
    fireEvent.change(screen.getByLabelText("Tot en met"), { target: { value: d("09-30") } });
    fireEvent.click(screen.getByRole("button", { name: /periode toepassen/i }));

    const badge = screen.getByTestId("statement-completeness");
    expect(badge).toHaveAttribute("data-completeness", "ambiguous");
    expect(badge).toHaveTextContent("Controle vereist");
    expect(badge.className).not.toMatch(/green/);
    expect(screen.getByTestId("statement-completeness-notice")).toBeInTheDocument();
  });

  it("19/21. een falende kern toont fail-closed en géén cijfers", () => {
    // Eén losse regel: de boekingsgroep is niet in balans.
    state.accounts = [BANK, KAPITAAL];
    state.rows = [
      {
        id: "x1", client_id: "client-1", grootboekrekening_id: BANK.id, posting_group_id: "gx", line_no: 1,
        posting_date: d("03-01"), boekjaar: YEAR, debit_amount: "100.00", credit_amount: "0.00",
        currency: "EUR", source_type: "manual_journal",
      },
    ];
    renderBalans();
    expect(screen.getByTestId("statement-failed")).toBeInTheDocument();
    expect(screen.getByText(/zelfcontrole van de rapportagekern/i)).toBeInTheDocument();
    // Geen tabellen, geen totalen, geen verschil.
    expect(screen.queryByTestId("balans-activa-table")).toBeNull();
    expect(screen.queryByTestId("balans-difference")).toBeNull();
    expect(screen.getByTestId("balans-export")).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("administratie en periode", () => {
  it("27/28. alleen de gekozen administratie wordt getoond", () => {
    state.accounts = [BANK, KAPITAAL];
    state.rows = [
      ...entry(BANK.id, KAPITAAL.id, "5000.00", d("01-01"), "manual_journal", "client-1"),
      ...entry(BANK.id, KAPITAAL.id, "9999.00", d("02-01"), "manual_journal", "client-2"),
    ];
    renderBalans();
    // 9999 hoort bij een andere administratie en mag nergens verschijnen.
    expect(screen.queryByText(/9\.999,00/)).toBeNull();
    const activa = screen.getByTestId("balans-activa-table");
    expect(within(activa).getByTestId("statement-total")).toHaveTextContent(bedrag(500_000));
  });

  it("27b. zonder specifieke administratie wordt er niets berekend", () => {
    state.clientId = "all";
    state.accounts = [BANK, KAPITAAL];
    state.rows = [...entry(BANK.id, KAPITAAL.id, "5000.00", d("01-01"))];
    renderBalans();
    expect(screen.getByText(/Kies eerst een specifieke administratie/)).toBeInTheDocument();
    expect(screen.queryByTestId("balans-activa-table")).toBeNull();
  });

  it("25/26. de jaarkeuze gebruikt de bestaande periodesemantiek", () => {
    winstjaar();
    renderBalans();
    expect(screen.getByTestId("balans-period-label")).toHaveTextContent(String(YEAR));
    fireEvent.click(screen.getByRole("button", { name: String(YEAR - 1) }));
    expect(screen.getByTestId("balans-period-label")).toHaveTextContent(String(YEAR - 1));
    // Vorig jaar heeft geen mutaties in deze fixture.
    expect(screen.getByText(/Nog geen geboekte grootboekmutaties/)).toBeInTheDocument();
  });

  it("een laadfout van het grootboek toont een herstelbare melding, geen cijfers", () => {
    state.postingsError = { message: "Netwerkfout" };
    state.accounts = [BANK, KAPITAAL];
    renderBalans();
    expect(screen.getByTestId("balans-error")).toHaveTextContent("Netwerkfout");
    fireEvent.click(screen.getByRole("button", { name: /opnieuw proberen/i }));
    expect(refetchPostings).toHaveBeenCalled();
  });

  it("zonder rekeningschema wordt er geen rapport getoond", () => {
    state.accountsError = { message: "Schema onbereikbaar" };
    state.rows = [...entry("a-bank", "a-kap", "100.00", d("03-01"))];
    renderBalans();
    expect(screen.getByTestId("balans-error")).toHaveTextContent(/Rekeningschema laden is mislukt/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("statische grenzen", () => {
  const bronnen = [
    "src/pages/Balans.tsx",
    "src/pages/WinstVerlies.tsx",
    "src/components/overzichten/FinancialStatementTable.tsx",
    "src/components/overzichten/FinancialReportNotices.tsx",
    "src/components/overzichten/FinancialCompletenessBadge.tsx",
    "src/components/overzichten/FinancialReportHeader.tsx",
    "src/lib/financial-statements-presentation.ts",
    "src/hooks/useFinancialStatements.ts",
  ].map((p) => ({ p, code: strip(readFileSync(p, "utf8")) }));

  function strip(src: string) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  }

  it("4. de UI rekent niet: geen optelling, geen tekenomklap, geen verschilberekening", () => {
    // De gedeelde hook mág de kern en de engine aanroepen — dát is de
    // datastroom. Geen enkele pagina of component mag dat.
    const hook = bronnen.find((b) => b.p.endsWith("useFinancialStatements.ts"))!;
    const presentatie = bronnen.filter((b) => b !== hook);

    // In deze bestanden komt elk bedrag binnen als member-expressie
    // (`balanceSheet.totalAssetsCents`, `line.displayedCents`), dus de patronen
    // moeten daar óók op aanslaan — anders bewaken ze precies de schrijfwijze
    // niet die hier gebruikt zou worden.
    const REKENT = [
      /(?:\.|\b)\w*Cents\b\s*[+\-*/]\s/, //  a.xCents - b.yCents  /  xCents + 1
      /[+\-*/]=\s*[\w.]*Cents\b/, //          total += line.displayedCents
      /[-+]\s*[\w.]*Cents\b/, //           unaire min/plus op een bedrag
      /\.reduce\(/,
    ];

    for (const { p, code } of presentatie) {
      for (const patroon of REKENT) {
        expect(code, `${p} — ${patroon}`).not.toMatch(patroon);
      }
      expect(code, p).not.toMatch(/buildAccountReport|toCents\(|signedAmountCents/);
      expect(code, p).not.toMatch(/buildFinancialStatements\(/);
    }

    // En de hook zelf rekent ook niet: hij geeft door.
    expect(hook.code).toContain("buildFinancialStatements(");
    for (const patroon of REKENT) {
      expect(hook.code, `hook — ${patroon}`).not.toMatch(patroon);
    }
  });

  it("4b. de bewaking slaat werkelijk aan op de manier waarop hier gerekend zóu worden", () => {
    // Zonder deze controle zou een te nauwe regex ongemerkt niets bewaken.
    const REKENT = [
      /(?:\.|\b)\w*Cents\b\s*[+\-*/]\s/,
      /[+\-*/]=\s*[\w.]*Cents\b/,
      /[-+]\s*[\w.]*Cents\b/,
      /\.reduce\(/,
    ];
    const overtredingen = [
      "const diff = balanceSheet.totalAssetsCents - balanceSheet.totalLiabilitiesEquityCents;",
      "let t = 0; for (const l of group.lines) t += l.displayedCents;",
      "formatCents(a.displayedCents + b.displayedCents)",
      "const netto = -profitLoss.netResultCents;",
      "const totaal = lines.reduce((s, l) => s + l.displayedCents, 0);",
    ];
    for (const regel of overtredingen) {
      expect(REKENT.some((p) => p.test(regel)), regel).toBe(true);
    }
  });

  it("33/34/35. geen classificatie op rekeningnummer, categorie of een vaste sluitrekening", () => {
    for (const { p, code } of bronnen) {
      expect(code, p).not.toMatch(/9998|9999|2010|2011/);
      expect(code, p).not.toMatch(/nummer\s*[<>]=?\s*\d/);
      expect(code, p).not.toMatch(/classifyLedgerCategory|KNOWN_LEDGER_CATEGORIES/);
    }
  });

  it("36/37/38. geen beginbalansregels, journaalposten of documenttotalen", () => {
    for (const { p, code } of bronnen) {
      expect(code, p).not.toMatch(/opening_balance_lines|journal_entries/);
      expect(code, p).not.toMatch(/purchase_invoice|sales_invoice|bank_transaction/);
      expect(code, p).not.toMatch(/amount_incl|amount_excl|btw_amount/);
    }
  });

  it("43/44. de kern en de engine zijn byte-voor-byte ongewijzigd", () => {
    let base: string;
    try {
      base = execFileSync("git", ["show", "origin/main:src/lib/ledger-reporting.ts"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return; // origin/main niet beschikbaar: overslaan, niet vals slagen
    }
    expect(readFileSync("src/lib/ledger-reporting.ts", "utf8")).toBe(base);
    expect(readFileSync("src/lib/financial-statements.ts", "utf8")).toBe(
      execFileSync("git", ["show", "origin/main:src/lib/financial-statements.ts"], { encoding: "utf8" }),
    );
    expect(readFileSync("src/lib/proef-saldibalans.ts", "utf8")).toBe(
      execFileSync("git", ["show", "origin/main:src/lib/proef-saldibalans.ts"], { encoding: "utf8" }),
    );
  });

  it("de routes hangen onder Grootboek en er komt geen nav-item bij", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toMatch(/path="\/grootboek\/balans"/);
    expect(app).toMatch(/path="\/grootboek\/winst-verlies"/);
    const nav = readFileSync("src/components/layout/nav.ts", "utf8");
    expect(nav).not.toMatch(/balans|winst-verlies/i);
  });
});

describe("branch-scope", () => {
  function changedFiles(): string[] | null {
    try {
      return execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).split("\n").filter(Boolean);
    } catch {
      return null;
    }
  }
  const changed = changedFiles();
  const branchIt = changed === null ? it.skip : it;

  branchIt("39/40. geen migratie en geen SQL", () => {
    expect(changed!.filter((f) => f.startsWith("supabase/"))).toEqual([]);
    expect(changed!.filter((f) => f.endsWith(".sql"))).toEqual([]);
  });

  branchIt("41. de gegenereerde types zijn ongewijzigd", () => {
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
  });

  branchIt("42. geen afhankelijkheidswijziging", () => {
    expect(changed).not.toContain("package.json");
    expect(changed!.filter((f) => /package-lock\.json|bun\.lockb|pnpm-lock\.yaml|yarn\.lock/.test(f))).toEqual([]);
  });

  branchIt("43/44b. kern, engine en proef- en saldibalans staan niet in de diff", () => {
    for (const f of ["src/lib/ledger-reporting.ts", "src/lib/financial-statements.ts", "src/lib/proef-saldibalans.ts"]) {
      expect(changed, f).not.toContain(f);
    }
  });
});
