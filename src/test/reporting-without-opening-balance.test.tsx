import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Fix — rapportage zonder beginbalans.
 *
 * De beginbalans is een OVERLOOP- en VOLLEDIGHEIDSgegeven, geen
 * zichtbaarheidsvoorwaarde. Deze tests leggen vast dat bekende cijfers uit
 * ledger_postings altijd zichtbaar blijven, ook als er geen beginbalans is —
 * en dat ze even zichtbaar blijven wanneer er wél één is.
 *
 * De fixtures lopen door de échte kern, de échte proef- en saldibalans en de
 * échte statement-engine; alleen de dataleverende hooks zijn gemockt. Alles in
 * hele centen.
 */

const state = {
  rows: [] as any[],
  accounts: [] as any[],
  clientId: "client-1" as string,
  obState: "not_set" as string,
  obSeverity: "incomplete" as "complete" | "incomplete" | "unknown",
  /** Elke aanroep van useLedgerCompleteness, om de `enabled`-schakelaar te zien. */
  completenessCalls: [] as { clientId: string | undefined; enabled: boolean | undefined }[],
};

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.clientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "client-1", name: "Klant A" }, { id: "client-2", name: "Klant B" }] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({
    data: state.accounts, isPending: false, isError: false, error: null, refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/useLedgerCompleteness", () => ({
  useLedgerCompleteness: (clientId: string | undefined, options?: { enabled?: boolean }) => {
    state.completenessCalls.push({ clientId, enabled: options?.enabled });
    return { data: undefined, isPending: false, isError: false };
  },
  useOpeningBalanceCompleteness: () => ({
    data: {
      state: state.obState, year: 2026, assertionYear: null, draftCount: 0,
      label: state.obState === "posted" ? "Geboekt" : "Niet ingesteld",
      severity: state.obSeverity, note: null,
    },
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/hooks/useLedgerPostings", () => ({
  useLedgerPostings: (opts: any) => ({
    data: opts?.clientId
      ? state.rows.filter((r) => r.client_id === opts.clientId && r.posting_date < opts.period.toExclusive)
      : undefined,
    isPending: false, isError: false, error: null, refetch: vi.fn(),
  }),
}));

import Balans, { BALANS_EMPTY_MESSAGE } from "@/pages/Balans";
import WinstVerlies from "@/pages/WinstVerlies";
import {
  attributeUnclassifiedAccount,
  unclassifiedRelevanceFor,
} from "@/lib/unclassified-attribution";
import { buildAccountReport, yearPeriod, type LedgerPostingLike } from "@/lib/ledger-reporting";
import { buildTrialBalance } from "@/lib/proef-saldibalans";
import {
  buildFinancialStatements,
  movementOnPeriodStartFromRows,
  openingBalanceContributionFromRows,
} from "@/lib/financial-statements";
import { formatCents } from "@/lib/financial-statements-presentation";

const bedrag = (cents: number) => formatCents(cents).replace(/\u00a0/g, " ");

const CLIENT = "client-1";
const YEAR = new Date().getFullYear();
const PERIOD = yearPeriod(YEAR);
const d = (md: string) => `${YEAR}-${md}`;

let seq = 0;
/** Eén balanced boekingsgroep. */
function entry(
  debit: string,
  credit: string,
  amount: string,
  date: string,
  sourceType = "manual_journal",
  client = CLIENT,
): LedgerPostingLike[] {
  seq++;
  const g = `g-${seq}`;
  const base = {
    client_id: client, posting_group_id: g, posting_date: date,
    boekjaar: Number(date.slice(0, 4)), currency: "EUR", source_type: sourceType,
  };
  return [
    { ...base, id: `${g}-1`, line_no: 1, grootboekrekening_id: debit, debit_amount: amount, credit_amount: "0.00" },
    { ...base, id: `${g}-2`, line_no: 2, grootboekrekening_id: credit, debit_amount: "0.00", credit_amount: amount },
  ];
}

const acc = (over: any) => ({
  nummer: 1000, omschrijving: "Rekening", categorie: "activa", actief: true,
  statement_type: null, report_group: null, normal_side: null, report_sort: null, ...over,
});

const BANK = acc({ id: "bank", nummer: 1100, omschrijving: "Bank", statement_type: "balans", report_group: "vlottende_activa" });
const KAPITAAL = acc({ id: "kap", nummer: 610, omschrijving: "Kapitaal", categorie: "passiva", statement_type: "balans", report_group: "eigen_vermogen" });
const OMZET = acc({ id: "omzet", nummer: 8000, omschrijving: "Omzet", categorie: "omzet", statement_type: "winst_verlies", report_group: "netto_omzet" });
const KOSTEN = acc({ id: "kosten", nummer: 4700, omschrijving: "Advieskosten", categorie: "kosten", statement_type: "winst_verlies", report_group: "overige_bedrijfskosten" });

/** Lopend jaar, ZONDER beginbalansrijen: omzet 1000, kosten 400. */
function lopendJaarZonderBeginbalans() {
  state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN];
  state.rows = [
    ...entry(BANK.id, OMZET.id, "1000.00", d("04-01")),
    ...entry(KOSTEN.id, BANK.id, "400.00", d("05-01")),
  ];
}

/**
 * Exact dezelfde aanroep als useFinancialStatements(), inclusief de twee
 * diagnosekaarten. Zonder die kaarten zou deze helper een ánder pad meten dan
 * de pagina en zouden de asserties niets over de productie zeggen.
 */
const engine = (period = PERIOD) => {
  const rows = state.rows.filter((r) => r.client_id === state.clientId && r.posting_date < period.toExclusive);
  const report = buildAccountReport({ rows, clientId: state.clientId, period, accounts: state.accounts });
  return {
    report,
    fs: buildFinancialStatements({
      report,
      period,
      accounts: state.accounts as any,
      openingBalanceContribution: openingBalanceContributionFromRows(rows, period),
      movementOnPeriodStart: movementOnPeriodStartFromRows(rows, period),
    }),
  };
};

const renderBalans = () => render(<MemoryRouter><Balans /></MemoryRouter>);
const renderWv = () => render(<MemoryRouter><WinstVerlies /></MemoryRouter>);

beforeEach(() => {
  state.rows = [];
  state.accounts = [];
  state.clientId = CLIENT;
  state.obState = "not_set";
  state.obSeverity = "incomplete";
  state.completenessCalls = [];
});

/** De laatste `enabled` waarmee de pagina de documentvolledigheid opvroeg. */
const laatsteCompletenessEnabled = () => state.completenessCalls[state.completenessCalls.length - 1]?.enabled;

// ─────────────────────────────────────────────────────────────────────────────
describe("zonder beginbalans blijven de cijfers zichtbaar", () => {
  it("1. W&V toont de periodemutaties zonder één beginbalansrij", () => {
    lopendJaarZonderBeginbalans();
    const { fs } = engine();
    if (!fs.ok) throw new Error("engine faalde");
    // Geen enkele boeking is een beginbalans.
    expect(state.rows.every((r) => r.source_type !== "opening_balance")).toBe(true);
    expect(fs.profitLoss.netResultCents).toBe(60_000);

    renderWv();
    expect(screen.getByTestId("wv-revenue")).toHaveTextContent(bedrag(100_000));
    expect(screen.getByTestId("wv-expense")).toHaveTextContent(bedrag(40_000));
    expect(screen.getByTestId("wv-result")).toHaveAttribute("data-result", "60000");
    // De omzetregel staat er echt, niet alleen het totaal.
    const omzet = screen.getAllByTestId("statement-line").find((r) => r.getAttribute("data-account-id") === OMZET.id)!;
    expect(omzet).toHaveTextContent(bedrag(100_000));
  });

  it("2. Balans toont eindsaldi zonder één beginbalansrij", () => {
    lopendJaarZonderBeginbalans();
    renderBalans();
    const activa = screen.getByTestId("balans-activa-table");
    // Bank = 1000 ontvangen − 400 betaald = 600.
    expect(within(activa).getByTestId("statement-total")).toHaveTextContent(bedrag(60_000));
    const bank = within(activa).getAllByTestId("statement-line").find((r) => r.getAttribute("data-account-id") === BANK.id)!;
    expect(bank).toHaveTextContent(bedrag(60_000));
    // De balans sluit dankzij de synthetische resultaatregel.
    expect(screen.getByTestId("balans-difference")).toHaveAttribute("data-difference", "0");
  });

  it("3. Proef-/saldibalans toont debet, credit en saldo zonder beginbalans", () => {
    lopendJaarZonderBeginbalans();
    const { report } = engine();
    const tb = buildTrialBalance({ report, accounts: state.accounts, clientId: CLIENT });
    expect(tb.ok).toBe(true);
    if (tb.ok !== true) return;
    expect(tb.rows.length).toBe(3);
    expect(tb.totals.periodDebitCents).toBe(140_000);
    expect(tb.totals.periodCreditCents).toBe(140_000);
    expect(tb.totals.closingDebitCents).toBe(100_000);
    expect(tb.totals.closingCreditCents).toBe(100_000);
    // Beginsaldo is nul omdat er niets vóór de periode staat — niet omdat er
    // een beginbalans ontbreekt.
    expect(tb.totals.openingDebitCents).toBe(0);
    expect(tb.totals.openingCreditCents).toBe(0);
    const omzetRij = tb.rows.find((r) => r.account.id === OMZET.id)!;
    expect(omzetRij.periodCreditCents).toBe(100_000);
    expect(omzetRij.closingCreditCents).toBe(100_000);
  });

  it("5. een ontbrekende beginbalans is nooit een enginefout", () => {
    lopendJaarZonderBeginbalans();
    const { report, fs } = engine();
    expect(report.ok).toBe(true);
    expect(fs.ok).toBe(true);
    renderBalans();
    expect(screen.queryByTestId("statement-failed")).toBeNull();
    expect(screen.getByTestId("balans-activa-table")).toBeInTheDocument();
  });

  it("6. een ontbrekende beginbalans mag de volledigheid raken, nooit de zichtbaarheid", () => {
    lopendJaarZonderBeginbalans();
    renderBalans();
    // De overloopmelding staat er…
    const notice = screen.getByTestId("statement-carry-forward");
    expect(notice).toHaveAttribute("data-ob-state", "not_set");
    // …en de cijfers óók.
    expect(screen.getByTestId("balans-activa-table")).toBeInTheDocument();
    expect(screen.getAllByTestId("statement-line").length).toBeGreaterThan(0);
  });

  it("11. er wordt geen beginbalansbedrag verzonnen", () => {
    lopendJaarZonderBeginbalans();
    const { report } = engine();
    if (report.ok !== true) throw new Error("kern faalde");
    // Elke rekening heeft beginsaldo 0 omdat er niets vóór de periode geboekt
    // is — er is nergens een bedrag bijgemaakt.
    for (const r of report.rollups) expect(r.openingCents).toBe(0);
    expect(report.totals.openingCents).toBe(0);
    const { fs } = engine();
    if (!fs.ok) throw new Error("engine faalde");
    expect(fs.profitLoss.openingCents).toBe(0);
    // De app geeft de bijdragekaart altijd mee, dus dit is een BEREKENDE nul:
    // er is werkelijk geen beginbalansrij in de periode. Dat is iets anders dan
    // een verzonnen nul — en de melding leunt daarom op `insidePeriod`, niet op
    // het saldo (zie openingContributionNotice).
    expect(fs.diagnostics.openingBalanceContributionKnown).toBe(true);
    expect(fs.profitLoss.openingBalanceContributionCents).toBe(0);
    expect(fs.diagnostics.openingBalanceInsidePeriod).toBe(false);
  });
});

describe("lege staat en echte beginbalans", () => {
  it("4. geen beginbalans én geen mutaties → geldige lege staat", () => {
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN];
    state.rows = [];
    renderBalans();
    expect(screen.getByText(/Nog geen geboekte grootboekmutaties/)).toBeInTheDocument();
    expect(screen.queryByTestId("balans-activa-table")).toBeNull();
  });

  it("13. mét een echte beginbalans werkt het rapport nog steeds", () => {
    state.obState = "posted";
    state.obSeverity = "complete";
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN];
    state.rows = [
      ...entry(BANK.id, KAPITAAL.id, "2500.00", d("01-01"), "opening_balance"),
      ...entry(BANK.id, OMZET.id, "1000.00", d("04-01")),
    ];
    renderBalans();
    const activa = screen.getByTestId("balans-activa-table");
    // 2500 beginbalans + 1000 omzet = 3500.
    expect(within(activa).getByTestId("statement-total")).toHaveTextContent(bedrag(350_000));
    expect(screen.getByTestId("balans-difference")).toHaveAttribute("data-difference", "0");
    // Bij een geboekte beginbalans verdwijnt de overloopmelding.
    expect(screen.queryByTestId("statement-carry-forward")).toBeNull();
  });

  it("14. beginbalansrijen tellen precies één keer mee", () => {
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN];
    state.rows = [...entry(BANK.id, KAPITAAL.id, "2500.00", d("01-01"), "opening_balance")];
    const alsBeginbalans = engine().fs;
    // Dezelfde rijen, maar als memoriaal: identiek beeld, dus de bron wordt
    // nergens een tweede keer opgeteld.
    state.rows = [...entry(BANK.id, KAPITAAL.id, "2500.00", d("01-01"), "manual_journal")];
    const alsMemoriaal = engine().fs;
    if (!alsBeginbalans.ok || !alsMemoriaal.ok) throw new Error("engine faalde");
    expect(alsBeginbalans.balanceSheet.totalAssetsCents).toBe(250_000);
    expect(alsMemoriaal.balanceSheet.totalAssetsCents).toBe(250_000);
  });

  it("15. periodefiltering blijft kloppen: vorig jaar telt als beginsaldo, niet als mutatie", () => {
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN];
    state.rows = [
      ...entry(BANK.id, OMZET.id, "900.00", `${YEAR - 1}-06-01`),
      ...entry(BANK.id, OMZET.id, "100.00", d("06-01")),
    ];
    const { report, fs } = engine();
    if (report.ok !== true || !fs.ok) throw new Error("engine faalde");
    const bank = report.rollups.find((r) => r.account.id === BANK.id)!;
    expect(bank.openingCents).toBe(90_000); // vorig jaar
    expect(bank.periodDebitCents).toBe(10_000); // dit jaar
    expect(bank.closingCents).toBe(100_000);
    // Alleen de mutatie van dit jaar is resultaat van dit jaar.
    expect(fs.profitLoss.netResultCents).toBe(10_000);
  });
});

describe("classificatie wist nooit activiteit", () => {
  /** Zoals een echte database na de classificatiemigratie: alles NULL. */
  function nietsGeclassificeerd() {
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN].map((a) => ({
      ...a, statement_type: null, report_group: null, normal_side: null, report_sort: null,
    }));
    state.rows = [
      ...entry(BANK.id, OMZET.id, "1000.00", d("04-01")),
      ...entry(KOSTEN.id, BANK.id, "400.00", d("05-01")),
    ];
  }

  it("7. een geclassificeerde balansrekening met activiteit verschijnt", () => {
    lopendJaarZonderBeginbalans();
    renderBalans();
    const rij = screen.getAllByTestId("statement-line").find((r) => r.getAttribute("data-account-id") === BANK.id);
    expect(rij).toBeDefined();
  });

  it("8. een geclassificeerde W&V-rekening met activiteit verschijnt", () => {
    lopendJaarZonderBeginbalans();
    renderWv();
    const rij = screen.getAllByTestId("statement-line").find((r) => r.getAttribute("data-account-id") === KOSTEN.id);
    expect(rij).toBeDefined();
  });

  it("9. een ongeclassificeerde rekening met activiteit blijft zichtbaar, mét bedrag", () => {
    nietsGeclassificeerd();
    renderBalans();
    const sectie = screen.getByTestId("balans-unclassified");
    const rijen = within(sectie).getAllByTestId("statement-unclassified-row");
    expect(rijen).toHaveLength(3);
    const bankRij = rijen.find((r) => r.getAttribute("data-account-id") === BANK.id)!;
    expect(bankRij).toHaveTextContent(bedrag(60_000));
  });

  it("9b. een leeg overzicht door ontbrekende classificatie wordt uitgelegd, niet verzwegen", () => {
    nietsGeclassificeerd();
    renderBalans();
    const melding = screen.getByTestId("statement-nothing-classified");
    // statement_type én report_group zijn leeg, dus er is niets waaruit blijkt
    // dat deze rekeningen voor de BALANS bedoeld waren. De melding noemt de
    // activiteit en houdt zich bij de oorzaak op de vlakte — geen stellige
    // bewering die de metadata niet draagt.
    expect(melding).toHaveAttribute("data-certainty", "onbepaald");
    expect(melding).toHaveAttribute("data-relevant", "0");
    expect(melding).toHaveTextContent(/niet vast te stellen/i);
    expect(melding).toHaveTextContent(/3 rekeningen/);
    expect(within(melding).getByRole("link", { name: /classificeren/i })).toHaveAttribute("href", "/grootboek");
    // De cijfers staan er nog steeds, onderaan.
    expect(within(screen.getByTestId("balans-unclassified")).getAllByTestId("statement-unclassified-row")).toHaveLength(3);
  });

  it("9b-bis. de melding noemt géén bedrag — de nettosom is hier per definitie nul", () => {
    nietsGeclassificeerd();
    const { fs } = engine();
    if (!fs.ok) throw new Error("engine faalde");
    // Dit is de valkuil: met niets geclassificeerd tellen alle eindsaldi op tot
    // nul (invariant van de kern). "€ 0,00" in de melding zou lezen als "er is
    // niets" — precies het tegendeel van de boodschap.
    expect(fs.unclassified.withActivityCount).toBe(3);
    expect(fs.unclassified.closingCents).toBe(0);
    expect(fs.unclassified.movementCents).toBe(0);

    renderBalans();
    const melding = screen.getByTestId("statement-nothing-classified");
    expect(melding).not.toHaveTextContent(/€/);
    // Het aantal is wél eerlijk en staat er.
    expect(melding).toHaveTextContent(/3 rekeningen/);
  });

  it("9c. dezelfde uitleg op de W&V, met de periodemutatie", () => {
    nietsGeclassificeerd();
    renderWv();
    expect(screen.getByTestId("statement-nothing-classified")).toHaveTextContent(/winst-en-verliesrekening/i);
    expect(within(screen.getByTestId("wv-unclassified")).getAllByTestId("statement-unclassified-row")).toHaveLength(3);
  });

  it("9d. zodra er wél iets geclassificeerd is, verdwijnt die uitleg", () => {
    lopendJaarZonderBeginbalans();
    renderBalans();
    expect(screen.queryByTestId("statement-nothing-classified")).toBeNull();
  });

  it("10. de synthetische resultaatregel blijft kloppen zonder beginbalans", () => {
    lopendJaarZonderBeginbalans();
    const { fs } = engine();
    if (!fs.ok) throw new Error("engine faalde");
    const lopend = fs.balanceSheet.systemLines.find((l) => l.kind === "current_year_result")!;
    const vorig = fs.balanceSheet.systemLines.find((l) => l.kind === "prior_years_result")!;
    expect(lopend.displayedCents).toBe(fs.profitLoss.netResultCents);
    // Zonder historie is er geen onverdeeld resultaat van vorige jaren — nul
    // omdat er niets was, niet omdat het verzonnen is.
    expect(vorig.displayedCents).toBe(0);

    renderBalans();
    const systeem = screen.getAllByTestId("statement-system-line");
    expect(systeem).toHaveLength(2);
    // Ruwe textContent houdt de harde spatie van Intl; normaliseer beide kanten.
    const tekst = (el: Element) => (el.textContent ?? "").replace(/\u00a0/g, " ");
    expect(systeem.some((r) => tekst(r).includes(bedrag(60_000)))).toBe(true);
  });
});

describe("administratiescheiding", () => {
  it("12. een andere administratie lekt niet mee", () => {
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN];
    state.rows = [
      ...entry(BANK.id, OMZET.id, "1000.00", d("04-01"), "manual_journal", CLIENT),
      ...entry(BANK.id, OMZET.id, "9999.00", d("04-02"), "manual_journal", "client-2"),
    ];
    renderBalans();
    expect(screen.queryByText(/9\.999,00/)).toBeNull();
    const activa = screen.getByTestId("balans-activa-table");
    expect(within(activa).getByTestId("statement-total")).toHaveTextContent(bedrag(100_000));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Review P2-1 — de classificatiemelding is per overzicht.
 *
 * Een globale telling over álle niet-geclassificeerde rekeningen deugt niet:
 * staat de activiteit aantoonbaar aan de balanskant, dan mag de W&V nooit
 * beweren dat zíj leeg is doordat W&V-rekeningen niet zijn geclassificeerd —
 * en omgekeerd. De toewijzing komt uitsluitend uit de twee expliciete velden
 * (`statement_type`, `report_group`); nooit uit een rekeningnummer, een naam
 * of `categorie`.
 */
describe("de classificatiemelding is statement-specifiek", () => {
  /** Alleen balansverkeer; beide balansrekeningen missen nog hun groep. */
  function alleenBalansOngeclassificeerd() {
    state.accounts = [
      { ...BANK, report_group: null },
      { ...KAPITAAL, report_group: null },
    ];
    state.rows = [...entry(BANK.id, KAPITAAL.id, "1000.00", d("04-01"))];
  }

  /** Alleen resultaatverkeer; de omzetrekening mist nog haar groep. */
  function alleenWvOngeclassificeerd() {
    state.accounts = [BANK, { ...OMZET, report_group: null }];
    state.rows = [...entry(BANK.id, OMZET.id, "1000.00", d("04-01"))];
  }

  it("13. alleen balansactiviteit: de balans meldt het, de W&V zwijgt erover", () => {
    alleenBalansOngeclassificeerd();

    renderBalans();
    const melding = screen.getByTestId("statement-nothing-classified");
    // `statement_type = 'balans'` staat er met zoveel woorden; alleen de groep
    // ontbreekt. De metadata draagt dus wél een stellige uitspraak.
    expect(melding).toHaveAttribute("data-statement", "balans");
    expect(melding).toHaveAttribute("data-certainty", "specifiek");
    expect(melding).toHaveAttribute("data-relevant", "2");
    expect(melding).toHaveAttribute("data-undetermined", "0");
    cleanup();

    renderWv();
    // De W&V is leeg omdat er geen resultaatverkeer is — niet door
    // ongeclassificeerde W&V-rekeningen. Dus geen melding die dat beweert.
    expect(screen.queryByTestId("statement-nothing-classified")).toBeNull();
  });

  it("14. alleen W&V-activiteit: de W&V meldt het, de balans claimt dezelfde oorzaak niet", () => {
    alleenWvOngeclassificeerd();

    renderWv();
    const melding = screen.getByTestId("statement-nothing-classified");
    expect(melding).toHaveAttribute("data-statement", "winst_verlies");
    expect(melding).toHaveAttribute("data-certainty", "specifiek");
    expect(melding).toHaveAttribute("data-relevant", "1");
    cleanup();

    renderBalans();
    expect(screen.queryByTestId("statement-nothing-classified")).toBeNull();
    // En voor de balans telt die W&V-rekening ook niet mee als oorzaak.
    const { fs } = engine();
    if (!fs.ok) throw new Error("engine faalde");
    expect(unclassifiedRelevanceFor(fs.unclassified.accounts, "balans")).toEqual({
      relevantCount: 0,
      undeterminedCount: 0,
      any: false,
    });
    expect(unclassifiedRelevanceFor(fs.unclassified.accounts, "winst_verlies").relevantCount).toBe(1);
  });

  it("15. gemengd: elke pagina meldt alleen haar eigen ongeclassificeerde activiteit", () => {
    state.accounts = [
      { ...BANK, report_group: null },
      { ...KAPITAAL, report_group: null },
      { ...OMZET, report_group: null },
      { ...KOSTEN, report_group: null },
    ];
    state.rows = [
      ...entry(BANK.id, OMZET.id, "1000.00", d("04-01")),
      ...entry(KOSTEN.id, BANK.id, "400.00", d("05-01")),
    ];
    const { fs } = engine();
    if (!fs.ok) throw new Error("engine faalde");
    // Drie rekeningen met activiteit (kapitaal beweegt niet), verdeeld over
    // twee overzichten: één balansrekening en twee W&V-rekeningen. Geen enkele
    // pagina mag de globale drie noemen.
    expect(fs.unclassified.withActivityCount).toBe(3);

    renderBalans();
    const balansMelding = screen.getByTestId("statement-nothing-classified");
    expect(balansMelding).toHaveAttribute("data-relevant", "1");
    expect(balansMelding).toHaveAttribute("data-undetermined", "0");
    cleanup();

    renderWv();
    const wvMelding = screen.getByTestId("statement-nothing-classified");
    expect(wvMelding).toHaveAttribute("data-relevant", "2");
    expect(wvMelding).toHaveAttribute("data-undetermined", "0");
  });

  it("16. volledig onbekende classificatie: geen stellige oorzaak, bedragen blijven zichtbaar", () => {
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN].map((a) => ({
      ...a, statement_type: null, report_group: null, normal_side: null, report_sort: null,
    }));
    state.rows = [
      ...entry(BANK.id, OMZET.id, "1000.00", d("04-01")),
      ...entry(KOSTEN.id, BANK.id, "400.00", d("05-01")),
    ];

    for (const [render_, testId] of [[renderBalans, "balans-unclassified"], [renderWv, "wv-unclassified"]] as const) {
      render_();
      const melding = screen.getByTestId("statement-nothing-classified");
      expect(melding).toHaveAttribute("data-certainty", "onbepaald");
      expect(melding).toHaveAttribute("data-relevant", "0");
      // Geen bewering over wat er "voor dit overzicht" bedoeld was.
      expect(melding).not.toHaveTextContent(/bedoeld/i);
      expect(melding).toHaveTextContent(/niet vast te stellen/i);
      // En de bedragen staan er gewoon, per rekening.
      const rijen = within(screen.getByTestId(testId)).getAllByTestId("statement-unclassified-row");
      expect(rijen).toHaveLength(3);
      cleanup();
    }
  });

  it("17. de toewijzing komt uit de expliciete velden, nooit uit het rekeningnummer", () => {
    // Twee keer exact hetzelfde nummer en dezelfde categorie; alleen de
    // expliciete rapportagevelden verschillen. Een toewijzing op nummer of
    // categorie zou hier tweemaal hetzelfde antwoord geven.
    const gemeenschappelijk = { accountId: "x", accountNumber: 4700, accountName: "Advieskosten", categorie: "kosten" };
    expect(
      attributeUnclassifiedAccount({
        ...gemeenschappelijk, statementType: "balans", reportGroup: null, reason: "missing_report_group",
      } as never),
    ).toBe("balans");
    expect(
      attributeUnclassifiedAccount({
        ...gemeenschappelijk, statementType: "winst_verlies", reportGroup: null, reason: "missing_report_group",
      } as never),
    ).toBe("winst_verlies");
    // Geen overzicht ingevuld, wél een geldige groep: de groepsverzamelingen
    // zijn disjunct, dus de groep wijst het overzicht aan — nog steeds
    // expliciete metadata, geen gok.
    expect(
      attributeUnclassifiedAccount({
        ...gemeenschappelijk, statementType: null, reportGroup: "netto_omzet", reason: "missing_statement_type",
      } as never),
    ).toBe("winst_verlies");
    expect(
      attributeUnclassifiedAccount({
        ...gemeenschappelijk, statementType: null, reportGroup: "vaste_activa", reason: "missing_statement_type",
      } as never),
    ).toBe("balans");
    // Niets ingevuld → onbepaald.
    expect(
      attributeUnclassifiedAccount({
        ...gemeenschappelijk, statementType: null, reportGroup: null, reason: "missing_statement_type",
      } as never),
    ).toBe("onbepaald");
    // Twee expliciete velden die elkaar tegenspreken: niet vast te stellen
    // welk van beide de vergissing is, dus geen keuze.
    expect(
      attributeUnclassifiedAccount({
        ...gemeenschappelijk, statementType: "balans", reportGroup: "netto_omzet", reason: "invalid_group_for_statement",
      } as never),
    ).toBe("onbepaald");
    // Een rekening die de kern niet kon herleiden heeft geen metadata.
    expect(
      attributeUnclassifiedAccount({
        ...gemeenschappelijk, statementType: null, reportGroup: null, reason: "unresolved_account",
      } as never),
    ).toBe("onbepaald");
  });

  it("18. een rekening zonder beweging telt voor geen enkel overzicht mee", () => {
    // Zonder beweging is het rapport niet onvolledig: de rekening wacht op
    // classificatie, maar er ontbreekt geen cijfer. Zij mag dus geen melding
    // aanzetten — ook niet op het overzicht waar ze aantoonbaar voor bedoeld is.
    const zonderBeweging = {
      accountId: "stil", accountNumber: 1200, accountName: "Slapende rekening", categorie: "activa",
      statementType: "balans", reportGroup: null, reason: "missing_report_group",
      rawSignedClosingCents: 0, rawSignedMovementCents: 0, hasActivity: false,
    } as never;
    expect(attributeUnclassifiedAccount(zonderBeweging)).toBe("balans");
    expect(unclassifiedRelevanceFor([zonderBeweging], "balans")).toEqual({
      relevantCount: 0,
      undeterminedCount: 0,
      any: false,
    });
    expect(unclassifiedRelevanceFor([zonderBeweging], "winst_verlies").any).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Review P2-2 — de documentvolledigheid is een diagnose bij een LEEG rapport,
 * geen achtergrondscan bij elk bezoek. `fetchLedgerCompletenessCounts` doet
 * negen parallelle tellingen met gepagineerde id-lijsten; dat hoort niet te
 * draaien op een gevulde balans die er niets mee doet.
 */
describe("documentvolledigheid draait alleen bij een werkelijk leeg rapport", () => {
  it("19. gevulde balans: de volledigheidsquery staat uit", () => {
    lopendJaarZonderBeginbalans();
    renderBalans();
    expect(screen.getByTestId("balans-activa-table")).toBeInTheDocument();
    expect(laatsteCompletenessEnabled()).toBe(false);
  });

  it("20. gevulde W&V: de volledigheidsquery staat uit", () => {
    lopendJaarZonderBeginbalans();
    renderWv();
    expect(screen.getByTestId("wv-table")).toBeInTheDocument();
    expect(laatsteCompletenessEnabled()).toBe(false);
  });

  it("21. een rapport met alleen ongeclassificeerde activiteit is niet leeg: query blijft uit", () => {
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN].map((a) => ({
      ...a, statement_type: null, report_group: null,
    }));
    state.rows = [...entry(BANK.id, OMZET.id, "1000.00", d("04-01"))];
    renderBalans();
    // De bedragen staan onder "Niet geclassificeerd"; er valt niets te duiden
    // met een documenttelling.
    expect(screen.getByTestId("balans-unclassified")).toBeInTheDocument();
    expect(laatsteCompletenessEnabled()).toBe(false);
  });

  it("22. werkelijk leeg rapport: dán pas wordt de volledigheidsquery aangezet", () => {
    state.accounts = [BANK, KAPITAAL, OMZET, KOSTEN];
    state.rows = [];
    renderBalans();
    expect(screen.getByText(BALANS_EMPTY_MESSAGE)).toBeInTheDocument();
    expect(laatsteCompletenessEnabled()).toBe(true);
    cleanup();

    state.completenessCalls = [];
    renderWv();
    expect(laatsteCompletenessEnabled()).toBe(true);
  });

  it("23. zonder gekozen administratie blijft de query uit", () => {
    state.clientId = "all";
    state.accounts = [BANK, KAPITAAL];
    state.rows = [];
    renderBalans();
    expect(laatsteCompletenessEnabled()).toBe(false);
    // En er gaat sowieso geen administratie mee.
    expect(state.completenessCalls.every((c) => c.clientId === undefined)).toBe(true);
  });

  it("24. bij een fout in het rapport wordt er niets zwaars gescand", () => {
    // Niet-sluitende boekingsgroep: de engine faalt, het rapport is NIET leeg,
    // en een documenttelling zou hier geen enkele vraag beantwoorden.
    state.accounts = [BANK, KAPITAAL];
    state.rows = [
      {
        client_id: CLIENT, posting_group_id: "kapot", posting_date: d("04-01"), boekjaar: YEAR,
        currency: "EUR", source_type: "manual_journal", id: "kapot-1", line_no: 1,
        grootboekrekening_id: BANK.id, debit_amount: "100.00", credit_amount: "0.00",
      },
    ];
    renderBalans();
    expect(screen.getByTestId("statement-failed")).toBeInTheDocument();
    expect(laatsteCompletenessEnabled()).toBe(false);
  });
});
