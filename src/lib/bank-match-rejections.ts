/**
 * Bank-matchafwijzingen — de pure onderdrukkingsregel.
 *
 * Een afwijzing is één feit: "voor DEZE banktransactie is DEZE factuur (van
 * deze soort) als suggestie afgewezen". Deze module zegt uitsluitend of een
 * kandidaat daarom niet opnieuw mag worden voorgesteld. Zij rekent geen score,
 * kiest geen alternatief en boekt niets; de bestaande matcher
 * (`rankCandidates()`) blijft de bron van kandidaten.
 *
 * Bron van de afwijzingen: de tabel `public.bank_match_rejections` (migratie
 * 20261010120000). De leeshook die haar rijen hier aanlevert, komt in een
 * vervolg-PR zodra de migratie in productie staat en `types.ts` is
 * geregenereerd. Tot dan heeft deze module geen aanroeper in de UI.
 */

export type BankMatchInvoiceType = "inkoop" | "verkoop";

/** Precies de identiteit van een rij in bank_match_rejections. */
export interface BankMatchRejectionLike {
  bank_transaction_id: string;
  invoice_type: BankMatchInvoiceType;
  invoice_id: string;
}

/** Wat de matcher van een kandidaat weet: factuur-id en -soort. */
export interface BankMatchCandidateLike {
  id: string;
  type: BankMatchInvoiceType;
}

function key(bankTransactionId: string, type: BankMatchInvoiceType, invoiceId: string): string {
  return `${bankTransactionId}|${type}|${invoiceId}`;
}

/** Eén opzoekverzameling voor alle afwijzingen die de aanroeper heeft gelezen. */
export function buildRejectionIndex(rows: readonly BankMatchRejectionLike[]): ReadonlySet<string> {
  return new Set(rows.map((r) => key(r.bank_transaction_id, r.invoice_type, r.invoice_id)));
}

/**
 * Is deze kandidaat voor deze transactie afgewezen? Alleen een exacte
 * overeenkomst telt: dezelfde transactie, dezelfde soort, dezelfde factuur.
 * Een afwijzing bij een andere transactie onderdrukt niets.
 */
export function isRejectedCandidate(
  index: ReadonlySet<string>,
  bankTransactionId: string,
  candidate: BankMatchCandidateLike,
): boolean {
  return index.has(key(bankTransactionId, candidate.type, candidate.id));
}

/** De kandidaten zonder de afgewezen kandidaten; volgorde en overige velden blijven ongewijzigd. */
export function withoutRejectedCandidates<T extends BankMatchCandidateLike>(
  index: ReadonlySet<string>,
  bankTransactionId: string,
  candidates: readonly T[],
): T[] {
  return candidates.filter((c) => !isRejectedCandidate(index, bankTransactionId, c));
}
