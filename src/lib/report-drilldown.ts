/**
 * Van een gerapporteerd bedrag naar de grootboekregels eronder.
 *
 * WAT DIT WEL DOET
 * De regels die de engine al heeft berekend ordenen in een pad —
 * categorie → groep → rekening — en per niveau vaststellen dát de onderdelen
 * exact optellen tot het bedrag erboven.
 *
 * WAT DIT NADRUKKELIJK NIET DOET
 * Geen enkel rapportbedrag opnieuw berekenen. Elk bedrag dat hier voorkomt is
 * een veld van `buildFinancialStatements()` of van de kern
 * (`buildAccountReport` / `buildRunningBalance`). Er wordt geen teken
 * omgeklapt, geen classificatie afgeleid uit een nummer of een naam, en er
 * wordt nooit een beginsaldo verzonnen.
 *
 * DE AANSLUITING IS HET PUNT
 * Een doorklik die niet aansluit op het bedrag waarop geklikt is, is erger dan
 * geen doorklik: dan lijkt het rapport te liegen. Daarom levert elk niveau
 * naast zijn regels ook een expliciete `reconciles`-uitspraak, en leggen de
 * tests die vast.
 */

import {
  displayedCents as orientCents,
  type FinancialStatementAccountLine,
  type FinancialStatementGroup,
} from "./financial-statements";
import type { NormalSide } from "./reporting-classification";
import type { StatementGroupSections, StatementSubgroupSection } from "./financial-statements-subgroups";
import type { LedgerPeriod, LedgerRunningBalance } from "./ledger-reporting";

/**
 * Welk rapport de doorklik verklaart. EXPLICIET meegegeven — nooit afgeleid
 * uit een label, een rekeningnummer of een categorie.
 *
 * Dit onderscheid is niet cosmetisch. Een W&V-regel is de MUTATIE van de
 * gekozen periode; een balansregel is een EINDSALDO waar een overloop uit
 * eerdere perioden in kan zitten. Dezelfde uitleg voor beide zou bij een
 * omzetrekening met jaren historie een cumulatief saldo presenteren als
 * verklaring van een bedrag dat alleen over deze periode gaat.
 */
export type ReportKind = "profit_loss" | "balance_sheet" | "trial_balance";

/** Waar de gebruiker naar kijkt. `null` = het paneel is dicht. */
export type DrilldownTarget =
  | { level: "group"; groupKey: string }
  | { level: "subgroup"; groupKey: string; subgroupKey: string }
  | { level: "account"; groupKey: string; subgroupKey: string | null; accountId: string };

/** Eén regel in het paneel, met het bedrag zoals het rapport het toont. */
export interface DrilldownAccountRow {
  accountId: string;
  accountNumber: number | null;
  accountName: string;
  /** Exact `FinancialStatementAccountLine.displayedCents` — niet herrekend. */
  displayedCents: number;
  /** Exact `FinancialStatementAccountLine.rawSignedCents` — debet-positief. */
  rawSignedCents: number;
  /**
   * De oriëntatie van de KOLOM waarin het rapport deze regel toont, zoals de
   * engine hem heeft vastgesteld. Wordt hier alleen doorgegeven, nooit
   * afgeleid: het paneel gebruikt hem met de exportfunctie van de engine zelf.
   */
  presentationSide: NormalSide;
  isContra: boolean;
}

export interface DrilldownSubgroupRow {
  key: string;
  label: string;
  isFallback: boolean;
  subtotalCents: number;
  accounts: DrilldownAccountRow[];
}

export interface DrilldownGroupView {
  groupKey: string;
  label: string;
  /** Het groepstotaal van de engine, ongewijzigd. */
  totalCents: number;
  subgroups: DrilldownSubgroupRow[];
  /** Σ subgroeptotalen === groepstotaal. */
  reconciles: boolean;
}

function toRow(line: FinancialStatementAccountLine): DrilldownAccountRow {
  return {
    accountId: line.accountId,
    accountNumber: line.accountNumber,
    accountName: line.accountName,
    displayedCents: line.displayedCents,
    rawSignedCents: line.rawSignedCents,
    presentationSide: line.presentationSide,
    isContra: line.isContra,
  };
}

function sum(cents: readonly number[]): number {
  let totaal = 0;
  for (const c of cents) totaal += c;
  return totaal;
}

function subgroupRow(section: StatementSubgroupSection): DrilldownSubgroupRow {
  return {
    key: section.key,
    label: section.label,
    isFallback: section.isFallback,
    subtotalCents: section.subtotalCents,
    accounts: section.lines.map(toRow),
  };
}

/**
 * Het paneel voor één categorie.
 *
 * Zijn er secties (PR #184), dan worden die gebruikt — inclusief de sectie
 * "Nog niet ingedeeld", die nooit wordt weggelaten. Zijn ze er niet, dan valt
 * de categorie terug op één naamloze sectie met al haar rekeningen, zodat een
 * doorklik ook werkt zolang niemand een groep heeft gekozen.
 */
export function groupView(
  group: FinancialStatementGroup,
  sections: StatementGroupSections | undefined,
): DrilldownGroupView {
  const subgroups = sections
    ? sections.sections.map(subgroupRow)
    : [
        {
          key: "__all__",
          label: group.label,
          isFallback: true,
          subtotalCents: sum(group.lines.map((l) => l.displayedCents)),
          accounts: group.lines.map(toRow),
        },
      ];

  return {
    groupKey: group.key,
    label: group.label,
    totalCents: group.totalCents,
    subgroups,
    reconciles: sum(subgroups.map((s) => s.subtotalCents)) === group.totalCents,
  };
}

/** Één groep binnen een categorie, of `null` als die groep niet bestaat. */
export function subgroupView(
  view: DrilldownGroupView,
  subgroupKey: string,
): DrilldownSubgroupRow | null {
  return view.subgroups.find((s) => s.key === subgroupKey) ?? null;
}

/** Sluit een groep aan op de som van haar rekeningen? */
export function subgroupReconciles(row: DrilldownSubgroupRow): boolean {
  return sum(row.accounts.map((a) => a.displayedCents)) === row.subtotalCents;
}

/** De rekening die is aangeklikt, met het bedrag dat het rapport toont. */
export function accountRow(
  view: DrilldownGroupView,
  accountId: string,
): DrilldownAccountRow | null {
  for (const sub of view.subgroups) {
    const treffer = sub.accounts.find((a) => a.accountId === accountId);
    if (treffer) return treffer;
  }
  return null;
}

/** Geen rekening mag twee keer in één paneel staan. */
export function accountsAreUnique(view: DrilldownGroupView): boolean {
  const ids = view.subgroups.flatMap((s) => s.accounts.map((a) => a.accountId));
  return new Set(ids).size === ids.length;
}

// ── De aansluiting van een balansrekening ───────────────────────────────────

/**
 * Beginsaldo + mutaties = eindsaldo, alle drie uit de KERN.
 *
 * Voor een balansrekening is het eindsaldo van de balans niet hetzelfde als de
 * mutaties van de periode: er kan een overloop uit eerdere perioden in zitten.
 * Dat verschil mag nooit worden weggemoffeld, want dan zou het paneel
 * suggereren dat de getoonde regels het hele saldo verklaren.
 *
 * Alle drie de getallen komen uit `buildRunningBalance()` — dezelfde kern die
 * het rapport voedt. Er wordt geen beginbalans verzonnen: is er niets vóór de
 * periode geboekt, dan is het beginsaldo gewoon 0, en dat is een uitkomst en
 * geen aanname.
 */
export interface AccountReconciliation {
  openingCents: number;
  periodDebitCents: number;
  periodCreditCents: number;
  /** Debet-positief, zoals de kern rekent. */
  periodMovementCents: number;
  closingCents: number;
  /** Beginsaldo + mutaties === eindsaldo. */
  reconciles: boolean;
  /** Draagt deze rekening een overloop uit eerdere perioden? */
  hasOpeningContribution: boolean;
}

export function accountReconciliation(running: LedgerRunningBalance): AccountReconciliation {
  const periodDebitCents = sum(running.lines.map((l) => l.debitCents));
  const periodCreditCents = sum(running.lines.map((l) => l.creditCents));
  const periodMovementCents = periodDebitCents - periodCreditCents;
  return {
    openingCents: running.openingCents,
    periodDebitCents,
    periodCreditCents,
    periodMovementCents,
    closingCents: running.closingCents,
    reconciles: running.openingCents + periodMovementCents === running.closingCents,
    hasOpeningContribution: running.openingCents !== 0,
  };
}

// ── Periode- en administratiegrenzen ────────────────────────────────────────

/**
 * Ligt elke getoonde regel binnen de periode van het rapport, en bij de juiste
 * administratie? De kern filtert daar al op; dit is de vangnetcontrole die de
 * tests kunnen aanroepen, zodat een latere wijziging niet ongemerkt een regel
 * van buiten de periode of van een andere administratie binnenlaat.
 *
 * De periode is halfopen: `[from, toExclusive)`. Dezelfde conventie als overal.
 */
export function linesWithinPeriod(
  running: LedgerRunningBalance,
  period: LedgerPeriod,
  clientId: string,
): boolean {
  return running.lines.every(
    (l) =>
      l.row.client_id === clientId &&
      l.row.posting_date >= period.from &&
      l.row.posting_date < period.toExclusive,
  );
}

/** Staat er alleen de aangeklikte rekening in? */
export function linesBelongToAccount(running: LedgerRunningBalance, accountId: string): boolean {
  return running.lines.every((l) => l.row.grootboekrekening_id === accountId);
}

// ── De aansluiting op het AANGEKLIKTE rapportbedrag ─────────────────────────

/**
 * Wat een W&V-bedrag werkelijk verklaart.
 *
 * Een W&V-regel is de MUTATIE van de gekozen periode — de engine zet
 * `rawSignedCents` voor een resultaatrekening op `periodDebit − periodCredit`
 * en niet op het eindsaldo. Een beginsaldo/eindsaldo-opstelling zou hier dus
 * cumulatieve historie presenteren als verklaring van een bedrag dat alleen
 * over deze periode gaat: bij een omzetrekening met jaren historie leest dat
 * als 80.000 "verklaring" bij een rapportregel van 20.000.
 *
 * De oriëntatie komt van de engine zelf: `presentationSide` staat op de regel
 * en `orientCents()` is de exportfunctie die de engine óók gebruikt om
 * `displayedCents` te maken. Er is hier dus geen tweede tekenmotor.
 */
export interface ProfitLossReconciliation {
  /** Het bedrag waarop geklikt is, zoals het rapport het toont. */
  reportCents: number;
  periodDebitCents: number;
  periodCreditCents: number;
  /** Debet-positief, de conventie van de kern. */
  netMovementCents: number;
  /** De mutatie in de oriëntatie van de rapportkolom. */
  orientedCents: number;
  presentationSide: NormalSide;
  /** Wijst het rapportbedrag de andere kant op dan de kernconventie? */
  isMirrored: boolean;
  /** De periodemutatie verklaart het rapportbedrag exact. */
  reconciles: boolean;
}

export function profitLossReconciliation(
  row: DrilldownAccountRow,
  running: LedgerRunningBalance,
): ProfitLossReconciliation {
  const periodDebitCents = sum(running.lines.map((l) => l.debitCents));
  const periodCreditCents = sum(running.lines.map((l) => l.creditCents));
  const netMovementCents = periodDebitCents - periodCreditCents;
  const oriented = orientCents(netMovementCents, row.presentationSide);
  return {
    reportCents: row.displayedCents,
    periodDebitCents,
    periodCreditCents,
    netMovementCents,
    orientedCents: oriented,
    presentationSide: row.presentationSide,
    isMirrored: row.presentationSide === "credit" && netMovementCents !== 0,
    reconciles: oriented === row.displayedCents,
  };
}

/**
 * De laatste stap van een balansaansluiting: het debet-positieve
 * grootboeksaldo naast het bedrag zoals de Balans het toont.
 *
 * Bij een creditzijde (eigen vermogen, schulden) zijn die twee elkaars
 * spiegelbeeld. Twee tegengestelde getallen zonder uitleg naast elkaar is
 * precies wat een lezer doet twijfelen aan het rapport; daarom benoemt het
 * paneel ze allebei, en alleen wanneer ze verschillen.
 */
export interface BalanceOrientation {
  /** `LedgerRunningBalance.closingCents`, debet-positief. */
  ledgerClosingCents: number;
  /** `FinancialStatementAccountLine.displayedCents`. */
  reportCents: number;
  presentationSide: NormalSide;
  /** De twee wijzen tegengesteld; dan hoort er uitleg bij. */
  isMirrored: boolean;
  /** Het grootboeksaldo verklaart het rapportbedrag exact. */
  reconciles: boolean;
}

export function balanceOrientation(
  row: DrilldownAccountRow,
  running: LedgerRunningBalance,
): BalanceOrientation {
  const oriented = orientCents(running.closingCents, row.presentationSide);
  return {
    ledgerClosingCents: running.closingCents,
    reportCents: row.displayedCents,
    presentationSide: row.presentationSide,
    isMirrored: oriented !== running.closingCents,
    reconciles: oriented === row.displayedCents,
  };
}
