/**
 * Client-side parser for MT940 (SWIFT) and CAMT.053 (XML) bank statements.
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
   * reference: same real reference, same amount, at most 4 days apart.
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

  const tail = reference?.indexOf("//") ?? -1;
  const bankReference = reference && tail >= 0 ? reference.slice(tail + 2).trim() || null : null;

  return {
    date,
    amount,
    description: description.trim() || "Geen omschrijving",
    counterAccount,
    reference,
    source: "mt940",
    bankReference,
  };
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
  const bankReference = getTextNS(entry, ns, "AcctSvcrRef").trim() || null;

  return {
    date: dateStr,
    amount: signedAmount,
    description,
    counterAccount,
    reference,
    source: "camt053",
    bankReference,
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
  /** Present on rows imported from CAMT.053; used to read the reference right. */
  camt_ustrd?: string | null;
  camt_addtl_ntry_inf?: string | null;
  camt_counterparty_name?: string | null;
}

/** A stored row does not record its format; "//" means MT940, CAMT fields mean CAMT.053. */
export function storedReferenceSource(row: ExistingBankTransactionForDuplicates): ReferenceSource {
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

  const existingRefs = withoutRepeatedBankReferences(
    existing.map((ex) => referenceIdsFor({ reference: ex.reference, source: storedReferenceSource(ex) })),
  );
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
  const refs = withoutRepeatedBankReferences(
    incoming.map((tx) =>
      referenceIdsFor({ reference: tx.reference, source: tx.source ?? "unknown", bankReference: tx.bankReference }),
    ),
  );
  const compatible = (ids: ReferenceIds) => (index: number) => !differentReferences(ids, existingRefs[index]);

  incoming.forEach((tx, i) => {
    const ids = refs[i];
    const keys = [...(ids.bank ? [`B:${ids.bank}`] : []), ...ids.owners.map((o) => `O:${o}`)];
    const candidates = [...new Set(keys.flatMap((k) => byReference.get(k) ?? []))].sort((a, b) => a - b);
    const matched = claimFirst(candidates, (index) => {
      if (existing[index].amount.toFixed(2) !== tx.amount.toFixed(2)) return false;
      const how = sameReference(ids, existingRefs[index]);
      if (how === "bank") return true;
      return how === "owner" && daysApart(existing[index].transaction_date, tx.date) <= REFERENCE_DATE_WINDOW_DAYS;
    });
    if (matched) result[i] = { isDuplicate: true, reason: "reference" };
  });
  incoming.forEach((tx, i) => {
    if (result[i].isDuplicate) return;
    const candidates = byComposite.get(compositeKey(tx.date, tx.amount, tx.description, tx.counterAccount)) ?? [];
    if (claimFirst(candidates, compatible(refs[i]))) result[i] = { isDuplicate: true, reason: "composite" };
  });
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
 *   - With the bank's own reference: account + bank reference + date + amount.
 *     That identifies the bank transaction itself, so the same line in another
 *     or overlapping statement of the same account is recognised too. The
 *     date is in it so that a bank writing a constant instead of a unique
 *     reference can never make next month's payment equal to this one.
 *   - Without one: a key of the whole statement (account, balances and every
 *     line) + the line's position. That only recognises the same statement
 *     again, but can never make two different lines equal — two genuine,
 *     identical payments always get different fingerprints.
 */
export async function importFingerprints(statement: ParsedStatement): Promise<string[]> {
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
  const ids = withoutRepeatedBankReferences(
    statement.transactions.map((t) =>
      referenceIdsFor({ reference: t.reference, source: t.source ?? "unknown", bankReference: t.bankReference }),
    ),
  );
  return Promise.all(
    statement.transactions.map((t, index) => {
      return ids[index].bank
        ? sha256Hex(`v1|bank|${account}|${ids[index].bank}|${t.date}|${t.amount.toFixed(2)}`)
        : sha256Hex(`v1|stmt|${statementKey}|${index}`);
    }),
  );
}
