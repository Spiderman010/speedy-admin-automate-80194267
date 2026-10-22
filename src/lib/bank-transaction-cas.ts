/**
 * Compare-and-set voor een directe write op de matchvelden (review P5 H-1/H-2):
 * de write gaat alleen door als de regel in de database nog de toestand heeft
 * waar het scherm van uitging. Anders is er intussen iets gebeurd (een ander
 * tabblad, een koppeling via de betaalschrijver) en wordt er niets geschreven.
 */
export interface BankTransactionExpectation {
  match_status: readonly string[];
  /** undefined: niet controleren; null: moet leeg zijn. */
  matched_invoice_id?: string | null;
}

/** Elke match_status behalve `gematcht`: een regel zonder betaling. */
export const BANK_TX_NOT_LINKED_STATUSES = ["niet_gematcht", "suggestie", "handmatig_geboekt", "wacht_op_factuur"] as const;

export const BANK_TX_CHANGED_MESSAGE =
  "Deze bankregel is intussen gewijzigd (bijvoorbeeld in een ander tabblad of door een koppeling). Er is niets gewijzigd; de lijst is ververst.";

export class BankTransactionChangedError extends Error {
  constructor() {
    super(BANK_TX_CHANGED_MESSAGE);
    this.name = "BankTransactionChangedError";
  }
}
