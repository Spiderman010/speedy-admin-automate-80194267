import { describe, expect, it } from "vitest";
import { suggestSupplierLedger } from "@/lib/supplier-ledger-suggestion";

const supplier = {
  id: "sup-1", client_id: "client-a", actief: true,
  standaard_grootboekrekening_id: "ledger-1",
};
const ledger = {
  id: "ledger-1", client_id: "client-a", nummer: 4510,
  omschrijving: "Onderhoudskosten", actief: true,
};
describe("Supplier default ledger suggestions", () => {
  it("proposes only a unique active ledger in the same client", () => {
    expect(suggestSupplierLedger("sup-1", "client-a", [supplier], [ledger])).toEqual({
      id: "ledger-1", label: "4510 - Onderhoudskosten",
    });
  });
  it("rejects cross-client and inactive suppliers or accounts", () => {
    expect(suggestSupplierLedger("sup-1", "client-b", [supplier], [ledger])).toBeNull();
    expect(suggestSupplierLedger("sup-1", "client-a", [{ ...supplier, actief: false }], [ledger])).toBeNull();
    expect(suggestSupplierLedger("sup-1", "client-a", [supplier], [{ ...ledger, actief: false }])).toBeNull();
    expect(suggestSupplierLedger("sup-1", "client-a", [supplier], [{ ...ledger, client_id: "client-b" }])).toBeNull();
  });
  it("does not resolve ambiguous IDs and allows organization-wide bookable ledgers", () => {
    expect(suggestSupplierLedger("sup-1", "client-a", [supplier], [ledger, ledger])).toBeNull();
    expect(suggestSupplierLedger("sup-1", "client-a", [supplier], [{ ...ledger, client_id: null }])).not.toBeNull();
  });
  it("never proposes a ledger without a configured supplier default", () => {
    expect(suggestSupplierLedger("sup-1", "client-a", [{ ...supplier, standaard_grootboekrekening_id: null }], [ledger])).toBeNull();
  });
});
