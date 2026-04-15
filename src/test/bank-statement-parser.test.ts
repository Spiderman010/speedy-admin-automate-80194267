import { describe, it, expect } from "vitest";
import {
  parseBankStatement,
  parseBankStatementFull,
  detectDuplicates,
  type ParsedTransaction,
} from "@/lib/bank-statement-parser";

// ─── MT940 fixtures ─────────────────────────────────────────────────
const MT940_SAMPLE = `:20:STARTUMS
:25:NL91ABNA0417164300
:28C:00000
:60F:C240101EUR1234,56
:61:240115D100,00N029NONREF
:86:Betaling aan leverancier XYZ /CNTP/NL91INGB0001234567
:61:240110C250,50N029REF123
:86:Ontvangst klant ABC
:61:240120D50,00N029NONREF2
:86:Abonnement betaling
:62F:C1335,06
`;

const MT940_BAD_BALANCE = `:20:TEST
:25:NL91ABNA0417164300
:28C:00000
:60F:C1000,00
:61:240101C100,00N029REF1
:86:test
:62F:C1200,00
`;

describe("parseBankStatement (backward compat)", () => {
  it("returns ParsedTransaction[] from MT940", () => {
    const result = parseBankStatement(MT940_SAMPLE);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(3);
    // Should have date, amount, description
    expect(result[0]).toHaveProperty("date");
    expect(result[0]).toHaveProperty("amount");
  });
});

describe("parseBankStatementFull - MT940", () => {
  it("extracts opening and closing balance", () => {
    const stmt = parseBankStatementFull(MT940_SAMPLE);
    expect(stmt.openingBalance).toBe(1234.56);
    expect(stmt.closingBalance).toBe(1335.06);
  });

  it("parses correct number of transactions", () => {
    const stmt = parseBankStatementFull(MT940_SAMPLE);
    expect(stmt.transactions.length).toBe(3);
  });

  it("sorts transactions newest first (date descending)", () => {
    const stmt = parseBankStatementFull(MT940_SAMPLE);
    const dates = stmt.transactions.map((t) => t.date);
    expect(dates).toEqual(["2024-01-20", "2024-01-15", "2024-01-10"]);
  });

  it("parses amounts with correct sign", () => {
    const stmt = parseBankStatementFull(MT940_SAMPLE);
    // sorted: 20th=-50, 15th=-100, 10th=+250.50
    expect(stmt.transactions[0].amount).toBe(-50);
    expect(stmt.transactions[1].amount).toBe(-100);
    expect(stmt.transactions[2].amount).toBe(250.5);
  });

  it("extracts counter account from CNTP", () => {
    const stmt = parseBankStatementFull(MT940_SAMPLE);
    // The -100 tx (15th) has /CNTP/
    const tx = stmt.transactions.find((t) => t.amount === -100);
    expect(tx?.counterAccount).toBe("NL91INGB0001234567");
  });

  it("extracts reference", () => {
    const stmt = parseBankStatementFull(MT940_SAMPLE);
    const tx = stmt.transactions.find((t) => t.amount === 250.5);
    expect(tx?.reference).toBe("REF123");
  });

  it("balance check passes when statement is consistent", () => {
    const stmt = parseBankStatementFull(MT940_SAMPLE);
    const sum = stmt.transactions.reduce((a, t) => a + t.amount, 0);
    const diff = Math.abs(stmt.openingBalance! + sum - stmt.closingBalance!);
    expect(diff).toBeLessThanOrEqual(0.01);
  });

  it("balance check fails for inconsistent statement", () => {
    const stmt = parseBankStatementFull(MT940_BAD_BALANCE);
    const sum = stmt.transactions.reduce((a, t) => a + t.amount, 0);
    const diff = Math.abs(stmt.openingBalance! + sum - stmt.closingBalance!);
    expect(diff).toBeGreaterThan(0.01);
  });
});

// ─── CAMT.053 fixtures ──────────────────────────────────────────────
const CAMT053_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Bal>
        <Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">5000.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
      </Bal>
      <Ntry>
        <Amt Ccy="EUR">150.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2024-03-15</Dt></BookgDt>
        <NtryDtls><TxDtls><RmtInf><Ustrd>Factuur 2024-001</Ustrd></RmtInf><Refs><EndToEndId>E2E-001</EndToEndId></Refs><RltdPties><DbtrAcct><Id><IBAN>NL91INGB0001234567</IBAN></Id></DbtrAcct></RltdPties></TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">300.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2024-03-20</Dt></BookgDt>
        <AddtlNtryInf>Betaling ontvangen klant</AddtlNtryInf>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">75.50</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2024-03-10</Dt></BookgDt>
        <AddtlNtryInf>Kantoorbenodigdheden</AddtlNtryInf>
      </Ntry>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">5074.50</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
      </Bal>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

describe("parseBankStatementFull - CAMT.053", () => {
  it("extracts opening and closing balance", () => {
    const stmt = parseBankStatementFull(CAMT053_SAMPLE);
    expect(stmt.openingBalance).toBe(5000);
    expect(stmt.closingBalance).toBe(5074.5);
  });

  it("parses correct number of transactions", () => {
    const stmt = parseBankStatementFull(CAMT053_SAMPLE);
    expect(stmt.transactions.length).toBe(3);
  });

  it("sorts transactions newest first", () => {
    const stmt = parseBankStatementFull(CAMT053_SAMPLE);
    const dates = stmt.transactions.map((t) => t.date);
    expect(dates).toEqual(["2024-03-20", "2024-03-15", "2024-03-10"]);
  });

  it("balance check passes", () => {
    const stmt = parseBankStatementFull(CAMT053_SAMPLE);
    const sum = stmt.transactions.reduce((a, t) => a + t.amount, 0);
    const diff = Math.abs(stmt.openingBalance! + sum - stmt.closingBalance!);
    expect(diff).toBeLessThanOrEqual(0.01);
  });

  it("extracts IBAN counter account", () => {
    const stmt = parseBankStatementFull(CAMT053_SAMPLE);
    const tx = stmt.transactions.find((t) => t.amount === -150);
    expect(tx?.counterAccount).toBe("NL91INGB0001234567");
  });

  it("extracts EndToEndId reference", () => {
    const stmt = parseBankStatementFull(CAMT053_SAMPLE);
    const tx = stmt.transactions.find((t) => t.amount === -150);
    expect(tx?.reference).toBe("E2E-001");
  });
});

// ─── Duplicate detection ────────────────────────────────────────────
describe("detectDuplicates", () => {
  const incoming: ParsedTransaction[] = [
    { date: "2024-01-15", amount: -100, description: "Betaling leverancier", counterAccount: "NL91INGB0001234567", reference: "REF123" },
    { date: "2024-01-10", amount: 250.5, description: "Ontvangst klant ABC", counterAccount: null, reference: null },
    { date: "2024-01-20", amount: -50, description: "Nieuwe transactie", counterAccount: null, reference: null },
  ];

  it("detects duplicate by reference", () => {
    const existing = [
      { transaction_date: "2024-01-15", amount: -100, description: "iets anders", counter_account: null, reference: "REF123" },
    ];
    const result = detectDuplicates(incoming, existing);
    expect(result[0]).toEqual({ isDuplicate: true, reason: "reference" });
    expect(result[1].isDuplicate).toBe(false);
    expect(result[2].isDuplicate).toBe(false);
  });

  it("detects duplicate by composite key", () => {
    const existing = [
      { transaction_date: "2024-01-10", amount: 250.5, description: "Ontvangst klant ABC", counter_account: null, reference: null },
    ];
    const result = detectDuplicates(incoming, existing);
    expect(result[0].isDuplicate).toBe(false);
    expect(result[1]).toEqual({ isDuplicate: true, reason: "composite" });
  });

  it("composite key is case-insensitive and trimmed", () => {
    const existing = [
      { transaction_date: "2024-01-10", amount: 250.5, description: "  ONTVANGST KLANT ABC  ", counter_account: null, reference: null },
    ];
    const result = detectDuplicates(incoming, existing);
    expect(result[1]).toEqual({ isDuplicate: true, reason: "composite" });
  });

  it("no false positives for different transactions", () => {
    const existing = [
      { transaction_date: "2024-02-01", amount: -999, description: "Heel andere boeking", counter_account: null, reference: "OTHER" },
    ];
    const result = detectDuplicates(incoming, existing);
    expect(result.every((d) => !d.isDuplicate)).toBe(true);
  });

  it("returns correct length matching incoming", () => {
    const result = detectDuplicates(incoming, []);
    expect(result.length).toBe(incoming.length);
  });
});
