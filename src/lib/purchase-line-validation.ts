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

const fmt = (n: number) => `€${n.toFixed(2)}`;
const fmtDiff = (d: number) => `${d > 0 ? "+" : ""}${fmt(d)}`;

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
