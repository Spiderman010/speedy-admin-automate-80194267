import { describe, expect, it } from "vitest";
import { suggestExistingSupplier } from "@/lib/purchase-supplier-suggestion";

const a = { id: "a", naam: "Acme BV", btw_nummer: "NL123456789B01", iban: "NL12ABNA0123456789", client_id: "client-1", actief: true };
const b = { id: "b", naam: "Beta BV", btw_nummer: "NL987654321B01", iban: "NL34RABO0123456789", client_id: "client-1", actief: true };
describe("purchase supplier confirmation proposals", () => {
  it("matches normalized VAT for same client", () => {
    expect(suggestExistingSupplier({ supplier: "Other name", supplier_btw_number: "nl123456789b01" }, [a, b], "client-1")?.id).toBe("a");
  });
  it("does not suggest cross-client, inactive, or ambiguous suppliers", () => {
    expect(suggestExistingSupplier({ supplier: "Acme BV" }, [a], "client-2")).toBeNull();
    expect(suggestExistingSupplier({ supplier: "Acme BV" }, [{ ...a, actief: false }], "client-1")).toBeNull();
    expect(suggestExistingSupplier({ supplier: "Acme BV" }, [a, { ...a, id: "c" }], "client-1")).toBeNull();
  });
  it("rejects conflicting VAT and IBAN and does not fall back to name", () => {
    expect(suggestExistingSupplier({
      supplier: "Acme BV", supplier_btw_number: a.btw_nummer, supplier_iban: b.iban,
    }, [a, b], "client-1")).toBeNull();
    expect(suggestExistingSupplier({
      supplier: "Acme BV", supplier_btw_number: "NL000000000B01",
    }, [a, b], "client-1")).toBeNull();
  });
});
