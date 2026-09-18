// Balans/W&V PR 3 — pure statement-engine boven de bestaande rapportagekern.
//
// Geen React, geen Supabase, geen routing, geen UI. Deze module rekent niet
// zelf aan boekingen: ze krijgt de rollups van buildAccountReport() (6C-b7 PR 1)
// en hergroepeert die. De financiële waarheid blijft public.ledger_postings —
// er is hier geen tweede rekenbron, geen documenttotaal, geen
// opening_balance_lines en geen journal_entries.
//
// Conventies — overgenomen, niet heronderhandeld:
//   • Tekenconventie van de kern: signed = debet − credit (debet-positief).
//     Deze module klapt NIETS om in de kern; ze berekent per regel een
//     aparte `displayedCents` voor presentatie en laat `rawSignedCents`
//     ongemoeid naast staan.
//   • Alles in hele centen (integer). Geen float, nergens.
//   • Periode = half-open [from, toExclusive), precies zoals de kern.
//   • Classificatie komt UITSLUITEND uit de expliciete velden van PR 1/PR 2
//     (statement_type, report_group, normal_side, report_sort). `categorie`
//     is géén financiële waarheid en wordt alleen als diagnose meegegeven.
//   • Een rekening die niet betrouwbaar te presenteren is, verdwijnt nooit:
//     ze belandt in `unclassified` mét reden.
//
// ─────────────────────────────────────────────────────────────────────────────
// WAAROM DE BALANS SLUIT ZONDER ÉÉN BOEKING TE SCHRIJVEN
//
// De kern garandeert over álle rekeningen: Σ beginsaldo = 0 en
// Σ periodedebet = Σ periodecredit, dus Σ eindsaldo = 0. Splits de rekeningen
// in B (balans), P (W&V) en U (niet geclassificeerd):
//
//   Σ_B eindsaldo + Σ_P eindsaldo + Σ_U eindsaldo = 0
//
// en voor de W&V-rekeningen geldt per definitie
//
//   Σ_P eindsaldo = Σ_P beginsaldo + Σ_P periodemutatie
//                 = pnlOpeningCents  + pnlMovementCents
//
// Die twee sommen verhuizen als presentatieregels naar het eigen vermogen:
// "Onverdeeld resultaat voorgaande jaren" (raw = pnlOpeningCents) en
// "Resultaat lopend boekjaar" (raw = pnlMovementCents). Daarmee is
//
//   Σ_B eindsaldo + pnlOpeningCents + pnlMovementCents = −Σ_U eindsaldo
//
// oftewel: de balans sluit exact, en het verschil dat overblijft is precies
// het niet-geclassificeerde deel. Mathematisch sluiten is dus NIET hetzelfde
// als volledig zijn — daarom is `completeness` een eigen oordeel.
//
// Er wordt geen enkele ledger_postings-rij verzonnen, geen 9998 aangeroepen en
// geen resultaatbestemming verondersteld die nog niet bestaat.

import type { LedgerAccountReport, LedgerAccountRollup, LedgerPeriod, LedgerPostingLike } from "./ledger-reporting";
import { isInPeriod, signedAmountCents } from "./ledger-reporting";
import { reportYearForPeriod } from "./ledger-completeness";
import {
  BALANS_GROUPS,
  REPORT_GROUP_LABELS,
  WINST_VERLIES_GROUPS,
  isNormalSide,
  isReportGroup,
  isStatementType,
} from "./reporting-classification";
import type { NormalSide, ReportGroup, StatementType } from "./reporting-classification";

// ── Invoer ──────────────────────────────────────────────────────────────────

/**
 * De classificatievelden van een grootboekrekening, zoals de database ze
 * teruggeeft. Bewust los van LedgerAccountLike: de kern kent deze velden niet
 * en hoeft ze niet te kennen.
 */
export interface ClassifiedAccountLike {
  id: string;
  nummer?: number | null;
  omschrijving?: string | null;
  categorie?: string | null;
  statement_type?: string | null;
  report_group?: string | null;
  normal_side?: string | null;
  report_sort?: number | null;
}

export interface FinancialStatementsInput {
  /** Het resultaat van buildAccountReport(); faalt dat, dan faalt dit ook. */
  report: LedgerAccountReport;
  period: LedgerPeriod;
  /** Rekeningen mét classificatie. Ontbreekt er één, dan is die rekening niet geclassificeerd. */
  accounts: readonly ClassifiedAccountLike[];
  /**
   * Optioneel: per rekening de signed centen die in deze periode uit
   * beginbalansrijen komen (source_type = 'opening_balance'). Puur diagnose —
   * het verandert geen enkel totaal. Gebruik
   * openingBalanceContributionFromRows() om hem uit dezelfde ledgerrijen te
   * halen die de kern al gebruikte. Ontbreekt hij, dan rapporteren de
   * diagnostics dat als "onbekend" in plaats van als nul.
   *
   * De engine controleert de sleutels tegen de rollups: een sleutel die geen
   * rekening in dit rapport is, wordt niet meegeteld maar wél geteld in
   * `diagnostics.strayContributionKeys`. Een kaart die uit andere rijen, een
   * andere periode of een andere administratie komt, is daarmee zichtbaar in
   * plaats van stilzwijgend gezaghebbend.
   */
  openingBalanceContribution?: ReadonlyMap<string, number>;
  /**
   * Optioneel: per rekening de signed centen die geboekt zijn op de éérste dag
   * van de periode. Een afsluitboeking die het resultaat van vorig jaar naar
   * het eigen vermogen brengt, wordt vaak op 1 januari gedateerd; die valt dan
   * in de periodemutatie en maakt de splitsing lopend/voorgaand misleidend.
   * Puur diagnose — het verandert geen enkel totaal.
   */
  movementOnPeriodStart?: ReadonlyMap<string, number>;
}

/**
 * Beginbalansbijdrage per rekening binnen de periode, uit dezelfde
 * ledger_postings-rijen die buildAccountReport() kreeg. Geen tweede bron en
 * geen tweede rekenwijze: het is signedAmountCents() over een deelverzameling
 * van precies dezelfde rijen.
 */
export function openingBalanceContributionFromRows(
  rows: readonly LedgerPostingLike[],
  period: LedgerPeriod,
): Map<string, number> {
  const byAccount = new Map<string, number>();
  for (const row of rows) {
    if (row.source_type !== OPENING_BALANCE_SOURCE_TYPE) continue;
    if (!isInPeriod(row.posting_date, period)) continue;
    const current = byAccount.get(row.grootboekrekening_id) ?? 0;
    byAccount.set(row.grootboekrekening_id, current + signedAmountCents(row));
  }
  return byAccount;
}

/**
 * Per rekening de signed centen geboekt op de eerste dag van de periode, uit
 * dezelfde rijen. Een jaarafsluiting bestaat nog niet, maar wie er handmatig
 * één boekt dateert die doorgaans op 1 januari; dan zit het resultaat van vorig
 * jaar zowel in de openingsstand van de W&V-rekeningen als in de mutatie van
 * dit jaar, en klopt de splitsing niet meer. Diagnose, geen correctie.
 */
export function movementOnPeriodStartFromRows(
  rows: readonly LedgerPostingLike[],
  period: LedgerPeriod,
): Map<string, number> {
  const byAccount = new Map<string, number>();
  for (const row of rows) {
    if (row.posting_date !== period.from) continue;
    const current = byAccount.get(row.grootboekrekening_id) ?? 0;
    byAccount.set(row.grootboekrekening_id, current + signedAmountCents(row));
  }
  return byAccount;
}

export const OPENING_BALANCE_SOURCE_TYPE = "opening_balance";

// ── Presentatiezijde ────────────────────────────────────────────────────────

/**
 * De vaste, expliciete zijde per rapportagegroep — alleen gebruikt wanneer de
 * rekening zelf geen `normal_side` draagt. Geen afleiding uit rekeningnummer,
 * geen afleiding uit `categorie`.
 *
 * `financiele_baten_lasten` en `overig_resultaat` staan er bewust NIET in:
 * die groepen kunnen beide kanten op (rentebaten tegenover rentelasten), dus
 * zonder expliciete zijde is er geen betrouwbare presentatie mogelijk. Zulke
 * rekeningen komen in `unclassified` met reden `missing_normal_side`.
 */
export const GROUP_DEFAULT_NORMAL_SIDE: Readonly<Partial<Record<ReportGroup, NormalSide>>> = {
  vaste_activa: "debet",
  vlottende_activa: "debet",
  prive: "debet",
  kostprijs_omzet: "debet",
  personeelskosten: "debet",
  afschrijvingen: "debet",
  overige_bedrijfskosten: "debet",
  belastingen: "debet",
  eigen_vermogen: "credit",
  voorzieningen: "credit",
  langlopende_schulden: "credit",
  kortlopende_schulden: "credit",
  netto_omzet: "credit",
};

/** Groepen die zonder expliciete `normal_side` niet te presenteren zijn. */
export const GROUPS_REQUIRING_EXPLICIT_SIDE: readonly ReportGroup[] = [
  "financiele_baten_lasten",
  "overig_resultaat",
];

/** debet-oriëntatie toont het tekenconventiegetal; credit-oriëntatie klapt het om. */
export function displayedCents(rawSignedCents: number, side: NormalSide): number {
  return side === "credit" ? -rawSignedCents + 0 : rawSignedCents;
}

/**
 * De oriëntatie van de KOLOM waarin een regel staat — niet die van de rekening
 * zelf. Dit onderscheid is wezenlijk: een kolomtotaal is pas op te tellen als
 * elke regel in dezelfde richting wijst.
 *
 * Zou je per regel op de eigen `normal_side` normaliseren, dan klapt een regel
 * die tegen zijn kolom in staat twee keer om en telt hij op in plaats van af.
 * Dat gaat mis bij precies de twee gevallen die in een Nederlandse balans
 * doodgewoon zijn:
 *   • privé — debet van aard, maar het staat aan de creditzijde en hoort
 *     ván het kapitaal af te gaan;
 *   • een cumulatieve afschrijving binnen de vaste activa — credit van aard,
 *     maar het hoort ván de boekwaarde af te gaan.
 * Met de kolomoriëntatie verschijnen die als negatieve (aftrek)regels, precies
 * zoals een balans wordt gelezen, en klopt elk kolomtotaal.
 *
 * `normal_side` blijft bewaard als de AARD van de rekening; wijkt die af van de
 * kolom, dan is het een tegenrekening (`isContra`).
 *
 * Voor de W&V bepaalt de groep de richting (omzet credit, kosten debet). Voor
 * de twee groepen die beide kanten op kunnen bestaat geen groepsrichting; daar
 * geeft de verplichte expliciete `normal_side` de doorslag — een rentebaat
 * hoort aan de opbrengstenkant, een rentelast aan de kostenkant.
 */
export function presentationSideFor(
  reportGroup: ReportGroup,
  accountNormalSide: NormalSide,
): NormalSide {
  if ((ASSET_GROUPS as readonly string[]).includes(reportGroup)) return "debet";
  if ((EQUITY_LIABILITY_GROUPS as readonly string[]).includes(reportGroup)) return "credit";
  return GROUP_DEFAULT_NORMAL_SIDE[reportGroup] ?? accountNormalSide;
}

// ── Groepsindeling ──────────────────────────────────────────────────────────

export const ASSET_GROUPS: readonly ReportGroup[] = ["vaste_activa", "vlottende_activa"];

export const EQUITY_LIABILITY_GROUPS: readonly ReportGroup[] = [
  "eigen_vermogen",
  "voorzieningen",
  "langlopende_schulden",
  "kortlopende_schulden",
  "prive",
];

// ── Uitvoertypen ────────────────────────────────────────────────────────────

export type UnclassifiedReason =
  | "missing_statement_type"
  | "missing_report_group"
  | "invalid_group_for_statement"
  | "missing_normal_side"
  /** De rekening bestaat niet in het schema (de kern kon haar niet herleiden). */
  | "unresolved_account"
  /** De rekening bestaat wel, maar zat niet in de meegegeven `accounts`. */
  | "account_not_supplied";

export interface FinancialStatementAccountLine {
  synthetic: false;
  accountId: string;
  accountNumber: number | null;
  accountName: string;
  reportGroup: ReportGroup;
  /** De aard van de rekening zelf. */
  normalSide: NormalSide;
  /** Bron van die aard: expliciet op de rekening, of de vaste groepskaart. */
  normalSideSource: "explicit" | "group_default";
  /** De richting van de kolom waarin deze regel staat. */
  presentationSide: NormalSide;
  /** De aard wijkt af van de kolom: een aftrekpost (tegenrekening). */
  isContra: boolean;
  /** Tekenconventie van de kern, ongewijzigd. */
  rawSignedCents: number;
  /** Genormaliseerd op de KOLOM, zodat kolomtotalen optelbaar zijn. */
  displayedCents: number;
  reportSort: number | null;
  /** Alleen voor de W&V: het deel van de mutatie dat uit beginbalansrijen komt. */
  openingBalanceContributionCents: number | null;
  hasActivity: boolean;
}

export type SystemLineKind = "current_year_result" | "prior_years_result";

export interface FinancialStatementSystemLine {
  synthetic: true;
  kind: SystemLineKind;
  label: string;
  /** Het bedrag zoals het in de tekenconventie van de kern staat. */
  rawSignedCents: number;
  displayedCents: number;
}

export interface FinancialStatementGroup {
  key: ReportGroup;
  label: string;
  lines: FinancialStatementAccountLine[];
  totalCents: number;
  rawSignedCents: number;
}

export interface UnclassifiedAccount {
  accountId: string;
  accountNumber: number | null;
  accountName: string;
  reason: UnclassifiedReason;
  /** Uitsluitend diagnose — nooit gebruikt om te classificeren. */
  categorie: string | null;
  statementType: string | null;
  reportGroup: string | null;
  rawSignedClosingCents: number;
  rawSignedMovementCents: number;
  hasActivity: boolean;
}

export interface UnclassifiedSummary {
  accounts: UnclassifiedAccount[];
  /** Alleen de rekeningen met werkelijke activiteit. */
  withActivityCount: number;
  closingCents: number;
  movementCents: number;
  byReason: Record<UnclassifiedReason, number>;
}

export type StatementCompleteness = "complete" | "incomplete" | "unknown" | "ambiguous";

export interface FinancialStatementsDiagnostics {
  reportYear: number | null;
  /** De periode beslaat niet precies één kalenderjaar. */
  yearAmbiguous: boolean;
  /** Rollups totaal = balans + W&V + niet geclassificeerd. */
  coverage: {
    totalRollups: number;
    balanceAccounts: number;
    profitLossAccounts: number;
    unclassifiedAccounts: number;
    ok: boolean;
  };
  /** Σ eindsaldo over alle rollups; moet 0 zijn (invariant van de kern). */
  ledgerClosingSumCents: number;
  openingBalanceContributionKnown: boolean;
  openingBalanceOnProfitLossCents: number | null;
  /** Hetzelfde, maar voor rekeningen die niet geclassificeerd konden worden. */
  openingBalanceOnUnclassifiedCents: number | null;
  /** De beginbalans valt binnen de rapportageperiode. */
  openingBalanceInsidePeriod: boolean;
  /** Sleutels in de meegegeven kaart die geen rekening in dit rapport zijn. */
  strayContributionKeys: number;
  /**
   * W&V-mutatie geboekt op de eerste dag van de periode. Is dit niet 0, dan
   * kan er een afsluitboeking in de periode liggen en is de splitsing tussen
   * lopend en voorgaand resultaat niet te vertrouwen. null = niet opgegeven.
   */
  profitLossOnPeriodStartCents: number | null;
  failures: string[];
}

export interface BalanceSheetResult {
  assetGroups: FinancialStatementGroup[];
  liabilityEquityGroups: FinancialStatementGroup[];
  systemLines: FinancialStatementSystemLine[];
  /** Som van de gepresenteerde bedragen — wat een lezer optelt. */
  totalAssetsCents: number;
  totalLiabilitiesEquityCents: number;
  /** totalAssets − totalLiabilitiesEquity, in gepresenteerde centen. */
  differenceCents: number;
  /**
   * De echte sluitcontrole, in de tekenconventie van de kern:
   * Σ balansrekeningen + de twee resultaatregels + het niet-geclassificeerde
   * deel. Dit hoort altijd 0 te zijn — het is de invariant van de kern zelf en
   * staat los van hoe een regel wordt gepresenteerd.
   */
  rawReconciliationCents: number;
  /** De gepresenteerde balans sluit (verschil 0). */
  ok: boolean;
}

export interface ProfitLossResult {
  groups: FinancialStatementGroup[];
  revenueCents: number;
  expenseCents: number;
  netResultCents: number;
  /** Cumulatief vóór de periode: het onverdeelde resultaat van eerdere jaren. */
  openingCents: number;
  /** De mutatie binnen de periode. */
  movementCents: number;
  /** opening + movement. */
  totalCents: number;
  /** Het deel van `movementCents` dat uit beginbalansrijen komt; null = onbekend. */
  openingBalanceContributionCents: number | null;
  ok: boolean;
}

export type FinancialStatementsResult =
  | {
      ok: true;
      balanceSheet: BalanceSheetResult;
      profitLoss: ProfitLossResult;
      unclassified: UnclassifiedSummary;
      completeness: StatementCompleteness;
      diagnostics: FinancialStatementsDiagnostics;
    }
  | {
      ok: false;
      failures: string[];
      completeness: StatementCompleteness;
      diagnostics: FinancialStatementsDiagnostics;
    };

// ── Classificatie van één rekening ──────────────────────────────────────────

export type AccountClassification =
  | { kind: "classified"; statementType: StatementType; reportGroup: ReportGroup; normalSide: NormalSide; normalSideSource: "explicit" | "group_default"; reportSort: number | null }
  | { kind: "unclassified"; reason: UnclassifiedReason };

/**
 * De expliciete velden zijn gezaghebbend — en alleen die. Elke stap die
 * mislukt geeft een eigen reden terug, zodat de latere UI kan zeggen wát er
 * ontbreekt. `categorie` speelt hier geen enkele rol.
 */
export function classifyAccount(
  account: ClassifiedAccountLike | undefined,
  resolved: boolean,
): AccountClassification {
  // Twee verschillende gebreken, twee verschillende redenen: een rekening die
  // niet bestaat vraagt om een boeking nakijken, een rekening die alleen niet
  // is meegegeven vraagt om een volledigere query.
  if (!resolved) return { kind: "unclassified", reason: "unresolved_account" };
  if (!account) return { kind: "unclassified", reason: "account_not_supplied" };

  const statementType = account.statement_type;
  if (!isStatementType(statementType)) return { kind: "unclassified", reason: "missing_statement_type" };

  const reportGroup = account.report_group;
  if (!isReportGroup(reportGroup)) return { kind: "unclassified", reason: "missing_report_group" };

  const allowed =
    statementType === "balans"
      ? (BALANS_GROUPS as readonly string[]).includes(reportGroup)
      : (WINST_VERLIES_GROUPS as readonly string[]).includes(reportGroup);
  if (!allowed) return { kind: "unclassified", reason: "invalid_group_for_statement" };

  let normalSide: NormalSide;
  let normalSideSource: "explicit" | "group_default";
  if (isNormalSide(account.normal_side)) {
    normalSide = account.normal_side;
    normalSideSource = "explicit";
  } else {
    const fallback = GROUP_DEFAULT_NORMAL_SIDE[reportGroup];
    if (!fallback) return { kind: "unclassified", reason: "missing_normal_side" };
    normalSide = fallback;
    normalSideSource = "group_default";
  }

  const reportSort =
    typeof account.report_sort === "number" && Number.isFinite(account.report_sort) ? account.report_sort : null;

  return { kind: "classified", statementType, reportGroup, normalSide, normalSideSource, reportSort };
}

// ── Volgorde binnen een groep ───────────────────────────────────────────────

/** report_sort oplopend (leeg achteraan), dan rekeningnummer, dan id. */
export function compareStatementLines(
  a: FinancialStatementAccountLine,
  b: FinancialStatementAccountLine,
): number {
  if (a.reportSort !== b.reportSort) {
    if (a.reportSort === null) return 1;
    if (b.reportSort === null) return -1;
    return a.reportSort - b.reportSort;
  }
  if (a.accountNumber !== b.accountNumber) {
    if (a.accountNumber === null) return 1;
    if (b.accountNumber === null) return -1;
    return a.accountNumber - b.accountNumber;
  }
  return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
}

// ── De engine ───────────────────────────────────────────────────────────────

function emptyByReason(): Record<UnclassifiedReason, number> {
  return {
    missing_statement_type: 0,
    missing_report_group: 0,
    invalid_group_for_statement: 0,
    missing_normal_side: 0,
    unresolved_account: 0,
    account_not_supplied: 0,
  };
}

function movementOf(rollup: LedgerAccountRollup): number {
  return rollup.periodDebitCents - rollup.periodCreditCents;
}

function rollupHasActivity(rollup: LedgerAccountRollup): boolean {
  return (
    rollup.openingCents !== 0 ||
    rollup.periodDebitCents !== 0 ||
    rollup.periodCreditCents !== 0 ||
    rollup.closingCents !== 0
  );
}

function buildGroups(
  keys: readonly ReportGroup[],
  lines: readonly FinancialStatementAccountLine[],
): FinancialStatementGroup[] {
  return keys.map((key) => {
    const groupLines = lines.filter((l) => l.reportGroup === key).sort(compareStatementLines);
    return {
      key,
      label: REPORT_GROUP_LABELS[key],
      lines: groupLines,
      totalCents: groupLines.reduce((sum, l) => sum + l.displayedCents, 0),
      rawSignedCents: groupLines.reduce((sum, l) => sum + l.rawSignedCents, 0),
    };
  });
}

export const CURRENT_YEAR_RESULT_LABEL = "Resultaat lopend boekjaar";
export const PRIOR_YEARS_RESULT_LABEL = "Onverdeeld resultaat voorgaande jaren";
/** Labels voor een periode die geen volledig kalenderjaar is. */
export const CURRENT_PERIOD_RESULT_LABEL = "Resultaat over deze periode";
export const PRIOR_PERIOD_RESULT_LABEL = "Resultaat vóór deze periode";

/** Precies één heel kalenderjaar, half-open: [Y-01-01, Y+1-01-01). */
export function isFullCalendarYear(period: LedgerPeriod): boolean {
  const year = Number(period.from.slice(0, 4));
  if (!Number.isFinite(year)) return false;
  return period.from === `${year}-01-01` && period.toExclusive === `${year + 1}-01-01`;
}

/**
 * Bouwt de balans en de winst-en-verliesrekening uit één rapport.
 *
 * Faalt de kern, dan faalt dit ook — er worden geen cijfers uit een ongeldig
 * rapport gepresenteerd.
 */
export function buildFinancialStatements(input: FinancialStatementsInput): FinancialStatementsResult {
  const { report, period, accounts, openingBalanceContribution, movementOnPeriodStart } = input;

  const reportYear = reportYearForPeriod(period);
  // Een boekjaarsplitsing mag alleen "lopend boekjaar" heten als de periode
  // werkelijk dat hele kalenderjaar is. Bij een kwartaal of een maand ligt het
  // resultaat van eerdere maanden in `openingCents` — dat is géén resultaat van
  // voorgaande JAREN, en die duiding zou stilzwijgend misleiden.
  const fullCalendarYear = isFullCalendarYear(period);
  const yearAmbiguous = !fullCalendarYear;
  const contributionKnown = openingBalanceContribution !== undefined;

  const baseDiagnostics: FinancialStatementsDiagnostics = {
    reportYear,
    yearAmbiguous,
    coverage: {
      totalRollups: 0,
      balanceAccounts: 0,
      profitLossAccounts: 0,
      unclassifiedAccounts: 0,
      // Er is niets geteld, dus er valt ook niets te bevestigen.
      ok: false,
    },
    ledgerClosingSumCents: 0,
    openingBalanceContributionKnown: contributionKnown,
    openingBalanceOnProfitLossCents: null,
    openingBalanceOnUnclassifiedCents: null,
    openingBalanceInsidePeriod: false,
    strayContributionKeys: 0,
    profitLossOnPeriodStartCents: null,
    failures: [],
  };

  // 1. De kern is de poort. Een ongeldig rapport levert nooit cijfers op.
  if (!report.ok) {
    return {
      ok: false,
      failures: ["kernel_not_ok"],
      completeness: "unknown",
      diagnostics: { ...baseDiagnostics, failures: ["kernel_not_ok"] },
    };
  }

  const byId = new Map<string, ClassifiedAccountLike>();
  for (const a of accounts) byId.set(a.id, a);

  const balanceLines: FinancialStatementAccountLine[] = [];
  const profitLossLines: FinancialStatementAccountLine[] = [];
  const unclassifiedAccounts: UnclassifiedAccount[] = [];
  const byReason = emptyByReason();

  let ledgerClosingSumCents = 0;
  let pnlOpeningCents = 0;
  let pnlMovementCents = 0;
  let openingBalanceOnProfitLossCents = 0;
  let unclassifiedClosingCents = 0;
  let unclassifiedMovementCents = 0;
  let unclassifiedWithActivity = 0;
  let openingBalanceOnUnclassifiedCents = 0;
  let profitLossOnPeriodStartCents = 0;

  for (const rollup of report.rollups) {
    ledgerClosingSumCents += rollup.closingCents;
    const account = byId.get(rollup.account.id);
    const classification = classifyAccount(account, rollup.account.resolved);
    const hasActivity = rollupHasActivity(rollup);

    if (classification.kind === "unclassified") {
      byReason[classification.reason]++;
      unclassifiedClosingCents += rollup.closingCents;
      unclassifiedMovementCents += movementOf(rollup);
      // Ook een niet-geclassificeerde rekening kan beginbalansbijdrage dragen;
      // die mag niet stilzwijgend uit de diagnose verdwijnen.
      if (contributionKnown) openingBalanceOnUnclassifiedCents += openingBalanceContribution!.get(rollup.account.id) ?? 0;
      if (hasActivity) unclassifiedWithActivity++;
      unclassifiedAccounts.push({
        accountId: rollup.account.id,
        accountNumber: rollup.account.nummer,
        accountName: rollup.account.omschrijving,
        reason: classification.reason,
        // Diagnose, geen waarheid: dit veld classificeert nooit iets.
        categorie: account?.categorie ?? null,
        statementType: typeof account?.statement_type === "string" ? account.statement_type : null,
        reportGroup: typeof account?.report_group === "string" ? account.report_group : null,
        rawSignedClosingCents: rollup.closingCents,
        rawSignedMovementCents: movementOf(rollup),
        hasActivity,
      });
      continue;
    }

    const isBalance = classification.statementType === "balans";
    // Balans = standsgrootheid (eindsaldo). W&V = stroomgrootheid (mutatie).
    const rawSignedCents = isBalance ? rollup.closingCents : movementOf(rollup);
    const contribution = openingBalanceContribution?.get(rollup.account.id) ?? null;
    const presentationSide = presentationSideFor(classification.reportGroup, classification.normalSide);

    const line: FinancialStatementAccountLine = {
      synthetic: false,
      accountId: rollup.account.id,
      accountNumber: rollup.account.nummer,
      accountName: rollup.account.omschrijving,
      reportGroup: classification.reportGroup,
      normalSide: classification.normalSide,
      normalSideSource: classification.normalSideSource,
      presentationSide,
      isContra: classification.normalSide !== presentationSide,
      rawSignedCents,
      displayedCents: displayedCents(rawSignedCents, presentationSide),
      reportSort: classification.reportSort,
      openingBalanceContributionCents: isBalance ? null : contributionKnown ? contribution ?? 0 : null,
      hasActivity,
    };

    if (isBalance) {
      balanceLines.push(line);
    } else {
      profitLossLines.push(line);
      pnlOpeningCents += rollup.openingCents;
      pnlMovementCents += movementOf(rollup);
      if (contributionKnown) openingBalanceOnProfitLossCents += contribution ?? 0;
      if (movementOnPeriodStart) profitLossOnPeriodStartCents += movementOnPeriodStart.get(rollup.account.id) ?? 0;
    }
  }

  // 2. Dekking: elke rollup komt precies één keer terecht.
  const coverage = {
    totalRollups: report.rollups.length,
    balanceAccounts: balanceLines.length,
    profitLossAccounts: profitLossLines.length,
    unclassifiedAccounts: unclassifiedAccounts.length,
    ok: balanceLines.length + profitLossLines.length + unclassifiedAccounts.length === report.rollups.length,
  };

  // Sleutels die geen rekening in dit rapport zijn, tellen nergens in mee maar
  // worden wel geteld: een kaart uit andere rijen of een andere periode is
  // daarmee zichtbaar in plaats van stilzwijgend gezaghebbend.
  let strayContributionKeys = 0;
  if (contributionKnown) {
    const rollupIds = new Set(report.rollups.map((r) => r.account.id));
    for (const key of openingBalanceContribution!.keys()) if (!rollupIds.has(key)) strayContributionKeys++;
  }

  const diagnostics: FinancialStatementsDiagnostics = {
    ...baseDiagnostics,
    coverage,
    ledgerClosingSumCents,
    openingBalanceOnProfitLossCents: contributionKnown ? openingBalanceOnProfitLossCents : null,
    openingBalanceOnUnclassifiedCents: contributionKnown ? openingBalanceOnUnclassifiedCents : null,
    openingBalanceInsidePeriod: contributionKnown && openingBalanceContribution!.size > 0,
    strayContributionKeys,
    profitLossOnPeriodStartCents: movementOnPeriodStart ? profitLossOnPeriodStartCents : null,
    failures: [],
  };

  const failures: string[] = [];
  if (!coverage.ok) failures.push("coverage_mismatch");
  // Invariant van de kern; als die hier niet klopt, klopt de hele set niet.
  if (ledgerClosingSumCents !== 0) failures.push("ledger_closing_sum_not_zero");

  // 3. W&V — presentatie en nettoresultaat, in centen.
  const profitLossGroups = buildGroups(WINST_VERLIES_GROUPS, profitLossLines);
  let revenueCents = 0;
  let expenseCents = 0;
  for (const line of profitLossLines) {
    // Op de KOLOM splitsen, niet op de aard van de rekening: een
    // belastingteruggaaf is een creditpost binnen `belastingen` en verlaagt de
    // belastinglast — het is geen omzet.
    if (line.presentationSide === "credit") revenueCents += line.displayedCents;
    else expenseCents += line.displayedCents;
  }
  const netResultCents = revenueCents - expenseCents;
  // Winst is positief: de W&V-rekeningen staan in de kern credit (negatief).
  if (netResultCents !== -pnlMovementCents) failures.push("pnl_net_result_mismatch");

  const profitLoss: ProfitLossResult = {
    groups: profitLossGroups,
    revenueCents,
    expenseCents,
    netResultCents,
    openingCents: pnlOpeningCents,
    movementCents: pnlMovementCents,
    totalCents: pnlOpeningCents + pnlMovementCents,
    openingBalanceContributionCents: contributionKnown ? openingBalanceOnProfitLossCents : null,
    // Deze cijfers zijn pas een compleet beeld van de periode als er geen
    // niet-geclassificeerde activiteit buiten staat.
    ok: unclassifiedWithActivity === 0,
  };

  // 4. Balans — standen plus de twee presentatieregels.
  const assetGroups = buildGroups(ASSET_GROUPS, balanceLines);
  const liabilityEquityGroups = buildGroups(EQUITY_LIABILITY_GROUPS, balanceLines);

  // De W&V-saldi verhuizen als presentatieregel naar het eigen vermogen. Ze
  // dragen de tekenconventie van de kern (`rawSignedCents`) en worden als
  // credit-normaal getoond, zodat winst positief verschijnt.
  const systemLines: FinancialStatementSystemLine[] = [
    {
      synthetic: true,
      kind: "prior_years_result",
      // Alleen een volledig kalenderjaar mag "voorgaande jaren" heten.
      label: fullCalendarYear ? PRIOR_YEARS_RESULT_LABEL : PRIOR_PERIOD_RESULT_LABEL,
      rawSignedCents: pnlOpeningCents,
      displayedCents: displayedCents(pnlOpeningCents, "credit"),
    },
    {
      synthetic: true,
      kind: "current_year_result",
      label: fullCalendarYear ? CURRENT_YEAR_RESULT_LABEL : CURRENT_PERIOD_RESULT_LABEL,
      rawSignedCents: pnlMovementCents,
      displayedCents: displayedCents(pnlMovementCents, "credit"),
    },
  ];

  const totalAssetsCents = assetGroups.reduce((sum, g) => sum + g.totalCents, 0);
  const totalLiabilitiesEquityCents =
    liabilityEquityGroups.reduce((sum, g) => sum + g.totalCents, 0) +
    systemLines.reduce((sum, l) => sum + l.displayedCents, 0);
  const differenceCents = totalAssetsCents - totalLiabilitiesEquityCents;

  // 5. Sluitcontroles. Eerlijk gezegd: zolang de kern `ok` teruggeeft, kunnen
  //    deze twee niet afgaan — ze volgen wiskundig uit Σ beginsaldo = 0 en
  //    Σ periodedebet = Σ periodecredit. Ze blijven staan als vangnet voor een
  //    met de hand samengesteld of elders gemanipuleerd rapport, en omdat een
  //    toekomstige wijziging in de groepsindeling ze wél kan breken (valt een
  //    balansgroep buiten beide kolommen, dan slaat de tweede check aan).
  const balanceRawCents =
    assetGroups.reduce((sum, g) => sum + g.rawSignedCents, 0) +
    liabilityEquityGroups.reduce((sum, g) => sum + g.rawSignedCents, 0);
  const rawReconciliationCents =
    balanceRawCents + systemLines.reduce((sum, l) => sum + l.rawSignedCents, 0) + unclassifiedClosingCents;
  if (rawReconciliationCents !== 0) failures.push("balance_identity_broken");
  // Omdat elke regel op zijn kolom is genormaliseerd, is het gepresenteerde
  // verschil per constructie precies het niet-geclassificeerde deel. Wijkt dat
  // af, dan is er een regel buiten beide kolommen gevallen.
  if (differenceCents !== -unclassifiedClosingCents) failures.push("presented_identity_broken");

  // 6. Kruiscontrole: de synthetische resultaatregel is exact het W&V-resultaat.
  const currentYearLine = systemLines.find((l) => l.kind === "current_year_result")!;
  if (currentYearLine.displayedCents !== netResultCents) failures.push("current_year_result_mismatch");

  const balanceSheet: BalanceSheetResult = {
    assetGroups,
    liabilityEquityGroups,
    systemLines,
    totalAssetsCents,
    totalLiabilitiesEquityCents,
    differenceCents,
    rawReconciliationCents,
    ok: differenceCents === 0,
  };

  const unclassified: UnclassifiedSummary = {
    accounts: unclassifiedAccounts.sort((a, b) => {
      if (a.accountNumber !== b.accountNumber) {
        if (a.accountNumber === null) return 1;
        if (b.accountNumber === null) return -1;
        return a.accountNumber - b.accountNumber;
      }
      return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
    }),
    withActivityCount: unclassifiedWithActivity,
    closingCents: unclassifiedClosingCents,
    movementCents: unclassifiedMovementCents,
    byReason,
  };

  diagnostics.failures = failures;

  if (failures.length > 0) {
    return { ok: false, failures, completeness: "unknown", diagnostics };
  }

  // 7. Volledigheid is een eigen oordeel: sluitend ≠ volledig.
  const completeness: StatementCompleteness =
    unclassified.withActivityCount > 0 ? "incomplete" : yearAmbiguous ? "ambiguous" : "complete";

  return { ok: true, balanceSheet, profitLoss, unclassified, completeness, diagnostics };
}
