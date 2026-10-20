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

  it("een echte referentie blijft, genormaliseerd zodat MT940 en CAMT overeenkomen", () => {
    expect(identifyingBankReference(" E2E-2026-0042 ")).toBe("E2E-2026-0042");
    expect(identifyingBankReference("e2e-2026-0042")).toBe("E2E-2026-0042");
    // MT940 met ING-typecode en bankreferentie ⇔ CAMT EndToEndId.
    expect(identifyingBankReference("NTRFABC123//B6C02XY0001")).toBe("ABC123");
    expect(identifyingBankReference("ABC123")).toBe("ABC123");
    // Alleen een bankreferentie achter NONREF is geen referentie van de opdrachtgever.
    expect(identifyingBankReference("NONREF//B6C02XY0001")).toBeNull();
    // Alleen echte SWIFT-typecodes worden gestript; een referentie die toevallig zo begint niet.
    expect(identifyingBankReference("NOTA2026-01")).toBe("NOTA2026-01");
    expect(identifyingBankReference("NDDTPOLIS123")).toBe("POLIS123");
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

describe("detectDuplicates — reviewbevindingen", () => {
  it("ING-typecodes: de parser levert 'NTRFNONREF', en ook dat is geen referentie", () => {
    const parsed = parseBankStatementFull(`:20:ING
:25:NL91INGB0001234567
:28C:00001
:60F:C260301EUR500,00
:61:2603020302D12,50NTRFNONREF
:86:Parkeren Centrum
:61:2603030303D99,00NMSCNONREF
:86:Kosten betaalpakket
:62F:C388,50
`).transactions;
    expect(parsed.map((t) => t.reference).sort()).toEqual(["NMSCNONREF", "NTRFNONREF"]);
    expect(identifyingBankReference("NTRFNONREF")).toBeNull();
    expect(identifyingBankReference("NDDT NOTPROVIDED".replace(" ", ""))).toBeNull();
    // Een andere, al opgeslagen NTRFNONREF-regel maakt deze niet tot duplicaat.
    const existing = [stored({ reference: "NTRFNONREF", description: "Huur", amount: -950, transaction_date: "2026-02-02" })];
    expect(detectDuplicates(parsed, existing).every((d) => !d.isDuplicate)).toBe(true);
  });

  it("een vaste incassoreferentie (polisnummer) maakt de betaling van volgende maand geen duplicaat", () => {
    const existing = [stored({ reference: "POLIS123", amount: -12.5, transaction_date: "2026-01-02", description: "Verzekering jan" })];
    const volgendeMaand = [tx({ reference: "POLIS123", amount: -12.5, date: "2026-02-02", description: "Verzekering feb" })];
    expect(detectDuplicates(volgendeMaand, existing)[0].isDuplicate).toBe(false);
    const volgendeWeek = [tx({ reference: "POLIS123", amount: -12.5, date: "2026-01-09", description: "Verzekering jan" })];
    expect(detectDuplicates(volgendeWeek, existing)[0].isDuplicate).toBe(false);
    const paarDagenLater = [tx({ reference: "POLIS123", amount: -12.5, date: "2026-01-05", description: "Verzekering jan" })];
    expect(detectDuplicates(paarDagenLater, existing)).toEqual([{ isDuplicate: true, reason: "reference" }]);
  });

  it("oude regel met overschreven omschrijving: zelfde datum, bedrag en tegenrekening ⇒ 'mogelijk duplicaat' (uitgevinkt)", () => {
    const existing = [stored({ reference: "NONREF", description: "Bankkosten jan", counter_account: "NL02ABNA0123456789" })];
    const incoming = [tx({ reference: "NONREF", description: "Kosten betaalpakket", counterAccount: "NL02 ABNA 0123 4567 89" })];
    expect(detectDuplicates(incoming, existing)).toEqual([{ isDuplicate: true, reason: "possible" }]);
  });

  it("dezelfde betaling uit MT940 (NTRFABC123) en CAMT (ABC123) wordt als duplicaat herkend", () => {
    const existing = [stored({ reference: "ABC123", amount: -80, transaction_date: "2026-03-02", description: "camt tekst" })];
    const incoming = [tx({ reference: "NTRFABC123//B6C02", amount: -80, date: "2026-03-01", description: "mt940 tekst" })];
    expect(detectDuplicates(incoming, existing)).toEqual([{ isDuplicate: true, reason: "reference" }]);
  });

  it("zonder tegenrekening is er geen 'mogelijk duplicaat': twee kaartbetalingen van hetzelfde bedrag blijven allebei", () => {
    const existing = [stored({ description: "BEA Albert Heijn", counter_account: null })];
    const incoming = [tx({ description: "BEA Jumbo", counterAccount: null })];
    expect(detectDuplicates(incoming, existing)).toEqual([{ isDuplicate: false, reason: null }]);
  });

  it("een zwakke match van een eerdere regel pakt nooit de opgeslagen regel die een latere regel exact matcht", () => {
    const existing = [stored({ description: "Parkeren Centrum" })];
    const incoming = [tx({ description: "Parkeren Noord" }), tx({ description: "Parkeren Centrum" })];
    expect(detectDuplicates(incoming, existing)).toEqual([
      { isDuplicate: false, reason: null },
      { isDuplicate: true, reason: "composite" },
    ]);
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
