import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPurchaseInvoiceExport, type SnelstartLedgerAccount, type SnelstartPurchaseLine } from "@/lib/snelstart-export";

/**
 * Herstelpakket P6 (A2-04) — de SnelStart-inkoopexport per boekingsregel naast
 * wat de ECHTE `post_purchase_invoice()` in het grootboek boekt.
 *
 * De fixture is gemaakt door `supabase/tests/snelstart-export-ledger/run-proof.sh`
 * op een wegwerpcluster: de echte migratieketen t/m de nieuwste migratie (dus de
 * effectieve definitie van de schrijver), facturen S1–S9 en hun boeking via
 * de schrijver zelf. Deze test legt de export van dezelfde bronrijen ernaast:
 *
 *   per kostenregel   rekening(export) = rekening(journaal) en
 *                     excl(export)     = debet(journaal)
 *   btw               Σ btw(export)    = debet BTW te vorderen (1520)
 *   crediteur         Σ bedrag(export) = credit crediteuren (1600)
 *
 * S5 (B-5) rondt de kop-btw over het totaal af (0,27); de export verdeelt die
 * (0,14 + 0,13, H6-01) en dat rekent ook terug, dus hij sluit op het journaal.
 * S9 (K-9, 2 × 1,30 @ 21%, kop 0,55) is niet terug te rekenen (1,58 → 0,27): de
 * schrijver boekt hem, de export weigert (H6-01b).
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
  it("vindt de effectieve (nieuwste) definitie van de schrijver en bewijst daar de vergelijking tegen", () => {
    const dir = resolve(process.cwd(), "supabase/migrations");
    const def = /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?post_purchase_invoice\s*\(/i;
    const latest = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
      .filter((f) => def.test(readFileSync(resolve(dir, f), "utf8"))).at(-1);
    if (!latest) throw new Error("geen migratie definieert public.post_purchase_invoice(");
    const sql = readFileSync(resolve(dir, latest), "utf8");
    const start = sql.search(def);
    const body = sql.slice(start);
    const open = body.indexOf("AS $$");
    const end = open < 0 ? -1 : body.indexOf("$$;", open + 5);
    if (open < 0 || end < 0) throw new Error(`einde van de body van post_purchase_invoice ontbreekt in ${latest}`);
    const fn = body.slice(open, end);
    // Wat de fixture aanneemt, staat in die definitie: kostenregels per regel debet,
    // kop-btw op btw_te_vorderen, kop-incl credit op crediteuren.
    expect(fn).toMatch(/v_line\.amount_excl, 0, 'EUR'/);
    expect(fn).toMatch(/btw_te_vorderen_rekening_id, v_group_id/);
    expect(fn).toMatch(/0, v_inv\.amount_incl, 'EUR'/);
    // De fixture is door het harnas gegenereerd met de volledige keten t/m de nieuwste
    // migratie; bewijs 5.1 daar faalt als de schrijver iets anders boekt.
    expect(fx.invoices.length).toBeGreaterThan(0);
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

  it("VERSCHIL S9 (H6-01b): het journaal boekt de kop-btw 0,55; geen verdeling rekent in SnelStart terug — de export weigert", () => {
    const { invoice, plan, vat } = compare("K-9");
    expect(invoice.posted).toBe(true);
    expect(vat).toBe(55);
    expect(plan.rows).toEqual([]);
    expect(plan.refused[0].reason).toMatch(/terugrekent/);
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
