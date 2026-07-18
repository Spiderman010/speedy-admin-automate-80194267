// Kleine pure helper voor BTW-berekening in de handmatige inkoopfactuur-popup.
// Behoud dezelfde rondingslogica als in PurchaseInvoiceCreateDialog:
// - alle geldbedragen op 2 decimalen (half-up via Math.round).
// - excl → btw = excl * pct / 100, incl = excl + btw.
// - incl → excl = incl / (1 + pct/100), btw = incl - excl.

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function deriveFromExcl(excl: number, pct: number): { btw: number; incl: number } {
  const btw = round2((excl * pct) / 100);
  const incl = round2(excl + btw);
  return { btw, incl };
}

export function deriveFromIncl(incl: number, pct: number): { excl: number; btw: number } {
  const excl = round2(incl / (1 + pct / 100));
  const btw = round2(incl - excl);
  return { excl, btw };
}
