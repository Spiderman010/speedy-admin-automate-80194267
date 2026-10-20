/**
 * Client-side parser for MT940 (SWIFT) and CAMT.053 (XML) bank statements.
 */

export interface ParsedTransaction {
  date: string; // YYYY-MM-DD
  amount: number;
  description: string;
  counterAccount: string | null;
  reference: string | null;
  /** CAMT.053 Ustrd (unstructured remittance info) — only set for CAMT.053 sources. */
  ustrd?: string | null;
  /** CAMT.053 AddtlNtryInf (additional entry information) — only set for CAMT.053 sources. */
  addtlNtryInf?: string | null;
  /** CAMT.053 counterparty name from RltdPties (Dbtr/Cdtr <Nm>). */
  counterpartyName?: string | null;
}

export interface ParsedStatement {
  openingBalance: number | null;
  closingBalance: number | null;
  accountIban: string | null;
  transactions: ParsedTransaction[];
}

export interface DuplicateInfo {
  isDuplicate: boolean;
  /**
   * reference: same real reference, same amount, within a few days.
   * composite: same date, amount, description and counter account.
   * possible:  same date, amount and counter account, but a different text —
   *            typically an older row whose description was overwritten by a
   *            typed note. Deselected, so the user decides.
   */
  reason: "reference" | "composite" | "possible" | null;
}

// ─── MT940 Parser ───────────────────────────────────────────────────
export function parseMT940(text: string): ParsedTransaction[] {
  return parseMT940Full(text).transactions;
}

function parseMT940Balance(raw: string): number | null {
  // Full format: C/DYYMMDDCCCAMOUNT (e.g. C240101EUR1234,56)
  const full = raw.match(/^([CD])\d{6}[A-Z]{3}(\d+,\d{0,2})/);
  if (full) {
    const sign = full[1] === "D" ? -1 : 1;
    return sign * parseFloat(full[2].replace(",", "."));
  }
  // Short format without date/currency: C/DAMOUNT (e.g. C1234,56)
  const short = raw.match(/^([CD])(\d+,\d{0,2})/);
  if (short) {
    const sign = short[1] === "D" ? -1 : 1;
    return sign * parseFloat(short[2].replace(",", "."));
  }
  return null;
}

function parseMT940Full(text: string): ParsedStatement {
  const transactions: ParsedTransaction[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let openingBalance: number | null = null;
  let closingBalance: number | null = null;
  let accountIban: string | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Extract account IBAN from :25: field
    if (line.startsWith(":25:") && !accountIban) {
      const field = line.substring(4).trim();
      const ibanMatch = field.match(/([A-Z]{2}\d{2}[A-Z]{4}\d{10,})/);
      if (ibanMatch) accountIban = ibanMatch[1];
    }

    if (line.startsWith(":60F:") || line.startsWith(":60M:")) {
      const bal = parseMT940Balance(line.substring(5));
      if (openingBalance === null) openingBalance = bal;
    }

    if (line.startsWith(":62F:") || line.startsWith(":62M:")) {
      closingBalance = parseMT940Balance(line.substring(5));
    }

    if (line.startsWith(":61:")) {
      const raw = line.substring(4);
      const tx = parseMT940Transaction(raw, lines, i);
      if (tx) transactions.push(tx);
    }
    i++;
  }

  // Sort by date descending (YYYY-MM-DD strings compare correctly)
  transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return { openingBalance, closingBalance, accountIban, transactions };
}

function parseMT940Transaction(
  raw: string,
  lines: string[],
  lineIdx: number
): ParsedTransaction | null {
  // Format: YYMMDD[MMDD]C/DamountNtypeRef
  const dateStr = raw.substring(0, 6);
  const year = 2000 + parseInt(dateStr.substring(0, 2));
  const month = dateStr.substring(2, 4);
  const day = dateStr.substring(4, 6);
  const date = `${year}-${month}-${day}`;

  let pos = 6;
  if (/^\d{4}[CD]/.test(raw.substring(pos))) {
    pos += 4;
  }

  const cdMatch = raw.substring(pos).match(/^(R?[CD])/);
  if (!cdMatch) return null;
  const isCredit = cdMatch[1].endsWith("C");
  pos += cdMatch[1].length;

  const amountMatch = raw.substring(pos).match(/^(\d+,\d{0,2})/);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1].replace(",", ".")) * (isCredit ? 1 : -1);
  pos += amountMatch[1].length;

  const typeMatch = raw.substring(pos).match(/^[A-Z]\d{3}/);
  if (typeMatch) pos += 4;

  const reference = raw.substring(pos).trim() || null;

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

  const ibanMatch = description.match(/([A-Z]{2}\d{2}[A-Z]{4}\d{10,})/);
  if (ibanMatch) counterAccount = ibanMatch[1];

  const cntpMatch = description.match(/\/CNTP\/([^/]+)/);
  if (cntpMatch) counterAccount = cntpMatch[1];

  return { date, amount, description: description.trim() || "Geen omschrijving", counterAccount, reference };
}

// ─── CAMT.053 Parser ────────────────────────────────────────────────
export function parseCAMT053(xmlText: string): ParsedTransaction[] {
  return parseCAMT053Full(xmlText).transactions;
}

function parseCAMT053Full(xmlText: string): ParsedStatement {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const transactions: ParsedTransaction[] = [];
  let openingBalance: number | null = null;
  let closingBalance: number | null = null;
  let accountIban: string | null = null;

  const ns = doc.documentElement.namespaceURI || "";

  // Extract account IBAN from <Acct><Id><IBAN>
  const ibanEls = ns ? doc.getElementsByTagNameNS(ns, "IBAN") : doc.getElementsByTagName("IBAN");
  if (ibanEls.length > 0) accountIban = ibanEls[0].textContent || null;

  // Extract balances from <Bal> elements
  const balEls = ns ? doc.getElementsByTagNameNS(ns, "Bal") : doc.getElementsByTagName("Bal");
  for (let i = 0; i < balEls.length; i++) {
    const bal = balEls[i];
    const code = getTextNS(bal as Element, ns, "Cd");
    if (code !== "OPBD" && code !== "CLBD") continue;
    const amtStr = getTextNS(bal as Element, ns, "Amt");
    if (!amtStr) continue;
    const cdtDbt = getTextNS(bal as Element, ns, "CdtDbtInd");
    const value = parseFloat(amtStr) * (cdtDbt === "DBIT" ? -1 : 1);
    if (code === "OPBD" && openingBalance === null) openingBalance = value;
    if (code === "CLBD") closingBalance = value;
  }

  const entries = ns
    ? doc.getElementsByTagNameNS(ns, "Ntry")
    : doc.getElementsByTagName("Ntry");

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const tx = parseCAMTEntry(entry, ns);
    if (tx) transactions.push(tx);
  }

  transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return { openingBalance, closingBalance, accountIban, transactions };
}



function getTextNS(parent: Element, ns: string, tag: string): string {
  const els = ns
    ? parent.getElementsByTagNameNS(ns, tag)
    : parent.getElementsByTagName(tag);
  return els.length > 0 ? (els[0].textContent || "") : "";
}

function parseCAMTEntry(entry: Element, ns: string): ParsedTransaction | null {
  const amountStr = getTextNS(entry, ns, "Amt");
  if (!amountStr) return null;
  const amount = parseFloat(amountStr);

  const cdtDbt = getTextNS(entry, ns, "CdtDbtInd");
  const signedAmount = cdtDbt === "DBIT" ? -amount : amount;

  let dateStr = "";
  const bookgDt = ns ? entry.getElementsByTagNameNS(ns, "BookgDt") : entry.getElementsByTagName("BookgDt");
  if (bookgDt.length) {
    dateStr = getTextNS(bookgDt[0] as Element, ns, "Dt");
  }
  if (!dateStr) {
    const valDt = ns ? entry.getElementsByTagNameNS(ns, "ValDt") : entry.getElementsByTagName("ValDt");
    if (valDt.length) dateStr = getTextNS(valDt[0] as Element, ns, "Dt");
  }
  if (!dateStr) return null;

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

  return {
    date: dateStr,
    amount: signedAmount,
    description,
    counterAccount,
    reference,
    ustrd,
    addtlNtryInf,
    counterpartyName,
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
// There is no database uniqueness on bank_transactions, so this check is the
// only thing standing between a re-imported statement and a second copy of
// every transaction (each of which could then be posted again). It must
// therefore be neither too loose (missing a duplicate) nor too strict
// (silently deselecting a genuine new transaction).

/**
 * Bank placeholders that mean "no reference". MT940 uses NONREF in :61: when
 * the account owner gave no reference (standard at Rabobank, ING, ABN AMRO);
 * CAMT.053 uses NOTPROVIDED for a missing EndToEndId. They are shared by many
 * unrelated transactions, so they can never identify one.
 */
const PLACEHOLDER_REFERENCES = new Set(["NONREF", "NOTPROVIDED", "NOT PROVIDED"]);

/**
 * The MT940 parser only strips type codes shaped like N544; ING-style codes
 * (NTRF, NDDT, NMSC, …) stay glued to the reference, as in "NTRFNONREF".
 */
const MT940_TYPE_CODE = /^[NSF][A-Z0-9]{3}/;

/** A trimmed reference that can identify a transaction, or null for none/placeholder. */
export function identifyingBankReference(reference: string | null | undefined): string | null {
  const trimmed = (reference ?? "").trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (PLACEHOLDER_REFERENCES.has(upper)) return null;
  if (MT940_TYPE_CODE.test(upper) && PLACEHOLDER_REFERENCES.has(upper.slice(4))) return null;
  return trimmed;
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
 * A reference only proves a duplicate together with the same amount and a
 * date close by. Not the exact date: value date and booking date can differ
 * by a few days. Not any date either: a direct debit can carry the same
 * reference (a policy or contract number) every month.
 */
function referenceKey(reference: string, amount: number): string {
  return `${reference}|${amount.toFixed(2)}`;
}

const REFERENCE_DATE_WINDOW_DAYS = 7;

function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Number.isFinite(ms) ? ms / 86_400_000 : Number.POSITIVE_INFINITY;
}

function possibleKey(date: string, amount: number, counterAccount: string | null): string {
  return `${date}|${amount.toFixed(2)}|${(counterAccount || "").replace(/\s/g, "").toLowerCase()}`;
}

export interface ExistingBankTransactionForDuplicates {
  transaction_date: string;
  amount: number;
  description: string | null;
  counter_account: string | null;
  reference: string | null;
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

  const existingRefs = existing.map((ex) => identifyingBankReference(ex.reference));
  existing.forEach((ex, index) => {
    const ref = existingRefs[index];
    if (ref) push(byReference, referenceKey(ref, ex.amount), index);
    push(byComposite, compositeKey(ex.transaction_date, ex.amount, ex.description, ex.counter_account), index);
    push(byPossible, possibleKey(ex.transaction_date, ex.amount, ex.counter_account), index);
  });

  const claim = (
    map: Map<string, number[]>,
    key: string,
    allowed: (index: number) => boolean = () => true,
  ): boolean => {
    const index = map.get(key)?.find((i) => !consumed[i] && allowed(i));
    if (index === undefined) return false;
    consumed[index] = true;
    return true;
  };

  // Strongest evidence first, across the whole file: a weak match of an
  // earlier row may never take the stored row that a later row matches exactly.
  const result: DuplicateInfo[] = incoming.map(() => ({ isDuplicate: false, reason: null }));
  const refs = incoming.map((tx) => identifyingBankReference(tx.reference));
  const compatible = (ref: string | null) => (index: number) =>
    // Two different real references prove two different transactions,
    // however alike the rest looks.
    !ref || !existingRefs[index] || existingRefs[index] === ref;

  incoming.forEach((tx, i) => {
    const ref = refs[i];
    const nearby = (index: number) => daysApart(existing[index].transaction_date, tx.date) <= REFERENCE_DATE_WINDOW_DAYS;
    if (ref && claim(byReference, referenceKey(ref, tx.amount), nearby)) {
      result[i] = { isDuplicate: true, reason: "reference" };
    }
  });
  incoming.forEach((tx, i) => {
    if (result[i].isDuplicate) return;
    if (claim(byComposite, compositeKey(tx.date, tx.amount, tx.description, tx.counterAccount), compatible(refs[i]))) {
      result[i] = { isDuplicate: true, reason: "composite" };
    }
  });
  incoming.forEach((tx, i) => {
    if (result[i].isDuplicate) return;
    if (claim(byPossible, possibleKey(tx.date, tx.amount, tx.counterAccount), compatible(refs[i]))) {
      result[i] = { isDuplicate: true, reason: "possible" };
    }
  });
  return result;
}
