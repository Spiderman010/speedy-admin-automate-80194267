/** Central fail-closed reversal policy for persisted bank rows.
 * Importers MUST retain source reversal evidence; downstream payment writers MUST
 * call this check or enforce an equivalent database-level invariant.
 * A missing field is UNKNOWN, not evidence of a normal payment.
 */
export interface BankReversalState { is_reversal?: boolean | null }

export function canAutomaticallyMatchBankTransaction(
  transaction: BankReversalState,
): boolean {
  return transaction.is_reversal === false;
}

export function assertOrdinaryBankPayment(transaction: BankReversalState): void {
  if (!canAutomaticallyMatchBankTransaction(transaction)) {
    throw new Error("Banktransactie is een storno of de storno-status is onbekend; automatische factuurkoppeling is geblokkeerd.");
  }
}
