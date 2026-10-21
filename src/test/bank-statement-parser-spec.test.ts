import { describe, expect, it } from "vitest";
import {
  accountCheckBlocker,
  checkStatementAccount,
  parseBankStatementFull,
  statementImportBlockers,
} from "@/lib/bank-statement-parser";

/**
 * Nulmeting A1-13 (P0), F1a-N3 (P1), A1-14 (P1): de MT940-parser volgens SWIFT
 * veld 61, CAMT.053 met CdtDbtInd/RvslInd, de saldocontrole per afschrift, de
 * valuta en het aantal rekeningen. Een regel die niet gelezen kan worden, is
 * nooit stil weg: hij staat met zijn ruwe tekst in `errors` en blokkeert.
 */

const mt940 = (lines61: string[], opts: { opening?: string; closing?: string; account?: string; currency?: string } = {}) =>
  [
    ":20:STARTUMS",
    `:25:${opts.account ?? "NL91ABNA0417164300"}`,
    ":28C:00001",
    `:60F:C261001${opts.currency ?? "EUR"}${opts.opening ?? "1000,00"}`,
    ...lines61.flatMap((l, i) => [l, `:86:/NAME/Regel ${i + 1}/REMI/test`]),
    `:62F:C261002${opts.currency ?? "EUR"}${opts.closing ?? "1000,00"}`,
    "-",
  ].join("\n");

const byRef = (text: string) =>
  Object.fromEntries(parseBankStatementFull(text).transactions.map((t) => [t.bankReference, t.amount]));

describe("MT940 :61: — D/C-markering, storno's, boekdatum en fondscode (A1-13, F1a-N3)", () => {
  it("RC (terugboeking van een credit) is geld uit, RD (terugboeking van een debet) is geld in", () => {
    const text = mt940([":61:261002RC100,00NTRFNONREF//B1", ":61:261002RD40,00NTRFNONREF//B2"], { closing: "940,00" });
    const st = parseBankStatementFull(text);
    expect(byRef(text)).toEqual({ B1: -100, B2: 40 });
    expect(st.transactions.every((t) => t.isReversal === true)).toBe(true);
    expect(st.errors).toEqual([]);
    expect(statementImportBlockers(st)).toEqual([]);
  });

  it("met boekdatum (MMDD) verdwijnt een RC- of RD-regel niet meer", () => {
    const text = mt940(
      [":61:2610021002D25,00NTRFNONREF//B3", ":61:2610021002RC100,00NTRFNONREF//B4", ":61:2610021002RD40,00NTRFNONREF//B5"],
      { closing: "915,00" },
    );
    expect(byRef(text)).toEqual({ B3: -25, B4: -100, B5: 40 });
    expect(statementImportBlockers(parseBankStatementFull(text))).toEqual([]);
  });

  it("een fondscode (subveld 4, 'R' voor EUR) breekt het bedrag niet meer: DR, CR en RCR", () => {
    const text = mt940(
      [
        ":61:2610021002D25,00NTRFNONREF//F1",
        ":61:2610021002DR583,92NMSC1110030403010139//F2",
        ":61:2610021002CR100,00NTRFNONREF//F3",
        ":61:2610021002RCR50,00N544NONREF//F4",
      ],
      { closing: "441,08" },
    );
    const st = parseBankStatementFull(text);
    expect(byRef(text)).toEqual({ F1: -25, F2: -583.92, F3: 100, F4: -50 });
    expect(st.fundsCodes).toEqual(["R"]);
    expect(statementImportBlockers(st)).toEqual([]);
  });

  it("referentie, bankreferentie, datum en valutadatum zijn dezelfde velden als voorheen", () => {
    const st = parseBankStatementFull(mt940([":61:2610021003D80,00N544NONREF//B6J02XY0009999"], { closing: "920,00" }));
    const [t] = st.transactions;
    expect(t).toMatchObject({
      date: "2026-10-02",
      valueDate: "2026-10-02",
      amount: -80,
      reference: "NONREF//B6J02XY0009999",
      bankReference: "B6J02XY0009999",
      source: "mt940",
      description: "/NAME/Regel 1/REMI/test",
    });
    expect(t.isReversal).toBeUndefined();
    expect(st.openingBalance).toBe(1000);
    expect(st.closingBalance).toBe(920);
    expect(st.accountIban).toBe("NL91ABNA0417164300");
  });

  it("een niet-herkende :61:-regel wordt een zichtbare fout met de ruwe regel en het regelnummer, en blokkeert", () => {
    const text = mt940([":61:2610021002D10,00NTRFNONREF//OK", ":61:2610021002X12,00NTRFNONREF//X1"], { closing: "990,00" });
    const st = parseBankStatementFull(text);
    expect(st.transactions.map((t) => t.bankReference)).toEqual(["OK"]);
    expect(st.errors).toEqual([
      expect.objectContaining({ lineNumber: 7, raw: ":61:2610021002X12,00NTRFNONREF//X1" }),
    ]);
    const blockers = statementImportBlockers(st);
    expect(blockers.map((b) => b.kind)).toEqual(["unreadable"]);
    expect(blockers[0].details[0]).toContain("Regel 7: :61:2610021002X12,00NTRFNONREF//X1");
  });

  it("een ongeldige datum of een bedrag met drie decimalen is evenmin stil weg", () => {
    const st = parseBankStatementFull(
      mt940([":61:2613021302D10,00NTRFNONREF//M13", ":61:261002D10,005NTRFNONREF//DEC3"], { closing: "980,00" }),
    );
    expect(st.transactions).toEqual([]);
    expect(st.errors.map((e) => e.raw)).toEqual([
      ":61:2613021302D10,00NTRFNONREF//M13",
      ":61:261002D10,005NTRFNONREF//DEC3",
    ]);
    expect(st.errors[0].reason).toMatch(/valutadatum/);
    expect(st.errors[1].reason).toMatch(/decimalen/);
  });
});

describe("MT940 — saldocontrole per afschrift", () => {
  it("beginsaldo + Σ bedragen ≠ eindsaldo blokkeert, met de bedragen en het verschil", () => {
    // Een storno die als +100 werd gelezen, gaf precies dit verschil (2 × 100).
    const st = parseBankStatementFull(mt940([":61:261002D12,50NTRFNONREF//S1"], { closing: "1000,00" }));
    const blockers = statementImportBlockers(st);
    expect(blockers.map((b) => b.kind)).toEqual(["balance"]);
    expect(blockers[0].details[0]).toMatch(/beginsaldo €\s1\.000,00 \+ 1 mutatie\(s\) €\s-12,50 = €\s987,50, maar het eindsaldo is €\s1\.000,00 \(verschil €\s12,50\)/);
  });

  it("meerdere pagina's (:60M:/:62M:) worden per pagina gecontroleerd", () => {
    const text = [
      ":20:STARTUMS", ":25:NL91ABNA0417164300", ":28C:00001/1",
      ":60F:C261001EUR100,00",
      ":61:2610011001D10,00NTRFNONREF//P1", ":86:een",
      ":62M:C261001EUR90,00",
      ":20:STARTUMS", ":25:NL91ABNA0417164300", ":28C:00001/2",
      ":60M:C261001EUR90,00",
      ":61:2610011001C5,00NTRFNONREF//P2", ":86:twee",
      ":62F:C261001EUR90,00",
      "-",
    ].join("\n");
    const st = parseBankStatementFull(text);
    expect(st.sections.map((s) => [s.openingBalance, s.totalCents, s.closingBalance])).toEqual([[100, -1000, 90], [90, 500, 90]]);
    const blockers = statementImportBlockers(st);
    expect(blockers.map((b) => b.kind)).toEqual(["balance"]);
    expect(blockers[0].details).toHaveLength(1);
    expect(blockers[0].details[0]).toMatch(/^Afschrift 2 \(NL91ABNA0417164300\)/);
  });

  it("zonder eindsaldo is de volledigheid niet te controleren: geblokkeerd", () => {
    const text = [":20:X", ":25:NL91ABNA0417164300", ":60F:C261001EUR100,00", ":61:261002D10,00NTRFNONREF//Z", ":86:z", "-"].join("\n");
    const blockers = statementImportBlockers(parseBankStatementFull(text));
    expect(blockers.map((b) => b.kind)).toEqual(["balance"]);
    expect(blockers[0].details[0]).toMatch(/eindsaldo ontbreekt/);
  });
});

describe("MT940 — valuta en rekeningen (A1-14)", () => {
  it("een ander valuta dan EUR blokkeert", () => {
    const st = parseBankStatementFull(mt940([":61:2610021002C99,99NTRFNONREF//U1"], { currency: "USD", closing: "1099,99" }));
    expect(st.currencies).toEqual(["USD"]);
    expect(statementImportBlockers(st).map((b) => b.kind)).toEqual(["currency"]);
  });

  it("een fondscode die niet bij EUR hoort, blokkeert ook", () => {
    const st = parseBankStatementFull(mt940([":61:2610021002CD99,99NTRFNONREF//U2"], { closing: "1099,99" }));
    expect(st.transactions[0].amount).toBe(99.99);
    expect(statementImportBlockers(st).map((b) => b.kind)).toEqual(["currency"]);
  });

  it("zonder enige valutacode is de valuta onbekend: geblokkeerd", () => {
    const text = [":20:X", ":25:NL91ABNA0417164300", ":60F:C100,00", ":61:261002D10,00NTRFNONREF//Q", ":86:q", ":62F:C90,00", "-"].join("\n");
    const blockers = statementImportBlockers(parseBankStatementFull(text));
    expect(blockers.map((b) => b.kind)).toEqual(["currency"]);
    expect(blockers[0].message).toMatch(/onbekend/);
  });

  it("afschriften van twee rekeningen in één bestand blokkeren", () => {
    const one = mt940([":61:261002D10,00NTRFNONREF//A1"], { closing: "990,00" });
    const two = mt940([":61:261002D10,00NTRFNONREF//A2"], { closing: "990,00", account: "NL02RABO0123456789EUR" });
    const st = parseBankStatementFull(`${one}\n${two}`);
    expect(st.accounts).toEqual(["NL91ABNA0417164300", "NL02RABO0123456789"]);
    expect(st.accountIban).toBe("NL91ABNA0417164300");
    expect(statementImportBlockers(st).map((b) => b.kind)).toEqual(["accounts"]);
  });
});

const camt = (stmts: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>${stmts}</BkToCstmrStmt></Document>`;
const bal = (code: string, amount: string, ind = "CRDT", ccy = "EUR") =>
  `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="${ccy}">${amount}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Dt><Dt>2026-10-01</Dt></Dt></Bal>`;
const ntry = (amount: string, ind: string | null, extra = "", ccy = "EUR", date = "<BookgDt><Dt>2026-10-02</Dt></BookgDt>") =>
  `<Ntry><Amt Ccy="${ccy}">${amount}</Amt>${ind === null ? "" : `<CdtDbtInd>${ind}</CdtDbtInd>`}${extra}<Sts>BOOK</Sts>${date}<AcctSvcrRef>REF-${amount}-${ind}</AcctSvcrRef></Ntry>`;
const stmt = (iban: string, body: string) => `<Stmt><Id>S1</Id><Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>EUR</Ccy></Acct>${body}</Stmt>`;

describe("CAMT.053 — CdtDbtInd en RvslInd, saldi, valuta, rekeningen", () => {
  it("het teken volgt CdtDbtInd, ook bij een terugboeking; RvslInd markeert de storno", () => {
    const text = camt(stmt("NL91ABNA0417164300",
      bal("OPBD", "1000.00") +
      ntry("100.00", "DBIT", "<RvslInd>true</RvslInd>") + // teruggedraaide ontvangst: geld uit
      ntry("40.00", "CRDT", "<RvslInd>true</RvslInd>") + // teruggedraaide betaling: geld in
      ntry("12.50", "DBIT") +
      bal("CLBD", "927.50")));
    const st = parseBankStatementFull(text);
    expect(st.transactions.map((t) => [t.amount, t.isReversal ?? false]).sort()).toEqual([[-100, true], [-12.5, false], [40, true]].sort());
    expect(st.errors).toEqual([]);
    expect(statementImportBlockers(st)).toEqual([]);
  });

  it("zonder CdtDbtInd wordt een bedrag niet stil een bijschrijving, maar een fout die blokkeert", () => {
    const st = parseBankStatementFull(camt(stmt("NL91ABNA0417164300", bal("OPBD", "100.00") + ntry("10.00", null) + bal("CLBD", "90.00"))));
    expect(st.transactions).toEqual([]);
    expect(st.errors[0].reason).toMatch(/CdtDbtInd/);
    expect(st.errors[0].raw).toContain("<Amt Ccy=\"EUR\">10.00</Amt>");
    expect(statementImportBlockers(st).map((b) => b.kind)).toEqual(["unreadable", "balance"]);
  });

  it("een onleesbaar bedrag of een ontbrekende datum is een fout, geen weggelaten regel", () => {
    const st = parseBankStatementFull(camt(stmt("NL91ABNA0417164300",
      bal("OPBD", "100.00") + ntry("12,50", "DBIT") + ntry("5.00", "DBIT", "", "EUR", "") + bal("CLBD", "100.00"))));
    expect(st.errors.map((e) => e.reason)).toEqual([expect.stringMatching(/Bedrag "12,50"/), expect.stringMatching(/datum ontbreken/)]);
  });

  it("een datum die alleen als tijdstip (DtTm) staat, wordt gelezen", () => {
    const st = parseBankStatementFull(camt(stmt("NL91ABNA0417164300",
      bal("OPBD", "100.00") + ntry("5.00", "DBIT", "", "EUR", "<BookgDt><DtTm>2026-10-03T08:00:00</DtTm></BookgDt>") + bal("CLBD", "95.00"))));
    expect(st.transactions.map((t) => t.date)).toEqual(["2026-10-03"]);
    expect(statementImportBlockers(st)).toEqual([]);
  });

  it("saldocontrole per <Stmt>, ook met PRCD als beginsaldo", () => {
    const ok = parseBankStatementFull(camt(stmt("NL91ABNA0417164300", bal("PRCD", "50.00") + ntry("20.00", "CRDT") + bal("CLBD", "70.00"))));
    expect(ok.sections[0]).toMatchObject({ openingBalance: 50, closingBalance: 70, totalCents: 2000 });
    expect(statementImportBlockers(ok)).toEqual([]);
    const off = parseBankStatementFull(camt(stmt("NL91ABNA0417164300", bal("OPBD", "50.00") + ntry("20.00", "CRDT") + bal("CLBD", "50.00"))));
    expect(statementImportBlockers(off).map((b) => b.kind)).toEqual(["balance"]);
  });

  it("twee <Stmt> van verschillende rekeningen blokkeren; het rekening-IBAN komt uit Acct, niet van een tegenpartij", () => {
    const text = camt(
      stmt("NL01BANK0000000001", bal("OPBD", "0.00") + ntry("10.00", "CRDT") + bal("CLBD", "10.00")) +
      stmt("NL02BANK0000000002", bal("OPBD", "0.00") + ntry("20.00", "DBIT") + bal("CLBD", "20.00", "DBIT")),
    );
    const st = parseBankStatementFull(text);
    expect(st.accounts).toEqual(["NL01BANK0000000001", "NL02BANK0000000002"]);
    expect(st.accountIban).toBe("NL01BANK0000000001");
    expect(statementImportBlockers(st).map((b) => b.kind)).toEqual(["accounts"]);
  });

  it("een bedrag in een andere valuta blokkeert", () => {
    const st = parseBankStatementFull(camt(stmt("NL91ABNA0417164300", bal("OPBD", "0.00") + ntry("10.00", "CRDT", "", "USD") + bal("CLBD", "10.00"))));
    expect(st.currencies.sort()).toEqual(["EUR", "USD"]);
    expect(statementImportBlockers(st).map((b) => b.kind)).toEqual(["currency"]);
  });

  it("geen <Stmt> (geen rekeningafschrift) of kapotte XML: een fout, nooit 'geen transacties'", () => {
    const ntfctn = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02"><BkToCstmrDbtCdtNtfctn><Ntfctn>${ntry("1.00", "CRDT")}</Ntfctn></BkToCstmrDbtCdtNtfctn></Document>`;
    const a = parseBankStatementFull(ntfctn);
    expect(a.errors.map((e) => e.reason)).toEqual([expect.stringMatching(/Geen <Stmt>/), expect.stringMatching(/buiten een <Stmt>/)]);
    const b = parseBankStatementFull(`<?xml version="1.0"?><Document><BkToCstmrStmt><Stmt>`);
    expect(b.errors[0].reason).toMatch(/XML/);
    expect(statementImportBlockers(b).map((x) => x.kind)).toEqual(["unreadable"]);
  });
});

describe("rekeningcontrole tegen de administraties (A1-14, D-05)", () => {
  const A = { id: "a", name: "Klant A", ibans: ["NL91 RABO 0123 4567 89"] };
  const B = { id: "b", name: "Klant B", ibans: [] as string[] };
  const C = { id: "c", name: "Klant C", ibans: ["NL02ABNA0123456789"] };
  const st = { accountIban: "NL91RABO0123456789" };

  it("het IBAN hoort bij de gekozen administratie", () => {
    expect(checkStatementAccount(st, A, [A, B, C])).toEqual({ status: "match", iban: "NL91RABO0123456789" });
  });

  it("het IBAN hoort bij een andere administratie: geblokkeerd, met de naam van die administratie", () => {
    const check = checkStatementAccount(st, B, [A, B, C]);
    expect(check).toEqual({ status: "other_administration", iban: "NL91RABO0123456789", administrations: ["Klant A"] });
    expect(accountCheckBlocker(check, "Klant B")!.message).toMatch(/hoort bij Klant A, niet bij Klant B/);
    expect(accountCheckBlocker(checkStatementAccount(st, A, [A, B, C]), "Klant A")).toBeNull();
  });

  it("geen IBAN vastgelegd en het IBAN is onbekend: expliciete bevestiging nodig", () => {
    expect(checkStatementAccount(st, B, [B, C])).toEqual({ status: "confirm", iban: "NL91RABO0123456789", reason: "no_client_iban", administrations: [] });
  });

  it("een ander vastgelegd IBAN, en ook nergens anders bekend: expliciete bevestiging", () => {
    expect(checkStatementAccount(st, C, [B, C])).toMatchObject({ status: "confirm", reason: "different_iban" });
  });

  it("geen herkenbaar IBAN in het afschrift, of hetzelfde IBAN bij twee administraties: bevestiging", () => {
    expect(checkStatementAccount({ accountIban: null }, A, [A])).toMatchObject({ status: "confirm", reason: "no_statement_iban" });
    const A2 = { id: "a2", name: "Klant A2", ibans: ["NL91RABO0123456789"] };
    expect(checkStatementAccount(st, A, [A, A2])).toMatchObject({ status: "confirm", reason: "shared_iban", administrations: ["Klant A2"] });
  });
});
