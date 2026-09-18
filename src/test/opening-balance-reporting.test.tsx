import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  buildAccountReport,
  buildRunningBalance,
  LEDGER_SOURCE_LABELS,
  OPENING_BALANCE_ROUTE,
  openingBalanceRoute,
  resolveLedgerSource,
  type LedgerPostingLike,
} from "@/lib/ledger-reporting";
import {
  computeLedgerCompleteness,
  computeOpeningBalanceCompleteness,
  OPENING_BALANCE_STATE_LABELS,
  reportYearForPeriod,
  unknownOpeningBalanceCompleteness,
  type OpeningBalanceCompletenessState,
} from "@/lib/ledger-completeness";
import { buildTrialBalance } from "@/lib/proef-saldibalans";
import { LedgerCompletenessNotice } from "@/components/grootboek/LedgerCompletenessNotice";
import { GrootboekAccountMutations } from "@/components/grootboek/GrootboekAccountMutations";
import type { OpeningBalanceMarker, OpeningBalanceRow } from "@/lib/opening-balance-utils";
import { useOpeningBalanceCompleteness } from "@/hooks/useLedgerCompleteness";

const overviewState = {
  data: undefined as { headers: OpeningBalanceRow[]; marker: OpeningBalanceMarker | null } | undefined,
  isPending: false,
  isError: false,
};
const { overviewSpy } = vi.hoisted(() => ({ overviewSpy: vi.fn() }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u-1" } }) }));
vi.mock("@/hooks/useOpeningBalances", () => ({
  useOpeningBalanceOverview: (clientId?: string) => {
    overviewSpy(clientId);
    return overviewState;
  },
}));

/**
 * Fase 6C-b8 PR 3 — rapportage-integratie van de beginbalans: bronlabel,
 * drilldown, volledigheidsdimensie en het bewijs dat er géén tweede
 * rekenpad is bijgekomen. Nummering volgt de testmatrix van de opdracht.
 */

const OB_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

let seq = 0;
const p = (over: Partial<LedgerPostingLike> & Pick<LedgerPostingLike, "grootboekrekening_id">): LedgerPostingLike => {
  seq += 1;
  return {
    id: `p-${String(seq).padStart(4, "0")}`,
    client_id: "c-1",
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
    ...over,
  };
};
const grp = (g: string, date: string, legs: Array<[string, number, number]>, over: Partial<LedgerPostingLike> = {}) =>
  legs.map(([acc, d, c], i) =>
    p({ posting_group_id: g, line_no: i + 1, posting_date: date, grootboekrekening_id: acc, debit_amount: d, credit_amount: c, ...over }),
  );

const accounts = [
  { id: "gb-1100", nummer: 1100, omschrijving: "Bank", categorie: "activa", actief: true },
  { id: "gb-1300", nummer: 1300, omschrijving: "Debiteuren", categorie: "activa", actief: true },
  { id: "gb-1600", nummer: 1600, omschrijving: "Crediteuren", categorie: "passiva", actief: true },
  { id: "gb-4000", nummer: 4000, omschrijving: "Kosten", categorie: "kosten", actief: true },
];
const YEAR_2027 = { from: "2027-01-01", toExclusive: "2028-01-01" };

const headerRow = (over: Partial<OpeningBalanceRow> = {}): OpeningBalanceRow => ({
  id: OB_ID,
  organization_id: "org-1",
  client_id: "c-1",
  user_id: "u-1",
  boekjaar: 2027,
  opening_date: "2027-01-01",
  description: "Beginbalans 2027",
  reference: null,
  nil_declaration: false,
  nil_declared_at: null,
  nil_declared_by: null,
  created_at: "2027-01-01T00:00:00Z",
  updated_at: "2027-01-01T00:00:00Z",
  ...over,
});
const markerRow = (over: Partial<OpeningBalanceMarker> = {}): OpeningBalanceMarker => ({
  opening_balance_id: OB_ID,
  posting_group_id: "g-ob",
  organization_id: "org-1",
  client_id: "c-1",
  user_id: "u-1",
  boekjaar: 2027,
  opening_date: "2027-01-01",
  line_count: 2,
  total_amount: 1000,
  created_at: "2027-01-02T00:00:00Z",
  ...over,
});
const nilRow = (over: Partial<OpeningBalanceRow> = {}) =>
  headerRow({ nil_declaration: true, nil_declared_at: "2027-01-05T10:00:00Z", nil_declared_by: "u-9", ...over });

const completeDocs = () =>
  computeLedgerCompleteness({
    purchase: { eligible: 1, posted: 1 },
    sales: { eligible: 0, posted: 0, refusedVerlegd: 0 },
    bank: { eligible: 0, posted: 0, awaitingInvoice: 0 },
    manual: { total: 0, posted: 0 },
  });

describe("bronlabel en drilldown", () => {
  it("1/2. opening_balance → 'Beginbalans'; de andere labels zijn ongewijzigd", () => {
    expect(LEDGER_SOURCE_LABELS.opening_balance).toBe("Beginbalans");
    expect(LEDGER_SOURCE_LABELS).toMatchObject({
      purchase_invoice: "Inkoop",
      sales_invoice: "Verkoop",
      bank_allocation: "Bank",
      manual_journal: "Memoriaal",
    });
    expect(resolveLedgerSource("opening_balance", OB_ID).label).toBe("Beginbalans");
    expect(resolveLedgerSource("purchase_invoice", "pi-1")).toMatchObject({ label: "Inkoop", path: "/facturen/inkoop/pi-1" });
    expect(resolveLedgerSource("manual_journal", "mj-1")).toMatchObject({ label: "Memoriaal", path: "/grootboek/memoriaal" });
  });

  it("3/32. de route wijst naar de beginbalanspagina onder Grootboek, met het kop-id als doel", () => {
    expect(resolveLedgerSource("opening_balance", OB_ID)).toEqual({
      kind: "resolved",
      sourceType: "opening_balance",
      label: "Beginbalans",
      path: `/grootboek/beginbalans?openingBalanceId=${OB_ID}`,
    });
    expect(OPENING_BALANCE_ROUTE).toBe("/grootboek/beginbalans");
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toMatch(/path="\/grootboek\/beginbalans"/);
  });

  it("4. source_id ís de kop-id (opening_balances.id): zo schrijft de boeker hem en zo eist de claimtrigger het", () => {
    const sql = readFileSync("supabase/migrations/20260919120000_add_opening_balance_posting.sql", "utf8")
      .split("\n")
      .filter((r) => !r.trimStart().startsWith("--"))
      .join("\n");
    // De INSERT in post_opening_balance(): source_type, source_id, source_line_id ← 'opening_balance', v_header.id, v_line.id
    expect(sql).toMatch(/description, source_type, source_id, source_line_id, user_id[\s\S]*?'opening_balance', v_header\.id, v_line\.id, v_uid/);
    // En de claimtrigger zoekt de claim op opening_balance_id = NEW.source_id.
    expect(sql).toMatch(/WHERE opening_balance_id = NEW\.source_id/);
  });

  it("5. een ontbrekend of misvormd source_id landt veilig op de pagina zelf, zonder doelparameter", () => {
    expect(openingBalanceRoute(null)).toBe("/grootboek/beginbalans");
    expect(openingBalanceRoute("")).toBe("/grootboek/beginbalans");
    expect(openingBalanceRoute("not-a-uuid")).toBe("/grootboek/beginbalans");
    expect(openingBalanceRoute("<script>")).toBe("/grootboek/beginbalans");
    expect(resolveLedgerSource("opening_balance", "abc")).toMatchObject({ kind: "resolved", path: "/grootboek/beginbalans" });
  });

  it("37. de mutatieregel toont 'Beginbalans' en een link met betekenisvolle toegankelijke naam", () => {
    const rows = [
      ...grp("g-ob", "2027-01-01", [["gb-1300", 1000, 0], ["gb-1600", 0, 1000]], {
        source_type: "opening_balance",
        source_id: OB_ID,
        description: "Beginbalans 2027",
      }),
      ...grp("g-1", "2027-02-01", [["gb-1300", 0, 250], ["gb-1100", 250, 0]], { source_type: "bank_allocation", source_id: "al-1" }),
    ];
    const running = buildRunningBalance({ rows, clientId: "c-1", accountId: "gb-1300", period: YEAR_2027, accounts });
    render(
      <MemoryRouter>
        <GrootboekAccountMutations running={running} periodLabel="2027" />
      </MemoryRouter>,
    );
    const obRow = screen.getAllByTestId("mutation-row").find((r) => r.getAttribute("data-source-type") === "opening_balance")!;
    expect(obRow).toHaveTextContent("Beginbalans");
    expect(obRow).not.toHaveTextContent("opening_balance");
    // Datum, omschrijving en bedrag zijn het grootboekfeit zelf.
    expect(obRow).toHaveTextContent("01-01-2027");
    expect(obRow).toHaveTextContent("Beginbalans 2027");
    expect(obRow.textContent!.replace(/\u00a0/g, " ")).toContain("€ 1.000,00");
    const link = within(obRow).getByRole("link", { name: "Open bron (Beginbalans) van Beginbalans 2027" });
    expect(link).toHaveAttribute("href", `/grootboek/beginbalans?openingBalanceId=${OB_ID}`);
  });
});

describe("volledigheid — beginbalansdimensie", () => {
  const compute = (headers: OpeningBalanceRow[], marker: OpeningBalanceMarker | null, year: number | null = 2027) =>
    computeOpeningBalanceCompleteness({ headers, marker, year });

  it("9. geen kop → not_set (onvolledig)", () => {
    expect(compute([], null)).toMatchObject({ state: "not_set", severity: "incomplete", label: "Niet ingesteld", year: 2027 });
  });

  it("10/16. concept → draft; meerdere concepten → draft met aantal, nooit volledig", () => {
    expect(compute([headerRow()], null)).toMatchObject({ state: "draft", severity: "incomplete", draftCount: 1 });
    const multi = compute([headerRow(), headerRow({ id: "ob-2", opening_date: "2027-01-02" })], null);
    expect(multi).toMatchObject({ state: "draft", severity: "incomplete", draftCount: 2 });
    expect(multi.note).toMatch(/2 concepten/);
  });

  it("11. claimrij → posted (volledig)", () => {
    expect(compute([headerRow()], markerRow())).toMatchObject({ state: "posted", severity: "complete", assertionYear: 2027, label: "Geboekt" });
  });

  it("12/13. nihil → nil (volledig, expliciet 'Nihil') en nooit gelijk aan not_set", () => {
    const nil = compute([nilRow()], null);
    expect(nil).toMatchObject({ state: "nil", severity: "complete", label: "Nihil" });
    const notSet = compute([], null);
    expect(nil.state).not.toBe(notSet.state);
    expect(nil.label).not.toBe(notSet.label);
    expect(nil.severity).not.toBe(notSet.severity);
  });

  it("14/36. een mislukte controle → unknown, nooit not_set", () => {
    const u = unknownOpeningBalanceCompleteness(2027);
    expect(u).toMatchObject({ state: "unknown", severity: "unknown", label: "Onbekend", note: "Kon beginbalansstatus niet controleren." });
    expect(u.state).not.toBe("not_set");
  });

  it("15. geboekt én nihil → conflict (onbekend, nooit volledig)", () => {
    const c = compute([nilRow()], markerRow({ opening_balance_id: "ob-x" }));
    expect(c).toMatchObject({ state: "conflict", severity: "unknown", label: "Conflict" });
    expect(compute([headerRow({ nil_declaration: true })], null).state).toBe("conflict");
  });

  it("17/18. het rapportjaar kiest de passende bewering; een ander boekjaar telt niet als passend", () => {
    expect(compute([headerRow()], markerRow(), 2027).state).toBe("posted");
    const other = compute([headerRow({ boekjaar: 2026, opening_date: "2026-01-01" })], markerRow({ boekjaar: 2026, opening_date: "2026-01-01" }), 2027);
    expect(other).toMatchObject({ state: "other_year", severity: "incomplete", assertionYear: 2026, year: 2027 });
    expect(other.note).toMatch(/boekjaar 2026, niet voor rapportjaar 2027/);
    // Concepten van een ander jaar maken het rapportjaar niet 'draft'.
    expect(compute([headerRow({ boekjaar: 2026, opening_date: "2026-01-01" })], null, 2027)).toMatchObject({ state: "not_set" });
    expect(compute([nilRow({ boekjaar: 2026, opening_date: "2026-01-01" })], null, 2027).state).toBe("other_year");
  });

  it("19. het rapportjaar volgt de periode; meerdere kalenderjaren zijn niet te bepalen en nooit volledig", () => {
    expect(reportYearForPeriod(YEAR_2027)).toBe(2027);
    expect(reportYearForPeriod({ from: "2027-02-01", toExclusive: "2027-03-01" })).toBe(2027);
    expect(reportYearForPeriod({ from: "2027-12-01", toExclusive: "2028-01-01" })).toBe(2027);
    expect(reportYearForPeriod({ from: "2027-12-01", toExclusive: "2028-01-02" })).toBeNull();
    expect(reportYearForPeriod({ from: "2000-01-01", toExclusive: "2101-01-01" })).toBeNull();
    const amb = compute([headerRow()], markerRow(), null);
    expect(amb).toMatchObject({ state: "ambiguous", severity: "unknown", label: "Niet te bepalen voor meerdere boekjaren" });
  });

  it("de uitkomst bevat nooit een bedrag", () => {
    const c = compute([headerRow()], markerRow());
    expect(Object.keys(c)).not.toContain("total_amount");
    expect(JSON.stringify(c)).not.toMatch(/1000|amount/);
  });
});

describe("LedgerCompletenessNotice — beginbalansrij", () => {
  const ob = (state: OpeningBalanceCompletenessState) => {
    if (state === "unknown") return unknownOpeningBalanceCompleteness(2027);
    const byState: Record<Exclude<OpeningBalanceCompletenessState, "unknown">, () => ReturnType<typeof computeOpeningBalanceCompleteness>> = {
      not_set: () => computeOpeningBalanceCompleteness({ headers: [], marker: null, year: 2027 }),
      draft: () => computeOpeningBalanceCompleteness({ headers: [headerRow()], marker: null, year: 2027 }),
      posted: () => computeOpeningBalanceCompleteness({ headers: [headerRow()], marker: markerRow(), year: 2027 }),
      nil: () => computeOpeningBalanceCompleteness({ headers: [nilRow()], marker: null, year: 2027 }),
      other_year: () => computeOpeningBalanceCompleteness({ headers: [], marker: markerRow({ boekjaar: 2026 }), year: 2027 }),
      conflict: () => computeOpeningBalanceCompleteness({ headers: [nilRow()], marker: markerRow({ opening_balance_id: "x" }), year: 2027 }),
      ambiguous: () => computeOpeningBalanceCompleteness({ headers: [], marker: null, year: null }),
    };
    return byState[state]();
  };
  const renderWith = (state: OpeningBalanceCompletenessState) =>
    render(
      <MemoryRouter>
        <LedgerCompletenessNotice completeness={completeDocs()} openingBalance={ob(state)} />
      </MemoryRouter>,
    );

  it("29/30/31. alle toestanden hebben een eigen, expliciete tekst; geboekt ≠ nihil en niet ingesteld ≠ concept", () => {
    const seen = new Map<string, string>();
    for (const state of ["not_set", "draft", "posted", "nil", "other_year", "conflict", "ambiguous", "unknown"] as const) {
      const { unmount } = renderWith(state);
      const row = screen.getByTestId("completeness-opening_balance");
      expect(row).toHaveAttribute("data-ob-state", state);
      expect(row).toHaveTextContent(OPENING_BALANCE_STATE_LABELS[state]);
      seen.set(state, OPENING_BALANCE_STATE_LABELS[state]);
      unmount();
    }
    expect(new Set(seen.values()).size).toBe(seen.size);
    expect(seen.get("posted")).not.toBe(seen.get("nil"));
    expect(seen.get("not_set")).not.toBe(seen.get("draft"));
  });

  it("geboekt of nihil → melding volledig; niet ingesteld, concept of ander jaar → onvolledig; onbekend → onbekend", () => {
    for (const [state, expected] of [
      ["posted", "complete"],
      ["nil", "complete"],
      ["not_set", "incomplete"],
      ["draft", "incomplete"],
      ["other_year", "incomplete"],
      ["conflict", "incomplete"],
      ["ambiguous", "incomplete"],
      ["unknown", "incomplete"],
    ] as const) {
      const { unmount } = renderWith(state);
      expect(screen.getByTestId("ledger-completeness"), state).toHaveAttribute("data-status", expected);
      unmount();
    }
  });

  it("nihil wordt expliciet zo benoemd en nooit als 'niet ingesteld' getoond", () => {
    renderWith("nil");
    const row = screen.getByTestId("completeness-opening_balance");
    expect(row).toHaveTextContent("Nihil");
    expect(row).toHaveTextContent("bewust op nihil gezet");
    expect(row).not.toHaveTextContent("Niet ingesteld");
  });

  it("14. fout bij de controle → 'Onbekend' met 'Kon beginbalansstatus niet controleren', geen groen", () => {
    render(
      <MemoryRouter>
        <LedgerCompletenessNotice completeness={completeDocs()} openingBalance={undefined} openingBalanceError />
      </MemoryRouter>,
    );
    const row = screen.getByTestId("completeness-opening_balance");
    expect(row).toHaveAttribute("data-ob-state", "unknown");
    expect(row).toHaveTextContent("Kon beginbalansstatus niet controleren");
    expect(screen.getByTestId("ledger-completeness")).toHaveAttribute("data-status", "incomplete");
  });

  it("de rij linkt naar de beginbalans met een betekenisvolle naam; zonder de prop verandert de melding niet", () => {
    renderWith("posted");
    expect(screen.getByRole("link", { name: "Open de beginbalans van deze administratie" })).toHaveAttribute("href", "/grootboek/beginbalans");
    expect(screen.getByTestId("ledger-completeness")).toHaveTextContent("de beginbalans is vastgelegd");
  });

  it("40. oude aanroepers zonder beginbalansprop zien de bestaande melding ongewijzigd", () => {
    render(<LedgerCompletenessNotice completeness={completeDocs()} />);
    expect(screen.queryByTestId("completeness-opening_balance")).toBeNull();
    expect(screen.getByTestId("ledger-completeness")).toHaveAttribute("data-status", "complete");
    expect(screen.getByTestId("ledger-completeness")).toHaveTextContent("Alle postbare documenten zijn geboekt (alle jaren)");
  });
});

describe("geen dubbeltelling — het grootboek blijft de enige financiële bron", () => {
  const obGroup = () =>
    grp("g-ob", "2027-01-01", [["gb-1300", 1000, 0], ["gb-1600", 0, 1000]], { source_type: "opening_balance", source_id: OB_ID });
  const bankGroup = () => grp("g-1", "2027-02-01", [["gb-1100", 250, 0], ["gb-1300", 0, 250]], { source_type: "bank_allocation", source_id: "al-1" });

  it("21. het rekeningrapport telt de beginbalansregels precies één keer", () => {
    const report = buildAccountReport({ rows: [...obGroup(), ...bankGroup()], clientId: "c-1", period: YEAR_2027, accounts });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const deb = report.rollups.find((r) => r.account.id === "gb-1300")!;
    expect(deb.openingCents).toBe(0);
    expect(deb.periodDebitCents).toBe(100000);
    expect(deb.periodCreditCents).toBe(25000);
    expect(deb.closingCents).toBe(75000);
    expect(report.totals.periodDebitCents).toBe(125000);
    expect(report.totals.periodCreditCents).toBe(125000);
  });

  it("20. de proef- en saldibalans bevat het beginbalansbedrag precies één keer", () => {
    const report = buildAccountReport({ rows: [...obGroup(), ...bankGroup()], clientId: "c-1", period: YEAR_2027, accounts });
    const tb = buildTrialBalance({ report, accounts, clientId: "c-1" });
    expect(tb.ok).toBe(true);
    if (!tb.ok) return;
    expect(tb.totals.periodDebitCents).toBe(125000);
    expect(tb.totals.periodCreditCents).toBe(125000);
    const cred = tb.rows.find((r) => r.account.id === "gb-1600")!;
    expect(cred.closingCreditCents).toBe(100000);
    expect(cred.closingDebitCents).toBe(0);
  });

  it("22/39. het bronlabel verandert niets aan de cijfers: dezelfde regels als memoriaal geven exact hetzelfde rapport", () => {
    const asOb = buildAccountReport({ rows: [...obGroup(), ...bankGroup()], clientId: "c-1", period: YEAR_2027, accounts });
    const asManual = buildAccountReport({
      rows: [...grp("g-ob", "2027-01-01", [["gb-1300", 1000, 0], ["gb-1600", 0, 1000]], { source_type: "manual_journal" }), ...bankGroup()],
      clientId: "c-1",
      period: YEAR_2027,
      accounts,
    });
    expect(asOb.ok && asManual.ok).toBe(true);
    if (!asOb.ok || !asManual.ok) return;
    expect(asOb.totals).toEqual(asManual.totals);
    expect(asOb.rollups.map((r) => [r.account.id, r.openingCents, r.periodDebitCents, r.periodCreditCents, r.closingCents])).toEqual(
      asManual.rollups.map((r) => [r.account.id, r.openingCents, r.periodDebitCents, r.periodCreditCents, r.closingCents]),
    );
  });

  it("de beginbalans van vorig jaar komt als beginsaldo binnen via het grootboek, nooit apart", () => {
    const rows = [
      ...grp("g-ob", "2026-01-01", [["gb-1300", 1000, 0], ["gb-1600", 0, 1000]], { source_type: "opening_balance", source_id: OB_ID }),
      ...bankGroup(),
    ];
    const report = buildAccountReport({ rows, clientId: "c-1", period: YEAR_2027, accounts });
    if (!report.ok) throw new Error("rapport ongeldig");
    const deb = report.rollups.find((r) => r.account.id === "gb-1300")!;
    expect(deb.openingCents).toBe(100000);
    expect(deb.periodDebitCents).toBe(0);
    expect(deb.closingCents).toBe(75000);
  });
});

describe("useOpeningBalanceCompleteness — één query per administratie", () => {
  function Probe({ period }: { period: { from: string; toExclusive: string } }) {
    const r = useOpeningBalanceCompleteness("c-1", period);
    return <div data-testid="probe" data-state={r.data?.state ?? "none"} data-error={String(r.isError)} />;
  }

  it("14/36. een mislukte lezing van de domeintabellen → unknown, nooit not_set", () => {
    overviewState.data = undefined;
    overviewState.isError = true;
    render(<Probe period={YEAR_2027} />);
    expect(screen.getByTestId("probe")).toHaveAttribute("data-state", "unknown");
    expect(screen.getByTestId("probe")).toHaveAttribute("data-error", "true");
  });

  it("28. de status komt uit het bestaande overzicht van de administratie (koppen + claim), zonder extra query per rij", () => {
    overviewSpy.mockClear();
    overviewState.isError = false;
    overviewState.data = { headers: [headerRow()], marker: markerRow() };
    render(<Probe period={YEAR_2027} />);
    expect(screen.getByTestId("probe")).toHaveAttribute("data-state", "posted");
    expect(overviewSpy).toHaveBeenCalledWith("c-1");
    // Het rapportjaar komt uit de periode; meerdere jaren → niet te bepalen.
    const { unmount } = render(<Probe period={{ from: "2000-01-01", toExclusive: "2101-01-01" }} />);
    expect(screen.getAllByTestId("probe")[1]).toHaveAttribute("data-state", "ambiguous");
    unmount();
  });
});

describe("statische bewaking", () => {
  const reportingFiles = [
    "src/lib/ledger-reporting.ts",
    "src/lib/ledger-completeness.ts",
    "src/hooks/useLedgerCompleteness.ts",
    "src/components/grootboek/LedgerCompletenessNotice.tsx",
    "src/components/grootboek/GrootboekAccountMutations.tsx",
    "src/pages/GrootboekSaldi.tsx",
    "src/pages/ProefSaldibalans.tsx",
    "src/lib/proef-saldibalans.ts",
  ].map((path) => ({
    path,
    // Commentaar telt niet mee: de kern documenteert juist dat journal_entries er NIET in zit.
    text: readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((r) => !r.trimStart().startsWith("//"))
      .join("\n"),
  }));

  it("22/23/24/35. geen opening_balance_lines-bedragen, geen journal_entries, geen documenttotalen, geen overdracht van vorig jaar", () => {
    for (const { path, text } of reportingFiles) {
      expect(text, path).not.toMatch(/opening_balance_lines/);
      expect(text, path).not.toMatch(/journal_entries/);
      expect(text, path).not.toMatch(/amount_incl|amount_excl|btw_amount|remaining_amount/);
      expect(text, path).not.toMatch(/carry|overdracht|eindsaldo vorig/i);
    }
    // De volledigheidshook leest voor de beginbalans alleen het bestaande overzicht (koppen + claim), geen bedragkolommen.
    const hook = reportingFiles.find((f) => f.path.endsWith("useLedgerCompleteness.ts"))!.text;
    expect(hook).toMatch(/useOpeningBalanceOverview\(clientId\)/);
    expect(hook).not.toMatch(/total_amount|debit_amount|credit_amount/);
  });

  it("28. de volledigheid komt uit één query per administratie; de mutatietabel doet per rij geen enkele query", () => {
    const table = reportingFiles.find((f) => f.path.endsWith("GrootboekAccountMutations.tsx"))!.text;
    expect(table).not.toMatch(/useQuery|supabase|useOpeningBalance/);
    const notice = reportingFiles.find((f) => f.path.endsWith("LedgerCompletenessNotice.tsx"))!.text;
    expect(notice).not.toMatch(/useQuery|supabase/);
  });

  it("de rapportagekern (ledger-reporting.ts) is buiten het bronblok byte-voor-byte ongewijzigd", () => {
    let base: string;
    try {
      base = execFileSync("git", ["show", "origin/main:src/lib/ledger-reporting.ts"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return; // geen origin/main (ondiepe clone): niets te vergelijken
    }
    const cut = (s: string) => s.slice(0, s.indexOf("// ── Bron-drilldown"));
    expect(cut(readFileSync("src/lib/ledger-reporting.ts", "utf8"))).toBe(cut(base));
  });

  it("25/26/27/33/34. geen migratie, types, package of nav in deze branch; de boekers zijn niet aangeraakt", () => {
    let changed: string[];
    try {
      changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split("\n")
        .filter(Boolean);
    } catch {
      return;
    }
    expect(changed.filter((f) => f.startsWith("supabase/") || f.endsWith(".sql"))).toEqual([]);
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
    expect(changed).not.toContain("package.json");
    expect(changed.filter((f) => /nav\.ts$|package-lock|bun\.lockb|App\.tsx$/.test(f))).toEqual([]);
    expect(changed.filter((f) => /useOpeningBalancePosting|useManualJournal|usePurchaseInvoicePosting|useSalesInvoicePosting|useBankAllocationPosting/.test(f))).toEqual([]);
    // De beginbalanspagina krijgt alleen doelselectie: geen nieuwe RPC- of mutatie-aanroep.
    const diff = execFileSync("git", ["diff", "origin/main...HEAD", "--", "src/pages/Beginbalans.tsx"], { encoding: "utf8" });
    const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(added.some((l) => /mutateAsync|\.rpc\(|\.insert\(|\.update\(|\.delete\(/.test(l))).toBe(false);
  });
});
