import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { assertBranchSqlLeavesReportingAlone } from "./support/branch-sql-scope";

/**
 * Het tweede taxonomieniveau in Balans en W&V.
 *
 * Deze PR verandert UITSLUITEND de groepering op het scherm. Elke test hier
 * draait door de ECHTE kern en de ECHTE engine — alleen de datahooks zijn
 * gemockt — zodat elk bedrag dat wordt vergeleken een enginewaarde is en niet
 * een met de hand verzonnen getal. Wat bewezen moet worden is even eenvoudig
 * als streng: er verandert geen cent, en er verdwijnt geen rekening.
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
import {
  UNASSIGNED_SUBGROUP_KEY,
  UNASSIGNED_SUBGROUP_LABEL,
  anySubgroupsPresent,
  sectionsCoverAllLines,
  subgroupSectionsFor,
  subgroupSectionsForGroups,
} from "@/lib/financial-statements-subgroups";

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
  statement_type: null, report_group: null, report_subgroup: null,
  normal_side: null, report_sort: null, ...over,
});

const YEAR = new Date().getFullYear();
const d = (md: string) => `${YEAR}-${md}`;

/**
 * Een bankrekening zoals AA Secure er een heeft. Het NUMMER doet in deze hele
 * keten niets: de indeling komt uitsluitend uit `report_subgroup`.
 */
const BANK = acc({
  id: "a-bank", nummer: 1100, omschrijving: "Rekening-courant bank",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: "liquide_middelen",
});
const DEBITEUREN = acc({
  id: "a-deb", nummer: 1300, omschrijving: "Debiteuren",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: "handelsdebiteuren",
});
/** Categorie ingevuld, groep bewust NIET: het vangnetgeval. */
const VOORUIT = acc({
  id: "a-vooruit", nummer: 1400, omschrijving: "Vooruitbetaald",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: null,
});
const KAPITAAL = acc({
  id: "a-kap", nummer: 610, omschrijving: "Kapitaal", categorie: "passiva",
  statement_type: "balans", report_group: "eigen_vermogen", report_subgroup: "ondernemingsvermogen",
});
const OMZET = acc({
  id: "a-omzet", nummer: 8000, omschrijving: "Omzet", categorie: "omzet",
  statement_type: "winst_verlies", report_group: "netto_omzet", report_subgroup: "omzet_hoog_tarief",
});
const SOFTWARE = acc({
  id: "a-soft", nummer: 4500, omschrijving: "Softwarelicenties", categorie: "kosten",
  statement_type: "winst_verlies", report_group: "overige_bedrijfskosten",
  report_subgroup: "automatisering_software",
});
const HUUR = acc({
  id: "a-huur", nummer: 4100, omschrijving: "Huur bedrijfspand", categorie: "kosten",
  statement_type: "winst_verlies", report_group: "overige_bedrijfskosten", report_subgroup: "huur",
});

function engineResult(period = yearPeriod(YEAR)) {
  const rows = state.rows.filter((r) => r.client_id === state.clientId && r.posting_date < period.toExclusive);
  const report = buildAccountReport({ rows, clientId: state.clientId, period, accounts: state.accounts });
  const result = buildFinancialStatements({
    report, period, accounts: state.accounts,
    openingBalanceContribution: openingBalanceContributionFromRows(rows, period),
    movementOnPeriodStart: movementOnPeriodStartFromRows(rows, period),
  });
  // Versmalt meteen: faalt de engine, dan zegt de test dat in plaats van
  // stilletjes langs een half resultaat te lopen.
  if (!result.ok) throw new Error("engine faalde");
  return result;
}

const renderBalans = () => render(<MemoryRouter initialEntries={["/grootboek/balans"]}><Balans /></MemoryRouter>);
const renderWv = () => render(<MemoryRouter initialEntries={["/grootboek/winst-verlies"]}><WinstVerlies /></MemoryRouter>);

/**
 * Eén jaar met alle vijf de gevallen erin: ingedeeld (bank, debiteuren),
 * categorie zonder groep (vooruitbetaald), volledig ongeclassificeerd
 * (a-onbekend) en een verouderde groepwaarde (a-stale).
 */
function jaarMetIndeling() {
  const ONGECLASSIFICEERD = acc({ id: "a-onbekend", nummer: 2500, omschrijving: "Nog te duiden" });
  const STALE = acc({
    id: "a-stale", nummer: 1450, omschrijving: "Oude indeling",
    statement_type: "balans", report_group: "vlottende_activa",
    report_subgroup: "iets_wat_niet_meer_bestaat",
  });
  state.accounts = [BANK, DEBITEUREN, VOORUIT, STALE, ONGECLASSIFICEERD, KAPITAAL, OMZET, SOFTWARE, HUUR];
  state.rows = [
    ...entry(BANK.id, KAPITAAL.id, "5000.00", d("01-01")),
    ...entry(DEBITEUREN.id, OMZET.id, "1210.00", d("03-01")),
    ...entry(VOORUIT.id, BANK.id, "250.00", d("04-01")),
    ...entry(STALE.id, BANK.id, "75.00", d("04-15")),
    ...entry(ONGECLASSIFICEERD.id, BANK.id, "40.00", d("05-01")),
    ...entry(SOFTWARE.id, BANK.id, "300.00", d("06-01")),
    ...entry(HUUR.id, BANK.id, "900.00", d("07-01")),
  ];
}

beforeEach(() => {
  state.rows = [];
  state.accounts = [];
  state.clientId = "client-1";
});

// ── de zichtbare hiërarchie ─────────────────────────────────────────────────

describe("Balans: categorie → groep → rekening", () => {
  it("1. Vlottende activa toont Liquide middelen als tweede niveau, met de bankrekening eronder", () => {
    jaarMetIndeling();
    renderBalans();

    const subgroepen = screen.getAllByTestId("statement-subgroup").map((r) => r.getAttribute("data-subgroup"));
    expect(subgroepen).toContain("liquide_middelen");
    expect(subgroepen).toContain("handelsdebiteuren");

    // De bankrekening staat er, met het bedrag van de engine.
    const tabel = screen.getByTestId("balans-activa-table");
    const bankRegel = within(tabel)
      .getAllByTestId("statement-line")
      .find((r) => r.getAttribute("data-account-id") === BANK.id)!;
    const engineBank = engineResult()
      .balanceSheet.assetGroups.flatMap((g) => g.lines)
      .find((l) => l.accountId === BANK.id)!;
    expect(bankRegel).toHaveTextContent(bedrag(engineBank.displayedCents));
  });

  it("1b. het kopje draagt het Nederlandse label", () => {
    jaarMetIndeling();
    renderBalans();
    const kop = screen
      .getAllByTestId("statement-subgroup")
      .find((r) => r.getAttribute("data-subgroup") === "liquide_middelen")!;
    expect(kop).toHaveTextContent("Liquide middelen");
  });

  it("2. een rekening mét categorie maar zónder groep blijft zichtbaar onder 'Nog niet ingedeeld'", () => {
    jaarMetIndeling();
    renderBalans();

    const vangnet = screen
      .getAllByTestId("statement-subgroup")
      .find((r) => r.getAttribute("data-subgroup") === UNASSIGNED_SUBGROUP_KEY)!;
    expect(vangnet).toHaveTextContent(UNASSIGNED_SUBGROUP_LABEL);

    const tabel = screen.getByTestId("balans-activa-table");
    const ids = within(tabel).getAllByTestId("statement-line").map((r) => r.getAttribute("data-account-id"));
    expect(ids).toContain(VOORUIT.id);
  });

  it("4. een verouderde of onbekende groepwaarde laat de rekening niet verdwijnen", () => {
    jaarMetIndeling();
    renderBalans();
    const tabel = screen.getByTestId("balans-activa-table");
    const ids = within(tabel).getAllByTestId("statement-line").map((r) => r.getAttribute("data-account-id"));
    // "iets_wat_niet_meer_bestaat" hoort bij geen enkele categorie en valt dus
    // in het vangnet — maar staat er.
    expect(ids).toContain("a-stale");
    // en nooit onder een verzonnen kopje
    const subgroepen = screen.getAllByTestId("statement-subgroup").map((r) => r.getAttribute("data-subgroup"));
    expect(subgroepen).not.toContain("iets_wat_niet_meer_bestaat");
  });

  it("3. een volledig ongeclassificeerde rekening houdt haar eigen sectie", () => {
    jaarMetIndeling();
    renderBalans();
    const rijen = screen.getAllByTestId("statement-unclassified-row");
    expect(rijen.some((r) => /Nog te duiden/.test(r.textContent ?? ""))).toBe(true);
    // en zij staat NIET als gewone regel in de categorie-indeling
    const tabel = screen.getByTestId("balans-activa-table");
    const ids = within(tabel).getAllByTestId("statement-line").map((r) => r.getAttribute("data-account-id"));
    expect(ids).not.toContain("a-onbekend");
  });
});

// ── de cijfers ──────────────────────────────────────────────────────────────

describe("er verandert geen cent", () => {
  it("5. elk categorietotaal is nog steeds precies het groepstotaal van de engine", () => {
    jaarMetIndeling();
    renderBalans();
    const engine = engineResult();
    for (const groep of [...engine.balanceSheet.assetGroups, ...engine.balanceSheet.liabilityEquityGroups]) {
      const rij = screen
        .getAllByTestId("statement-group-total")
        .find((r) => r.getAttribute("data-group") === groep.key);
      if (!rij) continue;
      expect(rij, groep.key).toHaveTextContent(bedrag(groep.totalCents));
    }
  });

  it("5b. en de subtotalen van de groepen tellen exact op tot dat categorietotaal", () => {
    jaarMetIndeling();
    const engine = engineResult();
    const secties = subgroupSectionsForGroups(engine.balanceSheet.assetGroups, state.accounts);
    expect(secties.length).toBeGreaterThan(0);
    for (const s of secties) {
      expect(s.totalsMatch, s.group.key).toBe(true);
      expect(sectionsCoverAllLines(s), s.group.key).toBe(true);
    }
  });

  it("6. de balanstotalen en het verschil zijn onveranderd", () => {
    jaarMetIndeling();
    renderBalans();
    const engine = engineResult();
    const totalen = screen.getAllByTestId("statement-total");
    expect(totalen[0]).toHaveTextContent(bedrag(engine.balanceSheet.totalAssetsCents));
    expect(totalen[1]).toHaveTextContent(bedrag(engine.balanceSheet.totalLiabilitiesEquityCents));
  });

  it("7. het W&V-resultaat is onveranderd", () => {
    jaarMetIndeling();
    renderWv();
    const engine = engineResult();
    expect(screen.getByTestId("statement-total")).toHaveTextContent(
      bedrag(engine.profitLoss.netResultCents),
    );
  });

  it("7b. geen enkele regel raakt zoek of dubbel, in welke groep dan ook", () => {
    jaarMetIndeling();
    const engine = engineResult();
    const alle = [
      ...engine.balanceSheet.assetGroups,
      ...engine.balanceSheet.liabilityEquityGroups,
      ...engine.profitLoss.groups,
    ];
    for (const groep of alle) {
      const s = subgroupSectionsFor(groep, new Map(state.accounts.map((a: any) => [a.id, a.report_subgroup ?? null])));
      const ids = s.sections.flatMap((sec) => sec.lines.map((l) => l.accountId));
      expect(ids.slice().sort(), groep.key).toEqual(groep.lines.map((l) => l.accountId).slice().sort());
      expect(new Set(ids).size, groep.key).toBe(ids.length);
    }
  });
});

// ── W&V en de presentatiekopjes ─────────────────────────────────────────────

describe("W&V: dezelfde hiërarchie, met de clusterkopjes als presentatie", () => {
  it("14. Overige bedrijfskosten toont Huisvestingskosten en Kantoorkosten als kopje", () => {
    jaarMetIndeling();
    renderWv();
    const clusters = screen.getAllByTestId("statement-cluster").map((r) => r.textContent?.trim());
    expect(clusters).toContain("Huisvestingskosten");
    expect(clusters).toContain("Kantoorkosten");
  });

  it("14b. die kopjes zijn presentatie: ze bestaan niet als opgeslagen waarde", () => {
    jaarMetIndeling();
    const engine = engineResult();
    const secties = subgroupSectionsForGroups(engine.profitLoss.groups, state.accounts);
    const sleutels = secties.flatMap((s) => s.sections.map((sec) => sec.key));
    // Het cluster is een LABEL naast de sectie, nooit haar sleutel.
    expect(sleutels).not.toContain("Huisvestingskosten");
    expect(sleutels).not.toContain("Kantoorkosten");
    expect(sleutels).toContain("huur");
    expect(sleutels).toContain("automatisering_software");
  });

  it("14c. de laag schrijft nergens een subgroep terug", () => {
    jaarMetIndeling();
    const voor = state.accounts.map((a: any) => a.report_subgroup ?? null);
    const engine = engineResult();
    subgroupSectionsForGroups(engine.profitLoss.groups, state.accounts);
    subgroupSectionsForGroups(engine.balanceSheet.assetGroups, state.accounts);
    expect(state.accounts.map((a: any) => a.report_subgroup ?? null)).toEqual(voor);
  });
});

// ── gedrag zonder indeling ──────────────────────────────────────────────────

describe("zolang er niets is ingedeeld, blijft het rapport zoals het was", () => {
  it("de tabel toont geen leeg tweede niveau", () => {
    state.accounts = [
      acc({ id: "a-bank", nummer: 1100, omschrijving: "Bank", statement_type: "balans", report_group: "vlottende_activa" }),
      acc({ id: "a-kap", nummer: 610, omschrijving: "Kapitaal", categorie: "passiva", statement_type: "balans", report_group: "eigen_vermogen" }),
    ];
    state.rows = [...entry("a-bank", "a-kap", "5000.00", d("01-01"))];
    renderBalans();
    expect(screen.queryByTestId("statement-subgroup")).not.toBeInTheDocument();
    // maar de regels staan er gewoon
    expect(screen.getAllByTestId("statement-line").length).toBeGreaterThan(0);
  });

  it("en de pure laag zegt dat ook", () => {
    state.accounts = [
      acc({ id: "a-bank", statement_type: "balans", report_group: "vlottende_activa" }),
    ];
    state.rows = [...entry("a-bank", "a-bank", "1.00", d("01-01"))];
    const engine = engineResult();
    expect(anySubgroupsPresent(subgroupSectionsForGroups(engine.balanceSheet.assetGroups, state.accounts))).toBe(false);
  });
});

// ── sortering ───────────────────────────────────────────────────────────────

describe("sortering", () => {
  it("13. de volgorde binnen een groep blijft die van de engine (report_sort, dan nummer)", () => {
    const EERST = acc({
      id: "a-sort-1", nummer: 1900, omschrijving: "Eerst", statement_type: "balans",
      report_group: "vlottende_activa", report_subgroup: "liquide_middelen", report_sort: 1,
    });
    const TWEEDE = acc({
      id: "a-sort-2", nummer: 1000, omschrijving: "Tweede", statement_type: "balans",
      report_group: "vlottende_activa", report_subgroup: "liquide_middelen", report_sort: 2,
    });
    const KAP = acc({ id: "a-kap", nummer: 610, categorie: "passiva", statement_type: "balans", report_group: "eigen_vermogen" });
    state.accounts = [TWEEDE, EERST, KAP];
    state.rows = [
      ...entry(EERST.id, KAP.id, "100.00", d("01-01")),
      ...entry(TWEEDE.id, KAP.id, "200.00", d("01-02")),
    ];

    const engine = engineResult();
    const engineVolgorde = engine.balanceSheet.assetGroups.flatMap((g) => g.lines.map((l) => l.accountId));
    const secties = subgroupSectionsForGroups(engine.balanceSheet.assetGroups, state.accounts);
    const sectieVolgorde = secties.flatMap((s) => s.sections.flatMap((sec) => sec.lines.map((l) => l.accountId)));
    expect(sectieVolgorde).toEqual(engineVolgorde);
    // report_sort wint van het rekeningnummer — dat was zo en blijft zo.
    expect(engineVolgorde).toEqual([EERST.id, TWEEDE.id]);
  });
});

// ── systeemregels ───────────────────────────────────────────────────────────

describe("systeemregels", () => {
  it("8. de resultaatregels blijven presentatie: geen rekeningnummer, geen groep, geen drilldown", () => {
    jaarMetIndeling();
    renderBalans();
    const regels = screen.getAllByTestId("statement-system-line");
    expect(regels.length).toBe(2);
    for (const regel of regels) {
      expect(within(regel).queryByRole("link")).toBeNull();
      expect(regel).toHaveAttribute("data-system-line");
      // Ze horen niet in een subgroepsectie thuis.
      expect(regel.getAttribute("data-subgroup")).toBeNull();
    }
  });

  it("8b. ze staan niet in de opgedeelde regels van welke groep dan ook", () => {
    jaarMetIndeling();
    const engine = engineResult();
    const secties = subgroupSectionsForGroups(engine.balanceSheet.liabilityEquityGroups, state.accounts);
    for (const s of secties) {
      for (const sec of s.sections) {
        for (const line of sec.lines) expect(line.synthetic).toBe(false);
      }
    }
  });
});

// ── statische grenzen ───────────────────────────────────────────────────────

describe("de grenzen van deze laag", () => {
  const lib = readFileSync("src/lib/financial-statements-subgroups.ts", "utf8");
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const libCode = strip(lib);

  it("9. er wordt niets afgeleid uit een rekeningnummer of een naam", () => {
    expect(libCode).not.toMatch(/\bnummer\b|accountNumber|omschrijving|accountName|categorie/);
    expect(libCode).not.toMatch(/\d{3,4}\s*(<=|<|>=|>)|(<=|<|>=|>)\s*\d{3,4}/);
    expect(libCode).not.toMatch(/\.(startsWith|endsWith|match|test)\(/);
  });

  it("10/11. deze laag schrijft nergens: geen database, geen mutatie van de invoer", () => {
    expect(libCode).not.toMatch(/supabase|\.rpc\(|\.insert\(|\.update\(|\.delete\(|from\(/);
    expect(libCode).not.toMatch(/ledger_postings|report_group\s*=|report_subgroup\s*=[^=]/);
    // De engine en de kern worden hier niet aangeroepen; deze laag leest alleen
    // wat zij al hebben opgeleverd.
    expect(libCode).not.toMatch(/buildAccountReport|buildFinancialStatements\(|toCents\(/);
  });

  it("10b. de regels van de engine worden niet gekopieerd of aangepast, alleen opgedeeld", () => {
    jaarMetIndeling();
    const engine = engineResult();
    const groep = engine.balanceSheet.assetGroups.find((g) => g.key === "vlottende_activa")!;
    const s = subgroupSectionsFor(groep, new Map(state.accounts.map((a: any) => [a.id, a.report_subgroup ?? null])));
    // Identiteit, niet alleen gelijkheid: het zijn dezelfde objecten.
    for (const sec of s.sections) {
      for (const line of sec.lines) {
        expect(groep.lines.includes(line)).toBe(true);
      }
    }
    // En de groep zelf gaat ongewijzigd mee.
    expect(s.group).toBe(groep);
    expect(s.group.totalCents).toBe(groep.totalCents);
  });

  it("15. een bankrekening komt onder Liquide middelen zonder dat haar nummer iets doet", () => {
    // Dezelfde rekening, een volstrekt ander nummer: de indeling verandert niet.
    const KAP = acc({ id: "a-kap", nummer: 610, categorie: "passiva", statement_type: "balans", report_group: "eigen_vermogen" });
    for (const nummer of [1100, 4242, 9]) {
      state.accounts = [{ ...BANK, nummer }, KAP];
      state.rows = [...entry(BANK.id, KAP.id, "5000.00", d("01-01"))];
      const engine = engineResult();
      const secties = subgroupSectionsForGroups(engine.balanceSheet.assetGroups, state.accounts);
      const liquide = secties
        .flatMap((s) => s.sections)
        .find((sec) => sec.key === "liquide_middelen");
      expect(liquide, `nummer ${nummer}`).toBeDefined();
      expect(liquide!.lines.map((l) => l.accountId), `nummer ${nummer}`).toEqual([BANK.id]);
    }
  });
});

describe("scope", () => {
  it("12. geen migratie, en de rekenlagen blijven byte-voor-byte gelijk", (ctx) => {
    let toon: (p: string) => string;
    let changed: string[];
    try {
      execFileSync("git", ["rev-parse", "origin/main"], { stdio: ["ignore", "pipe", "ignore"] });
      toon = (p) => execFileSync("git", ["show", `origin/main:${p}`], { encoding: "utf8" });
      changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).split("\n").filter(Boolean);
    } catch {
      ctx.skip();
      return;
    }
    // Dit is een presentatie-PR: geen enkele rekenlaag mag bewegen.
    for (const p of [
      "src/lib/financial-statements.ts",
      "src/lib/ledger-reporting.ts",
      "src/lib/proef-saldibalans.ts",
      "src/lib/financial-statements-presentation.ts",
      "src/hooks/useFinancialStatements.ts",
      "src/lib/reporting-classification.ts",
    ]) {
      expect(readFileSync(p, "utf8"), p).toBe(toon(p));
    }
    assertBranchSqlLeavesReportingAlone(changed);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    expect(changed).not.toContain("package.json");
    expect(changed).not.toContain("package-lock.json");
  });
});
