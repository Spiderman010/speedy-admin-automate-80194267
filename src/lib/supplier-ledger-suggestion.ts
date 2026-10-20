export interface SupplierLedgerPreference {
  id: string;
  client_id: string;
  actief: boolean;
  standaard_grootboekrekening_id: string | null;
}
export interface BookableLedger {
  id: string;
  client_id: string | null;
  nummer: number;
  omschrijving: string;
  actief: boolean;
}
/** A suggestion only. Never use this result as a booking instruction. */
export function suggestSupplierLedger(
  supplierId: string | null | undefined,
  clientId: string,
  suppliers: readonly SupplierLedgerPreference[],
  ledgers: readonly BookableLedger[],
): { id: string; label: string } | null {
  if (!supplierId || !clientId) return null;
  const matchingSuppliers = suppliers.filter((s) =>
    s.id === supplierId && s.client_id === clientId && s.actief
  );
  if (matchingSuppliers.length !== 1) return null;
  const target = matchingSuppliers[0].standaard_grootboekrekening_id;
  if (!target) return null;
  const matchingLedgers = ledgers.filter((a) =>
    a.id === target && a.actief && (a.client_id === null || a.client_id === clientId)
  );
  if (matchingLedgers.length !== 1) return null;
  const a = matchingLedgers[0];
  return { id: a.id, label: `${a.nummer} - ${a.omschrijving}` };
}
