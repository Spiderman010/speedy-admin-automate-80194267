import { describe, expect, it } from "vitest";
import {
  detectDuplicates,
  hasBankDescription,
  identifyingBankReference,
  parseBankStatementFull,
  type ParsedTransaction,
} from "@/lib/bank-statement-parser";

/**
 * Bankimport — geen dubbele én geen ontbrekende transacties.
 *
 * bank_transactions heeft geen database-uniciteit; detectDuplicates() is de
 * enige rem op een tweede kopie van een afschrift (en daarmee op een tweede
 * boeking). Hij mag ook niet te streng zijn: een echte nieuwe transactie die
 * als "duplicaat" wordt uitgevinkt, ontbreekt stil in de administratie.
 */

const tx = (over: Partial<ParsedTransaction>): ParsedTransaction => ({
  date: "2026-03-02",
  amount: -12.5,
  description: "Parkeren Centrum",
  counterAccount: null,
  reference: null,
  ...over,
});

const stored = (over: Partial<{ transaction_date: string; amount: number; description: string | null; counter_account: string | null; reference: string | null }>) => ({
  transaction_date: "2026-03-02",
  amount: -12.5,
  description: "Parkeren Centrum",
  counter_account: null,
  reference: null,
  ...over,
});

describe("identifyingBankReference", () => {
  it("bankplaceholders identificeren niets: NONREF (MT940) en NOTPROVIDED (CAMT), ongeacht hoofdletters en spaties", () => {
    for (const ref of ["NONREF", " nonref ", "NOTPROVIDED", "NOT PROVIDED", "", "   ", null, undefined]) {
      expect(identifyingBankReference(ref), String(ref)).toBeNull();
    }
  });

  it("een echte referentie blijft, getrimd; ook NONREF met bankreferentie erachter", () => {
    expect(identifyingBankReference(" E2E-2026-0042 ")).toBe("E2E-2026-0042");
    expect(identifyingBankReference("NONREF//B6C02XY0001")).toBe("NONREF//B6C02XY0001");
  });
});

describe("detectDuplicates — niet te streng", () => {
  it("NONREF maakt een nieuwe transactie geen duplicaat (Rabobank/ING/ABN AMRO zetten het bij bijna elke regel)", () => {
    const existing = [stored({ reference: "NONREF", description: "Huur maart", amount: -950 })];
    const incoming = [tx({ reference: "NONREF", description: "Bol.com bestelling", amount: -23.99 })];
    expect(detectDuplicates(incoming, existing)).toEqual([{ isDuplicate: false, reason: null }]);
  });

  it("NOTPROVIDED in CAMT werkt hetzelfde", () => {
    const existing = [stored({ reference: "NOTPROVIDED", amount: -10 })];
    const incoming = [tx({ reference: "NOTPROVIDED", amount: -99 })];
    expect(detectDuplicates(incoming, existing)[0].isDuplicate).toBe(false);
  });

  it("dezelfde referentie met een ander bedrag is geen duplicaat", () => {
    const existing = [stored({ reference: "E2E-1", amount: -100 })];
    const incoming = [tx({ reference: "E2E-1", amount: -250 })];
    expect(detectDuplicates(incoming, existing)[0].isDuplicate).toBe(false);
  });

  it("één-op-één: van twee gelijke betalingen op één dag is er maar één al geïmporteerd ⇒ de tweede blijft geselecteerd", () => {
    const existing = [stored({})];
    const incoming = [tx({}), tx({})];
    expect(detectDuplicates(incoming, existing)).toEqual([
      { isDuplicate: true, reason: "composite" },
      { isDuplicate: false, reason: null },
    ]);
  });

  it("twee verschillende échte referenties bewijzen twee transacties, hoe gelijk de rest ook is", () => {
    const existing = [stored({ reference: "E2E-A" })];
    const incoming = [tx({ reference: "E2E-B" })];
    expect(detectDuplicates(incoming, existing)[0].isDuplicate).toBe(false);
  });

  it("een opgeslagen regel die al via zijn referentie is 'verbruikt', verklaart geen tweede regel via de terugvalsleutel", () => {
    const existing = [stored({ reference: "E2E-1" })];
    const incoming = [tx({ reference: "E2E-1" }), tx({ reference: null })];
    expect(detectDuplicates(incoming, existing)).toEqual([
      { isDuplicate: true, reason: "reference" },
      { isDuplicate: false, reason: null },
    ]);
  });
});

describe("detectDuplicates — niet te los", () => {
  it("hetzelfde afschrift opnieuw importeren: elke regel is een duplicaat", () => {
    const statement = parseBankStatementFull(`:20:STARTUMS
:25:NL91RABO0123456789
:28C:00001
:60F:C260301EUR1000,00
:61:260302D12,50N544NONREF
:86:Parkeren Centrum
:61:260302D12,50N544NONREF
:86:Parkeren Centrum
:61:260303C500,00N541NONREF
:86:Factuur 2026-014 klant BV /CNTP/NL02INGB0001234567
:62F:C1475,00
`);
    expect(statement.transactions).toHaveLength(3);
    const existing = statement.transactions.map((t) => ({
      transaction_date: t.date,
      amount: t.amount,
      description: t.description,
      counter_account: t.counterAccount,
      reference: t.reference,
    }));
    expect(detectDuplicates(statement.transactions, existing).every((d) => d.isDuplicate)).toBe(true);
  });

  it("dezelfde referentie en hetzelfde bedrag is een duplicaat, ook met een andere datum (valutadatum in MT940, boekdatum in CAMT)", () => {
    const existing = [stored({ reference: "E2E-9", transaction_date: "2026-03-02", amount: -80 })];
    const incoming = [tx({ reference: "E2E-9", date: "2026-03-03", amount: -80, description: "andere tekst" })];
    expect(detectDuplicates(incoming, existing)).toEqual([{ isDuplicate: true, reason: "reference" }]);
  });

  it("een opgeslagen regel zonder referentie wordt via datum/bedrag/omschrijving/tegenrekening herkend", () => {
    const existing = [stored({ reference: null, description: "  PARKEREN CENTRUM " })];
    const incoming = [tx({ reference: "E2E-NEW" })];
    expect(detectDuplicates(incoming, existing)).toEqual([{ isDuplicate: true, reason: "composite" }]);
  });
});

describe("hasBankDescription", () => {
  it("alleen echte banktekst telt; leeg en de parser-placeholder niet", () => {
    expect(hasBankDescription("Huur maart /CNTP/NL02")).toBe(true);
    expect(hasBankDescription("Geen omschrijving")).toBe(false);
    expect(hasBankDescription("   ")).toBe(false);
    expect(hasBankDescription(null)).toBe(false);
  });
});
