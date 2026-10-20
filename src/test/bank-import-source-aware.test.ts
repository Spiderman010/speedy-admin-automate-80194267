import { describe, expect, it } from "vitest";
import {
  detectDuplicates,
  importFingerprints,
  parseBankStatementFull,
  referenceIdsFor,
  storedReferenceSource,
  type ExistingBankTransactionForDuplicates,
  type ParsedTransaction,
} from "@/lib/bank-statement-parser";

/**
 * Bronformaat-afhankelijke referenties en de importvingerafdruk.
 *
 * Productievorm (alleen-lezen steekproef, 200 open regels, oktober 2026): elke
 * regel komt uit MT940 en heeft een referentie "NONREF//<bankreferentie>" of
 * "NOTPROVIDED//<bankreferentie>"; alle 200 bankreferenties zijn verschillend.
 * Er zijn groepen van 2–5 verschillende betalingen met dezelfde datum, hetzelfde
 * bedrag en dezelfde tegenrekening, en één groep van drie die op alles gelijk
 * is behalve de bankreferentie.
 */

// Productievormige MT940 (fictieve waarden): drie gelijke betalingen, alleen de bankreferentie verschilt.
const MT940 = `:20:940S261002
:25:NL91INGB0001234567
:28C:00275
:60F:C261001EUR1000,00
:61:2610021002D12,50N544NONREF//B6J02XY0000001
:86:/CNTP/NL02ABNA0123456789/ABNANL2A/Parkeergarage Centrum///REMI/USTD//Parkeren/
:61:2610021002D12,50N544NONREF//B6J02XY0000002
:86:/CNTP/NL02ABNA0123456789/ABNANL2A/Parkeergarage Centrum///REMI/USTD//Parkeren/
:61:2610021002D12,50N544NONREF//B6J02XY0000003
:86:/CNTP/NL02ABNA0123456789/ABNANL2A/Parkeergarage Centrum///REMI/USTD//Parkeren/
:61:2610021002C250,00N544NOTPROVIDED//B6J02XY0000004
:86:/CNTP/NL55RABO0300065264/RABONL2U/Klant BV///REMI/USTD//Factuur 2026-118/
:62F:C1212,50
`;

const asStored = (t: ParsedTransaction): ExistingBankTransactionForDuplicates => ({
  transaction_date: t.date,
  amount: t.amount,
  description: t.description,
  counter_account: t.counterAccount,
  reference: t.reference,
});

describe("referenties per bronformaat", () => {
  it("MT940: de bankreferentie na '//' is de sleutel; NONREF/NOTPROVIDED ervoor telt niet", () => {
    const [t] = parseBankStatementFull(MT940).transactions;
    expect(t.source).toBe("mt940");
    expect(t.bankReference).toMatch(/^B6J02XY000000\d$/);
    expect(referenceIdsFor({ reference: "NONREF//B6J02XY0000001", source: "mt940" })).toEqual({ bank: "B6J02XY0000001", owners: [] });
    expect(referenceIdsFor({ reference: "NTRFABC123//B6J02", source: "mt940" })).toEqual({ bank: "B6J02", owners: ["ABC123"] });
  });

  it("CAMT: de EndToEndId blijft zoals hij is — ook als hij met een SWIFT-code begint", () => {
    expect(referenceIdsFor({ reference: "NTRFABC123", source: "camt053" })).toEqual({ bank: null, owners: ["NTRFABC123"] });
    expect(referenceIdsFor({ reference: "NTRFABC123", source: "camt053", bankReference: "2026100212345" }).bank).toBe("2026100212345");
  });

  it("een opgeslagen regel zonder formaatkenmerk accepteert beide lezingen (historische herimport)", () => {
    expect(storedReferenceSource({ ...asStored(parseBankStatementFull(MT940).transactions[0]) })).toBe("mt940");
    expect(storedReferenceSource({ transaction_date: "2026-10-02", amount: 1, description: null, counter_account: null, reference: "E2E-1", camt_ustrd: "x" })).toBe("camt053");
    expect(storedReferenceSource({ transaction_date: "2026-10-02", amount: 1, description: null, counter_account: null, reference: "NTRFABC123" })).toBe("unknown");
    expect(referenceIdsFor({ reference: "NTRFABC123", source: "unknown" }).owners).toEqual(["NTRFABC123", "ABC123"]);
  });
});

describe("duplicaten op productievormige data", () => {
  const parsed = parseBankStatementFull(MT940).transactions;

  it("historische herimport van hetzelfde MT940-afschrift: elke regel herkend via de bankreferentie", () => {
    expect(detectDuplicates(parsed, parsed.map(asStored))).toEqual(parsed.map(() => ({ isDuplicate: true, reason: "reference" })));
  });

  it("drie gelijke betalingen, er was er één: precies die ene is duplicaat, de andere twee blijven", () => {
    const one = parsed.filter((t) => t.bankReference === "B6J02XY0000002").map(asStored);
    const result = detectDuplicates(parsed, one);
    expect(result.filter((d) => d.isDuplicate)).toHaveLength(1);
    expect(result[parsed.findIndex((t) => t.bankReference === "B6J02XY0000002")]).toEqual({ isDuplicate: true, reason: "reference" });
  });

  it("verschillende bankreferenties zijn nooit 'mogelijk duplicaat', ook bij gelijke datum, bedrag en tegenrekening", () => {
    const anders = parsed.map((t, i) => ({ ...asStored(t), description: `anders ${i}`, reference: `NONREF//OUDE${i}` }));
    expect(detectDuplicates(parsed, anders).every((d) => !d.isDuplicate)).toBe(true);
  });

  it("de bankreferentie herkent ook buiten het datumvenster (zij is uniek per transactie)", () => {
    const later = [{ ...parsed[0], date: "2026-10-20" }];
    expect(detectDuplicates(later, [asStored(parsed[0])])).toEqual([{ isDuplicate: true, reason: "reference" }]);
  });

  it("P2: twee CAMT-referenties die alleen in een SWIFT-prefix verschillen zijn verschillende transacties", () => {
    const stored: ExistingBankTransactionForDuplicates = { transaction_date: "2026-10-02", amount: -80, description: "a", counter_account: null, reference: "ABC123", camt_ustrd: "a" };
    const incoming: ParsedTransaction = { date: "2026-10-02", amount: -80, description: "b", counterAccount: null, reference: "NTRFABC123", source: "camt053" };
    expect(detectDuplicates([incoming], [stored])[0].isDuplicate).toBe(false);
  });

  it("MT940 met typecode tegenover CAMT zonder: dezelfde betaling wordt herkend", () => {
    const stored: ExistingBankTransactionForDuplicates = { transaction_date: "2026-10-03", amount: -80, description: "camt", counter_account: null, reference: "ABC123", camt_ustrd: "camt" };
    const incoming: ParsedTransaction = { date: "2026-10-02", amount: -80, description: "mt940", counterAccount: null, reference: "NTRFABC123//B6J02", bankReference: "B6J02", source: "mt940" };
    expect(detectDuplicates([incoming], [stored])).toEqual([{ isDuplicate: true, reason: "reference" }]);
  });

  it("historisch opgeslagen zonder formaatkenmerk ('NTRFABC123') tegenover een nieuwe CAMT-import ('ABC123'): herkend", () => {
    const stored: ExistingBankTransactionForDuplicates = { transaction_date: "2026-10-02", amount: -80, description: "oud", counter_account: null, reference: "NTRFABC123" };
    const incoming: ParsedTransaction = { date: "2026-10-02", amount: -80, description: "nieuw", counterAccount: null, reference: "ABC123", source: "camt053" };
    expect(detectDuplicates([incoming], [stored])).toEqual([{ isDuplicate: true, reason: "reference" }]);
  });
});

describe("vangnet: een niet-unieke bankreferentie maakt nooit verschillende regels gelijk", () => {
  const constantBank = `:20:X
:25:NL91RABO0123456789
:28C:00001
:60F:C261001EUR100,00
:61:261002D12,50N544NONREF//CONSTANT
:86:Parkeren
:61:261002D30,00N544NONREF//CONSTANT
:86:Benzine
:61:261002D5,00N544NONREF//NONREF
:86:Koffie
:62F:C52,50
`;

  it("een placeholder achter '//' is geen bankreferentie", () => {
    expect(referenceIdsFor({ reference: "NONREF//NONREF", source: "mt940" }).bank).toBeNull();
  });

  it("een bankreferentie die in het afschrift vaker voorkomt, telt voor die regels niet; afdrukken blijven verschillend", async () => {
    const statement = parseBankStatementFull(constantBank);
    const fps = await importFingerprints(statement);
    expect(new Set(fps).size).toBe(3);
    // Een al opgeslagen andere regel met dezelfde 'bankreferentie' maakt een nieuwe regel geen duplicaat.
    const stored = [{ transaction_date: "2026-10-02", amount: -99, description: "Iets anders", counter_account: null, reference: "NONREF//CONSTANT" }];
    expect(detectDuplicates(statement.transactions, stored).every((d) => !d.isDuplicate)).toBe(true);
  });

  it("historische dubbele import (dezelfde bankreferentie twee keer opgeslagen): een herimport wordt nog steeds herkend", () => {
    const [t] = parseBankStatementFull(MT940).transactions;
    const stored = [asStored(t), asStored(t)];
    expect(detectDuplicates([t], stored)).toEqual([{ isDuplicate: true, reason: "composite" }]);
  });
});

describe("importvingerafdruk", () => {
  const statement = parseBankStatementFull(MT940);

  it("64 hex-tekens per regel, deterministisch", async () => {
    const a = await importFingerprints(statement);
    const b = await importFingerprints(parseBankStatementFull(MT940));
    expect(a).toHaveLength(statement.transactions.length);
    expect(a.every((f) => /^[0-9a-f]{64}$/.test(f))).toBe(true);
    expect(b).toEqual(a);
  });

  it("drie gelijke betalingen krijgen drie verschillende afdrukken (geen onterechte blokkade)", async () => {
    const fps = await importFingerprints(statement);
    expect(new Set(fps).size).toBe(fps.length);
  });

  it("met bankreferentie: dezelfde transactie in een ander (overlappend) afschrift van dezelfde rekening heeft dezelfde afdruk", async () => {
    const overlap = { ...statement, closingBalance: 999, transactions: [statement.transactions[1]] };
    const [fp] = await importFingerprints(overlap);
    expect((await importFingerprints(statement))).toContain(fp);
  });

  it("andere rekening ⇒ andere afdruk, ook met dezelfde bankreferentie", async () => {
    const other = await importFingerprints({ ...statement, accountIban: "NL20INGB0009876543" });
    const mine = await importFingerprints(statement);
    expect(other.some((f) => mine.includes(f))).toBe(false);
  });

  it("zonder bankreferentie: twee identieke regels in één afschrift krijgen verschillende afdrukken; hetzelfde afschrift opnieuw dezelfde", async () => {
    const plain = parseBankStatementFull(`:20:X
:25:NL91RABO0123456789
:28C:00001
:60F:C261001EUR100,00
:61:261002D12,50N544NONREF
:86:Parkeren
:61:261002D12,50N544NONREF
:86:Parkeren
:62F:C75,00
`);
    expect(plain.transactions.every((t) => !t.bankReference)).toBe(true);
    const fps = await importFingerprints(plain);
    expect(new Set(fps).size).toBe(2);
    expect(await importFingerprints(plain)).toEqual(fps);
  });
});

describe("Codex-ronde op b60c15a", () => {
  it("opgeslagen bronformaat wint: een CAMT-regel zonder CAMT-velden wordt niet meer als 'onbekend' dubbel gelezen", () => {
    const zonderVelden = { transaction_date: "2026-10-02", amount: -80, description: "x", counter_account: null, reference: "NTRFABC123" };
    expect(storedReferenceSource({ ...zonderVelden, import_source: "camt053" })).toBe("camt053");
    const incoming: ParsedTransaction = { date: "2026-10-03", amount: -80, description: "y", counterAccount: null, reference: "ABC123", source: "camt053" };
    expect(detectDuplicates([incoming], [{ ...zonderVelden, import_source: "camt053" }])[0].isDuplicate).toBe(false);
    // Zonder opgeslagen bronformaat (rij van vóór 20261020120000) blijft de dubbele lezing — bewust, voor historische herimports.
    expect(detectDuplicates([incoming], [zonderVelden])[0].isDuplicate).toBe(true);
  });

  it("dezelfde transactie uit MT940 en CAMT (CAMT leidt met de boekdatum) geeft dezelfde vingerafdruk: de valutadatum telt", async () => {
    const mt940 = parseBankStatementFull(`:20:X
:25:NL91INGB0001234567
:28C:00001
:60F:C261001EUR100,00
:61:2610021003D80,00N544NONREF//B6J02XY0009999
:86:Verzekering
:62F:C20,00
`);
    const camt = parseBankStatementFull(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Acct><Id><IBAN>NL91INGB0001234567</IBAN></Id></Acct>
<Ntry><Amt Ccy="EUR">80.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-03</Dt></BookgDt><ValDt><Dt>2026-10-02</Dt></ValDt>
<AcctSvcrRef>B6J02XY0009999</AcctSvcrRef><AddtlNtryInf>Verzekering</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`);
    expect(camt.transactions[0]).toMatchObject({ date: "2026-10-03", valueDate: "2026-10-02", bankReference: "B6J02XY0009999", source: "camt053" });
    const [a] = await importFingerprints(mt940);
    const [b] = await importFingerprints(camt);
    expect(a).toBe(b);
  });

  it("een bankreferentie die al bij een opgeslagen regel met een ander bedrag hoort: het afschrift vertrouwt zijn bankreferenties niet", async () => {
    const statement = parseBankStatementFull(MT940);
    const stored = [{ transaction_date: "2026-09-02", amount: -999, description: "vorige maand", counter_account: null, reference: "NONREF//B6J02XY0000001" }];
    const trusted = await importFingerprints(statement);
    const distrusted = await importFingerprints(statement, stored);
    // Geen enkele regel gebruikt dan nog de bankreferentie-afdruk, ook de regels met een andere referentie niet.
    expect(distrusted.some((f) => trusted.includes(f))).toBe(false);
    expect(new Set(distrusted).size).toBe(distrusted.length);
    // En de duplicaatcontrole ziet de regel niet als dezelfde transactie.
    expect(detectDuplicates([statement.transactions[0]], stored)[0].isDuplicate).toBe(false);
  });

  it("één herhaalde bankreferentie in het afschrift: geen enkele regel van dat afschrift gebruikt de bankreferentie", async () => {
    const herhaald = parseBankStatementFull(MT940.replace("B6J02XY0000002", "B6J02XY0000001"));
    const normaal = await importFingerprints(parseBankStatementFull(MT940));
    const fps = await importFingerprints(herhaald);
    // Regel 3 en 4 hebben nog een eigen, unieke bankreferentie, maar krijgen toch de afschrift-afdruk.
    expect(fps.some((f) => normaal.includes(f))).toBe(false);
  });
});


describe("Codex-ronde op 427204f: de CAMT-bankreferentie wordt bewaard", () => {
  const CAMT_REGEL = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Acct><Id><IBAN>NL91INGB0001234567</IBAN></Id></Acct>
<Ntry><Amt Ccy="EUR">80.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-05</Dt></BookgDt><ValDt><Dt>2026-10-02</Dt></ValDt>
<AcctSvcrRef>B6J02XY0009999</AcctSvcrRef><NtryDtls><TxDtls><Refs><EndToEndId>POLIS-77</EndToEndId></Refs>
<RmtInf><Ustrd>Premie oktober</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
  // Hetzelfde, nu als MT940: andere datum (valutadatum), andere omschrijving, geen tegenrekening.
  const MT940_REGEL = `:20:X
:25:NL91INGB0001234567
:28C:00001
:60F:C261001EUR100,00
:61:2610021002D80,00N544NONREF//B6J02XY0009999
:86:Verzekering
:62F:C20,00
`;

  /** Zoals de import een CAMT-regel opslaat (Bank.tsx handleImport). */
  const opgeslagenCamt = (bewaarBankReferentie: boolean): ExistingBankTransactionForDuplicates => {
    const [t] = parseBankStatementFull(CAMT_REGEL).transactions;
    return {
      ...asStored(t),
      import_source: "camt053",
      camt_ustrd: t.ustrd ?? null,
      ...(bewaarBankReferentie ? { bank_reference: t.bankReference ?? null } : {}),
    };
  };

  it("met bewaarde bankreferentie: dezelfde betaling als MT940 opnieuw ingelezen is een duplicaat", () => {
    const [mt] = parseBankStatementFull(MT940_REGEL).transactions;
    const stored = opgeslagenCamt(true);
    // Geen van de zwakkere sleutels zou hem vinden: datum, omschrijving en tegenrekening verschillen of ontbreken.
    expect(stored.transaction_date).not.toBe(mt.date);
    expect(mt.counterAccount).toBeNull();
    expect(detectDuplicates([mt], [stored])[0]).toEqual({ isDuplicate: true, reason: "reference" });
  });

  it("zonder bewaarde bankreferentie (rij van vóór de migratie) wordt hij niet herkend — het gedocumenteerde restrisico", () => {
    const [mt] = parseBankStatementFull(MT940_REGEL).transactions;
    expect(detectDuplicates([mt], [opgeslagenCamt(false)])[0].isDuplicate).toBe(false);
  });

  it("een bewaarde bankreferentie die verschilt, bewijst een andere transactie", () => {
    const [mt] = parseBankStatementFull(MT940_REGEL.replace("B6J02XY0009999", "B6J02XY0001111")).transactions;
    expect(detectDuplicates([mt], [opgeslagenCamt(true)])[0].isDuplicate).toBe(false);
  });

  it("een placeholder als bewaarde bankreferentie telt niet", () => {
    const stored = { ...opgeslagenCamt(true), bank_reference: "NOTPROVIDED" };
    expect(referenceIdsFor({ reference: stored.reference, source: "camt053", bankReference: stored.bank_reference }).bank).toBeNull();
  });
});
