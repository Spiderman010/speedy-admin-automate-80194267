// Pure kopcontroles voor de inkoopwerkbank.
//
// DE KOP WORDT NIET MEER AFGELEID (A2-02 / D-01). Deze module bevatte
// `deriveHeaderFromLines`: als de kop "incompleet" leek (geen btw-bedrag, incl
// gelijk aan excl) en de regels btw droegen, werd de kop uit de regels
// herrekend. Bij een 0%-factuur waarvan de OCR de 0 als NULL opsloeg, en een
// regel met een stil aangenomen 21%, werd € 100 / € 0 / € 100 zo € 100 / € 21 /
// € 121 — en de totaalcontrole vergeleek daarna twee afgeleide waarden en werd
// groen. De kop is het document; hij wordt nu nooit meer uit regels herleid.
//
// Wat hier staat, leidt niets af. Het zijn dezelfde toetsen die
// `post_purchase_invoice()` op de opgeslagen kop doet, zodat een groene
// "sluit aan" in de werkbank alleen verschijnt bij echte aansluiting:
//   • excl en incl zijn bekend;
//   • excl + btw (NULL = 0, zoals de schrijver) = incl, exact op de cent;
//   • Σ regels excl = kop excl, exact op de cent.
// Plus de feiten die de btw-poorten nodig hebben: hoeveel btw er op het
// document staat, en of het kop-percentage bij de regels past (FD-N2).

import { toCents } from "./btw-calc";
import { isLineVatChoice } from "./purchase-line-validation";

export interface HeaderAmounts {
  amount_excl: number | null;
  btw_amount: number | null;
  amount_incl: number | null;
}

const known = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

/**
 * Sluit de kop zelf? excl + (btw ?? 0) = incl op de cent — exact de regel van
 * `post_purchase_invoice()` (`v_btw := COALESCE(btw_amount, 0)`). `null` zolang
 * excl of incl ontbreekt: dan valt er niets te zeggen en dus ook niets goed te keuren.
 */
export function headerReconciles(h: HeaderAmounts): boolean | null {
  if (!known(h.amount_excl) || !known(h.amount_incl)) return null;
  const btw = known(h.btw_amount) ? h.btw_amount : 0;
  return toCents(h.amount_excl) + toCents(btw) === toCents(h.amount_incl);
}

/**
 * De btw die op het document staat, in hele centen: het grootste van het
 * btw-bedrag en incl − excl (beide alleen als ze bekend zijn); 0 als er niets
 * bekend is. "Staat er btw op deze factuur?" mag nooit afhangen van welk van
 * de twee velden toevallig gevuld is.
 */
export function documentVatCents(h: HeaderAmounts): number {
  const fromAmount = known(h.btw_amount) ? toCents(h.btw_amount) : 0;
  const fromTotals = known(h.amount_excl) && known(h.amount_incl)
    ? toCents(h.amount_incl) - toCents(h.amount_excl)
    : 0;
  return Math.max(fromAmount, fromTotals, 0);
}

/** Σ regelbedragen excl in hele centen. */
export function sumLineExclCents(amounts: readonly number[]): number {
  return amounts.reduce((som, a) => som + toCents(a), 0);
}

// ── Het kop-percentage (FD-N2) ──────────────────────────────────────────────
//
// `purchase_invoices.btw_percentage` boekt niets: `post_purchase_invoice()`
// leest alleen `btw_amount` en de regels. De SnelStart-export gebruikt het kop-
// percentage wél, als btw-code voor het HELE bedrag (21 → "1", 9 → "2",
// 0 → "0", NULL → ""). Een kop-percentage dat niet bij de regels past, geeft
// daar aantoonbaar een verkeerde code. Daarom:
//   • een ontbrekend kop-percentage blijft ontbrekend (nooit meer stil 21%);
//   • bij gemengde tarieven kiest de gebruiker expliciet "Gemengd", en dat
//     wordt als NULL bewaard — de vorm die de UBL-intake bij gemengde tarieven
//     zelf al gebruikt (`ubl-extract.ts`: gemengd → null);
//   • goedkeuren vraagt een kop-percentage dat bij de regels past.

/** De keuzewaarde voor "meerdere tarieven"; wordt als NULL opgeslagen. */
export const HEADER_VAT_MIXED = "gemengd";

/**
 * Opgeslagen kop-percentage → invoerwaarde. NULL wordt "" (nog niet gekozen),
 * nooit 21. Een ander opgeslagen getal (bv. 6) blijft letterlijk staan zodat
 * een gewone Opslaan het niet stil verandert; goedkeuren vraagt dan alsnog een
 * keuze (zie `headerVatChoiceProblem`).
 */
export function headerVatChoiceFromStored(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "";
  return ["0", "9", "21"].find((o) => Number(o) === Number(p)) ?? String(Number(p));
}

/**
 * Invoerwaarde → op te slaan kop-percentage. "Gemengd" en "nog niet gekozen"
 * worden NULL; een getal blijft dat getal (dus ook een ongewijzigd bewaard 6).
 */
export function headerVatChoiceToStored(choice: string): number | null {
  if (choice === "" || choice === HEADER_VAT_MIXED) return null;
  const n = Number(choice);
  return Number.isFinite(n) ? n : null;
}

const label = (pct: string) => `${pct}%`;

/**
 * Waarom het kop-percentage nog niet goed te keuren is, of `null` als het past.
 * Alleen tegen regels MET een keuze: een regel zonder keuze heeft zijn eigen
 * blokkade ("BTW niet herkend").
 */
export function headerVatChoiceProblem(headerChoice: string, lineChoices: readonly string[]): string | null {
  const gekozen = [...new Set(lineChoices.filter((c) => isLineVatChoice(c)))].sort((a, b) => Number(a) - Number(b));
  if (headerChoice !== HEADER_VAT_MIXED && !isLineVatChoice(headerChoice)) {
    // Leeg, of een opgeslagen percentage dat de werkbank niet aanbiedt.
    return "BTW niet herkend — kies het btw-percentage van de factuur: 0%, 9%, 21% of Gemengd.";
  }
  if (headerChoice === HEADER_VAT_MIXED) {
    return gekozen.length === 1
      ? `Gemengd past alleen bij regels met verschillende tarieven; alle regels hebben ${label(gekozen[0])}.`
      : null;
  }
  const afwijkend = gekozen.filter((c) => c !== headerChoice);
  if (afwijkend.length === 0) return null;
  return gekozen.length > 1
    ? `Het btw-percentage van de factuur (${label(headerChoice)}) past niet bij de boekingsregels (${gekozen.map(label).join(", ")}); kies Gemengd.`
    : `Het btw-percentage van de factuur (${label(headerChoice)}) past niet bij de boekingsregels (${label(gekozen[0])}).`;
}
