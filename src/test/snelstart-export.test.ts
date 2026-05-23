import { describe, it, expect } from "vitest";
import { buildBankSnelstartRows, resolveBankExportGrootboek } from "@/lib/snelstart-export";
import type { Tables } from "@/integrations/supabase/types";

type BankTransaction = Tables<"bank_transactions">;
type Grootboek = { id: string; nummer: number; omschrijving: string };

function makeTx(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: "tx-1",
    user_id: "u-1",
    client_id: "c-1",
    transaction_date: "2024-01-15",
    description: "Test betaling",
    amount: -150.0,
    match_status: "gematcht",
    matched_invoice_id: null,
    match_confidence: null,
    grootboekrekening_id: null,
    created_at: "2024-01-15T00:00:00Z",
    updated_at: "2024-01-15T00:00:00Z",
    ...overrides,
  } as BankTransaction;
}

const gb4400: Grootboek = { id: "gb-4400", nummer: 4400, omschrijving: "Kosten" };
const gb1799: Grootboek = { id: "gb-1799", nummer: 1799, omschrijving: "Onbekend" };

describe("resolveBankExportGrootboek", () => {
  it("blocks suggestie", () => {
    const { source } = resolveBankExportGrootboek(makeTx({ match_status: "suggestie" }), [gb4400]);
    expect(source).toBe("blocked_unconfirmed");
  });

  it("blocks niet_gematcht", () => {
    const { source } = resolveBankExportGrootboek(makeTx({ match_status: "niet_gematcht" }), [gb4400]);
    expect(source).toBe("blocked_unprocessed");
  });

  it("resolves gematcht with own ledger to source own", () => {
    const tx = makeTx({ match_status: "gematcht", grootboekrekening_id: "gb-4400" });
    const { source, grootboek } = resolveBankExportGrootboek(tx, [gb4400]);
    expect(source).toBe("own");
    expect(grootboek?.nummer).toBe(4400);
  });

  it("resolves gematcht without ledger to 1799 when present", () => {
    const tx = makeTx({ match_status: "gematcht", grootboekrekening_id: null });
    const { source, grootboek } = resolveBankExportGrootboek(tx, [gb4400, gb1799]);
    expect(source).toBe("1799");
    expect(grootboek?.nummer).toBe(1799);
  });

  it("blocks gematcht without ledger and no 1799", () => {
    const tx = makeTx({ match_status: "gematcht", grootboekrekening_id: null });
    const { source, grootboek } = resolveBankExportGrootboek(tx, [gb4400]);
    expect(source).toBe("blocked_missing_1799");
    expect(grootboek).toBeNull();
  });

  it("resolves handmatig_geboekt with own ledger to source own", () => {
    const tx = makeTx({ match_status: "handmatig_geboekt", grootboekrekening_id: "gb-4400" });
    const { source } = resolveBankExportGrootboek(tx, [gb4400]);
    expect(source).toBe("own");
  });

  it("blocks handmatig_geboekt without ledger", () => {
    const tx = makeTx({ match_status: "handmatig_geboekt", grootboekrekening_id: null });
    const { source } = resolveBankExportGrootboek(tx, [gb4400, gb1799]);
    expect(source).toBe("blocked_manual_invalid");
  });
});

describe("buildBankSnelstartRows", () => {
  it("produces 2 rows per exported transaction", () => {
    const tx = makeTx({ match_status: "gematcht", grootboekrekening_id: "gb-4400", amount: -150 });
    const { rows, exportedTransactions } = buildBankSnelstartRows([tx], [gb4400], 1100);
    expect(exportedTransactions).toBe(1);
    expect(rows).toHaveLength(2);
  });

  it("uses the passed bankDagboek in both rows", () => {
    const tx = makeTx({ match_status: "gematcht", grootboekrekening_id: "gb-4400", amount: -150 });
    const { rows } = buildBankSnelstartRows([tx], [gb4400], 1200);
    // Both rows start with the bankDagboek as first field
    expect(rows[0].startsWith("1200;")).toBe(true);
    expect(rows[1].startsWith("1200;")).toBe(true);
  });

  it("row 1 uses bankDagboek as grootboeknummer; row 2 uses contra account", () => {
    const tx = makeTx({ match_status: "gematcht", grootboekrekening_id: "gb-4400", amount: -200 });
    const { rows } = buildBankSnelstartRows([tx], [gb4400], 1100);
    const fields0 = rows[0].split(";");
    const fields1 = rows[1].split(";");
    // field index 3 = fldGrootboeknummer
    expect(fields0[3]).toBe("1100"); // bank account
    expect(fields1[3]).toBe("4400"); // contra account
  });

  it("skips blocked transactions and does not produce rows", () => {
    const suggestie = makeTx({ match_status: "suggestie" });
    const nietGematcht = makeTx({ id: "tx-2", match_status: "niet_gematcht" });
    const { rows, skippedTransactions, skippedUnconfirmed, skippedUnprocessed } =
      buildBankSnelstartRows([suggestie, nietGematcht], [gb4400], 1100);
    expect(rows).toHaveLength(0);
    expect(skippedTransactions).toBe(2);
    expect(skippedUnconfirmed).toBe(1);
    expect(skippedUnprocessed).toBe(1);
  });

  it("exports handmatig_geboekt with valid ledger, skips without", () => {
    const exportable = makeTx({ id: "tx-ok", match_status: "handmatig_geboekt", grootboekrekening_id: "gb-4400" });
    const blocked = makeTx({ id: "tx-bad", match_status: "handmatig_geboekt", grootboekrekening_id: null });
    const { rows, exportedTransactions, skippedManualInvalidLedger } =
      buildBankSnelstartRows([exportable, blocked], [gb4400], 1100);
    expect(exportedTransactions).toBe(1);
    expect(rows).toHaveLength(2);
    expect(skippedManualInvalidLedger).toBe(1);
  });

  it("tracks bookedTo1799 when using 1799 fallback", () => {
    const tx = makeTx({ match_status: "gematcht", grootboekrekening_id: null });
    const { bookedTo1799 } = buildBankSnelstartRows([tx], [gb4400, gb1799], 1100);
    expect(bookedTo1799).toBe(1);
  });

  it("formats positive amount as debet on bank row, credit on contra row", () => {
    const tx = makeTx({ match_status: "gematcht", grootboekrekening_id: "gb-4400", amount: 100 });
    const { rows } = buildBankSnelstartRows([tx], [gb4400], 1100);
    const f0 = rows[0].split(";"); // bank row
    const f1 = rows[1].split(";"); // contra row
    // fldDebet = index 4, fldCredit = index 5
    expect(f0[4]).toBe("100,00"); // bank debet
    expect(f0[5]).toBe("0");      // bank credit
    expect(f1[4]).toBe("0");      // contra debet
    expect(f1[5]).toBe("100,00"); // contra credit
  });

  it("formats negative amount as credit on bank row, debet on contra row", () => {
    const tx = makeTx({ match_status: "gematcht", grootboekrekening_id: "gb-4400", amount: -75.5 });
    const { rows } = buildBankSnelstartRows([tx], [gb4400], 1100);
    const f0 = rows[0].split(";");
    const f1 = rows[1].split(";");
    expect(f0[4]).toBe("0");      // bank debet
    expect(f0[5]).toBe("75,50"); // bank credit
    expect(f1[4]).toBe("75,50"); // contra debet
    expect(f1[5]).toBe("0");      // contra credit
  });

  it("returns empty rows for empty input", () => {
    const { rows, exportedTransactions } = buildBankSnelstartRows([], [gb4400], 1100);
    expect(rows).toHaveLength(0);
    expect(exportedTransactions).toBe(0);
  });
});
