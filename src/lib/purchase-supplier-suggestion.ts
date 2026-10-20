export interface SupplierCandidate {
  id: string;
  naam: string;
  btw_nummer: string | null;
  iban: string | null;
  client_id: string;
  actief: boolean;
}
export interface InvoiceSupplierIdentity {
  supplier: string | null;
  supplier_btw_number?: string | null;
  supplier_iban?: string | null;
}
const norm = (s: string | null | undefined): string =>
  (s ?? "").toUpperCase().replace(/[\s.\-/\\]/g, "");
const normName = (s: string | null | undefined): string =>
  (s ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("nl");

export function suggestExistingSupplier(
  identity: InvoiceSupplierIdentity,
  candidates: readonly SupplierCandidate[],
  clientId: string,
): SupplierCandidate | null {
  const scoped = candidates.filter((s) => s.actief && s.client_id === clientId);
  const vat = norm(identity.supplier_btw_number);
  const iban = norm(identity.supplier_iban);
  // Strong identifiers take precedence. Conflicts between identifiers are not auto-resolved.
  const byVat = vat ? scoped.filter((s) => norm(s.btw_nummer) === vat) : [];
  const byIban = iban ? scoped.filter((s) => norm(s.iban) === iban) : [];
  if (byVat.length > 1 || byIban.length > 1) return null;
  if (byVat.length === 1 && byIban.length === 1 && byVat[0].id !== byIban[0].id) return null;
  const match = byVat[0] ?? byIban[0];
  if (match) {
    // A conflicting, present identifier on the matched supplier is disqualifying.
    if (vat && match.btw_nummer && norm(match.btw_nummer) !== vat) return null;
    if (iban && match.iban && norm(match.iban) !== iban) return null;
    return match;
  }
  if (vat || iban) return null;
  const name = normName(identity.supplier);
  if (!name) return null;
  const byName = scoped.filter((s) => normName(s.naam) === name);
  return byName.length === 1 ? byName[0] : null;
}
