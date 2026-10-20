import { validatePurchaseLines, type HeaderTotals } from "./purchase-line-validation";

export interface UblWorkspaceLine {
  omschrijving: string;
  amount_excl: number;
  btw_percentage: number | null;
}

/** Only prefill drafts from trusted-shape UBL metadata; never post automatically. */
export function getUblWorkspaceLines(
  ocrData: unknown,
  header: HeaderTotals,
): UblWorkspaceLine[] | null {
  if (!ocrData || typeof ocrData !== "object" || Array.isArray(ocrData)) return null;
  const data = ocrData as Record<string, unknown>;
  if (data.source !== "ubl" || !Array.isArray(data.invoice_lines)
    || data.invoice_lines.length === 0 || data.invoice_lines.length > 200) return null;

  const result: UblWorkspaceLine[] = [];
  for (const item of data.invoice_lines) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const l = item as Record<string, unknown>;
    if (typeof l.description !== "string" || !l.description.trim()
      || typeof l.amount_excl !== "number" || !Number.isFinite(l.amount_excl)
      || l.amount_excl < 0
      || (l.btw_percentage !== null
        && (typeof l.btw_percentage !== "number" || !Number.isFinite(l.btw_percentage)
          || l.btw_percentage < 0 || l.btw_percentage > 100))) return null;
    result.push({
      omschrijving: l.description.trim(),
      amount_excl: l.amount_excl,
      btw_percentage: l.btw_percentage as number | null,
    });
  }
  // Fail closed on discrepant, incomplete or credit/discount documents:
  // accounting totals remain authoritative and require human review.
  if (header.amount_excl == null || header.btw_amount == null || header.amount_incl == null
    || validatePurchaseLines(result, header) !== null) return null;
  return result;
}
