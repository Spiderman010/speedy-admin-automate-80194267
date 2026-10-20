/**
 * Of een bankregel werkelijk in het grootboek staat.
 *
 * `match_status` zegt alleen hoe een regel is verwerkt (gematcht met een
 * factuur, of handmatig gecodeerd op een rekening). Of er een journaalpost is,
 * staat in de boekingsmarkers:
 *   - directe boeking:  `bank_transaction_postings` (één per banktransactie)
 *   - via facturen:     `bank_allocation_postings` (één per factuurkoppeling,
 *                       met het geboekte bedrag)
 * Een tegenboeking (`ledger_reversal_postings`) laat de marker staan; een
 * teruggedraaide groep telt daarom niet als "in grootboek".
 *
 * Deze module leest geen data; zij beslist alleen uit opgehaalde feiten. Zonder
 * feiten (laden, fout) is de uitkomst "onbekend" — nooit "geboekt".
 */

export type BankLedgerState = "geboekt" | "deels_geboekt" | "teruggedraaid" | "niet_geboekt" | "onbekend";

export interface BankLedgerFacts {
  /** Directe boeking per banktransactie: de boekingsgroep. */
  directPostingGroup: ReadonlyMap<string, string>;
  /** Geboekte factuurkoppelingen per banktransactie. */
  allocationPostings: ReadonlyMap<string, readonly { postingGroupId: string; amount: number }[]>;
  /** Boekingsgroepen waarvoor een tegenboeking bestaat. */
  reversedGroups: ReadonlySet<string>;
}

/** Halve cent: bedragen staan op twee decimalen. */
const CENT_TOLERANCE = 0.005;

export function resolveBankLedgerState(
  transaction: { id: string; amount: number },
  facts: BankLedgerFacts | null,
): BankLedgerState {
  if (!facts) return "onbekend";

  const direct = facts.directPostingGroup.get(transaction.id);
  if (direct) return facts.reversedGroups.has(direct) ? "teruggedraaid" : "geboekt";

  const postings = facts.allocationPostings.get(transaction.id) ?? [];
  if (postings.length === 0) return "niet_geboekt";
  const live = postings.filter((p) => !facts.reversedGroups.has(p.postingGroupId));
  if (live.length === 0) return "teruggedraaid";

  // Een koppeling boekt alleen haar eigen bedrag: één geboekte koppeling van
  // € 60 op een bankregel van € 100 is maar deels in het grootboek.
  const posted = live.reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0);
  return posted + CENT_TOLERANCE >= Math.abs(Number(transaction.amount)) ? "geboekt" : "deels_geboekt";
}

/** Alleen verwerkte regels (gematcht of gecodeerd) horen in het grootboek te staan. */
export function expectsLedgerPosting(matchStatus: string): boolean {
  return matchStatus === "gematcht" || matchStatus === "handmatig_geboekt";
}

export const BANK_LEDGER_STATE_LABEL: Record<BankLedgerState, string> = {
  geboekt: "In grootboek",
  deels_geboekt: "Deels in grootboek",
  teruggedraaid: "Teruggedraaid — niet in grootboek",
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
