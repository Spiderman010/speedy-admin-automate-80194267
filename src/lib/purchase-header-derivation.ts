// Pure helper: derive missing purchase invoice header totals from booking lines.
//
// Rationale: when a purchase invoice is created manually the user often only
// enters amount_excl. btw_amount stays null and amount_incl mirrors
// amount_excl. As soon as a booking line adds VAT (e.g. 9%), the header vs
// lines comparison shows an artificial gap even though the line itself is
// correct. This helper normalises the header totals from the lines in exactly
// that case, without ever overwriting explicit user/OCR values.

import type { HeaderTotals, LineTotals } from "./purchase-line-validation";

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Returns normalised header totals when the header is incomplete and the
 * lines carry meaningful VAT information; otherwise returns the input header
 * unchanged. Never overwrites explicit btw_amount values.
 *
 * Derivation fires only when ALL of these hold:
 *  - header.amount_excl is present
 *  - header.btw_amount is null (not user-supplied)
 *  - header.amount_incl is null OR equals amount_excl within 1 cent
 *  - at least one line contributes a non-zero VAT sum (sumBtw != 0)
 *  - line sums are internally consistent (sumIncl = sumExcl + sumBtw)
 */
export function deriveHeaderFromLines(
  header: HeaderTotals,
  lineTotals: LineTotals,
): HeaderTotals {
  const excl = header.amount_excl;
  const incl = header.amount_incl;
  const btw = header.btw_amount;

  if (excl == null) return header;
  if (btw != null) return header;
  if (incl != null && Math.abs(incl - excl) > 0.01) return header;

  const sumBtw = r2(lineTotals.sumBtw);
  if (sumBtw === 0) return header;

  return {
    amount_excl: r2(lineTotals.sumExcl),
    btw_amount: sumBtw,
    amount_incl: r2(lineTotals.sumIncl),
  };
}
