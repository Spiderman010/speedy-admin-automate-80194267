/**
 * Legacy-rekeningtekst → hooguit een SUGGESTIE, nooit een toewijzing.
 *
 * Oude inkoopfacturen dragen `purchase_invoices.ledger_account_text`: vrije
 * tekst als "4602 - Telefoonkosten". Dat is géén verwijzing naar
 * `grootboekrekeningen` — het is tekst, en tekst is in de boekhouding geen
 * rekening. Deze module zet die tekst hooguit om in één ondubbelzinnige
 * kandidaat die de gebruiker zelf moet bevestigen.
 *
 * DE REGELS ZIJN OPZETTELIJK STRENG:
 *   • alleen een EXACT rekeningnummer vooraan in de tekst telt;
 *   • alleen rekeningen die in deze administratie boekbaar zijn (organisatie-
 *     breed of van deze administratie) doen mee;
 *   • er moet PRECIES ÉÉN kandidaat overblijven.
 *
 * Geen fuzzy matching, geen "beste gok", geen nummerreeksen, geen matching op
 * omschrijving — die zou "Telefoonkosten" aan de verkeerde rekening kunnen
 * knopen zonder dat iemand het merkt. Bij nul kandidaten, meerdere kandidaten
 * of tekst zonder nummer is het antwoord: geen suggestie.
 *
 * Deze module wijst nooit iets toe en slaat nooit iets op. De uitkomst is
 * hooguit iets dat de UI mag vóórstellen.
 */

export interface LedgerAccountCandidate {
  id: string;
  nummer: number;
  omschrijving: string;
  /** `null` = organisatiebreed; anders alleen voor die administratie. */
  client_id: string | null;
}

export type LegacySuggestionReason =
  /** Er is geen legacy-tekst. */
  | "geen_tekst"
  /** De tekst begint niet met een rekeningnummer. */
  | "geen_nummer"
  /** Geen enkele boekbare rekening met dat nummer. */
  | "geen_match"
  /** Meer dan één rekening met dat nummer; niet ondubbelzinnig. */
  | "meerdere_matches";

export type LegacyLedgerSuggestion =
  | { kind: "geen"; reason: LegacySuggestionReason }
  | { kind: "uniek"; account: LedgerAccountCandidate; label: string };

/** Zelfde weergave als de rekeningkiezer: "4602 - Telefoonkosten". */
export function formatLedgerLabel(nummer: number, omschrijving: string): string {
  return `${nummer} - ${omschrijving}`;
}

/**
 * Het rekeningnummer vooraan in de tekst, of `null`.
 *
 * Alleen een aaneengesloten reeks cijfers helemaal aan het begin, die daarna
 * eindigt (einde tekst) of wordt gevolgd door een scheidingsteken (spatie,
 * koppelteken, dubbele punt). "4602 - Telefoonkosten" → 4602;
 * "Telefoonkosten" → null; "46021" → 46021 (een ánder nummer, dus geen match
 * op 4602 — dat is de bedoeling).
 */
export function parseLegacyAccountNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = /^\s*(\d{1,9})(?=$|[\s\-:.,])/.exec(text);
  if (!match) return null;
  const nummer = Number(match[1]);
  return Number.isFinite(nummer) ? nummer : null;
}

/**
 * De enige toegestane afleiding van legacy-tekst naar een rekening.
 *
 * `accounts` hoort de ACTIEVE rekeningen te zijn; deze functie filtert daar
 * alleen nog het administratiebereik uit (organisatiebreed of deze
 * administratie), hetzelfde bereik dat de rekeningkiezer en de grootboekregels
 * hanteren.
 */
export function suggestLedgerAccountFromLegacyText(
  text: string | null | undefined,
  accounts: readonly LedgerAccountCandidate[],
  clientId: string | null | undefined,
): LegacyLedgerSuggestion {
  if (!text || text.trim() === "") return { kind: "geen", reason: "geen_tekst" };

  const nummer = parseLegacyAccountNumber(text);
  if (nummer === null) return { kind: "geen", reason: "geen_nummer" };

  const boekbaar = accounts.filter((a) => a.client_id === null || a.client_id === clientId);
  const treffers = boekbaar.filter((a) => a.nummer === nummer);

  if (treffers.length === 0) return { kind: "geen", reason: "geen_match" };
  if (treffers.length > 1) return { kind: "geen", reason: "meerdere_matches" };

  const account = treffers[0];
  return { kind: "uniek", account, label: formatLedgerLabel(account.nummer, account.omschrijving) };
}
