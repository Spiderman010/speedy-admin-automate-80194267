import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Balans/W&V PR 5 — UI-polish.
 *
 * Deze PR verandert uitsluitend de presentatie. Deze tests bewaken dat:
 * de cijfers exact die van de engine blijven, systeemregels niet aanklikbaar
 * worden, niet-geclassificeerde rijen zichtbaar blijven, de statussen hun
 * betekenis houden, en de opmaak geen paginabrede overflow of verloren
 * uitlijning introduceert.
 */

const state = {
  rows: [] as any[],
  accounts: [] as any[],
  clientId: "client-1" as string,
};

vi.mock("@/hooks/useClientContext", () => ({
  useClientContext: () => ({ selectedClientId: state.clientId, setSelectedClientId: vi.fn() }),
}));
vi.mock("@/hooks/useActiveOrganization", () => ({
  useActiveOrganization: () => ({ activeOrganizationId: "org-1", isReady: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useClients: () => ({ data: [{ id: "client-1", name: "Klant A" }] }),
}));
vi.mock("@/hooks/useGrootboekrekeningen", () => ({
  useGrootboekrekeningen: () => ({
    data: state.accounts, isPending: false, isError: false, error: null, refetch: vi.fn(),
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
  useLedgerPostings: (opts: any) => ({
    data: opts?.clientId
      ? state.rows.filter((r) => r.client_id === opts.clientId && r.posting_date < opts.period.toExclusive)
      : undefined,
    isPending: false, isError: false, error: null, refetch: vi.fn(),
  }),
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

/** Intl zet een harde spatie tussen € en het bedrag; de DOM normaliseert die. */
const bedrag = (cents: number) => formatCents(cents).replace(/\u00a0/g, " ");

let seq = 0;
function entry(debit: string, credit: string, amount: string, date: string, client = "client-1") {
  seq++;
  const group = `g-${seq}`;
  const base = {
    client_id: client, posting_group_id: group, posting_date: date,
    boekjaar: Number(date.slice(0, 4)), currency: "EUR", source_type: "manual_journal",
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

const YEAR = new Date().getFullYear();
const d = (md: string) => `${YEAR}-${md}`;

function engineResult(period = yearPeriod(YEAR)) {
  const rows = state.rows.filter((r) => r.client_id === state.clientId && r.posting_date < period.toExclusive);
  const report = buildAccountReport({ rows, clientId: state.clientId, period, accounts: state.accounts });
  return buildFinancialStatements({
    report, period, accounts: state.accounts,
    openingBalanceContribution: openingBalanceContributionFromRows(rows, period),
    movementOnPeriodStart: movementOnPeriodStartFromRows(rows, period),
  });
}

const renderBalans = () => render(<MemoryRouter initialEntries={["/grootboek/balans"]}><Balans /></MemoryRouter>);
const renderWv = () => render(<MemoryRouter initialEntries={["/grootboek/winst-verlies"]}><WinstVerlies /></MemoryRouter>);

/** Winst 600: omzet 1000, kosten 400, kapitaal 5000. */
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
  state.clientId = "client-1";
});

// ─────────────────────────────────────────────────────────────────────────────
describe("polish verandert geen enkel bedrag", () => {
  it("1. de balans toont nog exact de engine-waarden", () => {
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
    // Elke regel is het engine-bedrag, geen afgeleide.
    for (const groep of [...engine.balanceSheet.assetGroups, ...engine.balanceSheet.liabilityEquityGroups]) {
      for (const regel of groep.lines) {
        const rij = screen.getAllByTestId("statement-line").find((r) => r.getAttribute("data-account-id") === regel.accountId)!;
        expect(rij).toHaveTextContent(bedrag(regel.displayedCents));
      }
    }
  });

  it("2. de W&V toont nog exact de engine-waarden", () => {
    winstjaar();
    const engine = engineResult();
    if (!engine.ok) throw new Error("engine faalde");
    renderWv();

    expect(screen.getByTestId("wv-revenue")).toHaveTextContent(bedrag(engine.profitLoss.revenueCents));
    expect(screen.getByTestId("wv-expense")).toHaveTextContent(bedrag(engine.profitLoss.expenseCents));
    expect(screen.getByTestId("wv-result")).toHaveAttribute("data-result", String(engine.profitLoss.netResultCents));
    expect(screen.getByTestId("wv-result")).toHaveTextContent(bedrag(engine.profitLoss.netResultCents));
    // De totaalregel van de tabel blijft hetzelfde resultaat.
    expect(screen.getByTestId("statement-total")).toHaveTextContent(bedrag(engine.profitLoss.netResultCents));
  });

  it("10. een verschil ongelijk nul waarschuwt nog steeds, met het engine-bedrag", () => {
    state.accounts = [BANK, KAPITAAL, acc({ id: "a-vreemd", nummer: 3000, omschrijving: "Onbekend" })];
    state.rows = [...entry("a-vreemd", KAPITAAL.id, "50.00", d("06-01"))];
    const engine = engineResult();
    if (!engine.ok) throw new Error("engine faalde");
    renderBalans();

    expect(screen.getByTestId("balans-difference-warning")).toBeInTheDocument();
    expect(screen.getByTestId("balans-difference")).toHaveTextContent(bedrag(engine.balanceSheet.differenceCents));
    expect(screen.getByTestId("balans-difference")).toHaveAttribute(
      "data-difference",
      String(engine.balanceSheet.differenceCents),
    );
  });
});

describe("polish behoudt de afspraken", () => {
  it("3. systeemregels blijven onaanklikbaar en zonder rekeningnummer", () => {
    winstjaar();
    renderBalans();
    const systeem = screen.getAllByTestId("statement-system-line");
    expect(systeem).toHaveLength(2);
    for (const rij of systeem) {
      expect(within(rij).queryByRole("link")).toBeNull();
      expect(within(rij).getByText("Berekend")).toBeInTheDocument();
    }
  });

  it("4. echte rekeningregels blijven doorklikbaar naar het saldoscherm", () => {
    winstjaar();
    renderBalans();
    const rij = screen.getAllByTestId("statement-line").find((r) => r.getAttribute("data-account-id") === BANK.id)!;
    expect(within(rij).getByRole("link")).toHaveAttribute("href", `/grootboek/saldi/${BANK.id}`);
  });

  it("5. de niet-geclassificeerde sectie blijft zichtbaar en uitgeklapt", () => {
    state.accounts = [BANK, KAPITAAL, acc({ id: "a-vreemd", nummer: 3000, omschrijving: "Onbekende post" })];
    state.rows = [...entry("a-vreemd", KAPITAAL.id, "50.00", d("06-01"))];
    renderBalans();
    const sectie = screen.getByTestId("balans-unclassified");
    // Geen details/summary, geen ingeklapte container.
    expect(sectie.querySelector("details")).toBeNull();
    expect(sectie).toBeVisible();
    const rij = within(sectie).getByTestId("statement-unclassified-row");
    expect(rij).toHaveTextContent("3000");
    expect(rij).toHaveTextContent("Onbekende post");
    expect(rij).toHaveTextContent(bedrag(5_000));
    expect(within(rij).getByText("Geen rapport gekozen")).toBeInTheDocument();
    expect(within(sectie).getByRole("link", { name: /rekeningschema/i })).toHaveAttribute("href", "/grootboek");
  });

  it("6/7/8/9. elke volledigheidsstatus houdt haar tekst en toon", () => {
    const gevallen: Array<[string, string, RegExp]> = [
      ["complete", "Volledig", /green/],
      ["incomplete", "Onvolledig", /amber/],
      ["ambiguous", "Controle vereist", /amber/],
      ["unknown", "Niet vastgesteld", /muted/],
    ];
    for (const [status, label, toon] of gevallen) {
      const { unmount } = render(
        <MemoryRouter>
          <StatusProbe status={status as never} />
        </MemoryRouter>,
      );
      const badge = screen.getByTestId("statement-completeness");
      expect(badge).toHaveAttribute("data-completeness", status);
      expect(badge).toHaveTextContent(label);
      expect(badge.className).toMatch(toon);
      // Alleen "Volledig" mag groen zijn.
      if (status !== "complete") expect(badge.className).not.toMatch(/green/);
      unmount();
    }
  });
});

// Kleine probe zodat elke status los te renderen is.
import { FinancialCompletenessBadge } from "@/components/overzichten/FinancialCompletenessBadge";
import type { StatementCompleteness } from "@/lib/financial-statements";
function StatusProbe({ status }: { status: StatementCompleteness }) {
  return <FinancialCompletenessBadge completeness={status} />;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("opmaak en responsiviteit", () => {
  const bronnen = {
    tabel: readFileSync("src/components/overzichten/FinancialStatementTable.tsx", "utf8"),
    notices: readFileSync("src/components/overzichten/FinancialReportNotices.tsx", "utf8"),
    header: readFileSync("src/components/overzichten/FinancialReportHeader.tsx", "utf8"),
    balans: readFileSync("src/pages/Balans.tsx", "utf8"),
    wv: readFileSync("src/pages/WinstVerlies.tsx", "utf8"),
  };

  it("12. elke financiële tabel zit in een eigen horizontale scrollcontainer", () => {
    winstjaar();
    renderBalans();
    for (const id of ["balans-activa-table", "balans-passiva-table"]) {
      const tabel = screen.getByTestId(id);
      // De shadcn-Table brengt zelf al een `overflow-auto`-wrapper mee; daar
      // omheen zit die van ons. Eén van beide moet het horizontale scrollen
      // opvangen, anders schuift de hele pagina mee.
      const container = tabel.closest('[class*="overflow"]');
      expect(container, id).not.toBeNull();
      expect(container!.className, id).toMatch(/overflow-(x-)?auto/);
    }
    // En in de bron staat het bij élke tabel, ook die van de niet-geclassificeerde sectie.
    expect(bronnen.tabel).toMatch(/overflow-x-auto/);
    expect(bronnen.notices).toMatch(/overflow-x-auto/);
  });

  it("11. de scrollcontainer heeft een minimale tabelbreedte, zodat de pagina zelf niet meeschuift", () => {
    // min-w hoort op de TABEL te staan (die mag breder zijn dan het scherm),
    // niet op de container — anders duwt hij de pagina open.
    expect(bronnen.tabel).toMatch(/<Table className="min-w-\[\d+px\]"/);
    expect(bronnen.tabel).not.toMatch(/overflow-x-auto[^"]*min-w-\[/);
    expect(bronnen.notices).not.toMatch(/overflow-x-auto[^"]*min-w-\[/);
    // De balanskolommen mogen op een smal scherm niet naast elkaar blijven staan.
    expect(bronnen.balans).toMatch(/grid gap-4 lg:grid-cols-2/);
    // En ze mogen niet uitzetten voorbij hun kolom.
    expect(bronnen.balans).toMatch(/min-w-0 rounded-lg border/);
  });

  it("13. bedragen blijven rechts uitgelijnd met tabulaire cijfers", () => {
    winstjaar();
    renderBalans();
    const rij = screen.getAllByTestId("statement-line")[0];
    const cellen = rij.querySelectorAll("td");
    const bedragCel = cellen[cellen.length - 1];
    expect(bedragCel.className).toMatch(/text-right/);
    expect(bedragCel.className).toMatch(/tabular-nums/);
    // Ook de totaalregel en de niet-geclassificeerde bedragen.
    expect(bronnen.tabel).toMatch(/whitespace-nowrap text-right font-mono text-sm tabular-nums/);
    expect(bronnen.notices).toMatch(/text-right font-mono text-sm tabular-nums/);
  });

  it("de bediening staat in één balk in plaats van verspreid", () => {
    winstjaar();
    renderBalans();
    const balk = screen.getByTestId("balans-toolbar");
    // Administratie, boekjaar, status en export staan in dezelfde balk.
    expect(within(balk).getByRole("combobox", { name: "Administratie" })).toBeInTheDocument();
    expect(within(balk).getByTestId("balans-period-filters")).toBeInTheDocument();
    expect(within(balk).getByTestId("statement-completeness")).toBeInTheDocument();
    expect(within(balk).getByTestId("balans-export")).toBeInTheDocument();
    expect(within(balk).getByRole("button", { name: /periode toepassen/i })).toBeInTheDocument();
  });

  it("de tabelstructuur blijft semantisch: echte tabel, groepskop als th", () => {
    winstjaar();
    renderBalans();
    const tabel = screen.getByTestId("balans-activa-table");
    expect(tabel.tagName).toBe("TABLE");
    expect(tabel.querySelector("thead")).not.toBeNull();
    expect(tabel.querySelector("tbody")).not.toBeNull();
    expect(tabel.querySelector("tfoot")).not.toBeNull();
    // Elke groep is een eigen <tbody> met een rowgroup-kop, zodat een
    // schermlezer die kop aan de regels eronder koppelt. `colgroup` zou naar
    // een <colgroup>-element verwijzen dat hier niet bestaat.
    const groepRij = screen.getAllByTestId("statement-group")[0];
    const groepskop = groepRij.querySelector("th");
    expect(groepskop).not.toBeNull();
    expect(groepskop).toHaveAttribute("scope", "rowgroup");
    expect(groepRij.closest("tbody")).not.toBeNull();
    expect(tabel.querySelectorAll("tbody").length).toBeGreaterThan(1);
    // Geen div-grid als vervanging van een tabel.
    expect(bronnen.tabel).not.toMatch(/role="(grid|table|row|cell)"/);
  });

  /**
   * Bedragen reizen door deze laag onder twee namen: als engineveld
   * (`displayedCents`, `totalCents`, …) én als de kale prop `cents` van de
   * Bedrag-cel. Een bewaking die alleen op `Cents` met hoofdletter let, kijkt
   * dus langs de enige variabele waar het werkelijk mis zou gaan.
   */
  const REKENT = [
    /\bcents\b\s*[+\-*/]\s/i, //        cents - x   /  totalCents + y
    /[+\-*/]=\s*[\w.]*cents\b/i, //      t += line.displayedCents
    /[-+]\s*[\w.]*cents\b/i, //           -cents  (tekenomklap)
    /\.reduce\(/, //                      eigen som
    /Math\.(abs|round|floor|ceil|max|min)\(/, //  eigen afronding/absolutie
    /\.toFixed\(/, //                     eigen opmaak
    /Intl\.NumberFormat/, //              tweede formatter naast formatCents
    /\.(filter|slice|sort)\(/, //         regels weglaten of herordenen
  ];

  it("14. er komt geen rekenwerk in de UI bij", () => {
    const strip = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    for (const [naam, src] of Object.entries(bronnen)) {
      for (const patroon of REKENT) {
        expect(strip(src), `${naam} — ${patroon}`).not.toMatch(patroon);
      }
      expect(strip(src), naam).not.toMatch(/buildAccountReport|buildFinancialStatements\(|toCents\(/);
    }
  });
  it("14b. die bewaking slaat werkelijk aan op de manieren waarop hier gerekend zóu worden", () => {
    const overtredingen = [
      "formatCents(-cents)",
      "formatCents(cents / 100)",
      "formatCents(Math.abs(group.totalCents))",
      "formatCents(Math.round(cents))",
      "(cents / 100).toFixed(2)",
      "new Intl.NumberFormat('nl-NL').format(cents)",
      "group.lines.filter((l) => l.displayedCents !== 0)",
      "accounts.slice(0, 5)",
      "[...group.lines].sort(vergelijk)",
      "t += l.displayedCents",
      "a.totalCents + b.totalCents",
      "lines.reduce((s, l) => s + l.displayedCents, 0)",
    ];
    for (const regel of overtredingen) {
      expect(REKENT.some((p) => p.test(regel)), regel).toBe(true);
    }
  });
});

describe("scope", () => {
  it("15. de rekenlagen zijn byte-voor-byte ongewijzigd", (ctx) => {
    let toon: (p: string) => string;
    try {
      execFileSync("git", ["rev-parse", "origin/main"], { stdio: ["ignore", "pipe", "ignore"] });
      toon = (p) => execFileSync("git", ["show", `origin/main:${p}`], { encoding: "utf8" });
    } catch {
      // Zichtbaar overslaan, niet stilzwijgend groen worden.
      ctx.skip();
      return;
    }
    for (const p of [
      "src/lib/financial-statements.ts",
      "src/lib/ledger-reporting.ts",
      "src/lib/proef-saldibalans.ts",
      "src/lib/financial-statements-presentation.ts",
      "src/hooks/useFinancialStatements.ts",
    ]) {
      expect(readFileSync(p, "utf8"), p).toBe(toon(p));
    }
  });

  it("16/17. geen dependency-, migratie-, schema- of typewijziging", (ctx) => {
    let changed: string[];
    try {
      changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).split("\n").filter(Boolean);
    } catch {
      ctx.skip();
      return;
    }
    expect(changed).not.toContain("package.json");
    expect(changed!.filter((f) => /package-lock\.json|bun\.lockb|pnpm-lock\.yaml|yarn\.lock/.test(f))).toEqual([]);
    expect(changed!.filter((f) => f.startsWith("supabase/") || f.endsWith(".sql"))).toEqual([]);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    // Geen routewijziging in een pure polish-PR.
    expect(changed).not.toContain("src/App.tsx");
  });
});
