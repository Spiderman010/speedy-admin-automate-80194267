// Fase 6C-b7 PR 1 — pure rapportagekern boven public.ledger_postings.
//
// Geen React, geen Supabase, geen imports uit de documentlaag. Alles wat hier
// staat is deterministisch en in isolatie te testen. De cijfers in deze laag
// komen UITSLUITEND uit ledger_postings: journal_entries, factuurtotalen en
// banksaldi mogen hier nooit binnenkomen (zie de dubbeltellingsregel in
// PROJECT_MAP 6C-b7).
//
// Conventies — vastgelegd, getest, overal in deze module gelijk:
//   • Tekenconventie: signed = debet − credit (debet-positief). Er wordt NIET
//     per categorie omgeklapt; een creditsaldo is een negatief getal.
//   • Rekenen in hele centen (integer). numeric(12,2) uit de database wordt
//     op de grens omgezet; balansinvarianten vergelijken nooit floats.
//   • Periode = half-open [from, toExclusive) op posting_date, ISO-strings
//     lexicografisch vergeleken. Dit is de bestaande app-conventie
//     (getLedgerYearRange / getYearDateRange: >= 'YYYY-01-01' en
//     < 'YYYY+1-01-01'). boekjaar wordt meegedragen maar filtert nooit.
//   • Beginsaldo = Σ(debet − credit) vóór from; periode = binnen [from, to).
//     Omdat de groepstrigger van 6C-b2 één posting_date per boekingsgroep
//     afdwingt, kan een periodegrens nooit een journaalpost doormidden knippen.
//   • reversal_of_posting_id wordt nooit gefilterd: een toekomstige
//     tegenboeking is gewoon een rij en telt gewoon mee.
//   • EUR-only: elke rij met een andere valuta is een harde fout, nooit een
//     stilzwijgend weggelaten rij.
//   • Een rekening die niet te herleiden is, blijft in beeld als
//     "Onbekende rekening"; zijn boekingen verdwijnen nooit.

// ── Invoertypen (structureel, zodat echte rijen én kleine fixtures passen) ──

export interface LedgerPostingLike {
  id: string;
  client_id: string;
  grootboekrekening_id: string;
  posting_group_id: string;
  line_no: number;
  /** ISO yyyy-mm-dd. */
  posting_date: string;
  boekjaar: number;
  /** numeric(12,2); PostgREST levert een number, een string wordt ook geaccepteerd. */
  debit_amount: number | string;
  credit_amount: number | string;
  currency: string;
  description?: string | null;
  source_type: string;
  source_id?: string | null;
  source_line_id?: string | null;
  reversal_of_posting_id?: string | null;
}

/** Alle rekeningen, dus óók inactieve — een inactieve rekening kan saldo dragen. */
export interface LedgerAccountLike {
  id: string;
  nummer: number;
  omschrijving: string;
  categorie: string | null | undefined;
  actief?: boolean | null;
}

export const REPORTING_CURRENCY = "EUR";

export type LedgerReportingErrorCode = "currency" | "client" | "period" | "amount";

/** Harde rapportagefout: de invoer kan niet veilig worden geaggregeerd. */
export class LedgerReportingError extends Error {
  readonly code: LedgerReportingErrorCode;
  constructor(code: LedgerReportingErrorCode, message: string) {
    super(message);
    this.name = "LedgerReportingError";
    this.code = code;
  }
}

// ── Geld: hele centen ───────────────────────────────────────────────────────

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * numeric(12,2) → hele centen, exact. Strings worden decimaal geparsed zonder
 * float-omweg; numbers zijn een float-weergave van een tweedecimaal getal en
 * worden met Math.round hersteld (0.29 * 100 = 28.999999… → 29).
 */
export function toCents(value: number | string): number {
  if (typeof value === "string") {
    const m = DECIMAL_RE.exec(value.trim());
    if (!m) throw new LedgerReportingError("amount", `Ongeldig bedrag: "${value}"`);
    const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
    // "+ 0" normaliseert -0 naar 0.
    return (m[1] ? -cents : cents) + 0;
  }
  if (!Number.isFinite(value)) {
    throw new LedgerReportingError("amount", `Ongeldig bedrag: ${String(value)}`);
  }
  return Math.round(value * 100) + 0;
}

/** Hele centen → number in euro's, voor weergave via de bestaande formatters. */
export function centsToAmount(cents: number): number {
  return cents / 100;
}

/** signed = debet − credit, in centen. Debet-positief, geen categorie-omklap. */
export function signedAmountCents(row: Pick<LedgerPostingLike, "debit_amount" | "credit_amount">): number {
  return toCents(row.debit_amount) - toCents(row.credit_amount);
}

// ── Periode: half-open [from, toExclusive) ──────────────────────────────────

export interface LedgerPeriod {
  /** Inclusief, ISO yyyy-mm-dd. */
  from: string;
  /** Exclusief, ISO yyyy-mm-dd. */
  toExclusive: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Echte kalenderdatum: vorm én bestaan (2027-02-30 en 2027-13-01 vallen af). */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function assertLedgerPeriod(period: LedgerPeriod): void {
  if (!isCalendarDate(period.from) || !isCalendarDate(period.toExclusive)) {
    throw new LedgerReportingError("period", "Periode moet uit bestaande ISO-datums (yyyy-mm-dd) bestaan");
  }
  if (!(period.from < period.toExclusive)) {
    throw new LedgerReportingError("period", "Periode: from moet vóór toExclusive liggen");
  }
}

/** Kalenderjaar als half-open periode, gelijk aan getLedgerYearRange. */
export function yearPeriod(year: number): LedgerPeriod {
  return { from: `${year}-01-01`, toExclusive: `${year + 1}-01-01` };
}

export function isBeforePeriod(postingDate: string, period: LedgerPeriod): boolean {
  return postingDate < period.from;
}

export function isInPeriod(postingDate: string, period: LedgerPeriod): boolean {
  return postingDate >= period.from && postingDate < period.toExclusive;
}

// ── Guards ──────────────────────────────────────────────────────────────────

/** EUR-only. Eén afwijkende rij maakt het hele rapport ongeldig. */
export function assertReportingCurrency(rows: readonly Pick<LedgerPostingLike, "id" | "currency">[]): void {
  const foreign = rows.filter((r) => r.currency !== REPORTING_CURRENCY);
  if (foreign.length > 0) {
    const codes = [...new Set(foreign.map((r) => r.currency))].sort().join(", ");
    throw new LedgerReportingError(
      "currency",
      `Rapportage ondersteunt alleen ${REPORTING_CURRENCY}; ${foreign.length} boeking(en) in ${codes} gevonden`,
    );
  }
}

/**
 * Het klantpredicaat is verplicht. RLS is organisatiebreed en vervangt het
 * niet; deze laag controleert dat nogmaals zodat een vergeten filter in de
 * query nooit stilletjes meerdere administraties optelt.
 */
export function assertSingleClient(
  rows: readonly Pick<LedgerPostingLike, "id" | "client_id">[],
  clientId: string,
): void {
  if (!clientId) throw new LedgerReportingError("client", "Rapportage vereist een administratie (client_id)");
  const foreign = rows.filter((r) => r.client_id !== clientId);
  if (foreign.length > 0) {
    throw new LedgerReportingError(
      "client",
      `${foreign.length} boeking(en) horen bij een andere administratie dan ${clientId}`,
    );
  }
}

// ── Rekeningclassificatie ───────────────────────────────────────────────────

export const KNOWN_LEDGER_CATEGORIES = ["activa", "passiva", "omzet", "kosten", "privé"] as const;
export type KnownLedgerCategory = (typeof KNOWN_LEDGER_CATEGORIES)[number];
export type LedgerAccountCategory = KnownLedgerCategory | "onbekend";

/**
 * Opgeslagen categorie → bekende waarde of "onbekend". De kolom is vrije tekst
 * zonder CHECK, dus alles wat niet exact een bekende waarde is, wordt zichtbaar
 * als onbekend gerapporteerd — nooit weggelaten.
 *
 * Let op: "privé" wordt herkend maar krijgt hier bewust GEEN plaats in een
 * balans of W&V. Die betekenis bestaat niet in het schema en is een besluit
 * van de eigenaar, niet van deze module.
 */
export function classifyLedgerCategory(raw: string | null | undefined): LedgerAccountCategory {
  const value = (raw ?? "").trim().toLowerCase();
  return (KNOWN_LEDGER_CATEGORIES as readonly string[]).includes(value)
    ? (value as KnownLedgerCategory)
    : "onbekend";
}

export interface LedgerAccountRef {
  id: string;
  /** null wanneer de rekening niet te herleiden is. */
  nummer: number | null;
  omschrijving: string;
  categorie: LedgerAccountCategory;
  /** null wanneer onbekend. Inactieve rekeningen blijven gewoon meetellen. */
  actief: boolean | null;
  resolved: boolean;
}

export const UNKNOWN_ACCOUNT_LABEL = "Onbekende rekening";

export function resolveLedgerAccount(
  accountId: string,
  accounts: readonly LedgerAccountLike[] | undefined,
): LedgerAccountRef {
  const account = accounts?.find((a) => a.id === accountId);
  if (!account) {
    return {
      id: accountId,
      nummer: null,
      omschrijving: UNKNOWN_ACCOUNT_LABEL,
      categorie: "onbekend",
      actief: null,
      resolved: false,
    };
  }
  return {
    id: account.id,
    nummer: account.nummer,
    omschrijving: account.omschrijving,
    categorie: classifyLedgerCategory(account.categorie),
    actief: account.actief ?? null,
    resolved: true,
  };
}

export function formatLedgerAccountLabel(account: LedgerAccountRef): string {
  return account.nummer === null ? account.omschrijving : `${account.nummer} - ${account.omschrijving}`;
}

// ── Volgorde ────────────────────────────────────────────────────────────────

/** Stabiele, volledige volgorde: posting_date, posting_group_id, line_no, id. */
export function compareLedgerRows(a: LedgerPostingLike, b: LedgerPostingLike): number {
  if (a.posting_date !== b.posting_date) return a.posting_date < b.posting_date ? -1 : 1;
  if (a.posting_group_id !== b.posting_group_id) return a.posting_group_id < b.posting_group_id ? -1 : 1;
  if (a.line_no !== b.line_no) return a.line_no - b.line_no;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

// ── Rekeningrollup (saldilijst / proef- en saldibalans) ─────────────────────

export interface LedgerAccountRollup {
  account: LedgerAccountRef;
  openingCents: number;
  periodDebitCents: number;
  periodCreditCents: number;
  /** opening + periodDebit − periodCredit. */
  closingCents: number;
  /** Aantal boekingsregels in de periode (niet ervoor). */
  periodLineCount: number;
}

export interface LedgerReportTotals {
  openingCents: number;
  periodDebitCents: number;
  periodCreditCents: number;
  closingCents: number;
  rowCount: number;
}

export type LedgerSelfCheckFailure =
  | { kind: "period_unbalanced"; periodDebitCents: number; periodCreditCents: number; differenceCents: number }
  | { kind: "opening_unbalanced"; openingCents: number }
  /** Eén boekingsgroep is op zichzelf niet in balans (bv. half opgehaald of half gedupliceerd). */
  | { kind: "group_unbalanced"; postingGroupId: string; differenceCents: number };

export type LedgerAccountReport =
  | { ok: true; rollups: LedgerAccountRollup[]; totals: LedgerReportTotals }
  | { ok: false; failures: LedgerSelfCheckFailure[]; totals: LedgerReportTotals };

export interface BuildAccountReportInput {
  rows: readonly LedgerPostingLike[];
  clientId: string;
  period: LedgerPeriod;
  accounts?: readonly LedgerAccountLike[];
  /** Standaard true: rekeningen met 0/0/0/0 blijven staan. */
  includeZeroAccounts?: boolean;
}

/**
 * Per rekening: beginsaldo, periodedebet, periodecredit, eindsaldo.
 *
 * Zelfcontrole, in centen: (1) elke boekingsgroep in de set is op zichzelf in
 * balans — dat is de invariant die de databasetrigger werkelijk garandeert,
 * en hij vangt een groep die door batchen half is opgehaald of half is
 * gedupliceerd; (2) over alle rekeningen Σ periodedebet = Σ periodecredit;
 * (3) Σ beginsaldo = 0. Faalt er één, dan geeft dit GEEN cijfers terug maar
 * een expliciet ongeldig resultaat.
 */
export function buildAccountReport(input: BuildAccountReportInput): LedgerAccountReport {
  const { rows, clientId, period, accounts, includeZeroAccounts = true } = input;
  assertLedgerPeriod(period);
  assertSingleClient(rows, clientId);
  assertReportingCurrency(rows);

  const byAccount = new Map<string, LedgerAccountRollup>();
  const rollupFor = (accountId: string): LedgerAccountRollup => {
    let r = byAccount.get(accountId);
    if (!r) {
      r = {
        account: resolveLedgerAccount(accountId, accounts),
        openingCents: 0,
        periodDebitCents: 0,
        periodCreditCents: 0,
        closingCents: 0,
        periodLineCount: 0,
      };
      byAccount.set(accountId, r);
    }
    return r;
  };

  let rowCount = 0;
  const groupNet = new Map<string, number>();
  for (const row of rows) {
    const inScope = isBeforePeriod(row.posting_date, period) || isInPeriod(row.posting_date, period);
    // Rijen op/na toExclusive tellen nergens mee.
    if (!inScope) continue;
    const signed = signedAmountCents(row);
    groupNet.set(row.posting_group_id, (groupNet.get(row.posting_group_id) ?? 0) + signed);
    if (isBeforePeriod(row.posting_date, period)) {
      rollupFor(row.grootboekrekening_id).openingCents += signed;
    } else {
      const r = rollupFor(row.grootboekrekening_id);
      r.periodDebitCents += toCents(row.debit_amount);
      r.periodCreditCents += toCents(row.credit_amount);
      r.periodLineCount++;
    }
    rowCount++;
  }

  const totals: LedgerReportTotals = {
    openingCents: 0,
    periodDebitCents: 0,
    periodCreditCents: 0,
    closingCents: 0,
    rowCount,
  };
  const rollups: LedgerAccountRollup[] = [];
  for (const r of byAccount.values()) {
    r.closingCents = r.openingCents + r.periodDebitCents - r.periodCreditCents;
    totals.openingCents += r.openingCents;
    totals.periodDebitCents += r.periodDebitCents;
    totals.periodCreditCents += r.periodCreditCents;
    totals.closingCents += r.closingCents;
    const isZero =
      r.openingCents === 0 && r.periodDebitCents === 0 && r.periodCreditCents === 0 && r.closingCents === 0;
    if (includeZeroAccounts || !isZero) rollups.push(r);
  }

  const failures: LedgerSelfCheckFailure[] = [];
  for (const [postingGroupId, net] of groupNet) {
    if (net !== 0) failures.push({ kind: "group_unbalanced", postingGroupId, differenceCents: net });
  }
  if (totals.periodDebitCents !== totals.periodCreditCents) {
    failures.push({
      kind: "period_unbalanced",
      periodDebitCents: totals.periodDebitCents,
      periodCreditCents: totals.periodCreditCents,
      differenceCents: totals.periodDebitCents - totals.periodCreditCents,
    });
  }
  if (totals.openingCents !== 0) {
    failures.push({ kind: "opening_unbalanced", openingCents: totals.openingCents });
  }
  if (failures.length > 0) return { ok: false, failures, totals };

  rollups.sort(compareAccountRollups);
  return { ok: true, rollups, totals };
}

/** Op rekeningnummer; onbekende rekeningen (zonder nummer) achteraan, dan op id. */
function compareAccountRollups(a: LedgerAccountRollup, b: LedgerAccountRollup): number {
  const an = a.account.nummer;
  const bn = b.account.nummer;
  if (an !== null && bn !== null && an !== bn) return an - bn;
  if (an === null && bn !== null) return 1;
  if (an !== null && bn === null) return -1;
  return a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0;
}

// ── Lopend saldo per rekening ───────────────────────────────────────────────

export interface LedgerRunningLine {
  row: LedgerPostingLike;
  debitCents: number;
  creditCents: number;
  signedCents: number;
  /** Debet-positief saldo ná deze regel. */
  balanceCents: number;
}

export interface LedgerRunningBalance {
  account: LedgerAccountRef;
  openingCents: number;
  lines: LedgerRunningLine[];
  closingCents: number;
}

export interface BuildRunningBalanceInput {
  rows: readonly LedgerPostingLike[];
  clientId: string;
  accountId: string;
  period: LedgerPeriod;
  accounts?: readonly LedgerAccountLike[];
}

/**
 * Chronologische mutaties van één rekening met lopend saldo, in de vaste
 * volgorde posting_date, posting_group_id, line_no, id — onafhankelijk van de
 * invoervolgorde.
 */
export function buildRunningBalance(input: BuildRunningBalanceInput): LedgerRunningBalance {
  const { rows, clientId, accountId, period, accounts } = input;
  assertLedgerPeriod(period);
  assertSingleClient(rows, clientId);
  // Valuta is een eigenschap van de hele set, niet van één rekening.
  assertReportingCurrency(rows);
  const own = rows.filter((r) => r.grootboekrekening_id === accountId);

  let openingCents = 0;
  const inPeriod: LedgerPostingLike[] = [];
  for (const row of own) {
    if (isBeforePeriod(row.posting_date, period)) openingCents += signedAmountCents(row);
    else if (isInPeriod(row.posting_date, period)) inPeriod.push(row);
  }
  inPeriod.sort(compareLedgerRows);

  let balance = openingCents;
  const lines: LedgerRunningLine[] = inPeriod.map((row) => {
    const debitCents = toCents(row.debit_amount);
    const creditCents = toCents(row.credit_amount);
    const signedCents = debitCents - creditCents;
    balance += signedCents;
    return { row, debitCents, creditCents, signedCents, balanceCents: balance };
  });

  return {
    account: resolveLedgerAccount(accountId, accounts),
    openingCents,
    lines,
    closingCents: balance,
  };
}

// ── Bron-drilldown ──────────────────────────────────────────────────────────

export type LedgerSourceLink =
  | { kind: "resolved"; sourceType: string; label: string; path: string }
  | { kind: "unresolved"; sourceType: string; label: string; reason: string };

/**
 * Bekende source_types → bestaande routes uit App.tsx. Alleen de inkoopwerkplek
 * heeft een per-document route; de andere landen op hun overzichtspagina.
 * Een onbekend source_type krijgt geen verzonnen route.
 */
export const LEDGER_SOURCE_LABELS: Readonly<Record<string, string>> = {
  purchase_invoice: "Inkoop",
  sales_invoice: "Verkoop",
  bank_allocation: "Bank",
  manual_journal: "Memoriaal",
  opening_balance: "Beginbalans",
};

/** Basisroute van de beginbalans; het doel-id gaat als queryparameter mee. */
export const OPENING_BALANCE_ROUTE = "/grootboek/beginbalans";
export const OPENING_BALANCE_TARGET_PARAM = "openingBalanceId";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Route naar de beginbalans van de administratie. Voor een
 * source_type = 'opening_balance'-rij is source_id de id van de kop
 * (public.opening_balances.id — zo schrijft post_opening_balance() hem, en de
 * claimtrigger dwingt dat af). Alleen een goedgevormde uuid gaat mee als
 * doel; anders landt de link op de pagina zelf, die onder RLS de
 * gezaghebbende toestand van de gekozen administratie toont.
 */
export function openingBalanceRoute(openingBalanceId: string | null | undefined): string {
  return isUuid(openingBalanceId)
    ? `${OPENING_BALANCE_ROUTE}?${OPENING_BALANCE_TARGET_PARAM}=${openingBalanceId}`
    : OPENING_BALANCE_ROUTE;
}

export function resolveLedgerSource(
  sourceType: string,
  sourceId: string | null | undefined,
): LedgerSourceLink {
  switch (sourceType) {
    case "opening_balance":
      return { kind: "resolved", sourceType, label: "Beginbalans", path: openingBalanceRoute(sourceId) };
    case "purchase_invoice":
      if (!sourceId) {
        return { kind: "unresolved", sourceType, label: "Inkoop", reason: "Inkoopfactuur zonder source_id" };
      }
      return { kind: "resolved", sourceType, label: "Inkoop", path: `/facturen/inkoop/${sourceId}` };
    case "sales_invoice":
      return { kind: "resolved", sourceType, label: "Verkoop", path: "/verkoop" };
    case "bank_allocation":
      return { kind: "resolved", sourceType, label: "Bank", path: "/bank" };
    case "manual_journal":
      return { kind: "resolved", sourceType, label: "Memoriaal", path: "/grootboek/memoriaal" };
    default:
      return {
        kind: "unresolved",
        sourceType,
        label: sourceType || "Onbekende bron",
        reason: `Onbekend brontype "${sourceType}"`,
      };
  }
}
