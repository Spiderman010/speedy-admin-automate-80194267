import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { buildAccountReport, type LedgerPeriod, type LedgerPostingLike } from "@/lib/ledger-reporting";
import { buildTrialBalance, trialBalanceToCsv, type TrialBalance } from "@/lib/proef-saldibalans";
import { buildFinancialStatements, PRIOR_PERIOD_RESULT_LABEL, PRIOR_YEARS_RESULT_LABEL } from "@/lib/financial-statements";
import { CATEGORY_LABELS } from "@/lib/grootboek-saldi-utils";

/**
 * Herstel P7 — A3-12: de proef- en saldibalans per boekjaar telt W&V-
 * rekeningen vanaf nul.
 *
 * Het scenario van de nulmeting (repro/A3/a3-psb-cumulatief.test.ts): omzet
 * 10.000 in 2026 en 2.000 in 2027. Vóór deze herstelstap toonde de PSB van
 * 2027 omzet met beginsaldo 10.000 en eindsaldo 12.000. Nu: beginsaldo 0,
 * eindsaldo 2.000, en de 10.000 op de berekende regel "Onverdeeld resultaat
 * voorgaande jaren" — met precies het bedrag dat de balans daar toont.
 *
 * Alles draait door de ECHTE kern, de echte PSB-laag en de echte
 * statement-engine; er is niets gemockt behalve, in het paginadeel, de
 * datahooks.
 */

const accounts = [
  { id: "deb", nummer: 1300, omschrijving: "Debiteuren", categorie: "activa", statement_type: "balans", report_group: "vlottende_activa", normal_side: "debet" },
  { id: "kas", nummer: 1000, omschrijving: "Kas", categorie: "activa", statement_type: "balans", report_group: "vlottende_activa", normal_side: "debet" },
  { id: "omzet", nummer: 8000, omschrijving: "Omzet", categorie: "omzet", statement_type: "winst_verlies", report_group: "netto_omzet", normal_side: "credit" },
  { id: "kosten", nummer: 4400, omschrijving: "Kantoorkosten", categorie: "kosten", statement_type: "winst_verlies", report_group: "overige_bedrijfskosten", normal_side: "debet" },
  // Niet geclassificeerd: of dit een W&V-rekening is, staat nergens vast.
  { id: "vrij", nummer: 9100, omschrijving: "Nog in te delen", categorie: "kosten", statement_type: null, report_group: null, normal_side: null },
];

let seq = 0;
const row = (o: Partial<LedgerPostingLike>): LedgerPostingLike => ({
  id: `r-${String(++seq).padStart(4, "0")}`,
  client_id: "c1",
  grootboekrekening_id: "deb",
  posting_group_id: "g",
  line_no: 1,
  posting_date: "2026-06-01",
  boekjaar: 2026,
  debit_amount: 0,
  credit_amount: 0,
  currency: "EUR",
  source_type: "sales_invoice",
  ...o,
});
const groep = (g: string, date: string, legs: Array<[string, number, number]>) =>
  legs.map(([acc, d, c], i) =>
    row({ posting_group_id: g, line_no: i + 1, posting_date: date, boekjaar: Number(date.slice(0, 4)), grootboekrekening_id: acc, debit_amount: d, credit_amount: c }),
  );

/** Omzet 10.000 in 2026 en 2.000 in 2027 (de nulmeting), plus kosten in beide jaren. */
function twoYears(): LedgerPostingLike[] {
  return [
    ...groep("g26", "2026-06-01", [["deb", 10000, 0], ["omzet", 0, 10000]]),
    ...groep("g26k", "2026-07-01", [["kosten", 300, 0], ["kas", 0, 300]]),
    ...groep("g27", "2027-06-01", [["deb", 2000, 0], ["omzet", 0, 2000]]),
    ...groep("g27q1", "2027-02-01", [["kosten", 50, 0], ["kas", 0, 50]]),
  ];
}

const jaar = (y: number): LedgerPeriod => ({ from: `${y}-01-01`, toExclusive: `${y + 1}-01-01` });

function tb(rows: LedgerPostingLike[], period: LedgerPeriod, accs = accounts): Extract<TrialBalance, { ok: true }> {
  const report = buildAccountReport({ rows, clientId: "c1", period, accounts: accs });
  const result = buildTrialBalance({ report, accounts: accs, clientId: "c1", period });
  if (!result.ok) throw new Error(`PSB faalde: ${JSON.stringify(result.failures)}`);
  return result;
}

const rij = (t: Extract<TrialBalance, { ok: true }>, id: string) => t.rows.find((r) => r.account.id === id)!;

describe("A3-12 — W&V per boekjaar vanaf nul, balansrekeningen cumulatief", () => {
  it("1. PSB 2027: omzet beginsaldo 0 en eindsaldo 2.000 — niet 12.000 (het scenario van de nulmeting)", () => {
    const t = tb(twoYears(), jaar(2027));
    const omzet = rij(t, "omzet");
    expect(omzet).toMatchObject({
      openingDebitCents: 0, openingCreditCents: 0,
      periodDebitCents: 0, periodCreditCents: 200000,
      closingDebitCents: 0, closingCreditCents: 200000,
      profitLoss: true,
    });
    const kosten = rij(t, "kosten");
    expect(kosten).toMatchObject({ openingDebitCents: 0, closingDebitCents: 5000, profitLoss: true });
  });

  it("2. de balansrekeningen blijven cumulatief tot het einde van het jaar", () => {
    const t = tb(twoYears(), jaar(2027));
    expect(rij(t, "deb")).toMatchObject({ openingDebitCents: 1000000, periodDebitCents: 200000, closingDebitCents: 1200000, profitLoss: false });
    expect(rij(t, "kas")).toMatchObject({ openingCreditCents: 30000, periodCreditCents: 5000, closingCreditCents: 35000, profitLoss: false });
  });

  it("3. het resultaat van 2026 staat op één berekende regel, begin en eind gelijk, zonder periodemutatie", () => {
    const t = tb(twoYears(), jaar(2027));
    expect(t.systemRows).toHaveLength(1);
    expect(t.systemRows[0]).toEqual({
      kind: "prior_result",
      label: PRIOR_YEARS_RESULT_LABEL,
      rawSignedCents: -970000, // omzet 10.000 credit − kosten 300 debet
      openingDebitCents: 0, openingCreditCents: 970000,
      periodDebitCents: 0, periodCreditCents: 0,
      closingDebitCents: 0, closingCreditCents: 970000,
    });
  });

  it("4. alle zes kolommen sluiten, en de totalen zijn exact die van de kern (de verzoening blijft gezaghebbend)", () => {
    const period = jaar(2027);
    const report = buildAccountReport({ rows: twoYears(), clientId: "c1", period, accounts });
    if (!report.ok) throw new Error("kern faalde");
    const t = tb(twoYears(), period);
    expect(t.totals.openingDebitCents).toBe(t.totals.openingCreditCents);
    expect(t.totals.periodDebitCents).toBe(t.totals.periodCreditCents);
    expect(t.totals.closingDebitCents).toBe(t.totals.closingCreditCents);
    expect(t.totals.openingDebitCents - t.totals.openingCreditCents).toBe(report.totals.openingCents);
    expect(t.totals.closingDebitCents - t.totals.closingCreditCents).toBe(report.totals.closingCents);
    expect(t.totals.periodDebitCents).toBe(report.totals.periodDebitCents);
  });

  it("5. consistent met de balans: de berekende regel = 'Onverdeeld resultaat voorgaande jaren', de W&V-eindsaldi = 'Resultaat lopend boekjaar'", () => {
    const period = jaar(2027);
    const report = buildAccountReport({ rows: twoYears(), clientId: "c1", period, accounts });
    const fs = buildFinancialStatements({ report, period, accounts, openingBalanceContribution: new Map() });
    if (!fs.ok) throw new Error("engine faalde");
    const prior = fs.balanceSheet.systemLines.find((l) => l.kind === "prior_years_result")!;
    const current = fs.balanceSheet.systemLines.find((l) => l.kind === "current_year_result")!;
    const t = tb(twoYears(), period);
    expect(t.systemRows[0].rawSignedCents).toBe(prior.rawSignedCents);
    expect(t.systemRows[0].label).toBe(prior.label);
    const pnlClosing = t.rows
      .filter((r) => r.profitLoss)
      .reduce((s, r) => s + r.closingDebitCents - r.closingCreditCents, 0);
    expect(pnlClosing).toBe(current.rawSignedCents);
  });

  it("6. PSB 2026 (het eerste jaar): geen berekende regel, omzet 10.000 als mutatie en eindsaldo", () => {
    const t = tb(twoYears(), jaar(2026));
    expect(t.systemRows).toEqual([]);
    expect(rij(t, "omzet")).toMatchObject({ openingCreditCents: 0, periodCreditCents: 1000000, closingCreditCents: 1000000 });
    expect(t.profitLoss).toMatchObject({ resetAccounts: 2, unclassifiedWithOpening: 0 });
  });

  it("7. een periode binnen een jaar heet 'vóór deze periode' (het label van de balans) en draagt ook de eerdere maanden", () => {
    const t = tb(twoYears(), { from: "2027-04-01", toExclusive: "2027-07-01" });
    expect(t.systemRows[0].label).toBe(PRIOR_PERIOD_RESULT_LABEL);
    // 2026: −9.700; Q1 2027: kosten 50 debet → −9.650.
    expect(t.systemRows[0].rawSignedCents).toBe(-965000);
    expect(rij(t, "omzet")).toMatchObject({ openingCreditCents: 0, closingCreditCents: 200000 });
  });

  it("8. 'Alle jaren': niets vóór de periode, dus geen berekende regel; de W&V draagt dan de mutatie van alle jaren", () => {
    const t = tb(twoYears(), { from: "2000-01-01", toExclusive: "2101-01-01" });
    expect(t.systemRows).toEqual([]);
    expect(rij(t, "omzet")).toMatchObject({ closingCreditCents: 1200000 });
  });

  it("9. een rekening zonder classificatie blijft cumulatief en wordt geteld, nooit geraden", () => {
    const rows = [
      ...twoYears(),
      ...groep("gvrij", "2026-08-01", [["vrij", 100, 0], ["kas", 0, 100]]),
      ...groep("gvrij27", "2027-08-01", [["vrij", 40, 0], ["kas", 0, 40]]),
    ];
    const t = tb(rows, jaar(2027));
    expect(rij(t, "vrij")).toMatchObject({ openingDebitCents: 10000, closingDebitCents: 14000, profitLoss: false });
    expect(t.profitLoss.unclassifiedWithOpening).toBe(1);
    // De berekende regel bevat uitsluitend de expliciet geclassificeerde W&V-rekeningen.
    expect(t.systemRows[0].rawSignedCents).toBe(-970000);
    expect(t.totals.openingDebitCents).toBe(t.totals.openingCreditCents);
  });

  it("10. de CSV draagt dezelfde rijen: omzet vanaf nul, de berekende regel zonder rekeningnummer met categorie 'Berekend'", () => {
    const t = tb(twoYears(), jaar(2027));
    const csv = trialBalanceToCsv({ rows: t.rows, systemRows: t.systemRows, totals: t.totals, categoryLabel: (c) => CATEGORY_LABELS[c] });
    const regels = csv.trimEnd().split("\r\n");
    expect(regels).toContain('"8000";"Omzet";"Omzet";"0,00";"0,00";"0,00";"2000,00";"0,00";"2000,00"');
    expect(regels).toContain('"";"Onverdeeld resultaat voorgaande jaren";"Berekend";"0,00";"9700,00";"0,00";"0,00";"0,00";"9700,00"');
    const totaal = regels[regels.length - 1];
    expect(totaal).toBe('"";"Totaal";"";"10000,00";"10000,00";"2050,00";"2050,00";"12050,00";"12050,00"');
  });
});

// ── De pagina ────────────────────────────────────────────────────────────────

const YEAR = new Date().getFullYear();
const state = {
  postings: [] as Array<Record<string, unknown>>,
};

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: "c1", setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "c1", name: "Klant 1", organization_id: "org-1" }] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({ data: accounts, isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useLedgerPostings", () => ({
  useLedgerPostings: () => ({ data: state.postings, isPending: false, isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/hooks/useLedgerCompleteness", () => ({
  useLedgerCompleteness: () => ({ data: undefined, isPending: false, isError: true }),
  useOpeningBalanceCompleteness: () => ({ data: undefined, isPending: false, isError: false }),
}));

import ProefSaldibalans from "@/pages/ProefSaldibalans";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/overzichten/proef-saldibalans"]}>
      <Routes>
        <Route path="/overzichten/proef-saldibalans" element={<ProefSaldibalans />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Dezelfde twee jaren, maar dan vorig jaar en dit jaar (de pagina opent op het lopende jaar). */
function pagePostings() {
  const shift = (r: LedgerPostingLike) => {
    const y = Number(r.posting_date.slice(0, 4)) === 2026 ? YEAR - 1 : YEAR;
    return { ...r, posting_date: `${y}${r.posting_date.slice(4)}`, boekjaar: y, organization_id: "org-1" };
  };
  return twoYears().map(shift);
}

describe("A3-12 — de PSB-pagina", () => {
  beforeEach(() => {
    state.postings = pagePostings();
  });

  it("11. de pagina van het lopende jaar toont omzet vanaf nul, de berekende regel en de uitleg", async () => {
    renderPage();
    const omzetRij = (await screen.findAllByTestId("psb-row")).find((r) => r.getAttribute("data-account-id") === "omzet")!;
    expect(omzetRij).toHaveAttribute("data-profit-loss", "true");
    const cellen = within(omzetRij).getAllByRole("cell").map((c) => c.textContent);
    expect(cellen.slice(3)).toEqual(["0,00", "0,00", "0,00", "2000,00", "0,00", "2000,00"]);
    const systeem = screen.getByTestId("psb-system-row");
    expect(systeem).toHaveTextContent("Onverdeeld resultaat voorgaande jaren");
    expect(systeem).toHaveTextContent("Berekend");
    expect(within(systeem).queryByRole("link")).toBeNull();
    expect(within(systeem).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("psb-pnl-notice")).toHaveTextContent("Winst-en-verliesrekeningen tonen alleen de mutaties van deze periode");
    expect(screen.getByTestId("psb-totals")).toHaveTextContent("en 1 berekende regel");
  });

  it("12. de doorklik legt een W&V-rij uit als periodemutatie (2.000), en een balansrij als kolomregel", async () => {
    renderPage();
    const knoppen = await screen.findAllByTestId("psb-drilldown");
    fireEvent.click(knoppen.find((b) => b.getAttribute("data-account-id") === "omzet")!);
    await screen.findByTestId("drilldown-account-level");
    expect(screen.getByTestId("drilldown-reconciliation")).toHaveAttribute("data-kind", "profit_loss");
    expect(screen.getByTestId("drilldown-report-amount")).toHaveTextContent("2.000,00");
    expect(screen.queryByTestId("drilldown-mismatch")).toBeNull();
  });
});
