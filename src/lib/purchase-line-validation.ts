// Pure helper to validate purchase invoice lines against header totals.
// Header is leading. Mixed VAT percentages per line are supported because
// the VAT sum is computed per line as amount_excl * btw_percentage / 100.

export interface PurchaseLineInput {
  omschrijving: string;
  amount_excl: number;
  btw_percentage: number | null;
}

export interface HeaderTotals {
  amount_excl: number | null;
  btw_amount: number | null;
  amount_incl: number | null;
}

export interface LineTotals {
  sumExcl: number;
  sumBtw: number;
  sumIncl: number;
}

export interface LineDiffs {
  excl: number | null;
  btw: number | null;
  incl: number | null;
  tolerance: number;
  exclOk: boolean;
  btwOk: boolean;
  inclOk: boolean;
  allOk: boolean;
}

/** Round to 2 decimals to mirror NL bookkeeping cent precision. */
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Tolerance scales with line count to absorb per-line rounding drift. */
export function lineTolerance(lineCount: number): number {
  return Math.max(0.02, 0.01 * Math.max(1, lineCount));
}

export function computeLineTotals(lines: PurchaseLineInput[]): LineTotals {
  let sumExcl = 0;
  let sumBtw = 0;
  for (const l of lines) {
    const excl = Number(l.amount_excl || 0);
    const pct = Number(l.btw_percentage || 0);
    sumExcl += excl;
    sumBtw += excl * pct / 100;
  }
  return {
    sumExcl: r2(sumExcl),
    sumBtw: r2(sumBtw),
    sumIncl: r2(sumExcl + sumBtw),
  };
}

export function computeLineDiffs(
  lines: PurchaseLineInput[],
  header: HeaderTotals,
): LineDiffs {
  const totals = computeLineTotals(lines);
  const tolerance = lineTolerance(lines.length);
  const excl = header.amount_excl != null && Number.isFinite(header.amount_excl)
    ? r2(totals.sumExcl - header.amount_excl) : null;
  const btw = header.btw_amount != null && Number.isFinite(header.btw_amount)
    ? r2(totals.sumBtw - header.btw_amount) : null;
  const incl = header.amount_incl != null && Number.isFinite(header.amount_incl)
    ? r2(totals.sumIncl - header.amount_incl) : null;
  const exclOk = excl === null || Math.abs(excl) <= tolerance;
  const btwOk = btw === null || Math.abs(btw) <= tolerance;
  const inclOk = incl === null || Math.abs(incl) <= tolerance;
  return { excl, btw, incl, tolerance, exclOk, btwOk, inclOk, allOk: exclOk && btwOk && inclOk };
}

const fmt = (n: number) => `€${Math.abs(n).toFixed(2)}`;
const fmtDiff = (d: number) => `${d < 0 ? "-" : "+"}${fmt(d)}`;

/**
 * Returns a Dutch validation error string, or null when lines are valid.
 * Reports all mismatched totals (excl/BTW/incl) in one message so the user
 * knows exactly which total is off.
 */
export function validatePurchaseLines(
  lines: PurchaseLineInput[],
  header: HeaderTotals,
): string | null {
  if (lines.length === 0) return null;
  for (const l of lines) {
    if (!l.omschrijving.trim()) return "Elke regel moet een omschrijving hebben";
    if (!Number.isFinite(Number(l.amount_excl))) return "Elke regel moet een geldig bedrag excl. hebben";
  }
  const totals = computeLineTotals(lines);
  const diffs = computeLineDiffs(lines, header);
  if (diffs.allOk) return null;

  const parts: string[] = [];
  if (!diffs.exclOk && diffs.excl !== null && header.amount_excl !== null) {
    parts.push(`excl. BTW (som ${fmt(totals.sumExcl)} vs factuur ${fmt(header.amount_excl)}, verschil ${fmtDiff(diffs.excl)})`);
  }
  if (!diffs.btwOk && diffs.btw !== null && header.btw_amount !== null) {
    parts.push(`BTW (som ${fmt(totals.sumBtw)} vs factuur ${fmt(header.btw_amount)}, verschil ${fmtDiff(diffs.btw)})`);
  }
  if (!diffs.inclOk && diffs.incl !== null && header.amount_incl !== null) {
    parts.push(`incl. BTW (som ${fmt(totals.sumIncl)} vs factuur ${fmt(header.amount_incl)}, verschil ${fmtDiff(diffs.incl)})`);
  }
  if (parts.length === 0) return null;
  return `Deelregels wijken af op ${parts.join("; ")}.`;
}

// -----------------------------------------------------------------------------
// Prefill helper — derives one default purchase line from header totals.
// Mirrors the "Maak deelregel voor totaalbedrag" button, with one extension:
// when amount_excl is missing but amount_incl is present, excl is derived from
// incl using the header VAT percentage (or equals incl when pct is 0).
// -----------------------------------------------------------------------------

export interface PrefillHeader {
  amount_excl: number | null;
  amount_incl: number | null;
  btw_percentage: number | null;
  isBtwVrijgesteld: boolean;
}

export interface PrefillLine {
  amount_excl: number;
  btw_percentage: number;
}

/**
 * Returns the prefill line derived from header totals, or null when no usable
 * excl amount can be determined. Rounds excl to 2 decimals.
 *
 * Rules (in order):
 *  - btw_percentage = 0 when BTW-vrijgesteld, otherwise header pct (0 when missing).
 *  - excl = header.amount_excl when finite.
 *  - else, if amount_incl is finite: excl = incl / (1 + pct/100). With pct=0 this
 *    equals incl, which also covers BTW-vrijgesteld facturen met alleen incl.
 *  - else: null (no prefill possible).
 */
export function derivePrefillLine(header: PrefillHeader): PrefillLine | null {
  const pct = header.isBtwVrijgesteld ? 0 : (Number.isFinite(header.btw_percentage as number) ? Number(header.btw_percentage) : 0);
  const headerExcl = header.amount_excl;
  const headerIncl = header.amount_incl;
  let excl: number | null = headerExcl != null && Number.isFinite(headerExcl) ? headerExcl : null;
  if (excl == null && headerIncl != null && Number.isFinite(headerIncl)) {
    excl = pct ? headerIncl / (1 + pct / 100) : headerIncl;
  }
  if (excl == null) return null;
  return { amount_excl: r2(excl), btw_percentage: pct };
}

// -----------------------------------------------------------------------------
// Blank-line predicate — a line is "completely empty" when it has no meaningful
// user input: no description, no amount input, no ledger account. The VAT
// percentage is a select with a default value (21% or 0% bij BTW-vrijgesteld)
// and therefore never counts as user-entered by itself; without an amount the
// derived VAT is €0 regardless of percentage.
// -----------------------------------------------------------------------------

export interface BlankLineCandidate {
  omschrijving: string;
  /** Raw text from the amount input field. Empty string = user typed nothing. */
  amount_input: string;
  grootboekrekening_id: string | null;
}

export function isBlankLine(l: BlankLineCandidate): boolean {
  const noDesc = !l.omschrijving || l.omschrijving.trim() === "";
  const noAmount = !l.amount_input || l.amount_input.trim() === "";
  const noLedger = !l.grootboekrekening_id;
  return noDesc && noAmount && noLedger;
}

/**
 * A line is "partially filled" when it is not blank but is still missing a
 * required field (description or a usable amount input). Save must be blocked
 * so we never persist half-filled ghost lines.
 */
export function isPartiallyFilledLine(l: BlankLineCandidate): boolean {
  if (isBlankLine(l)) return false;
  const noDesc = !l.omschrijving || l.omschrijving.trim() === "";
  const noAmount = !l.amount_input || l.amount_input.trim() === "";
  return noDesc || noAmount;
}

/**
 * Een regel mét boekhoudkundige inhoud maar ZONDER grootboekrekening.
 *
 * Dit is bewust een aparte vraag naast `isPartiallyFilledLine`. Die laatste
 * bewaakt het OPSLAAN: half ingevulde spookregels mogen niet worden
 * weggeschreven, maar een regel waar de rekening nog bij gezocht moet worden
 * moet je wel tussentijds kunnen bewaren. Ontbreekt de rekening nog, dan is de
 * factuur alleen niet GOEDGEKEURD-klaar: `post_purchase_invoice()` weigert elke
 * regel zonder grootboekrekening, dus goedkeuren zou een factuur opleveren die
 * er af is maar nooit geboekt kan worden.
 *
 * Een volledig lege regel telt niet mee — die wordt nergens opgeslagen en is
 * gewoon een lege invoerrij.
 */
export function isLineMissingLedgerAccount(l: BlankLineCandidate): boolean {
  if (isBlankLine(l)) return false;
  return !l.grootboekrekening_id;
}

/** Hoeveel betekenisvolle regels wachten nog op een grootboekrekening. */
export function countLinesMissingLedgerAccount(lines: readonly BlankLineCandidate[]): number {
  let n = 0;
  for (const l of lines) if (isLineMissingLedgerAccount(l)) n++;
  return n;
}


