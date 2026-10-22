// Fase 6C-b7 PR 3 — proef- en saldibalans, pure laag.
//
// Deze module rekent NIETS uit het grootboek opnieuw. Alle bedragen komen uit
// `buildAccountReport()` (PR 1); hier gebeurt alleen twee dingen:
//
//   1. PRESENTATIE — het debet-positieve saldo van de kern wordt gesplitst in
//      een debet- en een creditkolom. De onderliggende tekenconventie blijft
//      ongemoeid: er wordt niets omgeklapt, en zeker niet per categorie.
//   2. VERZOENING — de zichtbare rijen worden teruggelegd tegen de kern.
//
// Die verzoening bestaat uit twee lagen, en het verschil is de moeite waard:
//
//   a. PAARSGEWIJS (begin Dr = Cr, periode Dr = Cr, eind Dr = Cr). Dit is
//      verdediging in de diepte en NIET onafhankelijk: zolang de kern zijn
//      eigen zelfcontrole doorstaat volgt dit er wiskundig uit, en de
//      zichtbaarheidsfilter kan per definitie alleen rijen weglaten waarvan
//      alle zes bedragen nul zijn. Deze laag kan vandaag dus niet aanslaan.
//      Hij blijft staan als vangnet voor een toekomstige fout in de filter.
//   b. TEGEN DE KERNTOTALEN. Dit is de laag die wél iets toevoegt: de som van
//      de gesplitste kolommen wordt vergeleken met `report.totals` van de kern
//      zelf. Zou de splitsing systematisch omklappen (alles in de verkeerde
//      kolom), dan blijft (a) keurig kloppen — de twee totalen wisselen
//      immers gewoon van plaats — terwijl (b) het meteen ziet. Hetzelfde
//      geldt voor een verkeerd overgenomen periodekolom of een rij die bij
//      het filteren zoekraakt.
//
// W&V PER PERIODE VANAF NUL (herstel P7, A3-12)
//
// De kern rekent het beginsaldo van ELKE rekening als Σ(debet − credit) vóór
// de periode. Voor een balansrekening is dat juist; voor een W&V-rekening
// betekent het dat de proef- en saldibalans van 2027 de omzet van 2026 als
// beginsaldo meedraagt (nulmeting: omzet 10.000 in 2026 en 2.000 in 2027 gaf
// een eindsaldo van 12.000 in plaats van 2.000). BoekAssist maakt bij het
// afsluiten bewust GEEN resultaatboeking (PROJECT_MAP 6C-b10); de balans lost
// dat in de presentatie op met twee berekende regels uit de statement-engine:
// "Onverdeeld resultaat voorgaande jaren" (= Σ beginsaldo van de W&V-
// rekeningen) en "Resultaat lopend boekjaar" (= hun mutatie).
//
// Deze module doet nu precies hetzelfde, met dezelfde indeling en hetzelfde
// bedrag:
//   • een W&V-rekening is een rekening die de statement-engine als
//     `winst_verlies` classificeert (`classifyAccount`) — expliciete
//     classificatie, nooit `categorie` of een rekeningnummer;
//   • zo'n rekening toont beginsaldo 0 en als eindsaldo alleen haar mutatie
//     in de periode;
//   • wat zij vóór de periode droeg, staat op één BEREKENDE regel zonder
//     rekening ("Onverdeeld resultaat voorgaande jaren" bij een heel
//     kalenderjaar, anders "Resultaat vóór deze periode" — de labels van de
//     balans). Die regel is per constructie gelijk aan `prior_years_result` van
//     de balans over dezelfde periode;
//   • een rekening zonder (geldige) classificatie blijft cumulatief, zoals de
//     balans haar onder "Niet geclassificeerd" met haar eindsaldo toont. Dat
//     wordt geteld en gemeld, niet geraden.
// Er wordt niets geboekt en niets bijgeteld: de verschuiving tussen de
// rekeningen en de berekende regel laat elke kolomsom gelijk, dus de
// verzoening tegen de kern (b) blijft gelden en vangt een fout in deze stap.
//
// Wat deze module NIET doet: geen journal_entries, geen factuur- of banktotalen,
// geen tekenomklap per categorie, geen filter op reversal_of_posting_id.

import {
  centsToAmount,
  classifyLedgerCategory,
  type LedgerAccountCategory,
  type LedgerAccountReport,
  type LedgerAccountRef,
  type LedgerAccountRollup,
  type LedgerPeriod,
  type LedgerSelfCheckFailure,
} from "@/lib/ledger-reporting";
import {
  PRIOR_PERIOD_RESULT_LABEL,
  PRIOR_YEARS_RESULT_LABEL,
  classifyAccount,
  isFullCalendarYear,
} from "@/lib/financial-statements";

/** Rekening uit het schema, zoals `useGrootboekrekeningen` hem levert. */
export interface ChartAccountLike {
  id: string;
  nummer: number;
  omschrijving: string;
  categorie: string | null | undefined;
  actief?: boolean | null;
  client_id?: string | null;
  /** De expliciete rapportageclassificatie (Balans/W&V PR 1); bepaalt of een rekening een W&V-rekening is. */
  statement_type?: string | null;
  report_group?: string | null;
  normal_side?: string | null;
  report_sort?: number | null;
}

export interface TrialBalanceRow {
  account: LedgerAccountRef;
  openingDebitCents: number;
  openingCreditCents: number;
  periodDebitCents: number;
  periodCreditCents: number;
  closingDebitCents: number;
  closingCreditCents: number;
  /** Alle zes bedragen zijn nul. */
  isZero: boolean;
  /** De rij heeft boekingen in beeld (kwam uit de kern, niet uit het schema). */
  hasPostings: boolean;
  /**
   * Een W&V-rekening (expliciet geclassificeerd): beginsaldo 0, eindsaldo =
   * alleen de mutatie in de periode. Haar historie staat op de berekende regel.
   */
  profitLoss: boolean;
}

/**
 * Een BEREKENDE regel: geen grootboekrekening, geen rekeningnummer, geen
 * doorklik. Draagt het resultaat van vóór de periode, zoals de balans dat doet.
 */
export interface TrialBalanceSystemRow {
  kind: "prior_result";
  label: string;
  /** Kern-teken (debet-positief): Σ beginsaldo van de W&V-rekeningen. */
  rawSignedCents: number;
  openingDebitCents: number;
  openingCreditCents: number;
  periodDebitCents: number;
  periodCreditCents: number;
  closingDebitCents: number;
  closingCreditCents: number;
}

/** Wat de W&V-stap heeft gedaan, voor de melding op het scherm. */
export interface TrialBalanceProfitLossSummary {
  /** Aantal W&V-rekeningen dat vanaf nul wordt getoond. */
  resetAccounts: number;
  /** Rekeningen zonder (geldige) classificatie met een beginsaldo ≠ 0: blijven cumulatief. */
  unclassifiedWithOpening: number;
  /** Het label van de berekende regel. */
  priorResultLabel: string;
}

export interface TrialBalanceTotals {
  openingDebitCents: number;
  openingCreditCents: number;
  periodDebitCents: number;
  periodCreditCents: number;
  closingDebitCents: number;
  closingCreditCents: number;
}

export type TrialBalanceFailure =
  | { kind: "kernel"; failures: LedgerSelfCheckFailure[] }
  | { kind: "kernel_mismatch"; veld: string; verwacht: number; gevonden: number }
  | { kind: "opening_unbalanced"; debitCents: number; creditCents: number }
  | { kind: "period_unbalanced"; debitCents: number; creditCents: number }
  | { kind: "closing_unbalanced"; debitCents: number; creditCents: number };

export type TrialBalance =
  | {
      ok: true;
      rows: TrialBalanceRow[];
      /** Berekende regels (hoogstens één): het resultaat van vóór de periode. */
      systemRows: TrialBalanceSystemRow[];
      /** Kolomsommen over `rows` ÉN `systemRows`. */
      totals: TrialBalanceTotals;
      profitLoss: TrialBalanceProfitLossSummary;
    }
  | { ok: false; failures: TrialBalanceFailure[] };

/**
 * Debet-positief saldo -> twee kolommen. Puur presentatie.
 *
 *   saldo > 0  -> debet = saldo,      credit = 0
 *   saldo < 0  -> debet = 0,          credit = |saldo|
 *   saldo = 0  -> debet = 0,          credit = 0
 */
export function splitBalanceCents(cents: number): { debitCents: number; creditCents: number } {
  if (cents > 0) return { debitCents: cents, creditCents: 0 };
  if (cents < 0) return { debitCents: 0, creditCents: -cents };
  return { debitCents: 0, creditCents: 0 };
}

/**
 * Eén rekening uit de kern. Een W&V-rekening krijgt beginsaldo 0 en als
 * eindsaldo alleen haar mutatie (periodedebet − periodecredit); de kern zelf
 * wordt niet aangeraakt.
 */
function rowUitRollup(r: LedgerAccountRollup, profitLoss: boolean): TrialBalanceRow {
  const openingCents = profitLoss ? 0 : r.openingCents;
  const closingCents = profitLoss ? r.periodDebitCents - r.periodCreditCents : r.closingCents;
  const opening = splitBalanceCents(openingCents);
  const closing = splitBalanceCents(closingCents);
  const isZero =
    opening.debitCents === 0 && opening.creditCents === 0 &&
    r.periodDebitCents === 0 && r.periodCreditCents === 0 &&
    closing.debitCents === 0 && closing.creditCents === 0;
  return {
    account: r.account,
    openingDebitCents: opening.debitCents,
    openingCreditCents: opening.creditCents,
    periodDebitCents: r.periodDebitCents,
    periodCreditCents: r.periodCreditCents,
    closingDebitCents: closing.debitCents,
    closingCreditCents: closing.creditCents,
    isZero,
    hasPostings: true,
    profitLoss,
  };
}

function rowUitSchema(a: ChartAccountLike, categorie: LedgerAccountCategory): TrialBalanceRow {
  return {
    account: {
      id: a.id,
      nummer: a.nummer,
      omschrijving: a.omschrijving,
      categorie,
      actief: a.actief ?? null,
      resolved: true,
    },
    openingDebitCents: 0,
    openingCreditCents: 0,
    periodDebitCents: 0,
    periodCreditCents: 0,
    closingDebitCents: 0,
    closingCreditCents: 0,
    isZero: true,
    hasPostings: false,
    profitLoss: false,
  };
}

/** Vaste volgorde: rekeningnummer, dan omschrijving, dan id. Nooit op saldo. */
export function compareTrialBalanceRows(a: TrialBalanceRow, b: TrialBalanceRow): number {
  const an = a.account.nummer;
  const bn = b.account.nummer;
  if (an !== null && bn !== null && an !== bn) return an - bn;
  // Een niet-herleidbare rekening heeft geen nummer en sorteert achteraan.
  if (an === null && bn !== null) return 1;
  if (an !== null && bn === null) return -1;
  const ao = a.account.omschrijving;
  const bo = b.account.omschrijving;
  if (ao !== bo) return ao < bo ? -1 : 1;
  return a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0;
}

export interface BuildTrialBalanceInput {
  report: LedgerAccountReport;
  /** Volledig rekeningschema; alleen nodig voor "Toon nulrekeningen". */
  accounts?: readonly ChartAccountLike[];
  /** Administratie waarvoor het rapport draait; filtert het schema. */
  clientId?: string;
  /** Standaard false: rekeningen zonder saldo en zonder beweging blijven weg. */
  includeZeroAccounts?: boolean;
  /** Injecteerbaar voor de test; standaard de classificatie van de kern. */
  classify?: (raw: string | null | undefined) => LedgerAccountCategory;
  /**
   * De periode van het rapport; alleen voor het LABEL van de berekende regel
   * (een heel kalenderjaar heet "voorgaande jaren", elke andere periode
   * "vóór deze periode" — dezelfde regel als de balans).
   */
  period?: LedgerPeriod;
}

/**
 * Bouwt de proef- en saldibalans uit een rapport van de kern.
 *
 * Faalt de zelfcontrole van de kern, dan komt er geen enkel bedrag uit: het
 * resultaat draagt dan alleen de reden. Hetzelfde geldt wanneer de zes
 * kolomtotalen paarsgewijs niet sluiten.
 */
export function buildTrialBalance(input: BuildTrialBalanceInput): TrialBalance {
  const { report, accounts, clientId, includeZeroAccounts = false } = input;

  if (report.ok === false) {
    return { ok: false, failures: [{ kind: "kernel", failures: report.failures }] };
  }

  // Dezelfde indeling als de balans: alleen een rekening die de statement-
  // engine als W&V classificeert, gaat per periode vanaf nul.
  const classificatie = new Map((accounts ?? []).map((a) => [a.id, a]));
  let priorResultCents = 0;
  let resetAccounts = 0;
  let resetMetBeginsaldo = 0;
  let unclassifiedWithOpening = 0;
  const rijen = report.rollups.map((r) => {
    const c = classifyAccount(classificatie.get(r.account.id), r.account.resolved);
    const profitLoss = c.kind === "classified" && c.statementType === "winst_verlies";
    if (profitLoss) {
      resetAccounts++;
      priorResultCents += r.openingCents;
      if (r.openingCents !== 0) resetMetBeginsaldo++;
    } else if (c.kind === "unclassified" && r.openingCents !== 0) {
      unclassifiedWithOpening++;
    }
    return rowUitRollup(r, profitLoss);
  });

  // Alleen bij "Toon nulrekeningen": rekeningen uit het schema die in deze
  // periode geen enkele boeking hebben. Er wordt niets verzonnen — ze komen
  // binnen met zes nullen.
  if (includeZeroAccounts && accounts) {
    const classify = input.classify ?? defaultClassify;
    const gezien = new Set(rijen.map((r) => r.account.id));
    for (const a of accounts) {
      if (gezien.has(a.id)) continue;
      // Het schema bevat ook rekeningen van andere administraties; die horen
      // niet in dit rapport. Organisatiebrede rekeningen (client_id null) wel.
      const hoortErbij = a.client_id == null || !clientId || a.client_id === clientId;
      if (!hoortErbij) continue;
      rijen.push(rowUitSchema(a, classify(a.categorie)));
    }
  }

  // Zichtbaarheid. Een niet-herleidbare rekening MET boekingen blijft altijd
  // staan: een boeking op een rekening die we niet kunnen thuisbrengen mag
  // nooit uit beeld verdwijnen.
  const zichtbaar = rijen.filter((r) => {
    if (!r.isZero) return true;
    if (r.hasPostings && !r.account.resolved) return true;
    return includeZeroAccounts;
  });

  zichtbaar.sort(compareTrialBalanceRows);

  // De berekende regel verschijnt zodra een W&V-rekening iets vóór de periode
  // droeg — ook als dat per saldo nul is, want dan zijn er wel bedragen
  // verschoven. Zonder historie (het eerste jaar) is er niets te tonen.
  const priorResultLabel =
    input.period && isFullCalendarYear(input.period) ? PRIOR_YEARS_RESULT_LABEL : PRIOR_PERIOD_RESULT_LABEL;
  const systemRows: TrialBalanceSystemRow[] = [];
  if (resetMetBeginsaldo > 0) {
    const split = splitBalanceCents(priorResultCents);
    systemRows.push({
      kind: "prior_result",
      label: priorResultLabel,
      rawSignedCents: priorResultCents,
      openingDebitCents: split.debitCents,
      openingCreditCents: split.creditCents,
      periodDebitCents: 0,
      periodCreditCents: 0,
      closingDebitCents: split.debitCents,
      closingCreditCents: split.creditCents,
    });
  }

  const totals: TrialBalanceTotals = {
    openingDebitCents: 0, openingCreditCents: 0,
    periodDebitCents: 0, periodCreditCents: 0,
    closingDebitCents: 0, closingCreditCents: 0,
  };
  for (const r of [...zichtbaar, ...systemRows]) {
    totals.openingDebitCents += r.openingDebitCents;
    totals.openingCreditCents += r.openingCreditCents;
    totals.periodDebitCents += r.periodDebitCents;
    totals.periodCreditCents += r.periodCreditCents;
    totals.closingDebitCents += r.closingDebitCents;
    totals.closingCreditCents += r.closingCreditCents;
  }

  const failures: TrialBalanceFailure[] = [];

  // (b) Terug naar de kern. `report.totals` is door de kern zelf berekend,
  // los van de splitsing en de filter hierboven.
  const kern = report.totals;
  const vergelijk = (veld: string, verwacht: number, gevonden: number) => {
    if (verwacht !== gevonden) failures.push({ kind: "kernel_mismatch", veld, verwacht, gevonden });
  };
  vergelijk("beginsaldo", kern.openingCents, totals.openingDebitCents - totals.openingCreditCents);
  vergelijk("periode debet", kern.periodDebitCents, totals.periodDebitCents);
  vergelijk("periode credit", kern.periodCreditCents, totals.periodCreditCents);
  vergelijk("eindsaldo", kern.closingCents, totals.closingDebitCents - totals.closingCreditCents);

  // (a) Paarsgewijs.
  if (totals.openingDebitCents !== totals.openingCreditCents) {
    failures.push({
      kind: "opening_unbalanced",
      debitCents: totals.openingDebitCents,
      creditCents: totals.openingCreditCents,
    });
  }
  if (totals.periodDebitCents !== totals.periodCreditCents) {
    failures.push({
      kind: "period_unbalanced",
      debitCents: totals.periodDebitCents,
      creditCents: totals.periodCreditCents,
    });
  }
  if (totals.closingDebitCents !== totals.closingCreditCents) {
    failures.push({
      kind: "closing_unbalanced",
      debitCents: totals.closingDebitCents,
      creditCents: totals.closingCreditCents,
    });
  }
  if (failures.length > 0) return { ok: false, failures };

  return {
    ok: true,
    rows: zichtbaar,
    systemRows,
    totals,
    profitLoss: { resetAccounts, unclassifiedWithOpening, priorResultLabel },
  };
}

const defaultClassify = classifyLedgerCategory;

// ── Bedragopmaak ───────────────────────────────────────────────────────────

/**
 * Centen -> Nederlands decimaalgetal, ZONDER euroteken en zonder
 * duizendtalscheiding. Gebruikt door zowel het scherm als de CSV, zodat er
 * geen tweede opmaakpad kan ontstaan.
 */
export function formatAmountNl(cents: number): string {
  return centsToAmount(cents).toFixed(2).replace(".", ",");
}

// ── CSV ────────────────────────────────────────────────────────────────────

export const CSV_SEPARATOR = ";";

/** De categorie van een berekende regel, gelijk aan de badge op de balans. */
export const SYSTEM_ROW_CATEGORY_LABEL = "Berekend";

export const CSV_HEADERS = [
  "Rekeningnummer",
  "Omschrijving",
  "Categorie",
  "Beginsaldo debet",
  "Beginsaldo credit",
  "Periode debet",
  "Periode credit",
  "Eindsaldo debet",
  "Eindsaldo credit",
] as const;

/** Elk veld tussen dubbele aanhalingstekens, interne aanhalingstekens verdubbeld. */
function csvVeld(waarde: string): string {
  return `"${(waarde ?? "").replace(/"/g, '""')}"`;
}

function csvRegel(velden: readonly string[]): string {
  return velden.map(csvVeld).join(CSV_SEPARATOR);
}

export interface TrialBalanceCsvInput {
  rows: readonly TrialBalanceRow[];
  /** Berekende regels: zonder rekeningnummer, categorie "Berekend". */
  systemRows?: readonly TrialBalanceSystemRow[];
  totals: TrialBalanceTotals;
  categoryLabel: (c: LedgerAccountCategory) => string;
  /** Label voor de totaalregel, bv. "Totaal". */
  totalLabel?: string;
}

/**
 * Exact dezelfde rijen, dezelfde volgorde en dezelfde totalen als het scherm.
 * Zonder BOM: die wordt pas bij het downloaden toegevoegd, zodat de tekst zelf
 * vergelijkbaar blijft in een test.
 */
export function trialBalanceToCsv(input: TrialBalanceCsvInput): string {
  const { rows, systemRows = [], totals, categoryLabel, totalLabel = "Totaal" } = input;
  const regels = [csvRegel(CSV_HEADERS)];

  for (const r of rows) {
    regels.push(csvRegel([
      r.account.nummer === null ? "" : String(r.account.nummer),
      r.account.omschrijving,
      categoryLabel(r.account.categorie),
      formatAmountNl(r.openingDebitCents),
      formatAmountNl(r.openingCreditCents),
      formatAmountNl(r.periodDebitCents),
      formatAmountNl(r.periodCreditCents),
      formatAmountNl(r.closingDebitCents),
      formatAmountNl(r.closingCreditCents),
    ]));
  }

  for (const r of systemRows) {
    regels.push(csvRegel([
      "",
      r.label,
      SYSTEM_ROW_CATEGORY_LABEL,
      formatAmountNl(r.openingDebitCents),
      formatAmountNl(r.openingCreditCents),
      formatAmountNl(r.periodDebitCents),
      formatAmountNl(r.periodCreditCents),
      formatAmountNl(r.closingDebitCents),
      formatAmountNl(r.closingCreditCents),
    ]));
  }

  regels.push(csvRegel([
    "",
    totalLabel,
    "",
    formatAmountNl(totals.openingDebitCents),
    formatAmountNl(totals.openingCreditCents),
    formatAmountNl(totals.periodDebitCents),
    formatAmountNl(totals.periodCreditCents),
    formatAmountNl(totals.closingDebitCents),
    formatAmountNl(totals.closingCreditCents),
  ]));

  return `${regels.join("\r\n")}\r\n`;
}

/** Bestandsnaamveilige weergave: kleine letters, streepjes, geen accenten. */
export function slugify(waarde: string): string {
  const basis = waarde
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return basis || "onbekend";
}

export function trialBalanceCsvFilename(clientName: string, periodLabel: string): string {
  return `proef-en-saldibalans-${slugify(clientName)}-${slugify(periodLabel)}.csv`;
}
