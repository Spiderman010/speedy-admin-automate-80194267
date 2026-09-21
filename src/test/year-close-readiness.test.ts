import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { buildAccountReport, yearPeriod, LedgerReportingError } from "@/lib/ledger-reporting";
import { buildTrialBalance } from "@/lib/proef-saldibalans";
import {
  buildFinancialStatements,
  movementOnPeriodStartFromRows,
  openingBalanceContributionFromRows,
  type FinancialStatementsResult,
} from "@/lib/financial-statements";
import { subgroupSectionsForGroups } from "@/lib/financial-statements-subgroups";
import { computeLedgerCompleteness, type OpeningBalanceCompleteness } from "@/lib/ledger-completeness";
import type { LedgerIntegrityReport } from "@/lib/ledger-integrity";
import { evaluateReversalIntegrity, REVERSAL_SOURCE_TYPE } from "@/lib/reversal-integrity";
import { accountsForClient } from "@/lib/account-scope";
import { available, runDiagnostics, unavailable, type DiagnosticRunInput } from "@/lib/diagnostic-report";
import {
  activityByBoekjaar,
  evaluateYearClose,
  yearActivity,
  yearAlreadyClosed,
  yearOrder,
  type YearCloseInput,
} from "@/lib/year-close-readiness";

/**
 * Jaarafsluiting — gereedheid (PR 1).
 *
 * Alles loopt door de ÉCHTE kern, de échte kolommenbalans, de échte
 * jaarrekeningmotor en de échte controle van Diagnostics v1/v1.1. Wat deze
 * suite bewaakt is de belofte van een afsluitcontrole: zij zegt nooit "gereed"
 * over iets wat zij niet heeft kunnen vaststellen, en zij verzint geen
 * permissieve regel die dit product niet kent.
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
  client_id: null as string | null,
  statement_type: null as string | null, report_group: null as string | null,
  report_subgroup: null as string | null, normal_side: null, report_sort: null,
  ...over,
});

const BANK = acc({
  id: "a-bank", nummer: 1100, omschrijving: "Bank",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: "liquide_middelen",
});
const KAPITAAL = acc({
  id: "a-kap", nummer: 610, omschrijving: "Kapitaal", categorie: "passiva",
  statement_type: "balans", report_group: "eigen_vermogen", report_subgroup: "ondernemingsvermogen",
});
const OMZET = acc({
  id: "a-omzet", nummer: 8200, omschrijving: "Omzet", categorie: "omzet",
  statement_type: "winst_verlies", report_group: "netto_omzet", report_subgroup: "omzet_hoog_tarief",
});
/** Inactief, maar met historie: moet zichtbaar blijven voor de rapportage. */
const INACTIEF = acc({
  id: "a-oud", nummer: 1900, omschrijving: "Opgeheven rekening", actief: false, client_id: "client-1",
  statement_type: "balans", report_group: "vlottende_activa", report_subgroup: "liquide_middelen",
});

const SCHOON_INTEGRITY: LedgerIntegrityReport = {
  findings: [], errorCount: 0, warningCount: 0,
  byKind: {
    factuur_zonder_regels: 0, legacy_tekst_zonder_rekening: 0,
    marker_zonder_boekingsgroep: 0, boekingsgroep_niet_in_balans: 0,
  },
};
const GEEN_TEGENBOEKINGEN = evaluateReversalIntegrity({ markers: [], postings: [] });
const BEGINBALANS_GEBOEKT: OpeningBalanceCompleteness = {
  state: "posted", year: YEAR, assertionYear: YEAR, draftCount: 0,
  label: "Geboekt", severity: "complete", note: null,
};
const ALLES_GEBOEKT = computeLedgerCompleteness({
  purchase: { eligible: 1, posted: 1 },
  sales: { eligible: 0, posted: 0, refusedVerlegd: 0 },
  bank: { eligible: 0, posted: 0, awaitingInvoice: 0 },
  manual: { total: 0, posted: 0 },
});

// ── De echte motoren ───────────────────────────────────────────────────────

function scoped(rows: readonly Record<string, unknown>[], clientId: string) {
  return rows.filter((r) => r.client_id === clientId && (r.posting_date as string) < period.toExclusive);
}

function statementsOf(rows: readonly Record<string, unknown>[], accounts: readonly unknown[]): FinancialStatementsResult {
  const rijen = scoped(rows, "client-1") as never;
  const report = buildAccountReport({ rows: rijen, clientId: "client-1", period, accounts: accounts as never });
  return buildFinancialStatements({
    report, period, accounts: accounts as never,
    openingBalanceContribution: openingBalanceContributionFromRows(rijen, period),
    movementOnPeriodStart: movementOnPeriodStartFromRows(rijen, period),
  });
}

function diagnosticInput(
  rows: readonly Record<string, unknown>[],
  accounts: readonly unknown[],
  over: Partial<DiagnosticRunInput> = {},
): DiagnosticRunInput {
  const rijen = scoped(rows, "client-1") as never;
  const report = buildAccountReport({ rows: rijen, clientId: "client-1", period, accounts: accounts as never });
  const statements = statementsOf(rows, accounts);
  return {
    trialBalance: available(buildTrialBalance({ report, accounts: accounts as never, clientId: "client-1" })),
    integrity: available(SCHOON_INTEGRITY),
    reversals: available(GEEN_TEGENBOEKINGEN),
    statements: available(statements),
    openingBalance: available(BEGINBALANS_GEBOEKT),
    completeness: available(ALLES_GEBOEKT),
    subgroupSections: available(
      statements.ok === true
        ? subgroupSectionsForGroups(
            [...statements.balanceSheet.assetGroups, ...statements.balanceSheet.liabilityEquityGroups, ...statements.profitLoss.groups],
            accounts as never,
          )
        : [],
    ),
    ...over,
  };
}

/** Een gezonde administratie met boekingen in YEAR. */
function gezond() {
  return {
    accounts: [BANK, KAPITAAL, OMZET],
    rows: [...entry(BANK.id, OMZET.id, "1210.00", `${YEAR}-03-01`)],
  };
}

function readiness(
  rows: readonly Record<string, unknown>[],
  accounts: readonly unknown[],
  over: Partial<YearCloseInput> = {},
  diagOver: Partial<DiagnosticRunInput> = {},
) {
  return evaluateYearClose({
    clientId: "client-1",
    fiscalYear: YEAR,
    diagnostics: runDiagnostics(diagnosticInput(rows, accounts, diagOver)),
    closedThrough: available(null),
    activityByYear: available(activityByBoekjaar(rows as never)),
    ...over,
  });
}

const check = (r: ReturnType<typeof evaluateYearClose>, id: string) => r.checks.find((c) => c.id === id);

// ── 1. Gezond ──────────────────────────────────────────────────────────────

describe("een gezond boekjaar", () => {
  it("1. is gereed voor afsluiten", () => {
    const { rows, accounts } = gezond();
    const r = readiness(rows, accounts);
    expect(r.status).toBe("ready");
    expect(r.summary.blocking).toBe(0);
    expect(r.summary.warnings).toBe(0);
    expect(r.unavailable).toHaveLength(0);
    // De bestaande controle zit er volledig in, plus de drie jaarvragen.
    expect(r.summary.executed).toBeGreaterThanOrEqual(12);
    expect(check(r, "year_activity")?.severity).toBe("ok");
  });

  it("15. de bedragen blijven exact in centen", () => {
    const { rows, accounts } = gezond();
    const statements = statementsOf(rows, accounts);
    if (statements.ok !== true) throw new Error("motor faalde");
    // 1210,00 omzet — geen afronding, geen float.
    expect(statements.profitLoss.netResultCents).toBe(121000);
  });
});

// ── 2-5. Blokkades ─────────────────────────────────────────────────────────

describe("blokkades", () => {
  it("2. een onbalans in het grootboek blokkeert", () => {
    const accounts = [BANK, KAPITAAL, OMZET];
    const rows = [{
      client_id: "client-1", posting_group_id: "g-scheef", posting_date: `${YEAR}-03-01`,
      boekjaar: YEAR, currency: "EUR", source_type: "manual_journal",
      id: "s1", line_no: 1, grootboekrekening_id: BANK.id, debit_amount: "100.00", credit_amount: "0.00",
    }];
    const r = readiness(rows, accounts);
    expect(r.status).toBe("blocked");
    expect(r.summary.blocking).toBeGreaterThan(0);
  });

  it("3. een gebroken boekingsintegriteit blokkeert", () => {
    const { rows, accounts } = gezond();
    const kapot: LedgerIntegrityReport = {
      ...SCHOON_INTEGRITY, errorCount: 1,
      findings: [{
        kind: "boekingsgroep_niet_in_balans", severity: "error",
        subject: "g-1", detail: "debet 100, credit 0",
        reference: { soort: "boekingsgroep", id: "g-1" },
      }],
    };
    const r = readiness(rows, accounts, {}, { integrity: available(kapot) });
    expect(r.status).toBe("blocked");
    expect(check(r, "posting_groups")?.severity).toBe("error");
  });

  it("4. een gebroken tegenboekingslineage blokkeert", () => {
    const { rows, accounts } = gezond();
    const kapot = evaluateReversalIntegrity({
      markers: [],
      postings: [{
        id: "t1", client_id: "client-1", grootboekrekening_id: BANK.id,
        posting_group_id: "g-t", debit_amount: "0.00", credit_amount: "100.00",
        currency: "EUR", source_type: REVERSAL_SOURCE_TYPE, source_id: null,
        reversal_of_posting_id: null,
      }],
    });
    expect(kapot.findings.length).toBeGreaterThan(0);
    const r = readiness(rows, accounts, {}, { reversals: available(kapot) });
    expect(r.status).toBe("blocked");
    expect(check(r, "reversal_integrity")?.severity).toBe("error");
  });

  it("5. een jaarrekening die niet gebouwd kan worden blokkeert", () => {
    const { rows, accounts } = gezond();
    const gefaald: FinancialStatementsResult = {
      ok: false, failures: ["kernel_not_ok"], completeness: "unknown", diagnostics: {} as never,
    };
    const r = readiness(rows, accounts, {}, { statements: available(gefaald) });
    expect(r.status).toBe("blocked");
    expect(check(r, "statements")?.severity).toBe("error");
  });
});

// ── 6-7. Fail closed ───────────────────────────────────────────────────────

describe("fail closed", () => {
  it("6. een onleesbare bron levert 'incomplete', nooit groen", () => {
    const { rows, accounts } = gezond();
    const r = readiness(rows, accounts, {}, { trialBalance: unavailable("Grootboekmutaties") });
    expect(r.status).toBe("incomplete");
    expect(r.unavailable).toContain("Grootboekmutaties");
  });

  it("6b. een onleesbaar afsluitwatermerk levert ook 'incomplete'", () => {
    const { rows, accounts } = gezond();
    const r = readiness(rows, accounts, { closedThrough: unavailable("Administratiegegevens") });
    expect(r.status).toBe("incomplete");
    expect(r.unavailable).toContain("Administratiegegevens");
    // Zonder watermerk wordt er niets over de volgorde beweerd.
    expect(check(r, "year_order")).toBeUndefined();
    expect(check(r, "year_already_closed")).toBeUndefined();
  });

  it("6c. ook wanneer elke andere controle slaagt blijft het onvolledig", () => {
    const { rows, accounts } = gezond();
    const r = readiness(rows, accounts, { activityByYear: unavailable("Grootboekmutaties (alle jaren)") });
    expect(r.summary.blocking).toBe(0);
    expect(r.summary.warnings).toBe(0);
    expect(r.status).toBe("incomplete");
  });

  it("7. een boekjaar zonder boekingen is GEEN gecontroleerd en compleet jaar", () => {
    const accounts = [BANK, KAPITAAL, OMZET];
    const r = readiness([], accounts);
    const c = check(r, "year_activity");
    expect(c?.severity).toBe("warning");
    expect(c?.summary).toContain("niets vastgesteld");
    expect(r.status).not.toBe("ready");
  });
});

// ── 8-10. Bestaande semantiek wordt gevolgd ────────────────────────────────

describe("bestaande semantiek blijft leidend", () => {
  it("8. niet-geclassificeerde activiteit blijft een waarschuwing, geen blokkade", () => {
    const ONBEKEND = acc({ id: "a-onb", nummer: 9999, omschrijving: "Nog in te delen", categorie: "onbekend" });
    const accounts = [BANK, KAPITAAL, OMZET, ONBEKEND];
    const rows = [...entry(ONBEKEND.id, OMZET.id, "500.00", `${YEAR}-03-01`)];
    const r = readiness(rows, accounts);
    expect(check(r, "classification")?.severity).toBe("warning");
    expect(r.summary.blocking).toBe(0);
    expect(r.status).toBe("warning");
  });

  it("9. een ontbrekende groep blijft een waarschuwing", () => {
    const VOORUIT = acc({
      id: "a-vooruit", nummer: 1400, omschrijving: "Vooruitbetaald",
      statement_type: "balans", report_group: "vlottende_activa", report_subgroup: null,
    });
    const accounts = [BANK, KAPITAAL, OMZET, VOORUIT];
    const rows = [...entry(VOORUIT.id, OMZET.id, "250.00", `${YEAR}-04-01`)];
    const r = readiness(rows, accounts);
    expect(check(r, "subgroups")?.severity).toBe("warning");
    expect(r.summary.blocking).toBe(0);
  });

  it("10. een onvolledige beginbalans blijft een waarschuwing, geen blokkade", () => {
    const { rows, accounts } = gezond();
    const onvolledig: OpeningBalanceCompleteness = {
      state: "not_set", year: YEAR, assertionYear: null, draftCount: 0,
      label: "Niet ingesteld", severity: "incomplete", note: null,
    };
    const r = readiness(rows, accounts, {}, { openingBalance: available(onvolledig) });
    expect(check(r, "opening_balance_status")?.severity).toBe("warning");
    expect(r.summary.blocking).toBe(0);
    // Waarschuwingen alleen zijn hier bewust géén gereedheid.
    expect(r.status).toBe("warning");
  });
});

// ── 11-12. Afsluitstatus en volgorde ───────────────────────────────────────

describe("afsluitstatus en volgorde", () => {
  it("11. een al afgesloten boekjaar wordt herkend", () => {
    expect(yearAlreadyClosed(2026, 2026).severity).toBe("error");
    expect(yearAlreadyClosed(2025, 2026).severity).toBe("error");
    expect(yearAlreadyClosed(2027, 2026).severity).toBe("ok");
    expect(yearAlreadyClosed(2026, null).severity).toBe("ok");
    const { rows, accounts } = gezond();
    const r = readiness(rows, accounts, { closedThrough: available(YEAR) });
    expect(r.status).toBe("blocked");
    expect(check(r, "year_already_closed")?.summary).toContain("al afgesloten");
  });

  it("12. een onmogelijke volgorde faalt dicht", () => {
    // 2024 heeft boekingen en is niet afgesloten; 2026 afsluiten zou 2024 en
    // 2025 stilzwijgend meenemen, want het veld is één jaartal met <=.
    const activiteit = new Map([[2024, 4], [YEAR, 2]]);
    const c = yearOrder(YEAR, null, activiteit);
    expect(c.severity).toBe("error");
    expect(c.count).toBe(1);
    expect(c.summary).toContain("2024");

    // Al afgesloten t/m 2025: dan ligt er niets ouders meer open.
    expect(yearOrder(YEAR, 2025, activiteit).severity).toBe("ok");
    // Een leeg tussenliggend jaar is geen bezwaar.
    expect(yearOrder(YEAR, null, new Map([[2024, 0], [YEAR, 2]])).severity).toBe("ok");
  });

  it("12b. de telling per boekjaar komt uit de opgeslagen boekjaar-kolom", () => {
    const rows = [
      ...entry(BANK.id, OMZET.id, "100.00", `${VORIG}-06-01`),
      ...entry(BANK.id, OMZET.id, "100.00", `${YEAR}-06-01`),
    ];
    const per = activityByBoekjaar(rows as never);
    expect(per.get(VORIG)).toBe(2);
    expect(per.get(YEAR)).toBe(2);
    // Een rij zonder boekjaar wordt niet aan een jaar toegerekend.
    expect(activityByBoekjaar([{ boekjaar: null }]).size).toBe(0);
  });

  it("12c. yearActivity telt alleen het gevraagde boekjaar", () => {
    const per = new Map([[VORIG, 10], [YEAR, 3]]);
    expect(yearActivity(YEAR, per).count).toBe(3);
    expect(yearActivity(2099, per).severity).toBe("warning");
  });
});

// ── 13-14. Rekeningscope ───────────────────────────────────────────────────

describe("administratiegrens", () => {
  it("13. administratie A ziet de rekening van administratie B niet", () => {
    const VAN_B = acc({ id: "a-b", nummer: 1201, omschrijving: "Van B", client_id: "client-2" });
    const gescoped = accountsForClient([BANK, KAPITAAL, OMZET, VAN_B], "client-1");
    expect(gescoped.map((a) => a.id)).not.toContain("a-b");
  });

  it("13b. de kern blijft rijen van een andere administratie weigeren", () => {
    const vreemd = entry(BANK.id, OMZET.id, "999.00", `${YEAR}-06-01`, "client-2");
    expect(() =>
      buildAccountReport({ rows: vreemd as never, clientId: "client-1", period, accounts: [BANK, OMZET] as never }),
    ).toThrow(LedgerReportingError);
  });

  it("14. een inactieve rekening met historie blijft meetellen", () => {
    const accounts = accountsForClient([BANK, KAPITAAL, OMZET, INACTIEF], "client-1");
    expect(accounts.map((a) => a.id)).toContain("a-oud");
    const rows = [...entry(INACTIEF.id, OMZET.id, "750.00", `${YEAR}-05-01`)];
    const r = readiness(rows, accounts);
    // De rekening is inactief maar volledig geclassificeerd: geen bevinding,
    // en haar bedrag verdwijnt niet uit de controle.
    expect(check(r, "classification")?.severity).toBe("ok");
    const statements = statementsOf(rows, accounts);
    if (statements.ok !== true) throw new Error("motor faalde");
    expect(statements.profitLoss.netResultCents).toBe(75000);
  });
});

// ── 16-19. De grenzen van deze laag ────────────────────────────────────────

describe("de grenzen van de gereedheidslaag", () => {
  const code = (pad: string) =>
    readFileSync(pad, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  const BESTANDEN = [
    "src/lib/year-close-readiness.ts",
    "src/hooks/useYearCloseSources.ts",
    "src/pages/Jaarafsluiting.tsx",
  ];

  it("16. de resultaatrekening wordt nergens uit nummer, naam of categorie afgeleid", () => {
    for (const pad of BESTANDEN) {
      const bron = code(pad);
      expect(bron, pad).not.toMatch(/9998|9999/);
      expect(bron, pad).not.toMatch(/\.\s*(nummer|omschrijving|categorie)\b/);
      expect(bron, pad).not.toMatch(/\d{3,4}\s*(<=|<|>=|>)|(<=|<|>=|>)\s*\d{3,4}/);
      // Er wordt in PR 1 sowieso geen resultaat bestemd.
      expect(bron, pad).not.toMatch(/resultaatrekening|equityAccount|resultAccount/i);
    }
  });

  it.each(BESTANDEN)("17. %s bevat geen schrijfpad", (pad) => {
    const bron = code(pad);
    expect(bron).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(bron).not.toMatch(/useMutation|\.rpc\(/);
    expect(bron).not.toMatch(/@\/integrations\/supabase/);
    // Geen afsluitmutatie, en geen achtergrondtaak.
    expect(bron).not.toMatch(/afgesloten_boekjaar\s*[:=]/);
    expect(bron).not.toMatch(/setInterval|cron|schedule/i);
  });

  it("18. de controle draait pas na een expliciete handeling", () => {
    const bron = readFileSync("src/pages/Jaarafsluiting.tsx", "utf8");
    // De uitkomst zit in state en wordt in een klikhandler gezet.
    expect(bron).toMatch(/const \[snapshot, setSnapshot\]/);
    expect(bron).toMatch(/onClick=\{voerUit\}/);
    expect(bron).toContain("Gereedheid controleren");
    // Geen actieve afsluitknop in PR 1.
    expect(bron).not.toMatch(/Boekjaar afsluiten|Definitief afsluiten<|onClick=\{.*afsluit/i);
  });

  it("19. de momentopname verandert niet mee met de bronnen", () => {
    const { rows, accounts } = gezond();
    const eerste = readiness(rows, accounts);
    // Dezelfde invoer later opnieuw beoordeeld geeft exact hetzelfde; de
    // uitkomst draagt geen verwijzing naar levende query-state.
    expect(readiness(rows, accounts)).toEqual(eerste);
    expect(Object.isFrozen(eerste.checks)).toBe(false); // geen verborgen proxy
    expect(JSON.parse(JSON.stringify(eerste))).toEqual(eerste);
  });

  it("20. er is één ernstladder, die van accounting-diagnostics", () => {
    const bron = code("src/lib/year-close-readiness.ts");
    expect(bron).toContain('from "./accounting-diagnostics"');
    expect(bron).not.toMatch(/"pass"|"blocking"|"critical"|"fatal"/);
  });
});

// ── Gebroken boekjaren: de grens wordt benoemd, niet geveinsd ──────────────

describe("boekjaar = kalenderjaar", () => {
  it("21. het product kent geen gebroken boekjaar, en deze laag doet niet alsof", () => {
    // Elke schrijver leidt boekjaar af als EXTRACT(YEAR FROM <datum>).
    const writers = [
      "supabase/migrations/20260915140000_add_purchase_ledger_posting.sql",
      "supabase/migrations/20260915160000_add_sales_ledger_posting.sql",
      "supabase/migrations/20260917120000_add_bank_settlement_posting.sql",
      "supabase/migrations/20260918120000_add_manual_journal_posting.sql",
      "supabase/migrations/20260921120000_add_ledger_reversal_posting.sql",
    ];
    for (const pad of writers) {
      expect(readFileSync(pad, "utf8"), pad).toMatch(/v_boekjaar := EXTRACT\(YEAR FROM/);
    }
    // En de beginbalansmigratie zegt het met zoveel woorden.
    expect(readFileSync("supabase/migrations/20260919120000_add_opening_balance_posting.sql", "utf8"))
      .toContain("Broken fiscal years are NOT supported in v1");

    // De gereedheidslaag rekent daarom met kalenderjaren, en zegt dat ook.
    const bron = readFileSync("src/lib/year-close-readiness.ts", "utf8");
    expect(bron).toContain("KALENDERJAAR");
  });

  it("22. de periode van een boekjaar is het halfopen kalenderjaar", () => {
    const p = yearPeriod(YEAR);
    expect(p.from).toBe(`${YEAR}-01-01`);
    expect(p.toExclusive).toBe(`${YEAR + 1}-01-01`);
  });
});
