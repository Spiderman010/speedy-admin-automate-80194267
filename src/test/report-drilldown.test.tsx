import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Van een gerapporteerd bedrag naar de boeking eronder.
 *
 * De harde eis die elke test hier bewaakt is de AANSLUITING: wat het paneel
 * toont moet exact optellen tot het bedrag waarop geklikt is, en de regels
 * eronder moeten van dezelfde administratie en dezelfde periode zijn. Elk
 * bedrag dat hier wordt vergeleken komt uit de échte kern en de échte engine —
 * alleen de datahooks zijn gemockt — zodat geen enkele verwachting een met de
 * hand verzonnen getal is.
 */

const state = {
  rows: [] as any[],
  accounts: [] as any[],
  clientId: "client-1" as string,
};

const writeCalls: string[] = [];

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
    isPending: false, isError: false,
  }),
}));
vi.mock("@/hooks/useLedgerPostings", () => ({
  LEDGER_POSTINGS_QUERY_KEY: "ledger-postings",
  useLedgerPostings: (opts: any) => ({
    data: opts?.clientId && opts?.enabled !== false
      ? state.rows.filter((r) => r.client_id === opts.clientId && r.posting_date < opts.period.toExclusive)
      : undefined,
    isPending: false, isError: false, error: null, refetch: vi.fn(),
  }),
}));
// De reversal-laag praat rechtstreeks met Supabase; elke schrijfpoging valt op.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabel: string) => {
      // `ledger_postings` levert de regels waar het boekingspaneel op draait;
      // de markertabel levert niets, dus geen tegenboeking — het gewone geval.
      const data = tabel === "ledger_postings" ? state.rows : [];
      const chain: any = {
        select: () => chain, eq: () => chain, order: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(r),
        insert: () => { writeCalls.push("insert"); throw new Error("mag niet"); },
        update: () => { writeCalls.push("update"); throw new Error("mag niet"); },
        delete: () => { writeCalls.push("delete"); throw new Error("mag niet"); },
      };
      return chain;
    },
    rpc: (fn: string) =>
      fn === "has_min_role"
        ? Promise.resolve({ data: true, error: null })
        : Promise.resolve({ data: null, error: null }),
  },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));

import Balans from "@/pages/Balans";
import WinstVerlies from "@/pages/WinstVerlies";
import ProefSaldibalans from "@/pages/ProefSaldibalans";
import { buildAccountReport, buildRunningBalance, yearPeriod } from "@/lib/ledger-reporting";
import {
  buildFinancialStatements,
  movementOnPeriodStartFromRows,
  openingBalanceContributionFromRows,
} from "@/lib/financial-statements";
import { subgroupSectionsForGroups } from "@/lib/financial-statements-subgroups";
import { formatCents } from "@/lib/financial-statements-presentation";
import {
  accountReconciliation,
  accountsAreUnique,
  groupView,
  linesBelongToAccount,
  linesWithinPeriod,
  subgroupReconciles,
} from "@/lib/report-drilldown";

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
const VORIG = YEAR - 1;

const BANK = acc({
  id: "a-bank", nummer: 1100, omschrijving: "Rekening-courant bank",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: "liquide_middelen",
});
const DEBITEUREN = acc({
  id: "a-deb", nummer: 1300, omschrijving: "Debiteuren",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: "handelsdebiteuren",
});
const VOORUIT = acc({
  id: "a-vooruit", nummer: 1400, omschrijving: "Vooruitbetaald",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: null,
});
const KAPITAAL = acc({
  id: "a-kap", nummer: 610, omschrijving: "Kapitaal", categorie: "passiva",
  statement_type: "balans", report_group: "eigen_vermogen", report_subgroup: "ondernemingsvermogen",
});
const OMZET = acc({
  id: "a-omzet", nummer: 8200, omschrijving: "Omzet hoog diensten", categorie: "omzet",
  statement_type: "winst_verlies", report_group: "netto_omzet", report_subgroup: "omzet_hoog_tarief",
});
const OMZET_LAAG = acc({
  id: "a-omzet-laag", nummer: 8210, omschrijving: "Omzet laag", categorie: "omzet",
  statement_type: "winst_verlies", report_group: "netto_omzet", report_subgroup: "omzet_laag_tarief",
});

const period = yearPeriod(YEAR);

/**
 * De rijen zoals de hook ze aanlevert: al op administratie gefilterd.
 * `buildRunningBalance` WEIGERT rijen van een andere administratie met een
 * harde fout — de tenantgrens zit dus in de kern zelf, niet in het scherm.
 */
const eigenRijen = (clientId = "client-1") => state.rows.filter((r) => r.client_id === clientId);

const running = (accountId: string) =>
  buildRunningBalance({
    rows: eigenRijen(), clientId: "client-1", accountId, period, accounts: state.accounts,
  });

function engine() {
  const rows = state.rows.filter((r) => r.client_id === state.clientId && r.posting_date < period.toExclusive);
  const report = buildAccountReport({ rows, clientId: state.clientId, period, accounts: state.accounts });
  const result = buildFinancialStatements({
    report, period, accounts: state.accounts,
    openingBalanceContribution: openingBalanceContributionFromRows(rows, period),
    movementOnPeriodStart: movementOnPeriodStartFromRows(rows, period),
  });
  if (!result.ok) throw new Error("engine faalde");
  return result;
}

/** Alle drie de gevallen: ingedeeld, categorie zonder groep, en overloop. */
function jaar() {
  state.accounts = [BANK, DEBITEUREN, VOORUIT, KAPITAAL, OMZET, OMZET_LAAG];
  state.rows = [
    // vorig jaar: dit wordt het beginsaldo van de bank
    ...entry(BANK.id, KAPITAAL.id, "5000.00", `${VORIG}-06-01`),
    // dit jaar
    ...entry(DEBITEUREN.id, OMZET.id, "1210.00", `${YEAR}-03-01`),
    ...entry(BANK.id, OMZET_LAAG.id, "500.00", `${YEAR}-04-01`),
    ...entry(VOORUIT.id, BANK.id, "250.00", `${YEAR}-05-01`),
    // een andere administratie: mag nergens opduiken
    ...entry(BANK.id, KAPITAAL.id, "999.00", `${YEAR}-06-01`, "client-2"),
  ];
}

/**
 * Het boekingspaneel onderin gebruikt de ECHTE react-query (dat is juist de
 * herbruikte laag uit PR #185), dus is er een provider nodig.
 */
function renderPage(pad: string, Pagina: () => JSX.Element) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[pad]}><Pagina /></MemoryRouter>
    </QueryClientProvider>,
  );
}
const renderBalans = () => renderPage("/grootboek/balans", Balans);
const renderWv = () => renderPage("/grootboek/winst-verlies", WinstVerlies);
const renderPsb = () => renderPage("/overzichten/proef-saldibalans", ProefSaldibalans);

/** De rekeningrij van een specifieke rekening aanklikken, niet zomaar de eerste. */
const klikRekening = async (accountId: string) => {
  const rij = (await screen.findAllByTestId("drilldown-account-row")).find(
    (r) => r.getAttribute("data-account-id") === accountId,
  )!;
  fireEvent.click(within(rij).getByTestId("drilldown-open-account"));
};

/** De groep openen waar een bepaalde rekening in zit. */
const klikGroepMet = async (subgroupKey: string) => {
  const rij = (await screen.findAllByTestId("drilldown-subgroup-row")).find(
    (r) => r.getAttribute("data-subgroup") === subgroupKey,
  )!;
  fireEvent.click(within(rij).getByTestId("drilldown-open-subgroup"));
};

const klikGroep = (key: string) =>
  fireEvent.click(screen.getAllByTestId("drilldown-group").find((b) => b.getAttribute("data-group") === key)!);

beforeEach(() => {
  state.rows = [];
  state.accounts = [];
  state.clientId = "client-1";
  writeCalls.length = 0;
});

// ── A. Winst-en-verliesrekening ─────────────────────────────────────────────

describe("W&V", () => {
  it("1/2. de categorie is aanklikbaar en het paneel sluit exact aan op het categorietotaal", async () => {
    jaar();
    renderWv();
    klikGroep("netto_omzet");
    const totaal = engine().profitLoss.groups.find((g) => g.key === "netto_omzet")!.totalCents;
    expect(await screen.findByTestId("drilldown-group-total")).toHaveTextContent(bedrag(totaal));
    expect(screen.queryByTestId("drilldown-mismatch")).toBeNull();
  });

  it("2b. de aansluiting is een eigenschap van het model, niet van het scherm", () => {
    jaar();
    const e = engine();
    const secties = subgroupSectionsForGroups(e.profitLoss.groups, state.accounts);
    for (const g of e.profitLoss.groups) {
      const view = groupView(g, secties.find((s) => s.group.key === g.key));
      expect(view.reconciles, g.key).toBe(true);
      expect(accountsAreUnique(view), g.key).toBe(true);
      for (const sub of view.subgroups) expect(subgroupReconciles(sub), sub.key).toBe(true);
    }
  });

  it("3/4. de groep is aanklikbaar en sluit aan op haar subtotaal", async () => {
    jaar();
    renderWv();
    klikGroep("netto_omzet");
    const naarGroep = (await screen.findAllByTestId("drilldown-open-subgroup"))[0];
    fireEvent.click(naarGroep);
    const e = engine();
    const secties = subgroupSectionsForGroups(e.profitLoss.groups, state.accounts);
    const sub = secties.find((s) => s.group.key === "netto_omzet")!.sections[0];
    expect(await screen.findByTestId("drilldown-subgroup-total")).toHaveTextContent(bedrag(sub.subtotalCents));
  });

  it("5/6. de rekening is aanklikbaar en het paneel toont alleen díe rekening", async () => {
    jaar();
    renderWv();
    klikGroep("netto_omzet");
    fireEvent.click((await screen.findAllByTestId("drilldown-open-subgroup"))[0]);
    fireEvent.click((await screen.findAllByTestId("drilldown-open-account"))[0]);
    await screen.findByTestId("drilldown-account-level");

    expect(linesBelongToAccount(running(OMZET.id), OMZET.id)).toBe(true);
  });

  it("7/8. alleen de geselecteerde administratie en periode komen in de mutaties", () => {
    jaar();
    const r = running(BANK.id);
    expect(linesWithinPeriod(r, period, "client-1")).toBe(true);
    // de regel van client-2 en die van vorig jaar zitten er niet in
    expect(r.lines.some((l) => l.row.client_id === "client-2")).toBe(false);
    expect(r.lines.some((l) => l.row.posting_date < period.from)).toBe(false);
    // En de kern WEIGERT ongefilterde rijen: de tenantgrens is geen schermregel.
    expect(() =>
      buildRunningBalance({
        rows: state.rows, clientId: "client-1", accountId: BANK.id, period, accounts: state.accounts,
      }),
    ).toThrow(/andere administratie/);
  });

  it("9. vanuit een mutatie is het boekingsdetail te openen", async () => {
    jaar();
    renderWv();
    klikGroep("netto_omzet");
    fireEvent.click((await screen.findAllByTestId("drilldown-open-subgroup"))[0]);
    fireEvent.click((await screen.findAllByTestId("drilldown-open-account"))[0]);
    const openKnop = (await screen.findAllByTestId("open-posting-group"))[0];
    expect(openKnop).toBeInTheDocument();
    fireEvent.click(openKnop);
    // 28/29: het bestaande boekingspaneel, met de tegenboekingsactie van PR #185.
    expect(await screen.findByTestId("posting-group-status")).toBeInTheDocument();
    expect(await screen.findByTestId("reversal-open-button")).toHaveTextContent("Tegenboeking maken");
  });
});

// ── B. Balans ───────────────────────────────────────────────────────────────

describe("Balans", () => {
  it("10/11/12. categorie, groep en rekening zijn alle drie doorklikbaar", async () => {
    jaar();
    renderBalans();
    klikGroep("vlottende_activa");
    expect(await screen.findByTestId("drilldown-group-level")).toBeInTheDocument();
    fireEvent.click((await screen.findAllByTestId("drilldown-open-subgroup"))[0]);
    expect(await screen.findByTestId("drilldown-subgroup-level")).toBeInTheDocument();
    fireEvent.click((await screen.findAllByTestId("drilldown-open-account"))[0]);
    expect(await screen.findByTestId("drilldown-account-level")).toBeInTheDocument();
  });

  it("10b. het categorietotaal in het paneel is dat van de engine", async () => {
    jaar();
    renderBalans();
    klikGroep("vlottende_activa");
    const totaal = engine().balanceSheet.assetGroups.find((g) => g.key === "vlottende_activa")!.totalCents;
    expect(await screen.findByTestId("drilldown-group-total")).toHaveTextContent(bedrag(totaal));
  });

  it("13/14/15. beginsaldo en periodemutaties staan apart en tellen op tot het eindsaldo", () => {
    jaar();
    const a = accountReconciliation(running(BANK.id));
    // De bank draagt 5000 uit vorig jaar mee.
    expect(a.openingCents).toBe(500000);
    expect(a.hasOpeningContribution).toBe(true);
    // Dit jaar: +500 ontvangen, −250 betaald.
    expect(a.periodMovementCents).toBe(25000);
    expect(a.openingCents + a.periodMovementCents).toBe(a.closingCents);
    expect(a.reconciles).toBe(true);
  });

  it("13b. het scherm meldt de overloop expliciet in plaats van hem te verzwijgen", async () => {
    jaar();
    renderBalans();
    klikGroep("vlottende_activa");
    await klikGroepMet("liquide_middelen");
    await klikRekening(BANK.id);
    await screen.findByTestId("drilldown-account-level");
    const a = accountReconciliation(running(BANK.id));
    expect(screen.getByTestId("drilldown-opening")).toHaveTextContent(bedrag(a.openingCents));
    expect(screen.getByTestId("drilldown-movement")).toHaveTextContent(bedrag(a.periodMovementCents));
    expect(screen.getByTestId("drilldown-closing")).toHaveTextContent(bedrag(a.closingCents));
    expect(screen.getByTestId("drilldown-opening-notice")).toBeInTheDocument();
  });

  it("16. zonder eerdere boekingen wordt er geen beginsaldo verzonnen", () => {
    jaar();
    const a = accountReconciliation(running(DEBITEUREN.id));
    expect(a.openingCents).toBe(0);
    expect(a.hasOpeningContribution).toBe(false);
    expect(a.reconciles).toBe(true);
  });

  it("23. een rekening met categorie maar zonder groep blijft doorklikbaar", async () => {
    jaar();
    renderBalans();
    klikGroep("vlottende_activa");
    const vangnet = (await screen.findAllByTestId("drilldown-subgroup-row")).find(
      (r) => r.getAttribute("data-subgroup") === "__unassigned__",
    );
    expect(vangnet).toBeDefined();
    expect(within(vangnet!).getByTestId("drilldown-open-subgroup")).toBeInTheDocument();
  });
});

// ── C. Kolommenbalans ───────────────────────────────────────────────────────

describe("Kolommenbalans", () => {
  it("17/18. het rekeningnummer is aanklikbaar en opent de mutaties", async () => {
    jaar();
    renderPsb();
    const knop = (await screen.findAllByTestId("psb-drilldown")).find(
      (b) => b.getAttribute("data-account-id") === BANK.id,
    )!;
    fireEvent.click(knop);
    expect(await screen.findByTestId("drilldown-account-level")).toBeInTheDocument();
  });

  it("19/20/21. de periodekolommen en het eindsaldo sluiten aan op de mutaties", () => {
    jaar();
    const a = accountReconciliation(running(BANK.id));
    const report = buildAccountReport({
      rows: eigenRijen(), clientId: "client-1", period, accounts: state.accounts,
    });
    if (!report.ok) throw new Error("kern faalde");
    const rollup = report.rollups.find((r) => r.account.id === BANK.id)!;
    expect(a.periodDebitCents).toBe(rollup.periodDebitCents);
    expect(a.periodCreditCents).toBe(rollup.periodCreditCents);
    expect(a.closingCents).toBe(rollup.closingCents);
    expect(a.openingCents).toBe(rollup.openingCents);
  });

  it("22. administratie en periode blijven onveranderd tijdens de doorklik", async () => {
    jaar();
    renderPsb();
    const rijenVoor = screen.getAllByTestId("psb-row").length;
    fireEvent.click((await screen.findAllByTestId("psb-drilldown"))[0]);
    await screen.findByTestId("drilldown-account-level");
    // De kolommenbalans staat er nog, met dezelfde rijen: er is niet genavigeerd.
    expect(screen.getAllByTestId("psb-row")).toHaveLength(rijenVoor);
    expect(screen.getByTestId("drilldown-context")).toHaveTextContent("Klant A");
  });
});

// ── Gedeeld ─────────────────────────────────────────────────────────────────

describe("gedeeld", () => {
  it("25. geen rekening staat twee keer in één paneel", () => {
    jaar();
    const e = engine();
    const alle = [...e.balanceSheet.assetGroups, ...e.balanceSheet.liabilityEquityGroups, ...e.profitLoss.groups];
    const secties = subgroupSectionsForGroups(alle, state.accounts);
    for (const g of alle) {
      expect(accountsAreUnique(groupView(g, secties.find((s) => s.group.key === g.key))), g.key).toBe(true);
    }
  });

  it("26/27. geen regel van buiten de periode of van een andere administratie", () => {
    jaar();
    for (const id of [BANK.id, DEBITEUREN.id, OMZET.id]) {
      expect(linesWithinPeriod(running(id), period, "client-1"), id).toBe(true);
    }
  });

  it("30. er wordt nergens geschreven tijdens een doorklik", async () => {
    jaar();
    renderBalans();
    klikGroep("vlottende_activa");
    fireEvent.click((await screen.findAllByTestId("drilldown-open-subgroup"))[0]);
    fireEvent.click((await screen.findAllByTestId("drilldown-open-account"))[0]);
    await screen.findByTestId("drilldown-account-level");
    await waitFor(() => expect(writeCalls).toEqual([]));
  });

  it("30b. de doorkliklaag bevat geen enkel schrijfpad", () => {
    for (const p of [
      "src/lib/report-drilldown.ts",
      "src/components/overzichten/ReportDrilldownSheet.tsx",
    ]) {
      const bron = readFileSync(p, "utf8");
      expect(bron, p).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
      expect(bron, p).not.toMatch(/from\(["']ledger_postings["']\)/);
    }
  });

  it("de doorkliklaag leidt niets af uit nummer, naam of categorie", () => {
    const bron = readFileSync("src/lib/report-drilldown.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    expect(bron).not.toMatch(/categorie/);
    expect(bron).not.toMatch(/\d{3,4}\s*(<=|<|>=|>)|(<=|<|>=|>)\s*\d{3,4}/);
    expect(bron).not.toMatch(/\.(startsWith|endsWith|match|test)\(/);
  });
});

describe("scope", () => {
  it("31/32. geen migratie en geen rekenlaag aangeraakt", (ctx) => {
    let changed: string[];
    let toon: (p: string) => string;
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
    expect(changed.filter((f) => f.startsWith("supabase/"))).toEqual([]);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    expect(changed).not.toContain("package.json");
    for (const p of [
      "src/lib/ledger-reporting.ts",
      "src/lib/financial-statements.ts",
      "src/lib/financial-statements-presentation.ts",
      "src/lib/financial-statements-subgroups.ts",
      "src/lib/proef-saldibalans.ts",
      "src/lib/reporting-classification.ts",
      "src/hooks/useFinancialStatements.ts",
      "src/hooks/useLedgerReversal.ts",
      "src/components/grootboek/LedgerPostingGroupSheet.tsx",
    ]) {
      expect(readFileSync(p, "utf8"), p).toBe(toon(p));
    }
  });
});
