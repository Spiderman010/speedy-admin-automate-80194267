// Kleine pure helpers voor BTW-berekening.
//
// HELE CENTEN, HALF-UP
// Geldbedragen worden hier in hele centen gerekend, niet in binaire floats.
// Een float als 1,815 bestaat niet exact (1,81499999…), dus "excl × pct" en
// "excl + btw" los afronden met toFixed/Math.round levert soms een btw die een
// cent onder half-up ligt, of een incl die niet meer gelijk is aan excl + btw
// (A3-10). De database rekent in NUMERIC en rondt bij opslag in numeric(12,2)
// half weg van nul af; voor positieve bedragen is dat half-up. `toCents`
// doet precies dat op de decimale waarde van het bedrag, en alle afgeleide
// bedragen worden daarna als gehele centen opgeteld. Zo geldt per constructie:
//
//   inclCents = exclCents + btwCents        (de controle van post_sales_invoice
//                                             en post_purchase_invoice)
//   btwCents  = half-up(exclCents × pct / 100)
//
// `round2` blijft bestaan met zijn oude betekenis (Math.round op de float):
// memoriaal en andere modules gebruiken hem als "heeft dit bedrag hoogstens
// twee decimalen?"-toets.

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Een bedrag naar hele centen, half weg van nul afgerond op de DECIMALE waarde
 * (zoals PostgreSQL bij opslag in numeric(…,2)): 1,005 → 101, 1,815 → 182,
 * −1,005 → −101. De decimale waarde is de kortste weergave van het getal, dus
 * wat de gebruiker typte. Niet-eindige invoer geeft NaN.
 */
export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) return Number.NaN;
  const abs = Math.abs(amount);
  const text = abs.toString();
  // "1.005e2" laat de decimale komma verschuiven zonder binaire afronding;
  // alleen bij een exponentiële weergave (extreem klein of groot) valt dat weg.
  const cents = text.includes("e") ? Math.round(abs * 100) : Math.round(Number(`${text}e2`));
  return amount < 0 ? -cents : cents;
}

/** Hele centen naar een bedrag (2 decimalen, zo exact als een double toelaat). */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** Hele centen als tekst met precies twee decimalen en een punt: 452 → "4.52". */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return "";
  const abs = Math.abs(Math.trunc(cents));
  const euros = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${cents < 0 && abs !== 0 ? "-" : ""}${euros}.${rest.toString().padStart(2, "0")}`;
}

/**
 * BTW in hele centen over een bedrag in hele centen: half-up(excl × pct / 100),
 * weg van nul voor negatieve bedragen. Exacte gehele rekenkunde (pct op twee
 * decimalen), dus geen afrondingsfout van de float.
 */
export function btwCentsFromExclCents(exclCents: number, pct: number): number {
  if (!Number.isFinite(exclCents) || !Number.isFinite(pct)) return Number.NaN;
  const basis = Math.round(pct * 100); // 21 → 2100, 9 → 900, 5,5 → 550
  const product = Math.abs(Math.trunc(exclCents)) * Math.abs(basis);
  const rest = product % 10000;
  const heel = (product - rest) / 10000;
  const cents = rest * 2 >= 10000 ? heel + 1 : heel;
  return (exclCents < 0) !== (basis < 0) && cents !== 0 ? -cents : cents;
}

/** excl (bedrag) + pct → excl, btw en incl in hele centen. */
export function deriveCentsFromExcl(excl: number, pct: number): { exclCents: number; btwCents: number; inclCents: number } {
  const exclCents = toCents(excl);
  const btwCents = btwCentsFromExclCents(exclCents, pct);
  return { exclCents, btwCents, inclCents: exclCents + btwCents };
}

/**
 * Voor een formulier met tekstvelden (de verkoopdialoog): excl en pct als tekst
 * → btw en incl als tekst met precies twee decimalen, in hele centen gerekend.
 * `null` zolang excl of pct geen getal is (dan wordt er niets herberekend).
 * Excl wordt gerekend zoals de database hem opslaat (half-up op twee
 * decimalen), dus excl + btw = incl blijft ook na opslag exact gelden.
 */
export function vatAmountsFromExclText(
  amountExcl: string,
  pct: string,
): { btw_amount: string; amount_incl: string } | null {
  const excl = parseFloat(amountExcl);
  const p = parseFloat(pct);
  if (!Number.isFinite(excl) || !Number.isFinite(p)) return null;
  const { btwCents, inclCents } = deriveCentsFromExcl(excl, p);
  return { btw_amount: formatCents(btwCents), amount_incl: formatCents(inclCents) };
}

/**
 * excl → btw = half-up(excl × pct / 100), incl = excl + btw — in hele centen
 * gerekend (zie boven), als bedrag teruggegeven.
 */
export function deriveFromExcl(excl: number, pct: number): { btw: number; incl: number } {
  const { btwCents, inclCents } = deriveCentsFromExcl(excl, pct);
  return { btw: fromCents(btwCents), incl: fromCents(inclCents) };
}

/**
 * incl → excl = incl / (1 + pct/100), btw = incl − excl. Gelijk aan de formule
 * van de bankschrijver (net = round(bruto / (1 + p/100), 2); btw = rest); A3-10
 * vond op 400.000 bedragen geen afwijking, dus ongewijzigd.
 */
export function deriveFromIncl(incl: number, pct: number): { excl: number; btw: number } {
  const excl = round2(incl / (1 + pct / 100));
  const btw = round2(incl - excl);
  return { excl, btw };
}
