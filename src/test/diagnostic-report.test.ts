import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  buildAccountReport,
  yearPeriod,
  LedgerReportingError,
  type LedgerPeriod,
} from "@/lib/ledger-reporting";
import { buildTrialBalance, type TrialBalance } from "@/lib/proef-saldibalans";
import {
  buildFinancialStatements,
  movementOnPeriodStartFromRows,
  openingBalanceContributionFromRows,
  type FinancialStatementsResult,
} from "@/lib/financial-statements";
import { subgroupSectionsForGroups, UNASSIGNED_SUBGROUP_KEY } from "@/lib/financial-statements-subgroups";
import { computeLedgerCompleteness, type OpeningBalanceCompleteness } from "@/lib/ledger-completeness";
import type { LedgerIntegrityReport } from "@/lib/ledger-integrity";
import {
  available,
  integrityChecks,
  integrityChecksCoverAll,
  runDiagnostics,
  unavailable,
  type DiagnosticRunInput,
} from "@/lib/diagnostic-report";

/**
 * Diagnostics v1 — het controlerapport.
 *
 * Elk bedrag en elk oordeel hieronder komt uit de ÉCHTE kern, de échte
 * kolommenbalans en de échte jaarrekeningmotor; er staat geen enkel met de
 * hand verzonnen getal in een verwachting. Wat deze suite bewaakt is niet
 * "rendert het iets", maar de twee beloften waarop een controlerapport staat
 * of valt:
 *
 *   1. het verzint niets — elke uitspraak is er al een van een bestaande laag;
 *   2. het kan nooit groen zijn over iets wat het niet heeft kunnen zien.
 */

const YEAR = 2026;
const VORIG = YEAR - 1;
const period = yearPeriod(YEAR);

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

const acc = <T extends { id: string }>(over: T) => ({
  nummer: 1000, omschrijving: "Rekening", categorie: "activa", actief: true,
  statement_type: null as string | null, report_group: null as string | null,
  report_subgroup: null as string | null, normal_side: null, report_sort: null,
  ...over,
});

const BANK = acc({
  id: "a-bank", nummer: 1100, omschrijving: "Rekening-courant bank",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: "liquide_middelen",
});
const KAPITAAL = acc({
  id: "a-kap", nummer: 610, omschrijving: "Kapitaal", categorie: "passiva",
  statement_type: "balans", report_group: "eigen_vermogen", report_subgroup: "ondernemingsvermogen",
});
const OMZET = acc({
  id: "a-omzet", nummer: 8200, omschrijving: "Omzet hoog", categorie: "omzet",
  statement_type: "winst_verlies", report_group: "netto_omzet", report_subgroup: "omzet_hoog_tarief",
});
/** Wél een categorie, nog géén groep — het tweede taxonomieniveau ontbreekt. */
const VOORUIT = acc({
  id: "a-vooruit", nummer: 1400, omschrijving: "Vooruitbetaald",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: null,
});
/** Helemaal niet geclassificeerd. */
const ONBEKEND = acc({ id: "a-onbekend", nummer: 9999, omschrijving: "Nog in te delen", categorie: "onbekend" });
/** Bestaat, maar er is nooit op geboekt. */
const SLAPEND = acc({
  id: "a-slapend", nummer: 1500, omschrijving: "Slapende rekening",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: "liquide_middelen",
});

const SCHOON_INTEGRITY: LedgerIntegrityReport = {
  findings: [], errorCount: 0, warningCount: 0,
  byKind: {
    factuur_zonder_regels: 0, legacy_tekst_zonder_rekening: 0,
    marker_zonder_boekingsgroep: 0, boekingsgroep_niet_in_balans: 0,
  },
};

const BEGINBALANS_GEBOEKT: OpeningBalanceCompleteness = {
  state: "posted", year: YEAR, assertionYear: YEAR, draftCount: 0,
  label: "Geboekt", severity: "complete", note: null,
};

/** Elke bron volledig geboekt; door de échte `computeLedgerCompleteness`. */
const ALLES_GEBOEKT = computeLedgerCompleteness({
  purchase: { eligible: 2, posted: 2 },
  sales: { eligible: 1, posted: 1, refusedVerlegd: 0 },
  bank: { eligible: 0, posted: 0, awaitingInvoice: 0 },
  manual: { total: 0, posted: 0 },
});

/** Eén inkoopfactuur staat klaar maar is nog niet geboekt. */
const OPENSTAAND = computeLedgerCompleteness({
  purchase: { eligible: 3, posted: 2 },
  sales: { eligible: 1, posted: 1, refusedVerlegd: 0 },
  bank: { eligible: 0, posted: 0, awaitingInvoice: 0 },
  manual: { total: 0, posted: 0 },
});

// ── De echte motoren, één keer bekabeld ────────────────────────────────────

function scoped(rows: readonly Record<string, unknown>[], clientId: string, per: LedgerPeriod) {
  return rows.filter((r) => r.client_id === clientId && (r.posting_date as string) < per.toExclusive);
}

function trialBalanceOf(rows: readonly Record<string, unknown>[], accounts: readonly unknown[], clientId = "client-1", per = period): TrialBalance {
  const report = buildAccountReport({ rows: scoped(rows, clientId, per) as never, clientId, period: per, accounts: accounts as never });
  return buildTrialBalance({ report, accounts: accounts as never, clientId });
}

function statementsOf(rows: readonly Record<string, unknown>[], accounts: readonly unknown[], clientId = "client-1", per = period): FinancialStatementsResult {
  const rijen = scoped(rows, clientId, per) as never;
  const report = buildAccountReport({ rows: rijen, clientId, period: per, accounts: accounts as never });
  return buildFinancialStatements({
    report, period: per, accounts: accounts as never,
    openingBalanceContribution: openingBalanceContributionFromRows(rijen, per),
    movementOnPeriodStart: movementOnPeriodStartFromRows(rijen, per),
  });
}

function sectionsOf(result: FinancialStatementsResult, accounts: readonly unknown[]) {
  if (result.ok !== true) return [];
  return subgroupSectionsForGroups(
    [...result.balanceSheet.assetGroups, ...result.balanceSheet.liabilityEquityGroups, ...result.profitLoss.groups],
    accounts as never,
  );
}

function inputFor(
  rows: readonly Record<string, unknown>[],
  accounts: readonly unknown[],
  over: Partial<DiagnosticRunInput> = {},
  per = period,
): DiagnosticRunInput {
  const statements = statementsOf(rows, accounts, "client-1", per);
  return {
    trialBalance: available(trialBalanceOf(rows, accounts, "client-1", per)),
    integrity: available(SCHOON_INTEGRITY),
    statements: available(statements),
    openingBalance: available(BEGINBALANS_GEBOEKT),
    completeness: available(ALLES_GEBOEKT),
    subgroupSections: available(sectionsOf(statements, accounts)),
    ...over,
  };
}

/** Een gezonde, volledig geclassificeerde administratie. */
function gezond() {
  return {
    accounts: [BANK, KAPITAAL, OMZET],
    rows: [
      ...entry(BANK.id, KAPITAAL.id, "5000.00", `${VORIG}-06-01`),
      ...entry(BANK.id, OMZET.id, "1210.00", `${YEAR}-03-01`),
    ],
  };
}

const check = (run: ReturnType<typeof runDiagnostics>, id: string) =>
  run.checks.find((c) => c.id === id);

// ── 1. Alles akkoord ───────────────────────────────────────────────────────

describe("een gezonde administratie", () => {
  it("1. alle controles slagen en er is geen waarschuwing of blokkade", () => {
    const { rows, accounts } = gezond();
    const run = runDiagnostics(inputFor(rows, accounts));
    expect(run.ok).toBe(true);
    expect(run.summary.blocking).toBe(0);
    expect(run.summary.warnings).toBe(0);
    expect(run.summary.executed).toBeGreaterThanOrEqual(8);
    expect(run.summary.passed).toBe(run.summary.executed);
    expect(check(run, "trial_balance")?.summary).toBe("Kolommenbalans sluit.");
  });

  it("1c. openstaand boekwerk is een waarschuwing en zegt dat het niet periodegebonden is", () => {
    const { rows, accounts } = gezond();
    const run = runDiagnostics(inputFor(rows, accounts, { completeness: available(OPENSTAAND) }));
    const c = check(run, "bank_outstanding");
    expect(c?.severity).toBe("warning");
    expect(c?.count).toBe(1);
    expect(c?.summary).toContain("hele administratie");
    expect(run.summary.blocking).toBe(0);
  });

  it("1b. een lege administratie leest niet als een geslaagde controle", () => {
    const run = runDiagnostics(inputFor([], [BANK, KAPITAAL, OMZET]));
    // Niets geboekt is geen bevinding, maar ook geen geruststelling.
    expect(check(run, "trial_balance")?.severity).toBe("ok");
    expect(check(run, "trial_balance")?.summary).toContain("niets geboekt");
    expect(check(run, "trial_balance")?.summary).not.toBe("Kolommenbalans sluit.");
  });

  it("10. een rekening zonder enige beweging levert geen bevinding op", () => {
    const { rows } = gezond();
    const accounts = [BANK, KAPITAAL, OMZET, SLAPEND];
    const run = runDiagnostics(inputFor(rows, accounts));
    // SLAPEND is volledig geclassificeerd maar heeft nul mutaties: zij mag de
    // classificatiecontrole niet laten uitslaan en niets blokkeren.
    expect(check(run, "classification")?.severity).toBe("ok");
    expect(run.summary.warnings).toBe(0);
    expect(run.summary.blocking).toBe(0);
  });
});

// ── 2. Onbalans ────────────────────────────────────────────────────────────

describe("een grootboek dat niet sluit", () => {
  /** Eén losse debetregel zonder tegenboeking: de kolommenbalans kan niet sluiten. */
  const scheef = () => {
    const rows = [
      ...entry(BANK.id, KAPITAAL.id, "5000.00", `${VORIG}-06-01`),
      {
        client_id: "client-1", posting_group_id: "g-scheef", posting_date: `${YEAR}-03-01`,
        boekjaar: YEAR, currency: "EUR", source_type: "manual_journal",
        id: "g-scheef-1", line_no: 1, grootboekrekening_id: BANK.id,
        debit_amount: "100.00", credit_amount: "0.00",
      },
    ];
    return { rows, accounts: [BANK, KAPITAAL, OMZET] };
  };

  it("2. onbalans in de periode is een blokkade, geen waarschuwing", () => {
    const { rows, accounts } = scheef();
    const run = runDiagnostics(inputFor(rows, accounts));
    const periode = check(run, "period_balance");
    expect(periode?.severity).toBe("error");
    expect(run.summary.blocking).toBeGreaterThan(0);
    // Het verschil komt uit de kolommenbalans zelf, niet uit een eigen telling.
    expect(periode?.amountCents).toBe(10000);
  });

  it("2b. de kolommenbalans meldt dat zij niet sluit", () => {
    const { rows, accounts } = scheef();
    const run = runDiagnostics(inputFor(rows, accounts));
    expect(check(run, "trial_balance")?.severity).toBe("error");
    expect(check(run, "trial_balance")?.summary).not.toBe("Kolommenbalans sluit.");
  });

  it("2c. een niet-sluitende boekingsgroep komt ongewijzigd uit de integriteitscontrole", () => {
    const { rows, accounts } = gezond();
    const rapport: LedgerIntegrityReport = {
      ...SCHOON_INTEGRITY,
      errorCount: 1,
      byKind: { ...SCHOON_INTEGRITY.byKind, boekingsgroep_niet_in_balans: 1 },
      findings: [{
        kind: "boekingsgroep_niet_in_balans", severity: "error",
        subject: "g-1", detail: "debet 100, credit 0",
        reference: { soort: "boekingsgroep", id: "g-1" },
      }],
    };
    const run = runDiagnostics(inputFor(rows, accounts, { integrity: available(rapport) }));
    expect(check(run, "posting_groups")?.severity).toBe("error");
    expect(check(run, "posting_groups")?.count).toBe(1);
  });
});

// ── Regressie: geen enkele bevinding mag wegvallen ─────────────────────────

/**
 * De P1 uit de review. De eerste versie filterde de integriteitsbevindingen op
 * `reference.soort === "boekingsgroep"` en liet daarmee `factuur_zonder_regels`
 * vallen — een BLOKKERENDE bevinding die /grootboek/integriteit wél toont.
 * Resultaat: dit rapport zei "alles akkoord" terwijl er een gebroken invariant
 * open stond. Deze tests vallen om zodra dat terugkomt.
 */
describe("elke integriteitsbevinding telt mee", () => {
  const rapportMet = (findings: LedgerIntegrityReport["findings"]): LedgerIntegrityReport => ({
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warningCount: findings.filter((f) => f.severity === "waarschuwing").length,
    byKind: { ...SCHOON_INTEGRITY.byKind },
  });

  const FACTUUR_ZONDER_REGELS: LedgerIntegrityReport["findings"][number] = {
    kind: "factuur_zonder_regels", severity: "error",
    subject: "INV-001", detail: "geen boekingsregels",
    reference: { soort: "inkoopfactuur", id: "i1" },
  };
  const LEGACY_TEKST: LedgerIntegrityReport["findings"][number] = {
    kind: "legacy_tekst_zonder_rekening", severity: "waarschuwing",
    subject: "INV-002", detail: "tekst is geen rekening",
    reference: { soort: "inkoopfactuur", id: "i2" },
  };

  it("2d. een blokkerende factuur_zonder_regels maakt de uitkomst NIET groen", () => {
    const { rows, accounts } = gezond();
    const run = runDiagnostics(
      inputFor(rows, accounts, { integrity: available(rapportMet([FACTUUR_ZONDER_REGELS])) }),
    );
    expect(run.summary.blocking).toBeGreaterThan(0);
    expect(check(run, "source_documents")?.severity).toBe("error");
    expect(check(run, "source_documents")?.count).toBe(1);
  });

  it("2e. een documentwaarschuwing komt als waarschuwing door, niet als blokkade", () => {
    const { rows, accounts } = gezond();
    const run = runDiagnostics(
      inputFor(rows, accounts, { integrity: available(rapportMet([LEGACY_TEKST])) }),
    );
    expect(check(run, "source_documents")?.severity).toBe("warning");
    expect(run.summary.blocking).toBe(0);
    expect(run.summary.warnings).toBeGreaterThan(0);
  });

  it("2f. elke bevinding wordt precies één keer geteld, ook een onbekende soort", () => {
    const vreemd = {
      kind: "boekingsgroep_niet_in_balans", severity: "error",
      subject: "x", detail: "x",
      reference: { soort: "iets_nieuws", id: "x1" },
    } as unknown as LedgerIntegrityReport["findings"][number];
    const rapport = rapportMet([FACTUUR_ZONDER_REGELS, LEGACY_TEKST, vreemd]);
    expect(integrityChecksCoverAll(rapport)).toBe(true);
    const geteld = integrityChecks(rapport).reduce((n, c) => n + (c.count ?? 0), 0);
    expect(geteld).toBe(3);
  });

  it("2g. de integriteitscontrole zegt erbij dat zij niet periodegebonden is", () => {
    const { rows, accounts } = gezond();
    const run = runDiagnostics(
      inputFor(rows, accounts, { integrity: available(rapportMet([FACTUUR_ZONDER_REGELS])) }),
    );
    expect(check(run, "source_documents")?.summary).toContain("hele administratie");
  });
});

// ── 3 + 4. Classificatie ───────────────────────────────────────────────────

describe("rapportageclassificatie", () => {
  it("3. een rekening met mutaties zonder classificatie is een waarschuwing, met bedrag", () => {
    const accounts = [BANK, KAPITAAL, OMZET, ONBEKEND];
    const rows = [
      ...entry(BANK.id, KAPITAAL.id, "5000.00", `${VORIG}-06-01`),
      ...entry(ONBEKEND.id, OMZET.id, "1000.00", `${YEAR}-03-01`),
    ];
    const run = runDiagnostics(inputFor(rows, accounts));
    const c = check(run, "classification");
    // De bestaande semantiek: open werk, geen bederf.
    expect(c?.severity).toBe("warning");
    expect(c?.count).toBe(1);
    expect(run.summary.blocking).toBe(0);
    // Het bedrag blijft zichtbaar en komt ongewijzigd uit de motor.
    const statements = statementsOf(rows, accounts);
    if (statements.ok !== true) throw new Error("motor faalde");
    expect(c?.amountCents).toBe(statements.unclassified.closingCents);
    expect(statements.unclassified.withActivityCount).toBe(1);
  });

  it("4. een ontbrekende groep laat geen bedrag verdwijnen", () => {
    const accounts = [BANK, KAPITAAL, OMZET, VOORUIT];
    const rows = [
      ...entry(BANK.id, KAPITAAL.id, "5000.00", `${VORIG}-06-01`),
      ...entry(VOORUIT.id, BANK.id, "250.00", `${YEAR}-05-01`),
    ];
    const statements = statementsOf(rows, accounts);
    if (statements.ok !== true) throw new Error("motor faalde");
    const sections = sectionsOf(statements, accounts);

    const run = runDiagnostics(inputFor(rows, accounts));
    const c = check(run, "subgroups");
    expect(c?.severity).toBe("warning");
    expect(c?.count).toBe(1);

    // Het bedrag staat gewoon in de sectie "Nog niet ingedeeld" — niet weg.
    const nietIngedeeld = sections
      .flatMap((g) => g.sections)
      .filter((s) => s.key === UNASSIGNED_SUBGROUP_KEY)
      .flatMap((s) => s.lines);
    expect(nietIngedeeld.some((l) => l.accountId === VOORUIT.id)).toBe(true);
    // En de subtotalen van elke groep blijven op het groepstotaal uitkomen.
    for (const groep of sections) expect(groep.totalsMatch).toBe(true);
    // De classificatiecontrole slaat NIET aan: een ontbrekende groep is iets
    // anders dan een ontbrekende categorie.
    expect(check(run, "classification")?.severity).toBe("ok");
  });

  it("4b. zolang niemand een groep heeft toegekend is het niveau niet in gebruik", () => {
    const geenGroepen = [
      acc({ id: "b1", nummer: 1100, omschrijving: "Bank", statement_type: "balans", report_group: "vlottende_activa" }),
      acc({ id: "b2", nummer: 610, omschrijving: "Kapitaal", categorie: "passiva", statement_type: "balans", report_group: "eigen_vermogen" }),
    ];
    const rows = entry("b1", "b2", "100.00", `${YEAR}-03-01`);
    const run = runDiagnostics(inputFor(rows, geenGroepen));
    const c = check(run, "subgroups");
    expect(c?.severity).toBe("ok");
    expect(c?.summary).toContain("nog niet in gebruik");
  });
});

// ── 5. Fail closed ─────────────────────────────────────────────────────────

describe("fail closed", () => {
  it("5. een technische storing kan nooit een groene uitkomst opleveren", () => {
    const { rows, accounts } = gezond();
    const run = runDiagnostics(
      inputFor(rows, accounts, { trialBalance: unavailable("Grootboekmutaties") }),
    );
    expect(run.ok).toBe(false);
    if (run.ok !== false) throw new Error("onbereikbaar");
    expect(run.unavailable).toContain("Grootboekmutaties");
    // De vier kolommenbalanscontroles zijn niet uitgevoerd — en dus ook niet
    // als "akkoord" geteld.
    expect(check(run, "trial_balance")).toBeUndefined();
    expect(check(run, "period_balance")).toBeUndefined();
  });

  it("5b. ook wanneer álle overige controles slagen blijft de uitkomst onvolledig", () => {
    const { rows, accounts } = gezond();
    const run = runDiagnostics(
      inputFor(rows, accounts, { completeness: unavailable("Volledigheid per bron") }),
    );
    expect(run.summary.warnings).toBe(0);
    expect(run.summary.blocking).toBe(0);
    // Alles wat draaide is akkoord, en tóch is dit geen "alles akkoord".
    expect(run.summary.passed).toBe(run.summary.executed);
    expect(run.ok).toBe(false);
  });

  it("5c. een gefaalde motor beweert niets over classificatie", () => {
    const { rows, accounts } = gezond();
    const gefaald: FinancialStatementsResult = {
      ok: false, failures: ["kernel_not_ok"], completeness: "unknown",
      diagnostics: {} as never,
    };
    const run = runDiagnostics(inputFor(rows, accounts, { statements: available(gefaald) }));
    expect(check(run, "statements")?.severity).toBe("error");
    // Geen uitspraak over iets waarvan de bron niet kon rekenen.
    expect(check(run, "classification")).toBeUndefined();
  });

  it("5e. een INHOUDELIJKE motorfout wordt niet als technische storing gemeld", () => {
    const { rows, accounts } = gezond();
    const gefaald: FinancialStatementsResult = {
      ok: false, failures: ["coverage_mismatch"], completeness: "unknown",
      diagnostics: {} as never,
    };
    const run = runDiagnostics(inputFor(rows, accounts, {
      statements: available(gefaald),
      // De groepsindeling is dan niet te bepalen — maar dát is boekhoudkundig,
      // geen storing, en mag de run niet als "onvolledig" bestempelen.
      subgroupSections: unavailable("Groepsindeling"),
    }));
    expect(run.ok).toBe(true);
    expect(check(run, "statements")?.severity).toBe("error");
    expect(check(run, "subgroups")).toBeUndefined();
  });

  it("5f. valt de kern om, dan is dat wél een storing", () => {
    const { rows, accounts } = gezond();
    const run = runDiagnostics(inputFor(rows, accounts, {
      subgroupSections: unavailable("Groepsindeling"),
    }));
    expect(run.ok).toBe(false);
    if (run.ok !== false) throw new Error("onbereikbaar");
    expect(run.unavailable).toContain("Groepsindeling");
  });

  it("5d. elke ontbrekende bron wordt bij naam genoemd", () => {
    const { rows, accounts } = gezond();
    const run = runDiagnostics(
      inputFor(rows, accounts, {
        integrity: unavailable("Integriteitscontrole"),
        openingBalance: unavailable("Beginbalans"),
      }),
    );
    if (run.ok !== false) throw new Error("onbereikbaar");
    expect([...run.unavailable].sort()).toEqual(["Beginbalans", "Integriteitscontrole"]);
  });
});

// ── 6 + 7. Grenzen van de kern ─────────────────────────────────────────────

describe("de grenzen van de kern blijven gelden", () => {
  it("6. de kern weigert rijen van een andere administratie", () => {
    const accounts = [BANK, KAPITAAL, OMZET];
    const vreemd = entry(BANK.id, KAPITAAL.id, "999.00", `${YEAR}-06-01`, "client-2");
    expect(() =>
      buildAccountReport({ rows: vreemd as never, clientId: "client-1", period, accounts: accounts as never }),
    ).toThrow(LedgerReportingError);
  });

  it("6b. een controle over client-1 ziet geen cent van client-2", () => {
    const accounts = [BANK, KAPITAAL, OMZET];
    const rows = [
      ...entry(BANK.id, OMZET.id, "1000.00", `${YEAR}-03-01`),
      ...entry(BANK.id, KAPITAAL.id, "999.00", `${YEAR}-06-01`, "client-2"),
    ];
    const tb = trialBalanceOf(rows, accounts);
    if (tb.ok !== true) throw new Error("kolommenbalans faalde");
    const totaal = tb.totals.periodDebitCents;
    expect(totaal).toBe(100000);
    const run = runDiagnostics(inputFor(rows, accounts));
    expect(run.summary.blocking).toBe(0);
  });

  it("7. de periodegrens is halfopen: 31-12 telt mee, 1-1 van het jaar erna niet", () => {
    const accounts = [BANK, KAPITAAL, OMZET];
    const rows = [
      ...entry(BANK.id, OMZET.id, "100.00", `${YEAR}-12-31`),
      ...entry(BANK.id, OMZET.id, "700.00", `${YEAR + 1}-01-01`),
    ];
    const tb = trialBalanceOf(rows, accounts);
    if (tb.ok !== true) throw new Error("kolommenbalans faalde");
    expect(tb.totals.periodDebitCents).toBe(10000);
    const run = runDiagnostics(inputFor(rows, accounts));
    expect(check(run, "period_balance")?.severity).toBe("ok");
  });

  it("7b. een boeking vóór de periode wordt beginsaldo en geen periodemutatie", () => {
    const accounts = [BANK, KAPITAAL, OMZET];
    const rows = entry(BANK.id, KAPITAAL.id, "5000.00", `${VORIG}-06-01`);
    const tb = trialBalanceOf(rows, accounts);
    if (tb.ok !== true) throw new Error("kolommenbalans faalde");
    expect(tb.totals.periodDebitCents).toBe(0);
    expect(tb.totals.openingDebitCents).toBe(500000);
    const run = runDiagnostics(inputFor(rows, accounts));
    expect(check(run, "opening_balance_totals")?.severity).toBe("ok");
    expect(check(run, "period_balance")?.severity).toBe("ok");
  });
});

// ── 8 + 9. De grenzen van de laag zelf ─────────────────────────────────────

describe("de grenzen van de controlelaag", () => {
  const code = (pad: string) =>
    readFileSync(pad, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  const BESTANDEN = [
    "src/lib/diagnostic-report.ts",
    "src/hooks/useDiagnosticSources.ts",
    "src/pages/Controle.tsx",
  ];

  it.each(BESTANDEN)("8. %s bevat geen schrijfpad", (pad) => {
    const bron = code(pad);
    expect(bron).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(bron).not.toMatch(/useMutation/);
    // Geen enkele RPC, ook geen lezende: de controle leest via bestaande hooks.
    expect(bron).not.toMatch(/\.rpc\(/);
    expect(bron).not.toMatch(/@\/integrations\/supabase/);
  });

  it.each(BESTANDEN)("9. %s leidt niets af uit rekeningnummer of naam", (pad) => {
    const bron = code(pad);
    expect(bron).not.toMatch(/\.\s*(nummer|omschrijving)\b/);
    // Geen nummerreeksen ("alles onder 3000 is activa").
    expect(bron).not.toMatch(/\d{3,4}\s*(<=|<|>=|>)|(<=|<|>=|>)\s*\d{3,4}/);
    expect(bron).not.toMatch(/startsWith\(|endsWith\(/);
  });

  it("8b. de controlelaag kent geen achtergrondtaak en geen AI", () => {
    for (const pad of BESTANDEN) {
      const bron = code(pad);
      expect(bron, pad).not.toMatch(/setInterval|setTimeout|cron|schedule/i);
      expect(bron, pad).not.toMatch(/openai|anthropic|llm|prompt/i);
    }
  });

  it("9b. er is één ernstladder: die van accounting-diagnostics", () => {
    const bron = code("src/lib/diagnostic-report.ts");
    // Geen tweede woordenschat in het model.
    expect(bron).not.toMatch(/"pass"|"blocking"|"fail"|"critical"/);
    expect(bron).toContain('from "./accounting-diagnostics"');
  });

  it("9c. de controlelaag rekent geen bedragen uit", () => {
    const bron = code("src/lib/diagnostic-report.ts");
    // De enige toegestane rekensom is debet − credit uit een bestaand verschil.
    expect(bron).not.toMatch(/reduce\(\(.*\)\s*=>\s*.*\+\s*(signedAmountCents|debit_amount|credit_amount)/);
    expect(bron).not.toMatch(/\/\s*100|\*\s*100/);
    expect(bron).not.toMatch(/parseFloat|Number\(/);
  });
});
