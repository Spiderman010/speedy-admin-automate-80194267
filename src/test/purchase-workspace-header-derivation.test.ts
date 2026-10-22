import { describe, it, expect } from "vitest";
import * as headerModule from "@/lib/purchase-header-derivation";
import {
  HEADER_VAT_MIXED,
  documentVatCents,
  headerReconciles,
  headerVatChoiceFromStored,
  headerVatChoiceProblem,
  headerVatChoiceToStored,
  sumLineExclCents,
} from "@/lib/purchase-header-derivation";

/*
 * Deze module bevatte `deriveHeaderFromLines`: een "incomplete" kop werd uit de
 * regels herrekend. Dat was het mechanisme van A2-02 / D-01 (een 0%-factuur van
 * € 100 werd met een stil aangenomen 21%-regel € 121). De afleiding is weg; de
 * werkbanktests in purchase-workspace-btw-fail-closed.test.tsx bewijzen op de
 * echte werkbank dat de kop nooit meer uit regels wordt herleid. Hier staan de
 * kopcontroles die ervoor in de plaats kwamen — dezelfde exacte toetsen als
 * post_purchase_invoice() op de opgeslagen kop.
 */

describe("de kop wordt niet meer afgeleid", () => {
  it("de module exporteert geen afleiding van de kop uit regels meer", () => {
    expect(Object.keys(headerModule)).not.toContain("deriveHeaderFromLines");
    for (const naam of Object.keys(headerModule)) expect(naam).not.toMatch(/^derive/i);
  });
});

describe("headerReconciles — excl + btw (leeg = 0) = incl, op de cent", () => {
  it("100 + 21 = 121 sluit", () => {
    expect(headerReconciles({ amount_excl: 100, btw_amount: 21, amount_incl: 121 })).toBe(true);
  });
  it("een leeg btw-bedrag telt als 0, net als in de schrijver: 100 / leeg / 100 sluit", () => {
    expect(headerReconciles({ amount_excl: 100, btw_amount: null, amount_incl: 100 })).toBe(true);
  });
  it("100 / leeg / 121 sluit niet: de btw ontbreekt in de kop", () => {
    expect(headerReconciles({ amount_excl: 100, btw_amount: null, amount_incl: 121 })).toBe(false);
  });
  it("één cent verschil sluit niet (geen tolerantie, zoals de schrijver)", () => {
    expect(headerReconciles({ amount_excl: 100, btw_amount: 21, amount_incl: 121.01 })).toBe(false);
  });
  it("zonder excl of incl valt er niets te zeggen", () => {
    expect(headerReconciles({ amount_excl: null, btw_amount: null, amount_incl: 121 })).toBeNull();
    expect(headerReconciles({ amount_excl: 100, btw_amount: 21, amount_incl: null })).toBeNull();
  });
  it("rekent in hele centen: 0,1 + 0,2 = 0,3", () => {
    expect(headerReconciles({ amount_excl: 0.1, btw_amount: 0.2, amount_incl: 0.3 })).toBe(true);
  });
});

describe("documentVatCents — staat er btw op het document?", () => {
  it("het btw-bedrag telt", () => {
    expect(documentVatCents({ amount_excl: 100, btw_amount: 21, amount_incl: 121 })).toBe(2100);
  });
  it("ook zonder btw-bedrag: incl − excl", () => {
    expect(documentVatCents({ amount_excl: 100, btw_amount: null, amount_incl: 121 })).toBe(2100);
  });
  it("een btw-bedrag van 0 met incl > excl telt toch als btw", () => {
    expect(documentVatCents({ amount_excl: 100, btw_amount: 0, amount_incl: 121 })).toBe(2100);
  });
  it("geen btw: 0", () => {
    expect(documentVatCents({ amount_excl: 100, btw_amount: null, amount_incl: 100 })).toBe(0);
    expect(documentVatCents({ amount_excl: null, btw_amount: null, amount_incl: 121 })).toBe(0);
  });
});

describe("sumLineExclCents — exact, in hele centen", () => {
  it("telt half-up afgeronde centen op", () => {
    expect(sumLineExclCents([33.33, 33.33, 33.34])).toBe(10000);
    expect(sumLineExclCents([1.005])).toBe(101);
  });
});

describe("het kop-percentage (FD-N2)", () => {
  it("opgeslagen → invoer: NULL wordt 'nog niet gekozen' (nooit 21), 0 blijft 0, een ander getal blijft letterlijk staan", () => {
    expect(headerVatChoiceFromStored(null)).toBe("");
    expect(headerVatChoiceFromStored(undefined)).toBe("");
    expect(headerVatChoiceFromStored(6)).toBe("6");
    expect(headerVatChoiceFromStored(0)).toBe("0");
    expect(headerVatChoiceFromStored(9)).toBe("9");
    expect(headerVatChoiceFromStored(21)).toBe("21");
  });
  it("keuze → opgeslagen: Gemengd en 'nog niet gekozen' worden NULL, nooit 21", () => {
    expect(headerVatChoiceToStored("")).toBeNull();
    expect(headerVatChoiceToStored(HEADER_VAT_MIXED)).toBeNull();
    expect(headerVatChoiceToStored("0")).toBe(0);
    expect(headerVatChoiceToStored("9")).toBe(9);
    expect(headerVatChoiceToStored("21")).toBe(21);
    // Een ongewijzigd bewaard afwijkend percentage gaat ongewijzigd terug.
    expect(headerVatChoiceToStored("6")).toBe(6);
  });
  it("past het kop-percentage bij de regels?", () => {
    expect(headerVatChoiceProblem("21", ["21", "21"])).toBeNull();
    expect(headerVatChoiceProblem("0", ["0"])).toBeNull();
    expect(headerVatChoiceProblem(HEADER_VAT_MIXED, ["9", "21"])).toBeNull();
    expect(headerVatChoiceProblem("", ["21"])).toMatch(/BTW niet herkend/);
    expect(headerVatChoiceProblem("6", ["21"])).toMatch(/BTW niet herkend/);
    expect(headerVatChoiceProblem("21", ["9", "21"])).toBe(
      "Het btw-percentage van de factuur (21%) past niet bij de boekingsregels (9%, 21%); kies Gemengd.",
    );
    expect(headerVatChoiceProblem("21", ["0"])).toBe(
      "Het btw-percentage van de factuur (21%) past niet bij de boekingsregels (0%).",
    );
    expect(headerVatChoiceProblem(HEADER_VAT_MIXED, ["21", "21"])).toMatch(/Gemengd past alleen/);
  });
  it("een regel zonder keuze telt hier niet mee (die heeft haar eigen blokkade)", () => {
    expect(headerVatChoiceProblem("21", ["21", ""])).toBeNull();
  });
});
