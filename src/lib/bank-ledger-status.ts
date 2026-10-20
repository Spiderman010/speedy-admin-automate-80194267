/**
 * Of een bankregel werkelijk in het grootboek staat.
 *
 * `match_status` zegt alleen hoe een regel is verwerkt (gematcht met een
 * factuur, of handmatig gecodeerd op een rekening). Of er een journaalpost is,
 * staat in de boekingsmarkers:
 *   - directe boeking:  `bank_transaction_postings` (één per banktransactie)
 *   - via facturen:     `bank_allocation_postings` (één per factuurkoppeling)
 *
 * Deze module leest geen data; zij beslist alleen uit opgehaalde feiten. Zonder
 * feiten (laden, fout) is de uitkomst "onbekend" — nooit "geboekt".
 */

export type BankLedgerState = "geboekt" | "deels_geboekt" | "niet_geboekt" | "onbekend";

export interface BankLedgerFacts {
  /** Banktransacties met een directe boeking. */
  directlyPosted: ReadonlySet<string>;
  /** Factuurkoppelingen per banktransactie (allocatie-id's). */
  allocationsByTransaction: ReadonlyMap<string, readonly string[]>;
  /** Factuurkoppelingen die geboekt zijn. */
  postedAllocations: ReadonlySet<string>;
}

export function resolveBankLedgerState(transactionId: string, facts: BankLedgerFacts | null): BankLedgerState {
  if (!facts) return "onbekend";
  if (facts.directlyPosted.has(transactionId)) return "geboekt";
  const allocations = facts.allocationsByTransaction.get(transactionId) ?? [];
  if (allocations.length === 0) return "niet_geboekt";
  const posted = allocations.filter((id) => facts.postedAllocations.has(id)).length;
  if (posted === allocations.length) return "geboekt";
  return posted > 0 ? "deels_geboekt" : "niet_geboekt";
}

/** Alleen verwerkte regels (gematcht of gecodeerd) horen in het grootboek te staan. */
export function expectsLedgerPosting(matchStatus: string): boolean {
  return matchStatus === "gematcht" || matchStatus === "handmatig_geboekt";
}

export const BANK_LEDGER_STATE_LABEL: Record<BankLedgerState, string> = {
  geboekt: "In grootboek",
  deels_geboekt: "Deels in grootboek",
  niet_geboekt: "Nog niet in grootboek",
  onbekend: "Grootboekstatus onbekend",
};

/**
 * De uitkomstmelding na handmatig coderen. Coderen legt alleen de rekening
 * vast; de journaalpost volgt pas bij "Boeken in grootboek" (detailpaneel) of
 * via de inhaalslag. De melding mag dus nooit "geboekt" zeggen.
 */
export function codedNotPostedMessage(ledgerText?: string | null): { title: string; description: string } {
  const account = ledgerText?.trim();
  return {
    title: account ? `Gecodeerd op ${account}` : "Gecodeerd",
    description: "Nog niet in het grootboek. Boek de regel via de details (Boeken in grootboek) of via de inhaalslag.",
  };
}
