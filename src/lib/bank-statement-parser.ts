/**
 * Client-side parser for MT940 (SWIFT) and CAMT.053 (XML) bank statements.
 *
 * Nothing is dropped silently. A statement line that cannot be read becomes a
 * `StatementParseError` carrying the raw line, and `statementImportBlockers()`
 * blocks the import while there is one. The balances are checked per balance
 * section (MT940 :60F:/:60M: … :62F:/:62M:, CAMT.053 per <Stmt>): opening
 * balance plus every line read must equal the closing balance, otherwise a
 * line is missing or was misread and the import is blocked too.
 *
 * The fields that existed before (date, amount, reference, bank reference,
 * the statement-level balances and account IBAN) are produced exactly as
 * before for every line that was already readable, so duplicate detection and
 * the import fingerprints of earlier imports keep working.
 */

export type BankStatementSource = "mt940" | "camt053";

export interface ParsedTransaction {
  date: string; // YYYY-MM-DD
  amount: number;
  description: string;
  counterAccount: string | null;
  reference: string | null;
  /** Which parser produced this line; reference semantics differ per format. */
  source?: BankStatementSource;
  /**
   * The bank's own reference for this transaction, when the statement carries
   * one: MT940 the part after "//" in :61:, CAMT.053 <AcctSvcrRef>. Unique per
   * transaction at the bank and stable across re-exports.
   */
  bankReference?: string | null;
  /**
   * Value date (YYYY-MM-DD). MT940's :61: date is the value date; CAMT.053
   * leads with the booking date, so its <ValDt> is kept here. Used where the
   * same transaction must give the same key in both formats.
   */
  valueDate?: string;
  /** CAMT.053 Ustrd (unstructured remittance info) — only set for CAMT.053 sources. */
  ustrd?: string | null;
  /** CAMT.053 AddtlNtryInf (additional entry information) — only set for CAMT.053 sources. */
  addtlNtryInf?: string | null;
  /** CAMT.053 counterparty name from RltdPties (Dbtr/Cdtr <Nm>). */
  counterpartyName?: string | null;
  /**
   * A reversal (storno): MT940 RC/RD, CAMT.053 <RvslInd>. Only set when true.
   * The sign already is the economic direction of this booking (RC = money
   * out, RD = money in); a reversal undoes an earlier booking and is never
   * offered as the payment of an invoice.
   */
  isReversal?: boolean;
}

/** A statement line that could not be read. It is never left out silently. */
export interface StatementParseError {
  /** 1-based line in the file (MT940); null for CAMT.053. */
  lineNumber: number | null;
  /** The line exactly as in the file (MT940), or an excerpt of the entry (CAMT.053). */
  raw: string;
  reason: string;
}

/** One balance-bounded section: opening balance + Σ lines = closing balance. */
export interface StatementBalanceSection {
  /** The account of the section (IBAN where readable). */
  account: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  /** Sum of the amounts read in this section, in cents. */
  totalCents: number;
  transactionCount: number;
}

export interface ParsedStatement {
  openingBalance: number | null;
  closingBalance: number | null;
  accountIban: string | null;
  transactions: ParsedTransaction[];
  /** Lines that could not be read. The import is blocked while there is one. */
  errors: StatementParseError[];
  /** Balance sections, for the balance check per statement. */
  sections: StatementBalanceSection[];
  /** Every distinct account in the file (IBAN where readable, otherwise as written). */
  accounts: string[];
  /** Every ISO currency code in the file (balances, amounts, account). */
  currencies: string[];
  /** MT940 funds codes (the third letter of the currency, "R" for EUR) seen in :61:. */
  fundsCodes: string[];
  /**
   * CAMT entries that are not booked (<Sts> PDNG or INFO): no transaction and
   * not in the balance check, since the booked closing balance (CLBD) does not
   * contain them. Listed so the preview can say they were left out.
   */
  notBooked: StatementNotBookedEntry[];
}

export interface StatementNotBookedEntry {
  status: string;
  raw: string;
}

export interface DuplicateInfo {
  isDuplicate: boolean;
  /**
   * reference: same real reference, same amount, at most 4 days apart.
   * composite: same date, amount, description and counter account.
   * possible:  same date, amount and counter account, but a different text —
   *            typically an older row whose description was overwritten by a
   *            typed note. Deselected, so the user decides.
   */
  reason: "reference" | "composite" | "possible" | null;
}

// ─── Shared helpers ─────────────────────────────────────────────────

/** "1234" + "5" → 123450 cents. Null for more than two decimals that are not zero. */
function decimalToCents(intPart: string, fracPart: string): number | null {
  const frac = fracPart ?? "";
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) return null;
  const cents = Number(intPart) * 100 + Number(`${frac}00`.slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const IBAN_IN_TEXT = /([A-Z]{2}\d{2}[A-Z]{4}\d{10,})/;

function normalizeAccount(value: string | null | undefined): string | null {
  const v = (value ?? "").replace(/\s+/g, "").toUpperCase();
  return v || null;
}

function emptyStatement(): ParsedStatement {
  return {
    openingBalance: null,
    closingBalance: null,
    accountIban: null,
    transactions: [],
    errors: [],
    sections: [],
    accounts: [],
    currencies: [],
    fundsCodes: [],
    notBooked: [],
  };
}

const sortNewestFirst = (a: ParsedTransaction, b: ParsedTransaction) =>
  a.date < b.date ? 1 : a.date > b.date ? -1 : 0;

// ─── MT940 Parser ───────────────────────────────────────────────────
export function parseMT940(text: string): ParsedTransaction[] {
  return parseMT940Full(text).transactions;
}

const MT940_BALANCE_FULL = /^([CD])\d{6}([A-Z]{3})(\d+),(\d*)\s*$/;
const MT940_BALANCE_SHORT = /^([CD])(\d+),(\d*)\s*$/;

function parseMT940Balance(raw: string): { value: number; currency: string | null } | null {
  // Full format: C/DYYMMDDCCCAMOUNT (e.g. C240101EUR1234,56)
  const full = raw.match(MT940_BALANCE_FULL);
  // Short format without date/currency: C/DAMOUNT (e.g. C1234,56)
  const short = full ? null : raw.match(MT940_BALANCE_SHORT);
  const m = full ?? short;
  if (!m) return null;
  const cents = decimalToCents(full ? full[3] : short![2], full ? full[4] : short![3]);
  if (cents === null) return null;
  const sign = m[1] === "D" ? -1 : 1;
  return { value: (sign * cents) / 100, currency: full ? full[2] : null };
}

/**
 * SWIFT MT940 field 61, first line:
 *   value date YYMMDD · [entry (booking) date MMDD] · mark C | D | RC | RD ·
 *   [funds code: one letter, the third letter of the currency] · amount
 *   (digits, comma, decimals) · transaction type (e.g. N544, NTRF) · the
 *   account owner's reference [// the bank's reference].
 * RC is the reversal of a credit: economically a debit, so negative. RD is
 * the reversal of a debit: a credit, so positive.
 */
const MT940_STATEMENT_LINE = /^(\d{2})(\d{2})(\d{2})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+),(\d*)(.*)$/;

type Mt940LineResult =
  | { tx: ParsedTransaction; cents: number; fundsCode: string | null }
  | { error: string };

function parseMT940Transaction(raw: string, lines: string[], lineIdx: number): Mt940LineResult {
  const m = raw.match(MT940_STATEMENT_LINE);
  if (!m) {
    return {
      error:
        "Regel niet herkend: verwacht valutadatum (JJMMDD), optioneel boekdatum (MMDD), D/C/RC/RD, optioneel een fondscode en een bedrag met komma",
    };
  }
  const [, yy, mm, dd, entry, mark, fundsCode, intPart, fracPart, rest] = m;
  const year = 2000 + Number(yy);
  const date = isoDate(year, Number(mm), Number(dd));
  if (!date) return { error: `Ongeldige valutadatum ${yy}${mm}${dd}` };
  if (entry) {
    const em = Number(entry.slice(0, 2));
    const ed = Number(entry.slice(2, 4));
    // The booking date can fall in the next or previous year (31-12 / 2-1).
    const vm = Number(mm);
    const entryYear = em < vm - 6 ? year + 1 : em > vm + 6 ? year - 1 : year;
    if (!isoDate(entryYear, em, ed)) return { error: `Ongeldige boekdatum ${entry}` };
  }
  const cents = decimalToCents(intPart, fracPart);
  if (cents === null) return { error: `Bedrag ${intPart},${fracPart} niet leesbaar (meer dan twee decimalen)` };
  // C and RD are money in; D and RC are money out.
  const sign = mark === "C" || mark === "RD" ? 1 : -1;
  const signedCents = sign * cents;
  const amount = signedCents / 100;

  let pos = 0;
  const typeMatch = rest.match(/^[A-Z]\d{3}/);
  if (typeMatch) pos += 4;
  const reference = rest.substring(pos).trim() || null;

  let description = "";
  let counterAccount: string | null = null;
  let j = lineIdx + 1;
  while (j < lines.length) {
    const currentLine = lines[j];
    if (currentLine.startsWith(":86:")) {
      description = currentLine.substring(4);
      j++;
      while (j < lines.length && lines[j] && !lines[j].startsWith(":")) {
        description += " " + lines[j];
        j++;
      }
      break;
    } else if (!currentLine.startsWith(":")) {
      j++;
    } else {
      break;
    }
  }

  const ibanMatch = description.match(IBAN_IN_TEXT);
  if (ibanMatch) counterAccount = ibanMatch[1];

  const cntpMatch = description.match(/\/CNTP\/([^/]+)/);
  if (cntpMatch) counterAccount = cntpMatch[1];

  const tail = reference?.indexOf("//") ?? -1;
  const bankReference = reference && tail >= 0 ? reference.slice(tail + 2).trim() || null : null;

  const tx: ParsedTransaction = {
    date,
    amount,
    description: description.trim() || "Geen omschrijving",
    counterAccount,
    reference,
    source: "mt940",
    bankReference,
    valueDate: date,
  };
  if (mark === "RC" || mark === "RD") tx.isReversal = true;
  return { tx, cents: signedCents, fundsCode: fundsCode ?? null };
}

function parseMT940Full(text: string): ParsedStatement {
  const result = emptyStatement();
  const currencies = new Set<string>();
  const fundsCodes = new Set<string>();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // The account of the current message, and the balance section being read.
  const state: { account: string | null; open: StatementBalanceSection | null } = { account: null, open: null };

  const openSection = (openingBalance: number | null): StatementBalanceSection => {
    const section: StatementBalanceSection = {
      account: state.account,
      openingBalance,
      closingBalance: null,
      totalCents: 0,
      transactionCount: 0,
    };
    state.open = section;
    return section;
  };
  const closeSection = () => {
    if (state.open) result.sections.push(state.open);
    state.open = null;
  };
  const fail = (index: number, reason: string) =>
    result.errors.push({ lineNumber: index + 1, raw: lines[index], reason });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith(":20:")) {
      // A new message: a section still open there has no closing balance.
      closeSection();
      state.account = null;
      continue;
    }

    if (line.startsWith(":25:")) {
      const field = line.substring(4).trim();
      const ibanMatch = field.match(IBAN_IN_TEXT);
      // The statement-level IBAN stays the first one found, as before.
      if (!result.accountIban && ibanMatch) result.accountIban = ibanMatch[1];
      state.account = normalizeAccount(ibanMatch ? ibanMatch[1] : field);
      if (state.account && !result.accounts.includes(state.account)) result.accounts.push(state.account);
      continue;
    }

    if (line.startsWith(":60F:") || line.startsWith(":60M:")) {
      const bal = parseMT940Balance(line.substring(5));
      if (result.openingBalance === null && bal) result.openingBalance = bal.value;
      if (bal?.currency) currencies.add(bal.currency);
      if (!bal) fail(i, "Beginsaldo niet leesbaar");
      // A new opening balance starts a new section; one still open lacks its closing balance.
      closeSection();
      openSection(bal ? bal.value : null);
      continue;
    }

    if (line.startsWith(":62F:") || line.startsWith(":62M:")) {
      const bal = parseMT940Balance(line.substring(5));
      result.closingBalance = bal ? bal.value : null;
      if (bal?.currency) currencies.add(bal.currency);
      if (!bal) fail(i, "Eindsaldo niet leesbaar");
      const section = state.open ?? openSection(null);
      section.closingBalance = bal ? bal.value : null;
      closeSection();
      continue;
    }

    if (line.startsWith(":61:")) {
      const parsed = parseMT940Transaction(line.substring(4), lines, i);
      const section = state.open ?? openSection(null);
      if ("error" in parsed) {
        fail(i, parsed.error);
        continue;
      }
      result.transactions.push(parsed.tx);
      section.totalCents += parsed.cents;
      section.transactionCount++;
      if (parsed.fundsCode) fundsCodes.add(parsed.fundsCode);
    }
  }
  closeSection();

  // Sort by date descending (YYYY-MM-DD strings compare correctly)
  result.transactions.sort(sortNewestFirst);
  result.currencies = [...currencies];
  result.fundsCodes = [...fundsCodes];
  return result;
}

// ─── CAMT.053 Parser ────────────────────────────────────────────────
export function parseCAMT053(xmlText: string): ParsedTransaction[] {
  return parseCAMT053Full(xmlText).transactions;
}

function directChildren(parent: Element, localName: string): Element[] {
  return Array.from(parent.children).filter((el) => el.localName === localName);
}

function directChild(parent: Element | null | undefined, localName: string): Element | null {
  if (!parent) return null;
  return directChildren(parent, localName)[0] ?? null;
}

function directText(parent: Element | null | undefined, ...path: string[]): string {
  let el: Element | null = parent ?? null;
  for (const name of path) el = directChild(el, name);
  return (el?.textContent ?? "").trim();
}

/** A short, single-line excerpt of an element, to show which entry could not be read. */
function excerpt(el: Element): string {
  const xml = typeof XMLSerializer !== "undefined" ? new XMLSerializer().serializeToString(el) : el.textContent ?? "";
  const flat = xml.replace(/\s+/g, " ").replace(/ xmlns="[^"]*"/g, "").trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

const CAMT_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

function camtCents(text: string): number | null {
  const m = text.trim().match(CAMT_AMOUNT);
  return m ? decimalToCents(m[1], m[2] ?? "") : null;
}

function camtDate(el: Element | null): string | null {
  const dt = directText(el, "Dt") || directText(el, "DtTm").slice(0, 10);
  const m = dt.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? isoDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

function parseCAMT053Full(xmlText: string): ParsedStatement {
  const result = emptyStatement();
  const currencies = new Set<string>();
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    result.errors.push({ lineNumber: null, raw: xmlText.slice(0, 200), reason: "Het XML-bestand kan niet worden gelezen" });
    return result;
  }

  const ns = doc.documentElement.namespaceURI || "";
  const byTag = (parent: Document | Element, tag: string) =>
    Array.from(ns ? parent.getElementsByTagNameNS(ns, tag) : parent.getElementsByTagName(tag));

  const statements = byTag(doc, "Stmt");
  if (statements.length === 0) {
    result.errors.push({
      lineNumber: null,
      raw: excerpt(doc.documentElement),
      reason: "Geen <Stmt> gevonden: dit is geen CAMT.053-rekeningafschrift",
    });
  }

  let entriesInStatements = 0;
  for (const stmt of statements) {
    const acct = directChild(stmt, "Acct");
    const iban = directText(acct, "Id", "IBAN");
    const account = normalizeAccount(iban || directText(acct, "Id", "Othr", "Id"));
    if (account && !result.accounts.includes(account)) result.accounts.push(account);
    // The statement-level IBAN: the account of the first statement, as before.
    if (result.accountIban === null && iban) result.accountIban = iban;
    const accountCurrency = directText(acct, "Ccy");
    if (accountCurrency) currencies.add(accountCurrency);

    const section: StatementBalanceSection = {
      account,
      openingBalance: null,
      closingBalance: null,
      totalCents: 0,
      transactionCount: 0,
    };
    let openingIsOpbd = false;
    for (const bal of directChildren(stmt, "Bal")) {
      const code = directText(bal, "Tp", "CdOrPrtry", "Cd");
      if (code !== "OPBD" && code !== "PRCD" && code !== "CLBD") continue;
      const amtEl = directChild(bal, "Amt");
      const cents = amtEl ? camtCents(amtEl.textContent ?? "") : null;
      const indicator = directText(bal, "CdtDbtInd");
      if (cents === null || (indicator !== "CRDT" && indicator !== "DBIT")) {
        result.errors.push({ lineNumber: null, raw: excerpt(bal), reason: `Saldo ${code} niet leesbaar` });
        continue;
      }
      const currency = amtEl?.getAttribute("Ccy")?.trim();
      if (currency) currencies.add(currency);
      const value = (indicator === "DBIT" ? -cents : cents) / 100;
      if (code === "OPBD") {
        // As before, the statement-level opening balance is the first OPBD.
        if (result.openingBalance === null) result.openingBalance = value;
        if (!openingIsOpbd) section.openingBalance = value;
        openingIsOpbd = true;
      } else if (code === "PRCD") {
        // "Previously closed booked": the opening balance of banks that do not send OPBD.
        if (section.openingBalance === null) section.openingBalance = value;
      } else {
        section.closingBalance = value;
        result.closingBalance = value;
      }
    }

    const entries = byTag(stmt, "Ntry");
    entriesInStatements += entries.length;
    for (const entry of entries) {
      // Only booked entries are bank transactions. A pending (PDNG) or
      // information-only (INFO) entry is not in the booked balances: counting
      // it reported a balance difference of exactly its amount, and importing
      // it would book a movement the bank has not booked (review P2-4).
      // camt.053.001.02 has <Sts>BOOK</Sts>, later versions <Sts><Cd>BOOK</Cd></Sts>;
      // without <Sts> the entry counts as booked, as before.
      const status = directText(entry, "Sts").toUpperCase();
      if (status && status !== "BOOK") {
        result.notBooked.push({ status, raw: excerpt(entry) });
        continue;
      }
      const parsed = parseCAMTEntry(entry, ns);
      if ("error" in parsed) {
        result.errors.push({ lineNumber: null, raw: excerpt(entry), reason: parsed.error });
        continue;
      }
      result.transactions.push(parsed.tx);
      section.totalCents += parsed.cents;
      section.transactionCount++;
      if (parsed.currency) currencies.add(parsed.currency);
    }
    result.sections.push(section);
  }

  const strays = byTag(doc, "Ntry").length - entriesInStatements;
  if (strays > 0) {
    result.errors.push({
      lineNumber: null,
      raw: `${strays} <Ntry>`,
      reason: `${strays} ${strays === 1 ? "boeking staat" : "boekingen staan"} buiten een <Stmt> en ${strays === 1 ? "kan" : "kunnen"} niet aan een rekening worden toegewezen`,
    });
  }

  result.transactions.sort(sortNewestFirst);
  result.currencies = [...currencies];
  return result;
}

function getTextNS(parent: Element, ns: string, tag: string): string {
  const els = ns
    ? parent.getElementsByTagNameNS(ns, tag)
    : parent.getElementsByTagName(tag);
  return els.length > 0 ? (els[0].textContent || "") : "";
}

type CamtEntryResult = { tx: ParsedTransaction; cents: number; currency: string | null } | { error: string };

function parseCAMTEntry(entry: Element, ns: string): CamtEntryResult {
  const amtEl = directChild(entry, "Amt");
  if (!amtEl) return { error: "Bedrag (<Amt>) ontbreekt" };
  const amountText = (amtEl.textContent ?? "").trim();
  const cents = camtCents(amountText);
  if (cents === null) return { error: `Bedrag "${amountText}" niet leesbaar` };

  // ISO 20022: CdtDbtInd is the direction of THIS booking, also for a
  // reversal (RvslInd): a reversed debit is booked CRDT, a reversed credit DBIT.
  const indicator = directText(entry, "CdtDbtInd");
  if (indicator !== "CRDT" && indicator !== "DBIT") {
    return {
      error: indicator
        ? `Onbekende debet/credit-aanduiding "${indicator}"`
        : "Debet/credit-aanduiding (<CdtDbtInd>) ontbreekt",
    };
  }
  const signedCents = indicator === "DBIT" ? -cents : cents;
  const reversal = directText(entry, "RvslInd").toLowerCase();
  const isReversal = reversal === "true" || reversal === "1";

  let dateStr = "";
  const bookgDt = ns ? entry.getElementsByTagNameNS(ns, "BookgDt") : entry.getElementsByTagName("BookgDt");
  if (bookgDt.length) {
    dateStr = getTextNS(bookgDt[0] as Element, ns, "Dt");
  }
  if (!dateStr) {
    const valDt = ns ? entry.getElementsByTagNameNS(ns, "ValDt") : entry.getElementsByTagName("ValDt");
    if (valDt.length) dateStr = getTextNS(valDt[0] as Element, ns, "Dt");
  }
  // Booking or value date given as a timestamp only (<DtTm>): read, no longer dropped.
  if (!dateStr) dateStr = camtDate(directChild(entry, "BookgDt")) ?? camtDate(directChild(entry, "ValDt")) ?? "";
  dateStr = dateStr.trim();
  if (!dateStr) return { error: "Boek- en valutadatum ontbreken" };
  const dm = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm || !isoDate(Number(dm[1]), Number(dm[2]), Number(dm[3]))) return { error: `Ongeldige datum "${dateStr}"` };
  const valDtEls = ns ? entry.getElementsByTagNameNS(ns, "ValDt") : entry.getElementsByTagName("ValDt");
  const valueDate = (valDtEls.length ? getTextNS(valDtEls[0] as Element, ns, "Dt") : "") || dateStr;

  const addtlNtryInf = getTextNS(entry, ns, "AddtlNtryInf") || null;
  const ustrd = getTextNS(entry, ns, "Ustrd") || null;

  // Counterparty name from RltdPties (Dbtr/Cdtr <Nm>)
  let counterpartyName: string | null = null;
  const rltdPties = ns
    ? entry.getElementsByTagNameNS(ns, "RltdPties")
    : entry.getElementsByTagName("RltdPties");
  for (let i = 0; i < rltdPties.length && !counterpartyName; i++) {
    const partyTags = ["Dbtr", "Cdtr", "UltmtDbtr", "UltmtCdtr"];
    for (const tag of partyTags) {
      const partyEls = ns
        ? (rltdPties[i] as Element).getElementsByTagNameNS(ns, tag)
        : (rltdPties[i] as Element).getElementsByTagName(tag);
      if (partyEls.length) {
        const nm = getTextNS(partyEls[0] as Element, ns, "Nm");
        if (nm) {
          counterpartyName = nm;
          break;
        }
      }
    }
  }

  const description = addtlNtryInf || ustrd || counterpartyName || "Geen omschrijving";

  let counterAccount: string | null = null;
  const ibanEl = ns ? entry.getElementsByTagNameNS(ns, "IBAN") : entry.getElementsByTagName("IBAN");
  if (ibanEl.length) counterAccount = ibanEl[0].textContent || null;

  let reference: string | null = null;
  const refEl = ns ? entry.getElementsByTagNameNS(ns, "EndToEndId") : entry.getElementsByTagName("EndToEndId");
  if (refEl.length && refEl[0].textContent !== "NOTPROVIDED") {
    reference = refEl[0].textContent;
  }
  const bankReference = getTextNS(entry, ns, "AcctSvcrRef").trim() || null;

  const tx: ParsedTransaction = {
    date: dateStr,
    amount: signedCents / 100,
    description,
    counterAccount,
    reference,
    source: "camt053",
    bankReference,
    valueDate,
    ustrd,
    addtlNtryInf,
    counterpartyName,
  };
  if (isReversal) tx.isReversal = true;
  return { tx, cents: signedCents, currency: amtEl.getAttribute("Ccy")?.trim() || null };
}

// ─── Import checks ──────────────────────────────────────────────────
//
// Pure: they decide whether a parsed statement may be imported at all, and
// against which administratie. The upload dialog blocks on every blocker and
// asks an explicit confirmation when the account cannot be tied to the
// chosen administratie.

/** The only currency BoekAssist books: bank_transactions has no currency column and every writer posts EUR. */
export const STATEMENT_CURRENCY = "EUR";
/** The MT940 funds code of EUR (the third letter of the currency code). */
const EUR_FUNDS_CODE = "R";

export interface StatementImportBlocker {
  kind: "unreadable" | "balance" | "currency" | "accounts" | "administration";
  message: string;
  /** One line per affected statement line or section, shown to the user. */
  details: string[];
}

const euro = (cents: number) =>
  new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(cents / 100);
const toCents = (value: number) => Math.round(value * 100);

/** Everything that blocks importing this statement. Empty: importable. */
export function statementImportBlockers(statement: ParsedStatement): StatementImportBlocker[] {
  const blockers: StatementImportBlocker[] = [];

  if (statement.errors.length > 0) {
    const n = statement.errors.length;
    blockers.push({
      kind: "unreadable",
      message:
        `${n} ${n === 1 ? "regel uit het afschrift kon" : "regels uit het afschrift konden"} niet worden gelezen. ` +
        "Importeren is geblokkeerd: een overgeslagen regel is een ontbrekende of verkeerde bankmutatie. " +
        "Controleer het bestand of vraag een nieuw afschrift op bij de bank.",
      details: statement.errors.map(
        (e) => `${e.lineNumber !== null ? `Regel ${e.lineNumber}: ` : ""}${e.raw} — ${e.reason}`,
      ),
    });
  }

  const balanceDetails: string[] = [];
  statement.sections.forEach((s, index) => {
    if (s.transactionCount === 0 && s.openingBalance === null && s.closingBalance === null) return;
    const label = `Afschrift ${index + 1}${s.account ? ` (${s.account})` : ""}`;
    if (s.openingBalance === null || s.closingBalance === null) {
      const missing = s.openingBalance === null && s.closingBalance === null
        ? "begin- en eindsaldo ontbreken"
        : s.openingBalance === null ? "het beginsaldo ontbreekt" : "het eindsaldo ontbreekt";
      balanceDetails.push(`${label}: ${missing}, dus de volledigheid van de ${s.transactionCount} gelezen regel(s) is niet te controleren.`);
      return;
    }
    const opening = toCents(s.openingBalance);
    const closing = toCents(s.closingBalance);
    const expected = opening + s.totalCents;
    if (expected !== closing) {
      balanceDetails.push(
        `${label}: beginsaldo ${euro(opening)} + ${s.transactionCount} mutatie(s) ${euro(s.totalCents)} = ${euro(expected)}, ` +
          `maar het eindsaldo is ${euro(closing)} (verschil ${euro(closing - expected)}).`,
      );
    }
  });
  if (balanceDetails.length > 0) {
    blockers.push({
      kind: "balance",
      message:
        "De saldocontrole klopt niet: beginsaldo plus de gelezen mutaties is niet het eindsaldo. " +
        "Er ontbreken regels of er zijn regels verkeerd gelezen; importeren is geblokkeerd.",
      details: balanceDetails,
    });
  }

  const foreign = statement.currencies.filter((c) => c.toUpperCase() !== STATEMENT_CURRENCY);
  const foreignFunds = statement.fundsCodes.filter((f) => f !== EUR_FUNDS_CODE);
  if (foreign.length > 0 || foreignFunds.length > 0) {
    const found = [...foreign, ...foreignFunds.map((f) => `fondscode ${f}`)].join(", ");
    blockers.push({
      kind: "currency",
      message: `Het afschrift is niet (alleen) in euro (${found}). BoekAssist verwerkt alleen EUR; importeren is geblokkeerd.`,
      details: [],
    });
  } else if (statement.currencies.length === 0 && statement.transactions.length > 0) {
    blockers.push({
      kind: "currency",
      message:
        "De valuta van het afschrift is onbekend: geen saldo of bedrag noemt een valuta. " +
        "BoekAssist verwerkt alleen EUR; importeren is geblokkeerd.",
      details: [],
    });
  }

  if (statement.accounts.length > 1) {
    blockers.push({
      kind: "accounts",
      message:
        `Het bestand bevat afschriften van ${statement.accounts.length} rekeningen (${statement.accounts.join(", ")}). ` +
        "Importeer per rekening, zodat elke regel in de juiste administratie komt.",
      details: [],
    });
  }

  return blockers;
}

export interface StatementAccountClient {
  id: string;
  name: string;
  ibans?: string[] | null;
}

/**
 *  match:                the account is a registered IBAN of the chosen administratie (and of no other);
 *  other_administration: the account is registered for another administratie only — blocked;
 *  confirm:              the account cannot be tied to the chosen administratie — import only
 *                        after an explicit confirmation by the user.
 */
export type StatementAccountCheck =
  | { status: "match"; iban: string }
  | { status: "other_administration"; iban: string; administrations: string[] }
  | {
      status: "confirm";
      iban: string | null;
      reason: "no_statement_iban" | "no_client_iban" | "different_iban" | "shared_iban";
      administrations: string[];
    };

export function normalizeIban(value: string | null | undefined): string {
  return (value ?? "").replace(/\s/g, "").toUpperCase();
}

export function checkStatementAccount(
  statement: Pick<ParsedStatement, "accountIban">,
  importClient: StatementAccountClient,
  clients: readonly StatementAccountClient[],
): StatementAccountCheck {
  const iban = normalizeIban(statement.accountIban);
  if (!iban) return { status: "confirm", iban: null, reason: "no_statement_iban", administrations: [] };
  const holds = (c: StatementAccountClient) => (c.ibans ?? []).some((i) => normalizeIban(i) === iban);
  const others = clients.filter((c) => c.id !== importClient.id && holds(c)).map((c) => c.name);
  if (holds(importClient)) {
    return others.length > 0
      ? { status: "confirm", iban, reason: "shared_iban", administrations: others }
      : { status: "match", iban };
  }
  if (others.length > 0) return { status: "other_administration", iban, administrations: others };
  const reason = (importClient.ibans ?? []).some((i) => normalizeIban(i)) ? "different_iban" : "no_client_iban";
  return { status: "confirm", iban, reason, administrations: [] };
}

/** The account belongs to another administratie of the organisation: never import it here. */
export function accountCheckBlocker(check: StatementAccountCheck, importClientName: string): StatementImportBlocker | null {
  if (check.status !== "other_administration") return null;
  const names = check.administrations.join(", ");
  return {
    kind: "administration",
    message:
      `Rekening ${check.iban} hoort bij ${names}, niet bij ${importClientName}. ` +
      `Importeer dit afschrift bij ${check.administrations.length === 1 ? "die administratie" : "de juiste administratie"}.`,
    details: [],
  };
}

// ─── Bank description ───────────────────────────────────────────────
/** What the parsers store when a statement line carries no text at all. */
export const NO_BANK_DESCRIPTION = "Geen omschrijving";

/**
 * Whether the imported bank text says anything. Only then is it the audit
 * source that must never be overwritten by a typed note.
 */
export function hasBankDescription(description: string | null | undefined): boolean {
  const trimmed = (description ?? "").trim();
  return trimmed.length > 0 && trimmed !== NO_BANK_DESCRIPTION;
}

// ─── Auto-detect format ─────────────────────────────────────────────
// Backward-compatible: returns ParsedTransaction[] only
export function parseBankStatement(content: string): ParsedTransaction[] {
  const trimmed = content.trim();
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<Document") || trimmed.startsWith("<document")) {
    return parseCAMT053(trimmed);
  }
  return parseMT940(trimmed);
}

// Full version: returns balances + sorted transactions
export function parseBankStatementFull(content: string): ParsedStatement {
  const trimmed = content.trim();
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<Document") || trimmed.startsWith("<document")) {
    return parseCAMT053Full(trimmed);
  }
  return parseMT940Full(trimmed);
}

// ─── Duplicate detection ────────────────────────────────────────────
//
// bank_transactions only carries a database guarantee for rows imported with
// an import fingerprint (20261020120000); this check is what stands between a
// re-imported statement and a second copy of every older transaction (each of
// which could then be posted again). It must therefore be neither too loose
// (missing a duplicate) nor too strict (silently deselecting a genuine new
// transaction).

/**
 * Bank placeholders that mean "no reference". MT940 uses NONREF in :61: when
 * the account owner gave no reference (standard at Rabobank, ING, ABN AMRO);
 * CAMT.053 uses NOTPROVIDED for a missing EndToEndId. They are shared by many
 * unrelated transactions, so they can never identify one.
 */
const PLACEHOLDER_REFERENCES = new Set(["NONREF", "NOTPROVIDED", "NOT PROVIDED", "NOTPROVIDED."]);

/**
 * The MT940 parser only strips type codes shaped like N544; ING-style codes
 * (NTRF, NDDT, NMSC, …) stay glued to the account owner's reference, as in
 * "NTRFNONREF" or "NTRFABC123". In MT940 that position is the type code by
 * definition, so it is removed there — and only there. A CAMT.053 EndToEndId
 * is the payer's own text and is never shortened.
 */
const SWIFT_TYPE_CODES =
  "BNK|BOE|BRF|CHG|CHK|CLR|CMI|CMN|CMP|CMS|CMT|CMZ|COL|COM|CPN|DCR|DDT|DIV|EQA|EXT|FEX|INT|LBX|LDP|MAR|MAT|MGT|MSC|NWI|ODC|OPT|PCH|POP|PRN|REC|RED|RIG|RTI|SAL|SEC|SLE|STO|STP|SUB|SWP|TAX|TCK|TCM|TRA|TRF|TRN|UWC|VDA|WAR";
const MT940_LETTER_TYPE_CODE = new RegExp(`^N(?:${SWIFT_TYPE_CODES})(?=.)`);

/** Where a reference came from. "unknown": a stored row with no format marker. */
export type ReferenceSource = BankStatementSource | "unknown";

/**
 * Everything that can identify one transaction by reference.
 *   bank:   the bank's own reference (MT940 "//" tail, CAMT <AcctSvcrRef>).
 *           Unique per transaction; two different ones prove two transactions.
 *   owners: the account owner's / payer's reference in comparable form. Two
 *           candidates only for an "unknown" stored row (as written, and with
 *           an MT940 type code removed), so historical rows still match.
 */
export interface ReferenceIds {
  bank: string | null;
  owners: string[];
}

function core(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

function ownerCandidate(value: string): string | null {
  return value && !PLACEHOLDER_REFERENCES.has(value) ? value : null;
}

function stripMt940TypeCode(value: string): string {
  return MT940_LETTER_TYPE_CODE.test(value) ? value.slice(4) : value;
}

export function referenceIdsFor(input: {
  reference: string | null | undefined;
  source?: ReferenceSource;
  bankReference?: string | null;
}): ReferenceIds {
  const source = input.source ?? "unknown";
  const raw = core(input.reference);
  const tail = raw.indexOf("//");
  const ownerPart = tail >= 0 ? raw.slice(0, tail) : raw;
  const tailRef = tail >= 0 ? raw.slice(tail + 2) : "";
  const bankCandidate = core(input.bankReference) || (source !== "camt053" ? tailRef : "");
  const bank = bankCandidate && !PLACEHOLDER_REFERENCES.has(bankCandidate) ? bankCandidate : null;

  const owners = new Set<string>();
  const add = (v: string | null) => {
    if (v) owners.add(v);
  };
  if (source === "camt053") {
    add(ownerCandidate(ownerPart));
  } else if (source === "mt940") {
    const owner = ownerCandidate(ownerPart);
    if (owner) add(ownerCandidate(stripMt940TypeCode(owner)));
  } else {
    // A stored row without "//" and without CAMT fields: its format is not
    // recorded. Accept both readings, so a statement imported before this
    // change is still recognised on re-import.
    const owner = ownerCandidate(ownerPart);
    if (owner) {
      add(owner);
      add(ownerCandidate(stripMt940TypeCode(owner)));
    }
  }
  return { bank, owners: [...owners] };
}

/** The MT940 account-owner reference in comparable form (null for none/placeholder). */
export function identifyingBankReference(reference: string | null | undefined): string | null {
  return referenceIdsFor({ reference, source: "mt940" }).owners[0] ?? null;
}

/**
 * Safety net: a bank reference only identifies a transaction if it is unique.
 * Should one appear more than once within the same list (a bank that writes a
 * constant after "//", or historical double imports), it is not used as a key
 * for those rows — they fall back to the weaker evidence instead of making
 * different transactions equal.
 */
function withoutRepeatedBankReferences(list: ReferenceIds[]): ReferenceIds[] {
  const counts = new Map<string, number>();
  for (const ids of list) if (ids.bank) counts.set(ids.bank, (counts.get(ids.bank) ?? 0) + 1);
  return list.map((ids) => (ids.bank && (counts.get(ids.bank) ?? 0) > 1 ? { ...ids, bank: null } : ids));
}

/**
 * Whether the bank references of one incoming statement may be trusted as
 * unique keys at all. A single repeat within the statement, or a reference
 * already stored for this administratie with a different amount, shows that
 * this bank does not write unique references — then none of the statement's
 * bank references is used (one line appearing once in a file proves nothing).
 */
function statementTrustsBankReferences(
  incoming: { ids: ReferenceIds; amount: number }[],
  stored: { ids: ReferenceIds; amount: number }[],
): boolean {
  const seen = new Set<string>();
  for (const { ids } of incoming) {
    if (!ids.bank) continue;
    if (seen.has(ids.bank)) return false;
    seen.add(ids.bank);
  }
  const storedAmounts = new Map<string, Set<string>>();
  for (const { ids, amount } of stored) {
    if (!ids.bank) continue;
    const set = storedAmounts.get(ids.bank) ?? new Set<string>();
    set.add(amount.toFixed(2));
    storedAmounts.set(ids.bank, set);
  }
  for (const { ids, amount } of incoming) {
    if (!ids.bank) continue;
    const amounts = storedAmounts.get(ids.bank);
    if (amounts && (amounts.size > 1 || !amounts.has(amount.toFixed(2)))) return false;
  }
  return true;
}

function storedReferenceIds(existing: readonly ExistingBankTransactionForDuplicates[]): ReferenceIds[] {
  return existing.map((ex) =>
    referenceIdsFor({ reference: ex.reference, source: storedReferenceSource(ex), bankReference: ex.bank_reference }),
  );
}

function incomingReferenceIds(
  incoming: readonly ParsedTransaction[],
  existing: readonly ExistingBankTransactionForDuplicates[],
  existingIds: readonly ReferenceIds[],
): ReferenceIds[] {
  const ids = incoming.map((tx) =>
    referenceIdsFor({ reference: tx.reference, source: tx.source ?? "unknown", bankReference: tx.bankReference }),
  );
  const trusted = statementTrustsBankReferences(
    incoming.map((tx, i) => ({ ids: ids[i], amount: tx.amount })),
    existing.map((ex, i) => ({ ids: existingIds[i], amount: ex.amount })),
  );
  return trusted ? ids : ids.map((r) => ({ ...r, bank: null }));
}

function sameReference(a: ReferenceIds, b: ReferenceIds): "bank" | "owner" | null {
  if (a.bank && b.bank) return a.bank === b.bank ? "bank" : null;
  return a.owners.some((o) => b.owners.includes(o)) ? "owner" : null;
}

/** Two different real references prove two different transactions. */
function differentReferences(a: ReferenceIds, b: ReferenceIds): boolean {
  if (a.bank && b.bank) return a.bank !== b.bank;
  if (a.owners.length > 0 && b.owners.length > 0) return !a.owners.some((o) => b.owners.includes(o));
  return false;
}

function compositeKey(
  date: string,
  amount: number,
  description: string | null,
  counterAccount: string | null
): string {
  const normDesc = (description || "").trim().toLowerCase().slice(0, 50);
  const normAcct = (counterAccount || "").trim().toLowerCase();
  return `${date}|${amount.toFixed(2)}|${normDesc}|${normAcct}`;
}

/**
 * An account owner's reference only proves a duplicate together with the same
 * amount and a date close by: value date and booking date can differ by a
 * weekend, and a direct debit can carry the same contract number every week.
 * The bank's own reference needs no window: it is unique per transaction.
 */
const REFERENCE_DATE_WINDOW_DAYS = 4;

function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Number.isFinite(ms) ? ms / 86_400_000 : Number.POSITIVE_INFINITY;
}

/**
 * Only with a counter account on both sides: without one, "possible" would
 * shrink to date + amount and drop a second, different card payment of the
 * same amount on the same day.
 */
function possibleKey(date: string, amount: number, counterAccount: string | null): string | null {
  const account = (counterAccount || "").replace(/\s/g, "").toLowerCase();
  return account ? `${date}|${amount.toFixed(2)}|${account}` : null;
}

export interface ExistingBankTransactionForDuplicates {
  transaction_date: string;
  amount: number;
  description: string | null;
  counter_account: string | null;
  reference: string | null;
  /** Stored format (20261020120000); authoritative when present. */
  import_source?: string | null;
  /**
   * The bank's own reference as imported (20261020120000). For MT940 it is also
   * in `reference` after "//"; for CAMT.053 (<AcctSvcrRef>) it is stored nowhere else.
   */
  bank_reference?: string | null;
  /** Present on rows imported from CAMT.053; a fallback for rows without import_source. */
  camt_ustrd?: string | null;
  camt_addtl_ntry_inf?: string | null;
  camt_counterparty_name?: string | null;
}

/** A stored row does not record its format; "//" means MT940, CAMT fields mean CAMT.053. */
export function storedReferenceSource(row: ExistingBankTransactionForDuplicates): ReferenceSource {
  if (row.import_source === "mt940" || row.import_source === "camt053") return row.import_source;
  if ((row.reference ?? "").includes("//")) return "mt940";
  if (row.camt_ustrd || row.camt_addtl_ntry_inf || row.camt_counterparty_name) return "camt053";
  return "unknown";
}

/**
 * Marks each incoming transaction that is already stored.
 *
 * Matching is one-to-one: every stored transaction can explain at most one
 * incoming transaction. Two identical payments on the same day (two parking
 * tickets) are both genuine; when only one of them was imported before, the
 * second one stays selected instead of being dropped as a "duplicate".
 */
export function detectDuplicates(
  incoming: ParsedTransaction[],
  existing: ExistingBankTransactionForDuplicates[]
): DuplicateInfo[] {
  const consumed = new Array<boolean>(existing.length).fill(false);
  const byReference = new Map<string, number[]>();
  const byComposite = new Map<string, number[]>();
  const byPossible = new Map<string, number[]>();
  const push = (map: Map<string, number[]>, key: string, index: number) => {
    const list = map.get(key);
    if (list) list.push(index);
    else map.set(key, [index]);
  };

  const existingRefs = withoutRepeatedBankReferences(storedReferenceIds(existing));
  existing.forEach((ex, index) => {
    const ids = existingRefs[index];
    if (ids.bank) push(byReference, `B:${ids.bank}`, index);
    for (const o of ids.owners) push(byReference, `O:${o}`, index);
    push(byComposite, compositeKey(ex.transaction_date, ex.amount, ex.description, ex.counter_account), index);
    const possible = possibleKey(ex.transaction_date, ex.amount, ex.counter_account);
    if (possible) push(byPossible, possible, index);
  });

  const claimFirst = (candidates: number[], allowed: (index: number) => boolean): boolean => {
    const index = candidates.find((i) => !consumed[i] && allowed(i));
    if (index === undefined) return false;
    consumed[index] = true;
    return true;
  };

  // Strongest evidence first, across the whole file: a weak match of an
  // earlier row may never take the stored row that a later row matches exactly.
  const result: DuplicateInfo[] = incoming.map(() => ({ isDuplicate: false, reason: null }));
  const refs = incomingReferenceIds(incoming, existing, storedReferenceIds(existing));
  const compatible = (ids: ReferenceIds) => (index: number) => !differentReferences(ids, existingRefs[index]);

  // 1. The bank's own reference: unique per transaction, so no date window.
  incoming.forEach((tx, i) => {
    const ids = refs[i];
    if (!ids.bank) return;
    const matched = claimFirst(byReference.get(`B:${ids.bank}`) ?? [], (index) =>
      existing[index].amount.toFixed(2) === tx.amount.toFixed(2) && sameReference(ids, existingRefs[index]) === "bank",
    );
    if (matched) result[i] = { isDuplicate: true, reason: "reference" };
  });
  // 2. Exact copies (date, amount, description, counter account) before the
  //    approximate owner-reference match: otherwise a newer, genuine row with
  //    the same owner reference could take the stored row that a later exact
  //    copy in the same file belongs to.
  //    Within those, a copy that also carries the same owner reference first.
  incoming.forEach((tx, i) => {
    if (result[i].isDuplicate) return;
    const candidates = byComposite.get(compositeKey(tx.date, tx.amount, tx.description, tx.counterAccount)) ?? [];
    if (claimFirst(candidates, (index) => sameReference(refs[i], existingRefs[index]) === "owner")) {
      result[i] = { isDuplicate: true, reason: "reference" };
    }
  });
  incoming.forEach((tx, i) => {
    if (result[i].isDuplicate) return;
    const candidates = byComposite.get(compositeKey(tx.date, tx.amount, tx.description, tx.counterAccount)) ?? [];
    if (claimFirst(candidates, compatible(refs[i]))) result[i] = { isDuplicate: true, reason: "composite" };
  });
  // 3. The account owner's reference: same amount, within the date window.
  //    Closest dates first across the whole file, so the nearest pair wins.
  const ownerPairs: { i: number; index: number; days: number }[] = [];
  incoming.forEach((tx, i) => {
    if (result[i].isDuplicate) return;
    const ids = refs[i];
    const candidates = new Set(ids.owners.flatMap((o) => byReference.get(`O:${o}`) ?? []));
    for (const index of candidates) {
      if (consumed[index] || existing[index].amount.toFixed(2) !== tx.amount.toFixed(2)) continue;
      if (sameReference(ids, existingRefs[index]) !== "owner") continue;
      const days = daysApart(existing[index].transaction_date, tx.date);
      if (days <= REFERENCE_DATE_WINDOW_DAYS) ownerPairs.push({ i, index, days });
    }
  });
  ownerPairs.sort((a, b) => a.days - b.days || a.i - b.i || a.index - b.index);
  for (const { i, index } of ownerPairs) {
    if (result[i].isDuplicate || consumed[index]) continue;
    consumed[index] = true;
    result[i] = { isDuplicate: true, reason: "reference" };
  }
  incoming.forEach((tx, i) => {
    if (result[i].isDuplicate) return;
    const possible = possibleKey(tx.date, tx.amount, tx.counterAccount);
    if (possible && claimFirst(byPossible.get(possible) ?? [], compatible(refs[i]))) {
      result[i] = { isDuplicate: true, reason: "possible" };
    }
  });
  return result;
}

// ─── Import fingerprints (database idempotency, 20261020120000) ─────

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One fingerprint per statement line, aligned with `statement.transactions`.
 * The database refuses a second row with the same fingerprint for the same
 * administratie (unique index), also when two people import at the same time.
 *
 *   - With the bank's own reference: account + bank reference + value date +
 *     amount (the value date, because MT940 and CAMT.053 lead with different
 *     dates for the same transaction), and only when the statement's bank
 *     references can be trusted (see statementTrustsBankReferences).
 *     That identifies the bank transaction itself, so the same line in another
 *     or overlapping statement of the same account is recognised too. The
 *     date is in it so that a bank writing a constant instead of a unique
 *     reference can never make next month's payment equal to this one.
 *   - Without one: a key of the whole statement (account, balances and every
 *     line) + the line's position. That only recognises the same statement
 *     again, but can never make two different lines equal — two genuine,
 *     identical payments always get different fingerprints.
 */
export async function importFingerprints(
  statement: ParsedStatement,
  existing: readonly ExistingBankTransactionForDuplicates[] = [],
): Promise<string[]> {
  const account = core(statement.accountIban);
  const statementKey = await sha256Hex(
    JSON.stringify([
      "v1",
      account,
      statement.openingBalance,
      statement.closingBalance,
      statement.transactions.map((t) => [t.date, t.amount.toFixed(2), t.description, t.counterAccount, t.reference]),
    ]),
  );
  const ids = incomingReferenceIds(statement.transactions, existing, storedReferenceIds(existing));
  return Promise.all(
    statement.transactions.map((t, index) => {
      return ids[index].bank
        ? sha256Hex(`v1|bank|${account}|${ids[index].bank}|${t.valueDate ?? t.date}|${t.amount.toFixed(2)}`)
        : sha256Hex(`v1|stmt|${statementKey}|${index}`);
    }),
  );
}
