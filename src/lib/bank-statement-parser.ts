/**
 * Client-side parser for MT940 (SWIFT) and CAMT.053 (XML) bank statements.
 */

export interface ParsedTransaction {
  date: string; // YYYY-MM-DD
  amount: number;
  description: string;
  counterAccount: string | null;
  reference: string | null;
}

export interface ParsedStatement {
  openingBalance: number | null;
  closingBalance: number | null;
  accountIban: string | null;
  transactions: ParsedTransaction[];
}

export interface DuplicateInfo {
  isDuplicate: boolean;
  reason: "reference" | "composite" | null;
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

  let description = getTextNS(entry, ns, "AddtlNtryInf");
  if (!description) description = getTextNS(entry, ns, "Ustrd");
  if (!description) description = "Geen omschrijving";

  let counterAccount: string | null = null;
  const ibanEl = ns ? entry.getElementsByTagNameNS(ns, "IBAN") : entry.getElementsByTagName("IBAN");
  if (ibanEl.length) counterAccount = ibanEl[0].textContent || null;

  let reference: string | null = null;
  const refEl = ns ? entry.getElementsByTagNameNS(ns, "EndToEndId") : entry.getElementsByTagName("EndToEndId");
  if (refEl.length && refEl[0].textContent !== "NOTPROVIDED") {
    reference = refEl[0].textContent;
  }

  return { date: dateStr, amount: signedAmount, description, counterAccount, reference };
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

export function detectDuplicates(
  incoming: ParsedTransaction[],
  existing: {
    transaction_date: string;
    amount: number;
    description: string | null;
    counter_account: string | null;
    reference: string | null;
  }[]
): DuplicateInfo[] {
  // Build sets from existing transactions
  const existingRefs = new Set<string>();
  const existingComposites = new Set<string>();

  for (const ex of existing) {
    if (ex.reference && ex.reference.trim()) {
      existingRefs.add(ex.reference.trim());
    }
    existingComposites.add(
      compositeKey(ex.transaction_date, ex.amount, ex.description, ex.counter_account)
    );
  }

  return incoming.map((tx) => {
    // Check reference first
    if (tx.reference && tx.reference.trim() && existingRefs.has(tx.reference.trim())) {
      return { isDuplicate: true, reason: "reference" as const };
    }
    // Fallback: composite key
    const key = compositeKey(tx.date, tx.amount, tx.description, tx.counterAccount);
    if (existingComposites.has(key)) {
      return { isDuplicate: true, reason: "composite" as const };
    }
    return { isDuplicate: false, reason: null };
  });
}
