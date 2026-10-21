import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPurchaseInvoiceExport, type SnelstartLedgerAccount, type SnelstartPurchaseLine } from "@/lib/snelstart-export";

/**
 * Herstelpakket P6 (A2-04) — de SnelStart-inkoopexport per boekingsregel naast
 * wat de ECHTE `post_purchase_invoice()` in het grootboek boekt.
 *
 * De fixture is gemaakt door `supabase/tests/snelstart-export-ledger/run-proof.sh`
 * op een wegwerpcluster: de echte migratieketen t/m 20261010120000 (laatste
 * definitie van de schrijver: 20261002120000), facturen S1–S8 en hun boeking via
 * de schrijver zelf. Deze test legt de export van dezelfde bronrijen ernaast:
 *
 *   per kostenregel   rekening(export) = rekening(journaal) en
 *                     excl(export)     = debet(journaal)
 *   btw               Σ btw(export)    = debet BTW te vorderen (1520)
 *   crediteur         Σ bedrag(export) = credit crediteuren (1600)
 *
 * S5 (B-5) rondt de kop-btw over het totaal af (0,27); sinds H6-01 verdeelt de
 * export die per tarief over de regels (0,14 + 0,13) en sluit hij op het journaal.
 *
 * waarbij excl en btw per exportregel worden afgeleid zoals SnelStart dat uit
 * "bedrag incl. + btw-code" doet: btw = afronden(incl × p / (100 + p)). Of
 * SnelStart precies zo afrondt, is niet getoetst (SnelStart-testimport,
 * nulmeting §9.2 punt 5).
 *
 * Opnieuw maken na een wijziging van de schrijver: draai het harnas; een ander
 * grootboek wordt dan een diff in de fixture en een rode test.
 */

type Fixture = {
  writer: string;
  crediteuren_nummer: number;
  btw_te_vorderen_nummer: number;
  invoices: Array<Record<string, any> & { id: string; supplier: string; invoice_number: string; posted: boolean }>;
  lines: SnelstartPurchaseLine[];
  accounts: SnelstartLedgerAccount[];
  ledger: Array<{ source_id: string; line_no: number; nummer: number; debit_amount: number; credit_amount: number; description: string }>;
};

const fx = JSON.parse(readFileSync(resolve(process.cwd(), "src/test/fixtures/snelstart-export-ledger.json"), "utf8")) as Fixture;

const cents = (n: number) => Math.round(n * 100);
const PCT_BY_CODE: Record<string, number> = { "1": 21, "2": 9, "0": 0 };

function parseRow(row: string) {
  const [datum, omschrijving, rekening, bedrag, code] = row.split(";").map((f) => f.replace(/^"|"$/g, ""));
  const inclCents = cents(Number(bedrag.replace(",", ".")));
  const pct = PCT_BY_CODE[code];
  // Zo leidt SnelStart de btw af uit "bedrag incl. + code" (aanname, niet getoetst).
  const vatCents = Math.round((inclCents * pct) / (100 + pct));
  return { datum, omschrijving, rekening: Number(rekening), inclCents, vatCents, exclCents: inclCents - vatCents, code };
}

function compare(invoiceNumber: string) {
  const invoice = fx.invoices.find((i) => i.invoice_number === invoiceNumber)!;
  const plan = buildPurchaseInvoiceExport({
    invoices: [invoice as any],
    lines: fx.lines.filter((l) => l.purchase_invoice_id === invoice.id),
    accounts: fx.accounts,
  });
  const journal = fx.ledger.filter((r) => r.source_id === invoice.id).sort((a, b) => a.line_no - b.line_no);
  const expense = journal.filter((r) => r.nummer !== fx.crediteuren_nummer && r.nummer !== fx.btw_te_vorderen_nummer);
  const vat = journal.filter((r) => r.nummer === fx.btw_te_vorderen_nummer).reduce((s, r) => s + cents(r.debit_amount), 0);
  const creditor = journal.filter((r) => r.nummer === fx.crediteuren_nummer).reduce((s, r) => s + cents(r.credit_amount), 0);
  const rows = plan.rows.map(parseRow);
  return { invoice, plan, journal, expense, vat, creditor, rows };
}

describe("A2-04 — export per boekingsregel tegenover de journaalregels van post_purchase_invoice", () => {
  it("de fixture komt van de laatste definitie van de schrijver", () => {
    expect(fx.writer).toContain("20261002120000");
    const migrations = readdirSync(resolve(process.cwd(), "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
    const redefining = migrations.filter((f) =>
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?post_purchase_invoice\s*\(/i.test(
        readFileSync(resolve(process.cwd(), "supabase/migrations", f), "utf8"),
      ),
    );
    // Komt er een nieuwere definitie bij, draai dan het harnas opnieuw (de fixture is dan verouderd).
    expect(redefining.at(-1)).toBe("20261002120000_decouple_year_watermark_from_posting.sql");
  });

  it("S1 (de A2-04-factuur): twee exportregels 4400/'1' en 4600/'2'; het journaal boekt D 4400 100 · D 4600 100 · D 1520 30 · C 1600 230", () => {
    const { plan, journal } = compare("000123");
    expect(plan.rows).toEqual([
      '"20-10-2026";"Leverancier BV - 000123 - Kantoorartikelen";"4400";"121,00";"1"',
      '"20-10-2026";"Leverancier BV - 000123 - Vakliteratuur";"4600";"109,00";"2"',
    ]);
    expect(journal.map((r) => [r.nummer, cents(r.debit_amount), cents(r.credit_amount)])).toEqual([
      [4400, 10000, 0], [4600, 10000, 0], [1520, 3000, 0], [1600, 0, 23000],
    ]);
  });

  it.each(["000123", "V-0", "G-77", "D-4", "B-5"])("factuur %s: export en journaal zijn regel voor regel gelijk", (nummer) => {
    const { invoice, plan, expense, vat, creditor, rows } = compare(nummer);
    expect(invoice.posted).toBe(true);
    expect(plan.refused).toEqual([]);
    expect(rows.map((r) => r.rekening)).toEqual(expense.map((r) => r.nummer));
    expect(rows.map((r) => r.exclCents)).toEqual(expense.map((r) => cents(r.debit_amount)));
    expect(rows.map((r) => r.omschrijving)).toEqual(expense.map((r) => `${invoice.supplier} - ${nummer} - ${r.description}`));
    expect(rows.reduce((s, r) => s + r.vatCents, 0)).toBe(vat);
    expect(rows.reduce((s, r) => s + r.inclCents, 0)).toBe(creditor);
    expect(rows.every((r) => r.datum === "20-10-2026")).toBe(true);
  });

  it("VERSCHIL S6: de schrijver negeert het regeltarief en boekt een regel zonder btw-% — de export weigert (onbekende btw)", () => {
    const { invoice, plan, journal } = compare("N-6");
    expect(invoice.posted).toBe(true);
    expect(journal.map((r) => r.nummer)).toEqual([4400, 1520, 1600]);
    expect(plan.rows).toEqual([]);
    expect(plan.refused[0].reason).toMatch(/onbekende btw/);
  });

  it.each([["Z-1", /geen boekingsregels/], ["R-1", /zonder grootboekrekening/]])(
    "factuur %s: de schrijver en de export weigeren allebei",
    (nummer, reason) => {
      const { invoice, plan, journal } = compare(nummer);
      expect(invoice.posted).toBe(false);
      expect(journal).toEqual([]);
      expect(plan.rows).toEqual([]);
      expect(plan.refused[0].reason).toMatch(reason);
    },
  );
});
