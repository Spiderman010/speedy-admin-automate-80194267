import { render, screen, within } from "@testing-library/react";
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

import Balans from "@/pages/Balans";
import WinstVerlies from "@/pages/WinstVerlies";
import { buildAccountReport, yearPeriod, type LedgerPostingLike } from "@/lib/ledger-reporting";
import { buildTrialBalance } from "@/lib/proef-saldibalans";
import { buildFinancialStatements } from "@/lib/financial-statements";
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

const engine = (period = PERIOD) => {
  const rows = state.rows.filter((r) => r.client_id === state.clientId && r.posting_date < period.toExclusive);
  const report = buildAccountReport({ rows, clientId: state.clientId, period, accounts: state.accounts });
  return { report, fs: buildFinancialStatements({ report, period, accounts: state.accounts as any }) };
};

const renderBalans = () => render(<MemoryRouter><Balans /></MemoryRouter>);
const renderWv = () => render(<MemoryRouter><WinstVerlies /></MemoryRouter>);

beforeEach(() => {
  state.rows = [];
  state.accounts = [];
  state.clientId = CLIENT;
  state.obState = "not_set";
  state.obSeverity = "incomplete";
});

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
    // En de bijdragediagnose is "niet vastgesteld", geen geverifieerde nul.
    expect(fs.diagnostics.openingBalanceContributionKnown).toBe(false);
    expect(fs.profitLoss.openingBalanceContributionCents).toBeNull();
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
    expect(melding).toHaveTextContent(/geen enkele grootboekrekening met beweging/i);
    expect(melding).toHaveTextContent(/3 rekeningen/);
    expect(within(melding).getByRole("link", { name: /classificeren/i })).toHaveAttribute("href", "/grootboek");
    // De cijfers staan er nog steeds, onderaan.
    expect(within(screen.getByTestId("balans-unclassified")).getAllByTestId("statement-unclassified-row")).toHaveLength(3);
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
