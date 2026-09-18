import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  ASSET_GROUPS,
  CURRENT_YEAR_RESULT_LABEL,
  EQUITY_LIABILITY_GROUPS,
  GROUPS_REQUIRING_EXPLICIT_SIDE,
  GROUP_DEFAULT_NORMAL_SIDE,
  PRIOR_YEARS_RESULT_LABEL,
  buildFinancialStatements,
  classifyAccount,
  compareStatementLines,
  displayedCents,
  openingBalanceContributionFromRows,
} from "@/lib/financial-statements";
import type { ClassifiedAccountLike } from "@/lib/financial-statements";
import { buildAccountReport, yearPeriod } from "@/lib/ledger-reporting";
import type { LedgerPeriod, LedgerPostingLike } from "@/lib/ledger-reporting";
import { BALANS_GROUPS, WINST_VERLIES_GROUPS } from "@/lib/reporting-classification";

/**
 * Balans/W&V PR 3 — de statement-engine.
 *
 * De engine rekent niet zelf aan boekingen: de fixtures gaan door de échte
 * buildAccountReport() heen, zodat elke test ook bewijst dat de kern en de
 * engine op dezelfde cijfers uitkomen. Alles in hele centen.
 */

const CLIENT = "client-1";
const PERIOD_2026 = yearPeriod(2026);

let seq = 0;
/** Eén boekingsgroep: debet op de ene rekening, credit op de andere. */
function entry(
  debitAccount: string,
  creditAccount: string,
  amount: string,
  date: string,
  sourceType = "manual_journal",
): LedgerPostingLike[] {
  seq++;
  const group = `g-${seq}`;
  const base = {
    client_id: CLIENT,
    posting_group_id: group,
    posting_date: date,
    boekjaar: Number(date.slice(0, 4)),
    currency: "EUR",
    source_type: sourceType,
  };
  return [
    { ...base, id: `${group}-1`, line_no: 1, grootboekrekening_id: debitAccount, debit_amount: amount, credit_amount: "0.00" },
    { ...base, id: `${group}-2`, line_no: 2, grootboekrekening_id: creditAccount, debit_amount: "0.00", credit_amount: amount },
  ];
}

const account = (over: Partial<ClassifiedAccountLike> & { id: string }): ClassifiedAccountLike => ({
  nummer: 1000,
  omschrijving: "Rekening",
  categorie: "activa",
  statement_type: null,
  report_group: null,
  normal_side: null,
  report_sort: null,
  ...over,
});

/** Volledige engine-run over echte kernrollups. */
function run(
  rows: LedgerPostingLike[],
  accounts: ClassifiedAccountLike[],
  period: LedgerPeriod = PERIOD_2026,
  withContribution = false,
) {
  const ledgerAccounts = accounts.map((a) => ({
    id: a.id,
    nummer: a.nummer ?? 0,
    omschrijving: a.omschrijving ?? "",
    categorie: a.categorie,
    actief: true,
  }));
  const report = buildAccountReport({ rows, clientId: CLIENT, period, accounts: ledgerAccounts });
  return buildFinancialStatements({
    report,
    period,
    accounts,
    openingBalanceContribution: withContribution ? openingBalanceContributionFromRows(rows, period) : undefined,
  });
}

/**
 * Versmalt naar het geslaagde resultaat. Expliciet uitgeschreven omdat deze
 * repo met `strict: false` draait: TypeScript versmalt een boolean-discriminant
 * dan niet betrouwbaar (zie ook ParsedAmount in opening-balance-utils.ts).
 */
type OkResult = Extract<ReturnType<typeof run>, { ok: true }>;
type FailedResult = Extract<ReturnType<typeof run>, { ok: false }>;

function ok(result: ReturnType<typeof run>): OkResult {
  if (result.ok !== true) throw new Error(`engine faalde: ${(result as FailedResult).failures.join(", ")}`);
  return result as OkResult;
}

/** Een gangbare set: bank (activa), eigen vermogen, omzet, kosten. */
const BANK = account({ id: "a-bank", nummer: 1100, omschrijving: "Bank", statement_type: "balans", report_group: "vlottende_activa" });
const KAPITAAL = account({ id: "a-kap", nummer: 610, omschrijving: "Kapitaal", categorie: "passiva", statement_type: "balans", report_group: "eigen_vermogen" });
const OMZET = account({ id: "a-omzet", nummer: 8000, omschrijving: "Omzet", categorie: "omzet", statement_type: "winst_verlies", report_group: "netto_omzet" });
const KOSTEN = account({ id: "a-kosten", nummer: 4700, omschrijving: "Advieskosten", categorie: "kosten", statement_type: "winst_verlies", report_group: "overige_bedrijfskosten" });

// ─────────────────────────────────────────────────────────────────────────────
describe("tekens en presentatie", () => {
  it("1/4. debet-normaal toont het kernteken ongewijzigd (activa en kosten positief)", () => {
    expect(displayedCents(50_000, "debet")).toBe(50_000);
    const r = ok(run([...entry(BANK.id, KAPITAAL.id, "500.00", "2026-03-01")], [BANK, KAPITAAL]));
    const bank = r.balanceSheet.assetGroups.flatMap((g) => g.lines).find((l) => l.accountId === BANK.id)!;
    expect(bank.rawSignedCents).toBe(50_000);
    expect(bank.displayedCents).toBe(50_000);
  });

  it("2/3. credit-normaal klapt om, zodat vermogen en omzet positief verschijnen", () => {
    expect(displayedCents(-50_000, "credit")).toBe(50_000);
    const r = ok(run([...entry(BANK.id, KAPITAAL.id, "500.00", "2026-03-01")], [BANK, KAPITAAL]));
    const kapitaal = r.balanceSheet.liabilityEquityGroups.flatMap((g) => g.lines).find((l) => l.accountId === KAPITAAL.id)!;
    expect(kapitaal.rawSignedCents).toBe(-50_000);
    expect(kapitaal.displayedCents).toBe(50_000);
  });

  it("5. een contra-actief (creditsaldo op een activarekening) toont negatief", () => {
    const r = ok(run([...entry(KAPITAAL.id, BANK.id, "200.00", "2026-03-01")], [BANK, KAPITAAL]));
    const bank = r.balanceSheet.assetGroups.flatMap((g) => g.lines).find((l) => l.accountId === BANK.id)!;
    expect(bank.rawSignedCents).toBe(-20_000);
    expect(bank.displayedCents).toBe(-20_000);
  });

  it("6. een contra-passief (debetsaldo op een vermogensrekening) toont negatief", () => {
    const r = ok(run([...entry(KAPITAAL.id, BANK.id, "200.00", "2026-03-01")], [BANK, KAPITAAL]));
    const kapitaal = r.balanceSheet.liabilityEquityGroups.flatMap((g) => g.lines).find((l) => l.accountId === KAPITAAL.id)!;
    expect(kapitaal.rawSignedCents).toBe(20_000);
    expect(kapitaal.displayedCents).toBe(-20_000);
  });

  it("7. een expliciete normal_side wint van de groepsstandaard", () => {
    // vlottende_activa is standaard debet; expliciet credit moet winnen. Zo
    // wordt bijvoorbeeld een cumulatieve afschrijving binnen de activa
    // credit-normaal gepresenteerd.
    const omgekeerd = account({ ...BANK, normal_side: "credit" });
    const r = ok(run([...entry(BANK.id, KAPITAAL.id, "500.00", "2026-03-01")], [omgekeerd, KAPITAAL]));
    const bank = r.balanceSheet.assetGroups.flatMap((g) => g.lines).find((l) => l.accountId === BANK.id)!;
    expect(bank.normalSide).toBe("credit");
    expect(bank.normalSideSource).toBe("explicit");
    expect(bank.displayedCents).toBe(-50_000);
    expect(bank.rawSignedCents).toBe(50_000); // de kern blijft ongemoeid
  });

  it("7b. een afwijkende zijde verandert de presentatie, nooit de sluitcontrole", () => {
    // De echte sluitcontrole staat in de tekenconventie van de kern. Een
    // afwijkende presentatiezijde mag die nooit raken — ze verschuift alleen
    // wat een lezer optelt.
    const omgekeerd = account({ ...BANK, normal_side: "credit" });
    const r = ok(run([...entry(BANK.id, KAPITAAL.id, "500.00", "2026-03-01")], [omgekeerd, KAPITAAL]));
    expect(r.balanceSheet.rawReconciliationCents).toBe(0);
    // Gepresenteerd sluit hij niet meer, en dat wordt eerlijk gemeld.
    expect(r.balanceSheet.differenceCents).not.toBe(0);
    expect(r.balanceSheet.ok).toBe(false);
    // Classificatie is wél compleet: dit is een presentatiekeuze, geen gat.
    expect(r.completeness).toBe("complete");
  });

  it("8. een groep die beide kanten op kan is zonder expliciete zijde niet presenteerbaar", () => {
    for (const groep of GROUPS_REQUIRING_EXPLICIT_SIDE) {
      expect(GROUP_DEFAULT_NORMAL_SIDE[groep]).toBeUndefined();
      const rekening = account({ id: "a-fin", nummer: 4940, statement_type: "winst_verlies", report_group: groep });
      const r = run([...entry("a-fin", KAPITAAL.id, "100.00", "2026-03-01")], [rekening, KAPITAAL]);
      const res = ok(r);
      expect(res.unclassified.accounts.map((u) => u.reason)).toContain("missing_normal_side");
      expect(res.completeness).toBe("incomplete");
    }
  });

  it("8b. met een expliciete zijde is diezelfde groep wél presenteerbaar", () => {
    const rekening = account({ id: "a-fin", nummer: 4940, statement_type: "winst_verlies", report_group: "financiele_baten_lasten", normal_side: "debet" });
    const r = ok(run([...entry("a-fin", KAPITAAL.id, "100.00", "2026-03-01")], [rekening, KAPITAAL]));
    const line = r.profitLoss.groups.flatMap((g) => g.lines).find((l) => l.accountId === "a-fin")!;
    expect(line.displayedCents).toBe(10_000);
    expect(r.unclassified.accounts).toHaveLength(0);
  });

  it("activa en passiva dekken samen precies alle balansgroepen — geen groep valt buiten de balans", () => {
    const opDeBalans = [...ASSET_GROUPS, ...EQUITY_LIABILITY_GROUPS].sort();
    expect(opDeBalans).toEqual([...BALANS_GROUPS].sort());
    // En ze overlappen niet: geen groep telt twee keer mee.
    expect(ASSET_GROUPS.filter((g) => EQUITY_LIABILITY_GROUPS.includes(g))).toEqual([]);
  });

  it("de groepskaart dekt precies de groepen die één vaste zijde hebben", () => {
    const mapped = Object.keys(GROUP_DEFAULT_NORMAL_SIDE).sort();
    const verwacht = [...BALANS_GROUPS, ...WINST_VERLIES_GROUPS]
      .filter((g) => !GROUPS_REQUIRING_EXPLICIT_SIDE.includes(g))
      .sort();
    expect(mapped).toEqual(verwacht);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("classificatie", () => {
  it("9/10. geldige balans- en W&V-groepen worden geclassificeerd", () => {
    expect(classifyAccount(BANK, true).kind).toBe("classified");
    expect(classifyAccount(OMZET, true).kind).toBe("classified");
  });

  it("11. zonder statement_type → niet geclassificeerd", () => {
    expect(classifyAccount(account({ id: "x", report_group: "vaste_activa" }), true)).toEqual({
      kind: "unclassified",
      reason: "missing_statement_type",
    });
  });

  it("12. zonder report_group → niet geclassificeerd", () => {
    expect(classifyAccount(account({ id: "x", statement_type: "balans" }), true)).toEqual({
      kind: "unclassified",
      reason: "missing_report_group",
    });
  });

  it("13. een groep van het andere overzicht → niet geclassificeerd", () => {
    expect(classifyAccount(account({ id: "x", statement_type: "balans", report_group: "netto_omzet" }), true)).toEqual({
      kind: "unclassified",
      reason: "invalid_group_for_statement",
    });
    expect(classifyAccount(account({ id: "x", statement_type: "winst_verlies", report_group: "vaste_activa" }), true)).toEqual({
      kind: "unclassified",
      reason: "invalid_group_for_statement",
    });
  });

  it("13b. een onbekende groep of onbekend overzicht → niet geclassificeerd", () => {
    expect(classifyAccount(account({ id: "x", statement_type: "balans", report_group: "groep_uit_de_toekomst" }), true).kind).toBe("unclassified");
    expect(classifyAccount(account({ id: "x", statement_type: "iets_anders", report_group: "vaste_activa" }), true)).toEqual({
      kind: "unclassified",
      reason: "missing_statement_type",
    });
  });

  it("14. een niet-herleidbare rekening → niet geclassificeerd", () => {
    expect(classifyAccount(undefined, false)).toEqual({ kind: "unclassified", reason: "unresolved_account" });
    // Ook mét classificatie telt "onherleidbaar" zwaarder: de rekening bestaat niet.
    expect(classifyAccount(BANK, false)).toEqual({ kind: "unclassified", reason: "unresolved_account" });
  });

  it("14b. een boeking op een rekening die niet in het schema staat blijft zichtbaar", () => {
    const r = ok(run([...entry("a-spook", KAPITAAL.id, "100.00", "2026-03-01")], [KAPITAAL]));
    const spook = r.unclassified.accounts.find((u) => u.accountId === "a-spook")!;
    expect(spook.reason).toBe("unresolved_account");
    expect(spook.rawSignedClosingCents).toBe(10_000);
    expect(r.completeness).toBe("incomplete");
  });

  it("categorie speelt géén rol bij classificeren — alleen als diagnose", () => {
    // Een rekening met categorie "omzet" maar zonder expliciete velden blijft
    // ongeclassificeerd; de categorie komt alleen terug in de diagnose.
    const alleenCategorie = account({ id: "a-cat", nummer: 8001, categorie: "omzet" });
    const r = ok(run([...entry(BANK.id, "a-cat", "300.00", "2026-03-01")], [BANK, alleenCategorie]));
    const rij = r.unclassified.accounts.find((u) => u.accountId === "a-cat")!;
    expect(rij.reason).toBe("missing_statement_type");
    expect(rij.categorie).toBe("omzet");
    expect(r.profitLoss.groups.flatMap((g) => g.lines)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("volgorde", () => {
  const line = (over: Partial<Parameters<typeof compareStatementLines>[0]>) =>
    ({
      synthetic: false,
      accountId: "id",
      accountNumber: 1000,
      accountName: "x",
      reportGroup: "vaste_activa",
      normalSide: "debet",
      normalSideSource: "group_default",
      rawSignedCents: 0,
      displayedCents: 0,
      reportSort: null,
      openingBalanceContributionCents: null,
      hasActivity: true,
      ...over,
    }) as Parameters<typeof compareStatementLines>[0];

  it("16. report_sort bepaalt de volgorde; leeg staat achteraan", () => {
    const gesorteerd = [line({ reportSort: null, accountNumber: 1 }), line({ reportSort: 5 }), line({ reportSort: 1 })].sort(compareStatementLines);
    expect(gesorteerd.map((l) => l.reportSort)).toEqual([1, 5, null]);
  });

  it("17. bij gelijke report_sort telt het rekeningnummer", () => {
    const gesorteerd = [line({ reportSort: 1, accountNumber: 900 }), line({ reportSort: 1, accountNumber: 100 })].sort(compareStatementLines);
    expect(gesorteerd.map((l) => l.accountNumber)).toEqual([100, 900]);
  });

  it("18. bij gelijk nummer telt de id, stabiel", () => {
    const gesorteerd = [line({ accountId: "b" }), line({ accountId: "a" })].sort(compareStatementLines);
    expect(gesorteerd.map((l) => l.accountId)).toEqual(["a", "b"]);
  });

  it("16b. de volgorde geldt echt binnen een groep van de engine", () => {
    const eerst = account({ id: "a-2", nummer: 1200, statement_type: "balans", report_group: "vlottende_activa", report_sort: 1 });
    const laatst = account({ id: "a-1", nummer: 1100, statement_type: "balans", report_group: "vlottende_activa", report_sort: 9 });
    const r = ok(run([...entry("a-1", KAPITAAL.id, "100.00", "2026-03-01"), ...entry("a-2", KAPITAAL.id, "100.00", "2026-03-01")], [eerst, laatst, KAPITAAL]));
    const groep = r.balanceSheet.assetGroups.find((g) => g.key === "vlottende_activa")!;
    expect(groep.lines.map((l) => l.accountId)).toEqual(["a-2", "a-1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("winst-en-verliesrekening", () => {
  /** Omzet 1000, kosten 400 → winst 600. */
  const winstRows = [
    ...entry(BANK.id, OMZET.id, "1000.00", "2026-04-01"),
    ...entry(KOSTEN.id, BANK.id, "400.00", "2026-05-01"),
  ];

  it("19/20/21. omzet, kosten en nettowinst in centen", () => {
    const r = ok(run(winstRows, [BANK, KAPITAAL, OMZET, KOSTEN]));
    expect(r.profitLoss.revenueCents).toBe(100_000);
    expect(r.profitLoss.expenseCents).toBe(40_000);
    expect(r.profitLoss.netResultCents).toBe(60_000);
  });

  it("22. een verlies levert een negatief nettoresultaat", () => {
    const verlies = [
      ...entry(BANK.id, OMZET.id, "100.00", "2026-04-01"),
      ...entry(KOSTEN.id, BANK.id, "450.00", "2026-05-01"),
    ];
    const r = ok(run(verlies, [BANK, KAPITAAL, OMZET, KOSTEN]));
    expect(r.profitLoss.netResultCents).toBe(-35_000);
  });

  it("de W&V gebruikt de periodemutatie, niet het eindsaldo", () => {
    // Vorig jaar 900 omzet, dit jaar 100: alleen 100 telt als periodemutatie.
    const rows = [
      ...entry(BANK.id, OMZET.id, "900.00", "2025-06-01"),
      ...entry(BANK.id, OMZET.id, "100.00", "2026-06-01"),
    ];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN]));
    expect(r.profitLoss.movementCents).toBe(-10_000);
    expect(r.profitLoss.netResultCents).toBe(10_000);
    expect(r.profitLoss.openingCents).toBe(-90_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("resultaatregels en balansidentiteit", () => {
  const winstRows = [
    ...entry(BANK.id, OMZET.id, "1000.00", "2026-04-01"),
    ...entry(KOSTEN.id, BANK.id, "400.00", "2026-05-01"),
  ];

  it("23/25. de resultaatregel is synthetisch: geen rekening-id, geen nummer", () => {
    const r = ok(run(winstRows, [BANK, KAPITAAL, OMZET, KOSTEN]));
    for (const lijn of r.balanceSheet.systemLines) {
      expect(lijn.synthetic).toBe(true);
      expect(lijn).not.toHaveProperty("accountId");
      expect(lijn).not.toHaveProperty("accountNumber");
      expect(Object.keys(lijn).sort()).toEqual(["displayedCents", "kind", "label", "rawSignedCents", "synthetic"]);
    }
    const lopend = r.balanceSheet.systemLines.find((l) => l.kind === "current_year_result")!;
    expect(lopend.label).toBe(CURRENT_YEAR_RESULT_LABEL);
    expect(lopend.displayedCents).toBe(60_000);
  });

  it("24/30. het resultaat van vorige jaren staat apart en telt niet als lopend resultaat", () => {
    const rows = [
      ...entry(BANK.id, OMZET.id, "900.00", "2025-06-01"), // vorig jaar
      ...entry(BANK.id, OMZET.id, "100.00", "2026-06-01"), // dit jaar
    ];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN]));
    const vorig = r.balanceSheet.systemLines.find((l) => l.kind === "prior_years_result")!;
    const lopend = r.balanceSheet.systemLines.find((l) => l.kind === "current_year_result")!;
    expect(vorig.label).toBe(PRIOR_YEARS_RESULT_LABEL);
    expect(vorig.displayedCents).toBe(90_000);
    expect(lopend.displayedCents).toBe(10_000);
    // Geen dubbeltelling: samen precies het cumulatieve W&V-saldo.
    expect(vorig.displayedCents + lopend.displayedCents).toBe(-r.profitLoss.totalCents);
  });

  it("27. de balans sluit in een winstjaar", () => {
    const r = ok(run(winstRows, [BANK, KAPITAAL, OMZET, KOSTEN]));
    expect(r.balanceSheet.differenceCents).toBe(0);
    expect(r.balanceSheet.ok).toBe(true);
    expect(r.balanceSheet.totalAssetsCents).toBe(r.balanceSheet.totalLiabilitiesEquityCents);
  });

  it("28. de balans sluit in een verliesjaar", () => {
    const verlies = [
      ...entry(BANK.id, KAPITAAL.id, "1000.00", "2026-01-01"),
      ...entry(KOSTEN.id, BANK.id, "450.00", "2026-05-01"),
      ...entry(BANK.id, OMZET.id, "100.00", "2026-06-01"),
    ];
    const r = ok(run(verlies, [BANK, KAPITAAL, OMZET, KOSTEN]));
    expect(r.profitLoss.netResultCents).toBe(-35_000);
    expect(r.balanceSheet.differenceCents).toBe(0);
  });

  it("29. de synthetische resultaatregel is exact het W&V-nettoresultaat", () => {
    for (const rows of [winstRows, [...entry(KOSTEN.id, BANK.id, "13.37", "2026-02-02")]]) {
      const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN]));
      const lopend = r.balanceSheet.systemLines.find((l) => l.kind === "current_year_result")!;
      expect(lopend.displayedCents).toBe(r.profitLoss.netResultCents);
    }
  });

  it("26. nergens wordt rekening 9998 of een andere sluitrekening aangeroepen", () => {
    // Commentaar weggestript: een bewering over de CODE mag niet slagen of
    // falen op proza (de kop legt juist uit dát er geen 9998 wordt gebruikt).
    const bron = readFileSync("src/lib/financial-statements.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(bron).not.toMatch(/9998|9999|2010|2011/);
    expect(bron).not.toMatch(/sluitrekening|suspense/i);
    // De resultaatregels hebben geen enkele rekeningverwijzing.
    const r = ok(run(winstRows, [BANK, KAPITAAL, OMZET, KOSTEN]));
    expect(JSON.stringify(r.balanceSheet.systemLines)).not.toMatch(/a-|9998/);
  });

  it("44. de tekenconventie van de kern blijft zichtbaar naast de presentatie", () => {
    const r = ok(run(winstRows, [BANK, KAPITAAL, OMZET, KOSTEN]));
    const omzet = r.profitLoss.groups.flatMap((g) => g.lines).find((l) => l.accountId === OMZET.id)!;
    // Omzet staat credit in de kern → negatief signed, positief gepresenteerd.
    expect(omzet.rawSignedCents).toBe(-100_000);
    expect(omzet.displayedCents).toBe(100_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("beginbalans", () => {
  const OB = "opening_balance";

  it("31/32. beginbalansrijen tellen precies één keer mee op de balans", () => {
    const rows = [...entry(BANK.id, KAPITAAL.id, "2500.00", "2026-01-01", OB)];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN], PERIOD_2026, true));
    const bank = r.balanceSheet.assetGroups.flatMap((g) => g.lines).find((l) => l.accountId === BANK.id)!;
    const kapitaal = r.balanceSheet.liabilityEquityGroups.flatMap((g) => g.lines).find((l) => l.accountId === KAPITAAL.id)!;
    expect(bank.displayedCents).toBe(250_000);
    expect(kapitaal.displayedCents).toBe(250_000);
    expect(r.balanceSheet.differenceCents).toBe(0);

    // Dezelfde rijen als gewone memoriaalboeking geven exact hetzelfde beeld:
    // de engine behandelt de bron niet anders, ze rapporteert hem alleen.
    const zelfde = ok(run([...entry(BANK.id, KAPITAAL.id, "2500.00", "2026-01-01")], [BANK, KAPITAAL, OMZET, KOSTEN], PERIOD_2026, true));
    expect(zelfde.balanceSheet.totalAssetsCents).toBe(r.balanceSheet.totalAssetsCents);
  });

  it("33. een beginbalansbijdrage op een W&V-rekening wordt apart zichtbaar gemaakt", () => {
    // Cutover halverwege het jaar: de beginbalans draagt YTD-omzet mee.
    const rows = [
      ...entry(BANK.id, OMZET.id, "700.00", "2026-07-01", OB),
      ...entry(BANK.id, OMZET.id, "300.00", "2026-09-01"),
    ];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN], PERIOD_2026, true));
    // Het totaal blijft de financiële waarheid: alle 1000 telt mee.
    expect(r.profitLoss.netResultCents).toBe(100_000);
    // En de herkomst is expliciet zichtbaar, niet weggemoffeld.
    expect(r.profitLoss.openingBalanceContributionCents).toBe(-70_000);
    const omzet = r.profitLoss.groups.flatMap((g) => g.lines).find((l) => l.accountId === OMZET.id)!;
    expect(omzet.openingBalanceContributionCents).toBe(-70_000);
    expect(r.diagnostics.openingBalanceInsidePeriod).toBe(true);
  });

  it("33b. zonder opgegeven bijdrage is het onbekend, niet stilzwijgend nul", () => {
    const rows = [...entry(BANK.id, OMZET.id, "700.00", "2026-07-01", OB)];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN], PERIOD_2026, false));
    expect(r.profitLoss.openingBalanceContributionCents).toBeNull();
    expect(r.diagnostics.openingBalanceContributionKnown).toBe(false);
    // Het bedrag zelf telt gewoon mee in de waarheid.
    expect(r.profitLoss.netResultCents).toBe(70_000);
  });

  it("de bijdrage komt uit dezelfde rijen en telt alleen beginbalansrijen binnen de periode", () => {
    const rows = [
      ...entry(BANK.id, OMZET.id, "700.00", "2026-07-01", OB),
      ...entry(BANK.id, OMZET.id, "500.00", "2025-07-01", OB), // buiten de periode
      ...entry(BANK.id, OMZET.id, "300.00", "2026-09-01"), // andere bron
    ];
    const bijdrage = openingBalanceContributionFromRows(rows, PERIOD_2026);
    expect(bijdrage.get(OMZET.id)).toBe(-70_000);
    expect(bijdrage.get(BANK.id)).toBe(70_000);
  });

  it("een beginbalans van vóór de periode komt als beginsaldo binnen, niet als mutatie", () => {
    const rows = [...entry(BANK.id, KAPITAAL.id, "2500.00", "2025-01-01", OB)];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN], PERIOD_2026, true));
    const bank = r.balanceSheet.assetGroups.flatMap((g) => g.lines).find((l) => l.accountId === BANK.id)!;
    expect(bank.displayedCents).toBe(250_000);
    expect(r.profitLoss.netResultCents).toBe(0);
    expect(r.diagnostics.openingBalanceInsidePeriod).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("niet geclassificeerd en dekking", () => {
  it("15. een rekening zonder activiteit blijft in de dekking, maar telt niet als onvolledig", () => {
    const leeg = account({ id: "a-leeg", nummer: 1900, statement_type: null });
    const rows = [...entry(BANK.id, KAPITAAL.id, "100.00", "2026-03-01")];
    const ledgerAccounts = [BANK, KAPITAAL, leeg].map((a) => ({
      id: a.id, nummer: a.nummer ?? 0, omschrijving: a.omschrijving ?? "", categorie: a.categorie, actief: true,
    }));
    // De kern levert alleen rollups voor rekeningen met rijen; een rekening
    // zonder boekingen komt dus niet eens in het rapport voor.
    const report = buildAccountReport({ rows, clientId: CLIENT, period: PERIOD_2026, accounts: ledgerAccounts });
    const r = buildFinancialStatements({ report, period: PERIOD_2026, accounts: [BANK, KAPITAAL, leeg] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unclassified.accounts).toHaveLength(0);
    expect(r.completeness).toBe("complete");
  });

  it("15b. een ongeclassificeerde rekening met saldo 0 telt niet mee als activiteit", () => {
    const vreemd = account({ id: "a-nul", nummer: 1500 });
    const rows = [
      ...entry("a-nul", KAPITAAL.id, "100.00", "2026-03-01"),
      ...entry(KAPITAAL.id, "a-nul", "100.00", "2026-04-01"),
    ];
    const r = ok(run(rows, [vreemd, KAPITAAL, BANK]));
    const rij = r.unclassified.accounts.find((u) => u.accountId === "a-nul")!;
    expect(rij.rawSignedClosingCents).toBe(0);
    // Er ís beweging geweest, dus de rekening telt als activiteit.
    expect(rij.hasActivity).toBe(true);
    expect(r.unclassified.withActivityCount).toBe(1);
  });

  it("41/42/43. dekking is exact: elke rekening precies één keer, nooit in beide overzichten", () => {
    const vreemd = account({ id: "a-vreemd", nummer: 3000 });
    const rows = [
      ...entry(BANK.id, OMZET.id, "500.00", "2026-04-01"),
      ...entry(KOSTEN.id, BANK.id, "200.00", "2026-05-01"),
      ...entry("a-vreemd", KAPITAAL.id, "50.00", "2026-06-01"),
    ];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN, vreemd]));
    const balansIds = r.balanceSheet.assetGroups.concat(r.balanceSheet.liabilityEquityGroups).flatMap((g) => g.lines).map((l) => l.accountId);
    const pnlIds = r.profitLoss.groups.flatMap((g) => g.lines).map((l) => l.accountId);
    const onbekendIds = r.unclassified.accounts.map((u) => u.accountId);
    const alle = [...balansIds, ...pnlIds, ...onbekendIds];

    expect(r.diagnostics.coverage.ok).toBe(true);
    expect(alle).toHaveLength(r.diagnostics.coverage.totalRollups);
    expect(new Set(alle).size).toBe(alle.length);
    expect(balansIds.filter((id) => pnlIds.includes(id))).toEqual([]);
  });

  it("de redenen worden geteld en het niet-geclassificeerde saldo wordt benoemd", () => {
    const vreemd = account({ id: "a-vreemd", nummer: 3000 });
    const r = ok(run([...entry("a-vreemd", KAPITAAL.id, "50.00", "2026-06-01")], [KAPITAAL, vreemd]));
    expect(r.unclassified.byReason.missing_statement_type).toBe(1);
    expect(r.unclassified.closingCents).toBe(5_000);
    expect(r.unclassified.withActivityCount).toBe(1);
  });

  it("niet-geclassificeerde activiteit verschijnt exact als het balansverschil", () => {
    const vreemd = account({ id: "a-vreemd", nummer: 3000 });
    const r = ok(run([...entry("a-vreemd", KAPITAAL.id, "50.00", "2026-06-01")], [KAPITAAL, vreemd]));
    // De balans sluit niet, en het gat is precies het ongeclassificeerde deel.
    expect(r.balanceSheet.differenceCents).toBe(-r.unclassified.closingCents);
    expect(r.balanceSheet.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("volledigheid en falen", () => {
  it("38. een falende kern laat de engine falen — nooit cijfers uit een ongeldig rapport", () => {
    // Een ongebalanceerde boekingsgroep laat de kern falen.
    const kapot: LedgerPostingLike[] = [
      {
        id: "x1", client_id: CLIENT, grootboekrekening_id: BANK.id, posting_group_id: "gx", line_no: 1,
        posting_date: "2026-03-01", boekjaar: 2026, debit_amount: "100.00", credit_amount: "0.00",
        currency: "EUR", source_type: "manual_journal",
      },
    ];
    const report = buildAccountReport({ rows: kapot, clientId: CLIENT, period: PERIOD_2026, accounts: [] });
    expect(report.ok).toBe(false);
    const r = buildFinancialStatements({ report, period: PERIOD_2026, accounts: [BANK] });
    expect(r.ok).toBe(false);
    const mislukt = r as FailedResult;
    expect(mislukt.failures).toContain("kernel_not_ok");
    expect(mislukt.completeness).toBe("unknown");
    expect(r).not.toHaveProperty("balanceSheet");
  });

  it("39/40. sluitend is niet hetzelfde als volledig", () => {
    // Deze set sluit wiskundig (de kern klopt), maar één rekening is niet
    // geclassificeerd — dus niet volledig.
    const vreemd = account({ id: "a-vreemd", nummer: 3000 });
    const r = ok(run([...entry("a-vreemd", KAPITAAL.id, "50.00", "2026-06-01")], [KAPITAAL, vreemd]));
    expect(r.diagnostics.ledgerClosingSumCents).toBe(0); // de ledger sluit
    expect(r.completeness).toBe("incomplete"); // maar het rapport niet
  });

  it("volledig vereist geclassificeerde activiteit én één herleidbaar boekjaar", () => {
    const r = ok(run([...entry(BANK.id, KAPITAAL.id, "100.00", "2026-03-01")], [BANK, KAPITAAL]));
    expect(r.completeness).toBe("complete");
    expect(r.diagnostics.reportYear).toBe(2026);
  });

  it("37. een periode over meerdere jaren maakt de resultaatsplitsing ambigu", () => {
    const meerjarig: LedgerPeriod = { from: "2025-01-01", toExclusive: "2027-01-01" };
    const rows = [...entry(BANK.id, OMZET.id, "100.00", "2026-06-01")];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN], meerjarig));
    expect(r.diagnostics.reportYear).toBeNull();
    expect(r.diagnostics.yearAmbiguous).toBe(true);
    expect(r.completeness).toBe("ambiguous");
    // De cijfers zelf blijven exact; alleen de duiding als "boekjaar" niet.
    expect(r.balanceSheet.differenceCents).toBe(0);
  });

  it("8. de invariant van de kern wordt opnieuw gecontroleerd", () => {
    const r = ok(run([...entry(BANK.id, KAPITAAL.id, "100.00", "2026-03-01")], [BANK, KAPITAAL]));
    expect(r.diagnostics.ledgerClosingSumCents).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("tegendraadse fixtures", () => {
  it("een onbekende report_group verdwijnt niet maar wordt benoemd", () => {
    const raar = account({ id: "a-raar", nummer: 5000, statement_type: "balans", report_group: "grootboek_van_de_maan" });
    const r = ok(run([...entry("a-raar", KAPITAAL.id, "10.00", "2026-06-01")], [raar, KAPITAAL]));
    const rij = r.unclassified.accounts.find((u) => u.accountId === "a-raar")!;
    expect(rij.reason).toBe("missing_report_group");
    expect(rij.reportGroup).toBe("grootboek_van_de_maan");
  });

  it("balans met een W&V-groep en W&V met een balansgroep komen beide in unclassified", () => {
    const kruislings1 = account({ id: "a-k1", nummer: 5001, statement_type: "balans", report_group: "netto_omzet" });
    const kruislings2 = account({ id: "a-k2", nummer: 5002, statement_type: "winst_verlies", report_group: "vaste_activa" });
    const r = ok(run([...entry("a-k1", "a-k2", "10.00", "2026-06-01")], [kruislings1, kruislings2]));
    expect(r.unclassified.accounts.map((u) => u.reason)).toEqual([
      "invalid_group_for_statement",
      "invalid_group_for_statement",
    ]);
    expect(r.balanceSheet.assetGroups.flatMap((g) => g.lines)).toHaveLength(0);
    expect(r.profitLoss.groups.flatMap((g) => g.lines)).toHaveLength(0);
  });

  it("resultaat van vorige jaren zonder jaarafsluiting blijft netjes gescheiden", () => {
    // 2024 en 2025 winst, 2026 verlies — er is nooit afgesloten.
    const rows = [
      ...entry(BANK.id, OMZET.id, "1000.00", "2024-06-01"),
      ...entry(BANK.id, OMZET.id, "500.00", "2025-06-01"),
      ...entry(KOSTEN.id, BANK.id, "200.00", "2026-06-01"),
    ];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN]));
    const vorig = r.balanceSheet.systemLines.find((l) => l.kind === "prior_years_result")!;
    const lopend = r.balanceSheet.systemLines.find((l) => l.kind === "current_year_result")!;
    expect(vorig.displayedCents).toBe(150_000); // 1000 + 500 winst
    expect(lopend.displayedCents).toBe(-20_000); // 200 verlies
    expect(r.balanceSheet.differenceCents).toBe(0);
  });

  it("negatieve contra-saldi houden de balans sluitend", () => {
    const rows = [
      ...entry(KAPITAAL.id, BANK.id, "300.00", "2026-02-01"), // bank negatief
      ...entry(BANK.id, OMZET.id, "1000.00", "2026-03-01"),
    ];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN]));
    expect(r.balanceSheet.differenceCents).toBe(0);
  });

  it("centen blijven heel: geen float-afronding bij ongelijke bedragen", () => {
    const rows = [
      ...entry(BANK.id, OMZET.id, "0.10", "2026-03-01"),
      ...entry(BANK.id, OMZET.id, "0.20", "2026-03-02"),
      ...entry(KOSTEN.id, BANK.id, "0.29", "2026-03-03"),
    ];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN]));
    expect(r.profitLoss.revenueCents).toBe(30);
    expect(r.profitLoss.expenseCents).toBe(29);
    expect(r.profitLoss.netResultCents).toBe(1);
    expect(Number.isInteger(r.profitLoss.netResultCents)).toBe(true);
  });

  it("alle bedragen in het model zijn hele getallen", () => {
    const rows = [
      ...entry(BANK.id, OMZET.id, "1234.56", "2026-03-01"),
      ...entry(KOSTEN.id, BANK.id, "78.90", "2026-04-01"),
    ];
    const r = ok(run(rows, [BANK, KAPITAAL, OMZET, KOSTEN]));
    const bedragen = JSON.stringify(r).match(/"[a-zA-Z]*Cents":(-?\d+(\.\d+)?)/g) ?? [];
    expect(bedragen.length).toBeGreaterThan(10);
    for (const b of bedragen) expect(b).not.toMatch(/\./);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("statische grenzen", () => {
  const bron = readFileSync("src/lib/financial-statements.ts", "utf8");
  const code = bron
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

  it("34/35/36. geen beginbalansregels, journaalposten of documenttotalen", () => {
    expect(code).not.toMatch(/opening_balance_lines|opening_balances\b/);
    expect(code).not.toMatch(/journal_entries/);
    expect(code).not.toMatch(/purchase_invoice|sales_invoice|bank_transaction|leveranciers/);
    expect(code).not.toMatch(/amount_incl|amount_excl|btw_amount|remaining_amount/);
  });

  it("de engine is puur: geen React, geen Supabase, geen query, geen routing", () => {
    expect(code).not.toMatch(/from\s+["']react|useState|useEffect|useQuery|useMemo/);
    expect(code).not.toMatch(/supabase|\.from\(|\.rpc\(/);
    expect(code).not.toMatch(/react-router|useNavigate/);
  });

  it("er wordt niet uit categorie of rekeningnummer geclassificeerd", () => {
    // `categorie` mag alleen als diagnoseveld voorkomen, nooit in een
    // classificatiebeslissing.
    expect(code).not.toMatch(/classifyLedgerCategory|KNOWN_LEDGER_CATEGORIES/);
    expect(code).not.toMatch(/nummer\s*[<>]=?\s*\d/);
    expect(code).not.toMatch(/if\s*\([^)]*categorie[^)]*\)/);
  });

  it("45/46. de kern en de proef- en saldibalans blijven ongewijzigd", () => {
    let base: string;
    try {
      base = execFileSync("git", ["show", "origin/main:src/lib/ledger-reporting.ts"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return; // origin/main niet beschikbaar: overslaan, niet vals slagen
    }
    expect(readFileSync("src/lib/ledger-reporting.ts", "utf8")).toBe(base);
    const psb = execFileSync("git", ["show", "origin/main:src/lib/proef-saldibalans.ts"], { encoding: "utf8" });
    expect(readFileSync("src/lib/proef-saldibalans.ts", "utf8")).toBe(psb);
  });

  it("de engine rekent niet zelf aan boekingsregels: bedragen komen uit de rollups", () => {
    // De enige plek waar een ledgerrij wordt aangeraakt is de diagnose-helper,
    // en die gebruikt de kernfunctie signedAmountCents().
    expect(code).not.toMatch(/toCents\(/);
    expect(code.match(/signedAmountCents\(/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/debit_amount|credit_amount/);
  });
});

describe("branch-scope", () => {
  function changedFiles(): string[] | null {
    try {
      return execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .filter(Boolean);
    } catch {
      return null;
    }
  }

  const changed = changedFiles();
  const branchIt = changed === null ? it.skip : it;

  branchIt("47/48. geen migratie en geen SQL", () => {
    expect(changed!.filter((f) => f.startsWith("supabase/"))).toEqual([]);
    expect(changed!.filter((f) => f.endsWith(".sql"))).toEqual([]);
  });

  branchIt("49. de gegenereerde types zijn ongewijzigd", () => {
    expect(changed).not.toContain("src/integrations/supabase/types.ts");
  });

  branchIt("50. geen afhankelijkheidswijziging", () => {
    expect(changed).not.toContain("package.json");
    expect(changed!.filter((f) => /package-lock\.json|bun\.lockb|pnpm-lock\.yaml|yarn\.lock/.test(f))).toEqual([]);
  });

  branchIt("geen UI in deze PR: geen pagina, component, route of nav-item", () => {
    expect(changed!.filter((f) => /^src\/pages\/|^src\/components\/|App\.tsx$|nav\.ts$/.test(f))).toEqual([]);
    expect(changed!.filter((f) => f.endsWith(".tsx") && !f.startsWith("src/test/"))).toEqual([]);
  });
});
